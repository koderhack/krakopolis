/**
 * Próbkowanie stanu symulacji → poziomy warstw audio (bez Web Audio).
 * Odległość względem kamery: blisko głośniej, daleko ciszej, poza obszarem ~0.
 */
import type { Sim } from '../simulation/sim';
import type { MiniCam } from '../ui/Minimap';
import type { CityAudioFrame, DisasterAudioKind } from './engine';

function clamp01(n: number) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function dist2(ax: number, az: number, bx: number, bz: number) {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** Promień słyszalności w metrach lokalnych – zależy od zoomu kamery. */
export function hearRadius(camDist: number) {
  return Math.max(180, Math.min(1400, camDist * 0.85 + 220));
}

function falloff(d: number, radius: number) {
  if (d >= radius) return 0;
  const t = 1 - d / radius;
  return t * t;
}

function mapDisasterKind(kind: string): DisasterAudioKind {
  if (kind === 'fire') return 'fire';
  if (kind === 'flood' || kind === 'rain') return 'flood';
  if (kind === 'airRaid') return 'airRaid';
  if (kind === 'contamination') return 'contamination';
  return 'generic';
}

export function sampleCityAudio(
  sim: Sim,
  cam: MiniCam | null,
  master: number,
): CityAudioFrame {
  const empty: CityAudioFrame = {
    master,
    city: 0,
    traffic: 0,
    transit: 0,
    emergency: 0,
    disaster: 0,
    disasterKind: 'generic',
  };
  if (!cam) return empty;

  const cx = cam.tx;
  const cz = cam.tz;
  const radius = hearRadius(cam.dist);
  const r2 = radius * radius;

  // --- ruch + komunikacja w okolicy kamery (stride, żeby nie męczyć CPU) ---
  let trafW = 0;
  let trafSum = 0;
  let transitW = 0;
  let transitSum = 0;
  const roads = sim.roads;
  const stride = roads.length > 2500 ? 3 : roads.length > 1200 ? 2 : 1;

  for (let i = 0; i < roads.length; i += stride) {
    const r = roads[i];
    if (!r || r.closed || r.destroyed || r.pedestrian) continue;
    const mx = (r.edge.ax + r.edge.bx) * 0.5;
    const mz = (r.edge.az + r.edge.bz) * 0.5;
    const d2 = dist2(mx, mz, cx, cz);
    if (d2 > r2) continue;
    const d = Math.sqrt(d2);
    const w = falloff(d, radius);
    if (w <= 0) continue;
    const lvl = Math.min(1.15, Math.max(0, r.level));
    trafW += w;
    trafSum += w * lvl;
    if (r.transit || r.edge.hasTram || r.realStop || r.addedStop) {
      transitW += w;
      transitSum += w * (0.35 + 0.65 * lvl);
    }
  }

  const trafficNear = trafW > 0 ? clamp01(trafSum / trafW) : 0;
  const transitNear = transitW > 0 ? clamp01(transitSum / transitW) : 0;

  // Zoom: daleki widok → cichszy ruch lokalny, mocniejszy „odległy” ambient.
  const zoom = clamp01((cam.dist - 180) / 1600);
  const nearFactor = 1 - zoom * 0.55;

  const cityAmbient = clamp01(
    0.22 + 0.28 * (sim.m.traffic / 100) + 0.18 * zoom + 0.12 * trafficNear * (1 - zoom),
  );

  // --- katastrofy: jedna dominująca źródło (bez wielu identycznych loopów) ---
  let bestScore = 0;
  let bestKind: DisasterAudioKind = 'generic';
  let bestIntensity = 0;
  let bestProx = 0;

  for (const d of sim.disasters) {
    if (d.phase === 'done' || d.intensity < 0.02) continue;
    const d2 = dist2(d.cx, d.cz, cx, cz);
    const dDist = Math.sqrt(d2);
    // Katastrofy słychać dalej niż zwykły ruch.
    const hear = radius * 1.55 + 280;
    const prox = falloff(dDist, hear);
    if (prox <= 0) continue;
    const score = d.intensity * (0.35 + 0.65 * prox);
    if (score > bestScore) {
      bestScore = score;
      bestKind = mapDisasterKind(d.kind as string);
      bestIntensity = d.intensity;
      bestProx = prox;
    }
  }

  const disasterLevel = clamp01(bestIntensity * bestProx);
  const emergencyLevel = clamp01(disasterLevel * (bestKind === 'airRaid' || bestKind === 'contamination' ? 1.05 : 0.9));

  return {
    master: clamp01(master),
    city: cityAmbient * nearFactor * 0.85 + zoom * 0.12,
    traffic: clamp01(trafficNear * nearFactor * (0.55 + 0.55 * trafficNear)),
    transit: clamp01(transitNear * nearFactor * 0.85),
    emergency: emergencyLevel,
    disaster: disasterLevel,
    disasterKind: bestKind,
  };
}
