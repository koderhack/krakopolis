/** Wspólne typy sceny – używane przez HUD, wyszukiwarkę i render. */

export type TrafficView = 'simulated' | 'baseline' | 'predicted';

export type Sel =
  | { kind: 'road'; id: number }
  | { kind: 'building'; id: number }
  | { kind: 'player'; id: number }
  | null;

export type Tool =
  | 'select'
  | 'park'
  | 'park-rect'
  | 'stop-bus'
  | 'stop-tram'
  | 'road'
  | 'tram-track'
  | 'disaster'
  | 'build';

/** Główny tryb pracy UI (pasek Buduj / Analiza / Zdarzenia / Historia). */
export type WorkspaceMode = 'build' | 'analyze' | 'events' | 'history' | null;

/** Rodzaj obiektu stawianego w terenie (niebieski podgląd). */
export type PlaceKind = Exclude<Tool, 'select' | 'disaster' | 'build'> | 'build';

export type BuildToolId = import('../simulation/city/catalog').BuildId;

export interface PendingBuild {
  buildId: BuildToolId;
  x: number;
  z: number;
  rot: number;
  report: import('../simulation/consequences').ConsequenceReport;
}

export interface PendingDisaster {
  kind: import('../simulation/city/player').DisasterKind;
  x: number;
  z: number;
  roads: number[];
  radius: number;
  estimatedAffected: number;
  cost: number;
  label: string;
  report: import('../simulation/consequences').ConsequenceReport;
}

export interface PlaceRef { kind: 'road' | 'building'; id: number }

/** Punkt, do którego kamera ma dolecieć (wyszukiwarka / minimapa). */
export interface FlyTarget {
  x: number;
  z: number;
  y?: number;
  distance?: number;
  lat?: number;
  lon?: number;
  token: number;
  /** fit = widok całego miasta; focus = przybliżenie do obiektu. */
  mode?: 'fit' | 'focus';
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
