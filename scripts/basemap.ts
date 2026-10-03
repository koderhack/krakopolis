/**
 * Składa ortofotomapę / kafelki OSM na obszar symulacji → public/data/basemap.jpg
 *
 * Źródła (otwarte, bez klucza API):
 *  - satellite: Esri World Imagery
 *  - osm: OpenStreetMap standard (wymaga User-Agent)
 *
 * Uruchomienie: npx tsx scripts/basemap.ts
 * Opcjonalnie: BASEMAP=osm npx tsx scripts/basemap.ts
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { AREA } from '../src/data/geo';

const OUT = join(process.cwd(), 'public', 'data', 'basemap.jpg');
const CACHE = join(process.cwd(), '.cache', 'basemap-tiles');
const Z = Number(process.env.BASEMAP_ZOOM ?? 17);
const KIND = (process.env.BASEMAP ?? 'satellite') as 'satellite' | 'osm';

mkdirSync(CACHE, { recursive: true });

function lon2tile(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function lat2tile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}
function latLonToPixel(lat: number, lon: number, z: number) {
  return { x: lon2tile(lon, z) * 256, y: lat2tile(lat, z) * 256 };
}

function tileUrl(z: number, x: number, y: number): string {
  if (KIND === 'osm') return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  // Esri World Imagery – popularne otwarte ortofoto (atrybucja: Esri / Maxar / Earthstar)
  return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
}

async function fetchTile(z: number, x: number, y: number): Promise<Buffer> {
  const name = `${KIND}-${z}-${x}-${y}.jpg`;
  const p = join(CACHE, name);
  const png = join(CACHE, `${KIND}-${z}-${x}-${y}.png`);
  if (existsSync(p)) return readFileSync(p);
  if (existsSync(png)) return readFileSync(png);
  const url = tileUrl(z, x, y);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'simcity-krakow/0.2 (hackathon; educational; local cache)' },
  });
  if (!res.ok) throw new Error(`tile ${z}/${x}/${y}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(KIND === 'osm' ? png : p, buf);
  return buf;
}

async function main() {
  const x0 = Math.floor(lon2tile(AREA.minLon, Z));
  const x1 = Math.floor(lon2tile(AREA.maxLon, Z));
  const y0 = Math.floor(lat2tile(AREA.maxLat, Z)); // north = smaller y
  const y1 = Math.floor(lat2tile(AREA.minLat, Z));
  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  console.log(`• basemap ${KIND} z=${Z}: ${cols}×${rows} kafelków (${cols * rows})`);

  const files: string[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const buf = await fetchTile(Z, x, y);
      const ext = KIND === 'osm' ? 'png' : 'jpg';
      const fp = join(CACHE, `${KIND}-${Z}-${x}-${y}.${ext}`);
      if (!existsSync(fp)) writeFileSync(fp, buf);
      files.push(fp);
      process.stdout.write('.');
    }
  }
  process.stdout.write('\n');

  const mosaic = join(CACHE, `mosaic-${KIND}-${Z}.jpg`);
  const mont = spawnSync('montage', [
    ...files,
    '-tile', `${cols}x${rows}`,
    '-geometry', '256x256+0+0',
    '-background', 'black',
    mosaic,
  ], { encoding: 'utf8' });
  if (mont.status !== 0) {
    console.error(mont.stderr || mont.stdout);
    throw new Error('montage nieudany – potrzebny ImageMagick (`montage`)');
  }

  // Przytnij do dokładnego bboxu AREA (piksele Web Mercator)
  const nw = latLonToPixel(AREA.maxLat, AREA.minLon, Z);
  const se = latLonToPixel(AREA.minLat, AREA.maxLon, Z);
  const originX = x0 * 256;
  const originY = y0 * 256;
  const cropX = Math.max(0, Math.floor(nw.x - originX));
  const cropY = Math.max(0, Math.floor(nw.y - originY));
  const cropW = Math.max(64, Math.ceil(se.x - nw.x));
  const cropH = Math.max(64, Math.ceil(se.y - nw.y));

  const crop = spawnSync('convert', [
    mosaic,
    '-crop', `${cropW}x${cropH}+${cropX}+${cropY}`,
    '+repage',
    '-quality', '82',
    OUT,
  ], { encoding: 'utf8' });
  if (crop.status !== 0) {
    console.error(crop.stderr || crop.stdout);
    throw new Error('convert crop nieudany');
  }
  console.log(`• zapisano ${OUT} (${cropW}×${cropH} px, ${KIND})`);
  console.log('• atrybucja: ' + (KIND === 'osm'
    ? '© OpenStreetMap contributors'
    : 'Esri, Maxar, Earthstar Geographics, and the GIS User Community'));
}

main().catch((e) => { console.error(e); process.exit(1); });
