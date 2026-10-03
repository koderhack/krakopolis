/** Warstwy mapy – każdą można włączać i wyłączać w panelu bocznym. */
export interface LayerDef {
  id: string;
  label: string;
  hint: string;
  defaultOn: boolean;
  /** Czy to warstwa danych zewnętrznych (a nie symulacji). */
  observed?: boolean;
}

export const LAYERS: LayerDef[] = [
  { id: 'base', label: 'Podłoże i zieleń', hint: 'Teren, parki i woda z OpenStreetMap', defaultOn: true },
  { id: 'basemap', label: 'Mapa satelitarna', hint: 'Ortofotomapa (Esri) pod miastem – drogi i budynki na realnym podkładzie', defaultOn: true },
  { id: 'trees', label: 'Drzewa', hint: 'Drzewa i krzewy na terenach zielonych z OSM (parki, Planty, skwery)', defaultOn: true },
  { id: 'roads', label: 'Sieć drogowa', hint: 'Realne ulice z OSM', defaultOn: true },
  { id: 'traffic', label: 'Kolor ruchu', hint: 'Obciążenie odcinków (baseline / predykcja / symulacja)', defaultOn: true },
  { id: 'buildings', label: 'Budynki 3D', hint: 'Bryły z prawdziwych obrysów OSM', defaultOn: true },
  { id: 'transit', label: 'Transport MPK', hint: 'Trasy, przystanki i pojazdy symulowane na GTFS', defaultOn: true },
  { id: 'live', label: 'Realne pojazdy (LIVE)', hint: 'Pojazdy z GTFS-RT – dane OBSERVED', defaultOn: true, observed: true },
  { id: 'pedestrians', label: 'Piesi', hint: 'Agenci symulacji (SIMULATED)', defaultOn: true },
  { id: 'pedflow', label: 'Ruch pieszy (heatmap)', hint: 'Natężenie pieszych na odcinkach – SIMULATED', defaultOn: false },
  { id: 'labels', label: 'Nazwy i mapy', hint: 'Etykiety miejsc – wyłączone domyślnie (kosztowne)', defaultOn: false, observed: true },
  { id: 'disasters', label: 'Katastrofy i zniszczenia', hint: 'Pożar, powódź, blackout, trzęsienie ziemi', defaultOn: true },
];

export const defaultLayers = (): Set<string> => new Set(LAYERS.filter((l) => l.defaultOn).map((l) => l.id));