/**
 * Szacunek ludności lokalnej z zabudowy OSM w danych Krakowa.
 *
 * Nie ma osobnej siatki GUS w repo – gęstość wynika z rzeczywistej zabudowy
 * (obrys × kondygnacje) w różnych częściach miasta: centrum/bloki = dużo osób,
 * park/obrzeża = mało. Wynik jest SIMULATED, ale przestrzennie spójny z danymi.
 */
import type { SimBuilding } from '../../data/model';
import type { PlayerBuilding } from './player';

/** m² powierzchni użytkowej na 1 mieszkańca (przybliżenie miejskie). */
const M2_PER_PERSON = 38;
/** Udział powierzchni budynku uznawany za mieszkalny (biura/garaże niżej). */
function residentialShare(h: number, levels: number): number {
  if (h < 4.5 || levels < 1) return 0.05;
  if (h >= 28 || levels >= 8) return 0.92;
  if (h >= 14 || levels >= 4) return 0.78;
  if (h >= 8) return 0.55;
  return 0.35;
}

/** Szacunek mieszkańców w jednym budynku OSM. */
export function osmBuildingResidents(b: {
  w: number; d: number; h: number; levels?: number; landmark?: boolean; name?: string;
}): number {
  if (b.landmark) return Math.max(8, Math.round((b.w * b.d) / 80));
  const levels = Math.max(1, b.levels ?? Math.round(b.h / 3.3));
  const floor = Math.max(12, b.w * b.d);
  const share = residentialShare(b.h, levels);
  return Math.max(0, Math.round((floor * levels * share) / M2_PER_PERSON));
}

/**
 * Liczba mieszkańców zagrożonych w promieniu `radius` wokół (cx, cz).
 * Budynki gracza: ich residents. OSM: z objętości zabudowy w danych.
 * Przy wskazanym budynku – minimum = jego pojemność.
 */
export function estimateAffectedResidents(opts: {
  cx: number;
  cz: number;
  radius: number;
  osmBuildings: SimBuilding[];
  playerBuildings: PlayerBuilding[];
  target?: { buildingId?: number; buildingKind?: 'osm' | 'player' };
}): number {
  const { cx, cz, radius, osmBuildings, playerBuildings, target } = opts;
  let sum = 0;

  for (const b of playerBuildings) {
    if (Math.hypot(b.x - cx, b.z - cz) <= radius) sum += b.residents;
  }
  for (const b of osmBuildings) {
    // lekki bounding – pełne pierścienie zbyt drogie przy każdym kliknięciu
    const reach = Math.max(b.w, b.d) * 0.5;
    if (Math.hypot(b.x - cx, b.z - cz) <= radius + reach) {
      sum += osmBuildingResidents(b);
    }
  }

  if (target?.buildingKind === 'player' && target.buildingId != null) {
    const b = playerBuildings.find((p) => p.id === target.buildingId);
    if (b) sum = Math.max(sum, b.residents);
  } else if (target?.buildingKind === 'osm' && target.buildingId != null) {
    const b = osmBuildings[target.buildingId];
    if (b) sum = Math.max(sum, osmBuildingResidents(b));
  }

  return Math.max(0, Math.round(sum));
}

/**
 * Relatywna wysokość terenu (−1..+1) względem średniej lokalnej – do powodzi.
 * Używa surowej siatki DEM z city.terrain (jeśli jest).
 */
export function terrainRelativeHeight(
  terrain: { minX: number; maxX: number; minZ: number; maxZ: number; cols: number; rows: number; heights: number[] } | null | undefined,
  x: number,
  z: number,
): number {
  if (!terrain?.heights?.length) return 0;
  const { minX, maxX, minZ, maxZ, cols, rows, heights } = terrain;
  const sample = (xx: number, zz: number) => {
    const fx = ((xx - minX) / Math.max(1e-6, maxX - minX)) * (cols - 1);
    const fz = ((maxZ - zz) / Math.max(1e-6, maxZ - minZ)) * (rows - 1);
    const ix = Math.max(0, Math.min(cols - 1, Math.round(fx)));
    const iz = Math.max(0, Math.min(rows - 1, Math.round(fz)));
    return heights[iz * cols + ix] ?? 0;
  };
  const h0 = sample(x, z);
  let sum = 0, n = 0;
  const step = 80;
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue;
      sum += sample(x + dx * step, z + dz * step);
      n++;
    }
  }
  const mean = n ? sum / n : h0;
  const delta = h0 - mean;
  // typowy zakres lokalny kilka–kilkanaście metrów
  return Math.max(-1, Math.min(1, delta / 12));
}
