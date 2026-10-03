/** Warstwy analizy – czytelne przełączniki, wyniki oznaczone jako szacunek modelu. */

export interface AnalysisLayerDef {
  id: string;
  label: string;
  hint: string;
  /** Mapowanie na istniejącą warstwę sceny (opcjonalnie). */
  mapLayer?: string;
  /** Czy wynik to szacunek (nie OBSERVED). */
  estimate: boolean;
}

export const ANALYSIS_LAYERS: AnalysisLayerDef[] = [
  { id: 'ax-traffic', label: 'Natężenie ruchu', hint: 'Obciążenie odcinków z modelu ruchu', mapLayer: 'traffic', estimate: true },
  { id: 'ax-schools', label: 'Dostęp do szkół', hint: 'Szacunek odległości do obiektów edukacyjnych', estimate: true },
  { id: 'ax-services', label: 'Dostęp do usług', hint: 'Szacunek dostępu do sklepów i biur', estimate: true },
  { id: 'ax-transit', label: 'Dostęp do transportu', hint: 'Przystanki i trasy MPK', mapLayer: 'transit', estimate: false },
  { id: 'ax-density', label: 'Gęstość mieszkańców', hint: 'Przybliżenie z zabudowy (szacunek)', estimate: true },
  { id: 'ax-infra', label: 'Obciążenie infrastruktury', hint: 'Predykcja obciążenia sieci', mapLayer: 'traffic', estimate: true },
  { id: 'ax-flood', label: 'Ryzyko powodzi', hint: 'Scenariusz modelu – nie mapa zagrożeń IMGW', estimate: true },
  { id: 'ax-fire', label: 'Ryzyko pożaru', hint: 'Scenariusz modelu – nie dane PSP', estimate: true },
  { id: 'ax-problem', label: 'Obszary problemowe', hint: 'Wysokie obciążenie + niska satysfakcja (szacunek)', estimate: true },
];

export type AnalysisId = (typeof ANALYSIS_LAYERS)[number]['id'];

/** Prosty tooltip dla odcinka w trybie analizy. */
export function analysisTooltip(
  analysis: Set<string>,
  roadLevel: number,
  prevLevel: number,
): { title: string; lines: string[] } | null {
  if (!analysis.size) return null;
  const pct = Math.round(Math.min(1.2, Math.max(0, roadLevel)) * 100);
  const delta = Math.round((roadLevel - prevLevel) * 100);
  if (analysis.has('ax-traffic') || analysis.has('ax-infra') || analysis.has('ax-problem')) {
    const high = pct >= 75;
    return {
      title: high ? 'WYSOKIE OBCIĄŻENIE' : pct >= 45 ? 'ŚREDNIE OBCIĄŻENIE' : 'NISKIE OBCIĄŻENIE',
      lines: [
        `${pct}% przepustowości (szacunek modelu)`,
        `${delta >= 0 ? '+' : ''}${delta}% względem baseline`,
      ],
    };
  }
  if (analysis.has('ax-flood')) {
    return {
      title: 'RYZYKO POWODZI',
      lines: ['Scenariusz modelu – nie oficjalna mapa zagrożeń.', 'Pewność: niska'],
    };
  }
  if (analysis.has('ax-fire')) {
    return {
      title: 'RYZYKO POŻARU',
      lines: ['Scenariusz modelu – nie dane PSP.', 'Pewność: niska'],
    };
  }
  if (analysis.has('ax-schools') || analysis.has('ax-services') || analysis.has('ax-density')) {
    return {
      title: 'SZACUNEK DOSTĘPNOŚCI',
      lines: ['Wartość przybliżona z lokalnego modelu.', 'Pewność: niska / średnia'],
    };
  }
  if (analysis.has('ax-transit')) {
    return {
      title: 'TRANSPORT',
      lines: ['Warstwa GTFS / symulacja MPK'],
    };
  }
  return null;
}
