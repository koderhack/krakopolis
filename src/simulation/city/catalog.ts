/**
 * Katalog budynków i geometria stawiania.
 *
 * Wszystko tutaj jest czystą funkcją: katalog opisuje *co* można postawić,
 * a pomocniki footprint/OBB – *gdzie* się to zmieści. Symulacja (`Sim`)
 * korzysta z tych samych definicji, więc podgląd przed postawieniem i efekt
 * końcowy zawsze pokazują dokładnie ten sam obiekt.
 *
 * Pojemności (mieszkańcy/praca) są SIMULATED – wpływają na symulację
 * (przychód, zadowolenie, cele ruchu), ale nie są danymi źródłowym.
 */

export type BuildId =
  | 'home'
  | 'small-block'
  | 'apartment-block'
  | 'highrise'
  | 'office'
  | 'shop'
  | 'school'
  | 'kindergarten'
  | 'hospital'
  | 'park'
  | 'parking';

export type BuildGroup = 'Mieszkania' | 'Usługi' | 'Zieleń i infrastruktura';

export interface BuildSpec {
  id: BuildId;
  label: string;
  group: BuildGroup;
  /** Wymiary bryły w metrach (oś X = szerokość, oś Z = głębokość). */
  w: number;
  d: number;
  h: number;
  /** Koszt w złotych (SIMULATED). */
  cost: number;
  color: string;
  roof: string;
  /** Mieszkańcy i miejsca pracy – wpływ na symulację. */
  residents: number;
  jobs: number;
  /** Czy ma sens rotować (parking i park – nie). */
  rotatable: boolean;
  desc: string;
}

export const CATALOG: BuildSpec[] = [
  { id: 'home', label: 'Dom jednorodzinny', group: 'Mieszkania', w: 13, d: 11, h: 7.5, cost: 110, color: '#e6d7bf', roof: '#a45a45', residents: 4, jobs: 0, rotatable: true, desc: 'Niski dom z dachem, 4 mieszkańców' },
  { id: 'small-block', label: 'Mały blok', group: 'Mieszkania', w: 24, d: 17, h: 12, cost: 240, color: '#dfd2c4', roof: '#8d6b57', residents: 11, jobs: 1, rotatable: true, desc: 'Kamienica, 3 kondygnacje' },
  { id: 'apartment-block', label: 'Blok mieszkalny', group: 'Mieszkania', w: 36, d: 21, h: 21, cost: 520, color: '#d9cfc0', roof: '#6f7d8c', residents: 28, jobs: 2, rotatable: true, desc: '6–7 kondygnacji, 28 mieszkańców' },
  { id: 'highrise', label: 'Duży blok mieszkalny', group: 'Mieszkania', w: 28, d: 28, h: 48, cost: 980, color: '#cfd6dc', roof: '#5a6874', residents: 44, jobs: 4, rotatable: true, desc: 'Wieżowiec, 44 mieszkańców' },
  { id: 'office', label: 'Biurowiec', group: 'Usługi', w: 32, d: 25, h: 34, cost: 760, color: '#c9d3da', roof: '#41505c', residents: 0, jobs: 34, rotatable: true, desc: 'Bianki, 34 miejsca pracy' },
  { id: 'shop', label: 'Sklep', group: 'Usługi', w: 19, d: 15, h: 6.5, cost: 280, color: '#e3d8c6', roof: '#c07a4a', residents: 0, jobs: 9, rotatable: true, desc: 'Lokal usługowy' },
  { id: 'school', label: 'Szkoła', group: 'Usługi', w: 42, d: 19, h: 10, cost: 560, color: '#dcd0b4', roof: '#8a5f4a', residents: 0, jobs: 16, rotatable: true, desc: 'Szkoła podstawowa' },
  { id: 'kindergarten', label: 'Przedszkole', group: 'Usługi', w: 21, d: 15, h: 6, cost: 320, color: '#e8ddc6', roof: '#c98a4b', residents: 0, jobs: 7, rotatable: true, desc: 'Żłobek i przedszkole' },
  { id: 'hospital', label: 'Szpital', group: 'Usługi', w: 46, d: 31, h: 25, cost: 1250, color: '#dfe4e8', roof: '#7d94a3', residents: 0, jobs: 64, rotatable: true, desc: 'Szpital, 64 miejsca pracy' },
  { id: 'park', label: 'Park', group: 'Zieleń i infrastruktura', w: 48, d: 48, h: 0.7, cost: 130, color: '#6fa055', roof: '#4d7a3a', residents: 0, jobs: 0, rotatable: false, desc: 'Zieleń, miejsce do spacerów' },
  { id: 'parking', label: 'Parking', group: 'Zieleń i infrastruktura', w: 36, d: 27, h: 0.5, cost: 160, color: '#9aa0a6', roof: '#7d838a', residents: 0, jobs: 0, rotatable: true, desc: 'Parking przy osiedlu' },
];

export const BUILD_GROUPS: BuildGroup[] = ['Mieszkania', 'Usługi', 'Zieleń i infrastruktura'];

const BY_ID = new Map(CATALOG.map((s) => [s.id, s]));
export const buildSpec = (id: BuildId): BuildSpec => BY_ID.get(id) ?? CATALOG[0];

/* ------------------------------------------------------------------ koszty */

/** Domyślne stare typy (park/mall/university) przechodzą przez ten sam katalog. */
export const LEGACY_SPECS: Record<string, { label: string; w: number; d: number; h: number; cost: number; color: string; roof: string }> = {
  mall: { label: 'Nowe centrum handlowe', w: 78, d: 66, h: 14, cost: 420, color: '#c8b7a0', roof: '#4a6a8a' },
  university: { label: 'Nowa uczelnia', w: 62, d: 54, h: 22, cost: 380, color: '#d8cdb8', roof: '#7a5f8a' },
};

/* --------------------------------------------------------------- geometria */

export interface Footprint {
  x: number;
  z: number;
  w: number;
  d: number;
  rot: number;
}

/** Cztery narożniki obrysu po obrocie (radiany, zgodnie z osią Z modelu). */
export function corners(f: Footprint): [number, number][] {
  const c = Math.cos(f.rot), s = Math.sin(f.rot);
  const hw = f.w / 2, hd = f.d / 2;
  const out: [number, number][] = [];
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    const lx = sx * hw, lz = sz * hd;
    out.push([f.x + lx * c - lz * s, f.z + lx * s + lz * c]);
  }
  return out;
}

/** Promień okręgu opisującego obrys – do szybkich testów. */
export function radius(f: Footprint): number {
  return Math.hypot(f.w, f.d) / 2;
}

function project(pts: [number, number][], ax: number, az: number) {
  let min = Infinity, max = -Infinity;
  for (const [x, z] of pts) {
    const p = x * ax + z * az;
    if (p < min) min = p;
    if (p > max) max = p;
  }
  return [min, max] as const;
}

/** Test przecięcia dwóch prostokątów po obrocie (separating axis theorem). */
export function overlaps(a: Footprint, b: Footprint): boolean {
  if (Math.hypot(a.x - b.x, a.z - b.z) > radius(a) + radius(b)) return false;
  const ca = corners(a), cb = corners(b);
  const axes: [number, number][] = [[1, 0], [0, 1]];
  for (const poly of [ca, cb]) {
    for (let i = 0; i < 2; i++) {
      const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % 4];
      const ex = x2 - x1, ez = z2 - z1;
      const len = Math.hypot(ex, ez) || 1;
      axes.push([-ez / len, ex / len]);
    }
  }
  for (const [ax, az] of axes) {
    const [aMin, aMax] = project(ca, ax, az);
    const [bMin, bMax] = project(cb, ax, az);
    if (aMax < bMin || bMax < aMin) return false;
  }
  return true;
}

/** Odległość punktu od odcinka – potrzebna przy kolizjach z drogami. */
export function distToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / len2)) : 0;
  return Math.hypot(px - (ax + dx * t), pz - (az + dz * t));
}

/** Czy punkt leży w wielokącie (metoda ray casting). */
export function pointInRing(px: number, pz: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi + 1e-12) + xi) inside = !inside;
  }
  return inside;
}

/** Odległość od wielokąta (0 wewnątrz). */
export function distToRing(px: number, pz: number, ring: [number, number][]): number {
  if (pointInRing(px, pz, ring)) return 0;
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const d = distToSegment(px, pz, ring[j][0], ring[j][1], ring[i][0], ring[i][1]);
    if (d < best) best = d;
  }
  return best;
}