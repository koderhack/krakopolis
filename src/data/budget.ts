/**
 * Budżet gry oparty o publiczne dane budżetu Miasta Krakowa 2025.
 * Źródło: uchwała RMK / komunikat Magiczny Kraków – dochody ~9,1 mld zł,
 * wydatki inwestycyjne ~1 mld zł (w tym ~19 mln w dyspozycji dzielnic).
 *
 * W symulacji obszaru centrum używamy funduszu inwestycyjnego obszaru
 * (szacunek udziału mapy w inwestycjach miasta) – oznaczony jako OBSERVED baseline.
 */
export const KRAKOW_BUDGET_2025 = {
  year: 2025,
  cityIncomePln: 9_100_000_000,
  citySpendPln: 9_800_000_000,
  cityInvestmentsPln: 1_000_000_000,
  districtsInvestmentsPln: 19_000_000,
  source: 'https://www.krakow.pl/ – budżet Miasta Krakowa 2025',
  origin: 'OBSERVED' as const,
};

/**
 * Startowy fundusz gracza: udział inwestycyjny obszaru Starego Miasta / centrum
 * w budżecie miasta (szacunek modelu na bazie danych OBSERVED).
 * ~5,2% z programu inwestycyjnego 1 mld zł.
 */
export const START_BUDGET_PLN = Math.round(KRAKOW_BUDGET_2025.cityInvestmentsPln * 0.052);

/** Mnożnik kosztów katalogu względem starych jednostek gry → zł. */
export const COST_SCALE = 10_000;

/** Przychód budżetu na sekundę czasu symulacji (zł) – udział lokalny w dochodach. */
export const BUDGET_INCOME_PER_SEC =
  Math.round((KRAKOW_BUDGET_2025.cityIncomePln * 0.002) / (365 * 24 * 3600)); // ~0.6 zł/s → za mało

/** Realistyczniejszy dopływ na potrzeby demo: ~25 tys. zł / h czasu symulacji. */
export const BUDGET_INCOME_PER_SIM_SEC = 7;

export function formatBudgetPln(v: number): string {
  const n = Math.round(v);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} mln zł`;
  if (Math.abs(n) >= 1_000) return `${Math.round(n / 1_000).toLocaleString('pl-PL')} tys. zł`;
  return `${n.toLocaleString('pl-PL')} zł`;
}
