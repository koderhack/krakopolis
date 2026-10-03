import type {
  BakedBuilding, BakedCity, BakedEnvironment, BakedManifest, BakedRoad, BakedStop,
  BakedTerrain, BakedTraffic, BakedTransit, BakedVehicleSnapshot,
} from '../baked';
import type { CityData, SimBuilding, SimPolygon, SimRoad, SimRoute, SimStop } from '../model';
import type { Origin, RoadState, SourceStatus, TrafficState } from '../types';
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

  const buildings: SimBuilding[] = b.city.buildings.map((x: BakedBuilding) => ({
    x: x.x, z: x.z, w: x.w, d: x.d, h: x.h, rot: x.rot, color: x.color, roof: x.roof,
    name: x.name, landmark: x.landmark, ring: x.ring, levels: x.levels,
  }));
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
      note: `Drogi: ${b.city.roads.length}, budynki: ${b.city.buildings.length}, skrzyżowania: ${b.city.signals.length}, miejsca: ${pois.length}.`,
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

export const staticStatusesFrom = (b: BakedBundle) => b.manifest;
export { REFRESH };