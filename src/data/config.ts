/**
 * Konfiguracja warstwy danych. Wszystkie adresy da się nadpisać zmiennymi
 * środowiskowymi (.env / shell), żeby dać się podpiąć pod własne proxy.
 */

const env = (k: string, d: string) => (typeof process !== 'undefined' && process.env?.[k]) || d;

/**
 * ZTP Kraków nie wysyła nagłówków CORS (sprawdzone: brak Access-Control-Allow-Origin),
 * więc przeglądarka nie może pobrać feedu bezpośrednio. Dlatego w vite.config.ts jest
 * proxy /api/live/ztp -> https://gtfs.ztp.krakow.pl. Ta sama sytuacja dotyczy Overpass.
 * Adresy poniżej to oryginalne, publiczne źródła danych.
 */
export const ENDPOINTS = {
  ztpIndex: env('VITE_ZTP_INDEX', 'https://gtfs.ztp.krakow.pl/'),
  ztpVehiclePositions: (feed: 'A' | 'T' | 'M') => `${env('VITE_ZTP_BASE', 'https://gtfs.ztp.krakow.pl')}/VehiclePositions_${feed}.pb`,
  ztpTripUpdates: (feed: 'A' | 'T' | 'M') => `${env('VITE_ZTP_BASE', 'https://gtfs.ztp.krakow.pl')}/TripUpdates_${feed}.pb`,
  ztpGtfs: (feed: 'A' | 'T' | 'M') => `${env('VITE_ZTP_BASE', 'https://gtfs.ztp.krakow.pl')}/GTFS_KRK_${feed}.zip`,
  overpass: env('VITE_OVERPASS', 'https://overpass-api.de/api/interpreter'),
  openMeteo: env('VITE_OPEN_METEO', 'https://api.open-meteo.com/v1/forecast'),
  openMeteoAir: env('VITE_OPEN_METEO_AIR', 'https://air-quality-api.open-meteo.com/v1/air-quality'),
} as const;

/** Prefiks lokalnego proxy (obsługuje CORS dla ZTP/Overpass). */
export const PROXY = {
  ztp: '/api/live/ztp',
  overpass: '/api/live/overpass',
} as const;

/** Interwały odświeżania w sekundach. Konfigurowalne przez ?refresh= w URL. */
export const REFRESH = {
  vehicles: 15,
  traffic: 30,
  environment: 600,
  osm: 3600,
} as const;

export const SOURCES = {
  ztpGtfs: {
    id: 'ztp-gtfs',
    name: 'ZTP Kraków – GTFS (rozkłady)',
    origin: 'Zarząd Transportu Publicznego w Krakowie',
    url: 'https://gtfs.ztp.krakow.pl/',
    license: 'Dane ZTP Kraków, portal gtfs.ztp.krakow.pl',
  },
  ztpRt: {
    id: 'ztp-rt',
    name: 'ZTP Kraków – GTFS-RT VehiclePositions',
    origin: 'Zarząd Transportu Publicznego w Krakowie',
    url: 'https://gtfs.ztp.krakow.pl/VehiclePositions_T.pb',
    license: 'Dane ZTP Kraków, portal gtfs.ztp.krakow.pl',
  },
  osm: {
    id: 'osm',
    name: 'OpenStreetMap – Overpass API',
    origin: 'OpenStreetMap contributors',
    url: 'https://overpass-api.de/api/interpreter',
    license: 'ODbL 1.0',
  },
  weather: {
    id: 'open-meteo',
    name: 'Open-Meteo – pogoda',
    origin: 'Open-Meteo (ECMWF / GFS)',
    url: 'https://open-meteo.com/',
    license: 'CC BY 4.0',
  },
  air: {
    id: 'open-meteo-air',
    name: 'Open-Meteo Air Quality (CAMS)',
    origin: 'Copernicus Atmosphere Monitoring Service – model, nie stacja pomiarowa',
    url: 'https://open-meteo.com/en/docs/air-quality-api',
    license: 'CC BY 4.0',
  },
} as const;