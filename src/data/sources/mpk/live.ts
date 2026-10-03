import { ENDPOINTS, PROXY, REFRESH, SOURCES } from '../../config';
import { decodeFeedMessage } from './gtfsrt';
import { toLocal, toLatLon, AREA } from '../../geo';
import { fetchWithTimeout } from '../../cache/store';
import type { SourceStatus, VehicleState } from '../../types';
import type { BakedRoute, BakedVehicleSnapshot } from '../../baked';
import type { CityData } from '../../model';

const FEEDS = ['T', 'A', 'M'] as const;
const kindOfFeed = (f: 'A' | 'T' | 'M'): 'tram' | 'bus' => (f === 'T' ? 'tram' : 'bus');

/**
 * ZTP Kraków nie wysyła nagłówków CORS, więc feedy GTFS-RT czytamy przez lokalne
 * proxy (vite.config.ts). Próbujemy też wprost – jeśli kiedyś ZTP włączy CORS,
 * aplikacja zadziała bez proxy.
 */
async function readVehiclePositions(feed: 'A' | 'T' | 'M'): Promise<{ buf: ArrayBuffer; live: boolean } | null> {
  const attempts: { url: string; live: boolean }[] = [
    { url: `${PROXY.ztp}/VehiclePositions_${feed}.pb`, live: true },
    { url: ENDPOINTS.ztpVehiclePositions(feed), live: true },
  ];
  for (const a of attempts) {
    try {
      const res = await fetchWithTimeout(a.url, 20_000);
      if (!res.ok) continue;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 8) return { buf, live: a.live };
    } catch {
      /* następna metoda */
    }
  }
  return null;
}

/** Rozwiązuje trip_id GTFS-RT do linii, kierunku i kształtu trasy z GTFS statycznego. */
function makeTripResolver(city: CityData) {
  const trips = city.rawTrips;
  const routes = city.routes;
  return (tripId?: string, routeId?: string) => {
    if (tripId && trips[tripId]) {
      const [ri, dir, shape] = trips[tripId].split(',').map(Number);
      const r = routes[ri];
      if (r) return { route: r, dir, shape };
    }
    if (routeId) {
      const r = routes.find((x) => x.id === routeId);
      if (r) return { route: r, dir: r.dir, shape: 0 };
    }
    return null;
  };
}

export interface LiveVehicleResult {
  vehicles: VehicleState[];
  status: SourceStatus;
  /** Odcinek drogi -> poziom zakrzepienia 1..4 (OBSERVED, ZTP). */
  congestion: Record<number, number>;
  headerTimestamp?: string;
}

/**
 * Odczyt realnych pozycji pojazdów MPK. Zwraca wyłącznie pojazdy znajdujące się
 * w obszarze symulacji – to one pokazujemy jako REALNE w scenie 3D.
 */
export async function fetchLiveVehicles(city: CityData): Promise<LiveVehicleResult> {
  const resolve = makeTripResolver(city);
  const vehicles: VehicleState[] = [];
  const congestion: Record<number, number> = {};
  let headerTs: number | undefined;
  let feedOk = 0;
  let errors: string[] = [];

  for (const feed of FEEDS) {
    const got = await readVehiclePositions(feed);
    if (!got) { errors.push(`${feed}: brak odpowiedzi`); continue; }
    let rt;
    try {
      rt = decodeFeedMessage(new Uint8Array(got.buf));
    } catch (e) {
      errors.push(`${feed}: ${String(e)}`);
      continue;
    }
    feedOk++;
    headerTs = headerTs ?? rt.timestamp;

    for (const v of rt.vehicles) {
      if (v.latitude === undefined || v.longitude === undefined) continue;
      if (v.latitude < AREA.minLat - 0.004 || v.latitude > AREA.maxLat + 0.004) continue;
      if (v.longitude < AREA.minLon - 0.006 || v.longitude > AREA.maxLon + 0.006) continue;
      const resolved = resolve(v.trip.tripId, v.trip.routeId);
      const local = toLocal(v.latitude, v.longitude);
      const roadId = nearestRoad(city, local.x, local.z);
      if (roadId !== undefined && v.congestionLevel !== undefined && v.congestionLevel > 0) {
        congestion[roadId] = Math.max(congestion[roadId] ?? 0, v.congestionLevel);
      }
      vehicles.push({
        id: `${feed}:${v.id}`,
        type: kindOfFeed(feed),
        line: resolved?.route.ref ?? '—',
        routeId: v.trip.routeId ?? resolved?.route.id,
        headsign: resolved?.route.dir === 1 ? 'powrót' : undefined,
        direction: v.trip.directionId ?? resolved?.dir ?? 0,
        latitude: v.latitude,
        longitude: v.longitude,
        x: local.x,
        z: local.z,
        bearing: v.bearing,
        speed: v.speed !== undefined && v.speed > 0 && v.speed < 45 ? v.speed : undefined,
        source: SOURCES.ztpRt.url,
        origin: 'OBSERVED',
        timestamp: new Date((v.timestamp ?? rt.timestamp ?? 0) * 1000).toISOString(),
      });
    }
  }

  const dataTimestamp = headerTs ? new Date(headerTs * 1000).toISOString() : undefined;
  const status: SourceStatus = {
    ...SOURCES.ztpRt,
    freshness: feedOk ? 'LIVE' : 'CACHED',
    dataTimestamp,
    fetchedAt: new Date().toISOString(),
    live: feedOk > 0,
    refreshSeconds: REFRESH.vehicles,
    records: vehicles.length,
    error: feedOk ? undefined : errors.join('; '),
    note: 'GTFS-RT VehiclePositions – realne pojazdy MPK/Mobilis z GPS.',
  };
  return { vehicles, status, congestion, headerTimestamp: dataTimestamp };
}

/** Migawka zapisana podczas `npm run ingest` – offline fallback. */
export function snapshotToVehicles(city: CityData, snap: { generatedAt: string; vehicles: BakedVehicleSnapshot[] }): {
  vehicles: VehicleState[];
  status: SourceStatus;
  congestion: Record<number, number>;
} {
  const resolve = makeTripResolver(city);
  const congestion: Record<number, number> = {};
  const vehicles = snap.vehicles.map((v) => {
    const resolved = resolve(v.tripId);
    const roadId = nearestRoad(city, v.x, v.z);
    if (roadId !== undefined && v.congestionLevel !== undefined && v.congestionLevel > 0) {
      congestion[roadId] = Math.max(congestion[roadId] ?? 0, v.congestionLevel);
    }
    return {
      id: v.id,
      type: kindOfFeed(v.feed),
      line: v.line ?? '—',
      headsign: resolved?.route.dir === 1 ? 'powrót' : undefined,
      direction: v.dir,
      latitude: v.lat,
      longitude: v.lon,
      x: v.x,
      z: v.z,
      bearing: v.bearing,
      speed: v.speed,
      source: SOURCES.ztpRt.url,
      origin: 'OBSERVED' as const,
      timestamp: v.timestamp,
    } satisfies VehicleState;
  });
  const status: SourceStatus = {
    ...SOURCES.ztpRt,
    freshness: 'CACHED',
    dataTimestamp: snap.generatedAt,
    fetchedAt: snap.generatedAt,
    live: false,
    records: vehicles.length,
    note: 'Migawka GTFS-RT zapisana podczas ostatniego `npm run ingest` – dane archiwalne, nie na żywo.',
  };
  return { vehicles, status, congestion };
}

/** Pozycja w przestrzeni geograficznej, gdyby trzeba było wrzucić model z powrotem do GTFS. */
export const vehicleToLatLon = toLatLon;

/** Przestrzenny indeks odcinków drogowych (budowany raz na instancję CityData). */
const roadIndexes = new WeakMap<CityData, { cell: number; map: Map<string, number[]> }>();

export function nearestRoad(city: CityData, x: number, z: number): number | undefined {
  const cell = 70;
  let idx = roadIndexes.get(city);
  if (!idx) {
    const map = new Map<string, number[]>();
    city.roads.forEach((r, i) => {
      const A = city.nodes[r.a], B = city.nodes[r.b];
      const steps = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.z - A.z) / cell));
      for (let s = 0; s <= steps; s++) {
        const px = A.x + ((B.x - A.x) * s) / steps, pz = A.z + ((B.z - A.z) * s) / steps;
        const k = Math.floor(px / cell) + ',' + Math.floor(pz / cell);
        const arr = map.get(k);
        if (arr) arr.push(i); else map.set(k, [i]);
      }
    });
    idx = { cell, map };
    roadIndexes.set(city, idx);
  }
  const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
  let best: { i: number; d: number } | null = null;
  const seen = new Set<number>();
  for (let a = -1; a <= 1; a++)
    for (let b = -1; b <= 1; b++) {
      const arr = idx.map.get(cx + a + ',' + (cz + b));
      if (!arr) continue;
      for (const i of arr) {
        if (seen.has(i)) continue;
        seen.add(i);
        const r = city.roads[i];
        const A = city.nodes[r.a], B = city.nodes[r.b];
        const dx = B.x - A.x, dz = B.z - A.z;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - A.x) * dx + (z - A.z) * dz) / l2));
        const d = Math.hypot(x - (A.x + dx * t), z - (A.z + dz * t));
        if (!best || d < best.d) best = { i, d };
      }
    }
  return best && best.d < 90 ? best.i : undefined;
}

export type { BakedRoute };