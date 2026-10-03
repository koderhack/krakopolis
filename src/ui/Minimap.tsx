/**
 * Minimapa – granice miasta, obszar kamery, klik = przeniesienie widoku.
 */
import { useEffect, useRef } from 'react';

export interface MiniCam {
  tx: number;
  tz: number;
  dist: number;
  yaw: number;
}

export function Minimap({
  bounds,
  cam,
  landmarks,
  onGoto,
  onFitCity,
}: {
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  cam: MiniCam | null;
  landmarks: { x: number; z: number }[];
  onGoto: (x: number, z: number) => void;
  onFitCity: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const size = 148;

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const w = size;
    const h = size;
    const pad = 8;
    const bw = bounds.maxX - bounds.minX || 1;
    const bh = bounds.maxZ - bounds.minZ || 1;
    const sx = (w - pad * 2) / bw;
    const sz = (h - pad * 2) / bh;
    const s = Math.min(sx, sz);
    const ox = pad + ((w - pad * 2) - bw * s) / 2;
    const oz = pad + ((h - pad * 2) - bh * s) / 2;
    const px = (x: number) => ox + (x - bounds.minX) * s;
    const pz = (z: number) => oz + (z - bounds.minZ) * s;

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(12, 18, 28, 0.92)';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    ctx.strokeStyle = 'rgba(92, 200, 255, 0.55)';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(px(bounds.minX), pz(bounds.minZ), bw * s, bh * s);

    ctx.fillStyle = 'rgba(242, 194, 48, 0.85)';
    for (const m of landmarks.slice(0, 24)) {
      ctx.beginPath();
      ctx.arc(px(m.x), pz(m.z), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    if (cam) {
      const half = Math.min(bw, bh) * 0.08 + cam.dist * 0.04;
      const cx = px(cam.tx);
      const cz = pz(cam.tz);
      ctx.strokeStyle = 'rgba(62, 224, 138, 0.95)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(cx - half * s * 0.35, cz - half * s * 0.35, half * s * 0.7, half * s * 0.7);
      ctx.fillStyle = '#3ee08a';
      ctx.beginPath();
      ctx.arc(cx, cz, 2.5, 0, Math.PI * 2);
      ctx.fill();
      // kierunek kamery
      ctx.strokeStyle = 'rgba(62, 224, 138, 0.7)';
      ctx.beginPath();
      ctx.moveTo(cx, cz);
      ctx.lineTo(cx + Math.sin(cam.yaw) * 14, cz + Math.cos(cam.yaw) * 14);
      ctx.stroke();
    }
  }, [bounds, cam, landmarks]);

  const click = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = ref.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const pad = 8;
    const bw = bounds.maxX - bounds.minX || 1;
    const bh = bounds.maxZ - bounds.minZ || 1;
    const sx = (size - pad * 2) / bw;
    const sz = (size - pad * 2) / bh;
    const s = Math.min(sx, sz);
    const ox = pad + ((size - pad * 2) - bw * s) / 2;
    const oz = pad + ((size - pad * 2) - bh * s) / 2;
    const x = bounds.minX + (mx - ox) / s;
    const z = bounds.minZ + (my - oz) / s;
    onGoto(x, z);
  };

  return (
    <div className="minimap">
      <canvas
        ref={ref}
        width={size}
        height={size}
        onClick={click}
        title="Kliknij, aby przenieść kamerę"
      />
      <button type="button" className="minimap-fit" onClick={onFitCity} title="Pokaż całe miasto (N)">
        Całe miasto
      </button>
    </div>
  );
}
