/**
 * Format lokalnego, „wypieczonego" zbioru danych (offline fallback).
 * Pliki powstają wyłącznie w `npm run ingest` z prawdziwych, publicznych źródeł:
 * OpenStreetMap (Overpass API) + ZTP Kraków (GTFS / GTFS-RT).
 * Współrzędne są już w metrach lokalnych (patrz src/data/geo.ts).
 */

export interface BakedArea {
  minLat: number; maxLat: number; minLon: number; maxLon: number;
  origin: { lat: number; lon: number };
  name: string;
}

/** Węzeł grafu drogowego w metrach lokalnych. */
export interface BakedNode { x: number; z: number }

export interface BakedRoad {
  id: number;
  /** Indeksy węzłów w `BakedCity.nodes` – początek i koniec odcinka. */
  a: number;
  b: number;
  name: string;
  ref?: string;
  roadClass: string;
  /** Łączna liczba pasów w obu kierunkach. */
  lanes: number;
  /** Liczba pasów w kierunku, w którym poprowadzona jest geometria odcinka. */
  lanesForward: number;
  oneway: boolean;
  /** m/s */
  speedLimit: number;
  hasTram: boolean;
  /** Czy odcinek jest przejezdny dla samochodów. */
  carAccess: boolean;
  /** Czy po odcinku kursują pojazdy MPK (wynik mapowania kształtów GTFS). */
  transit: boolean;
  osmId: number;
}

export interface BakedBuilding {
  x: number; z: number; w: number; d: number; h: number;
  /** Obrót obrysu [rad]. */
  rot: number;
  color: string; roof: string;
  name?: string;
  landmark: boolean;
  /** Prawdziwy obrys z OSM w metrach lokalnych (bez domknięcia). */
  ring?: [number, number][];
  /** Liczba kondygnacji z tagu building:levels – do okna elewacji. */
  levels?: number;
}

export interface BakedPolygon {
  /** Pierścień [x,z][] – bez domknięcia. */
  ring: [number, number][];
  kind: 'water' | 'green';
  /** Nazwa z OSM (park, skwer, zbiornik) – pod wyszukiwarkę. */
  name?: string;
}

export interface BakedCity {
  generatedAt: string;
  area: BakedArea;
  nodes: BakedNode[];
  roads: BakedRoad[];
  buildings: BakedBuilding[];
  polygons: BakedPolygon[];
  /** Skrzyżowania ze światłami [x, z]. */
  signals: [number, number][];
  /** Miejsca z nazwami z OSM – podstawa wyszukiwarki w aplikacji. */
  pois: BakedPoi[];
}

export interface BakedPoi {
  name: string;
  /** Kategoria z tagów OSM, np. „Poczta”, „Kościół”, „Dworzec”. */
  category: string;
  x: number;
  z: number;
}

export interface BakedStop {
  id: string;
  name: string;
  lat: number; lon: number; x: number; z: number;
  /** Linie kursujące na przystanku (z GTFS). */
  lines: string[];
  /** Tramwajowy / autobusowy / oba. */
  mode: 'tram' | 'bus' | 'both';
  /** Odcinek drogi przypisany przez mapowanie dopasowania. */
  roadId?: number;
}

export interface BakedRoute {
  id: string;
  /** Numer linii pokazywany w 3D, np. '18' albo '124'. */
  ref: string;
  kind: 'tram' | 'bus';
  operator: string;
  /** Kierunek: 0 albo 1 (GTFS direction_id). */
  dir: number;
  /** Indeks kształtu w polu `shapes`. */
  shape: number;
  /** Węzły grafu drogowego w kolejności przejazdu. */
  nodes: number[];
  /** Indeksy przystanków w kolejności przejazdu. */
  stops: number[];
}

export interface BakedTransit {
  generatedAt: string;
  area: BakedArea;
  stops: BakedStop[];
  routes: BakedRoute[];
  /** Kształty w metrach lokalnych. */
  shapes: [number, number][][];
  /** trip_id -> "indeksRuty,kierunek,indeksKształtu" (do podpięcia GTFS-RT). */
  trips: Record<string, string>;
}

/** Migawka prawdziwych pojazdów zapisana w trakcie ingestu. */
export interface BakedVehicleSnapshot {
  id: string;
  feed: 'A' | 'T' | 'M';
  tripId?: string;
  line?: string;
  dir: number;
  lat: number; lon: number; x: number; z: number;
  bearing?: number;
  speed?: number;
  congestionLevel?: number;
  timestamp: string;
}

export interface BakedTraffic {
  generatedAt: string;
  /** roadId -> znormalizowana intensywność 0..1 (PREDICTED z realnych pozycji). */
  level: Record<number, number>;
  /** roadId -> prędkość [m/s] (PREDICTED). */
  speed: Record<number, number>;
  /** roadId -> poziom zakrzepienia 1..4 z GTFS-RT (OBSERVED). */
  congestion: Record<number, number>;
  sampleSize: number;
}

export interface BakedEnvironment {
  generatedAt: string;
  weather?: Record<string, number | string>;
  airQuality?: Record<string, number | string>;
}

/**
 * Siatka wysokości terenu z demograficznego modelu Open-Meteo
 * (Copernicus DEM / GMTED). Używana do płaskiego kształtu terenu w 3D.
 */
export interface BakedTerrain {
  generatedAt: string;
  /** Rogi siatki w metrach lokalnych. */
  minX: number; maxX: number; minZ: number; maxZ: number;
  /** cols × rows wysokości [m n.p.m.]. */
  cols: number;
  rows: number;
  heights: number[];
  source: string;
}

export interface BakedManifest {
  generatedAt: string;
  area: BakedArea;
  sources: {
    id: string; name: string; origin: string; url: string; license: string;
    kind: 'live' | 'static' | 'derived';
    fetchedAt: string;
    records?: number;
    note?: string;
  }[];
  counts: Record<string, number>;
  files: Record<string, string>;
  notes: string[];
}