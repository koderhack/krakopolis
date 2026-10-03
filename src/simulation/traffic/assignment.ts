/**
 * Predykcja rozkładu ruchu po zmianach gracza (PREDICTED).
 *
 * Baseline (OBSERVED / PREDICTED z danych ZTP + OSM) nigdy nie jest nadpisywany.
 * Trzymamy równolegle:
 *   baselineState  – stan z prawdziwych danych,
 *   playerChanges  – zamknięcia, strefy piesze, nowe przystanki,
 *   simulatedFuture– wynik przypisania ruchu na grafie z uwzględnieniem zmian.
 *
 * Metoda: incremental assignment (All-or-Nothing z korektą obciążenia, funkcja
 * BPR). Nie jest to pełny model macierzy powiązań, ale daje spójny i jawny
 * wynik: po zamknięciu ulicy ruch przenosi się na realne objazdy w grafie.
 *
 * Przypisanie jest przyrostowe – w jednym kroku przetwarzamy kilka źródeł,
 * żeby nie blokować pętli renderowania.
 */
import { MinHeap, edgeCosts, travelTime, type RoadGraph } from '../graph';

export interface OdPair { from: number; to: number }

export interface AssignmentResult {
  /** Obciążenie odcinka [pojazdy / 15 min] w scenariuszu gracza. */
  load: Float32Array;
  /** Znormalizowany poziom 0..1 (load / capacity). */
  level: Float32Array;
  /** Czas przejazdu odcinka w scenariuszu [s]. */
  travelTime: Float32Array;
  /** Liczba wykonanych iteracji. */
  iterations: number;
  /** Pary OD bez połączenia po zamknięciach. */
  unreachable: number;
  /** Ile par OD uwzględniono w ostatnim pełnym przebiegu. */
  pairs: number;
}

const ORIGINS = 22;
const TRIPS_PER_ORIGIN = 7;

export class TrafficAssignment {
  private byOrigin = new Map<number, OdPair[]>();
  private originList: number[] = [];
  private load = new Float32Array(0);
  private scratch = { dist: new Float64Array(0), prev: new Float64Array(0), prevEdge: new Float32Array(0), done: new Uint8Array(0), heap: new MinHeap() };
  private cursor = 0;
  private iterations = 0;
  private unreachable = 0;
  private pairsTotal = 0;
  private costs = new Float32Array(0) as Float32Array;
  /** Ile pojazdów ma symulacja – obciążenie liczymy w tej samej skali. */
  private target = 600;

  result: AssignmentResult = {
    load: new Float32Array(), level: new Float32Array(), travelTime: new Float32Array(),
    iterations: 0, unreachable: 0, pairs: 0,
  };

  /**
   * `pool` to węzły SPÓJNEJ składowej sieci zjazdowej. Bez tego losowe pary
   * źródło–cel trafiają w odizolowane kawałki sieci i prawie każda para jest
   * nieosiągalna, więc przypisanie ruchu nic nie zwraca.
   */
  constructor(private g: RoadGraph, private blocked: () => (e: number) => boolean, pool: number[] = [], seed = 1337) {
    const n = g.nodes.length;
    this.scratch = {
      dist: new Float64Array(n), prev: new Float64Array(n),
      prevEdge: new Float32Array(n), done: new Uint8Array(n), heap: new MinHeap(),
    };
    this.load = new Float32Array(g.edges.length);
    this.seedOd(seed, pool);
  }

  /** Pary źródło–cel na realnych węzłach dróg przejezdnych dla aut. */
  private seedOd(seed: number, pool: number[]) {
    const rnd = mulberry32(seed);
    const carNodes = pool.filter((n) => n >= 0 && n < this.g.nodes.length && this.g.nodes[n]);
    if (carNodes.length < 4) return;
    const used = new Set<number>();
    const wantedOrigins = Math.min(40, Math.max(6, Math.floor(carNodes.length / 12)));
    while (this.originList.length < wantedOrigins) {
      const n = carNodes[Math.floor(rnd() * carNodes.length)];
      if (used.has(n)) continue;
      used.add(n);
      this.originList.push(n);
    }
    for (const from of this.originList) {
      const pairs: OdPair[] = [];
      const seen = new Set<number>([from]);
      for (let k = 0; k < TRIPS_PER_ORIGIN; k++) {
        const to = carNodes[Math.floor(rnd() * carNodes.length)];
        if (seen.has(to)) continue;
        seen.add(to);
        pairs.push({ from, to });
      }
      this.byOrigin.set(from, pairs);
      this.pairsTotal += pairs.length;
    }
  }

  get origins() { return this.originList.length; }

  setTarget(n: number) { this.target = Math.max(20, n); }

  /** Przetwarza `count` źródeł i aktualizuje wynik. Wołane co klatkę symulacji. */
  advance(count = 2): AssignmentResult {
    const m = this.g.edges.length;
    const blocked = this.blocked();
    const step = new Float32Array(m);
    this.costs = edgeCosts(this.g, this.load);
    let touched = 0;

    for (let k = 0; k < count; k++) {
      const from = this.originList[this.cursor % Math.max(1, this.originList.length)];
      if (from === undefined) break;
      this.cursor++;
      const pairs = this.byOrigin.get(from) ?? [];
      const tree = singleSourceTree(this.g, from, blocked, this.load, this.scratch, this.costs);
      for (const p of pairs) {
        const path = tree.pathTo(p.to);
        if (!path) { this.unreachable++; continue; }
        for (const e of path) step[e] += 1;
        touched++;
      }
    }
    if (!touched) return this.result;

    // Jedna jednostka „przejścia trasy" odpowiada 1/nTargets pojazdu w symulacji,
    // dzięki czemu load ma tę samą skalę co liczba agentów.
    const perTrip = this.target / Math.max(1, this.pairsTotal);
    // Wykładniczo wygładzamy – stabilne wyniki bez oscylacji.
    const alpha = this.iterations === 0 ? 1 : 0.4;
    for (let e = 0; e < m; e++) this.load[e] = this.load[e] * (1 - alpha) + step[e] * perTrip * alpha;
    this.iterations++;

    const level = new Float32Array(m);
    const tt = new Float32Array(m);
    for (let e = 0; e < m; e++) {
      const edge = this.g.edges[e];
      level[e] = edge.capacity > 0 ? Math.min(1.2, this.load[e] / edge.capacity) : 0;
      tt[e] = travelTime(edge, this.load[e]);
    }
    this.result = { load: this.load.slice(), level, travelTime: tt, iterations: this.iterations, unreachable: this.unreachable, pairs: this.pairsTotal };
    return this.result;
  }

  /** Pełne przeliczenie – używane bezpośrednio po akcji gracza. */
  run(): AssignmentResult {
    this.load.fill(0);
    this.iterations = 0;
    this.unreachable = 0;
    this.cursor = 0;
    return this.advance(this.originList.length);
  }
}

interface Tree {
  dist: Float64Array;
  pathTo(dst: number): number[] | null;
}

/** Drzewo najkrótszych ścieżek od jednego źródła (pełne, bez wczesnego przerwania). */
function singleSourceTree(
  g: RoadGraph, src: number,
  blocked: (e: number) => boolean, load: Float32Array,
  scratch: { dist: Float64Array; prev: Float64Array; prevEdge: Float32Array; done: Uint8Array; heap: MinHeap },
  costs: Float32Array,
): Tree {
  const { dist, prev, prevEdge, done, heap } = scratch;
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
    for (const { e, to } of g.adj[u]) {
      const edge = g.edges[e];
      if (blocked(e) || !edge.carAccess) continue;
      if (edge.oneway && edge.a !== u) continue; // contraflow: do góry pod prąd
      const nd = dist[u] + costs[e];
      if (nd < dist[to]) { dist[to] = nd; prev[to] = u; prevEdge[to] = e; heap.push(nd, to); }
    }
  }
  return {
    dist,
    pathTo(dst: number) {
      if (!isFinite(dist[dst])) return null;
      const out: number[] = [];
      for (let v = dst; v !== src; v = prev[v]) {
        if (v < 0) return null;
        out.push(prevEdge[v]);
      }
      return out.reverse();
    },
  };
}

export function mulberry32(a: number): () => number {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}