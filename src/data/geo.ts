/**
 * Wspólna definicja geografii i bboxu. Jedno źródło prawdy dla skryptu ingest
 * i dla przeglądarki, żeby współrzędne lokalne zawsze się zgadzały.
 */

/** Punkt odniesienia: narożnik Rynku Głównego (prawy narożnik Sukiennic). */
export const ORIGIN = { lat: 50.06162, lon: 19.93771 };

/** Obszar symulacji: Stare Miasto, Kazimierz, Wawel, Planty, Politechnika. */
export const AREA = {
  minLat: 50.0525,
  maxLat: 50.07,
  minLon: 19.926,
  maxLon: 19.948,
};

export const AREA_NAME = 'Stare Miasto, Kazimierz, Wawel (Kraków)';

const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** Współrzędne geograficzne -> lokalne metry (oś X = wschód, oś Z = południe). */
export function toLocal(lat: number, lon: number): { x: number; z: number } {
  return { x: (lon - ORIGIN.lon) * M_PER_DEG_LON, z: -(lat - ORIGIN.lat) * M_PER_DEG_LAT };
}

/** Współrzędne lokalne -> geograficzne (odwrotność toLocal). */
export function toLatLon(x: number, z: number): { lat: number; lon: number } {
  return { lat: ORIGIN.lat - z / M_PER_DEG_LAT, lon: ORIGIN.lon + x / M_PER_DEG_LON };
}

export function inArea(lat: number, lon: number): boolean {
  return lat >= AREA.minLat && lat <= AREA.maxLat && lon >= AREA.minLon && lon <= AREA.maxLon;
}

/** Odległość punktu od prostokąta w metrach (0 wewnątrz). */
export function outsideAreaMeters(lat: number, lon: number): number {
  const { x, z } = toLocal(lat, lon);
  const hx = ((AREA.maxLon - ORIGIN.lon) * M_PER_DEG_LON) / 2;
  const hz = ((ORIGIN.lat - AREA.minLat) * M_PER_DEG_LAT) / 2;
  return Math.max(Math.abs(x) - hx, Math.abs(z) - hz, 0);
}

/** Siatka kafelków do pobierania Overpass (zapobiega timeoutom na dużym bboxie). */
export function areaTiles(cols = 2, rows = 3): { minLat: number; maxLat: number; minLon: number; maxLon: number }[] {
  const out: { minLat: number; maxLat: number; minLon: number; maxLon: number }[] = [];
  const dLat = (AREA.maxLat - AREA.minLat) / rows;
  const dLon = (AREA.maxLon - AREA.minLon) / cols;
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++)
      out.push({ minLat: AREA.minLat + r * dLat, maxLat: AREA.minLat + (r + 1) * dLat, minLon: AREA.minLon + c * dLon, maxLon: AREA.minLon + (c + 1) * dLon });
  return out;
}