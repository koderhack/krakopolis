/**
 * Uzupełnianie dziur w zabudowie – bloki bez budynków OSM dostają
 * proste kamienice (oznaczone jako infill / SIMULATED).
 */
import type { SimBuilding, SimNode, SimPolygon, SimRoad } from './model';
import { distToSegment } from '../simulation/city/catalog';

const FACADES = ['#e8d5b0', '#d9a47c', '#c8826b', '#d7cbbd', '#cfc3b0', '#e3b7a0'];
const ROOFS = ['#8a3b32', '#6e3a34', '#5e4b46', '#7d4a3a'];

function hash01(n: number) {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return ((h >>> 8) & 0xffff) / 0x10000;
}

function nearRoad(nodes: SimNode[], roads: SimRoad[], x: number, z: number, maxD: number): boolean {
  for (const r of roads) {
    if (!r.carAccess && r.roadClass !== 'pedestrian') continue;
    const a = nodes[r.a], b = nodes[r.b];
    if (!a || !b) continue;
    if (distToSegment(x, z, a.x, a.z, b.x, b.z) < maxD) return true;
  }
  return false;
}

function inAnyBuilding(buildings: SimBuilding[], x: number, z: number, margin: number): boolean {
  for (const b of buildings) {
    if (Math.hypot(x - b.x, z - b.z) < Math.max(b.w, b.d) / 2 + margin) return true;
  }
  return false;
}

function inGreen(polygons: SimPolygon[], x: number, z: number): boolean {
  for (const p of polygons) {
    if (p.kind !== 'green' || p.ring.length < 3) continue;
    let hit = false;
    for (let i = 0, j = p.ring.length - 1; i < p.ring.length; j = i++) {
      const [xi, zi] = p.ring[i], [xj, zj] = p.ring[j];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi + 1e-12) + xi) hit = !hit;
    }
    if (hit) return true;
  }
  return false;
}

/**
 * Generuje do `limit` kamienic w pustych komórkach siatki przy ulicach.
 * Nie nadpisuje OSM – tylko uzupełnia braki.
 */
export function generateInfill(
  buildings: SimBuilding[],
  nodes: SimNode[],
  roads: SimRoad[],
  polygons: SimPolygon[],
  limit = 420,
): SimBuilding[] {
  const cell = 38;
  const occupied = new Set<string>();
  for (const b of buildings) {
    occupied.add(`${Math.floor(b.x / cell)},${Math.floor(b.z / cell)}`);
  }
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const n of nodes) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minZ = Math.min(minZ, n.z); maxZ = Math.max(maxZ, n.z);
  }
  const out: SimBuilding[] = [];
  let id = 0;
  for (let cx = Math.floor(minX / cell); cx <= Math.floor(maxX / cell) && out.length < limit; cx++) {
    for (let cz = Math.floor(minZ / cell); cz <= Math.floor(maxZ / cell) && out.length < limit; cz++) {
      const key = `${cx},${cz}`;
      if (occupied.has(key)) continue;
      const x = (cx + 0.5) * cell + (hash01(cx * 10007 + cz) - 0.5) * 8;
      const z = (cz + 0.5) * cell + (hash01(cz * 9001 + cx) - 0.5) * 8;
      if (!nearRoad(nodes, roads, x, z, 28)) continue;
      if (nearRoad(nodes, roads, x, z, 7)) continue; // za blisko osi jezdni
      if (inGreen(polygons, x, z)) continue;
      if (inAnyBuilding(buildings, x, z, 14) || inAnyBuilding(out, x, z, 12)) continue;
      const hv = hash01(cx * 13 + cz * 97);
      const w = 10 + hv * 14;
      const d = 8 + hash01(cx + cz * 3) * 12;
      const levels = 2 + Math.floor(hv * 4);
      out.push({
        x, z, w, d,
        h: levels * 3.2 + 1,
        rot: Math.floor(hv * 4) * (Math.PI / 2) + (hv - 0.5) * 0.15,
        color: FACADES[Math.floor(hv * FACADES.length) % FACADES.length],
        roof: ROOFS[Math.floor(hv * 17) % ROOFS.length],
        landmark: false,
        levels,
        name: 'zabudowa uzupełniająca',
      });
      occupied.add(key);
      id++;
    }
  }
  return out;
}
