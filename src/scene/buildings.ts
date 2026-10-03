import { distToRoads, type Edge } from '../simulation/sim';

export interface B { x: number; z: number; w: number; d: number; h: number; color: string; roof: string; name: string; landmark: boolean }
export interface Tree { x: number; z: number; s: number; c: string }

export function mulberry32(a: number) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const L = (x: number, z: number, w: number, d: number, h: number, color: string, roof: string, name: string): B => ({ x, z, w, d, h, color, roof, name, landmark: true });
export const LANDMARKS: B[] = [
  L(0, 0, 100, 22, 14, '#e8cf9a', '#8a3b32', 'Sukiennice'),
  L(-48, -34, 9, 9, 52, '#cfc3b0', '#5b4a44', 'Wieża Ratuszowa'),
  L(70, -78, 26, 40, 24, '#a9553f', '#4d3a37', 'Kościół Mariacki'),
  L(62, -98, 7, 7, 46, '#a9553f', '#3e5a4e', 'Wieża Mariacka (wyższa)'),
  L(78, -98, 7, 7, 38, '#a9553f', '#b08a3a', 'Wieża Mariacka (niższa)'),
  L(-12, 48, 12, 12, 12, '#efe6d2', '#6a8a7a', 'Kościół św. Wojciecha'),
  L(36, 548, 80, 30, 20, '#d8c9a3', '#8a3b32', 'Zamek Królewski na Wawelu'),
  L(-14, 548, 26, 40, 26, '#d9d0b8', '#b08a3a', 'Katedra Wawelska'),
  L(78, 548, 9, 9, 36, '#cfc3b0', '#5b4a44', 'Wieża Sandomierska'),
];
const FACADES = ['#e8d5b0', '#d9a47c', '#c8826b', '#e6c27a', '#b9c4a6', '#d7cbbd', '#9fb7c6', '#e3b7a0'];
const ROOFS = ['#8a3b32', '#6e3a34', '#5e4b46', '#7d4a3a'];

/** Proceduralne kamienice w wolnych kwartałach: Planty, Rynek i ulice zostają wolne. */
export function genBuildings(edges: Edge[]): B[] {
  const r = mulberry32(1257);
  const out: B[] = [...LANDMARKS];
  for (let x = -420; x <= 420; x += 24) {
    for (let z = -320; z <= 470; z += 24) {
      const px = x + (r() - 0.5) * 6, pz = z + (r() - 0.5) * 6;
      const w = 14 + r() * 8, d = 14 + r() * 8, tall = r() < 0.08 ? 8 : 0, fi = Math.floor(r() * FACADES.length), ri = Math.floor(r() * ROOFS.length);
      const inner = Math.abs(px) <= 388 && Math.abs(pz) <= 292;
      const south = pz > 300 && Math.abs(px) < 230;
      if (!inner && !south) continue;
      if (Math.abs(px) < 92 && Math.abs(pz) < 92) continue; // Rynek
      if (inner && ((Math.abs(px) >= 338 && Math.abs(px) <= 392) || (Math.abs(pz) >= 238 && Math.abs(pz) <= 292))) continue; // Planty
      if (distToRoads(edges, px, pz) < 14) continue;
      if (LANDMARKS.some((l) => Math.hypot(l.x - px, l.z - pz) < 26)) continue;
      const h = 11 + r() * 9 + (Math.hypot(px, pz) < 200 ? 4 : 0) + tall;
      out.push({ x: px, z: pz, w, d, h, color: FACADES[fi], roof: ROOFS[ri], name: 'Kamienica', landmark: false });
    }
  }
  return out;
}

const GREENS = ['#4f8a45', '#5f9a4f', '#3f7a45', '#6aa84f'];
/** Drzewa w Plantach (pierścień wokół Starego Miasta). */
export function genTrees(edges: Edge[]): Tree[] {
  const r = mulberry32(7), out: Tree[] = [];
  const add = (x: number, z: number) => {
    if (distToRoads(edges, x, z) < 10) return;
    out.push({ x, z, s: 0.8 + r() * 0.6, c: GREENS[Math.floor(r() * GREENS.length)] });
  };
  for (let t = -363; t <= 363; t += 8) { add(t, -263 + (r() - 0.5) * 36); add(t, 263 + (r() - 0.5) * 36); }
  for (let t = -263; t <= 263; t += 8) { add(-363 + (r() - 0.5) * 36, t); add(363 + (r() - 0.5) * 36, t); }
  return out;
}
export function parkTrees(i: number, x: number, z: number, r: number): Tree[] {
  const rnd = mulberry32(900 + i), out: Tree[] = [];
  for (let k = 0; k < 16; k++) {
    const a = rnd() * Math.PI * 2, d = Math.sqrt(rnd()) * r * 0.85;
    out.push({ x: x + Math.cos(a) * d, z: z + Math.sin(a) * d, s: 0.9 + rnd() * 0.6, c: GREENS[k % 4] });
  }
  return out;
}
