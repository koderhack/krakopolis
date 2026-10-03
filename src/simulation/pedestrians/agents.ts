/**
 * Agenci symulacji (SIMULATED). Żaden z tych obiektów nie jest realnym pojazdem –
 * realne pojazdy MPK przychodzą z warstwy danych i rysowane są osobno.
 */
import type { RoadGraph } from '../graph';
import { mulberry32 } from '../traffic/assignment';

export const CAR = 0, BUS = 1, TRAM = 2;
export type VehKind = 0 | 1 | 2;

export interface Veh {
  kind: VehKind;
  ref: string;
  route: number[];
  si: number;
  edge: number;
  dir: 1 | -1;
  /** Pozycja na odcinku [m] od jego początku (a). */
  s: number;
  speed: number;
  dest: number;
  /** Liczba ticków bez celu – po respawnie nie szukamy trasy natychmiast. */
  stuck: number;
  nodes: number[];
  dwell: number;
  x: number;
  z: number;
  yaw: number;
  /** Skala 0.85–1.25 – drobne zróżnicowanie modelu. */
  variant: number;
}

export interface Ped {
  edge: number;
  dir: 1 | -1;
  s: number;
  speed: number;
  side: 1 | -1;
  jit: number;
  x: number;
  z: number;
  yaw: number;
  /** Faza kroku 0..2π – do animacji nóg przy detalach. */
  phase: number;
  /** Wzrost 1.55–1.95 m – wpływa na model. */
  height: number;
  variant: number;
}

export interface Park {
  x: number;
  z: number;
  r: number;
}

/** Piesi to wyłącznie SIMULATED – liczba agentów, nie danych z miasta. */
export class PedestrianPool {
  peds: Ped[] = [];
  active = 0;

  constructor(private g: RoadGraph, private rnd: () => number, max: number) {
    for (let i = 0; i < max; i++) {
      const p: Ped = {
        edge: 0, dir: 1, s: 0,
        speed: 1.05 + this.rnd() * 0.55,
        side: this.rnd() < 0.5 ? 1 : -1,
        jit: this.rnd() * 2 - 1,
        x: 0, z: 0, yaw: 0, phase: this.rnd() * 6.28,
        height: 1.55 + this.rnd() * 0.4,
        variant: Math.floor(this.rnd() * 8),
      };
      this.place(p, this.pickEdge());
      this.peds.push(p);
    }
  }

  private pickEdge(): number {
    const m = this.g.edges.length;
    for (let i = 0; i < 30; i++) {
      const id = Math.floor(this.rnd() * m);
      if (this.g.edges[id].carAccess) return id;
    }
    return 0;
  }

  place(p: Ped, id: number) {
    p.edge = id;
    p.dir = this.rnd() < 0.5 ? 1 : -1;
    p.s = this.rnd() * this.g.edges[id].len;
    this.locate(p);
  }

  locate(p: Ped) {
    const e = this.g.edges[p.edge];
    const t = p.dir > 0 ? p.s : e.len - p.s;
    const off = e.carAccess ? p.side * 5.6 : p.jit * 3.5;
    p.x = e.ax + e.hx * t - e.hz * off;
    p.z = e.az + e.hz * t + e.hx * off;
    p.yaw = Math.atan2(-e.hz * p.dir, e.hx * p.dir);
  }

  step(p: Ped, dt: number) {
    const e = this.g.edges[p.edge];
    p.s += p.speed * dt;
    p.phase += dt * 5.4 * p.speed;
    if (p.phase > 6.283) p.phase -= 6.283;
    if (p.s >= e.len) {
      const node = p.dir > 0 ? e.b : e.a;
      const opts = this.g.adj[node];
      let total = 0;
      const ws = opts.map((o) => {
        const w = this.g.edges[o.e].carAccess ? 1 : 4;
        total += w;
        return w;
      });
      let r = this.rnd() * total, pick = opts[0];
      for (let i = 0; i < opts.length; i++) { r -= ws[i]; if (r <= 0) { pick = opts[i]; break; } }
      p.edge = pick.e;
      p.dir = this.g.edges[pick.e].a === node ? 1 : -1;
      p.s = Math.max(0, p.s - e.len);
    }
    this.locate(p);
  }
}

export function makeRnd(seed: number) {
  return mulberry32(seed);
}