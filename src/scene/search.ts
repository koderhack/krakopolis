import { useMemo } from 'react';
import type { CityData } from '../data/model';

export type PlaceKind = 'street' | 'stop' | 'poi' | 'building';

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

/**
 * Indeks wyszukiwarki zbudowany wyłącznie z prawdziwych nazw z danych:
 * ulice (OSM), przystanki (GTFS ZTP), miejsca i budynki z nazwami (OSM).
 */
export function buildIndex(city: CityData): Place[] {
  const out: Place[] = [];
  const seenStreet = new Set<string>();
  for (const r of city.roads) {
    const name = r.name;
    if (!name || name.length < 3) continue;
    const key = fold(name);
    if (!key || seenStreet.has(key)) continue;
    seenStreet.add(key);
    out.push({
      kind: 'street', name, x: (city.nodes[r.a].x + city.nodes[r.b].x) / 2,
      z: (city.nodes[r.a].z + city.nodes[r.b].z) / 2,
      ref: { kind: 'road', id: r.id }, rank: 3,
    });
  }
  for (const s of city.stops) {
    if (!s.name || s.name.length < 2) continue;
    out.push({
      kind: 'stop', name: s.name,
      detail: s.lines.length ? `przystanek · linie ${s.lines.slice(0, 6).join(', ')}` : 'przystanek MPK',
      x: s.x, z: s.z, rank: 5,
    });
  }
  for (const p of city.pois ?? []) {
    out.push({ kind: 'poi', name: p.name, detail: p.category, x: p.x, z: p.z, rank: 6 });
  }
  for (const [i, b] of city.buildings.entries()) {
    if (!b.name || b.name.length < 3) continue;
    out.push({
      kind: 'building', name: b.name, detail: 'budynek z OSM',
      x: b.x, z: b.z, ref: { kind: 'building', id: i }, rank: 2,
    });
  }
  return out;
}

/** Wyniki: dopasowanie prefiksowe > zawieranie > dopasowanie słów. */
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
      // dopasowanie po słowach: „glowna poczta" -> „poczta glowna"
      const words = q.split(' ');
      const hit = words.filter((w) => n.includes(w)).length;
      if (hit === words.length && words.length > 1) s = 60 - Math.min(20, n.length);
      else if (hit > 0) s = 30 + hit * 5;
    }
    if (s > 0) scored.push({ p, s: s + p.rank });
  }
  scored.sort((a, b) => b.s - a.s);
  // limitujemy duplikaty nazw (ulica występuje wiele razy)
  const out: Place[] = [];
  const perName = new Map<string, number>();
  for (const { p } of scored) {
    const k = p.kind + fold(p.name);
    const n = perName.get(k) ?? 0;
    if (n >= 3) continue;
    perName.set(k, n + 1);
    out.push(p);
    if (out.length >= limit) break;
  }
  return out;
}

export const KIND_LABEL: Record<PlaceKind, string> = {
  street: 'ulica', stop: 'przystanek', poi: 'miejsce', building: 'budynek',
};

export function useSearchIndex(city: CityData) {
  return useMemo(() => buildIndex(city), [city]);
}