/**
 * Warstwa cache: json z public/data traktujemy jako „wypieczone" prawdziwe dane
 * (CACHED), a odpowiedzi API trzymamy w localStorage, żeby restart przeglądarki
 * nie oznaczał utraty ostatniego odczytu.
 */

const mem = new Map<string, unknown>();
const LS_PREFIX = 'simcity-krakow:';

export function getLocal<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function setLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify(value));
  } catch {
    /* brak miejsca – pomijamy */
  }
}

export function clearLocal(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
  } catch {
    /* ignoruj */
  }
}

/** Jednorazowy fetch JSON z pamięcią podręczną w sesji. */
export async function cachedJson<T>(url: string): Promise<T> {
  const hit = mem.get(url);
  if (hit) return hit as T;
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${url}`);
  const data = (await res.json()) as T;
  mem.set(url, data);
  return data;
}

/** Fetch z timeoutem – żeby wiszące API nie blokowało całej aplikacji. */
export async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, cache: 'no-cache' });
  } finally {
    clearTimeout(timer);
  }
}

export const ageSeconds = (iso?: string): number | undefined =>
  iso ? Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)) : undefined;

export function formatAge(iso?: string): string {
  const s = ageSeconds(iso);
  if (s === undefined) return NO_AGE;
  if (s < 5) return 'przed chwilą';
  if (s < 60) return `${s} s temu`;
  if (s < 3600) return `${Math.round(s / 60)} min temu`;
  if (s < 86400) return `${Math.round(s / 3600)} godz. temu`;
  return `${Math.round(s / 86400)} dn. temu`;
}
const NO_AGE = 'brak danych';