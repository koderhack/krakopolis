/**
 * Wysokości terenu z siatki Open-Meteo (Copernicus DEM) + tekstury proceduralne.
 * Pole wysokości jest współdzielone modułowo, żeby drogi, budynki, pojazdy i
 * piesi stały dokładnie na tym samym profilu bez przekazywania propsów.
 */
import * as THREE from 'three';
import type { BakedTerrain } from '../data/baked';

let field: HeightField | null = null;

export class HeightField {
  /** Średnia wysokość obszaru – od niej liczymy odchylenie (0 = poziom ulic). */
  readonly base: number;
  constructor(readonly t: BakedTerrain) {
    let sum = 0;
    for (const h of t.heights) sum += h;
    this.base = t.heights.length ? sum / t.heights.length : 0;
  }
  at(x: number, z: number): number {
    const t = this.t;
    if (!t.heights.length) return 0;
    const fx = ((x - t.minX) / (t.maxX - t.minX)) * (t.cols - 1);
    const fz = ((t.maxZ - z) / (t.maxZ - t.minZ)) * (t.rows - 1);
    const cx = Math.max(0, Math.min(t.cols - 1, fx));
    const cz = Math.max(0, Math.min(t.rows - 1, fz));
    const x0 = Math.floor(cx), z0 = Math.floor(cz);
    const x1 = Math.min(t.cols - 1, x0 + 1), z1 = Math.min(t.rows - 1, z0 + 1);
    const tx = cx - x0, tz = cz - z0;
    const h = (xx: number, zz: number) => t.heights[zz * t.cols + xx] ?? 0;
    const top = h(x0, z0) * (1 - tx) + h(x1, z0) * tx;
    const bot = h(x0, z1) * (1 - tx) + h(x1, z1) * tx;
    return top * (1 - tz) + bot * tz - this.base;
  }
}

export function setHeightField(f: HeightField | null) { field = f; }
/** Wysokość gruntu w punkcie (x, z) [m]. */
export function groundY(x: number, z: number) { return field ? field.at(x, z) : 0; }
export const hasTerrain = () => field !== null;

/* ---------------------------------------------------------------- tekstury */

const cache = new Map<string, THREE.Texture>();
function tex(key: string, size: number, repeat: number, draw: (g: CanvasRenderingContext2D) => void) {
  const hit = cache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  cache.set(key, t);
  return t;
}

/** Podłoże: ciepła kostka brukowa. */
export const groundTex = () => tex('ground', 256, 30, (g) => {
  g.fillStyle = '#cfc4a9';
  g.fillRect(0, 0, 256, 256);
  for (let y = 0; y < 256; y += 32) {
    const off = ((y / 32) % 2) * 16;
    for (let x = -32; x < 256; x += 32) {
      const v = Math.random();
      g.fillStyle = `rgb(${204 + v * 24},${193 + v * 24},${167 + v * 24})`;
      g.fillRect(x + off + 1, y + 1, 30, 30);
    }
  }
  for (let i = 0; i < 3500; i++) {
    g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`;
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
});

/** Asfalt: ciemny, lekko wstruchany. */
export const asphaltTex = () => tex('asphalt', 256, 10, (g) => {
  g.fillStyle = '#33373f';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 11000; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.82 ? 'rgba(190,200,215,0.06)' : v > 0.45 ? 'rgba(0,0,0,0.14)' : 'rgba(90,100,116,0.09)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  }
});

/** Bruk chodnika. */
export const pavementTex = () => tex('pavement', 256, 10, (g) => {
  g.fillStyle = '#e2d8bf';
  g.fillRect(0, 0, 256, 256);
  g.strokeStyle = 'rgba(146,133,106,0.55)';
  g.lineWidth = 2;
  for (let y = 0; y <= 256; y += 32) { g.beginPath(); g.moveTo(0, y); g.lineTo(256, y); g.stroke(); }
  for (let y = 0; y < 256; y += 32) {
    const off = ((y / 32) % 2) * 32;
    for (let x = 0; x < 256; x += 64) { g.beginPath(); g.moveTo(x + off, y); g.lineTo(x + off, y + 32); g.stroke(); }
  }
});

/** Trawa / zieleń. */
export const grassTex = () => tex('grass', 256, 22, (g) => {
  g.fillStyle = '#6f9a55';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 9000; i++) {
    const v = Math.random();
    g.fillStyle = v > 0.6 ? 'rgba(140,180,105,0.5)' : v > 0.25 ? 'rgba(92,132,72,0.45)' : 'rgba(60,92,52,0.35)';
    g.fillRect(Math.random() * 256, Math.random() * 256, 1, 2 + Math.random() * 2);
  }
});
