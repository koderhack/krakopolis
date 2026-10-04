/**
 * Lokalny „backend” historii miasta – IndexedDB (opcja 1B).
 * Kształt API jak serwer: CityVersion / CityChange. Przeżywa refresh.
 */
import type { ConsequenceReport } from '../simulation/consequences';
import type { BuildId } from '../simulation/city/catalog';
import { START_BUDGET_PLN } from './budget';

const DB_NAME = 'simcity-krakow';
const STORE = 'versions';
const DB_VER = 2;

export interface CityChangeRecord {
  id: string;
  timestamp: string;
  type: string;
  label: string;
  payload?: Record<string, unknown>;
  report?: ConsequenceReport;
}

export interface PlayerSnapshotBuilding {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  rot?: number;
  kind: BuildId;
  name: string;
  color: string;
  roof: string;
  residents: number;
  jobs: number;
}

export interface PlayerSnapshotPark {
  x: number;
  z: number;
  r: number;
  shape?: 'circle' | 'rect';
  w?: number;
  d?: number;
}

/** Stan gracza zapisany w wersji – do przywracania po refresh / restore. */
export interface PlayerSnapshot {
  buildings: PlayerSnapshotBuilding[];
  parks: PlayerSnapshotPark[];
  budget: number;
  disasters?: {
    id: number;
    kind: string;
    cx: number;
    cz: number;
    intensity: number;
    peak: number;
    phase: string;
    startedAt: number;
    roads: number[];
    label: string;
    targetBuildingId?: number;
    targetBuildingKind?: 'osm' | 'player';
    targetLabel?: string;
    affectedResidents?: number;
    radius?: number;
    affectedBuildings?: { id: number; kind: 'osm' | 'player' }[];
    consequences?: string[];
  }[];
}

export interface CityVersion {
  id: number;
  createdAt: string;
  label: string;
  restoredFrom?: number;
  changes: CityChangeRecord[];
  metrics?: { traffic: number; satisfaction: number; budget: number; residents: number; jobs: number };
  snapshot?: PlayerSnapshot;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listVersions(): Promise<CityVersion[]> {
  const all = await withStore<CityVersion[]>('readonly', (s) => s.getAll());
  return (all ?? []).sort((a, b) => a.id - b.id);
}

export async function getVersion(id: number): Promise<CityVersion | undefined> {
  return withStore('readonly', (s) => s.get(id));
}

export async function latestVersion(): Promise<CityVersion | null> {
  const all = await listVersions();
  return all.length ? all[all.length - 1] : null;
}

export async function ensureRootVersion(): Promise<CityVersion> {
  const all = await listVersions();
  if (all.length) return all[all.length - 1];
  const root: CityVersion = {
    id: 1,
    createdAt: new Date().toISOString(),
    label: 'Stan początkowy miasta',
    changes: [],
    metrics: { traffic: 0, satisfaction: 70, budget: START_BUDGET_PLN, residents: 0, jobs: 0 },
    snapshot: { buildings: [], parks: [], budget: START_BUDGET_PLN },
  };
  await withStore('readwrite', (s) => s.put(root));
  return root;
}

export async function appendChange(
  change: Omit<CityChangeRecord, 'id' | 'timestamp'>,
  metrics?: CityVersion['metrics'],
  snapshot?: PlayerSnapshot,
): Promise<CityVersion> {
  const cur = await ensureRootVersion();
  const next: CityVersion = {
    id: cur.id + 1,
    createdAt: new Date().toISOString(),
    label: change.label,
    changes: [
      ...cur.changes,
      {
        id: `chg-${Date.now()}`,
        timestamp: new Date().toISOString(),
        ...change,
      },
    ],
    metrics: metrics ?? cur.metrics,
    snapshot: snapshot ?? cur.snapshot,
  };
  await withStore('readwrite', (s) => s.put(next));
  return next;
}

/** Przywrócenie: nowa wersja z snapshotu starszej – historia zostaje. */
export async function restoreVersion(fromId: number): Promise<CityVersion> {
  const from = await getVersion(fromId);
  if (!from) throw new Error(`Brak wersji v${fromId}`);
  const cur = await ensureRootVersion();
  const next: CityVersion = {
    id: cur.id + 1,
    createdAt: new Date().toISOString(),
    label: `Przywrócono stan z v${fromId}`,
    restoredFrom: fromId,
    changes: [...from.changes],
    metrics: from.metrics,
    snapshot: from.snapshot ?? { buildings: [], parks: [], budget: from.metrics?.budget ?? START_BUDGET_PLN },
  };
  await withStore('readwrite', (s) => s.put(next));
  return next;
}

const EMPTY_METRICS = { traffic: 0, satisfaction: 0, budget: 0, residents: 0, jobs: 0 };

export type VersionMetrics = NonNullable<CityVersion['metrics']>;

export interface VersionCompare {
  a: number;
  b: number;
  labelA: string;
  labelB: string;
  metricsA: VersionMetrics;
  metricsB: VersionMetrics;
  delta: {
    traffic: number;
    satisfaction: number;
    budget: number;
    residents: number;
    jobs: number;
    changes: number;
    buildings: number;
    parks: number;
  };
  /** Zmiany obecne w B, których nie było w A (po id). */
  newChanges: { label: string; type: string }[];
}

export async function compareVersions(aId: number, bId: number): Promise<VersionCompare | null> {
  const a = await getVersion(aId);
  const b = await getVersion(bId);
  if (!a || !b) return null;
  const ma = a.metrics ?? EMPTY_METRICS;
  const mb = b.metrics ?? EMPTY_METRICS;
  const aIds = new Set(a.changes.map((c) => c.id));
  const newChanges = b.changes
    .filter((c) => !aIds.has(c.id))
    .slice(-10)
    .map((c) => ({ label: c.label, type: c.type }));
  return {
    a: aId,
    b: bId,
    labelA: a.label,
    labelB: b.label,
    metricsA: ma,
    metricsB: mb,
    delta: {
      traffic: mb.traffic - ma.traffic,
      satisfaction: mb.satisfaction - ma.satisfaction,
      budget: mb.budget - ma.budget,
      residents: mb.residents - ma.residents,
      jobs: mb.jobs - ma.jobs,
      changes: b.changes.length - a.changes.length,
      buildings: (b.snapshot?.buildings.length ?? 0) - (a.snapshot?.buildings.length ?? 0),
      parks: (b.snapshot?.parks.length ?? 0) - (a.snapshot?.parks.length ?? 0),
    },
    newChanges,
  };
}
