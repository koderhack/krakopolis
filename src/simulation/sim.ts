/**
 * Silnik symulacji. Nie wykonuje żadnych zapytań sieciowych.
 *
 *   baselineState  – prawdziwe dane (OSM + ZTP + pogoda), wstrzykiwane z CityData,
 *   playerChanges  – decyzje gracza,
 *   simulatedFuture– to, co widzimy w symulacji (PREDICTED + SIMULATED).
 *
 * Stan z danych źródłowych nigdy nie jest nadpisywany przez gracza – trzymamy
 * obie warstwy osobno i pokazujemy je osobno w UI.
 */
import { buildGraph, edgeCosts, travelTime, MinHeap, TreeCache, type GraphEdge, type RoadGraph } from './graph';
import { TrafficAssignment, mulberry32 } from './traffic/assignment';
import { CAR, BUS, TRAM, PedestrianPool, makeRnd, type Park, type Ped, type Veh, type VehKind } from './pedestrians/agents';
import type { CityData, SimRoute } from '../data/model';
import {
  DISASTERS, DISASTER_EFFECTS, PlayerHistory, disasterPenalty, pickRoads,
  type DisasterKind, type DisasterState, type NewStop, type PlayerBuilding, type PlayerChange, type RoadClosure,
} from './city/player';
import { buildSpec, type BuildId } from './city/catalog';
import type { Origin } from '../data/types';
import { BUDGET_INCOME_PER_SIM_SEC, COST_SCALE, START_BUDGET_PLN } from '../data/budget';

export const MAX_PEDS = 900;
/**
 * Ile realnych pojazdów reprezentuje jeden agent symulacji.
 * Sieć w modelu ma ~41 km dróg zjazdowych, a Kraków w szczycie ruchu ma tam
 * dziesiątki tysięcy pojazdów – tyle agentów nie da się ani policzyć, ani
 * wyrenderować. Agent jest więc „paczką" ruchu: jeden agent = VEH_PER_AGENT
 * pojazdów. Metryki i predykcja operują na liczbie pojazdów, scena pokazuje
 * agentów; obie liczby są widoczne w HUD.
 */
export const VEH_PER_AGENT = 9;
export const TICK = 0.1;
export const COST = {
  close: 20 * COST_SCALE,
  carsOnly: 30 * COST_SCALE,
  pedestrian: 150 * COST_SCALE,
  stop: 80 * COST_SCALE,
  stopTram: 110 * COST_SCALE,
  park: 120 * COST_SCALE,
  mall: 420 * COST_SCALE,
  university: 380 * COST_SCALE,
  road: 260 * COST_SCALE,
};

/** Maks. przesunięcie zegara względem „teraz” (Europe/Warsaw). */
export const MAX_CLOCK_OFFSET_MS = 24 * 60 * 60 * 1000;

export interface RoadSim {
  edge: GraphEdge;
  /** Stan zamknięcia wprowadzony przez gracza lub katastrofę. */
  closure: RoadClosure;
  /** Odcinek zniszczony – nieprzejezdny dla wszystkich, do odbudowy lub cofnięcia. */
  destroyed: boolean;
  /** Poziom ruchu z danych źródłowych. 0..1. Nigdy nie zmieniany przez gracza. */
  baseline: number;
  baselineOrigin: Origin;
  baselineSpeed?: number;
  /** Poziom ruchu wyliczony przez przypisanie ruchu po zmianach gracza. 0..1. */
  predicted: number;
  /** Bieżący, animowany poziom ruchu (SIMULATED). */
  level: number;
  /** Obliczona przepustowość – stała, z klasy drogi i liczby pasów. */
  capacity: number;
  closed: boolean;
  pedestrian: boolean;
  /** Zmiana gracza: nowy przystanek. */
  addedStop: boolean;
  /** Realny przystanek MPK na tym odcinku. */
  realStop: boolean;
  /** Czy tu kursuje prawdziwa komunikacja (z mapowania GTFS). */
  transit: boolean;
  /** Odcinek dodany przez gracza – nowa droga lub autostrada. */
  built: boolean;
  /** Liczba pojazdów na odcinku (agenci × VEH_PER_AGENT). */
  vehicles: number;
  /** Waga przyciągania pieszych (wyższa na deptaku i przy przystankach). */
  walkWeight: number;
}

export interface Metrics {
  traffic: number;
  transit: number;
  pedestrians: number;
  pollution: number;
  noise: number;
  satisfaction: number;
  budget: number;
}

export interface Snapshot extends Metrics {
  cars: number;
  /** Liczba pojazdów reprezentowanych przez agentów (agent × VEH_PER_AGENT). */
  vehiclesModelled: number;
  peds: number;
  trams: number;
  buses: number;
  realVehicles: number;
  realTrams: number;
  realBuses: number;
  time: number;
  /** Godzina symulacji (Europe/Warsaw), np. "17:42". */
  clock: string;
  /** Godzina 0–23 w strefie warszawskiej. */
  hour: number;
  /** Czy weekend (sob/niedz) w zegarze symulacji. */
  weekend: boolean;
  /** Ile odcinków ma zamknięcie od gracza. */
  closed: number;
  assignmentAt: string;
  assignmentIterations: number;
  /** Liczba budynków dodanych przez gracza. */
  built: number;
  /** Liczba przystanków dodanych przez gracza. */
  newStops: number;
  destroyed: number;
  disasters: number;
  undoDepth: number;
}

/** Liczba aut: ~18 na kilometr sieci zjazdowej, z sensownymi ograniczeniami. */
/** Minimalny odstęp między pojazdami [m] – długość pojazdu plus margines. */
export const minGap = (kind: number) => (kind === TRAM ? 48 : kind === BUS ? 18 : 8);

const cmpVeh = (a: Veh, b: Veh) => (a.dir - b.dir) || (a.s - b.s);

function carCountFor(g: RoadGraph): number {
  let km = 0;
  for (const e of g.edges) if (e.carAccess) km += e.len / 1000;
  return Math.max(200, Math.min(1100, Math.round(km * 18)));
}

export class Sim {
  g: RoadGraph;
  roads: RoadSim[] = [];
  veh: Veh[] = [];
  peds: Ped[] = [];
  parks: Park[] = [];
  time = 0;
  /**
   * Zegar symulacji (ms epoch). Przy 1× trzymamy go zsynchronizowany z
   * rzeczywistym czasem Europe/Warsaw; przy 2×/5× przyspieszamy od tego punktu.
   */
  clockMs = Date.now();
  /** Offset względem czasu ściennego – clamp ±24 h (scrubbing UI). */
  clockOffsetMs = 0;
  version = 0;
  m: Metrics = { traffic: 0, transit: 0, pedestrians: 0, pollution: 0, noise: 0, satisfaction: 60, budget: START_BUDGET_PLN };

  private city: CityData | null = null;
  private routes: SimRoute[] = [];
  /** Przystanki: prawdziwe (z GTFS) + dodane przez gracza. */
  stops: { roadId: number; name: string; lines: string[] }[] = [];
  private peds_!: PedestrianPool;
  private rnd = makeRnd(20261003);
  private acc = 0;
  private tickN = 0;
  private assignment: TrafficAssignment | null = null;
  private assignAt = 0;
  private assignTimer = 0;
  private assignIterations = 0;
  private scratch = { dist: new Float64Array(0), prev: new Float64Array(0), prevEdge: new Float32Array(0), done: new Uint8Array(0), heap: new MinHeap() };
  /** Drzewa tras: jeden przebieg Dijkstry obsługuje wszystkie auta na danym skrzyżowaniu. */
  private trees = new TreeCache(96, 40_000);
  /**
   * Węzły „huby", na które kierują się pojazdy. Trasa jest wyznaczana od
   * docelowego huba, więc wystarczy kilkadziesiąt drzew Dijkstry zamiast
   * jednego na każde skrzyżowanie, na które wjeżdża auto.
   */
  private hubs: number[] = [];
  /** Aktualne obciążenie dróg – waga w drzewach tras. */
  private roadLoad = new Float32Array(0);
  /** Koszty przejazdu przeliczone raz na krok (bez Math.pow w pętli Dijkstry). */
  private costs = new Float32Array(0) as Float32Array;
  /**
   * Węzły, do których da się dojechać z głównej składowej sieci zjazdowej.
   * Wyznaczone raz, przy budowie – dzięki temu auta nie próbują w kółko
   * tras do nieosiągalnych celów (co zjadało klatkę).
   */
  private carTargets: number[] = [];
  private carNodes: number[] = [];
  private transitVehPerRoute = new Map<number, number>();
  /** Trasa bieżącego pojazdu MPK – używana przez routeTail(). */
  private vehRoute: number[] = [];
  /** Prawdziwe pojazdy z ostatniego odczytu GTFS-RT (OBSERVED). */
  realVehicles: CityData['liveVehicles'] = [];
  /** Mnożnik prędkości od aktywnych katastrof (0..1). */
  private disasterSpeed = 1;
  private disasterMood = { speed: 1, satisfaction: 0, pollution: 0, noise: 0 };
  private costByRoad = new Map<number, number>();
  /** Budynki postawione przez gracza – SIMULATED. */
  playerBuildings: PlayerBuilding[] = [];
  /** Przystanki dodane przez gracza (osobno autobusowe i tramwajowe). */
  playerStops: NewStop[] = [];
  /** Aktywne katastrofy – SIMULATED. */
  disasters: DisasterState[] = [];
  /** Historia odwracalnych decyzji gracza. */
  history = new PlayerHistory();
  /** Liczba zniszczonych odcinków (dla HUD). */
  destroyedCount = 0;
  environment = { temperatureC: undefined as number | undefined, pm25: undefined as number | undefined, windKmh: undefined as number | undefined };
  /** Ostatnia znana temperatura – wpływa na komfort pieszych i spowolnienie ruchu. */
  private temp = 14;
  private airFactor = 1;

  constructor(city: CityData) {
    this.g = buildGraph(city.nodes, city.roads);
    this.scratch = { dist: new Float64Array(city.nodes.length), prev: new Float64Array(city.nodes.length), prevEdge: new Float32Array(city.nodes.length), done: new Uint8Array(city.nodes.length), heap: new MinHeap() };
    this.applyCityData(city);
    // Gęstość pojazdów dopasowana do realnej długości sieci drogowej w modelu.
    this.carTarget = carCountFor(this.g);
    this.buildCarNetwork();
    this.assignment = new TrafficAssignment(this.g, () => this.blockedPredicate(), this.carTargets);
    this.assignment.setTarget(this.carTarget * VEH_PER_AGENT);
    this.runAssignment();
    for (let i = 0; i < this.carTarget; i++) this.spawnCar();
    for (let i = 0; i < MAX_PEDS; i++) this.peds_.step(this.peds[i], 0);
    this.metrics();
    this.time = 0;
  }

  /**
   * Węzły sieci zjazdowej oraz lista celów osiągalnych. Wybieramy NAJWIĘKSZĄ
   * spójną składową – w Starym Mieście część ulic jest zamknięta dla aut (Rynek,
   * Planty), więc sieć składa się z kilkudziesięciu kawałków. Pojazdy i predykcja
   * ruchu działają w tym największym, a nie w losowym.
   */
  private buildCarNetwork() {
    const carNodes: number[] = [];
    const inCar = new Uint8Array(this.g.nodes.length);
    for (const e of this.g.edges) {
      if (!e.carAccess || e.capacity <= 0) continue;
      if (!inCar[e.a]) { inCar[e.a] = 1; carNodes.push(e.a); }
      if (!inCar[e.b]) { inCar[e.b] = 1; carNodes.push(e.b); }
    }
    this.carNodes = carNodes;
    if (!carNodes.length) return;

    const visited = new Uint8Array(this.g.nodes.length);
    let best: number[] = [];
    for (const start of carNodes) {
      if (visited[start]) continue;
      const comp: number[] = [];
      const stack = [start];
      visited[start] = 1;
      while (stack.length) {
        const u = stack.pop()!;
        comp.push(u);
        for (const { e, to } of this.g.adj[u]) {
          const ed = this.g.edges[e];
          if (!ed.carAccess || visited[to]) continue;
          if (ed.oneway && ed.a !== u) continue; // do góry pod prąd nie wjeżdżamy
          visited[to] = 1;
          stack.push(to);
        }
      }
      if (comp.length > best.length) best = comp;
    }
    this.carTargets = best;

    // Huby: ruchomu co X węzłów składowej, żeby cele były rozłożone w całym mieście.
    const step = Math.max(1, Math.floor(best.length / 80));
    this.hubs = best.filter((_, i) => i % step === 0);
    if (this.hubs.length < 4) this.hubs = best.slice(0, 24);
  }

  /* ------------------------------------------------------------ dane */

  /** Wstrzykuje / aktualizuje prawdziwe dane źródłowe (baseline). */
  applyCityData(city: CityData) {
    this.city = city;
    this.realVehicles = city.liveVehicles;
    this.routes = city.routes;
    this.environment = {
      temperatureC: city.environment.weather?.temperatureC,
      pm25: city.environment.airQuality?.pm25,
      windKmh: city.environment.weather?.windSpeedKmh,
    };
    this.temp = city.environment.weather?.temperatureC ?? 14;
    // PM2.5 z modelu CAMS – wpływa na smog w symulacji, oznaczany jako PREDICTED.
    this.airFactor = city.environment.airQuality?.pm25 !== undefined
      ? Math.min(2.2, Math.max(0.7, city.environment.airQuality.pm25 / 15))
      : 1;

    const stopsByRoad = new Map<number, { roadId: number; name: string; lines: string[] }>();
    for (const s of city.stops) {
      // przystanek bez odcinka (np. po naprawie grafu) nie może dostać się do symulacji
      if (s.roadId === undefined || s.roadId < 0 || s.roadId >= city.roads.length) continue;
      const cur = stopsByRoad.get(s.roadId);
      if (cur) cur.lines = [...new Set([...cur.lines, ...s.lines])];
      else stopsByRoad.set(s.roadId, { roadId: s.roadId, name: s.name, lines: [...s.lines] });
    }
    this.stops = [...stopsByRoad.values()];

    // Nowe odcinki (gdyby dane doszły po restarcie) – dobudowa, zachowując decyzje gracza.
    if (this.roads.length !== city.roads.length) {
      const prev = new Map(this.roads.map((r) => [r.edge.id, r]));
      this.roads = city.roads.map((r) => {
        const old = prev.get(r.id);
        const rs: RoadSim = {
          edge: this.g.edges[r.id],
          closure: old?.closure ?? 'none',
          destroyed: old?.destroyed ?? false,
          baseline: r.baselineTraffic,
          baselineOrigin: r.baselineOrigin,
          baselineSpeed: r.baselineSpeed,
          predicted: r.baselineTraffic,
          level: old?.level ?? r.baselineTraffic,
          capacity: r.capacity,
          closed: old?.closed ?? false,
          pedestrian: old?.pedestrian ?? false,
          addedStop: old?.addedStop ?? false,
          realStop: old?.realStop ?? false,
          transit: r.transit,
          built: false,
          vehicles: 0,
          walkWeight: 1,
        };
        return rs;
      });
    } else {
      city.roads.forEach((r, i) => {
        const rs = this.roads[i];
        rs.baseline = r.baselineTraffic;
        rs.baselineOrigin = r.baselineOrigin;
        rs.baselineSpeed = r.baselineSpeed;
        rs.transit = r.transit;
      });
    }
    // Odcinek bez krawędzi w grafie nie jest widoczny w symulacji – pomijamy go,
    // inaczej jedna uszkodzona dana wywraca całą aplikację.
    this.roads = this.roads.filter((rs): rs is RoadSim => !!rs?.edge);
    for (const rs of this.roads) rs.realStop = stopsByRoad.has(rs.edge.id);

    this.reweight();
    if (this.routes.length && this.transitVehPerRoute.size === 0) {
      this.retargetTransit();
      this.respawnAllTransit();
    }
    this.version++;
  }

  /* ---------------------------------------------------------- symulacja */

  /** Ostatni „kubeł” popytu (godzina×2 + pół godziny) – flota MPK tylko przy zmianie. */
  private lastDemandBucket = -1;

  /** Synchronizacja z zegarem ściennym (tryb 1×) – zachowuje offset ±24 h. */
  syncClockToWall() {
    this.clockMs = Date.now() + this.clockOffsetMs;
    this.applyClockDemand(false);
  }

  /** Przyspieszenie zegara (tryb 2×/5×): dt w sekundach symulacji, clamp ±24 h. */
  advanceClock(dtSec: number) {
    this.clockOffsetMs = clamp(
      this.clockOffsetMs + dtSec * 1000,
      -MAX_CLOCK_OFFSET_MS,
      MAX_CLOCK_OFFSET_MS,
    );
    this.clockMs = Date.now() + this.clockOffsetMs;
    this.applyClockDemand(false);
  }

  /** Przesunięcie zegara o godziny (scrubbing). */
  nudgeClockHours(deltaH: number) {
    this.setClockOffsetHours(this.clockOffsetMs / 3_600_000 + deltaH);
  }

  /** Ustaw offset w godzinach względem „teraz” (−24…+24). */
  setClockOffsetHours(hours: number) {
    this.clockOffsetMs = clamp(hours * 3_600_000, -MAX_CLOCK_OFFSET_MS, MAX_CLOCK_OFFSET_MS);
    this.clockMs = Date.now() + this.clockOffsetMs;
    this.applyClockDemand(true);
  }

  /** Reset do czasu rzeczywistego. */
  resetClockToNow() {
    this.clockOffsetMs = 0;
    this.clockMs = Date.now();
    this.applyClockDemand(true);
  }

  /**
   * Przelicza flotę MPK i pieszych wg godziny zegara.
   * force=true przy scrubbingu (od razu, także na pauzie).
   */
  applyClockDemand(force = false) {
    const { hour, minute } = this.clockParts();
    const bucket = hour * 2 + (minute >= 30 ? 1 : 0);
    if (!force && bucket === this.lastDemandBucket) return;
    this.lastDemandBucket = bucket;

    this.retargetTransit();
    this.enforceTransitCaps();
    this.respawnTransit();

    // Piesi: przy skoku zegara doganiamy target od razu (metrics() idzie po ±18).
    const demand = this.transitDemandFactor();
    let pedLen = 0, closedLen = 0;
    for (const r of this.roads) {
      if (r.pedestrian) pedLen += r.edge.len;
      if (r.closed || r.closure === 'closed' || r.destroyed) closedLen += r.edge.len;
    }
    const np = this.parks.length;
    const pedTarget = Math.max(
      Math.max(40, Math.round(80 * demand)),
      Math.min(
        MAX_PEDS,
        (120 + pedLen / 5 + closedLen / 8 + np * 24 + this.stops.length * 0.35) * (0.35 + 0.85 * demand),
      ),
    );
    const old = Math.round(this.activePeds);
    if (force) this.activePeds = pedTarget;
    else this.activePeds += Math.max(-40, Math.min(40, pedTarget - this.activePeds));
    const now = Math.round(this.activePeds);
    for (let i = Math.min(old, now); i < now && i < MAX_PEDS; i++) {
      this.peds_.place(this.peds[i], this.pickPedEdge());
    }
  }

  clockOffsetHours(): number {
    return this.clockOffsetMs / 3_600_000;
  }

  /** Części czasu w Europe/Warsaw. */
  clockParts(): { hour: number; minute: number; second: number; weekend: boolean; label: string } {
    const parts = warsawParts(this.clockMs);
    const label = `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
    return { ...parts, label };
  }

  /** Współczynnik popytu MPK / pieszych wg godziny (0–1+). */
  transitDemandFactor(): number {
    const { hour, weekend } = this.clockParts();
    let f: number;
    if (hour < 5) f = 0.12;
    else if (hour < 7) f = 0.4;
    else if (hour < 9) f = 1.05;
    else if (hour < 15) f = 0.62;
    else if (hour < 18) f = 1.05;
    else if (hour < 22) f = 0.68;
    else f = 0.28;
    if (weekend) f *= hour >= 10 && hour < 20 ? 0.85 : 0.55;
    return f;
  }

  /** 0 = głęboka noc, 1 = pełne południe – do oświetlenia sceny. */
  dayFactor(): number {
    const { hour, minute } = this.clockParts();
    const t = hour + minute / 60;
    // wschód ~5:30, zachód ~20:00 (przybliżenie na Kraków)
    if (t < 5.0) return 0.08;
    if (t < 6.5) return 0.08 + (t - 5) / 1.5 * 0.55;
    if (t < 8) return 0.63 + (t - 6.5) / 1.5 * 0.37;
    if (t < 17) return 1;
    if (t < 19.5) return 1 - (t - 17) / 2.5 * 0.55;
    if (t < 21.5) return 0.45 - (t - 19.5) / 2 * 0.3;
    return 0.1;
  }

  advance(dt: number) {
    this.acc = Math.min(this.acc + dt, 0.5);
    while (this.acc >= TICK) { this.step(TICK); this.acc -= TICK; }
  }

  step(dt: number) {
    this.time += dt;
    this.tickN++;

    this.enforceSpacing();
    for (const v of this.veh) this.move(v, dt);

    for (const r of this.roads) r.vehicles = 0;
    for (const v of this.veh) {
      if (v.kind !== TRAM) this.roads[v.edge].vehicles += v.kind === BUS ? 2 : VEH_PER_AGENT;
    }

    // Bieżący poziom ruchu: płynne przejście od baseline do predicted.
    // Obciążenie dróg do funkcji BPR w wyznaczaniu tras.
    if (this.roadLoad.length !== this.roads.length) {
      this.roadLoad = new Float32Array(this.roads.length);
      this.costs = new Float32Array(this.g.edges.length);
    }
    for (let i = 0; i < this.roads.length; i++) {
      const r = this.roads[i];
      this.roadLoad[i] = r.closed || r.pedestrian ? 0 : Math.min(1.2, r.level) * r.capacity;
    }
    this.costs = edgeCosts(this.g, this.roadLoad);

    // Bieżący poziom ruchu: płynne przejście od baseline do predykcji,
    // z tłem „normalnego" ruchu z danych (gdy brak pomiaru – PREDICTED).
    for (const r of this.roads) {
      const base = r.baselineOrigin === 'OBSERVED' ? r.baseline * 0.45 : r.baseline * 0.6;
      const target = r.closed ? 0 : r.pedestrian ? 0 : Math.min(1, Math.max(base, r.predicted));
      r.level += (target - r.level) * Math.min(1, dt * 0.8);
    }

    // Przypisanie ruchu przyrostowe: jedno źródło Dijkstry co 0,3 s, żeby nie
    // obciążać klatki. Po decyzji gracza przelicza się je w całości (patrz reroute).
    this.assignTimer += dt;
    if (this.assignment && this.assignTimer >= 0.3) {
      this.assignTimer = 0;
      this.assignment.advance(1);
      this.applyAssignment();
      this.assignAt = Date.now();
      this.assignIterations = this.assignment.result.iterations;
    }

    const active = Math.round(this.m.pedestrians > 0 ? this.activePeds : this.activePeds);
    for (let i = 0; i < active; i++) this.peds_.step(this.peds[i], dt);

    if (this.tickN % 10 === 0) this.metrics();
    if (this.tickN % 120 === 0) this.applyClockDemand(true);
    // Pojazdy, które wyjechały poza obszar, znikają.
    if (this.tickN % 30 === 0) this.cullOutsideArea();
    this.tickDisasters(dt);
  }

  activePeds = 260;
  /** Liczba symulowanych aut – wynika z długości realnej sieci drogowej. */
  carTarget = 600;

  /* ------------------------------------------------------- trasowanie */

  private cost(r: RoadSim, kind: VehKind): number {
    const e = r.edge;
    if (kind === TRAM) {
      // Wyłącznie torowisko – nie jeździmy po zwykłych ulicach ani chodnikach.
      if (r.destroyed) return Infinity;
      const onRails = e.roadClass === 'tram' || e.hasTram;
      return onRails ? travelTime(e, 0) : Infinity;
    }
    if (r.closed || r.pedestrian || !e.carAccess) return Infinity;
    if (e.oneway && r.closed) return Infinity;
    return travelTime(e, r.level * e.capacity);
  }

  /**
   * Zbiór odcinków niedostępnych dla aut. Budowany raz i ważny do momentu
   * decyzji gracza – wcześniej powstawał na każde wywołanie Dijkstry
   * (kosztował 26 ms na tick, czyli połowę czasu klatki).
   */
  private blockedCache: { set: Set<number>; at: number } | null = null;
  private blockedPredicate(): (e: number) => boolean {
    if (!this.blockedCache) {
      const set = new Set<number>();
      for (const r of this.roads) {
        // Katastrofa zamyka wszystkich, także tramwaje.
        if (r.destroyed || r.closure === 'closed' || r.pedestrian || !r.edge.carAccess) set.add(r.edge.id);
      }
      this.blockedCache = { set, at: this.version };
    }
    const { set } = this.blockedCache;
    return (e: number) => set.has(e);
  }

  private path(src: number, dst: number, kind: VehKind): number[] | null {
    if (kind === TRAM) {
      // Tramwaje jadą swoją trasą z GTFS – Dijkstra tylko awaryjnie.
      return this.g.adj[src].some((o) => o.to === dst) ? [dst] : null;
    }
    const blocked = this.blockedPredicate();
    const tree = this.trees.get(this.g, dst, blocked, this.costs, this.version);
    const edges = tree.pathToRoot(src);
    if (!edges || !edges.length) return null;
    // Drzewo zwraca listę ODCINKÓW w kolejności src → cel; zamieniamy na węzły.
    const nodes = new Array<number>(edges.length);
    let cur = src;
    for (let i = 0; i < edges.length; i++) {
      const e = this.g.edges[edges[i]];
      cur = e.a === cur ? e.b : e.a;
      nodes[i] = cur;
    }
    return nodes;
  }

  private edgeBetween(a: number, b: number): number | undefined {
    const hit = this.g.adj[a].find((o) => o.to === b);
    return hit?.e;
  }

  private pickDest(v: Veh, from: number): boolean {
    if (v.kind === CAR) {
      // Cele to huby – dzięki temu liczba potrzebnych drzew jest stała.
      const pool = this.hubs.length ? this.hubs : this.carTargets.length ? this.carTargets : this.carNodes;
      if (!pool.length) { this.respawn(v); return false; }
      for (let i = 0; i < 3; i++) {
        const d = pool[Math.floor(this.rnd() * pool.length)];
        if (d === from) continue;
        const p = this.path(from, d, v.kind);
        if (p && p.length) { v.dest = d; v.nodes = p; return true; }
      }
      this.respawn(v);
      return false;
    }
    // Tramwaj/autobus wracają do następnego węzła trasy.
    for (let k = 1; k <= v.route.length; k++) {
      const idx = (v.si + k - 1) % v.route.length;
      const d = v.route[idx];
      if (d === from) continue;
      const eid = this.edgeBetween(from, d);
      if (eid === undefined) continue;
      if (v.kind === TRAM) {
        const e = this.roads[eid]?.edge;
        if (!e || (e.roadClass !== 'tram' && !e.hasTram)) continue;
      }
      v.dest = d;
      v.si = idx;
      v.nodes = this.routeTail(from, idx);
      if (v.nodes.length) return true;
    }
    this.respawn(v);
    return false;
  }

  /** Węzły od `from` do indeksu `idx` w trasie pojazdu. */
  private routeTail(from: number, idx: number): number[] {
    const out: number[] = [];
    const route = this.vehRoute;
    for (let k = 1; k <= route.length; k++) {
      const i = (idx + k) % route.length;
      out.push(route[i]);
      if (i === from) break;
    }
    return out;
  }

  respawn(v: Veh) {
    if (v.kind === TRAM || v.kind === BUS) {
      // wróć na własną trasę GTFS zamiast lądować na przypadkowej ulicy
      const route = this.routes.find((r) => r.ref === v.ref && (v.kind === TRAM ? r.kind === 'tram' : r.kind === 'bus'));
      if (route) { this.spawnRouteVehicle(route); this.veh = this.veh.filter((x) => x !== v); return; }
    }
    let id = 0;
    for (let i = 0; i < 60; i++) {
      id = Math.floor(this.rnd() * this.roads.length);
      const r = this.roads[id];
      if (!r.closed && !r.pedestrian && r.edge.carAccess && r.edge.capacity > 0) break;
    }
    const r = this.roads[id];
    v.edge = id;
    v.dir = this.rnd() < 0.5 ? 1 : -1;
    v.s = this.rnd() * r.edge.len;
    v.nodes = [];
    v.speed = r.edge.speedLimit * 0.5;
    v.dest = -1;
    this.locate(v);
  }

  private arrive(v: Veh, node: number, over: number) {
    if (v.nodes.length) {
      const e = this.edgeBetween(node, v.nodes[0]);
      if (e === undefined || this.cost(this.roads[e], v.kind) === Infinity) {
        v.nodes = this.path(node, v.dest, v.kind) ?? [];
      }
    }
    if (v.stuck > 0) { v.stuck--; return; }
    if (!v.nodes.length && !this.pickDest(v, node)) return;

    if (v.kind === TRAM) {
      // Pomiń skoki GTFS bez torowiska; zostań tylko na hasTram / roadClass tram.
      while (v.nodes.length) {
        const nx = v.nodes.shift()!;
        const id = this.edgeBetween(node, nx);
        if (id === undefined) { node = nx; continue; }
        const ed = this.roads[id]?.edge;
        if (!ed || (ed.roadClass !== 'tram' && !ed.hasTram)) { node = nx; continue; }
        v.edge = id;
        v.dir = ed.a === node ? 1 : -1;
        v.s = over;
        return;
      }
      this.respawn(v);
      return;
    }

    const nx = v.nodes.shift()!;
    const id = this.edgeBetween(node, nx);
    if (id === undefined) {
      // Gracz zamknął odcinek trasy – wracamy do początku kursu i jedziemy dalej.
      v.nodes = v.kind === CAR ? [] : v.route.slice(1);
      v.dest = v.kind === CAR ? -1 : (v.route[1] ?? -1);
      v.si = 0;
      return;
    }
    v.edge = id;
    v.dir = this.roads[id].edge.a === node ? 1 : -1;
    v.s = over;
  }

  private move(v: Veh, dt: number) {
    if (v.kind !== CAR) this.vehRoute = v.route;
    const r = this.roads[v.edge];
    if (!r?.edge) { this.respawn(v); return; }
    const e = r.edge;
    if (v.kind === TRAM && e.roadClass !== 'tram' && !e.hasTram) {
      this.respawn(v);
      return;
    }
    if (v.dwell > 0) { v.speed *= 0.85; v.dwell -= dt; }
    else {
      if (r.destroyed || r.closure === 'closed') { v.speed = 0; v.dwell = Math.max(v.dwell, 1); return; }
      const congestionFactor = v.kind === TRAM ? 0.85 : Math.max(0.12, 1 - 0.85 * Math.pow(Math.min(1, r.level), 1.5));
      let target = v.kind === TRAM ? 9.5 : e.speedLimit * congestionFactor;
      if (this.temp < 2) target *= 0.9;
      if (v.kind === BUS) target *= 0.88;
      // Hamowanie gdy z przodu (ten sam tor / kierunek) jest inny pojazd.
      const ahead = this.vehicleAhead(v);
      if (ahead) {
        const gap = ahead.s - v.s;
        const need = Math.max(minGap(v.kind), minGap(ahead.kind));
        if (gap < need * 2.2) {
          const t = Math.max(0, Math.min(1, (gap - need * 0.35) / (need * 1.8)));
          target = Math.min(target, ahead.speed * 0.85 + target * t * 0.15);
          if (gap < need * 1.05) target = Math.min(target, 0.4);
        }
      }
      v.speed += (target - v.speed) * Math.min(1, dt * 1.4);
      const before = v.s;
      v.s += v.speed * dt;
      const hasStop = r.realStop || r.addedStop;
      if (hasStop && v.kind !== CAR && before < e.len / 2 && v.s >= e.len / 2) v.dwell = 3.5;
      if (v.s >= e.len) this.arrive(v, v.dir > 0 ? e.b : e.a, v.s - e.len);
    }
    this.locate(v);
  }

  /** Najbliższy pojazd z przodu na tym samym odcinku i kierunku. */
  private vehicleAhead(v: Veh): Veh | null {
    let best: Veh | null = null;
    let bestS = Infinity;
    for (const o of this.veh) {
      if (o === v || o.edge !== v.edge || o.dir !== v.dir) continue;
      if (o.s <= v.s + 0.05) continue;
      if (o.s < bestS) { bestS = o.s; best = o; }
    }
    return best;
  }

  /**
   * Odstępy między pojazdami na tym samym odcinku i kierunku.
   * Sortujemy rosnąco po s: a jest z tyłu, b z przodu. Gdy odstęp za mały –
   * spychamy tylny (a) i gasimy prędkość.
   */
  private enforceSpacing() {
    const byEdge = this.laneBuckets;
    byEdge.clear();
    for (const v of this.veh) {
      const arr = byEdge.get(v.edge);
      if (arr) arr.push(v); else byEdge.set(v.edge, [v]);
    }
    for (const arr of byEdge.values()) {
      if (arr.length < 2) continue;
      arr.sort(cmpVeh);
      for (let i = 1; i < arr.length; i++) {
        const rear = arr[i - 1], front = arr[i];
        if (rear.dir !== front.dir) continue;
        const need = Math.max(minGap(rear.kind), minGap(front.kind));
        const gap = front.s - rear.s;
        if (gap >= need) continue;
        // tylny wjechał w przedni – cofnij tylny i zatrzymaj
        rear.s = front.s - need;
        if (rear.s < 0) rear.s = 0;
        rear.speed = Math.min(rear.speed, front.speed * 0.35);
        if (rear.dwell <= 0) rear.dwell = 0.08;
      }
    }
  }

  private laneBuckets = new Map<number, Veh[]>();

  private locate(v: Veh) {
    const e = this.roads[v.edge].edge;
    const t = v.dir > 0 ? v.s : e.len - v.s;
    const off = v.kind === TRAM ? 0 : v.kind === BUS ? 2.4 : 2.0;
    // Kierunek jazdy = hx/hz krawędzi × dir (tramwaj bez offsetu bocznego – na osi toru).
    const hx = e.hx * v.dir, hz = e.hz * v.dir;
    v.x = e.ax + e.hx * t - hz * off;
    v.z = e.az + e.hz * t + hx * off;
    // Mesh ma długość w +X; po rotacji Y forward = (cos yaw, -sin yaw) = (hx, hz).
    v.yaw = Math.atan2(-hz, hx);
  }

  /* ------------------------------------------- komunikacja na realnych trasach */

  /** Gęstość symulowanych pojazdów MPK – zależna od godziny (mniej w nocy). */
  private retargetTransit() {
    const want = new Map<number, number>();
    const demand = this.transitDemandFactor();
    // Noc: budżet może spaść do 0 – bez sztucznego minimum floty.
    let tramBudget = Math.max(0, Math.round(28 * demand));
    let busBudget = Math.max(0, Math.round(55 * demand));
    for (const r of this.routes) {
      if (r.nodes.length < 4) continue;
      const len = this.routeLength(r);
      if (r.kind === 'tram') {
        const base = Math.min(2, Math.max(0, Math.round(len / 2000 * demand)));
        const take = Math.min(base, tramBudget);
        tramBudget -= take;
        want.set(r.index, take);
      } else {
        const base = Math.min(2, Math.max(0, Math.round(len / 1400 * demand)));
        const take = Math.min(base, busBudget);
        busBudget -= take;
        want.set(r.index, take);
      }
    }
    this.transitVehPerRoute = want;
  }

  /** Usuwa nadmiarowe pojazdy MPK, gdy cap spadł (np. po retarget). */
  private enforceTransitCaps() {
    for (const r of this.routes) {
      const want = this.transitVehPerRoute.get(r.index) ?? 0;
      const mine = this.veh.filter((v) => v.kind !== CAR && v.route === r.nodes);
      for (let i = want; i < mine.length; i++) {
        const idx = this.veh.indexOf(mine[i]);
        if (idx >= 0) this.veh.splice(idx, 1);
      }
    }
  }

  private routeLength(r: SimRoute): number {
    let len = 0;
    for (let i = 1; i < r.nodes.length; i++) {
      const id = this.edgeBetween(r.nodes[i - 1], r.nodes[i]);
      if (id !== undefined) len += this.roads[id].edge.len;
    }
    return len;
  }

  private respawnAllTransit() {
    // Usuwamy symulowane pojazdy MPK, gdy zmienił się zestaw tras.
    const keep = new Set<number>();
    for (const v of this.veh) {
      if (v.kind === CAR) keep.add(this.veh.indexOf(v));
    }
    this.veh = this.veh.filter((v) => v.kind === CAR);

    for (const r of this.routes) {
      const want = this.transitVehPerRoute.get(r.index) ?? 0;
      for (let i = 0; i < want; i++) this.spawnRouteVehicle(r);
    }
    void keep;
  }

  /** Wstawia jeden pojazd MPK w losowym miejscu jego realnej trasy GTFS. */
  private spawnRouteVehicle(r: SimRoute) {
    if (r.nodes.length < 2) return;
    const isTram = r.kind === 'tram';
    const minClear = isTram ? 70 : 28;
    for (let attempt = 0; attempt < 16; attempt++) {
      const startAt = Math.floor(this.rnd() * r.nodes.length);
      const node = r.nodes[startAt];
      const next = r.nodes[(startAt + 1) % r.nodes.length];
      const id = this.edgeBetween(node, next);
      if (id === undefined) continue;
      const edge = this.roads[id]?.edge;
      if (!edge) continue;
      if (isTram && edge.roadClass !== 'tram' && !edge.hasTram) continue;
      const dir: 1 | -1 = edge.a === node ? 1 : -1;
      const s = this.rnd() * Math.max(1, edge.len - minClear * 0.5);
      // nie spawnuj na drugim pojeździe
      let blocked = false;
      for (const o of this.veh) {
        if (o.edge !== id || o.dir !== dir) continue;
        if (Math.abs(o.s - s) < minClear) { blocked = true; break; }
      }
      if (blocked) continue;
      const v = this.newVeh(isTram ? TRAM : BUS, r.ref, r.nodes);
      v.variant = this.rnd();
      v.edge = id;
      v.dir = dir;
      v.s = s;
      v.si = startAt;
      v.dest = next;
      v.stuck = 0;
      v.nodes = r.nodes.slice(startAt + 1);
      this.locate(v);
      this.veh.push(v);
      return;
    }
  }

  private newVeh(kind: VehKind, ref: string, route: number[]): Veh {
    return { kind, ref, route, si: 0, edge: 0, dir: 1, s: 0, speed: 0, dest: -1, stuck: 0, nodes: [], dwell: 0, x: 0, z: 0, yaw: 0, variant: 0.5 };
  }

  private spawnCar() {
    const v = this.newVeh(CAR, '', []);
    v.variant = this.rnd();
    this.respawn(v);
    this.veh.push(v);
  }

  /* ------------------------------------------------------------- piesi */

  private reweight() {
    for (const r of this.roads) {
      const mx = (r.edge.ax + r.edge.bx) / 2, mz = (r.edge.az + r.edge.bz) / 2;
      let w = 1;
      if (r.pedestrian) w += 7;
      if (r.closed) w += 4;
      if (r.edge.roadClass === 'pedestrian' || r.edge.roadClass === 'living_street') w += 6;
      if (r.realStop || r.addedStop) w += 3;
      if (r.transit) w += 2;
      for (const p of this.parks) if (Math.hypot(p.x - mx, p.z - mz) < p.r + 40) w += 6;
      r.walkWeight = w;
    }
    this.peds_ = new PedestrianPool(this.g, this.rnd, MAX_PEDS);
    this.peds = this.peds_.peds;
    const active = Math.round(this.activePeds);
    for (let i = 0; i < Math.min(active, MAX_PEDS); i++) this.peds_.place(this.peds[i], this.pickPedEdge());
  }

  private pickPedEdge(): number {
    let total = 0;
    for (const r of this.roads) total += r.walkWeight;
    let x = this.rnd() * total;
    for (const r of this.roads) { x -= r.walkWeight; if (x <= 0) return r.edge.id; }
    return 0;
  }

  /* ------------------------------------------------------------ metryki */

  private metrics() {
    let carLen = 0, tlSum = 0, total = 0, closedLen = 0, pedLen = 0;
    for (const r of this.roads) {
      total += r.edge.len;
      if (r.closed || r.closure === 'closed' || r.destroyed) closedLen += r.edge.len;
      if (r.pedestrian) pedLen += r.edge.len;
      if (!r.destroyed && r.closure !== 'closed' && !r.pedestrian && r.edge.carAccess) {
        carLen += r.edge.len;
        tlSum += Math.min(1, r.level) * r.edge.len;
      }
    }
    let sr = 0, sn = 0, tr = 0, tn = 0;
    for (const v of this.veh) {
      const lim = this.roads[v.edge].edge.speedLimit;
      if (v.kind === CAR) { sr += Math.min(1, v.speed / lim); sn++; }
      else { tr += Math.min(1, v.speed / (v.kind === TRAM ? 11 : lim)); tn++; }
    }
    const tl = carLen ? tlSum / carLen : 0;
    const np = this.parks.length;
    const clamp = (v: number, a = 0, b = 100) => Math.max(a, Math.min(b, v));
    const traffic = clamp(58 * tl + 42 * (1 - (sn ? sr / sn : 1)));
    // Hałas: głośniej blisko tras z komunikacją i na ulicach z ruchem.
    const noise = clamp(16 + 88 * (tlSum / Math.max(1, total)) + (this.activePeds / MAX_PEDS) * 8 + this.realVehicles.length * 0.05 - np * 2.5 + this.disasterMood.noise);
    // Smog: ruch + tło z modelu jakości powietrza (PREDICTED, nie pomiar).
    const pollution = clamp(8 + 0.5 * traffic + 24 * (tlSum / Math.max(1, total)) * this.airFactor - np * 4 - (pedLen / Math.max(1, total)) * 45 + this.disasterMood.pollution);
    const realTransitShare = Math.min(35, this.realVehicles.length * 0.25);
    const transit = clamp(18 + this.stops.length * 0.4 + realTransitShare + 45 * (tn ? tr / tn : 1));
    const demand = this.transitDemandFactor();
    const target = clamp(
      (120 + pedLen / 5 + closedLen / 8 + np * 24 + this.stops.length * 0.35) * (0.35 + 0.85 * demand),
      Math.max(40, Math.round(80 * demand)),
      MAX_PEDS,
    );
    const old = Math.round(this.activePeds);
    this.activePeds += clamp(target - this.activePeds, -18, 18);
    const now = Math.round(this.activePeds);
    for (let i = Math.min(old, now); i < now && i < MAX_PEDS; i++) this.peds_.place(this.peds[i], this.pickPedEdge());
    const pedestrians = clamp((this.activePeds / MAX_PEDS) * 155);
    const nClosed = this.roads.filter((r) => r.closure === 'closed' || r.destroyed).length;
    const nPed = this.roads.filter((r) => r.pedestrian).length;
    // Przyjemność rośnie w chłodny dzień, spada w smog i korki.
    const weatherBonus = this.temp < 24 && this.temp > 2 ? 6 : this.temp >= 24 ? -4 : -8;
    const satT = clamp(
      74 - 0.32 * traffic - 0.14 * pollution - 0.2 * noise + 0.11 * pedestrians
      + 0.1 * (transit - 50) + np * 3 + nPed * 1.4 - nClosed * 2.4 + weatherBonus
      - (this.airFactor - 1) * 12 + this.disasterMood.satisfaction,
    );
    const m = this.m;
    this.m = {
      traffic, transit, pedestrians, pollution, noise,
      satisfaction: m.satisfaction + (satT - m.satisfaction) * 0.1,
      budget: m.budget + BUDGET_INCOME_PER_SIM_SEC + m.satisfaction * 0.4 + pedestrians * 0.25 - this.stops.length * 0.2 - np * 0.8,
    };
  }

  /* --------------------------------------------------------- predykcja */

  private runAssignment() {
    if (!this.assignment) return;
    this.assignment.run();
    this.applyAssignment();
    this.assignAt = Date.now();
    this.assignIterations = this.assignment.result.iterations;
  }

  /**
   * Usuwa pojazdy, które wypadły poza obszar symulacji.
   * Trasa z GTFS bywa przycięta do bboxa, a po zamknięciu ulicy pojazd może
   * zawinąć poza mapę – taki agent jest usuwany, żeby nie jeździł w nicości
   * i nie kosztował mocy obliczeniowej.
   */
  cullOutsideArea(): number {
    const area = this.city?.area;
    if (!area) return 0;
    const mLon = 111_320 * Math.cos((area.origin.lat * Math.PI) / 180);
    const halfX = ((area.maxLon - area.origin.lon) * mLon) / 2 + 120;
    const halfZ = ((area.origin.lat - area.minLat) * 111_320) / 2 + 120;
    const before = this.veh.length;
    this.veh = this.veh.filter((v) => !(Math.abs(v.x) > halfX || v.z < -halfZ || v.z > halfZ));
    const removed = before - this.veh.length;
    if (removed) this.respawnTransit();
    return removed;
  }

  /** Uzupełnia brakujące pojazdy MPK po usunięciu tych, które wypadły z mapy. */
  private respawnTransit() {
    const have = new Set(this.veh.filter((v) => v.kind !== CAR).map((v) => v.ref + v.route.length));
    for (const r of this.routes) {
      const want = this.transitVehPerRoute.get(r.index) ?? 0;
      if (!want) continue;
      const count = this.veh.filter((v) => v.kind !== CAR && v.ref === r.ref && v.route === r.nodes).length;
      for (let i = count; i < want; i++) this.spawnRouteVehicle(r);
    }
    void have;
  }

  /** Po zmianach gracza zbiór zamkniętych ulic trzeba zbudować od nowa. */
  invalidateRouting() {
    this.blockedCache = null;
    this.trees.clear();
  }

  private applyAssignment() {
    if (!this.assignment) return;
    const { level } = this.assignment.result;
    for (let i = 0; i < this.roads.length; i++) {
      const r = this.roads[i];
      r.predicted = r.closed || r.pedestrian || !r.edge.carAccess ? 0 : Math.min(1.1, level[i]);
    }
  }

  /** Wywoływane po każdej decyzji gracza – natychmiastowa predykcja konsekwencji. */
  reroute() {
    this.version++;
    this.trees.clear();
    this.runAssignment();
    for (const v of this.veh) {
      if (v.kind !== CAR || v.dest < 0) continue;
      const e = this.roads[v.edge].edge;
      const from = v.dir > 0 ? e.b : e.a;
      v.nodes = this.path(from, v.dest, v.kind) ?? [];
    }
  }

  /* ------------------------------------------------------------ akcje */

  private spend(c: number) { if (this.m.budget < c) return false; this.m.budget -= c; return true; }

  setClosed(id: number, closed: boolean): string | null {
    const r = this.roads[id];
    if (!r || r.closed === closed) return null;
    if (closed) {
      if (this.roads.filter((x) => !x.closed && !x.pedestrian && x.edge.carAccess).length <= 12) {
        return 'Zostaw otwartych kilka ulic, inaczej auta nie mają którędy jechać.';
      }
      if (!this.spend(COST.close)) return 'Za mało środków w budżecie.';
    }
    r.closed = closed;
    this.reweight();
    this.invalidateRouting();
    this.reroute();
    return null;
  }

  setPedestrian(id: number, on: boolean): string | null {
    const r = this.roads[id];
    if (!r || r.pedestrian === on) return null;
    if (on) {
      if (this.roads.filter((x) => !x.closed && !x.pedestrian && x.edge.carAccess).length <= 12) {
        return 'Zostaw otwartych kilka ulic, inaczej auta nie mają którędy jechać.';
      }
      if (!this.spend(COST.pedestrian)) return 'Za mało środków w budżecie.';
    }
    r.pedestrian = on;
    this.reweight();
    this.invalidateRouting();
    this.reroute();
    return null;
  }

  addStop(id: number): string | null {
    const r = this.roads[id];
    if (!r) return 'Nieznany odcinek.';
    if (r.addedStop) return 'Na tym odcinku jest już Twój przystanek.';
    if (r.realStop) return 'Tu już jest prawdziwy przystanek MPK.';
    if (r.closed) return 'Nie dodasz przystanku na zamkniętej ulicy.';
    if (r.edge.len < 60) return 'Odcinek jest za krótki na przystanek.';
    if (!this.spend(COST.stop)) return 'Za mało środków w budżecie.';
    r.addedStop = true;
    this.stops.push({ roadId: id, name: `Nowy przystanek, ${r.edge.name}`, lines: [] });
    this.reweight();
    this.invalidateRouting();
    this.reroute();
    return null;
  }

  addPark(x: number, z: number, shape: 'circle' | 'rect' = 'circle', w = 52, d = 36): string | null {
    const area = this.city?.area;
    const maxX = ((area ? area.maxLon - area.origin.lon : 0.011) * 111320 * Math.cos((50.06 * Math.PI) / 180));
    const maxZ = ((area ? area.origin.lat - area.minLat : 0.009) * 111320);
    if (Math.abs(x) > maxX || z < -maxZ || z > maxZ) return 'Poza obszarem miasta.';
    if (this.parks.some((p) => Math.hypot(p.x - x, p.z - z) < 40)) return 'W tym miejscu jest już park.';
    if (this.roads.some((r) => distToSegment(r.edge, x, z) < 12)) return 'Za blisko jezdni. Kliknij w środek kwartału.';
    if (!this.spend(COST.park)) return 'Za mało środków w budżecie.';
    const park: Park = shape === 'rect'
      ? { x, z, r: Math.max(8, w / 2), d: Math.max(8, d / 2), shape: 'rect' }
      : { x, z, r: Math.max(12, Math.min(w, d) / 2), shape: 'circle' };
    this.parks.push(park);
    this.reweight();
    this.invalidateRouting();
    this.reroute();
    return null;
  }

  /** Nowe torowisko tramwajowe – jak droga, ale tylko dla tramwajów. */
  addTramTrack(x1: number, z1: number, x2: number, z2: number): string | null {
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 40) return 'Torowisko musi mieć co najmniej 40 m.';
    if (len > 900) return 'Torowisko może mieć maksymalnie 900 m.';
    if (!this.spend(COST.road)) return 'Za mało środków w budżecie.';

    const a = this.g.nodes.length, b = a + 1;
    this.g.nodes.push({ x: x1, z: z1 }, { x: x2, z: z2 });
    const id = this.g.edges.length;
    const speed = 30 / 3.6;
    this.g.edges.push({
      id, name: 'Nowe torowisko', roadClass: 'tram',
      a, b, ax: x1, az: z1, bx: x2, bz: z2,
      hx: (x2 - x1) / len, hz: (z2 - z1) / len, len,
      speedLimit: speed, capacity: 0,
      lanesForward: 1, oneway: false, carAccess: false,
      transit: true, hasTram: true, osmId: -1, at: [a, b],
    });
    (this.g.adj[a] ??= []).push({ e: id, to: b });
    (this.g.adj[b] ??= []).push({ e: id, to: a });

    const rs: RoadSim = {
      edge: this.g.edges[id],
      closure: 'none', destroyed: false,
      baseline: 0.15, baselineOrigin: 'SIMULATED',
      baselineSpeed: speed, predicted: 0.15, level: 0.1, capacity: 0,
      closed: false, pedestrian: false, addedStop: false, realStop: false,
      transit: true, built: true, vehicles: 0, walkWeight: 1,
    };
    this.roads.push(rs);
    this.invalidateRouting();
    this.reroute();
    this.history.push({
      label: 'nowe torowisko', at: Date.now(),
      apply: () => { this.invalidateRouting(); this.reroute(); },
      revert: () => {
        this.roads = this.roads.filter((x) => x !== rs);
        this.invalidateRouting();
        this.reroute();
      },
    });
    return null;
  }

  /* ------------------------------------------------- akcje gracza (v2) */

  /** Przystanek autobusowy albo tramwajowy w wybranym przez gracza punkcie. */
  addStopAt(roadId: number, mode: 'bus' | 'tram'): string | null {
    const r = this.roads[roadId];
    if (!r) return 'Nie kliknij ulicy.';
    if (r.destroyed || r.closure === 'closed') return 'Nie postawisz przystanku na zamkniętej ulicy.';
    if (r.addedStop) return 'Na tym odcinku masz już swój przystanek.';
    if (mode === 'tram' && r.edge.roadClass !== 'tram' && !r.edge.hasTram) {
      return 'Przystanek tramwajowy stawia się tylko przy torowisku.';
    }
    if (mode === 'bus' && !r.edge.carAccess && r.edge.roadClass !== 'pedestrian') {
      return 'Przystanek autobusowy wymaga ulicy przejezdnej.';
    }
    if (r.realStop) {
      const isTramReal = this.g.edges[roadId].hasTram || this.g.edges[roadId].roadClass === 'tram';
      if (isTramReal === (mode === 'tram')) return 'Tu już jest prawdziwy przystanek MPK tego rodzaju.';
    }
    const cost = mode === 'tram' ? COST.stopTram : COST.stop;
    if (r.edge.len < 45) return 'Odcinek jest za krótki na przystanek.';
    if (!this.spend(cost)) return 'Za mało środków w budżecie.';

    const stop: NewStop = { roadId, mode, name: mode === 'tram' ? `Nowy przystanek tramwajowy` : `Nowy przystanek autobusowy`, cost, at: Date.now() };
    const apply = () => {
      this.playerStops.push(stop);
      r.addedStop = true;
      if (mode === 'tram') r.transit = true;
      this.reweight();
      this.invalidateRouting();
      this.reroute();
    };
    const revert = () => {
      this.playerStops = this.playerStops.filter((x) => x !== stop);
      r.addedStop = false;
      this.reweight();
      this.invalidateRouting();
      this.reroute();
    };
    apply();
    this.history.push({ label: `przystanek ${mode === 'tram' ? 'tramwajowy' : 'autobusowy'} (${r.edge.name})`, at: Date.now(), apply, revert });
    return null;
  }

  /** Zamknięcie ulicy wyłącznie dla samochodów – tramwaje jadą dalej. */
  setCarsOnly(id: number, on: boolean): string | null {
    const r = this.roads[id];
    if (!r) return 'Nieznany odcinek.';
    const hasTransit = r.edge.hasTram || r.edge.roadClass === 'tram';
    if (on && !hasTransit) return 'Tą ulicą nie jeżdżą tramwaje – użyj zwykłego zamknięcia.';
    if ((r.closure === 'cars-only') === on) return null;
    if (on && this.roads.filter((x) => !x.destroyed && x.closure !== 'closed' && !x.pedestrian && x.edge.carAccess).length <= 12) {
      return 'Zostaw otwartych kilka ulic dla aut.';
    }
    if (on && !this.spend(COST.carsOnly)) return 'Za mało środków w budżecie.';
    const apply = () => {
      r.closure = on ? 'cars-only' : 'none';
      r.pedestrian = false;
      this.reweight();
      this.invalidateRouting();
      this.reroute();
    };
    const revert = () => {
      r.closure = on ? 'none' : 'cars-only';
      this.reweight();
      this.invalidateRouting();
      this.reroute();
    };
    apply();
    this.history.push({ label: on ? `zamknięcie dla aut: ${r.edge.name}` : `otwarcie dla aut: ${r.edge.name}`, at: Date.now(), apply, revert });
    return null;
  }

  /** Nowy budynek z katalogu (SIMULATED). */
  addStructure(kind: BuildId, x: number, z: number, rot = 0): string | null {
    const spec = buildSpec(kind);
    const area = this.city?.area;
    const mLon = 111_320 * Math.cos(((area?.origin.lat ?? 50.06) * Math.PI) / 180);
    const halfX = ((area ? area.maxLon - area.origin.lon : 0.011) * mLon) / 2 - 20;
    const halfZ = ((area ? area.origin.lat - area.minLat : 0.009) * 111_320) / 2 - 20;
    if (Math.abs(x) > halfX || Math.abs(z) > halfZ) return 'Poza obszarem miasta.';
    if (spec.id === 'park') return this.addPark(x, z, 'circle', spec.w, spec.d);
    const clash = this.playerBuildings.some((b) => Math.hypot(b.x - x, b.z - z) < Math.max(b.w, b.d) * 0.55);
    if (clash) return 'Za blisko innego budynku.';
    if (!this.spend(spec.cost)) return 'Za mało środków w budżecie.';

    const angle = spec.rotatable ? rot : 0;
    const b: PlayerBuilding = {
      id: this.playerBuildings.length,
      x, z, w: spec.w, d: spec.d, h: spec.h, rot: angle,
      kind: spec.id,
      name: spec.label,
      color: spec.color,
      roof: spec.roof,
      residents: spec.residents,
      jobs: spec.jobs,
    };
    const apply = () => {
      this.playerBuildings.push(b);
      this.reweight();
      this.reroute();
    };
    const revert = () => {
      this.playerBuildings = this.playerBuildings.filter((p) => p !== b);
      this.reweight();
      this.reroute();
    };
    apply();
    this.hubs = [...this.hubs, this.nearestCarNode(x, z)].filter((n) => n >= 0);
    this.history.push({ label: b.name, at: Date.now(), apply, revert });
    return null;
  }

  /** Usunięcie budynku gracza (nie OSM). */
  removePlayerBuilding(id: number): string | null {
    const b = this.playerBuildings.find((p) => p.id === id);
    if (!b) return 'Nie znaleziono budynku gracza.';
    const apply = () => {
      this.playerBuildings = this.playerBuildings.filter((p) => p.id !== id);
      this.reweight();
      this.reroute();
    };
    const revert = () => {
      this.playerBuildings.push(b);
      this.reweight();
      this.reroute();
    };
    apply();
    this.history.push({ label: `usunięto: ${b.name}`, at: Date.now(), apply, revert });
    return null;
  }

  redo(): string | null {
    const msg = this.history.redo();
    this.version++;
    this.invalidateRouting();
    this.reroute();
    return msg;
  }

  /**
   * Podgląd katastrofy bez zmiany stanu – do panelu Anuluj / Uruchom.
   */
  previewDisaster(kind: DisasterKind, cx: number, cz: number): {
    roads: number[];
    radius: number;
    label: string;
    cost: number;
    estimatedAffected: number;
    effects: typeof DISASTER_EFFECTS[DisasterKind];
  } {
    const def = DISASTERS[kind];
    const hit = pickRoads(
      this.roads.filter((r) => !r.built),
      cx, cz, def.radius, def.count,
      (r) => !r.destroyed && r.edge.carAccess,
    );
    const roads = hit.map((r) => r.edge.id);
    let residents = 0;
    for (const b of this.playerBuildings) {
      if (Math.hypot(b.x - cx, b.z - cz) <= def.radius) residents += b.residents;
    }
    // Szacunek: gęstość z budynków OSM w promieniu (przybliżenie).
    const estOsm = Math.round(def.radius * def.radius * 0.00035);
    return {
      roads,
      radius: def.radius,
      label: def.label,
      cost: def.cost,
      estimatedAffected: residents + estOsm,
      effects: DISASTER_EFFECTS[kind],
    };
  }

  /** Nowa droga / autostrada łącząca dwa punkty – wstawiana do grafu. */
  addRoad(x1: number, z1: number, x2: number, z2: number, highway: boolean): string | null {
    const len = Math.hypot(x2 - x1, z2 - z1);
    if (len < 60) return 'Droga musi mieć co najmniej 60 m.';
    if (len > 900) return 'Droga może mieć maksymalnie 900 m.';
    if (!this.spend(highway ? COST.road * 2 : COST.road)) return 'Za mało środków w budżecie.';

    const a = this.g.nodes.length, b = a + 1;
    this.g.nodes.push({ x: x1, z: z1 }, { x: x2, z: z2 });
    const id = this.g.edges.length;
    const speed = highway ? 120 / 3.6 : 60 / 3.6;
    const lanes = highway ? 3 : 2;
    this.g.edges.push({
      id, name: highway ? 'Nowa autostrada' : 'Nowa droga', roadClass: highway ? 'primary' : 'residential',
      a, b, ax: x1, az: z1, bx: x2, bz: z2,
      hx: (x2 - x1) / len, hz: (z2 - z1) / len, len,
      speedLimit: speed, capacity: Math.round(((highway ? 900 : 500) / 4) * lanes),
      lanesForward: lanes, oneway: false, carAccess: true,
      transit: false, hasTram: false, osmId: -1, at: [a, b],
    });
    (this.g.adj[a] ??= []).push({ e: id, to: b });
    (this.g.adj[b] ??= []).push({ e: id, to: a });

    const capacity = Math.round(((highway ? 900 : 500) / 4) * lanes);
    const rs: RoadSim = {
      edge: this.g.edges[id],
      closure: 'none', destroyed: false,
      baseline: highway ? 0.25 : 0.2, baselineOrigin: 'SIMULATED',
      baselineSpeed: speed, predicted: 0.2, level: 0.1, capacity,
      closed: false, pedestrian: false, addedStop: false, realStop: false,
      transit: false, built: true, vehicles: 0, walkWeight: 1,
    };
    this.roads.push(rs);
    this.costByRoad.set(id, capacity);

    const apply = () => {
      rs.closure = 'none';
      rs.destroyed = false;
      this.roadLoad = new Float32Array(this.roads.length);
      this.invalidateRouting();
      this.reroute();
    };
    const revert = () => {
      this.roads = this.roads.filter((x) => x !== rs);
      this.g.edges.splice(id, 1);
      this.g.nodes.splice(b, 1);
      this.g.nodes.splice(a, 1);
      this.invalidateRouting();
      this.reroute();
    };
    apply();
    this.hubs = [...this.hubs, a].filter((n) => n >= 0);
    this.history.push({ label: highway ? 'nowa autostrada' : 'nowa droga', at: Date.now(), apply, revert });
    return null;
  }

  /** Najbliższy węzeł sieci zjazdowej – dla nowych celów ruchu. */
  private nearestCarNode(x: number, z: number): number {
    let best = -1, bd = Infinity;
    for (const e of this.g.edges) {
      if (!e.carAccess) continue;
      const t = Math.max(0, Math.min(1, ((x - e.ax) * e.hx + (z - e.az) * e.hz)));
      const d = Math.hypot(x - (e.ax + e.hx * e.len * t), z - (e.az + e.hz * e.len * t));
      if (d < bd) { bd = d; best = t < 0.5 ? e.a : e.b; }
    }
    return best;
  }

  /* ------------------------------------------------------------ katastrofy */

  /** Wywołuje katastrofę i od razu pokazuje jej skutki w modelu. */
  triggerDisaster(kind: DisasterKind, cx: number, cz: number): string | null {
    const def = DISASTERS[kind];
    if (!this.spend(def.cost)) return 'Za mało środków w budżecie.';

    const hit = pickRoads(
      this.roads.filter((r) => !r.built),
      cx, cz, def.radius, def.count,
      (r) => !r.destroyed && r.edge.carAccess,
    );
    const roads = hit.map((r) => r.edge.id);
    const d: DisasterState = {
      kind, roads, intensity: 1, startedAt: Date.now(),
      label: def.label, cx, cz,
    };
    const apply = () => {
      this.disasters.push(d);
      for (const id of roads) {
        const r = this.roads[id];
        if (!r) continue;
        if (kind === 'earthquake' || kind === 'fire') { r.destroyed = true; r.closure = 'none'; }
        else if (kind === 'flood' || kind === 'rain') { r.closure = 'closed'; }
        else if (kind === 'blackout' || kind === 'heat') { /* spowolnienie przez disasterMood */ }
      }
      this.destroyedCount = this.roads.filter((r) => r.destroyed).length;
      this.invalidateRouting();
      this.reroute();
    };
    const revert = () => {
      this.disasters = this.disasters.filter((x) => x !== d);
      for (const id of roads) {
        const r = this.roads[id];
        if (!r) continue;
        r.destroyed = false;
        if (r.closure === 'closed') r.closure = 'none';
      }
      this.destroyedCount = this.roads.filter((r) => r.destroyed).length;
      this.invalidateRouting();
      this.reroute();
    };
    apply();
    this.history.push({
      label: `${def.label} – ${roads.length} odcinków`,
      at: Date.now(), apply, revert,
    });
    return null;
  }

  /** Katastrofy wygasają z czasem; pożar i powódź są gaszone. */
  private tickDisasters(dt: number) {
    if (!this.disasters.length) { this.disasterSpeed = 1; return; }
    for (const d of this.disasters) {
      if (d.kind === 'blackout') {
        // awaria sieci trwa kilka minut, potem wraca zasilanie
        if ((Date.now() - d.startedAt) / 1000 > 240) d.intensity = Math.max(0, d.intensity - dt * 0.25);
      } else {
        d.intensity = Math.max(0, d.intensity - dt * 0.05);
        // gaszenie: po 60 s odblokowujemy część odcinków
        if (d.intensity < 0.25 && (d.kind === 'fire' || d.kind === 'flood')) {
          for (const id of d.roads) {
            const r = this.roads[id];
            if (!r) continue;
            if (r.destroyed && d.kind === 'fire') continue; // spalone odcinki zostają
            if (r.closure === 'closed') r.closure = 'none';
          }
          this.invalidateRouting();
        }
      }
    }
    this.disasters = this.disasters.filter((d) => d.intensity > 0.02);
    const p = disasterPenalty(this.disasters);
    this.disasterSpeed = p.speed;
    this.disasterMood = p;
  }

  /** Lista zmian gracza do pokazania w UI. */
  playerChanges(): PlayerChange[] {
    const out: PlayerChange[] = [];
    for (const r of this.roads) {
      if (r.destroyed) out.push({ roadId: r.edge.id, name: r.edge.name, change: 'destroyed' });
      else if (r.closure === 'cars-only') out.push({ roadId: r.edge.id, name: r.edge.name, change: 'cars-only' });
      else if (r.closure === 'closed') out.push({ roadId: r.edge.id, name: r.edge.name, change: 'closed' });
      if (r.addedStop) out.push({ roadId: r.edge.id, name: r.edge.name, change: 'stop-bus' });
    }
    return out;
  }

  /** Cofnięcie ostatniej decyzji gracza. */
  undo(): string | null {
    const msg = this.history.undo();
    if (msg) this.version++;
    return msg;
  }

  /** Snapshot stanu gracza do IndexedDB (przeżywa refresh). */
  exportPlayerState(): {
    buildings: PlayerBuilding[];
    parks: Park[];
    budget: number;
    residents: number;
    jobs: number;
  } {
    return {
      buildings: this.playerBuildings.map((b) => ({ ...b })),
      parks: this.parks.map((p) => ({ ...p })),
      budget: this.m.budget,
      residents: this.playerBuildings.reduce((s, b) => s + b.residents, 0),
      jobs: this.playerBuildings.reduce((s, b) => s + b.jobs, 0),
    };
  }

  /** Przywrócenie budynków/parków gracza (bez historii undo – nowa sesja). */
  applyPlayerSnapshot(snap: {
    buildings: PlayerBuilding[];
    parks: Park[];
    budget: number;
  }) {
    this.playerBuildings = snap.buildings.map((b, i) => ({ ...b, id: i }));
    this.parks = snap.parks.map((p) => ({ ...p }));
    this.m.budget = snap.budget;
    this.history = new PlayerHistory();
    this.reweight();
    this.invalidateRouting();
    this.reroute();
    this.version++;
  }

  /* --------------------------------------------------------- odczyty */

  snapshot(): Snapshot {
    const realTrams = this.realVehicles.filter((v) => v.type === 'tram').length;
    const realBuses = this.realVehicles.filter((v) => v.type === 'bus').length;
    const clock = this.clockParts();
    return {
      ...this.m,
      cars: this.veh.filter((v) => v.kind === CAR).length,
      vehiclesModelled: Math.round(this.carTarget * VEH_PER_AGENT),
      peds: Math.round(this.activePeds),
      trams: this.veh.filter((v) => v.kind === TRAM).length,
      buses: this.veh.filter((v) => v.kind === BUS).length,
      realVehicles: this.realVehicles.length,
      realTrams, realBuses,
      time: this.time,
      clock: clock.label,
      hour: clock.hour,
      weekend: clock.weekend,
      closed: this.roads.filter((r) => r.closure === 'closed' || r.destroyed).length,
      built: this.playerBuildings.length,
      newStops: this.playerStops.length,
      destroyed: this.destroyedCount,
      disasters: this.disasters.length,
      undoDepth: this.history.depth,
      assignmentAt: new Date(this.assignAt).toISOString(),
      assignmentIterations: this.assignIterations,
    };
  }

}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

/** Godzina lokalna Kraków/Warszawa z ms epoch. */
function warsawParts(ms: number): { hour: number; minute: number; second: number; weekend: boolean } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Warsaw',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '0';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const second = Number(get('second'));
  const wd = get('weekday').toLowerCase();
  const weekend = wd.startsWith('sat') || wd.startsWith('sun') || wd.startsWith('sob') || wd.startsWith('nie');
  return { hour, minute, second, weekend };
}

function distToSegment(e: GraphEdge, x: number, z: number): number {
  const dx = e.bx - e.ax, dz = e.bz - e.az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((x - e.ax) * dx + (z - e.az) * dz) / l2));
  return Math.hypot(x - (e.ax + dx * t), z - (e.az + dz * t));
}