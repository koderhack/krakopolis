import type { BakedCity, BakedEnvironment, BakedManifest, BakedTerrain, BakedTraffic, BakedTransit } from './baked';
import { buildCityData, type BakedBundle } from './adapters/cityAdapter';
import { cachedJson, getLocal, setLocal } from './cache/store';
import { REFRESH } from './config';
import type { CityData } from './model';
import type { SourceStatus } from './types';
import { fetchLiveVehicles } from './sources/mpk/live';
import { fetchLiveEnvironment } from './sources/environment/live';

export interface PipelineSnapshot {
  city: CityData;
  statuses: SourceStatus[];
  /** Czy odświeżanie w tle działa (wszystkie źródła LIVE). */
  live: boolean;
  updatedAt: string;
  /** Błędy ostatniego cyklu odświeżania. */
  errors: string[];
}

const FILES = {
  manifest: '/data/manifest.json',
  city: '/data/osm-city.json',
  transit: '/data/transit.json',
  traffic: '/data/traffic.json',
  environment: '/data/environment.json',
  vehicles: '/data/vehicles-snapshot.json',
  terrain: '/data/terrain.json',
} as const;

/** Interwały można nadpisać w URL, np. ?refresh=vehicles:10,traffic:20 */
function refreshOverrides(): Partial<typeof REFRESH> {
  const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
  const out: Record<string, number> = {};
  for (const [k, v] of q) {
    const [key, val] = v.split(':');
    if (k === 'refresh') out[key] = Number(val);
  }
  return out;
}

/**
 * Warstwa danych: ładuje prawdziwe, wypieczone dane (offline fallback),
 * a następnie cyklicznie odświeża to, co da się pobrać na żywo.
 * Symulacja dostaje tylko wynik – nigdy nie pyta o API.
 */
export class DataPipeline {
  city: CityData | null = null;
  statuses: SourceStatus[] = [];
  errors: string[] = [];
  updatedAt = new Date().toISOString();
  readonly intervals = { ...REFRESH, ...refreshOverrides() };
  private timers: number[] = [];
  private listeners = new Set<(s: PipelineSnapshot) => void>();
  private prevPositions = new Map<string, { x: number; z: number; t: number }>();
  /** Ostatni znany dobry odczyt – używany, gdy API chwilowo zawiedzie. */
  private lastLive: { vehicles: CityData['liveVehicles']; timestamp: string } | null = null;

  on(fn: (s: PipelineSnapshot) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    if (!this.city) return;
    this.updatedAt = new Date().toISOString();
    for (const fn of this.listeners) fn(this.snapshot());
  }
  snapshot(): PipelineSnapshot {
    return {
      city: this.city!,
      statuses: this.statuses,
      live: this.statuses.some((s) => s.live),
      updatedAt: this.updatedAt,
      errors: this.errors,
    };
  }

  /** Wczytuje baseline (CACHED) i startuje odświeżanie w tle. */
  async start(): Promise<PipelineSnapshot> {
    const [manifest, city, transit, traffic, environment, vehicles, terrain] = await Promise.all([
      cachedJson<BakedManifest>(FILES.manifest),
      cachedJson<BakedCity>(FILES.city),
      cachedJson<BakedTransit>(FILES.transit),
      cachedJson<BakedTraffic>(FILES.traffic),
      cachedJson<BakedEnvironment>(FILES.environment),
      cachedJson<{ generatedAt: string; vehicles: BakedBundle['vehicles']['vehicles'] }>(FILES.vehicles),
      cachedJson<BakedTerrain | null>(FILES.terrain).catch(() => null),
    ]);
    const bundle: BakedBundle = { manifest, city, transit, traffic, environment, vehicles, terrain };
    this.city = buildCityData(bundle);
    this.statuses = this.city.statuses;
    this.lastLive = { vehicles: this.city.liveVehicles, timestamp: vehicles.generatedAt };
    this.emit();

    void this.refreshVehicles();
    void this.refreshEnvironment();
    this.schedule();
    return this.snapshot();
  }

  private schedule() {
    this.stop();
    const every = (fn: () => void, seconds: number) => {
      const t = window.setInterval(() => void fn(), Math.max(5, seconds) * 1000);
      this.timers.push(t);
    };
    every(() => this.refreshVehicles(), this.intervals.vehicles);
    every(() => this.refreshEnvironment(), this.intervals.environment);
  }
  stop() {
    for (const t of this.timers) window.clearInterval(t);
    this.timers = [];
  }

  /**
   * Odczyt GTFS-RT co 15–30 s: pobierz → zwaliduj → znormalizuj → podmień
   * w CityData → zaktualizuj scenę 3D. Nigdy w pętli animacji.
   */
  async refreshVehicles(): Promise<void> {
    if (!this.city) return;
    try {
      const { vehicles, status, congestion } = await fetchLiveVehicles(this.city);
      if (status.live && vehicles.length) {
        // PREDICTED: prędkość z dwóch kolejnych obserwacji tego samego pojazdu.
        const now = Date.now();
        for (const v of vehicles) {
          const prev = this.prevPositions.get(v.id);
          if (prev && now > prev.t) {
            const dt = (now - prev.t) / 1000;
            const d = Math.hypot(v.x - prev.x, v.z - prev.z);
            if (d > 0.5 && dt > 2 && dt < 300) v.speed = Math.min(45, d / dt);
          }
          this.prevPositions.set(v.id, { x: v.x, z: v.z, t: now });
        }
        this.lastLive = { vehicles, timestamp: status.dataTimestamp ?? new Date().toISOString() };
        setLocal('live-vehicles', this.lastLive);
        this.city.liveVehicles = vehicles;
        this.applyCongestion(congestion, vehicles.length, status.dataTimestamp);
        this.statuses = [status, ...this.statuses.filter((s) => s.id !== status.id)];
        this.errors = [];
      } else {
        this.useCachedLive(status);
      }
    } catch (e) {
      this.errors = [`GTFS-RT: ${String(e)}`];
      this.statuses = this.statuses.map((s) => (s.id === 'ztp-rt' ? { ...s, error: String(e) } : s));
    }
    this.emit();
  }

  private applyCongestion(congestion: Record<number, number>, sample: number, timestamp?: string) {
    if (!this.city) return;
    this.city.traffic = {
      observedLevel: this.city.traffic.observedLevel,
      observedSpeed: this.city.traffic.observedSpeed,
      origin: 'OBSERVED',
      source: this.city.traffic.source,
      timestamp,
      sampleSize: sample,
    };
    for (const road of this.city.roads) {
      const c = congestion[road.id];
      if (c === undefined) continue;
      road.baselineTraffic = Math.min(1, (c - 1) / 3);
      road.baselineOrigin = 'OBSERVED';
      road.baselineSpeed = road.speedLimit * (1 - 0.8 * road.baselineTraffic);
    }
    this.statuses = this.statuses.map((s) =>
      s.id === 'ztp-rt' ? { ...s, records: sample } : s,
    );
  }

  /** API nie odpowiedziało – pokazujemy ostatni prawdziwy odczyt, oznaczony CACHED. */
  private useCachedLive(status: SourceStatus) {
    if (!this.city) return;
    const cached = this.lastLive ?? getLocal<{ vehicles: CityData['liveVehicles']; timestamp: string }>('live-vehicles');
    if (cached?.vehicles?.length) {
      this.city.liveVehicles = cached.vehicles;
      this.statuses = this.statuses.map((s) =>
        s.id === 'ztp-rt'
          ? { ...s, freshness: 'CACHED', live: false, error: status.error ?? 'źródło live nie odpowiedziało', dataTimestamp: cached.timestamp }
          : s,
      );
    } else {
      this.statuses = this.statuses.map((s) => (s.id === 'ztp-rt' ? { ...s, ...status, live: false } : s));
    }
  }

  async refreshEnvironment(): Promise<void> {
    if (!this.city) return;
    try {
      const { env, statuses } = await fetchLiveEnvironment();
      const ok = statuses.some((s) => s.live);
      if (ok) {
        this.city.environment = env;
        this.statuses = [
          ...this.statuses.filter((s) => s.id !== 'open-meteo' && s.id !== 'open-meteo-air'),
          ...statuses,
        ];
      }
    } catch (e) {
      this.errors = [...this.errors, `Pogoda: ${String(e)}`];
    }
    this.emit();
  }
}

export const pipeline = new DataPipeline();