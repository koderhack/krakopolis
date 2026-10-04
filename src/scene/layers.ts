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
  { id: 'base', label: 'Podłoże i zieleń', hint: 'Teren, parki i woda', defaultOn: true },
  { id: 'basemap', label: 'Mapa satelitarna', hint: 'Zdjęcie miasta pod budynkami', defaultOn: true },
  { id: 'trees', label: 'Drzewa', hint: 'Drzewa w parkach i na skwerach', defaultOn: true },
  { id: 'roads', label: 'Sieć drogowa', hint: 'Ulice Krakowa', defaultOn: true },
  { id: 'traffic', label: 'Kolor ruchu', hint: 'Jak bardzo zatłoczone są ulice', defaultOn: true },
  { id: 'buildings', label: 'Budynki 3D', hint: 'Bryły budynków', defaultOn: true },
  { id: 'transit', label: 'Transport MPK', hint: 'Trasy, przystanki i pojazdy', defaultOn: true },
  { id: 'live', label: 'Pojazdy na żywo', hint: 'Prawdziwe tramwaje i autobusy jadące teraz', defaultOn: true, observed: true },
  { id: 'pedestrians', label: 'Piesi', hint: 'Przechodnie na ulicach', defaultOn: true },
  { id: 'pedflow', label: 'Ruch pieszy', hint: 'Gdzie chodzi najwięcej ludzi', defaultOn: false },
  { id: 'labels', label: 'Nazwy miejsc', hint: 'Podpisy na mapie', defaultOn: false, observed: true },
  { id: 'disasters', label: 'Katastrofy i zniszczenia', hint: 'Pożar, powódź, nalot, skażenie i inne', defaultOn: true },
];

export const defaultLayers = (): Set<string> => new Set(LAYERS.filter((l) => l.defaultOn).map((l) => l.id));