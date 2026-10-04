/**
 * Zmiany gracza i katastrofy.
 *
 * Każda decyzja gracza jest odwracalna: `PlayerAction` trzyma listę zmian,
 * które można cofnąć (`undo`) albo przywrócić do stanu wyjściowego (`reset`).
 * Stan z danych źródłowych (baseline) nigdy nie jest nadpisywany – trzymamy go
 * osobno, a na nim budujemy scenariusz.
 *
 * Wszystko w tym pliku jest SIMULATED – gracz nie zmienia prawdziwych danych
 * Krakowa, tylko wirtualny model.
 */
import { mulberry32 } from '../traffic/assignment';
import type { BuildId } from './catalog';

export type RoadClosure = 'none' | 'closed' | 'cars-only' | 'destroyed';

export type DisasterKind =
  | 'fire'
  | 'flood'
  | 'blackout'
  | 'earthquake'
  | 'heat'
  | 'rain'
  | 'airRaid'
  | 'contamination';

export interface AffectedBuildingRef {
  id: number;
  kind: 'osm' | 'player';
}

export interface PlayerBuilding {
  id: number;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  /** Obrót w radianach (oś Y). */
  rot?: number;
  kind: BuildId;
  name: string;
  color: string;
  roof: string;
  residents: number;
  jobs: number;
}

export interface DisasterState {
  /** Unikalny id w sesji. */
  id: number;
  kind: DisasterKind;
  /** Odcinki objęte skutkiem (zamknięte lub zniszczone) – efekty uboczne, NIE źródło. */
  roads: number[];
  /** Bieżąca intensywność 0..1 – rośnie, potem maleje. */
  intensity: number;
  /** Szczyt do tej pory (do poziomu LOW/MEDIUM/HIGH/CRITICAL). */
  peak: number;
  startedAt: number;
  /** Faza: grow → peak → contain → done. */
  phase: 'grow' | 'peak' | 'contain' | 'done';
  /** Opis skutków pokazywany w UI. */
  label: string;
  /** Epicentrum = dokładny punkt kliknięcia (metry lokalne). */
  cx: number;
  cz: number;
  /** Budynek docelowy (OSM index lub id gracza). */
  targetBuildingId?: number;
  targetBuildingKind?: 'osm' | 'player';
  targetLabel?: string;
  /** Szacunek mieszkańców w zasięgu – z gęstości zabudowy okolicy. */
  affectedResidents?: number;
  /** Promień strefy wpływu (metry lokalne) – zapisany przy starcie. */
  radius?: number;
  /** Budynki w strefie (OSM index lub id gracza). */
  affectedBuildings?: AffectedBuildingRef[];
  /** Skrót skutków / komunikatów dla historii i UI. */
  consequences?: string[];
  /** Ostatni komunikat fazy (unikamy spamowania). */
  lastNotice?: string;
}

export interface NewStop {
  roadId: number;
  mode: 'bus' | 'tram';
  name: string;
  cost: number;
  at: number;
}

export interface PlayerChange {
  roadId: number;
  name: string;
  change: 'closed' | 'cars-only' | 'stop-bus' | 'stop-tram' | 'destroyed' | 'opened';
}

/** Jedna akcja gracza – lista zmian, którą da się cofnąć. */
export interface UndoAction {
  label: string;
  at: number;
  apply: () => void;
  revert: () => void;
}

const rnd = mulberry32(4242);

export class PlayerHistory {
  private stack: UndoAction[] = [];
  private redoStack: UndoAction[] = [];
  limit = 40;

  push(a: UndoAction) {
    this.stack.push(a);
    if (this.stack.length > this.limit) this.stack.shift();
    this.redoStack.length = 0;
  }
  get canUndo() { return this.stack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get depth() { return this.stack.length; }
  get lastLabel() { return this.stack[this.stack.length - 1]?.label ?? ''; }
  undo(): string | null {
    const a = this.stack.pop();
    if (!a) return 'Nie ma czego cofać.';
    a.revert();
    this.redoStack.push(a);
    return `Cofnięto: ${a.label}.`;
  }
  redo(): string | null {
    const a = this.redoStack.pop();
    if (!a) return 'Nie ma czego ponowić.';
    a.apply();
    this.stack.push(a);
    return `Ponowiono: ${a.label}.`;
  }
  clear() { this.stack.length = 0; this.redoStack.length = 0; }
  list(): { label: string; at: string }[] {
    return this.stack.map((a) => ({ label: a.label, at: new Date(a.at).toLocaleTimeString('pl-PL') }));
  }
}

/** Nazwy katastrof / scenariuszy i koszt w budżecie (zł). */
export const DISASTERS = {
  fire: { label: 'Pożar', cost: 900_000, radius: 220, count: 2 },
  flood: { label: 'Powódź', cost: 1_300_000, radius: 500, count: 7 },
  blackout: { label: 'Awaria infrastruktury', cost: 700_000, radius: 320, count: 3 },
  earthquake: { label: 'Przeciążenie transportu', cost: 1_600_000, radius: 700, count: 9 },
  heat: { label: 'Fala upałów', cost: 550_000, radius: 900, count: 4 },
  rain: { label: 'Ekstremalne opady', cost: 1_100_000, radius: 550, count: 6 },
  /** Alarm cywilny – skutki dla miasta/mieszkańców, bez fizyki ataku. */
  airRaid: { label: 'Zagrożenie nalotem', cost: 1_200_000, radius: 450, count: 5 },
  /** Kryzys urbanistyczny / odporność miasta – bez modelowania broni. */
  contamination: { label: 'Ekstremalne skażenie', cost: 1_500_000, radius: 380, count: 6 },
} as const;

/** Efekty katastrof na metryki – jawnie odseparowane od danych. */
export const DISASTER_EFFECTS = {
  fire: { satisfaction: -14, pollution: +22, noise: +6, speed: 0.9 },
  flood: { satisfaction: -11, pollution: +6, noise: +4, speed: 0.72 },
  blackout: { satisfaction: -8, pollution: +2, noise: -8, speed: 0.86 },
  earthquake: { satisfaction: -18, pollution: +14, noise: +16, speed: 0.8 },
  heat: { satisfaction: -10, pollution: +8, noise: -2, speed: 0.88 },
  rain: { satisfaction: -9, pollution: +4, noise: +3, speed: 0.75 },
  airRaid: { satisfaction: -16, pollution: +3, noise: +18, speed: 0.68 },
  contamination: { satisfaction: -20, pollution: +26, noise: +8, speed: 0.62 },
} as const;

/** Katastrofy z fazami grow → peak → contain (jak pożar/powódź). */
export const PHASED_DISASTERS = new Set<DisasterKind>([
  'fire', 'flood', 'airRaid', 'contamination',
]);

/** Poziom wizualny katastrofy na podstawie intensywności. */
export function disasterLevel(intensity: number): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
  if (intensity >= 0.85) return 'CRITICAL';
  if (intensity >= 0.6) return 'HIGH';
  if (intensity >= 0.35) return 'MEDIUM';
  return 'LOW';
}

/** Wpływ aktywnych katastrof na bieżący ruch i zadowolenie. */
export function disasterPenalty(active: DisasterState[]): { speed: number; satisfaction: number; pollution: number; noise: number } {
  let speed = 1, satisfaction = 0, pollution = 0, noise = 0;
  for (const d of active) {
    const e = DISASTER_EFFECTS[d.kind];
    const k = d.intensity;
    speed *= 1 + (e.speed - 1) * k;
    satisfaction += e.satisfaction * k;
    pollution += e.pollution * k;
    noise += e.noise * k;
  }
  return { speed, satisfaction, pollution, noise };
}

/** Najbliższe odcinki wokół punktu – odległość do środka odcinka (nie losowa). */
export function pickRoads<T extends { edge: { ax: number; az: number; bx: number; bz: number } }>(
  roads: T[],
  cx: number,
  cz: number,
  radius: number,
  count: number,
  filter: (r: T) => boolean,
): T[] {
  const scored = roads
    .filter(filter)
    .map((r) => {
      const mx = (r.edge.ax + r.edge.bx) * 0.5;
      const mz = (r.edge.az + r.edge.bz) * 0.5;
      return { r, dist: Math.hypot(mx - cx, mz - cz) };
    })
    .filter((x) => x.dist <= radius)
    .sort((a, b) => a.dist - b.dist);
  return scored.slice(0, Math.max(0, count)).map((x) => x.r);
}
