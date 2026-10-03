import { ENDPOINTS, REFRESH, SOURCES } from '../../config';
import { ORIGIN } from '../../geo';
import { fetchWithTimeout } from '../../cache/store';
import type { EnvironmentState, SourceStatus } from '../../types';
import type { BakedEnvironment } from '../../baked';

const WMO: Record<number, string> = {
  0: 'bezchmurnie', 1: 'prawie bezchmurnie', 2: 'zachmurzenie częściowe', 3: 'zachmurzenie całkowite',
  45: 'mgła', 48: 'mgła z szronem', 51: 'marznąca mżawka', 53: 'marznąca mżawka', 55: 'gęsta marznąca mżawka',
  61: 'lekki deszcz', 63: 'deszcz', 65: 'silny deszcz', 66: 'marznący deszcz', 67: 'marznący deszcz',
  71: 'lekki śnieg', 73: 'śnieg', 75: 'silny śnieg', 77: 'śnieg ziarnisty',
  80: 'przelotny deszcz', 81: 'przelotny deszcz', 82: 'gwałtowny deszcz',
  85: 'przelotny śnieg', 86: 'silny przelotny śnieg',
  95: 'burza', 96: 'burza z gradem', 99: 'burza z silnym gradem',
};

const num = (v: unknown): number | undefined => (typeof v === 'number' && isFinite(v) ? v : undefined);

/**
 * Pogoda i jakość powietrza z Open-Meteo (CORS jest włączony – fetchujemy wprost).
 * UWAGA: jakość powietrza to model CAMS, a nie odczyt stacji GIOŚ/WIOŚ, więc
 * oznaczamy ją jako PREDICTED, nigdy jako OBSERVED.
 */
export async function fetchLiveEnvironment(): Promise<{ env: EnvironmentState; statuses: SourceStatus[] }> {
  const statuses: SourceStatus[] = [];
  const now = new Date().toISOString();
  let weather: EnvironmentState['weather'];
  let airQuality: EnvironmentState['airQuality'];

  try {
    const url = `${ENDPOINTS.openMeteo}?latitude=${ORIGIN.lat}&longitude=${ORIGIN.lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&timezone=Europe%2FWarsaw`;
    const res = await fetchWithTimeout(url, 15_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { current?: Record<string, number | string> };
    const c = j.current ?? {};
    weather = {
      temperatureC: num(c.temperature_2m),
      apparentTemperatureC: num(c.apparent_temperature),
      humidityPct: num(c.relative_humidity_2m),
      windSpeedKmh: num(c.wind_speed_10m),
      precipitationMm: num(c.precipitation),
      weatherCode: num(c.weather_code),
      description: WMO[num(c.weather_code) ?? -1] ?? 'brak opisu',
      origin: 'PREDICTED',
      source: SOURCES.weather.url,
    };
    statuses.push({
      ...SOURCES.weather, freshness: 'LIVE', live: true, refreshSeconds: REFRESH.environment,
      dataTimestamp: typeof c.time === 'string' ? c.time : now, fetchedAt: now,
    });
  } catch (e) {
    statuses.push({ ...SOURCES.weather, freshness: 'CACHED', live: false, error: String(e) });
  }

  try {
    const url = `${ENDPOINTS.openMeteoAir}?latitude=${ORIGIN.lat}&longitude=${ORIGIN.lon}` +
      `&current=european_aqi,pm10,pm2_5,nitrogen_dioxide,sulphur_dioxide,ozone&timezone=Europe%2FWarsaw`;
    const res = await fetchWithTimeout(url, 15_000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = (await res.json()) as { current?: Record<string, number | string> };
    const c = j.current ?? {};
    airQuality = {
      pm25: num(c.pm2_5),
      pm10: num(c.pm10),
      no2: num(c.nitrogen_dioxide),
      so2: num(c.sulphur_dioxide),
      o3: num(c.ozone),
      europeanAqi: num(c.european_aqi),
      description: airDescription(num(c.pm2_5), num(c.pm10), num(c.european_aqi)),
      origin: 'PREDICTED',
      source: SOURCES.air.url,
      note: 'Model CAMS, nie pomiar stacji GIOŚ/WIOŚ.',
    };
    statuses.push({
      ...SOURCES.air, freshness: 'LIVE', live: true, refreshSeconds: REFRESH.environment,
      dataTimestamp: typeof c.time === 'string' ? c.time : now, fetchedAt: now,
      note: 'Dane modelowe CAMS – brak publicznego API stacji pomiarowych dla Krakowa (GIOŚ wymaga klucza).',
    });
  } catch (e) {
    statuses.push({ ...SOURCES.air, freshness: 'CACHED', live: false, error: String(e) });
  }

  return { env: { observedAt: now, weather, airQuality }, statuses };
}

/** Fallback: dane zapisane podczas `npm run ingest`. */
export function cachedEnvironment(baked: BakedEnvironment): { env: EnvironmentState; statuses: SourceStatus[] } {
  const now = new Date().toISOString();
  const w = baked.weather ?? {};
  const a = baked.airQuality ?? {};
  const weather = w.temperature_2m !== undefined ? {
    temperatureC: num(w.temperature_2m),
    apparentTemperatureC: num(w.apparent_temperature),
    humidityPct: num(w.relative_humidity_2m),
    windSpeedKmh: num(w.wind_speed_10m),
    precipitationMm: num(w.precipitation),
    weatherCode: num(w.weather_code),
    description: WMO[num(w.weather_code) ?? -1] ?? 'brak opisu',
    origin: 'PREDICTED' as const,
    source: SOURCES.weather.url,
  } : undefined;
  const airQuality = a.pm2_5 !== undefined || a.european_aqi !== undefined ? {
    pm25: num(a.pm2_5),
    pm10: num(a.pm10),
    no2: num(a.nitrogen_dioxide),
    so2: num(a.sulphur_dioxide),
    o3: num(a.ozone),
    europeanAqi: num(a.european_aqi),
    description: airDescription(num(a.pm2_5), num(a.pm10), num(a.european_aqi)),
    origin: 'PREDICTED' as const,
    source: SOURCES.air.url,
    note: 'Model CAMS, nie pomiar stacji GIOŚ/WIOŚ.',
  } : undefined;
  return {
    env: { observedAt: baked.generatedAt, weather, airQuality },
    statuses: [
      { ...SOURCES.weather, freshness: 'CACHED', live: false, dataTimestamp: baked.generatedAt, fetchedAt: baked.generatedAt },
      { ...SOURCES.air, freshness: 'CACHED', live: false, dataTimestamp: baked.generatedAt, fetchedAt: baked.generatedAt },
    ],
  };
}

function airDescription(pm25?: number, pm10?: number, aqi?: number): string {
  if (aqi === undefined && pm25 === undefined && pm10 === undefined) return 'brak danych';
  if (aqi !== undefined) {
    if (aqi <= 20) return 'bardzo dobra';
    if (aqi <= 40) return 'dobra';
    if (aqi <= 60) return 'umiarkowana';
    if (aqi <= 80) return 'zła';
    return 'bardzo zła';
  }
  const v = pm25 ?? pm10 ?? 0;
  return v <= 15 ? 'dobra jakość powietrza' : v <= 35 ? 'umiarkowana' : 'zła jakość powietrza';
}