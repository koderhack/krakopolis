/** Wspólne typy sceny – używane przez HUD, wyszukiwarkę i render (Cesium). */

export type TrafficView = 'simulated' | 'baseline' | 'predicted';

export type Sel = { kind: 'road'; id: number } | { kind: 'building'; id: number } | null;

export type Tool = 'select' | 'park' | 'park-rect' | 'stop-bus' | 'stop-tram' | 'mall' | 'university' | 'road' | 'tram-track' | 'disaster';

/** Rodzaj obiektu stawianego w terenie (niebieski podgląd). */
export type PlaceKind = Exclude<Tool, 'select' | 'disaster'>;

export interface PlaceRef { kind: 'road' | 'building'; id: number }

/** Punkt, do którego kamera ma dolecieć (wyszukiwarka). */
export interface FlyTarget {
  x: number;
  z: number;
  y?: number;
  distance?: number;
  lat?: number;
  lon?: number;
  token: number;
}

/** Pozycja pojazdu w scenie – wspólna dla realnych (OBSERVED) i symulowanych. */
export interface FleetPose {
  id: string;
  x: number;
  z: number;
  yaw: number;
  ref: string;
  observed?: boolean;
  speed?: number;
  info?: string;
}
