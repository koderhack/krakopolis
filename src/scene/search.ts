import { useMemo } from 'react';
import type { CityData } from '../data/model';

export type PlaceKind = 'street' | 'stop' | 'poi' | 'building' | 'park';

export interface Place {
  kind: PlaceKind;
  /** Nazwa do pokazania i dopasowania. */
  name: string;
  /** Uzupełniający opis, np. linie kursujące na przystanku. */
  detail?: string;
  x: number;
  z: number;
  /** Opcjonalny odnośnik do reszty modelu (odcinek drogi, budynek). */
  ref?: { kind: 'road'; id: number } | { kind: 'building'; id: number };
  /** Priorytet przy równym dopasowaniu – wyższy wyżej. */
  rank: number;
}

const FOLD: Record<string, string> = {
  ą: 'a', ć: 'c', ę: 'e', ł: 'l', ń: 'n', ó: 'o', ś: 's', ź: 'z', ż: 'z',
  Ą: 'a', Ć: 'c', Ę: 'e', Ł: 'l', Ń: 'n', Ó: 'o', Ś: 's', Ź: 'z', Ż: 'z',
};

/** Polskie znaki i spacje sprowadzamy do postaci porównywalnej. */
export const fold = (s: string) =>
  s.toLowerCase().replace(/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g, (c) => FOLD[c] ?? c).replace(/[^a-z0-9]+/g, ' ').trim();

const SKIP_BUILDING = /^(zabudowa uzupelniajaca|building|yes)$/i;

function ringCentroid(ring: [number, number][]): { x: number; z: number } | null {
  if (!ring.length) return null;
  let sx = 0, sz = 0;
  for (const [x, z] of ring) { sx += x; sz += z; }
  return { x: sx / ring.length, z: sz / ring.length };
}

function isParkCategory(category: string): boolean {
  const c = fold(category);
  return c === 'park' || c === 'ogrod' || c.startsWith('park ') || c.includes('zielen');
}

/**
 * Indeks wyszukiwarki z prawdziwych nazw:
 * ulice (OSM), przystanki (GTFS), POI, budynki/landmarki, parki (poligony / POI).
 */
export function buildIndex(city: CityData): Place[] {
  const out: Place[] = [];
  const seenStreet = new Set<string>();
  for (const r of city.roads) {
    const name = r.name;
    if (!name || name.length < 3) continue;
    const key = fold(name);
    if (!key || seenStreet.has(key)) continue;
    // pomijamy syntetyczne nazwy odcinków (współrzędne / unnamed)
    if (/^\d+\.\d+,\s*-?\d+\.\d+$/.test(name) || /^odcinek\b/i.test(name) || /^unnamed\b/i.test(name)) continue;
    seenStreet.add(key);
    out.push({
      kind: 'street', name, x: (city.nodes[r.a].x + city.nodes[r.b].x) / 2,
      z: (city.nodes[r.a].z + city.nodes[r.b].z) / 2,
      ref: { kind: 'road', id: r.id }, rank: 3,
    });
  }

  const seenStop = new Set<string>();
  for (const s of city.stops) {
    if (!s.name || s.name.length < 2) continue;
    const key = fold(s.name);
    if (seenStop.has(key)) continue;
    seenStop.add(key);
    out.push({
      kind: 'stop', name: s.name,
      detail: s.lines.length ? `linie ${s.lines.slice(0, 6).join(', ')}` : 'MPK',
      x: s.x, z: s.z, rank: 5,
    });
  }

  const seenPoi = new Set<string>();
  for (const p of city.pois ?? []) {
    if (!p.name || p.name.length < 2) continue;
    const key = `${fold(p.name)}|${fold(p.category)}`;
    if (seenPoi.has(key)) continue;
    seenPoi.add(key);
    const park = isParkCategory(p.category);
    out.push({
      kind: park ? 'park' : 'poi',
      name: p.name,
      detail: p.category,
      x: p.x, z: p.z,
      rank: park ? 7 : 6,
    });
  }

  const seenPark = new Set<string>();
  for (const poly of city.polygons) {
    if (poly.kind !== 'green' || !poly.name || poly.name.length < 2) continue;
    const key = fold(poly.name);
    if (seenPark.has(key) || seenPoi.has(`${key}|park`)) continue;
    seenPark.add(key);
    const c = ringCentroid(poly.ring);
    if (!c) continue;
    out.push({ kind: 'park', name: poly.name, detail: 'park / zieleń', x: c.x, z: c.z, rank: 7 });
  }

  for (const [i, b] of city.buildings.entries()) {
    if (!b.name || b.name.length < 3) continue;
    if (SKIP_BUILDING.test(fold(b.name))) continue;
    out.push({
      kind: 'building',
      name: b.name,
      detail: b.landmark ? 'zabytkowy budynek' : 'budynek',
      x: b.x, z: b.z,
      ref: { kind: 'building', id: i },
      rank: b.landmark ? 8 : 2,
    });
  }
  return out;
}

/** Odległość edycyjna – lekkie fuzzy dla literówek (tylko krótkie zapytania). */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[m];
}

/** Wyniki: dokładne > prefiks > zawieranie > słowa > fuzzy. */
export function search(index: Place[], query: string, limit = 24): Place[] {
  const q = fold(query);
  if (q.length < 2) return [];
  const scored: { p: Place; s: number }[] = [];
  for (const p of index) {
    const n = fold(p.name);
    let s = 0;
    if (n === q) s = 120;
    else if (n.startsWith(q)) s = 100 - Math.min(20, n.length - q.length);
    else {
      const at = n.indexOf(q);
      if (at >= 0) s = 78 - Math.min(20, at) - Math.min(10, n.length - q.length);
    }
    if (s === 0) {
      // „glowna poczta" -> „poczta glowna"
      const words = q.split(' ').filter(Boolean);
      const hit = words.filter((w) => n.includes(w)).length;
      if (hit === words.length && words.length > 1) s = 60 - Math.min(20, n.length);
      else if (hit > 0) s = 30 + hit * 5;
    }
    if (s === 0 && q.length >= 4 && q.length <= 14) {
      const first = n.split(' ')[0] ?? n;
      // fuzzy tylko przy tej samej literze początkowej – unika „Floriańska”→„Słowiańska”
      if (first[0] === q[0]) {
        const d = editDistance(q, first.length <= q.length + 2 ? first : first.slice(0, q.length + 1));
        if (d === 1) s = 40;
        else if (d === 2 && q.length >= 6) s = 24;
      }
    }
    if (s > 0) scored.push({ p, s: s + p.rank });
  }
  scored.sort((a, b) => b.s - a.s);
  const out: Place[] = [];
  const perName = new Map<string, number>();
  for (const { p } of scored) {
    const k = p.kind + fold(p.name);
    const n = perName.get(k) ?? 0;
    if (n >= 2) continue;
    perName.set(k, n + 1);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

export const KIND_LABEL: Record<PlaceKind, string> = {
  street: 'ulica',
  stop: 'przystanek',
  poi: 'miejsce',
  building: 'budynek',
  park: 'park',
};

export function useSearchIndex(city: CityData) {
  return useMemo(() => buildIndex(city), [city]);
}
