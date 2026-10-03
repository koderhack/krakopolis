import type {
  BakedBuilding, BakedCity, BakedEnvironment, BakedManifest, BakedRoad, BakedStop,
  BakedTerrain, BakedTraffic, BakedTransit, BakedVehicleSnapshot,
} from '../baked';
import type { CityData, SimBuilding, SimNode, SimPolygon, SimRoad, SimRoute, SimStop } from '../model';
import type { Origin, RoadState, SourceStatus, TrafficState } from '../types';
import { distToSegment } from '../../simulation/city/catalog';
import { REFRESH, SOURCES } from '../config';
import { toLatLon } from '../geo';
import { generateInfill } from '../infill';
import { cachedEnvironment } from '../sources/environment/live';
import { snapshotToVehicles } from '../sources/mpk/live';

export interface BakedBundle {
  manifest: BakedManifest;
  city: BakedCity;
  transit: BakedTransit;
  traffic: BakedTraffic;
  environment: BakedEnvironment;
  vehicles: { generatedAt: string; vehicles: BakedVehicleSnapshot[] };
  /** Siatka wysokości – osobny plik terrain.json. */
  terrain?: BakedTerrain | null;
}

/**
 * Przenosi wypieczone dane do wewnętrznego schematu CityData.
 * Ustawia baseline ruchu drogowego na podstawie tego, co naprawdę wiemy:
 *  - poziom zakrzepienia z GTFS-RT (OBSERVED),
 *  - liczbie realnych pojazdów na odcinku (PREDICTED z OBSERVED),
 *  - klasie drogi i liczbie pasów, gdy brak pomiarów (PREDICTED, oznaczone w UI).
 */
export function buildCityData(b: BakedBundle): CityData {
  const stops: SimStop[] = b.transit.stops.map((s: BakedStop) => ({
    id: s.id, name: s.name, x: s.x, z: s.z, lat: s.lat, lon: s.lon, roadId: s.roadId ?? -1, lines: s.lines, mode: s.mode,
  }));

  const routes: SimRoute[] = b.transit.routes.map((r, index) => ({
    index,
    id: r.id,
    ref: r.ref,
    kind: r.kind,
    operator: r.operator,
    dir: r.dir,
    nodes: r.nodes,
    stops: r.stops,
    shape: b.transit.shapes[r.shape] ?? [],
  }));

  const congestion: Record<number, number> = {};
  for (const [k, v] of Object.entries(b.traffic.congestion ?? {})) congestion[Number(k)] = v;
  const measured = new Set<number>([...Object.keys(b.traffic.level).map(Number), ...Object.keys(congestion).map(Number)]);

  const roads: SimRoad[] = b.city.roads.map((r: BakedRoad) => {
    const capacity = capacityOf(r);
    const observedLevel = b.traffic.level?.[r.id];
    const cong = congestion[r.id];
    let baselineTraffic: number;
    let origin: Origin;
    if (cong !== undefined) {
      // ZTP: 1 = płynny, 2 = niewielki, 3 = średni, 4 = duży korek
      baselineTraffic = Math.min(1, (cong - 1) / 3);
      origin = 'OBSERVED';
    } else if (observedLevel !== undefined) {
      baselineTraffic = observedLevel;
      origin = 'PREDICTED';
    } else {
      baselineTraffic = estimateFromRoadClass(r);
      origin = 'PREDICTED';
    }
    const na = b.city.nodes[r.a], nb = b.city.nodes[r.b];
    const unnamed = na && nb
      ? formatCoords((na.x + nb.x) / 2, (na.z + nb.z) / 2)
      : formatCoords(0, 0);
    return {
      id: r.id,
      name: r.name || r.ref || unnamed,
      a: r.a,
      b: r.b,
      roadClass: r.roadClass,
      lanes: r.lanes,
      lanesForward: r.lanesForward,
      oneway: r.oneway,
      speedLimit: r.speedLimit,
      capacity,
      hasTram: r.hasTram,
      transit: r.transit || r.hasTram,
      carAccess: r.carAccess,
      osmId: r.osmId,
      baselineTraffic,
      baselineOrigin: origin,
      baselineSpeed: b.traffic.speed?.[r.id] ?? r.speedLimit * (1 - 0.45 * baselineTraffic),
      observedTransit: measured.has(r.id),
    };
  });

  // Najpierw naprawiamy graf (duplikaty / wiszące końce), potem odsuwamy
  // budynki od finalnej siatki – inaczej ściany wchodziłyby w „dziury” po snapie.
  const network = repairNetwork(b.city.nodes, roads);
  const corridor = new RoadCorridor(b.city.nodes, network.roads);
  let trimmed = 0, dropped = 0;
  // Przystanki z GTFS wskazują odcinki sprzed naprawy grafu. Jeśli odcinek
  // zniknął jako duplikat, doczepiamy przystanek do najbliższej ulicy –
  // inaczej tramwaj zniknąłby z trasy tylko dlatego, że ulica występuje w OSM
  // dwukrotnie (dwa pasy ruchu).
  for (const st of stops) {
    const to = network.remap.get(st.roadId ?? -1);
    if (to !== undefined) { st.roadId = to; continue; }
    st.roadId = nearestRoadTo(network.roads, b.city.nodes, st.x, st.z, 60);
  }
  const roadCount = network.roads.length;
  const buildings: SimBuilding[] = [];
  for (const x of b.city.buildings) {
    const fit = corridor.fit(x);
    if (fit === null) { dropped++; continue; }
    if (fit.trimmed) trimmed++;
    buildings.push({
      x: fit.x, z: fit.z, w: fit.w, d: fit.d, h: x.h, rot: x.rot, color: x.color, roof: x.roof,
      name: x.name, landmark: x.landmark, ring: fit.ring, levels: x.levels,
    });
  }
  const polygons: SimPolygon[] = b.city.polygons.map((p) => ({ ring: p.ring, kind: p.kind, name: p.name }));
  const osmCount = buildings.length;
  const infill = generateInfill(buildings, b.city.nodes, network.roads, polygons, 420);
  buildings.push(...infill);
  const pois = (b.city.pois ?? []).map((p) => ({ name: p.name, category: p.category, x: p.x, z: p.z }));

  const traffic: TrafficState = {
    observedLevel: b.traffic.level ?? {},
    observedSpeed: b.traffic.speed ?? {},
    origin: b.traffic.sampleSize > 0 ? 'PREDICTED' : 'SIMULATED',
    source: SOURCES.ztpRt.url,
    timestamp: b.traffic.generatedAt,
    sampleSize: b.traffic.sampleSize,
  };

  const { env, statuses: envStatuses } = cachedEnvironment(b.environment);
  const snap = snapshotToVehicles(
    {
      routes, rawTrips: b.transit.trips,
      roads, nodes: b.city.nodes,
    } as unknown as CityData,
    b.vehicles,
  );

  const staticStatuses: SourceStatus[] = [
    {
      ...SOURCES.osm,
      freshness: 'CACHED',
      dataTimestamp: b.city.generatedAt,
      fetchedAt: b.city.generatedAt,
      records: b.city.roads.length,
      note: `Drogi: ${roadCount}${network.duplicates ? ` (usunięto ${network.duplicates} duplikatów, dociągnięto ${network.snapped} końców)` : ''}, budynki OSM: ${osmCount}`
        + (infill.length ? ` + ${infill.length} uzupełnień (SIMULATED)` : '')
        + (trimmed || dropped ? ` (przyciętych do pasa drogowego: ${trimmed}, odrzuconych: ${dropped})` : '')
        + `, skrzyżowania: ${b.city.signals.length}, miejsca: ${pois.length}.`,
    },
    {
      ...SOURCES.ztpGtfs,
      freshness: 'CACHED',
      dataTimestamp: b.transit.generatedAt,
      fetchedAt: b.transit.generatedAt,
      records: routes.length,
      note: `Linie: ${routes.length}, przystanki: ${stops.length}.`,
    },
    snap.status,
    ...envStatuses,
  ];

  return {
    area: b.city.area,
    generatedAt: b.manifest.generatedAt,
    nodes: b.city.nodes,
    roads: network.roads,
    stops,
    routes,
    buildings,
    polygons,
    signals: b.city.signals,
    pois,
    terrain: b.terrain ?? null,
    traffic,
    liveVehicles: snap.vehicles,
    environment: env,
    statuses: staticStatuses,
    baselineOrigin: snap.vehicles.length ? 'OBSERVED' : 'PREDICTED',
    rawTrips: b.transit.trips,
  };
}

/**
 * Przepustowość w pojazdach na 15 minut, z klasyfikacji drogi OSM.
 * Wartości pochodzą z typowych przepustowości dla dróg miejskich
 * (poj./h na pas: motorway 1800, primary 800, residential 400) podzielonych przez 4.
 * To PREDICTED – OSM nie opisuje przepustowości.
 */
const VEH_PER_HOUR_PER_LANE: Record<string, number> = {
  motorway: 1800, trunk: 1400, primary: 800, secondary: 700, tertiary: 600,
  unclassified: 500, residential: 400, living_street: 150, service: 250, track: 200,
};

export function capacityOf(r: { roadClass: string; lanesForward: number; carAccess: boolean }): number {
  if (!r.carAccess) return 0;
  const lanes = Math.max(1, r.lanesForward);
  return Math.max(4, Math.round(((VEH_PER_HOUR_PER_LANE[r.roadClass] ?? 400) / 4) * lanes));
}

/** Etykieta zamiast „ulica bez nazwy” – środek odcinka w WGS84. */
export function formatCoords(x: number, z: number): string {
  const { lat, lon } = toLatLon(x, z);
  return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
}

/**
 * Ostatnia deska ratunku dla odcinka bez pomiarów: oszacowanie z klasy drogi
 * i prędkości dopuszczalnej. To jest PREDICTED – UI pokazuje to osobno.
 */
function estimateFromRoadClass(r: { roadClass: string; lanesForward: number; carAccess: boolean }): number {
  if (!r.carAccess) return 0;
  const rank: Record<string, number> = {
    motorway: 0.75, trunk: 0.6, primary: 0.55, secondary: 0.45, tertiary: 0.4,
    unclassified: 0.3, residential: 0.25, living_street: 0.12, service: 0.15, track: 0.1,
  };
  const lanes = Math.max(1, r.lanesForward);
  const base = rank[r.roadClass] ?? 0.25;
  // Tramwajowy torus zwykle odciąża jezdnię dla aut – dlatego mnożymy, gdy r.transit.
  return Math.min(0.85, base * (1 + (lanes - 1) * 0.05));
}

/**
 * Naprawa grafu dróg po scaleniu węzłów OSM.
 *
 * Po złączeniu dwujezdniowych ulic z ich osobnych osi powstają dokładnie
 * duplikaty odcinków (ta sama para węzłów), a końce ulic goniące się w
 * zbliżeniu zostają wiszące – na mapie wygląda to na „rozwaloną" siatkę.
 * Naprawa jest czysto pochodna: nie ruszamy danych źródłowych.
 */
function repairNetwork(nodes: SimNode[], roads: SimRoad[]): { roads: SimRoad[]; remap: Map<number, number>; duplicates: number; snapped: number } {
  // 1. duplikaty: ta sama para węzłów – zostaje jeden (z torowiskiem, jeśli było)
  const best = new Map<string, SimRoad>();
  let duplicates = 0;
  for (const r of roads) {
    const key = r.a < r.b ? `${r.a}:${r.b}` : `${r.b}:${r.a}`;
    const cur = best.get(key);
    if (!cur) { best.set(key, r); continue; }
    duplicates++;
    if (!cur.transit && !cur.hasTram && (r.transit || r.hasTram)) best.set(key, r);
    if ((r.lanesForward ?? 0) > (cur.lanesForward ?? 0)) best.set(key, r);
  }
  const out: SimRoad[] = [];
  const seen = new Set<string>();
  for (const r of roads) {
    const key = r.a < r.b ? `${r.a}:${r.b}` : `${r.b}:${r.a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(best.get(key)!);
  }

  // 2. wiszące końce: najpierw łączymy pary luźnych końców blisko siebie,
  // potem doczepiamy resztę do dowolnego pobliskiego węzła (nie tylko skrzyżowań).
  let snapped = 0;
  const degree = () => {
    const deg = new Map<number, number>();
    for (const r of out) { deg.set(r.a, (deg.get(r.a) ?? 0) + 1); deg.set(r.b, (deg.get(r.b) ?? 0) + 1); }
    return deg;
  };
  const retarget = (from: number, to: number) => {
    for (const r of out) {
      if (r.a === from) { r.a = to; snapped++; }
      else if (r.b === from) { r.b = to; snapped++; }
    }
  };

  for (let pass = 0; pass < 3; pass++) {
    const deg = degree();
    const loose = [...deg].filter(([, d]) => d === 1).map(([n]) => n);
    if (!loose.length) break;

    // 2a. para wiszących końców w ≤12 m – domknięcie przerwy w siatce
    const used = new Set<number>();
    for (let i = 0; i < loose.length; i++) {
      const a = loose[i];
      if (used.has(a)) continue;
      const pa = nodes[a];
      if (!pa) continue;
      let bestN = -1, bestD = 12;
      for (let j = i + 1; j < loose.length; j++) {
        const b = loose[j];
        if (used.has(b)) continue;
        const pb = nodes[b];
        if (!pb) continue;
        const d = Math.hypot(pb.x - pa.x, pb.z - pa.z);
        if (d < bestD && d > 0.3) { bestD = d; bestN = b; }
      }
      if (bestN >= 0) {
        retarget(a, bestN);
        used.add(a); used.add(bestN);
      }
    }

    // 2b. pozostałe luźne końce → najbliższy węzeł ≤14 m (dowolny stopień)
    const deg2 = degree();
    for (const node of [...deg2].filter(([, d]) => d === 1).map(([n]) => n)) {
      if (used.has(node)) continue;
      const p = nodes[node];
      if (!p) continue;
      let target = -1, bd = 14;
      for (const [other] of deg2) {
        if (other === node) continue;
        const q = nodes[other];
        if (!q) continue;
        const dist = Math.hypot(q.x - p.x, q.z - p.z);
        if (dist < bd && dist > 0.2) { bd = dist; target = other; }
      }
      if (target >= 0) retarget(node, target);
    }
  }

  // zerwane odcinki (oba końce w jednym węźle) oraz świeże duplikaty po snapie
  const cleaned: SimRoad[] = [];
  const seen2 = new Set<string>();
  for (const r of out) {
    if (r.a === r.b) continue;
    const key = r.a < r.b ? `${r.a}:${r.b}` : `${r.b}:${r.a}`;
    if (seen2.has(key)) continue;
    seen2.add(key);
    cleaned.push(r);
  }

  const remap = new Map<number, number>();
  cleaned.forEach((r, i) => { remap.set(r.id, i); r.id = i; });

  return { roads: cleaned, remap, duplicates, snapped };
}

/** Najbliższy odcinek drogi w promieniu – awaryjnie dla przystanków po remoncie grafu. */
function nearestRoadTo(roads: SimRoad[], nodes: SimNode[], x: number, z: number, maxDist: number): number {
  let best = -1, bd = maxDist;
  for (const r of roads) {
    const a = nodes[r.a], c = nodes[r.b];
    if (!a || !c) continue;
    const d = distToSegment(x, z, a.x, a.z, c.x, c.z);
    if (d < bd) { bd = d; best = r.id; }
  }
  return best;
}

/**
 * Pas jezdni wokół osi ulicy – półszerokości ≈ roadWidth/2 z renderu.
 * Chodniki (footway/path) pomijamy: biegną wzdłuż ścian i inaczej
 * zjadałyby kamienice Starego Miasta.
 */
const ROAD_HALF: Record<string, number> = {
  motorway: 6.2, trunk: 5.7, primary: 5.2, secondary: 4.5, tertiary: 4.0,
  residential: 3.3, unclassified: 3.2, living_street: 3.0, service: 2.4, track: 2.0,
  pedestrian: 3.4, tram: 2.5,
};

class RoadCorridor {
  private cell = 80;
  private grid = new Map<string, { ax: number; az: number; bx: number; bz: number; half: number }[]>();

  constructor(nodes: SimNode[], roads: SimRoad[]) {
    for (const r of roads) {
      if (!r.carAccess && r.roadClass !== 'pedestrian' && r.roadClass !== 'tram' && !r.hasTram) continue;
      const a = nodes[r.a], z2 = nodes[r.b];
      if (!a || !z2) continue;
      const ax = a.x, az = a.z, bx = z2.x, bz = z2.z;
      const half = ROAD_HALF[r.roadClass] ?? 3.2;
      const item = { ax, az, bx, bz, half };
      const x0 = Math.floor(Math.min(ax, bx) / this.cell), x1 = Math.floor(Math.max(ax, bx) / this.cell);
      const z0 = Math.floor(Math.min(az, bz) / this.cell), z1 = Math.floor(Math.max(az, bz) / this.cell);
      for (let cx = x0; cx <= x1; cx++)
        for (let cz = z0; cz <= z1; cz++) {
          const k = `${cx}:${cz}`;
          const list = this.grid.get(k);
          if (list) list.push(item); else this.grid.set(k, [item]);
        }
    }
  }

  private nearest(x: number, z: number): { d: number; px: number; pz: number; half: number } {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = { d: Infinity, px: 0, pz: 0, half: 3.2 };
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const list = this.grid.get(`${cx + i}:${cz + j}`);
        if (!list) continue;
        for (const s of list) {
          const ax = s.bx - s.ax, az = s.bz - s.az;
          const len2 = ax * ax + az * az;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * ax + (z - s.az) * az) / len2)) : 0;
          const px = s.ax + ax * t, pz = s.az + az * t;
          const d = Math.hypot(x - px, z - pz);
          if (d < best.d) best = { d, px, pz, half: s.half };
        }
      }
    return best;
  }

  clearance(x: number, z: number): number {
    const n = this.nearest(x, z);
    return n.d - n.half;
  }

  private pushOut(x: number, z: number, margin: number): [number, number] {
    const n = this.nearest(x, z);
    const need = n.half + margin;
    if (n.d >= need) return [x, z];
    if (n.d < 1e-4) {
      const nx = x - n.px, nz = z - n.pz;
      const len = Math.hypot(nx, nz);
      if (len < 1e-6) return [x + need, z];
      return [n.px + (nx / len) * need, n.pz + (nz / len) * need];
    }
    const k = need / n.d;
    return [n.px + (x - n.px) * k, n.pz + (z - n.pz) * k];
  }

  /** Odstęp ściany od krawędzi jezdni – budynki nie wchodzą na ulicę. */
  private static readonly MARGIN = 1.15;

  fit(x: BakedBuilding): { x: number; z: number; w: number; d: number; ring?: [number, number][]; trimmed: boolean } | null {
    const MARGIN = RoadCorridor.MARGIN;
    const src = (x.ring && x.ring.length >= 3 ? x.ring : orientedBox(x)).map(([a, b]) => [a, b] as [number, number]);
    if (this.clearance(x.x, x.z) < -2.5) return null;

    let ring = src.map(([px, pz]) => [px, pz] as [number, number]);
    let trimmed = false;
    for (let iter = 0; iter < 5; iter++) {
      let moved = false;
      for (let i = 0; i < ring.length; i++) {
        if (this.clearance(ring[i][0], ring[i][1]) >= MARGIN) continue;
        ring[i] = this.pushOut(ring[i][0], ring[i][1], MARGIN);
        moved = true; trimmed = true;
      }
      const next: [number, number][] = [];
      for (let i = 0; i < ring.length; i++) {
        next.push(ring[i]);
        const j = (i + 1) % ring.length;
        const mx = (ring[i][0] + ring[j][0]) / 2, mz = (ring[i][1] + ring[j][1]) / 2;
        if (this.clearance(mx, mz) < MARGIN) {
          next.push(this.pushOut(mx, mz, MARGIN));
          moved = true; trimmed = true;
        }
      }
      if (next.length !== ring.length) ring = next;
      if (!moved) break;
      if (ring.length > 48) {
        ring = ring.filter((_, i) => i % 2 === 0);
        if (ring.length < 3) return null;
      }
    }

    let area = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      area += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    area = Math.abs(area / 2);
    const area0 = Math.abs(ringArea(src));
    if (area < area0 * 0.35 || area < 8) return null;

    const cx = ring.reduce((t, p) => t + p[0], 0) / ring.length;
    const cz = ring.reduce((t, p) => t + p[1], 0) / ring.length;
    if (this.clearance(cx, cz) < 0) return null;

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [px, pz] of ring) {
      minX = Math.min(minX, px); maxX = Math.max(maxX, px);
      minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz);
    }
    return { x: cx, z: cz, w: maxX - minX, d: maxZ - minZ, ring, trimmed };
  }
}

/** Prostokąt obrócony jak w OSM (gdy brak pierścienia). */
function orientedBox(b: { x: number; z: number; w: number; d: number; rot: number }): [number, number][] {
  const c = Math.cos(b.rot), s = Math.sin(b.rot);
  const hw = b.w / 2, hd = b.d / 2;
  return (
    [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as [number, number][]
  ).map(([u, v]) => [b.x + u * c - v * s, b.z + u * s + v * c]);
}

/** Pole powierzchni wielokąta (znak nieistotny). */
function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return a / 2;
}

export const staticStatusesFrom = (b: BakedBundle) => b.manifest;
export { REFRESH };
