import type { BakedArea, BakedTerrain } from './baked';
import type { EnvironmentState, Origin, RoadState, SourceStatus, TrafficState, VehicleState } from './types';

/**
 * Wewnętrzny model miasta przekazywany do silnika symulacji.
 * Symulacja NIE wykonuje zapytań sieciowych – dostaje gotowy obiekt.
 */

export interface SimNode { x: number; z: number }

export interface SimRoad extends RoadState {
  /** Indeksy węzłów grafu (a, b) – zgodne z `CityData.nodes`. */
  lanesForward: number;
  carAccess: boolean;
  transit: boolean;
  /** Czy na odcinku fizycznie jest torowisko (OSM railway=tram). */
  hasTram: boolean;
  osmId: number;
  oneway: boolean;
}

export interface SimStop {
  id: string;
  name: string;
  x: number;
  z: number;
  lat: number;
  lon: number;
  roadId?: number;
  lines: string[];
  mode: 'tram' | 'bus' | 'both';
}

export interface SimRoute {
  index: number;
  /** Klucz `route_id#direction` z GTFS. */
  id: string;
  ref: string;
  kind: 'tram' | 'bus';
  operator: string;
  dir: number;
  /** Węzły grafu w kolejności przejazdu. */
  nodes: number[];
  /** Indeksy przystanków w kolejności przejazdu. */
  stops: number[];
  /** Kształt trasy w metrach lokalnych. */
  shape: [number, number][];
}

export interface SimBuilding {
  x: number; z: number; w: number; d: number; h: number; rot: number;
  color: string; roof: string; name?: string; landmark: boolean;
  /** Prawdziwy obrys z OSM – bryła 3D powstaje z niego, nie z pudełka. */
  ring?: [number, number][];
  levels?: number;
}

/** Miejsce z nazwą z OSM – kategoria, nazwa i pozycja w metrach lokalnych. */
export interface SimPoi {
  name: string;
  category: string;
  x: number;
  z: number;
}

export interface SimPolygon {
  ring: [number, number][];
  kind: 'water' | 'green';
  /** Nazwa z OSM (np. Planty, Park Jordana). */
  name?: string;
}

export interface CityData {
  area: BakedArea;
  generatedAt: string;
  nodes: SimNode[];
  roads: SimRoad[];
  stops: SimStop[];
  routes: SimRoute[];
  buildings: SimBuilding[];
  polygons: SimPolygon[];
  signals: [number, number][];
  pois: SimPoi[];
  /** Siatka wysokości z Open-Meteo DEM – null gdy brak danych. */
  terrain: BakedTerrain | null;
  traffic: TrafficState;
  /** Realne pojazdy MPK z ostatniego odczytu GTFS-RT (albo z migawki offline). */
  liveVehicles: VehicleState[];
  environment: EnvironmentState;
  statuses: SourceStatus[];
  /** Czy baseline ruchu pochodzi z prawdziwych pomiarów, czy z samego modelu. */
  baselineOrigin: Origin;
  /** Surowy słownik GTFS trip_id -> "indeksRuty,kierunek,indeksKształtu". */
  rawTrips: Record<string, string>;
}

export const NO_DATA = 'Data unavailable';