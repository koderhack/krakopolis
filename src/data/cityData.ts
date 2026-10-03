// Schemat danych miasta. Każde źródło (demo, Overpass/OSM, GTFS MPK Kraków) musi zwrócić CityData.
export interface NodeD { id: number; x: number; z: number }
export interface EdgeD { id: number; name: string; a: number; b: number; speedLimit: number; pedestrian: boolean }
export interface StopD { edge: number; name: string }
export interface RouteD { ref: string; kind: 'tram' | 'bus'; nodes: number[]; count: number }
export interface CityData { source: string; nodes: NodeD[]; edges: EdgeD[]; stops: StopD[]; routes: RouteD[] }

// Lokalne współrzędne w metrach: (0,0) = środek Rynku Głównego, +x wschód, +z południe (Wawel).
const P: [number, number][] = [
  [-400, -300], [0, -300], [400, -300], [400, 0], [400, 300], [0, 300], [-400, 300], [-400, 0], // 0-7 obwodnica wokół Plant
  [-100, -100], [0, -100], [100, -100], [100, 0], [100, 100], [0, 100], [-100, 100], [-100, 0], // 8-15 obwód Rynku
  [-200, -300], [200, -300], [-200, 300], [200, 300], [0, 520], // 16-19 dodatkowe węzły, 20 Wawel
];
// [węzeł A, węzeł B, nazwa, limit prędkości m/s]
const E: [number, number, string, number][] = [
  [0, 16, 'Basztowa', 14], [16, 1, 'Basztowa', 14], [1, 17, 'Dunajewskiego', 14], [17, 2, 'Dunajewskiego', 14],
  [2, 3, 'Lubicz', 14], [3, 4, 'Lubicz', 14], [4, 19, 'Dietla', 14], [19, 5, 'Dietla', 14],
  [5, 18, 'Podwale', 14], [18, 6, 'Podwale', 14], [6, 7, 'Podwale', 14], [7, 0, 'Podwale', 14],
  [8, 9, 'Rynek Główny', 6], [9, 10, 'Rynek Główny', 6], [10, 11, 'Rynek Główny', 6], [11, 12, 'Rynek Główny', 6],
  [12, 13, 'Rynek Główny', 6], [13, 14, 'Rynek Główny', 6], [14, 15, 'Rynek Główny', 6], [15, 8, 'Rynek Główny', 6],
  [1, 9, 'Floriańska', 8], [3, 11, 'Sienna', 8], [5, 13, 'Grodzka', 8], [7, 15, 'Szewska', 8],
  [16, 8, 'Sławkowska', 8], [17, 10, 'Św. Jana', 8], [18, 14, 'Dominikańska', 8], [19, 12, 'Poselska', 8],
  [5, 20, 'Grodzka', 10], [18, 20, 'Podzamcze', 10], [19, 20, 'Stradomska', 10],
];
const S: [number, number, string][] = [
  [16, 1, 'Basztowa'], [17, 2, 'Dunajewskiego'], [3, 4, 'Lubicz'], [19, 5, 'Dietla'], [18, 6, 'Podwale'], [7, 0, 'Podwale'],
  [1, 9, 'Floriańska'], [5, 13, 'Grodzka'], [7, 15, 'Szewska'], [3, 11, 'Sienna'], [17, 10, 'Św. Jana'], [19, 12, 'Poselska'], [5, 20, 'Wawel'],
];

const nodes: NodeD[] = P.map(([x, z], id) => ({ id, x, z }));
const edges: EdgeD[] = E.map(([a, b, name, speedLimit], id) => ({ id, name, a, b, speedLimit, pedestrian: false }));
const find = (a: number, b: number) => edges.find((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a))!.id;

export const demoCity: CityData = {
  source: 'Dane demonstracyjne: schematyczny układ Starego Miasta (to nie są dane OSM ani MPK)',
  nodes,
  edges,
  stops: S.map(([a, b, name]) => ({ edge: find(a, b), name })),
  routes: [
    { ref: '18', kind: 'tram', nodes: [0, 1, 2, 4, 5, 6], count: 2 },
    { ref: '52', kind: 'tram', nodes: [6, 5, 4, 2, 1, 0], count: 2 },
    { ref: '124', kind: 'bus', nodes: [1, 9, 15, 7], count: 2 },
    { ref: '152', kind: 'bus', nodes: [5, 13, 11, 3], count: 2 },
    { ref: '194', kind: 'bus', nodes: [17, 10, 12, 19], count: 2 },
  ],
};

/**
 * Adapter danych. Tutaj podłącz prawdziwe źródła, zwracając ten sam schemat CityData:
 *  - drogi i budynki: Overpass API (OpenStreetMap) dla bbox Starego Miasta, rzutowane na metry lokalne,
 *  - trasy i przystanki: GTFS ZTP Kraków.
 * Bez dostępu do sieci aplikacja zawsze działa na demoCity.
 */
export async function loadCityData(): Promise<CityData> {
  return demoCity;
}
