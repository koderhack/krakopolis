/**
 * Obserwacje i przewidywania po planowanej / zatwierdzonej zmianie.
 * To SZACUNEK MODELU (SIMULATED) – nie „AI predictions”.
 */
import type { BuildSpec } from './city/catalog';
import type { Sim } from './sim';
import { formatBudgetPln } from '../data/budget';

export type ImpactLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Confidence = 'wysoka' | 'średnia' | 'niska';

export interface Observation {
  text: string;
  kind: 'info' | 'warn' | 'good';
  confidence: Confidence;
}

export interface ImpactRow {
  label: string;
  level: ImpactLevel;
  delta?: string;
}

export interface ConsequenceReport {
  title: string;
  summary: string;
  observations: Observation[];
  impacts: ImpactRow[];
  horizons: { label: string; note: string }[];
  estimatedResidents: number;
  estimatedJobs: number;
  cost: number;
}

function levelFromAbs(n: number, lo: number, mid: number): ImpactLevel {
  const a = Math.abs(n);
  if (a < lo) return 'LOW';
  if (a < mid) return 'MEDIUM';
  return 'HIGH';
}

/** Raport przed zatwierdzeniem budowy z katalogu. */
export function previewBuild(spec: BuildSpec, nearTraffic = 0.35): ConsequenceReport {
  const res = spec.residents;
  const jobs = spec.jobs;
  const trafficPush = res * 0.08 + jobs * 0.12;
  const schoolNeed = res > 20 ? Math.round(res / 25) : 0;
  const observations: Observation[] = [];

  if (res > 0) {
    observations.push({
      text: `Nowa zabudowa zwiększy liczbę mieszkańców o około ${res}.`,
      kind: 'info',
      confidence: 'średnia',
    });
  }
  if (jobs > 0) {
    observations.push({
      text: `Powstanie około ${jobs} miejsc pracy – wzrośnie dojazd do tego punktu.`,
      kind: 'good',
      confidence: 'średnia',
    });
  }
  if (trafficPush > 8 || nearTraffic > 0.55) {
    observations.push({
      text: nearTraffic > 0.55
        ? 'Najbliższe ulice mogą być mocno zatłoczone w godzinach szczytu.'
        : 'Przewidywany wzrost ruchu lokalnego – warto sprawdzić dojazd i parking.',
      kind: 'warn',
      confidence: 'niska',
    });
  }
  if (schoolNeed > 0) {
    observations.push({
      text: `Przy ${res} mieszkańcach rośnie zapotrzebowanie na miejsca w szkole (ok. ${schoolNeed} klas).`,
      kind: 'warn',
      confidence: 'niska',
    });
  }
  if (spec.id === 'park') {
    observations.push({
      text: 'Park poprawia zadowolenie i obniża hałas w najbliższym otoczeniu.',
      kind: 'good',
      confidence: 'średnia',
    });
  }
  if (spec.id === 'parking') {
    observations.push({
      text: 'Parking zmniejsza lokalne szukanie miejsca, ale zajmuje teren i generuje manewry aut.',
      kind: 'info',
      confidence: 'średnia',
    });
  }
  if (spec.id === 'hospital' || spec.id === 'school') {
    observations.push({
      text: `Budynek usługowy (${spec.label}) poprawia dostępność usług w promieniu pieszym.`,
      kind: 'good',
      confidence: 'średnia',
    });
  }
  if (!observations.length) {
    observations.push({
      text: 'Zmiana ma ograniczony wpływ na miasto.',
      kind: 'info',
      confidence: 'średnia',
    });
  }

  const impacts: ImpactRow[] = [
    { label: 'Mieszkańcy', level: levelFromAbs(res, 5, 20), delta: res ? `+${res}` : '0' },
    { label: 'Miejsca pracy', level: levelFromAbs(jobs, 5, 20), delta: jobs ? `+${jobs}` : '0' },
    { label: 'Ruch', level: levelFromAbs(trafficPush, 5, 15), delta: trafficPush > 2 ? '↑' : '≈' },
    { label: 'Usługi', level: ['school', 'kindergarten', 'hospital', 'shop'].includes(spec.id) ? 'HIGH' : 'LOW', delta: ['school', 'kindergarten', 'hospital', 'shop'].includes(spec.id) ? '↑' : '≈' },
    { label: 'Środowisko', level: spec.id === 'park' ? 'MEDIUM' : trafficPush > 10 ? 'MEDIUM' : 'LOW', delta: spec.id === 'park' ? '↑' : trafficPush > 10 ? '↓' : '≈' },
    { label: 'Koszt', level: levelFromAbs(spec.cost, 2_000_000, 6_000_000), delta: formatBudgetPln(spec.cost) },
  ];

  return {
    title: `Plan: ${spec.label}`,
    summary: `${spec.desc} · koszt ${formatBudgetPln(spec.cost)} · ${spec.w}×${spec.d} m.`,
    observations,
    impacts,
    horizons: [
      { label: 'TERAZ', note: 'Natychmiastowa zmiana budżetu i lokalnego ruchu.' },
      { label: '1 ROK', note: res || jobs ? 'Stabilizacja dojazdów i obciążenia usług.' : 'Bez istotnych zmian długoterminowych.' },
      { label: '5 LAT', note: 'Długoterminowy wpływ trudny do przewidzenia.' },
      { label: '10 LAT', note: 'Za daleko w przyszłość – pomijamy.' },
    ],
    estimatedResidents: res,
    estimatedJobs: jobs,
    cost: spec.cost,
  };
}

/** Raport po zatwierdzeniu – porównanie metryk sprzed i po. */
export function reportAfterApply(
  label: string,
  before: { traffic: number; satisfaction: number; pedestrians: number; pollution: number; transit: number },
  after: { traffic: number; satisfaction: number; pedestrians: number; pollution: number; transit: number },
  extra?: Observation[],
): ConsequenceReport {
  const dT = after.traffic - before.traffic;
  const dS = after.satisfaction - before.satisfaction;
  const observations: Observation[] = [
    ...(extra ?? []),
    {
      text: `Ruch ${dT >= 0 ? 'wzrosł' : 'spadł'} o ok. ${Math.abs(dT).toFixed(1)} pkt.`,
      kind: dT > 3 ? 'warn' : dT < -2 ? 'good' : 'info',
      confidence: 'średnia',
    },
    {
      text: `Zadowolenie ${dS >= 0 ? 'wzrosło' : 'spadło'} o ok. ${Math.abs(dS).toFixed(1)} pkt.`,
      kind: dS > 1 ? 'good' : dS < -2 ? 'warn' : 'info',
      confidence: 'średnia',
    },
  ];
  return {
    title: `Zatwierdzono: ${label}`,
    summary: 'Efekt Twojej decyzji w mieście.',
    observations,
    impacts: [
      { label: 'Ruch', level: levelFromAbs(dT, 2, 6), delta: `${dT >= 0 ? '+' : ''}${dT.toFixed(1)}` },
      { label: 'Zadowolenie', level: levelFromAbs(dS, 1, 4), delta: `${dS >= 0 ? '+' : ''}${dS.toFixed(1)}` },
      { label: 'Piesi', level: levelFromAbs(after.pedestrians - before.pedestrians, 2, 8), delta: `${(after.pedestrians - before.pedestrians) >= 0 ? '+' : ''}${(after.pedestrians - before.pedestrians).toFixed(1)}` },
      { label: 'Smog', level: levelFromAbs(after.pollution - before.pollution, 1, 4), delta: `${(after.pollution - before.pollution) >= 0 ? '+' : ''}${(after.pollution - before.pollution).toFixed(1)}` },
      { label: 'Transport', level: levelFromAbs(after.transit - before.transit, 1, 4), delta: `${(after.transit - before.transit) >= 0 ? '+' : ''}${(after.transit - before.transit).toFixed(1)}` },
    ],
    horizons: [
      { label: 'TERAZ', note: 'Bieżący stan miasta.' },
      { label: '1 ROK', note: 'Przy utrzymaniu kierunku zmian – przybliżenie.' },
      { label: '5 LAT', note: 'Długoterminowy wpływ trudny do przewidzenia.' },
      { label: '10 LAT', note: 'Za daleko w przyszłość – pomijamy.' },
    ],
    estimatedResidents: 0,
    estimatedJobs: 0,
    cost: 0,
  };
}

export function metricsSnapshot(sim: Sim) {
  const m = sim.m;
  return {
    traffic: m.traffic,
    satisfaction: m.satisfaction,
    pedestrians: m.pedestrians,
    pollution: m.pollution,
    transit: m.transit,
  };
}

/** Raport przed uruchomieniem scenariusza katastrofy (szacunek). */
export function previewDisasterReport(p: {
  label: string;
  cost: number;
  roads: number;
  radius: number;
  estimatedAffected: number;
  effects: { satisfaction: number; pollution: number; noise: number; speed: number };
}): ConsequenceReport {
  return {
    title: `Scenariusz: ${p.label}`,
    summary: `Promień ~${Math.round(p.radius)} m · ${p.roads} ulic zagrożonych · ok. ${p.estimatedAffected} osób · koszt ${formatBudgetPln(p.cost)}.`,
    observations: [
      {
        text: `Potencjalnie dotkniętych ok. ${p.estimatedAffected} mieszkańców.`,
        kind: 'warn',
        confidence: 'niska',
      },
      {
        text: `Zadowolenie ok. ${p.effects.satisfaction} pkt, smog ${p.effects.pollution >= 0 ? '+' : ''}${p.effects.pollution}, prędkość ruchu ×${p.effects.speed.toFixed(2)}.`,
        kind: 'info',
        confidence: 'średnia',
      },
      {
        text: 'Enter uruchamia scenariusz. Esc anuluje podgląd.',
        kind: 'info',
        confidence: 'wysoka',
      },
    ],
    impacts: [
      { label: 'Mieszkańcy', level: levelFromAbs(p.estimatedAffected, 80, 400), delta: `~${p.estimatedAffected}` },
      { label: 'Ruch', level: p.effects.speed < 0.8 ? 'HIGH' : 'MEDIUM', delta: `×${p.effects.speed.toFixed(2)}` },
      { label: 'Infrastruktura', level: p.roads > 5 ? 'HIGH' : 'MEDIUM', delta: `${p.roads} ulic` },
      { label: 'Środowisko', level: levelFromAbs(p.effects.pollution, 5, 15), delta: `${p.effects.pollution >= 0 ? '+' : ''}${p.effects.pollution}` },
      { label: 'Koszt', level: levelFromAbs(p.cost, 600_000, 1_200_000), delta: formatBudgetPln(p.cost) },
    ],
    horizons: [
      { label: 'TERAZ', note: 'Scenariusz jeszcze nie uruchomiony – zatwierdź, by zacząć.' },
      { label: '1 ROK', note: 'Odbudowa zależy od Twoich kolejnych decyzji.' },
      { label: '5 LAT', note: 'Za daleko w przyszłość – pomijamy.' },
      { label: '10 LAT', note: 'Za daleko w przyszłość – pomijamy.' },
    ],
    estimatedResidents: p.estimatedAffected,
    estimatedJobs: 0,
    cost: p.cost,
  };
}
