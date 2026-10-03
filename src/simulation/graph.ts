/**
 * Graf dróg zrealizowany w całości na podstawie OpenStreetMap + GTFS ZTP.
 * Symulacja korzysta wyłącznie z tego grafu – nie ma tu żadnych wymyślonych ulic.
 */

export interface GraphEdge {
  id: number;
  name: string;
  roadClass: string;
  a: number;
  b: number;
  ax: number; az: number;
  bx: number; bz: number;
  hx: number; hz: number;
  len: number;
  speedLimit: number;
  /** Przepustowość [pojazdów / 15 min]. */
  capacity: number;
  lanesForward: number;
  oneway: boolean;
  carAccess: boolean;
  /** Czy kursuje tu komunikacja MPK (z mapowania kształtów GTFS). */
  transit: boolean;
  hasTram: boolean;
  osmId: number;
  /** Węzeł -> lista krawędzi (obie strony). */
  at: number[];
}

export interface RoadGraph {
  nodes: { x: number; z: number }[];
  edges: GraphEdge[];
  /** Sąsiedztwo: node -> { edge, to }. */
  adj: { e: number; to: number }[][];
  /** Współczynnik prędkości wg BPR – im większe obciążenie, tym wolniej. */
  jamFactor: number;
}

export function buildGraph(
  nodes: { x: number; z: number }[],
  roads: {
    id: number; a: number; b: number; name: string; roadClass: string; speedLimit: number;
    capacity: number; lanesForward: number; oneway: boolean; carAccess: boolean;
    transit: boolean; hasTram: boolean; osmId: number;
  }[],
  opts: { dwellAtStops?: boolean } = {},
): RoadGraph {
  const edges: GraphEdge[] = roads.map((r) => {
    const A = nodes[r.a], B = nodes[r.b];
    const len = Math.max(1e-3, Math.hypot(B.x - A.x, B.z - A.z));
    return {
      id: r.id,
      name: r.name,
      roadClass: r.roadClass,
      a: r.a, b: r.b,
      ax: A.x, az: A.z, bx: B.x, bz: B.z,
      hx: (B.x - A.x) / len, hz: (B.z - A.z) / len,
      len,
      speedLimit: r.speedLimit,
      capacity: r.capacity,
      lanesForward: r.lanesForward,
      oneway: r.oneway,
      carAccess: r.carAccess,
      transit: r.transit,
      hasTram: r.hasTram,
      osmId: r.osmId,
      at: [r.a, r.b],
    };
  });
  const adj: { e: number; to: number }[][] = nodes.map(() => []);
  for (const e of edges) {
    adj[e.a].push({ e: e.id, to: e.b });
    adj[e.b].push({ e: e.id, to: e.a });
  }
  void opts;
  return { nodes, edges, adj, jamFactor: 0.85 };
}

/** Czas przejazdu odcinka w sekundach przy danym obciążeniu (BPR). */
export function travelTime(e: GraphEdge, load: number): number {
  const freeFlow = e.len / Math.max(1, e.speedLimit);
  const cap = Math.max(1, e.capacity);
  return freeFlow * (1 + 0.85 * Math.pow(Math.min(1.6, load / cap), 2.4));
}

/**
 * Tablica kosztów przejazdu liczona RAZ na krok symulacji.
 * Wewnątrz Dijkstry używamy już samego dodawania – bez Math.pow na każdym
 * rozważeniu krawędzi, co było głównym kosztem routingu.
 */
export function edgeCosts(g: RoadGraph, load: Float32Array): Float32Array {
  const out = new Float32Array(g.edges.length);
  for (let i = 0; i < g.edges.length; i++) {
    const e = g.edges[i];
    const freeFlow = e.len / Math.max(1, e.speedLimit);
    if (e.capacity <= 0 || load[i] <= 0) { out[i] = freeFlow; continue; }
    out[i] = freeFlow * (1 + 0.85 * Math.pow(Math.min(1.6, load[i] / e.capacity), 2.4));
  }
  return out;
}

/** Kopiec binarny na indeksach węzłów – podstawa szybkiego Dijkstry. */
export class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() { return this.vals.length; }
  clear() { this.keys.length = 0; this.vals.length = 0; }
  push(key: number, val: number) {
    this.keys.push(key); this.vals.push(val);
    let i = this.vals.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      [this.keys[p], this.keys[i]] = [this.keys[i], this.keys[p]];
      [this.vals[p], this.vals[i]] = [this.vals[i], this.vals[p]];
      i = p;
    }
  }
  pop(): number {
    const top = this.vals[0];
    const lk = this.keys.pop()!, lv = this.vals.pop()!;
    if (this.vals.length) {
      this.keys[0] = lk; this.vals[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        [this.keys[m], this.keys[i]] = [this.keys[i], this.keys[m]];
        [this.vals[m], this.vals[i]] = [this.vals[i], this.vals[m]];
        i = m;
      }
    }
    return top;
  }
}

export interface PathResult {
  /** Lista węzłów od src do dst (bez src). */
  nodes: number[];
  /** Lista odcinków od src do dst. */
  edges: number[];
  cost: number;
}

/**
 * Dijkstra od jednego źródła. `blocked` i `extraCost` pozwalają uwzględnić
 * zamknięcia gracza oraz aktualne korki, bez ruszania danych bazowych.
 */
export function shortestPath(
  g: RoadGraph,
  src: number,
  dst: number,
  blocked: (edge: number) => boolean,
  costs: Float32Array,
  reuse?: { dist: Float64Array; prev: Float64Array; prevEdge: Float32Array; done: Uint8Array; heap: MinHeap },
): PathResult | null {
  const n = g.nodes.length;
  const st = reuse ?? { dist: new Float64Array(n), prev: new Float64Array(n), prevEdge: new Float32Array(n), done: new Uint8Array(n), heap: new MinHeap() };
  const { dist, prev, prevEdge, done, heap } = st;
  dist.fill(Infinity);
  prev.fill(-1);
  prevEdge.fill(-1);
  done.fill(0);
  heap.clear();
  dist[src] = 0;
  heap.push(0, src);
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === dst) break;
    for (const { e, to } of g.adj[u]) {
      const edge = g.edges[e];
      if (blocked(e) || !edge.carAccess) continue;
      if (edge.oneway && edge.a !== u) continue; // contraflow: do góry pod prąd
      const nd = dist[u] + costs[e];
      if (nd < dist[to]) { dist[to] = nd; prev[to] = u; prevEdge[to] = e; heap.push(nd, to); }
    }
  }
  if (!isFinite(dist[dst])) return null;
  const nodes: number[] = [];
  const edges: number[] = [];
  for (let v = dst; v !== src; v = prev[v]) {
    if (v < 0) return null;
    nodes.push(v);
    edges.push(prevEdge[v]);
  }
  nodes.reverse();
  edges.reverse();
  return { nodes, edges, cost: dist[dst] };
}

/**
 * Drzewo najkrótszych ścieżek z jednego węzła. Zamiast liczyć Dijkstrę osobno
 * dla każdego celu budujemy drzewo raz i z niego wyciągamy dowolne trasy –
 * auto przy wjeździe na skrzyżowanie dostaje komplet tras w jednym przebiegu.
 */
export interface PathTree {
  src: number;
  version: number;
  builtAt: number;
  dist: Float64Array;
  prev: Float64Array;
  prevEdge: Float32Array;
  nodes: number;
  pathTo(dst: number): number[] | null;
  /**
   * Ścieżka z `src` do korzenia drzewa. Koszty dróg są symetryczne, więc drzewo
   * zbudowane od celu daje tę samą trasę co od punktu startowego – dzięki temu
   * wystarczy kilkadziesiąt drzew zamiast jednego na każde skrzyżowanie.
   */
  pathToRoot(src: number): number[] | null;
}

const treeHeap = () => new MinHeap();

/** Buduje pełne drzewo najkrótszych ścieżek (bez wczesnego przerwania). */
export function buildTree(
  g: RoadGraph, src: number,
  blocked: (e: number) => boolean, costs: Float32Array,
  version: number,
  scratch?: { dist: Float64Array; prev: Float64Array; prevEdge: Float32Array; done: Uint8Array; heap: MinHeap },
): PathTree {
  const n = g.nodes.length;
  const st = scratch ?? {
    dist: new Float64Array(n), prev: new Float64Array(n),
    prevEdge: new Float32Array(n), done: new Uint8Array(n), heap: treeHeap(),
  };
  const { dist, prev, prevEdge, done, heap } = st;
  dist.fill(Infinity); prev.fill(-1); prevEdge.fill(-1); done.fill(0); heap.clear();
  dist[src] = 0;
  heap.push(0, src);
  let reached = 0;
  while (heap.size) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    reached++;
    for (const { e, to } of g.adj[u]) {
      const edge = g.edges[e];
      if (blocked(e) || !edge.carAccess) continue;
      if (edge.oneway && edge.a !== u) continue;
      const nd = dist[u] + costs[e];
      if (nd < dist[to]) { dist[to] = nd; prev[to] = u; prevEdge[to] = e; heap.push(nd, to); }
    }
  }
  return {
    src, version, builtAt: performance.now(), dist, prev, prevEdge, nodes: reached,
    pathTo(dst: number) {
      if (dst === src) return [];
      if (!isFinite(dist[dst])) return null;
      const out: number[] = [];
      for (let v = dst; v !== src; v = prev[v]) {
        if (v < 0) return null;
        out.push(prevEdge[v]);
      }
      return out.reverse();
    },
    pathToRoot(from: number) {
      if (from === src) return [];
      if (!isFinite(dist[from])) return null;
      const out: number[] = [];
      let v = from;
      for (let guard = 0; guard < 100000; guard++) {
        const p = prev[v];
        if (p < 0) return null;
        out.push(prevEdge[v]);
        if (p === src) return out;
        v = p;
      }
      return null;
    },
  };
}

/** Mały cache drzew: jeden przebieg Dijkstry obsługuje wiele aut naraz. */
export class TreeCache {
  private map = new Map<number, PathTree>();
  constructor(private size = 24, private ttlMs = 25_000) {}
  clear() { this.map.clear(); }
  get(g: RoadGraph, src: number, blocked: (e: number) => boolean, costs: Float32Array, version: number): PathTree {
    const hit = this.map.get(src);
    const now = performance.now();
    if (hit && hit.version === version && now - hit.builtAt < this.ttlMs) return hit;
    const tree = buildTree(g, src, blocked, costs, version);
    if (this.map.size >= this.size) {
      // usuwamy najstarsze
      let oldest = -1, t = Infinity;
      for (const [k, v] of this.map) if (v.builtAt < t) { t = v.builtAt; oldest = k; }
      if (oldest >= 0) this.map.delete(oldest);
    }
    this.map.set(src, tree);
    return tree;
  }
}

/** Najbliższy węzeł grafu dla punktu w metrach lokalnych. */
export function nearestNode(g: RoadGraph, x: number, z: number, filter?: (e: GraphEdge) => boolean): number {
  let best = -1, bestD = Infinity;
  for (const e of g.edges) {
    if (filter && !filter(e)) continue;
    const t = Math.max(0, Math.min(1, ((x - e.ax) * e.hx + (z - e.az) * e.hz) * e.len) / (e.len * e.len));
    const px = e.ax + e.hx * t * e.len, pz = e.az + e.hz * t * e.len;
    const d = Math.hypot(x - px, z - pz);
    if (d < bestD) { bestD = d; best = t < 0.5 ? e.a : e.b; }
  }
  return best < 0 ? 0 : best;
}

export function distToRoads(g: RoadGraph, x: number, z: number): number {
  let best = Infinity;
  for (const e of g.edges) {
    const t = Math.max(0, Math.min(1, ((x - e.ax) * e.hx + (z - e.az) * e.hz) * e.len) / (e.len * e.len));
    best = Math.min(best, Math.hypot(x - (e.ax + e.hx * t * e.len), z - (e.az + e.hz * t * e.len)));
  }
  return best;
}