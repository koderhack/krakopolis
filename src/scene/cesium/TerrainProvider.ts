/**
 * Dostawca terenu Cesium zbudowany z NASZYCH danych wysokości.
 *
 * Źródłem jest siatka Open-Meteo Elevation (Copernicus DEM / GMTED) pobrana
 * podczas `npm run ingest`. Dzięki temu Cesium nie potrzebuje Cesium ion
 * ani żadnego płatnego katalogu – wysokości są nasze.
 */
import {
  Event,
  GeographicTilingScheme,
  HeightmapTerrainData,
  Rectangle,
  type TerrainProvider,
} from 'cesium';
import type { BakedTerrain } from '../../data/baked';
import { ORIGIN } from '../../data/geo';

const M_LAT = 111_320;
const M_LON = 111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180);

/** Granice siatki wysokości w stopniach (siatka jest w metrach lokalnych). */
export function terrainBounds(t: BakedTerrain) {
  return {
    west: ORIGIN.lon + t.minX / M_LON,
    east: ORIGIN.lon + t.maxX / M_LON,
    south: ORIGIN.lat - t.maxZ / M_LAT,
    north: ORIGIN.lat - t.minZ / M_LAT,
  };
}

/**
 * W Cesium 1.140 `TerrainProvider` jest już interfejsem – nie da się go
 * wywołać przez `super()`. Dlatego implementujemy go strukturalnie (duck typing)
 * i rzutujemy na typ przy przypisywaniu do `viewer.terrainProvider`.
 */
export class LocalTerrainProvider {
  readonly tilingScheme = new GeographicTilingScheme();
  readonly errorEvent = new Event();
  readonly readyPromise: Promise<boolean> = Promise.resolve(true);
  private readonly bounds: Rectangle;
  private readonly base: number;

  constructor(private t: BakedTerrain, private maxLevel = 2) {
    const b = terrainBounds(t);
    this.bounds = Rectangle.fromDegrees(b.west, b.south, b.east, b.north);
    // średni poziom traktujemy jako 0 – teren unosi się i opada wokół niego
    let sum = 0;
    for (const h of t.heights) sum += h;
    this.base = t.heights.length ? sum / t.heights.length : 0;
  }

  getTileWidth() { return 32; }
  getTileHeight() { return 32; }
  getMaximumLevel() { return this.maxLevel; }
  getAvailableLevel() { return this.maxLevel; }
  getLevelMaximumGeometricError(level: number) { return Math.max(1e-4, 0.4 / 2 ** level); }
  getTilingSchemeBoundingRectangle() { return this.bounds; }

  getMinimumHeight() {
    let min = Infinity;
    for (const h of this.t.heights) min = Math.min(min, h - this.base);
    return isFinite(min) ? min : 0;
  }
  getMaximumHeight() {
    let max = -Infinity;
    for (const h of this.t.heights) max = Math.max(max, h - this.base);
    return isFinite(max) ? max : 0;
  }

  /** Czy Cesium ma się pytać o kafelik (ograniczamy do naszego prostokąta). */
  getTileDataAvailable(level: number, x: number, y: number): boolean {
    if (level > this.maxLevel) return false;
    const r = this.tilingScheme.tileXYToRectangle(x, y, level);
    return (
      r.north >= this.bounds.south && r.south <= this.bounds.north
      && r.east >= this.bounds.west && r.west <= this.bounds.east
    );
  }
  loadTileDataAvailability(_level: number, _x: number, _y: number) { return Promise.resolve(); }
  loadLevelZeroGeometricErrorForTiles() { return Promise.resolve(new Array(2).fill(400)); }
  getCredit() { return [{ html: 'Wysokości: Open-Meteo Elevation (Copernicus DEM)' }]; }
  get ready() { return true; }
  get availability() { return undefined; }
  loadAvailability(): Promise<void> { return Promise.resolve(); }
  get errorEventTypes() { return {}; }
  hasWaterMask = false;
  getWaterMask() { return undefined; }
  hasVertexNormals = false;
  getLevelAdditionalExaggeration() { return 1; }

  /** Biliniarna interpolacja naszej siatki wysokości. */
  private sample(lon: number, lat: number): number {
    const t = this.t;
    const fx = ((lon - this.bounds.west) / this.bounds.width) * (t.cols - 1);
    const fz = ((this.bounds.north - lat) / this.bounds.height) * (t.rows - 1);
    const cx = Math.max(0, Math.min(t.cols - 1, fx));
    const cz = Math.max(0, Math.min(t.rows - 1, fz));
    const x0 = Math.floor(cx), z0 = Math.floor(cz);
    const x1 = Math.min(t.cols - 1, x0 + 1), z1 = Math.min(t.rows - 1, z0 + 1);
    const tx = cx - x0, tz = cz - z0;
    const h = (xx: number, zz: number) => t.heights[zz * t.cols + xx] ?? 0;
    const a = h(x0, z0) * (1 - tx) + h(x1, z0) * tx;
    const b = h(x0, z1) * (1 - tx) + h(x1, z1) * tx;
    return a * (1 - tz) + b * tz - this.base;
  }

  async requestTileGeometry(level: number, x: number, y: number, request: any): Promise<any> {
    const w = this.getTileWidth(), h = this.getTileHeight();
    const rect = this.tilingScheme.tileXYToRectangle(x, y, level);
    const buffer = new Float32Array(w * h);
    for (let j = 0; j < h; j++) {
      const lat = rect.north - (rect.height * (j + 0.5)) / h;
      for (let i = 0; i < w; i++) {
        const lon = rect.west + (rect.width * (i + 0.5)) / w;
        buffer[j * w + i] = this.sample(lon, lat);
      }
    }
    const data: any = new HeightmapTerrainData({
      buffer,
      width: w,
      height: h,
      childTileMask: level < this.maxLevel ? 15 : 0,
    });
    try {
      // `TerrainMesh` i pola `HeightmapTerrainData` nie są w pełni opisane
      // w deklaracjach Cesium – sięgamy po nie dynamicznie.
      const Cesium = await import('cesium') as any;
      return await Cesium.TerrainMesh.createTriangleMesh({
        request,
        vertices: data.vertices,
        indices: data.indices,
        minimumHeights: data.minimumHeights,
        maximumHeights: data.maximumHeights,
      });
    } catch {
      return null;
    }
  }
}

/** Rzutowanie strukturalne na interfejs Cesium. */
export const asTerrainProvider = (p: LocalTerrainProvider): TerrainProvider => p as unknown as TerrainProvider;
