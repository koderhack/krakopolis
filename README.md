# SimCity Kraków

**3D symulacja Krakowa napędzana prawdziwymi publicznymi danymi miejskimi,
z symulowanymi konsekwencjami decyzji gracza.**

Drogi, budynki, przystanki i trasy komunikacji pochodzą z OpenStreetMap i z
oficjalnego GTFS Zarządu Transportu Publicznego w Krakowie. Realne pojazdy MPK
są czytane z GTFS-RT (pozycje GPS co 15–30 s) i renderowane w miejscu, w którym
naprawdę się znajdują. Gracz zamienia ulice, strefy piesze i przystanki — a
symulacja liczy, jak zmienia się rozkład ruchu na prawdziwej sieci drogowej.

## Uruchomienie

```bash
npm install
npm run ingest      # pobiera prawdziwe dane do public/data (jednorazowo, ~10–20 min)
npm run dev         # http://localhost:5173
```

`npm run ingest` potrzebuje sieci. Bez niego aplikacja nie ma czego pokazać —
nie ma w repo żadnych wymyślonych danych zapasowych, które udawałyby prawdziwe.

```bash
npm run sim:test    # smoke test silnika na prawdziwych danych
npm run build       # kontrola typów + build produkcyjny
npm run preview     # podgląd builda (proxy danych działa też tutaj)
```

## Skąd biorą się dane

Pełny opis źródeł, formatów i tego, **czego publicznie nie ma**, jest w
[`DATA_SOURCES.md`](./DATA_SOURCES.md). W skrócie:

| Warstwa | Źródło | Status |
|---|---|---|
| Drogi, budynki, zieleń, woda, światła | OpenStreetMap / Overpass API | `CACHED` |
| Linie, przystanki, trasy, kształty | ZTP Kraków, GTFS (T/A/M) | `CACHED` |
| **Realne pojazdy MPK** | ZTP Kraków, GTFS-RT `VehiclePositions` | **`LIVE`** |
| Ruch drogowy (poziom zastoju) | ZTP Kraków, `congestion_level` z GTFS-RT | **`LIVE`** |
| Pogoda | Open-Meteo | **`LIVE`** |
| Jakość powietrza | Open-Meteo Air Quality (model CAMS) | `PREDICTED` |

Kraków **nie publikuje** otwartego API z natężeniem ruchu drogowego ani liczbą
pieszych. Zamiast zmyślać te liczby, używamy tego, co jest: `congestion_level`
z GTFS-RTPoziom zastoju raportowany przez ZTP dla każdego pojazdu. Reszta jest
jawnie oznaczona jako `PREDICTED`.

## Trzy kategorie danych — nigdy nie mieszane

Każda liczba w interfejsie ma przypisane pochodzenie:

* **OBSERVED** — wprost z publicznego źródła. Przykład: pozycja GPS tramwaju
  linii 18 z `VehiclePositions_T.pb`, poziom zastoju `congestion_level = 3`.
* **PREDICTED** — policzone z danych zaobserwowanych. Przykład: po zamknięciu
  ulicy przypisanie ruchu daje na obwodnicy 92 % zamiast 80 %; prędkość
  z dwóch kolejnych pozycji tego samego pojazdu.
* **SIMULATED** — wygenerowane przez grę. Przykład: 130 poruszających się aut,
  sylwetki pieszych, poziom smogu w metrykach.

Przycisk **Kolor: dane / predykcja / symulacja** pod sceną przełącza, co dokładnie
widoczne na jezdniach. Panel po prawej pokazuje dla wybranego odcinka dwie liczby
niezależnie: `DANE ŹRÓDŁOWE` (nieruszone przez grę) i `PREDYKCJA SYMULACJI`.

## Jak to jest zbudowane

```
scripts/ingest.ts          pobiera prawdziwe dane → public/data/*.json
src/data/
  config.ts                adresy źródeł, interwały odświeżania
  geo.ts                   obszar i lokalna projekcja metry (0,0 = Rynek Główny)
  types.ts                 CityState / RoadState / VehicleState + pochodzenie danych
  baked.ts                 format plików offline
  sources/
    mpk/gtfsrt.ts          dekoder protobuf dla GTFS-RT (bez zależności)
    mpk/live.ts            live: pozycje pojazdów; fallback: migawka
    environment/live.ts    Open-Meteo: pogoda i jakość powietrza
  adapters/cityAdapter.ts  surowe dane → wewnętrzny CityData
  cache/store.ts           cache przeglądarki, liczenie wieku danych
  pipeline.ts              cykl: pobierz → zwaliduj → znormalizuj → podmień
src/simulation/
  graph.ts                 graf z OSM, Dijkstra, czas przejazdu (BPR)
  traffic/assignment.ts    predykcja rozkładu ruchu (przyrostowe przypisanie)
  pedestrians/agents.ts    agenci symulacji
  sim.ts                   baseline + playerChanges → simulatedFutureState
src/scene/                 R3F: teren, drogi, budynki, pojazdy, piesi
src/ui/                    HUD + panel źródeł danych
```

**Silnik symulacji nie wykonuje zapytań sieciowych.** Dostaje gotowy `CityData`
i nakłada na niego decyzje gracza. Dane źródłowe nigdy nie są nadpisywane przez
gracza — `baseline` i `predicted` to osobne pola.

## Realistyczne modele

Tramwaj (21,4 m): dwie bryły nadwozia z zaokrąglonymi krawędziami, pas okien,
listwa, dach, pantograf, dwa bogie, tablica z numerem linii (tekstura Canvas).
Autobus (12 m): nadwozie, zabudowa dachu, szyby, koła, tablica linii.
Piesi: sylwetka z głową, tułowiem, dwiema nogami i dwiema ramionami
z animowanym krokiem oraz wahaniem wysokości; sylwetki mają indywidualny wzrost
i kolor skóry, ubrania i wariant.

W scenie widać też **zielone pierścienie** pod realnymi pojazdami z GTFS-RT —
to jednoznaczny znak, że dana bryła to obserwacja, a nie agent gry.

## Demo (HackYeah)

1. Otwiera się 3D mapa Krakowa z realnymi ulicami, budynkami i przystankami.
2. Panel danych pokazuje, co jest `LIVE`, a co `CACHED`, z czasem odczytu.
3. Zielone pierścienie pod tramwajami i autobusami oznaczają realne pojazdy.
4. Gracz klika prawdziwą ulicę — panel pokazuje `OBSERVED` z danych źródłowych.
5. „Zamknij ulicę” → barierki w 3D, natychmiastowa predykcja objazdów.
6. Przełączenie „Kolor: dane / predykcja” pokazuje różnicę.
7. Metryki miasta (ruch, smog, hałas, zadowolenie) reagują na zmiany.

## Uwagi techniczne

* **CORS.** `gtfs.ztp.krakow.pl` i Overpass nie wysyłają nagłówków CORS, więc
  `vite.config.ts` robi przezroczyste proxy do tych samych, publicznych adresów
  (działa w `dev` i `preview`).
* **Wydajność.** Drogi, budynki, pojazdy i piesi są instancjonowane; przypisanie
  ruchu jest przyrostowe (kilka źródeł Dijkstry na krok), więc nie blokuje klatki.
* **Odświeżanie.** GTFS-RT co 15 s, pogoda co 10 min. Interwały da się nadpisać
  w URL: `?refresh=vehicles:10&refresh=traffic:20`.
* **Fallback.** Gdy API nie odpowiada, aplikacja pokazuje ostatni prawdziwy
  odczyt oznaczony `CACHED` z czasem, kiedy go zapisano. Nigdy nie podstawia
  wartości losowych.

## Licencje danych

OpenStreetMap — ODbL 1.0. Dane ZTP Kraków — zastrzeżone, dostępne publicznie na
`gtfs.ztp.krakow.pl`. Open-Meteo — CC BY 4.0. Kod aplikacji — MIT.