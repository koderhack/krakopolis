import type { CityData } from '../data/cityData';

export interface Edge {
  id: number; name: string; a: number; b: number; ax: number; az: number; bx: number; bz: number;
  hx: number; hz: number; len: number; speedLimit: number; capacity: number; load: number; trafficLevel: number;
  closed: boolean; pedestrian: boolean; hasStop: boolean; pw: number;
}
export interface Veh { kind: 0 | 1 | 2; ref: string; route: number[]; si: number; edge: number; dir: 1 | -1; s: number; speed: number; dest: number; nodes: number[]; dwell: number; x: number; z: number; yaw: number }
export interface Ped { edge: number; dir: 1 | -1; s: number; speed: number; side: 1 | -1; jit: number; x: number; z: number }
export interface Park { x: number; z: number; r: number }
export interface Stop { edge: number; name: string }
export interface Metrics { traffic: number; transit: number; pedestrians: number; pollution: number; noise: number; satisfaction: number; budget: number }

export const MAX_PEDS = 420;
export const N_CARS = 150;
export const TICK = 0.1; // stały krok symulacji [s]
export const COST = { close: 20, pedestrian: 150, stop: 80, park: 120 };
const clamp = (v: number, a = 0, b = 100) => Math.max(a, Math.min(b, v));

export function distToRoads(edges: Edge[], x: number, z: number) {
  let best = Infinity;
  for (const e of edges) {
    const t = clamp((x - e.ax) * e.hx + (z - e.az) * e.hz, 0, e.len);
    best = Math.min(best, Math.hypot(x - (e.ax + e.hx * t), z - (e.az + e.hz * t)));
  }
  return best;
}

/** Silnik symulacji niezależny od renderowania i Reacta. Kolejność kroku: pojazdy, obciążenie dróg, komunikacja, piesi, metryki. */
export class Sim {
  edges: Edge[] = [];
  adj: { e: number; to: number }[][] = [];
  eid = new Map<number, number>();
  veh: Veh[] = [];
  peds: Ped[] = [];
  parks: Park[] = [];
  stops: Stop[] = [];
  activePeds = 140;
  time = 0;
  version = 0;
  m: Metrics = { traffic: 0, transit: 0, pedestrians: 0, pollution: 0, noise: 0, satisfaction: 60, budget: 1000 };
  private acc = 0;
  private tickN = 0;
  private seed = 20261003;

  constructor(public data: CityData) {
    const N = data.nodes;
    this.adj = N.map(() => []);
    for (const d of data.edges) {
      const A = N[d.a], B = N[d.b];
      const len = Math.hypot(B.x - A.x, B.z - A.z);
      this.edges.push({ id: d.id, name: d.name, a: d.a, b: d.b, ax: A.x, az: A.z, bx: B.x, bz: B.z, hx: (B.x - A.x) / len, hz: (B.z - A.z) / len, len, speedLimit: d.speedLimit, capacity: Math.max(3, Math.round(len / 14)), load: 0, trafficLevel: 0, closed: false, pedestrian: d.pedestrian, hasStop: false, pw: 1 });
      this.adj[d.a].push({ e: d.id, to: d.b });
      this.adj[d.b].push({ e: d.id, to: d.a });
      this.eid.set(d.a * 64 + d.b, d.id);
      this.eid.set(d.b * 64 + d.a, d.id);
    }
    for (const s of data.stops) { this.edges[s.edge].hasStop = true; this.stops.push({ ...s }); }
    this.reweight();
    for (let i = 0; i < N_CARS; i++) { const v = this.newVeh(0, '', []); this.respawn(v); this.veh.push(v); }
    for (const r of data.routes) {
      for (let i = 0; i < r.count; i++) {
        const v = this.newVeh(r.kind === 'tram' ? 2 : 1, r.ref, r.nodes);
        const idx = (i * Math.floor(r.nodes.length / r.count)) % r.nodes.length;
        v.si = (idx + 1) % r.nodes.length;
        this.arrive(v, r.nodes[idx], 0);
        this.veh.push(v);
      }
    }
    for (let i = 0; i < MAX_PEDS; i++) {
      const p: Ped = { edge: 0, dir: 1, s: 0, speed: 1.1 + this.rnd() * 0.5, side: this.rnd() < 0.5 ? 1 : -1, jit: this.rnd() * 2 - 1, x: 0, z: 0 };
      this.placePed(p, this.pickPedEdge());
      this.peds.push(p);
    }
    for (let i = 0; i < 100; i++) this.step(TICK);
    this.metrics();
    this.time = 0;
  }

  private rnd() { // mulberry32: powtarzalna symulacja
    let t = (this.seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  private newVeh(kind: 0 | 1 | 2, ref: string, route: number[]): Veh {
    return { kind, ref, route, si: 0, edge: 0, dir: 1, s: 0, speed: 0, dest: -1, nodes: [], dwell: 0, x: 0, z: 0, yaw: 0 };
  }

  advance(dt: number) {
    this.acc = Math.min(this.acc + dt, 0.5);
    while (this.acc >= TICK) { this.step(TICK); this.acc -= TICK; }
  }

  step(dt: number) {
    this.time += dt;
    this.tickN++;
    for (const v of this.veh) this.move(v, dt); // 1-2. ruch aut, komunikacja miejska
    for (const e of this.edges) e.load = 0;
    for (const v of this.veh) if (v.kind !== 2) this.edges[v.edge].load += v.kind === 1 ? 2 : 1;
    for (const e of this.edges) e.trafficLevel += (Math.min(1.5, e.load / e.capacity) - e.trafficLevel) * 0.12; // 5. korki
    for (let i = this.tickN % 12; i < this.veh.length; i += 12) { // okresowe przeliczanie tras pod aktualne korki
      const v = this.veh[i];
      if (v.kind === 2 || !v.nodes.length) continue;
      const e = this.edges[v.edge];
      const p = this.path(v.dir > 0 ? e.b : e.a, v.dest, v.kind);
      if (p) v.nodes = p;
    }
    for (let i = 0; i < Math.round(this.activePeds); i++) this.movePed(this.peds[i], dt); // 4. piesi
    if (this.tickN % 10 === 0) this.metrics(); // 6-8. hałas, smog, statystyki
  }

  // ---------- trasowanie ----------
  private cost(e: Edge, kind: number) {
    if (kind === 2) return e.len / 9; // tramwaje jeżdżą po torach, zamknięcie ulicy ich nie dotyczy
    if (e.closed || e.pedestrian) return Infinity;
    return e.len / (e.speedLimit * Math.max(0.12, 1 - 0.88 * Math.pow(Math.min(1, e.trafficLevel), 1.5)));
  }
  private path(src: number, dst: number, kind: number): number[] | null {
    const n = this.data.nodes.length;
    const dist = new Array<number>(n).fill(Infinity), prev = new Array<number>(n).fill(-1), done = new Array<boolean>(n).fill(false);
    dist[src] = 0;
    for (;;) {
      let u = -1, b = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < b) { b = dist[i]; u = i; }
      if (u < 0 || u === dst) break;
      done[u] = true;
      for (const { e, to } of this.adj[u]) {
        const c = this.cost(this.edges[e], kind);
        if (c !== Infinity && dist[u] + c < dist[to]) { dist[to] = dist[u] + c; prev[to] = u; }
      }
    }
    if (dist[dst] === Infinity) return null;
    const out: number[] = [];
    for (let v = dst; v !== src; v = prev[v]) out.push(v);
    return out.reverse();
  }
  private blocked(a: number, b: number, kind: number) {
    return this.cost(this.edges[this.eid.get(a * 64 + b)!], kind) === Infinity;
  }
  private pickDest(v: Veh, from: number): boolean {
    if (v.kind === 0) {
      for (let i = 0; i < 10; i++) {
        const d = Math.floor(this.rnd() * this.data.nodes.length);
        if (d === from) continue;
        const p = this.path(from, d, 0);
        if (p) { v.dest = d; v.nodes = p; return true; }
      }
      this.respawn(v);
      return false;
    }
    for (let i = 0; i < v.route.length; i++) {
      const d = v.route[v.si];
      v.si = (v.si + 1) % v.route.length;
      if (d === from) continue;
      const p = this.path(from, d, v.kind) ?? this.path(from, d, 2);
      if (p) { v.dest = d; v.nodes = p; return true; }
    }
    this.respawn(v);
    return false;
  }
  private respawn(v: Veh) {
    let id = 0;
    for (let i = 0; i < 50; i++) { id = Math.floor(this.rnd() * this.edges.length); const e = this.edges[id]; if (!e.closed && !e.pedestrian) break; }
    const e = this.edges[id];
    v.edge = id; v.dir = this.rnd() < 0.5 ? 1 : -1; v.s = this.rnd() * e.len; v.nodes = []; v.speed = e.speedLimit * 0.5;
  }
  private arrive(v: Veh, node: number, over: number) {
    if (v.nodes.length && this.blocked(node, v.nodes[0], v.kind)) v.nodes = this.path(node, v.dest, v.kind) ?? []; // droga zamknięta: objazd
    if (!v.nodes.length && !this.pickDest(v, node)) return;
    const nx = v.nodes.shift()!;
    const id = this.eid.get(node * 64 + nx)!;
    v.edge = id; v.dir = this.edges[id].a === node ? 1 : -1; v.s = over;
  }
  private move(v: Veh, dt: number) {
    const e = this.edges[v.edge];
    if (v.dwell > 0) { v.dwell -= dt; v.speed = 0; }
    else {
      let t = v.kind === 2 ? 9 : e.speedLimit * Math.max(0.12, 1 - 0.88 * Math.pow(Math.min(1, e.trafficLevel), 1.5));
      if (v.kind === 1) t *= 0.85;
      v.speed += (t - v.speed) * Math.min(1, dt * 1.5);
      const before = v.s;
      v.s += v.speed * dt;
      if (v.kind && e.hasStop && before < e.len / 2 && v.s >= e.len / 2) v.dwell = 4; // postój na przystanku
      if (v.s >= e.len) this.arrive(v, v.dir > 0 ? e.b : e.a, v.s - e.len);
    }
    const c = this.edges[v.edge];
    const t = v.dir > 0 ? v.s : c.len - v.s;
    const hx = c.hx * v.dir, hz = c.hz * v.dir, off = v.kind === 2 ? 0 : 2.2;
    v.x = c.ax + c.hx * t - hz * off;
    v.z = c.az + c.hz * t + hx * off;
    v.yaw = Math.atan2(-hz, hx);
  }

  // ---------- piesi ----------
  private reweight() {
    for (const e of this.edges) {
      const mx = (e.ax + e.bx) / 2, mz = (e.az + e.bz) / 2;
      let w = 1 + (e.pedestrian ? 6 : 0) + (e.closed ? 3 : 0) + (e.name === 'Rynek Główny' ? 3 : 0) + (e.hasStop ? 2 : 0);
      for (const p of this.parks) if (Math.hypot(p.x - mx, p.z - mz) < 70) w += 5;
      e.pw = w;
    }
  }
  private pickPedEdge() {
    let tot = 0;
    for (const e of this.edges) tot += e.pw;
    let r = this.rnd() * tot;
    for (const e of this.edges) { r -= e.pw; if (r <= 0) return e.id; }
    return 0;
  }
  private placePed(p: Ped, id: number) {
    p.edge = id; p.dir = this.rnd() < 0.5 ? 1 : -1; p.s = this.rnd() * this.edges[id].len; this.locPed(p);
  }
  private locPed(p: Ped) {
    const e = this.edges[p.edge];
    const t = p.dir > 0 ? p.s : e.len - p.s;
    const off = e.pedestrian || e.closed ? p.jit * 4 : p.side * 6.2;
    p.x = e.ax + e.hx * t - e.hz * off;
    p.z = e.az + e.hz * t + e.hx * off;
  }
  private movePed(p: Ped, dt: number) {
    const e = this.edges[p.edge];
    p.s += p.speed * dt;
    if (p.s >= e.len) {
      const node = p.dir > 0 ? e.b : e.a, opts = this.adj[node];
      const ws = opts.map((o) => (o.e === p.edge && opts.length > 1 ? 0 : this.edges[o.e].pw));
      let r = this.rnd() * ws.reduce((a, b) => a + b, 0), pick = opts[0];
      for (let i = 0; i < opts.length; i++) { r -= ws[i]; if (r <= 0) { pick = opts[i]; break; } }
      p.edge = pick.e; p.dir = this.edges[pick.e].a === node ? 1 : -1; p.s = p.s - e.len;
    }
    this.locPed(p);
  }

  // ---------- metryki ----------
  private metrics() {
    let tot = 0, carLen = 0, tlSum = 0, ped = 0, closed = 0;
    for (const e of this.edges) {
      tot += e.len;
      if (e.pedestrian) ped += e.len;
      if (e.closed) closed += e.len;
      if (!e.closed && !e.pedestrian) { carLen += e.len; tlSum += Math.min(1, e.trafficLevel) * e.len; }
    }
    let sr = 0, sn = 0, tr = 0, tn = 0;
    for (const v of this.veh) {
      const lim = this.edges[v.edge].speedLimit;
      if (v.kind === 0) { sr += Math.min(1, v.speed / lim); sn++; } else { tr += Math.min(1, v.speed / (v.kind === 2 ? 9 : lim)); tn++; }
    }
    const tl = carLen ? tlSum / carLen : 0, np = this.parks.length;
    const traffic = clamp(55 * tl + 45 * (1 - (sn ? sr / sn : 1)));
    const noise = clamp(18 + 85 * (tlSum / tot) + (this.activePeds / MAX_PEDS) * 8 - np * 2.5);
    const pollution = clamp(10 + 0.45 * traffic + 20 * (tlSum / tot) - np * 4 - (ped / tot) * 40);
    const transit = clamp(20 + this.stops.length * 2 + 45 * (tn ? tr / tn : 1));
    const target = clamp(130 + ped / 5 + closed / 8 + np * 22 + this.stops.length * 4, 60, MAX_PEDS);
    const old = Math.round(this.activePeds);
    this.activePeds += clamp(target - this.activePeds, -12, 12);
    for (let i = old; i < Math.round(this.activePeds); i++) this.placePed(this.peds[i], this.pickPedEdge()); // nowi piesi pojawiają się tam, gdzie ich ciągnie
    const pedestrians = clamp((this.activePeds / MAX_PEDS) * 150);
    const nPed = this.edges.filter((e) => e.pedestrian).length, nClosed = this.edges.filter((e) => e.closed).length;
    const satT = clamp(78 - 0.3 * traffic - 0.15 * pollution - 0.2 * noise + 0.12 * pedestrians + 0.12 * (transit - 50) + np * 3 + nPed * 1.5 - nClosed * 2.5);
    const m = this.m;
    this.m = {
      traffic, transit, pedestrians, pollution, noise,
      satisfaction: m.satisfaction + (satT - m.satisfaction) * 0.1,
      budget: m.budget + 1.5 + m.satisfaction * 0.03 + pedestrians * 0.02 - this.stops.length * 0.05 - np * 0.08,
    };
  }
  snapshot() { return { ...this.m, cars: N_CARS, peds: Math.round(this.activePeds), time: this.time }; }

  // ---------- akcje gracza (zwracają komunikat błędu albo null) ----------
  private spend(c: number) { if (this.m.budget < c) return false; this.m.budget -= c; return true; }
  private changed() {
    this.version++;
    this.reweight();
    for (const v of this.veh) { // natychmiastowy objazd wszystkich pojazdów
      if (v.kind === 2 || !v.nodes.length) continue;
      const e = this.edges[v.edge];
      v.nodes = this.path(v.dir > 0 ? e.b : e.a, v.dest, v.kind) ?? [];
    }
  }
  setClosed(id: number, closed: boolean): string | null {
    const e = this.edges[id];
    if (e.closed === closed) return null;
    if (closed) {
      if (this.edges.filter((x) => !x.closed && !x.pedestrian).length <= 8) return 'Zostaw otwartych kilka ulic, inaczej auta nie mają którędy jechać.';
      if (!this.spend(COST.close)) return 'Za mało środków w budżecie.';
      e.pedestrian = false;
    }
    e.closed = closed; this.changed(); return null;
  }
  setPedestrian(id: number, on: boolean): string | null {
    const e = this.edges[id];
    if (e.pedestrian === on) return null;
    if (on) {
      if (this.edges.filter((x) => !x.closed && !x.pedestrian).length <= 8) return 'Zostaw otwartych kilka ulic, inaczej auta nie mają którędy jechać.';
      if (!this.spend(COST.pedestrian)) return 'Za mało środków w budżecie.';
      e.closed = false;
    }
    e.pedestrian = on; this.changed(); return null;
  }
  addStop(id: number): string | null {
    const e = this.edges[id];
    if (e.hasStop) return 'Na tym odcinku jest już przystanek.';
    if (e.closed) return 'Nie dodasz przystanku na zamkniętej ulicy.';
    if (e.len < 60) return 'Odcinek jest za krótki na przystanek.';
    if (!this.spend(COST.stop)) return 'Za mało środków w budżecie.';
    e.hasStop = true; this.stops.push({ edge: id, name: `Nowy przystanek, ${e.name}` }); this.changed(); return null;
  }
  addPark(x: number, z: number): string | null {
    if (Math.abs(x) > 430 || z < -330 || z > 480) return 'Poza obszarem miasta.';
    if (Math.abs(x) < 95 && Math.abs(z) < 95) return 'Rynek zostaje placem. Wybierz miejsce poza nim.';
    if (distToRoads(this.edges, x, z) < 9) return 'Za blisko jezdni. Kliknij w środek kwartału.';
    if (this.parks.some((p) => Math.hypot(p.x - x, p.z - z) < 45)) return 'W tym miejscu jest już park.';
    if (!this.spend(COST.park)) return 'Za mało środków w budżecie.';
    this.parks.push({ x, z, r: 26 }); this.changed(); return null;
  }
}
