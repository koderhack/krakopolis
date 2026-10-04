/**
 * Analiza natężenia ruchu – dyskretne 5 poziomów na istniejących
 * baseline / predicted / simulated (RoadSim), bez osobnego systemu ruchu.
 */

export type TrafficIntensityId =
  | 'very-low'
  | 'low'
  | 'medium'
  | 'high'
  | 'very-high';

export interface TrafficIntensityLevel {
  id: TrafficIntensityId;
  label: string;
  color: string;
  scale: number;
  min: number;
  max: number;
}

export const TRAFFIC_INTENSITY_LEVELS: readonly TrafficIntensityLevel[] = [
  { id: 'very-low', label: 'Bardzo niskie', color: '#1faa4a', scale: 0.4, min: 0, max: 0.2 },
  { id: 'low', label: 'Niskie', color: '#7dce55', scale: 0.65, min: 0.2, max: 0.4 },
  { id: 'medium', label: 'Średnie', color: '#f0c419', scale: 1, min: 0.4, max: 0.6 },
  { id: 'high', label: 'Wysokie', color: '#ef7e1a', scale: 1.4, min: 0.6, max: 0.8 },
  { id: 'very-high', label: 'Bardzo wysokie', color: '#e03a2f', scale: 1.85, min: 0.8, max: 1.2 },
] as const;

export const DEFAULT_TRAFFIC_INTENSITY: TrafficIntensityId = 'medium';

const LEVEL_BY_ID = Object.fromEntries(
  TRAFFIC_INTENSITY_LEVELS.map((l) => [l.id, l]),
) as Record<TrafficIntensityId, TrafficIntensityLevel>;

export function intensityDef(id: TrafficIntensityId): TrafficIntensityLevel {
  return LEVEL_BY_ID[id] ?? LEVEL_BY_ID.medium;
}

export function fallbackTrafficFromClass(roadClass: string): number {
  const rank: Record<string, number> = {
    motorway: 0.72, trunk: 0.58, primary: 0.52, secondary: 0.42, tertiary: 0.36,
    unclassified: 0.28, residential: 0.22, living_street: 0.12, service: 0.14, track: 0.08,
  };
  return rank[roadClass] ?? 0.22;
}

export type TrafficDataKind = 'simulated' | 'baseline' | 'predicted' | 'fallback';

export interface RoadTrafficSample {
  raw: number;
  display: number;
  level: TrafficIntensityLevel;
  kind: TrafficDataKind;
}

export function sampleRoadTraffic(
  road: {
    level: number;
    baseline: number;
    predicted: number;
    closed: boolean;
    pedestrian: boolean;
    edge: { carAccess: boolean; roadClass: string };
  },
  view: 'simulated' | 'baseline' | 'predicted',
  intensity: TrafficIntensityId,
): RoadTrafficSample {
  if (road.closed || road.pedestrian || !road.edge.carAccess) {
    return { raw: 0, display: 0, level: intensityDef('very-low'), kind: 'simulated' };
  }
  let raw: number;
  let kind: TrafficDataKind;
  if (view === 'baseline') { raw = road.baseline; kind = 'baseline'; }
  else if (view === 'predicted') { raw = road.predicted; kind = 'predicted'; }
  else { raw = road.level; kind = 'simulated'; }

  if (!(raw > 0.02)) {
    raw = fallbackTrafficFromClass(road.edge.roadClass);
    kind = 'fallback';
  }
  raw = Math.max(0, Math.min(1.2, raw));
  const display = Math.max(0, Math.min(1.2, raw * intensityDef(intensity).scale));
  return { raw, display, level: bandForValue(display), kind };
}

export function bandForValue(v: number): TrafficIntensityLevel {
  const x = Math.max(0, Math.min(1.2, v));
  for (const l of TRAFFIC_INTENSITY_LEVELS) {
    if (x < l.max || l.id === 'very-high') return l;
  }
  return LEVEL_BY_ID['very-high'];
}

export function intensityColor(id: TrafficIntensityId): string {
  return intensityDef(id).color;
}

/** @deprecated Zachowane tylko dla kompatybilności – UI ANALIZA używa TRAFFIC_INTENSITY_LEVELS. */
export interface AnalysisLayerDef {
  id: string;
  label: string;
  hint: string;
  mapLayer?: string;
  estimate: boolean;
}

/** @deprecated */
export const ANALYSIS_LAYERS: AnalysisLayerDef[] = [
  { id: 'ax-traffic', label: 'Natężenie ruchu', hint: 'Jak zatłoczone są ulice', mapLayer: 'traffic', estimate: true },
];
