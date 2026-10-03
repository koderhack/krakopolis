/**
 * Zbieranie prawdziwych danych o Krakowie do lokalnego cache (offline fallback).
 *
 * Źródła (wszystkie publiczne i oficjalne, sprawdzone na żywo):
 *  - OpenStreetMap / Overpass API  -> drogi, skrzyżowania, budynki, woda, zieleń
 *  - ZTP Kraków GTFS (T/A/M)      -> przystanki, linie, trasy, kształty
 *  - ZTP Kraków GTFS-RT           -> realne pozycje pojazdów + poziom zakrzepienia
 *  - Open-Meteo                    -> pogoda i jakość powietrza (model, nie stacja)
 *
 * Uruchomienie: npm run ingest
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AREA, AREA_NAME, ORIGIN, areaTiles, inArea, toLocal } from '../src/data/geo';
import { ENDPOINTS } from '../src/data/config';
import { decodeFeedMessage } from '../src/data/sources/mpk/gtfsrt';
import type {
  BakedArea, BakedBuilding, BakedCity, BakedEnvironment, BakedManifest, BakedNode, BakedPoi,
  BakedPolygon, BakedRoad, BakedStop, BakedTerrain, BakedTraffic, BakedTransit, BakedVehicleSnapshot,
} from '../src/data/baked';
import { unzip } from './lib/zip';
import { parseCsv } from './lib/csv';

const OUT_DIR = join(process.cwd(), 'public', 'data');
const CACHE_DIR = join(process.cwd(), '.cache');
mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(CACHE_DIR, { recursive: true });

const log = (...a: unknown[]) => console.log('•', ...a);
const nowIso = () => new Date().toISOString();
const round = (v: number) => Math.round(v * 10) / 10;
const FEEDS = ['T', 'A', 'M'] as const;
type Feed = (typeof FEEDS)[number];

/* ------------------------------------------------------------------ fetch */

async function fetchBuf(url: string, init: RequestInit = {}, tries = 4): Promise<Buffer> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 170_000);
    try {
      const res = await fetch(url, {
        ...init,
        signal: ctl.signal,
        headers: { 'User-Agent': 'simcity-krakow/0.2 (hackathon prototype)', ...(init.headers ?? {}) },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      last = e;
      const wait = 6000 * 2 ** i;
      log(`  ! ${String(e)} – czekam ${Math.round(wait / 1000)} s i ponawiam (${i + 1}/${tries})`);
      await new Promise((r) => setTimeout(r, wait));
    } finally {
      clearTimeout(timer);
    }
  }
  throw last as Error;
}

async function fetchJson<T>(url: string): Promise<T> {
  return JSON.parse((await fetchBuf(url)).toString('utf8')) as T;
}

const cachePath = (name: string) => join(CACHE_DIR, name);
/** Ile godzin może mieć plik w .cache, żeby zostać użyty bez ponownego pobierania. */
const CACHE_MAX_AGE_H = Number(process.env.INGEST_CACHE_HOURS ?? 24);

function freshCache(name: string): Buffer | null {
  if (process.env.INGEST_FORCE === '1') return null;
  const p = cachePath(name);
  if (!existsSync(p)) return null;
  const ageH = (Date.now() - statSync(p).mtimeMs) / 3_600_000;
  return ageH <= CACHE_MAX_AGE_H ? readFileSync(p) : null;
}
/** Gdy pobieranie zawiedzie, użyj ostatniego udanego pobrania z .cache. */
async function fetchWithCache(name: string, url: string, init?: RequestInit, tries = 4): Promise<{ buf: Buffer; fetchedAt: string; stale: boolean }> {
  const hit = freshCache(name);
  if (hit) return { buf: hit, fetchedAt: (existsSync(cachePath(name + '.at')) ? readFileSync(cachePath(name + '.at'), 'utf8') : nowIso()), stale: false };
  try {
    const buf = await fetchBuf(url, init, tries);
    writeFileSync(cachePath(name), buf);
    return { buf, fetchedAt: nowIso(), stale: false };
  } catch (e) {
    const p = cachePath(name);
    if (existsSync(p)) {
      log(`  ! pobieranie nieudane (${String(e)}), używam .cache/${name}`);
      const meta = p + '.at';
      return { buf: readFileSync(p), fetchedAt: existsSync(meta) ? readFileSync(meta, 'utf8') : nowIso(), stale: true };
    }
    throw e;
  }
}

/* ------------------------------------------------------------------- OSM */

interface OsmElement {
  type: string; id: number; lat?: number; lon?: number;
  /** `out center` zwraca środek dla relacji i węzłów. */
  center?: { lat: number; lon: number };
  nodes?: number[]; geometry?: { lat: number; lon: number }[]; tags?: Record<string, string>;
}

const HIGHWAY_RE = '^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|pedestrian|footway|path|steps|track)$';

function overpassQuery(b: { minLat: number; maxLat: number; minLon: number; maxLon: number }): string {
  const bb = `${b.minLat.toFixed(6)},${b.minLon.toFixed(6)},${b.maxLat.toFixed(6)},${b.maxLon.toFixed(6)}`;
  return `[out:json][timeout:120][maxsize:536870912];
(
  way["highway"~"${HIGHWAY_RE}"](${bb});
  way["building"](${bb});
  way["railway"="tram"](${bb});
  way["natural"="water"](${bb});
  way["waterway"~"^(river|canal|riverbank|stream)$"](${bb});
  relation["natural"="water"](${bb});
  relation["waterway"="river"](${bb});
  way["landuse"~"^(grass|forest|meadow|cemetery|recreation_ground)$"](${bb});
  way["leisure"~"^(park|garden)$"](${bb});
  node["highway"="traffic_signals"](${bb});
);
out geom;`;
}

/** Osobne zapytanie o miejsca (POI) – małe, więc Overpass odpowiada szybko. */
function poiQuery(b: { minLat: number; maxLat: number; minLon: number; maxLon: number }): string {
  const bb = `${b.minLat.toFixed(6)},${b.minLon.toFixed(6)},${b.maxLat.toFixed(6)},${b.maxLon.toFixed(6)}`;
  return `[out:json][timeout:90];
(
  node["amenity"~"^(post_office|townhall|university|hospital|place_of_worship|police|fire_station|theatre|courthouse)$"](${bb});
  node["tourism"~"^(attraction|museum|artwork|viewpoint)$"](${bb});
  node["railway"="station"](${bb});
  node["historic"~"^(memorial|monument|castle)$"](${bb});
  node["leisure"~"^(park|garden)$"]["name"](${bb});
);
out center tags;`;
}

/** Osobne zapytanie o koryto rzeki (Wisła) – linie OSM. */
function riverQuery(b: { minLat: number; maxLat: number; minLon: number; maxLon: number }): string {
  const bb = `${b.minLat.toFixed(6)},${b.minLon.toFixed(6)},${b.maxLat.toFixed(6)},${b.maxLon.toFixed(6)}`;
  return `[out:json][timeout:90];
(
  way["waterway"~"^(river|riverbank|canal)$"](${bb});
  way["natural"="water"](${bb});
  relation["natural"="water"](${bb});
);
out geom tags;`;
}

/**
 * Wykonuje zapytanie przez mirrory i zapisuje wynik w .cache.
 *
 * `budgetMs` to twardy limit czasu na całe zapytanie. Overpass potrafi
 * zwracać 504 przez kilkanaście sekund albo w ogóle nie odpowiedzieć, a bez
 * limitu jedno z opcjonalnych źródeł (POI, rzeki) blokowało cały zapis danych –
 * i zostawiało nas na starej, sprzed wielu wersji wypiance.
 */
async function overpass(name: string, query: string, tileIdx: number, budgetMs = 45_000): Promise<OsmElement[]> {
  const body = new URLSearchParams({ data: query }).toString();
  const deadline = Date.now() + budgetMs;
  let err: unknown;
  for (const m of OVERPASS_MIRRORS) {
    if (Date.now() > deadline) break;
    try {
      const { buf, stale } = await fetchWithCache(name + '-' + tileIdx + '.json', m, {
        method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, 1);
      void stale;
      const data = JSON.parse(buf.toString('utf8')) as { elements?: OsmElement[] };
      return data.elements ?? [];
    } catch (e) { err = e; }
  }
  log(`  ! zapytanie ${name} nieudane (pomijam, reszta danych się zapisze): ${String(err)}`);
  return [];
}

const OVERPASS_MIRRORS = [
  ENDPOINTS.overpass,
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];


async function fetchOsm(): Promise<OsmElement[]> {
  const tiles = areaTiles(3, 4);
  const byId = new Map<string, OsmElement>();
  for (const [i, t] of tiles.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 4000)); // Overpass nie lubi równoległych zapytań
    const body = new URLSearchParams({ data: overpassQuery(t) }).toString();
    log(`OSM: kafelek ${i + 1}/${tiles.length}`);
    let got: { buf: Buffer; stale: boolean } | null = null;
    let err: unknown;
    for (const m of OVERPASS_MIRRORS) {
      try {
        got = await fetchWithCache(`osm-tile-${i}.json`, m, { method: 'POST', body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        break;
      } catch (e) { err = e; }
    }
    if (!got) throw err as Error;
    const data = JSON.parse(got.buf.toString('utf8')) as { elements?: OsmElement[] };
    for (const el of data.elements ?? []) {
      const key = `${el.type}/${el.id}`;
      const prev = byId.get(key);
      if (prev) prev.tags = { ...prev.tags, ...el.tags };
      else byId.set(key, el);
    }
    log(`  → ${data.elements?.length ?? 0} elementów`);
  }
  return [...byId.values()];
}

/* --------------------------------------------------------- budowa grafu */

const SPEED_KMH: Record<string, number> = {
  motorway: 80, trunk: 60, primary: 50, secondary: 50, tertiary: 50,
  unclassified: 40, residential: 30, living_street: 20, service: 20, track: 20,
  pedestrian: 20, footway: 15, path: 15, steps: 10,
};
const CAR_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'track']);
const PED_CLASSES = new Set(['pedestrian', 'footway', 'path', 'steps']);

const FACADES = ['#e8d5b0', '#d9a47c', '#c8826b', '#e6c27a', '#b9c4a6', '#d7cbbd', '#9fb7c6', '#e3b7a0', '#cfc3b0', '#cbb9a4'];
const ROOFS = ['#8a3b32', '#6e3a34', '#5e4b46', '#7d4a3a', '#4a4a52'];
const hash01 = (n: number) => { let h = (n ^ 0x9e3779b9) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0; h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0; return ((h >>> 8) & 0xffff) / 0x10000; };

function cleanNum(s?: string): number {
  if (!s) return NaN;
  const n = parseFloat(String(s).replace(',', '.').replace(/[^\d.]/g, ''));
  return n;
}

function buildingHeight(t: Record<string, string>): number {
  const h = cleanNum(t.height);
  if (isFinite(h) && h > 2 && h < 400) return h;
  const lv = cleanNum(t['building:levels'] ?? t.levels);
  if (isFinite(lv) && lv > 0 && lv < 45) return lv * 3.3 + 1.2;
  const type = t.building ?? '';
  if (type === 'church' || type === 'cathedral' || type === 'chapel') return 16;
  if (type === 'industrial' || type === 'warehouse' || type === 'factory') return 14;
  if (type === 'apartments' || type === 'residential' || type === 'dormitory' || type === 'retail') return 18;
  if (type === 'commercial' || type === 'office') return 20;
  if (type === 'garage' || type === 'carport' || type === 'shed' || type === 'hut') return 6;
  return 12;
}

/**
 * Uproszczenie pierścienia – Douglas-Peucker z tolerancją 0,8 m.
 * Trzyma kształt budynku (narożniki, wycięcia), ale ogranicza liczbę punktów,
 * żeby plik z danymi pozostał rozsądnego rozmiaru.
 *
 * OSM zamyka way budynków: pierwszy punkt = ostatni. Bez otwarcia pierścienia
 * baza DP ma długość 0, wszystkie odstępy wychodzą 0 i zostają tylko 2 punkty
 * → pusty obrys → w 3D prostopadłościan zamiast prawdziwego kształtu.
 */
function simplifyRing(ring: [number, number][], tol = 0.8): [number, number][] {
  if (ring.length < 3) return [];
  // otwórz zamknięty pierścień (pierwszy ≈ ostatni)
  let pts = ring;
  if (Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.35) {
    pts = ring.slice(0, -1);
  }
  // usuń kolejne duplikaty po zaokrągleniu
  const dedup: [number, number][] = [];
  for (const p of pts) {
    const q: [number, number] = [round(p[0]), round(p[1])];
    const prev = dedup[dedup.length - 1];
    if (!prev || Math.hypot(prev[0] - q[0], prev[1] - q[1]) > 0.15) dedup.push(q);
  }
  if (dedup.length >= 3 && Math.hypot(dedup[0][0] - dedup[dedup.length - 1][0], dedup[0][1] - dedup[dedup.length - 1][1]) < 0.35) {
    dedup.pop();
  }
  if (dedup.length < 3) return [];
  if (dedup.length <= 6) return dedup;

  const keep = new Uint8Array(dedup.length);
  keep[0] = 1;
  keep[dedup.length - 1] = 1;
  const stack: [number, number][] = [[0, dedup.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1, worstD = tol;
    const [ax, az] = dedup[a], [bx, bz] = dedup[b];
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) continue;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((dedup[i][0] - ax) * dz - (dedup[i][1] - az) * dx) / len;
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out: [number, number][] = [];
  for (let i = 0; i < dedup.length; i++) if (keep[i]) out.push(dedup[i]);
  // awaryjnie: lepiej pełny obrys niż pusty (prostopadłościan w scenie)
  return out.length >= 3 ? out : dedup;
}

/** Kadr obrysu budynku: najdłuższa krawędź wyznacza oś dłuższą. */
function footprint(ring: [number, number][]) {
  let best = 0, bi = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (l > best) { best = l; bi = i; }
  }
  const a = ring[bi], b = ring[(bi + 1) % ring.length];
  const ux = (b[0] - a[0]) / best, uz = (b[1] - a[1]) / best;
  const rot = Math.atan2(-uz, ux);
  const nx = -uz, nz = ux;
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of ring) {
    const dx = p[0] - a[0], dz = p[1] - a[1];
    const u = dx * ux + dz * uz, v = dx * nx + dz * nz;
    if (u < u0) u0 = u; if (u > u1) u1 = u;
    if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  return {
    rot,
    w: Math.max(4, u1 - u0), d: Math.max(4, v1 - v0),
    x: a[0] + ux * (u0 + u1) / 2 + nx * (v0 + v1) / 2,
    z: a[1] + uz * (u0 + u1) / 2 + nz * (v0 + v1) / 2,
  };
}

function buildCity(osm: OsmElement[]): BakedCity {
  const area: BakedArea = { ...AREA, origin: ORIGIN, name: AREA_NAME };

  // 1. Współrzędne węzłów OSM -> metry lokalne
  const coord = new Map<number, [number, number]>();
  for (const el of osm) {
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      coord.set(el.id, [round(toLocal(el.lat, el.lon).x), round(toLocal(el.lat, el.lon).z)]);
    }
  }
  for (const el of osm) {
    if (el.type !== 'way' || !el.geometry) continue;
    const ids = el.nodes ?? [];
    for (let i = 0; i < ids.length && i < el.geometry.length; i++) {
      if (coord.has(ids[i])) continue;
      const g = el.geometry[i];
      coord.set(ids[i], [round(toLocal(g.lat, g.lon).x), round(toLocal(g.lat, g.lon).z)]);
    }
  }

  // 2. Drogi -> odcinki między kolejnymi węzłami OSM, na wspólnym grafie
  /**
   * OSM w Krakowie rozbija szerokie ulice na dwie niezależne jezdnie, a skrzyżowanie
   * łączy je dopiero chodnikiem – obie strony mają ODRĘBNE węzły, często kilka metrów
   * od siebie. Bez złączenia tych węzłów sieć drogowa rozpada się na setki kawałków
   * i nie da się po niej jeździć. Dlatego węzły scala Find-Union: każdy węzeł szukamy
   * w siatce o oczku 4 m i łączymy z sąsiadami bliższymi niż 4 m.
   */
  const MERGE_M = 4;
  const cellKey = (x: number, z: number) => `${Math.floor(x / MERGE_M)},${Math.floor(z / MERGE_M)}`;
  const parent: number[] = [];
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const grid = new Map<string, number[]>();

  const rawNodes: [number, number][] = [];
  const rawByOsmNode = new Map<number, number>();
  /** Jeden węzeł surowy na węzeł OSM – dzięki temu kolejne odcinki ulicy się łączą. */
  const rawNodeOf = (osmNodeId: number, p: [number, number]) => {
    const hit = rawByOsmNode.get(osmNodeId);
    if (hit !== undefined) return hit;
    const id = rawNodes.length;
    rawNodes.push(p);
    parent[id] = id;
    rawByOsmNode.set(osmNodeId, id);
    return id;
  };

  const tramWays = new Set<number>();
  for (const el of osm) if (el.type === 'way' && el.tags?.railway === 'tram') tramWays.add(el.id);

  const roads: BakedRoad[] = [];
  const seenSeg = new Set<string>();
  for (const el of osm) {
    if (el.type !== 'way') continue;
    // Odcinek drogi albo – osobno mapowane w OSM – torowisko.
    // Torowiska są potrzebne, bo po nich naprawdę jadą tramwaje.
    const tags = el.tags ?? {};
    const isTramTrack = tags.railway === 'tram' && !tags.highway;
    const highway = tags.highway;
    if (!isTramTrack && !highway) continue;
    const ids = el.nodes ?? [];
    for (let i = 1; i < ids.length; i++) {
      const pa = coord.get(ids[i - 1]), pb = coord.get(ids[i]);
      if (!pa || !pb) continue;
      if (Math.hypot(pb[0] - pa[0], pb[1] - pa[1]) < 2) continue;
      const key = ids[i - 1] < ids[i] ? `${ids[i - 1]}-${ids[i]}` : `${ids[i]}-${ids[i - 1]}`;
      if (seenSeg.has(key)) continue;
      seenSeg.add(key);
      const mx = (pa[0] + pb[0]) / 2, mz = (pa[1] + pb[1]) / 2;
      if (!inLocalArea(mx, mz)) continue;
      const cls = isTramTrack ? 'tram' : highway!;
      const carAccess = !isTramTrack && CAR_CLASSES.has(cls);
      const kmhTag = tags.maxspeed;
      const kmh = isTramTrack ? 30 : kmhTag && /^\d+$/.test(kmhTag) ? parseInt(kmhTag, 10) : (SPEED_KMH[cls] ?? 30);
      const oneway = isTramTrack
        ? true
        : tags.oneway === 'yes' || tags.oneway === '1' || tags.oneway === 'true' || cls === 'motorway';
      const lanesRaw = parseInt(tags.lanes ?? '', 10);
      const lanes = isTramTrack ? 2 : isFinite(lanesRaw) && lanesRaw > 0 ? lanesRaw : carAccess ? ((SPEED_KMH[cls] ?? 30) >= 50 ? 2 : 1) : 1;
      roads.push({
        id: roads.length,
        a: rawNodeOf(ids[i - 1], pa), b: rawNodeOf(ids[i], pb),
        name: tags.name ?? tags.ref ?? '',
        ref: tags.ref,
        roadClass: cls,
        lanes,
        lanesForward: Math.max(1, oneway ? lanes : Math.ceil(lanes / 2)),
        oneway,
        speedLimit: Math.max(2.8, Math.min(kmh, 130) / 3.6),
        hasTram: tramWays.has(el.id),
        carAccess,
        transit: false,
        osmId: el.id,
      });
    }
  }

  // 2b. Scalanie węzłów leżących na jednym skrzyżowaniu.
  rawNodes.forEach((p, i) => {
    const cx = Math.floor(p[0] / MERGE_M), cz = Math.floor(p[1] / MERGE_M);
    for (let a = -1; a <= 1; a++)
      for (let b = -1; b <= 1; b++) {
        const arr = grid.get(`${cx + a},${cz + b}`);
        if (!arr) continue;
        for (const j of arr) {
          if (Math.hypot(p[0] - rawNodes[j][0], p[1] - rawNodes[j][1]) <= MERGE_M) union(i, j);
        }
      }
    const k = cellKey(p[0], p[1]);
    const arr = grid.get(k);
    if (arr) arr.push(i); else grid.set(k, [i]);
  });
  const remap = new Int32Array(rawNodes.length);
  for (let i = 0; i < rawNodes.length; i++) remap[i] = find(i);
  const mergedIndex = new Map<number, number>();
  const nodes: BakedNode[] = [];
  const mergedOf = (i: number) => {
    const r = remap[i];
    const hit = mergedIndex.get(r);
    if (hit !== undefined) return hit;
    const id = nodes.length;
    const p = rawNodes[i];
    nodes.push({ x: p[0], z: p[1] });
    mergedIndex.set(r, id);
    return id;
  };
  for (const r of roads) { r.a = mergedOf(r.a); r.b = mergedOf(r.b); }
  // zerwane odcinki (oba końce scaliły się w jeden punkt) usuwamy
  for (let i = roads.length - 1; i >= 0; i--) if (roads[i].a === roads[i].b) roads.splice(i, 1);
  roads.forEach((r, i) => { r.id = i; });

  // 2c. Łączenie krótkich, niemal prostych odcinków.
  // OSM wstawia węzeł na każdym zakręcie i każdej zmianie nachylenia, przez co
  // jedna ulica to 20 odcinków po 2–4 m. Symulacja węzła co klatkę, a pojazdy
  // „przeskakiwałyby” przez miasto. Scalamy więc odcinki tej samej ulicy, które
  // leżą niemal w linii prostej.
  const finalRoads = mergeCollinear(nodes, roads);
  log(`  scalanie odcinków: ${roads.length} -> ${finalRoads.length}`);
  for (let i = 0; i < finalRoads.length; i++) finalRoads[i].id = i;

  // 3. Budynki
  const buildings: BakedBuilding[] = [];
  const seenB = new Set<number>();
  for (const el of osm) {
    if (el.type !== 'way' || !el.tags || el.tags.building === undefined || el.tags.building === 'no') continue;
    if (seenB.has(el.id)) continue;
    seenB.add(el.id);
    const ring: [number, number][] = [];
    for (const nid of el.nodes ?? []) { const p = coord.get(nid); if (p) ring.push(p); }
    if (ring.length < 3) continue;
    const f = footprint(ring);
    if (!inLocalArea(f.x, f.z)) continue;
    const hv = hash01(el.id);
    const landmark = el.tags.building === 'church' || el.tags.building === 'cathedral' || el.tags.building === 'chapel'
      || el.tags.tourism === 'attraction' || !!el.tags.historic || el.tags.amenity === 'place_of_worship';
    // Prawdziwy obrys z OSM – na nim budujemy bryłę w 3D (jak w Apple Maps).
    // Zabytki i duże bryły: niższa tolerancja, żeby Sukiennice/Wawel nie
    // zamieniły się w sześciokąt.
    const areaApprox = f.w * f.d;
    const tol = landmark || areaApprox > 2500 ? 0.35 : areaApprox > 800 ? 0.55 : 0.8;
    buildings.push({
      x: round(f.x), z: round(f.z), w: round(f.w), d: round(f.d), h: round(buildingHeight(el.tags)),
      rot: round(f.rot),
      color: el.tags['building:colour'] ?? FACADES[Math.floor(hv * FACADES.length) % FACADES.length],
      roof: el.tags['roof:colour'] ?? ROOFS[Math.floor(hv * 977) % ROOFS.length],
      name: el.tags.name,
      landmark,
      ring: simplifyRing(ring, tol),
      levels: isFinite(cleanNum(el.tags['building:levels'])) ? cleanNum(el.tags['building:levels']) : undefined,
    });
  }

  // 3b. NIE usuwamy odcinków „przez budynki”.
  // Wcześniejsze kasowanie rozrywało siatkę ulic Starego Miasta (fałszywe
  // trafienia AABB + realne nachodzenie obrysów OSM na jezdnię). Zamiast tego
  // budynki są odsunięte od pasa drogowego w cityAdapter (RoadCorridor).
  const keptRoads = finalRoads;
  log(`  odcinki dróg zachowane w całości: ${keptRoads.length} (budynki odsuną się od jezdni w adapterze)`);

  // 4. Woda i zieleń
  const polygons: BakedPolygon[] = [];
  const seenP = new Set<number>();
  const toRing = (el: OsmElement): [number, number][] => {
    const ring: [number, number][] = [];
    for (const nid of el.nodes ?? []) { const p = coord.get(nid); if (p) ring.push(p); }
    return ring;
  };

  // Wisła w OSM jest zmapowana jako multipolygon (relacja), więc `way` daje tylko
  // linie koryta. Zamiast zmyślać kształt, budujemy z linii rzeki taśmę
  // o szerokości z tagu `width` (domyślnie 70 m – realna szerokość Wisły w Krakowie).
  for (const el of osm) {
    if (el.type !== 'way' || !el.tags) continue;
    if (!['river', 'riverbank', 'canal'].includes(el.tags.waterway ?? '')) continue;
    if (seenP.has(el.id)) continue;
    const line = toRing(el);
    if (line.length < 2) continue;
    seenP.add(el.id);
    const widthTag = cleanNum(el.tags.width);
    const width = isFinite(widthTag) && widthTag > 3 ? widthTag : el.tags.waterway === 'canal' ? 22 : 70;
    const ribbon: [number, number][] = [];
    for (let i = 0; i < line.length; i++) {
      const p = line[i];
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      ribbon.push([p[0] + nx * width / 2, p[1] + nz * width / 2]);
    }
    for (let i = line.length - 1; i >= 0; i--) {
      const p = line[i];
      const a = line[Math.max(0, i - 1)], b = line[Math.min(line.length - 1, i + 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      ribbon.push([p[0] - nx * width / 2, p[1] - nz * width / 2]);
    }
    if (ribbon.length >= 3) polygons.push({ ring: ribbon, kind: 'water' });
  }

  for (const el of osm) {
    if (el.type === 'relation') {
      // relacja wody: składamy pierścienie z jej członków
      const tags = el.tags ?? {};
      const water = tags.natural === 'water' || tags.waterway === 'river';
      if (!water) continue;
      const ring = toRing(el);
      if (ring.length >= 3 && !seenP.has(el.id)) {
        seenP.add(el.id);
        polygons.push({ ring, kind: 'water', name: tags.name?.trim() || undefined });
      }
    }
    if (el.type !== 'way' || !el.tags) continue;
    const water = el.tags.natural === 'water' || el.tags.waterway === 'river' || el.tags.waterway === 'canal';
    const green = ['grass', 'forest', 'meadow', 'cemetery', 'recreation_ground'].includes(el.tags.landuse ?? '')
      || ['park', 'garden'].includes(el.tags.leisure ?? '');
    if (!water && !green) continue;
    if (seenP.has(el.id)) continue;
    seenP.add(el.id);
    const ring: [number, number][] = [];
    for (const nid of el.nodes ?? []) { const p = coord.get(nid); if (p) ring.push(p); }
    if (ring.length < 3) continue;
    // Odcinamy pierścienie bardzo duże (np. cała dolina Wisły) – w symulacji niepotrzebne.
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of ring) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
    if (maxX - minX > 900 && maxZ - minZ > 900) continue;
    const polyName = el.tags.name?.trim() || undefined;
    polygons.push({ ring, kind: water ? 'water' : 'green', name: polyName });
  }

  const signals: [number, number][] = [];
  for (const el of osm) {
    if (el.type !== 'node' || el.tags?.highway !== 'traffic_signals') continue;
    const p = coord.get(el.id);
    if (p) signals.push(p);
  }

  // 5. Miejsca (POI) – po nich działa wyszukiwarka w aplikacji.
  const pois: BakedPoi[] = [];
  const seenPoi = new Set<number>();
  const CATEGORY: Record<string, string> = {
    post_office: 'Poczta', townhall: 'Urząd', university: 'Uczelnia', hospital: 'Szpital',
    place_of_worship: 'Kościół', police: 'Policja', fire_station: 'Straż pożarna',
    theatre: 'Teatr', courthouse: 'Sąd', attraction: 'Atrakcja', station: 'Dworzec',
    memorial: 'Pomnik', monument: 'Pomnik', castle: 'Zamek',
    museum: 'Muzeum', artwork: 'Rzeźba', viewpoint: 'Punkt widokowy',
    park: 'Park', garden: 'Ogród',
  };
  const poiKey = (tags: Record<string, string>) =>
    tags.amenity ?? tags.tourism ?? tags.railway ?? tags.historic ?? tags.leisure;
  for (const el of osm) {
    if (seenPoi.has(el.id) || !el.tags) continue;
    const tags = el.tags;
    if (!tags.name) continue;
    const key = poiKey(tags);
    if (!key) continue;
    const category = CATEGORY[key];
    if (!category) continue;
    let p = el.type === 'node' ? coord.get(el.id) : undefined;
    if (!p && el.lat !== undefined && el.lon !== undefined) {
      const loc = toLocal(el.lat, el.lon);
      p = [round(loc.x), round(loc.z)];
    }
    if (!p && el.type === 'way' && el.nodes?.length) {
      let sx = 0, sz = 0, n = 0;
      for (const nid of el.nodes) {
        const c = coord.get(nid);
        if (c) { sx += c[0]; sz += c[1]; n++; }
      }
      if (n) p = [round(sx / n), round(sz / n)];
    }
    if (!p || !inLocalArea(p[0], p[1])) continue;
    seenPoi.add(el.id);
    pois.push({ name: tags.name, category, x: p[0], z: p[1] });
  }

  return { generatedAt: nowIso(), area, nodes, roads: keptRoads, buildings, polygons, signals, pois };
}

function inLocalArea(x: number, z: number): boolean {
  const mLat = ORIGIN.lat - z / 111_320;
  const mLon = ORIGIN.lon + x / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
  return inArea(mLat, mLon);
}

/* -------------------------------------------------------- indeks krawędzi */

/** Przyspieszone wyszukiwanie najbliższego odcinka drogi (siatka heksagonalna ~= prostokątna). */
/**
 * Wyszukiwanie najbliższego odcinka. `prefer` pozwala wymusić rodzaj drogi:
 * trasy tramwajowe szukamy na torowiskach, autobusowe na drogach zjazdowych.
 * Bez tego trasy wpadały na chodniki i liczba węzłów w trasie rosła w kosmos.
 */
function makeEdgeFinder(nodes: BakedNode[], roads: BakedRoad[], cell = 70, prefer: (r: BakedRoad) => boolean = () => true) {
  const geoms = roads.map((r) => {
    const A = nodes[r.a], B = nodes[r.b];
    return { x1: A.x, z1: A.z, x2: B.x, z2: B.z };
  });
  const grid = new Map<string, number[]>();
  geoms.forEach((g, i) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(g.x2 - g.x1, g.z2 - g.z1) / cell));
    for (let s = 0; s <= steps; s++) {
      const x = g.x1 + ((g.x2 - g.x1) * s) / steps, z = g.z1 + ((g.z2 - g.z1) * s) / steps;
      const k = Math.floor(x / cell) + ',' + Math.floor(z / cell);
      const arr = grid.get(k);
      if (arr) arr.push(i); else grid.set(k, [i]);
    }
  });
  return (x: number, z: number, radius = 1): { edge: number; dist: number; t: number } | null => {
    const cx = Math.floor(x / cell), cz = Math.floor(z / cell);
    let best: { edge: number; dist: number; t: number } | null = null;
    const seen = new Set<number>();
    for (let a = -radius; a <= radius; a++)
      for (let b = -radius; b <= radius; b++) {
        const arr = grid.get(cx + a + ',' + (cz + b));
        if (!arr) continue;
        for (const i of arr) {
          if (seen.has(i)) continue;
          seen.add(i);
          const g = geoms[i];
          const dx = g.x2 - g.x1, dz = g.z2 - g.z1;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.max(0, Math.min(1, ((x - g.x1) * dx + (z - g.z1) * dz) / l2));
          const raw = Math.hypot(x - (g.x1 + dx * t), z - (g.z1 + dz * t));
          // Preferowany rodzaj drogi dostaje premię 90 m – wybieramy go, gdy
          // nie jest drastycznie dalej.
          const dist = raw + (prefer(roads[i]) ? 0 : 90);
          if (!best || dist < best.dist) best = { edge: i, dist, t };
        }
      }
    return best;
  };
}

/* ------------------------------------------------------------------ GTFS */

interface GtfsStops { stops: Map<string, { id: string; name: string; lat: number; lon: number; x: number; z: number }> }
interface GtfsMeta {
  /** Klucze w formacie `${feed}|${route_id}` – route_id bywa powtórzone między feedami. */
  routes: Map<string, { ref: string; kind: 'tram' | 'bus'; operator: string }>;
  trips: Map<string, { route: string; dir: number; shape: string }>;
  shapes: Map<string, [number, number][]>;
}

function readCsvFromZip(zipBuf: Buffer, name: string): Record<string, string>[] {
  const f = unzip(zipBuf).get(name);
  return f ? parseCsv(f.toString('utf8')) : [];
}

/** shapes.txt bywa 30 MB – czytamy strumieniowo po liniach, od razu rzutując na metry. */
function readShapesInArea(zipBuf: Buffer): Map<string, [number, number][]> {
  const f = unzip(zipBuf).get('shapes.txt');
  const out = new Map<string, [number, number][]>();
  if (!f) return out;
  const text = f.toString('utf8');
  let cur = '';
  let count = 0;
  const flush = () => {
    if (cur.length > 4) {
      const c1 = cur.indexOf(',');
      const c2 = cur.indexOf(',', c1 + 1);
      const c3 = cur.indexOf(',', c2 + 1);
      if (c1 > 0 && c2 > c1) {
        const id = cur.slice(0, c1);
        const lat = parseFloat(cur.slice(c1 + 1, c2));
        const lon = parseFloat(cur.slice(c2 + 1, c3 > c2 ? c3 : undefined));
        if (isFinite(lat) && isFinite(lon) && inArea(lat, lon)) {
          const p = toLocal(lat, lon);
          let arr = out.get(id);
          if (!arr) { arr = []; out.set(id, arr); }
          arr.push([round(p.x), round(p.z)]);
        }
      }
    }
    cur = '';
    if (++count % 500_000 === 0) log(`  shapes.txt: ${count} linii...`);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') flush();
    else if (c !== '\r') cur += c;
  }
  flush();
  return out;
}

async function loadGtfs(feed: Feed): Promise<GtfsStops & GtfsMeta> {
  log(`GTFS ${feed}: pobieram ${ENDPOINTS.ztpGtfs(feed)}`);
  const { buf, fetchedAt } = await fetchWithCache(`gtfs-${feed}.zip`, ENDPOINTS.ztpGtfs(feed));
  writeFileSync(cachePath(`gtfs-${feed}.zip.at`), fetchedAt);

  const isTram = feed === 'T';
  const operator = feed === 'T' ? 'MPK – tramwaje' : feed === 'A' ? 'MPK – autobusy' : 'Mobilis – autobusy';

  const stops = new Map<string, GtfsStops['stops'] extends Map<string, infer V> ? V : never>();
  for (const s of readCsvFromZip(buf, 'stops.txt')) {
    const lat = parseFloat(s.stop_lat), lon = parseFloat(s.stop_lon);
    if (!isFinite(lat) || !isFinite(lon) || !inArea(lat, lon)) continue;
    const p = toLocal(lat, lon);
    stops.set(s.stop_id, { id: s.stop_id, name: s.stop_name || s.stop_id, lat, lon, x: round(p.x), z: round(p.z) });
  }

  const routes = new Map<string, { ref: string; kind: 'tram' | 'bus'; operator: string }>();
  for (const r of readCsvFromZip(buf, 'routes.txt')) {
    const ref = r.route_short_name || r.route_long_name;
    if (!ref) continue;
    const kind: 'tram' | 'bus' = isTram || r.route_type === '900' || r.route_type === '0' ? 'tram' : 'bus';
    routes.set(`${feed}|${r.route_id}`, { ref, kind, operator });
  }

  const shapes = readShapesInArea(buf);
  log(`GTFS ${feed}: ${stops.size} przystanków, ${shapes.size} kształtów w obszarze`);

  const trips = new Map<string, { route: string; dir: number; shape: string }>();
  for (const t of readCsvFromZip(buf, 'trips.txt')) {
    if (!routes.has(`${feed}|${t.route_id}`) || !shapes.has(t.shape_id)) continue;
    trips.set(t.trip_id, {
      route: `${feed}|${t.route_id}`,
      dir: parseInt(t.direction_id ?? '0', 10) || 0,
      shape: `${feed}|${t.shape_id}`,
    });
  }
  log(`GTFS ${feed}: ${trips.size} kursów dotykających obszaru`);
  return { stops, routes, trips, shapes };
}

/* ---------------------------------------------------------- GTFS-RT live */

async function fetchLiveVehicles(trips: Map<string, { route: string; dir: number }>, routes: Map<string, { ref: string }>): Promise<{ vehicles: BakedVehicleSnapshot[]; headerTs?: number }> {
  const vehicles: BakedVehicleSnapshot[] = [];
  let headerTs: number | undefined;
  for (const feed of FEEDS) {
    let buf: Buffer;
    try {
      const cached = freshCache(`rt-${feed}.pb`);
      if (cached) { buf = cached; log(`GTFS-RT ${feed}: z .cache (${cached.length} B)`); }
      else {
        buf = await fetchBuf(ENDPOINTS.ztpVehiclePositions(feed), {}, 2);
        writeFileSync(cachePath(`rt-${feed}.pb`), buf);
        writeFileSync(cachePath(`rt-${feed}.pb.at`), nowIso());
      }
    } catch (e) {
      log(`  ! GTFS-RT ${feed} niedostępny: ${String(e)}`);
      continue;
    }
    const rt = decodeFeedMessage(new Uint8Array(buf));
    headerTs = headerTs ?? rt.timestamp;
    let inside = 0;
    for (const v of rt.vehicles) {
      if (v.latitude === undefined || v.longitude === undefined) continue;
      if (!inArea(v.latitude, v.longitude)) continue;
      inside++;
      const trip = v.trip.tripId ? trips.get(v.trip.tripId) : undefined;
      const routeId = v.trip.routeId ?? trip?.route;
      const meta = routeId ? routes.get(routeId) : undefined;
      const p = toLocal(v.latitude, v.longitude);
      vehicles.push({
        id: `${feed}:${v.id}`,
        feed,
        tripId: v.trip.tripId,
        line: meta?.ref ?? (routeId ?? '—'),
        dir: v.trip.directionId ?? trip?.dir ?? 0,
        lat: v.latitude, lon: v.longitude, x: round(p.x), z: round(p.z),
        bearing: v.bearing,
        speed: v.speed !== undefined && v.speed > 0 && v.speed < 45 ? Math.round(v.speed * 10) / 10 : undefined,
        congestionLevel: v.congestionLevel && v.congestionLevel > 0 ? v.congestionLevel : undefined,
        timestamp: new Date((v.timestamp ?? rt.timestamp ?? 0) * 1000).toISOString(),
      });
    }
    log(`GTFS-RT ${feed}: ${rt.vehicles.length} pojazdów w feedzie, ${inside} w obszarze symulacji`);
  }
  return { vehicles, headerTs };
}

/**
 * Wysokości terenu z publicznego API Open-Meteo (model Copernicus DEM / GMTED).
 * Siatka 48×48 na obszarze symulacji – wystarczająco gładka, żeby Kraków
 * miał realny profil terenu (Wawel, kopiec Sikar, dolina Wisły).
 */
async function fetchTerrain(): Promise<BakedTerrain> {
  const existing = join(OUT_DIR, 'terrain.json');
  if (existsSync(existing) && process.env.INGEST_FORCE_TERRAIN !== '1') {
    try {
      const t = JSON.parse(readFileSync(existing, 'utf8')) as BakedTerrain;
      if (t.heights?.length) {
        log('  używam istniejącego public/data/terrain.json');
        return t;
      }
    } catch { /* pobierz od nowa */ }
  }
  const halfX = ((AREA.maxLon - ORIGIN.lon) * 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)) / 2 + 300;
  const halfZ = ((ORIGIN.lat - AREA.minLat) * 111_320) / 2 + 300;
  const cols = 48, rows = 48;
  const lats: number[] = [], lons: number[] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      lats.push(ORIGIN.lat - (halfZ * (1 - (2 * r) / (rows - 1))) / 111_320);
      lons.push(ORIGIN.lon + (halfX * (-1 + (2 * c) / (cols - 1))) / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)));
    }
  const heights: number[] = [];
  const CHUNK = 400;
  for (let i = 0; i < lats.length; i += CHUNK) {
    const la = lats.slice(i, i + CHUNK), lo = lons.slice(i, i + CHUNK);
    const url = `${ENDPOINTS.openMeteo}/elevation?latitude=${la.map((v) => v.toFixed(6)).join(',')}&longitude=${lo.map((v) => v.toFixed(6)).join(',')}`;
    try {
      const buf = await fetchBuf(url, {}, 1);
      const j = JSON.parse(buf.toString('utf8')) as { elevation: number[] };
      heights.push(...j.elevation.map((v) => Math.round(v * 10) / 10));
    } catch (e) {
      log('  ! wysokości niedostępne:', String(e));
      while (heights.length < lats.length) heights.push(210);
    }
  }
  return {
    generatedAt: nowIso(),
    minX: -halfX, maxX: halfX, minZ: -halfZ, maxZ: halfZ,
    cols, rows, heights: heights.slice(0, cols * rows),
    source: 'Open-Meteo Elevation API (Copernicus DEM / GMTED)',
  };
}

/* ------------------------------------------------------------------ main */

async function main() {
  const t0 = Date.now();
  const write = (name: string, obj: unknown) => {
    const s = JSON.stringify(obj);
    writeFileSync(join(OUT_DIR, name), s);
    log(`zapisano public/data/${name} (${Math.round(s.length / 1024)} kB)`);
  };

  log('=== 1/5 OpenStreetMap (Overpass API) ===');
  const osm = await fetchOsm();

  // POI / rzeki: opcjonalne. Bez sieci (albo INGEST_FAST=1) pomijamy, żeby
  // zawsze zapisać pełną siatkę dróg z .cache osm-tile-*.json.
  const skipExtra = process.env.INGEST_FAST === '1' || process.env.INGEST_OFFLINE === '1';
  if (skipExtra) {
    log('OSM: pomijam POI i rzeki (INGEST_FAST/OFFLINE) – używam kafelków + starych pois z poprzedniego pliku');
    try {
      const prev = JSON.parse(readFileSync(join(OUT_DIR, 'osm-city.json'), 'utf8')) as BakedCity;
      if (prev.pois?.length) {
        for (const p of prev.pois) {
          osm.push({
            type: 'node', id: Math.round(p.x * 1000 + p.z),
            lat: ORIGIN.lat - p.z / 111_320,
            lon: ORIGIN.lon + p.x / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180)),
            tags: { name: p.name, amenity: p.category === 'Poczta' ? 'post_office' : 'attraction' },
          });
        }
      }
      // zachowaj też wodę/zieleń z poprzedniego pliku przez geometrię – nie, polygons
      // powstają z osm elements; river z kafelków głównych już jest w way waterway
    } catch { /* brak poprzedniego pliku */ }
  } else {
    log('OSM: miejsca (POI)');
    const tiles = areaTiles(2, 3);
    const poiEls: OsmElement[] = [];
    const poiBudget = Date.now() + 40_000;
    for (const [i, t] of tiles.entries()) {
      if (Date.now() > poiBudget) { log('  ! pomijam część kafelków POI'); break; }
      const els = await overpass('osm-poi', poiQuery(t), i, 8_000);
      for (const e of els) {
        const lat = e.lat ?? (e.center?.lat);
        const lon = e.lon ?? (e.center?.lon);
        if (lat !== undefined && lon !== undefined) poiEls.push({ ...e, lat, lon });
      }
    }
    log(`OSM: ${poiEls.length} miejsc`);
    osm.push(...poiEls);

    log('OSM: rzeki');
    const riverEls: OsmElement[] = [];
    const riverBudget = Date.now() + 25_000;
    for (const [i, t] of tiles.entries()) {
      if (Date.now() > riverBudget) break;
      riverEls.push(...(await overpass('osm-river', riverQuery(t), i, 6_000)));
    }
    log(`OSM: ${riverEls.length} fragmentów rzeki`);
    osm.push(...riverEls);
  }
  log(`OSM: ${osm.length} elementów łącznie`);
  const city = buildCity(osm);
  // Przywróć pois z poprzedniego pliku, jeśli nowe zapytanie nic nie dało
  if (!city.pois.length) {
    try {
      const prev = JSON.parse(readFileSync(join(OUT_DIR, 'osm-city.json'), 'utf8')) as BakedCity;
      if (prev.pois?.length) city.pois = prev.pois;
    } catch { /* ignore */ }
  }
  log(`OSM → graf: ${city.nodes.length} węzłów, ${city.roads.length} odcinków, ${city.buildings.length} budynków, ${city.polygons.length} poligonów`);

  log('=== 2/5 ZTP Kraków – GTFS statyczny ===');
  const allStops = new Map<string, { id: string; name: string; lat: number; lon: number; x: number; z: number }>();
  const allRoutes = new Map<string, { ref: string; kind: 'tram' | 'bus'; operator: string }>();
  const allTrips = new Map<string, { route: string; dir: number; shape: string }>();
  const shapeList: [number, number][][] = [];
  const shapeKey = new Map<string, number>();
  for (const feed of FEEDS) {
    const g = await loadGtfs(feed);
    for (const [k, v] of g.stops) if (!allStops.has(k)) allStops.set(k, v);
    for (const [k, v] of g.routes) if (!allRoutes.has(k)) allRoutes.set(k, v);
    for (const [k, v] of g.trips) if (!allTrips.has(k)) allTrips.set(k, v);
    for (const [k, v] of g.shapes) {
      if (v.length < 2) continue;
      const key = `${feed}|${k}`;
      shapeKey.set(key, shapeList.length);
      shapeList.push(v);
    }
  }
  log(`Razem: ${allStops.size} przystanków, ${allRoutes.size} linii, ${allTrips.size} kursów, ${shapeList.length} kształtów`);

  log('=== 3/5 Mapowanie tras GTFS na graf dróg OSM ===');
  /** Osobne wyszukiwarki: tramwaje szukają torowisk, autobusy dróg zjazdowych. */
  const findTram = makeEdgeFinder(city.nodes, city.roads, 70, (r) => r.roadClass === 'tram' || r.hasTram);
  const findBus = makeEdgeFinder(city.nodes, city.roads, 70, (r) => r.carAccess || r.roadClass === 'tram');
  const findAny = makeEdgeFinder(city.nodes, city.roads, 70);
  const stopsOut: BakedStop[] = [];
  const stopIdx = new Map<string, number>();
  let skippedShort = 0, skippedStops = 0;
  const routes: BakedTransit['routes'] = [];

  // Dla każdej pary (linia, kierunek) wybieramy kształt z największą liczbą punktów w obszarze.
  const best = new Map<string, { route: string; dir: number; shape: number; len: number }>();
  for (const t of allTrips.values()) {
    const si = shapeKey.get(t.shape);
    if (si === undefined) continue;
    const len = shapeList[si].length;
    const k = `${t.route}#${t.dir}`;
    const cur = best.get(k);
    if (!cur || len > cur.len) best.set(k, { route: t.route, dir: t.dir, shape: si, len });
  }

  const transitEdges = new Set<number>();
  for (const [k, b] of best) {
    const meta = allRoutes.get(b.route);
    if (!meta) continue;
    const pts = shapeList[b.shape];
    const findEdge = meta.kind === 'tram' ? findTram : findBus;
    const nodes: number[] = [];
    let lastEdge = -1;
    for (const [x, z] of pts) {
      const m = findEdge(x, z, 2);
      if (!m || m.dist > 130) continue;
      transitEdges.add(m.edge);
      if (m.edge === lastEdge) continue;
      lastEdge = m.edge;
      const road = city.roads[m.edge];
      const last = nodes.length ? nodes[nodes.length - 1] : -1;
      // Wjeżdżamy w ten koniec odcinka, który jest bliżej – zachowuje geometrię trasy.
      const da = last < 0 ? Infinity : Math.hypot(city.nodes[last].x - city.nodes[road.a].x, city.nodes[last].z - city.nodes[road.a].z);
      const db = last < 0 ? Infinity : Math.hypot(city.nodes[last].x - city.nodes[road.b].x, city.nodes[last].z - city.nodes[road.b].z);
      const enter = da <= db ? road.a : road.b;
      const exit = da <= db ? road.b : road.a;
      if (last < 0) { nodes.push(enter); }
      else if (last !== enter) {
        // Luka w dopasowaniu – domykamy ją najkrótszą ścieżką po grafie dróg.
        const bridge = bridgePath(city, last, enter, 900);
        if (bridge) for (const n of bridge.slice(1)) nodes.push(n);
        else continue;
      }
      nodes.push(exit);
    }
    if (nodes.length < 4) { skippedShort++; continue; }

    // Przystanki w kolejności przejazdu: najbliższy punkt kształtu.
    const ordered = [...allStops.values()]
      .map((s) => {
        let bi = 0, bd = Infinity;
        for (let i = 0; i < pts.length; i++) {
          const d = Math.hypot(pts[i][0] - s.x, pts[i][1] - s.z);
          if (d < bd) { bd = d; bi = i; }
        }
        return { s, bi, bd };
      })
      .filter((o) => o.bd < 130)
      .sort((a, b) => a.bi - b.bi);
    if (ordered.length < 2) { skippedStops++; continue; }

    const stopOrder: number[] = [];
    for (const { s } of ordered) {
      let idx = stopIdx.get(s.id);
      if (idx === undefined) {
        idx = stopsOut.length;
        stopIdx.set(s.id, idx);
        stopsOut.push({ id: s.id, name: s.name, lat: s.lat, lon: s.lon, x: s.x, z: s.z, lines: [], mode: meta.kind });
      }
      if (!stopsOut[idx].lines.includes(meta.ref)) stopsOut[idx].lines.push(meta.ref);
      if (stopsOut[idx].mode !== meta.kind) stopsOut[idx].mode = 'both';
      stopOrder.push(idx);
    }
    const [routeId, dirStr] = k.split('#');
    routes.push({ id: k, ref: meta.ref, kind: meta.kind, operator: meta.operator, dir: parseInt(dirStr, 10), shape: b.shape, nodes, stops: stopOrder });
  }
  routes.sort((a, b) => (a.kind === b.kind ? a.ref.localeCompare(b.ref, 'pl', { numeric: true }) : a.kind === 'tram' ? -1 : 1));
  for (const r of city.roads) r.transit = transitEdges.has(r.id) || r.hasTram;
  log(`  (pominięto: za krótka trasa ${skippedShort}, za mało przystanków ${skippedStops})`);
  log(`Linie po mapowaniu: ${routes.length} (tramwajowych ${routes.filter((r) => r.kind === 'tram').length}, autobusowych ${routes.filter((r) => r.kind === 'bus').length}), przystanków ${stopsOut.length}, odcinków z komunikacją ${transitEdges.size}`);

  const routeIdxByKey = new Map(routes.map((r, i) => [r.id, i]));
  const tripsOut: Record<string, string> = {};
  for (const [tripId, t] of allTrips) {
    const rid = routeIdxByKey.get(`${t.route}#${t.dir}`);
    const si = shapeKey.get(t.shape);
    if (rid === undefined || si === undefined) continue;
    tripsOut[tripId] = `${rid},${t.dir},${si}`;
  }
  log(`Kursy przypięte do linii: ${Object.keys(tripsOut).length}`);

  for (const s of stopsOut) {
    const m = findAny(s.x, s.z, 1);
    s.roadId = m && m.dist < 130 ? m.edge : undefined;
  }

  log('=== 4/5 ZTP Kraków – GTFS-RT (realne pozycje pojazdów) ===');
  const { vehicles, headerTs } = await fetchLiveVehicles(
    new Map([...allTrips].map(([k, v]) => [k, { route: v.route, dir: v.dir }])),
    new Map([...allRoutes].map(([k, v]) => [k, { ref: v.ref }])),
  );
  log(`Realnych pojazdów w obszarze symulacji: ${vehicles.length}`);

  // Ruch: OBSERVED = poziom zakrzepienia z GTFS-RT, PREDICTED = intensywność z liczby realnych pojazdów.
  const traffic: BakedTraffic = {
    generatedAt: new Date((headerTs ?? Date.now() / 1000) * 1000).toISOString(),
    level: {}, speed: {}, congestion: {}, sampleSize: vehicles.length,
  };
  const count: Record<number, number> = {};
  const spd: Record<number, { sum: number; n: number }> = {};
  for (const v of vehicles) {
    const m = findAny(v.x, v.z, 1);
    if (!m || m.dist > 80) continue;
    count[m.edge] = (count[m.edge] ?? 0) + 1;
    if (v.congestionLevel !== undefined && v.congestionLevel > 0) {
      traffic.congestion[m.edge] = Math.max(traffic.congestion[m.edge] ?? 0, v.congestionLevel);
    }
    // OBSERVED: prędkość zgłoszona przez operatora (pole 5 w Position).
    if (v.speed !== undefined && v.speed > 0.5) {
      const e = spd[r_of(m.edge)] ?? { sum: 0, n: 0 };
      e.sum += v.speed; e.n++;
      spd[r_of(m.edge)] = e;
    }
  }
  function r_of(edgeId: number) { return edgeId; }
  for (const r of city.roads) {
    const c = count[r.id];
    if (!c) continue;
    const load = Math.min(1, c / (r.lanesForward * 5));
    traffic.level[r.id] = round(load);
  }
  // Prędkość: jeśli operator ją podaje – używamy OBSERVED, inaczej wyliczamy z obciążenia.
  for (const [edgeId, agg] of Object.entries(spd)) {
    const r = city.roads[Number(edgeId)];
    if (r) traffic.speed[Number(edgeId)] = round(agg.sum / agg.n);
  }
  for (const r of city.roads) {
    if (traffic.speed[r.id] !== undefined) continue;
    const c = count[r.id];
    if (!c) continue;
    traffic.speed[r.id] = round(r.speedLimit * (1 - 0.45 * Math.min(1, c / (r.lanesForward * 5))));
  }

  log('=== 5/5 Open-Meteo – pogoda i jakość powietrza ===');
  const env: BakedEnvironment = { generatedAt: nowIso() };
  try {
    const w = await fetchJson<{ current?: Record<string, number | string> }>(
      `${ENDPOINTS.openMeteo}?latitude=${ORIGIN.lat}&longitude=${ORIGIN.lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=Europe%2FWarsaw`);
    env.weather = { ...(w.current ?? {}), fetchedAt: nowIso() };
  } catch (e) { log('  ! pogoda niedostępna:', String(e)); }
  try {
    const a = await fetchJson<{ current?: Record<string, number | string> }>(
      `${ENDPOINTS.openMeteoAir}?latitude=${ORIGIN.lat}&longitude=${ORIGIN.lon}` +
      `&current=european_aqi,pm10,pm2_5,nitrogen_dioxide,sulphur_dioxide,ozone&timezone=Europe%2FWarsaw`);
    env.airQuality = { ...(a.current ?? {}), fetchedAt: nowIso() };
  } catch (e) { log('  ! jakość powietrza niedostępna:', String(e)); }

  /* --------------------------------------------- teren: wysokości z DEM */
  log('=== 6/6 Teren – wysokości z Open-Meteo (Copernicus DEM) ===');
  const terrain = await fetchTerrain();
  log(`  siatka ${terrain.cols}×${terrain.rows}, zakres ${Math.min(...terrain.heights)}–${Math.max(...terrain.heights)} m n.p.m.`);

  /* -------------------------------------------------------------- zapis */
  write('osm-city.json', city);
  write('transit.json', { generatedAt: nowIso(), area: city.area, stops: stopsOut, routes, shapes: shapeList, trips: tripsOut } satisfies BakedTransit);
  write('traffic.json', traffic);
  write('environment.json', env);
  write('vehicles-snapshot.json', { generatedAt: traffic.generatedAt, vehicles });
  write('terrain.json', terrain);

  const manifest: BakedManifest = {
    generatedAt: nowIso(),
    area: city.area,
    sources: [
      { id: 'osm', name: 'OpenStreetMap (Overpass API)', origin: 'OpenStreetMap contributors', url: 'https://overpass-api.de/api/interpreter', license: 'ODbL 1.0', kind: 'static', fetchedAt: city.generatedAt, records: city.roads.length },
      { id: 'ztp-gtfs', name: 'ZTP Kraków – GTFS (T/A/M)', origin: 'Zarząd Transportu Publicznego w Krakowie', url: 'https://gtfs.ztp.krakow.pl/', license: 'Dane ZTP Kraków', kind: 'static', fetchedAt: nowIso(), records: routes.length },
      { id: 'ztp-rt', name: 'ZTP Kraków – GTFS-RT VehiclePositions', origin: 'Zarząd Transportu Publicznego w Krakowie', url: 'https://gtfs.ztp.krakow.pl/VehiclePositions_T.pb', license: 'Dane ZTP Kraków', kind: 'live', fetchedAt: traffic.generatedAt, records: vehicles.length },
      { id: 'open-meteo', name: 'Open-Meteo – pogoda', origin: 'Open-Meteo (model prognozowy)', url: 'https://open-meteo.com/', license: 'CC BY 4.0', kind: 'live', fetchedAt: env.generatedAt },
      { id: 'open-meteo-air', name: 'Open-Meteo Air Quality (CAMS)', origin: 'Copernicus CAMS – model, nie stacja pomiarowa', url: 'https://open-meteo.com/en/docs/air-quality-api', license: 'CC BY 4.0', kind: 'live', fetchedAt: env.generatedAt },
    ],
    counts: {
      nodes: city.nodes.length, roads: city.roads.length, buildings: city.buildings.length,
      polygons: city.polygons.length, signals: city.signals.length, pois: city.pois.length,
      stops: stopsOut.length, routes: routes.length, shapes: shapeList.length,
      trips: Object.keys(tripsOut).length, liveVehicles: vehicles.length,
    },
    files: { city: 'osm-city.json', transit: 'transit.json', traffic: 'traffic.json', environment: 'environment.json', vehicles: 'vehicles-snapshot.json', terrain: 'terrain.json' },
    notes: [
      'Ruch drogowy: Kraków nie publikuje otwartego API z natężeniem ruchu na ulicach miejskich. Publicznym, aktualnym sygnałem jest GTFS-RT ZTP (poziom zakrzepienia + realne pozycje pojazdów) – to on zasila baseline ruchu.',
      'Jakość powietrza pochodzi z modelu CAMS (Open-Meteo), a nie ze stacji GIOŚ/WIOŚ – publiczne API GIOŚ wymaga klucza (api.gios.gov.pl).',
      'Wysokości budynków: tag OSM height / building:levels, w razie braku wartość domyślna dla typu budynku.',
    ],
  };
  write('manifest.json', manifest);
  log(`gotowe w ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

/**
 * Scala kolejno połączone odcinki tej samej ulicy (ta sama nazwa i klasa),
 * niemal prostoliniowe, w jeden odcinek. Wynik wygląda jak normalna sieć
 * drogowa i jest znacznie szybszy w symulacji.
 */
function mergeCollinear(nodes: BakedNode[], roads: BakedRoad[]): BakedRoad[] {
  const sameWay = (x: BakedRoad, y: BakedRoad) => x.name === y.name && x.roadClass === y.roadClass;
  const dead = new Set<number>();
  const at = new Map<number, number[]>();
  for (let i = 0; i < roads.length; i++) {
    for (const n of [roads[i].a, roads[i].b]) {
      const arr = at.get(n);
      if (arr) arr.push(i); else at.set(n, [i]);
    }
  }

  /**
   * Wydłuża odcinek wzdłuż ulicy. Łączymy TYLKO wtedy, gdy węzeł ma dokładnie
   * dwa odcinki, czyli jest zwykłym przegięciem tej samej ulicy. Gdy na węźle
   * rozgałęzia się inna ulica, sklejenie zamknęłoby ją w środku odcinka
   * i odcięło od sieci – dlatego takich węzłów nie ruszamy.
   */
  const extend = (head: number, tail: number, cameFrom: number) => {
    let h = head, t = tail, from = cameFrom;
    for (let guard = 0; guard < 300; guard++) {
      const all = at.get(t) ?? [];
      if (all.length !== 2 || !all.includes(from)) break;
      const next = all.find((j) => j !== from)!;
      if (dead.has(next)) break;
      const nr = roads[next];
      if (!sameWay(nr, roads[from])) break;
      const far = nr.a === t ? nr.b : nr.a;
      if (far === h) break;
      const v1x = nodes[t].x - nodes[h].x, v1z = nodes[t].z - nodes[h].z;
      const v2x = nodes[far].x - nodes[t].x, v2z = nodes[far].z - nodes[t].z;
      const l1 = Math.hypot(v1x, v1z), l2 = Math.hypot(v2x, v2z);
      if (!l1 || !l2) break;
      // Zakręt: nie prostujemy ulicy, bo przesunęłoby to realną geometrię.
      if ((v1x * v2x + v1z * v2z) / (l1 * l2) < 0.9) break;
      if (l1 + l2 > 200) break;
      dead.add(next);
      from = next;
      t = far;
    }
    return { head: h, tail: t };
  };

  const out: BakedRoad[] = [];
  for (let i = 0; i < roads.length; i++) {
    if (dead.has(i)) continue;
    const r0 = roads[i];
    dead.add(i);
    const fwd = extend(r0.a, r0.b, i);
    const bwd = extend(r0.b, r0.a, i);
    out.push({ ...r0, a: bwd.tail, b: fwd.tail });
  }
  return out;
}

/** Kopiec binarny – Dijkstra po wypieczonym grafie (używana przy-mostkowaniu luk). */
class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.v.length; }
  clear() { this.k.length = 0; this.v.length = 0; }
  push(key: number, val: number) {
    this.k.push(key); this.v.push(val);
    let i = this.v.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p] <= this.k[i]) break;
      [this.k[p], this.k[i]] = [this.k[i], this.k[p]];
      [this.v[p], this.v[i]] = [this.v[i], this.v[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.v[0];
    const lk = this.k.pop()!, lv = this.v.pop()!;
    if (this.v.length) {
      this.k[0] = lk; this.v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.k.length && this.k[l] < this.k[m]) m = l;
        if (r < this.k.length && this.k[r] < this.k[m]) m = r;
        if (m === i) break;
        [this.k[m], this.k[i]] = [this.k[i], this.k[m]];
        [this.v[m], this.v[i]] = [this.v[i], this.v[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Najkrótsza ścieżka w grafie dróg – służy do domykania luk w dopasowaniu trasy
 * do OSM (np. gdy fragment kształtu GTFS wypadł z obszaru albo nie znalazł drogi).
 * Trasy mają być ciągłą sekwencją węzłów, po której da się jechać symulacją.
 */
function bridgePath(city: BakedCity, from: number, to: number, maxCost: number): number[] | null {
  if (from === to) return [to];
  const n = city.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new Heap();
  dist[from] = 0; heap.push(0, from);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === to) break;
    for (const r of city.roads) {
      if (r.a !== u && r.b !== u) continue;
      const other = r.a === u ? r.b : r.a;
      const len = Math.hypot(
        city.nodes[r.b].x - city.nodes[r.a].x,
        city.nodes[r.b].z - city.nodes[r.a].z,
      ) || 1;
      const cost = len / Math.max(2, r.speedLimit) + (r.carAccess || r.roadClass === 'tram' ? 0 : 1.5);
      const nd = dist[u] + cost;
      if (nd < dist[other] - 1e-9) { dist[other] = nd; prev[other] = u; heap.push(nd, other); }
    }
  }
  if (!isFinite(dist[to]) || dist[to] > maxCost) return null;
  const out: number[] = [];
  for (let v = to; v !== from; v = prev[v]) {
    if (v < 0) return null;
    out.push(v);
  }
  out.push(from);
  return out.reverse();
}

/** Indeks odcinka łączącego dwa węzły grafu. */
function edgeBetweenNodes(city: BakedCity, a: number, b: number): number | undefined {
  for (const r of city.roads) {
    if ((r.a === a && r.b === b) || (r.b === a && r.a === b)) return r.id;
  }
  return undefined;
}



main().catch((e) => { console.error('ingest nieudany:', e); process.exit(1); });
