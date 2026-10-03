/**
 * Zunifikowany schemat stanu miasta.
 *
 * Każda liczba w tym pliku ma przypisane pochodzenie:
 *  - OBSERVED  – wprost odczytane z zewnętrznego, publicznego źródła danych,
 *  - PREDICTED – policzone z danych OBSERVED (np. prędkość z dwóch pozycji),
 *  - SIMULATED– wygenerowane przez silnik symulacji gry.
 *
 * Silnik symulacji NIE wykonuje zapytań do zewnętrznych API. Dostaje gotowy
 * CityState (baseline) i nakłada na niego zmiany gracza.
 */

export type Origin = 'OBSERVED' | 'PREDICTED' | 'SIMULATED';
export type Freshness = 'LIVE' | 'CACHED' | 'SIMULATED';

/** Zbiorcza ocena jednego źródła danych dla panelu statusu. */
export interface SourceStatus {
  id: string;
  name: string;
  /** Krótki opis gdzie dane pochodzą, pokazywany w UI. */
  origin: string;
  url?: string;
  license?: string;
  /** LIVE = pobrane teraz z API, CACHED = z lokalnego zapisu prawdziwych danych. */
  freshness: Freshness;
  /** Znacznik czasu danych (nie czasu ich pobrania). */
  dataTimestamp?: string;
  /** Kiedy aplikacja ostatnio skutecznie pobrała / wczytała te dane. */
  fetchedAt?: string;
  /** Wiek danych w sekundach liczony przy renderze. */
  ageSeconds?: number;
  /** Czy odświeżanie w tle działa. */
  live?: boolean;
  /** Interwał odświeżania w sekundach (konfigurowalny). */
  refreshSeconds?: number;
  records?: number;
  error?: string;
  /** Świadoma notatka: czego w danym źródle NIE ma. */
  note?: string;
}

export interface RoadState {
  id: number;
  name: string;
  a: number;
  b: number;
  /** Klasa z OSM: residential, primary, tertiary, pedestrian, ... */
  roadClass: string;
  lanes: number;
  oneway: boolean;
  speedLimit: number;
  /** Przepustowość [pojazdów / 15 min] oszacowana z klasy i liczby pasów. */
  capacity: number;
  hasTram: boolean;
  /** Poziom ruchu 0..1 w stanie bazowym (zaobserwowane lub oszacowane). */
  baselineTraffic: number;
  /** Skąd pochodzi baselineTraffic. */
  baselineOrigin: Origin;
  /** Średnia prędkość na odcinku [m/s] w stanie bazowym. */
  baselineSpeed?: number;
  /** Czy na odcinku jeżdżą realne pojazdy MPK (OBSERVED). */
  observedTransit: boolean;
  /** OSM id drogi, do odszukania w źródle. */
  osmId?: number;
}

export interface VehicleState {
  id: string;
  type: 'tram' | 'bus';
  line: string;
  routeId?: string;
  headsign?: string;
  direction: number;
  latitude: number;
  longitude: number;
  x: number;
  z: number;
  bearing?: number;
  /** m/s – PREDICTED z dwóch kolejnych pozycji realnego pojazdu. */
  speed?: number;
  /** min opóźnienia wg rozkładu, jeśli dostępne. */
  delaySeconds?: number;
  source: string;
  origin: Origin;
  timestamp: string;
}

export interface StopState {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  x: number;
  z: number;
  /** Odcinek drogi, na którym stoi przystanek. */
  roadId?: number;
  /** Linie kursujące na przystanku. */
  lines: string[];
  source: string;
}

export interface TrafficState {
  /** Odcinek drogi -> znormalizowana intensywność 0..1. */
  observedLevel: Record<number, number>;
  /** Odcinek drogi -> średnia prędkość [m/s]. */
  observedSpeed: Record<number, number>;
  origin: Origin;
  source: string;
  timestamp?: string;
  /** Ile realnych pojazdów MPK zasilało te pomiary. */
  sampleSize?: number;
}

export interface EnvironmentState {
  observedAt: string;
  weather?: {
    temperatureC?: number;
    apparentTemperatureC?: number;
    humidityPct?: number;
    windSpeedKmh?: number;
    precipitationMm?: number;
    weatherCode?: number;
    description: string;
    origin: Origin;
    source: string;
  };
  airQuality?: {
    pm25?: number;
    pm10?: number;
    no2?: number;
    so2?: number;
    o3?: number;
    europeanAqi?: number;
    description: string;
    origin: Origin;
    source: string;
    note?: string;
  };
}

export interface PedestrianState {
  /** Piesi to zawsze agenci symulacji – nigdy nie przedstawiamy ich jako obserwowanych. */
  origin: Origin;
  source: string;
  count: number;
}

export interface CityState {
  timestamp: string;
  area: { minLat: number; maxLat: number; minLon: number; maxLon: number; origin: { lat: number; lon: number }; name: string };
  roads: RoadState[];
  stops: StopState[];
  traffic: TrafficState;
  publicTransport: VehicleState[];
  pedestrians: PedestrianState;
  environment: EnvironmentState;
  statuses: SourceStatus[];
}

export const isObserved = (o: Origin) => o === 'OBSERVED';
export const unavailable = 'Data unavailable';