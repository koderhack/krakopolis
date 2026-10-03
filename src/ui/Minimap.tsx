/**
 * Minimapa z podkładem OpenStreetMap – granice miasta, widok kamery, klik = goto.
 */
import { useEffect, useRef, useState } from 'react';
import { toLocal } from '../data/geo';

export interface MiniCam {
  tx: number;
  tz: number;
  dist: number;
  yaw: number;
}

export interface MiniArea {
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
}

const TILE_Z = 15;
const SIZE = 148;
const PAD = 6;

function lon2tile(lon: number, z: number) {
  return ((lon + 180) / 360) * 2 ** z;
}
function lat2tile(lat: number, z: number) {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

function tileUrl(z: number, x: number, y: number) {
  const s = ['a', 'b', 'c'][(x + y) % 3];
  return `https://${s}.tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

type Mosaic = {
  canvas: HTMLCanvasElement;
  /** Świat lokalny X/Z odpowiadający krawędziom mozaiki. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

const mosaicCache = new Map<string, Promise<Mosaic | null>>();

async function loadOsmMosaic(area: MiniArea): Promise<Mosaic | null> {
  const key = `${area.minLat.toFixed(4)},${area.maxLat.toFixed(4)},${area.minLon.toFixed(4)},${area.maxLon.toFixed(4)}@${TILE_Z}`;
  const hit = mosaicCache.get(key);
  if (hit) return hit;

  const job = (async (): Promise<Mosaic | null> => {
    const x0 = Math.floor(lon2tile(area.minLon, TILE_Z));
    const x1 = Math.floor(lon2tile(area.maxLon, TILE_Z));
    const y0 = Math.floor(lat2tile(area.maxLat, TILE_Z)); // north
    const y1 = Math.floor(lat2tile(area.minLat, TILE_Z));
    const cols = x1 - x0 + 1;
    const rows = y1 - y0 + 1;
    if (cols < 1 || rows < 1 || cols * rows > 48) return null;

    const mosaic = document.createElement('canvas');
    mosaic.width = cols * 256;
    mosaic.height = rows * 256;
    const mctx = mosaic.getContext('2d');
    if (!mctx) return null;
    mctx.fillStyle = '#d8e0e8';
    mctx.fillRect(0, 0, mosaic.width, mosaic.height);

    const loads: Promise<void>[] = [];
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const url = tileUrl(TILE_Z, tx, ty);
        loads.push(
          new Promise((resolve) => {
            const img = new Image();
            // Bez crossOrigin – OSM nie wysyła CORS; do samego rysowania to wystarczy.
            img.onload = () => {
              mctx.drawImage(img, (tx - x0) * 256, (ty - y0) * 256);
              resolve();
            };
            img.onerror = () => resolve();
            img.src = url;
          }),
        );
      }
    }
    await Promise.all(loads);

    // Granice mozaiki w lokalnych metrach (narożniki kafelków).
    const nW = toLocal(area.maxLat, area.minLon);
    // Dokładniej: piksele kafelków → lat/lon narożników siatki
    const lonMin = (x0 / 2 ** TILE_Z) * 360 - 180;
    const lonMax = ((x1 + 1) / 2 ** TILE_Z) * 360 - 180;
    const latMax = tile2lat(y0, TILE_Z);
    const latMin = tile2lat(y1 + 1, TILE_Z);
    const sw = toLocal(latMin, lonMin);
    const ne = toLocal(latMax, lonMax);
    void nW;
    return {
      canvas: mosaic,
      minX: Math.min(sw.x, ne.x),
      maxX: Math.max(sw.x, ne.x),
      minZ: Math.min(sw.z, ne.z),
      maxZ: Math.max(sw.z, ne.z),
    };
  })();

  mosaicCache.set(key, job);
  return job;
}

function tile2lat(y: number, z: number) {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}

export function Minimap({
  bounds,
  area,
  cam,
  landmarks,
  onGoto,
  onFitCity,
}: {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  area: MiniArea;
  cam: MiniCam | null;
  landmarks: { x: number; z: number }[];
  onGoto: (x: number, z: number) => void;
  onFitCity: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [mosaic, setMosaic] = useState<Mosaic | null>(null);

  useEffect(() => {
    let alive = true;
    loadOsmMosaic(area).then((m) => { if (alive) setMosaic(m); });
    return () => { alive = false; };
  }, [area.minLat, area.maxLat, area.minLon, area.maxLon]);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = SIZE;
    const h = SIZE;
    const bw = bounds.maxX - bounds.minX || 1;
    const bh = bounds.maxZ - bounds.minZ || 1;
    const s = Math.min((w - PAD * 2) / bw, (h - PAD * 2) / bh);
    const ox = PAD + ((w - PAD * 2) - bw * s) / 2;
    const oz = PAD + ((h - PAD * 2) - bh * s) / 2;
    const px = (x: number) => ox + (x - bounds.minX) * s;
    const pz = (z: number) => oz + (z - bounds.minZ) * s;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#c5d0dc';
    ctx.fillRect(0, 0, w, h);

    if (mosaic) {
      const mw = mosaic.maxX - mosaic.minX || 1;
      const mh = mosaic.maxZ - mosaic.minZ || 1;
      // Wycinamy fragment mozaiki pokrywający bounds i rysujemy w lokalnym układzie.
      const srcX = ((bounds.minX - mosaic.minX) / mw) * mosaic.canvas.width;
      const srcY = ((bounds.minZ - mosaic.minZ) / mh) * mosaic.canvas.height;
      const srcW = (bw / mw) * mosaic.canvas.width;
      const srcH = (bh / mh) * mosaic.canvas.height;
      ctx.drawImage(
        mosaic.canvas,
        srcX, srcY, srcW, srcH,
        px(bounds.minX), pz(bounds.minZ), bw * s, bh * s,
      );
      // Lekkie przyciemnienie pod UI
      ctx.fillStyle = 'rgba(8, 12, 18, 0.12)';
      ctx.fillRect(px(bounds.minX), pz(bounds.minZ), bw * s, bh * s);
    } else {
      ctx.fillStyle = 'rgba(12, 18, 28, 0.85)';
      ctx.fillRect(0, 0, w, h);
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    ctx.strokeStyle = 'rgba(30, 90, 140, 0.7)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px(bounds.minX), pz(bounds.minZ), bw * s, bh * s);

    ctx.fillStyle = 'rgba(220, 60, 40, 0.9)';
    for (const m of landmarks.slice(0, 24)) {
      ctx.beginPath();
      ctx.arc(px(m.x), pz(m.z), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    if (cam) {
      const half = Math.min(bw, bh) * 0.08 + cam.dist * 0.04;
      const cx = px(cam.tx);
      const cz = pz(cam.tz);
      ctx.strokeStyle = 'rgba(20, 140, 80, 0.95)';
      ctx.fillStyle = 'rgba(62, 224, 138, 0.18)';
      ctx.lineWidth = 1.5;
      const rw = half * s * 0.7;
      ctx.fillRect(cx - rw / 2, cz - rw / 2, rw, rw);
      ctx.strokeRect(cx - rw / 2, cz - rw / 2, rw, rw);
      ctx.fillStyle = '#1a8f4a';
      ctx.beginPath();
      ctx.arc(cx, cz, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(20, 140, 80, 0.85)';
      ctx.beginPath();
      ctx.moveTo(cx, cz);
      ctx.lineTo(cx + Math.sin(cam.yaw) * 14, cz + Math.cos(cam.yaw) * 14);
      ctx.stroke();
    }
  }, [bounds, cam, landmarks, mosaic]);

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = ref.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * SIZE;
    const my = ((e.clientY - rect.top) / rect.height) * SIZE;
    const bw = bounds.maxX - bounds.minX || 1;
    const bh = bounds.maxZ - bounds.minZ || 1;
    const s = Math.min((SIZE - PAD * 2) / bw, (SIZE - PAD * 2) / bh);
    const ox = PAD + ((SIZE - PAD * 2) - bw * s) / 2;
    const oz = PAD + ((SIZE - PAD * 2) - bh * s) / 2;
    onGoto(bounds.minX + (mx - ox) / s, bounds.minZ + (my - oz) / s);
  };

  // Atrybucja OSM (wymóg licencji) – mały podpis.

  return (
    <div className="minimap">
      <canvas
        ref={ref}
        width={SIZE}
        height={SIZE}
        onClick={click}
        title="OpenStreetMap · kliknij, aby przenieść kamerę"
      />
      <span className="minimap-attr">© OpenStreetMap</span>
      <button type="button" className="minimap-fit" onClick={onFitCity} title="Pokaż całe miasto (N)">
        Całe miasto
      </button>
    </div>
  );
}
