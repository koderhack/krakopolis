import type {
  BakedBuilding, BakedCity, BakedEnvironment, BakedManifest, BakedRoad, BakedStop,
  BakedTerrain, BakedTraffic, BakedTransit, BakedVehicleSnapshot,
} from '../baked';
import type { CityData, SimBuilding, SimNode, SimPolygon, SimRoad, SimRoute, SimStop } from '../model';
import type { Origin, RoadState, SourceStatus, TrafficState } from '../types';
import { distToSegment } from '../../simulation/city/catalog';
import { REFRESH, SOURCES } from '../config';
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
    id: s.id, name: s.name, x: s.x, z: s.z, lat: s.lat, lon: s.lon, roadId: s.roadId, lines: s.lines, mode: s.mode,
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
    return {
      id: r.id,
      name: r.name || r.ref || 'ulica bez nazwy',
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

  // Bryły z OSM bywają narysowane z marginesem chodnika, a czasem z błędem –
  // nachodzą wtedy na jezdnię. Przed renderem przycinamy je do pasa drogowego,
  // żeby ściany zawsze kończyły się przed jezdnią (dane źródłowe nietknięte).
  const corridor = new RoadCorridor(b.city.nodes, roads);
  let trimmed = 0, dropped = 0;
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
  const polygons: SimPolygon[] = b.city.polygons.map((p) => ({ ring: p.ring, kind: p.kind }));
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
      note: `Drogi: ${b.city.roads.length}, budynki: ${buildings.length}`
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
    roads,
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
 * Pas drogowy wokół osi ulicy – siatka przestrzenna z półszerokościami
 * zależnymi od klasy drogi. Używana tylko do przycinania brył budynków.
 */
const ROAD_HALF: Record<string, number> = {
  motorway: 15, trunk: 13, primary: 11.5, secondary: 10, tertiary: 9,
  residential: 8, unclassified: 7.5, living_street: 5, service: 5.5, track: 4.5,
};

class RoadCorridor {
  private cell = 90;
  private grid = new Map<string, { ax: number; az: number; bx: number; bz: number; half: number }[]>();

  constructor(nodes: SimNode[], roads: SimRoad[]) {
    for (const r of roads) {
      const a = nodes[r.a], z2 = nodes[r.b];
      if (!a || !z2) continue;
      const ax = a.x, az = a.z, bx = z2.x, bz = z2.z;
      const half = (ROAD_HALF[r.roadClass] ?? 8) / 2;
      const item = { ax, az, bx, bz, half };
      // wstawiamy do wszystkich komórek, których dotyka odcinek
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

  /** Najmniejszy odstęp od pasa drogowego (dodatni = poza jezdnią). */
  clearance(x: number, z: number): number {
    const cx = Math.floor(x / this.cell), cz = Math.floor(z / this.cell);
    let best = Infinity;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const list = this.grid.get(`${cx + i}:${cz + j}`);
        if (!list) continue;
        for (const s of list) {
          const d = distToSegment(x, z, s.ax, s.az, s.bx, s.bz) - s.half;
          if (d < best) best = d;
        }
      }
    return best;
  }

  /**
   * Przycina bryłę do pasa drogowego. Zwraca `null`, gdy budynek leży w całości
   * na jezdni – taki obrys z OSM odrzucamy, zamiast rysować bryłę w miejscu,
   * gdzie stoi ulica.
   */
  fit(x: BakedBuilding): { x: number; z: number; w: number; d: number; ring?: [number, number][]; trimmed: boolean } | null {
    const MARGIN = 1.6;
    if (x.ring && x.ring.length >= 3) {
      let ring = x.ring.map((p) => [p[0], p[1]] as [number, number]);
      let cx = ring.reduce((t, p) => t + p[0], 0) / ring.length;
      let cz = ring.reduce((t, p) => t + p[1], 0) / ring.length;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [px, pz] of ring) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz); }
      const area0 = Math.abs(ringArea(ring));
      const touched = ring.some(([px, pz]) => this.clearance(px, pz) < MARGIN);
      if (!touched) {
        return { x: cx, z: cz, w: maxX - minX, d: maxZ - minZ, ring, trimmed: false };
      }
      // malejemy obrys do środka, aż cały znajdzie się poza jezdnią
      let scale = 1;
      for (let pass = 0; pass < 8; pass++) {
        scale *= 0.88;
        ring = x.ring.map((p) => [cx + (p[0] - cx) * scale, cz + (p[1] - cz) * scale] as [number, number]);
        const ok = ring.every(([px, pz]) => this.clearance(px, pz) >= MARGIN);
        if (ok) break;
      }
      const area1 = Math.abs(ringArea(ring));
      if (area1 < area0 * 0.3) return null; // bryła wtopiona w ulicę – odrzucamy
      minX = Infinity; maxX = -Infinity; minZ = Infinity; maxZ = -Infinity;
      for (const [px, pz] of ring) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minZ = Math.min(minZ, pz); maxZ = Math.max(maxZ, pz); }
      return { x: cx, z: cz, w: maxX - minX, d: maxZ - minZ, ring, trimmed: true };
    }
    // brak obrysu – prostokąt z wymiarów z OSM
    const corners = (w: number, d: number): [number, number][] => [
      [x.x - w / 2, x.z - d / 2], [x.x + w / 2, x.z - d / 2],
      [x.x + w / 2, x.z + d / 2], [x.x - w / 2, x.z + d / 2],
    ];
    let w = x.w, d = x.d;
    if (!corners(w, d).some(([px, pz]) => this.clearance(px, pz) < MARGIN)) {
      return { x: x.x, z: x.z, w, d, trimmed: false };
    }
    for (let pass = 0; pass < 8; pass++) {
      w *= 0.88; d *= 0.88;
      if (!corners(w, d).some(([px, pz]) => this.clearance(px, pz) < MARGIN)) break;
    }
    if (w < Math.max(3, x.w * 0.3)) return null;
    return { x: x.x, z: x.z, w, d, trimmed: true };
  }
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