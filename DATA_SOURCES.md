# Źródła danych

Wszystko, co w tej aplikacji jest „prawdziwe”, pochodzi z publicznych, oficjalnych
źródeł. Poniżej dokładny spis: co zostało użyte, jaki jest format, skąd brano
konkretne rekordy i czego w danych **nie ma**.

## 1. OpenStreetMap — geografia

| | |
|---|---|
| Co | drogi, skrzyżowania ze światłami, budynki, zieleń, koryto Wisły |
| Źródło | [Overpass API](https://overpass-api.de/api/interpreter) |
| Licencja | ODbL 1.0 |
| Kiedy | `npm run ingest` (dane statyczne, oznaczane `CACHED`) |

Zapytanie (skrypt `scripts/ingest.ts`, funkcja `overpassQuery`):

```
way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian|footway|path|steps|track)$"](bbox);
way["building"](bbox);
way["railway"="tram"](bbox);
way["natural"="water"](bbox);
way["waterway"~"^(river|canal)$"](bbox);
way["landuse"~"^(grass|forest|meadow|cemetery|recreation_ground)$"](bbox);
way["leisure"~"^(park|garden)$"](bbox);
node["highway"="traffic_signals"](bbox);
out geom;
```

Obszar symulacji: `50.0525–50.0700 N`, `19.9260–19.9480 E`
(Stare Miasto, Kazimierz, Wawel, Planty) — ~1,9 × 1,6 km.

Obszar dzielony jest na 12 kafelków, bo Overpass zwraca 504 na dużych zapytaniach.

**Jak powstaje graf dróg.** Każdy `way` z tagiem `highway` rozbijamy na odcinki
między kolejnymi węzłami OSM. Węzły scalone są z kwantyzacją do 25 cm, więc
skrzyżowania w różnych kafelkach trafiają do jednego punktu. Klasa drogi, `maxspeed`,
`oneway`, `lanes` i `name` pochodzą wyłącznie z tagów OSM. Szerokość jezdni
w scenie 3D jest **PREDICTED** — liczona z klasy drogi i liczby pasów, bo OSM nie
przechowuje szerokości jezdni.

**Wysokości budynków** z tagów `height` / `building:levels`. Gdy ich brak —
wartość domyślna dla typu budynku (12 m dla `yes`, 18 m dla `apartments`, 20 m dla
`office`, 16 m dla `church` itd.). Ten fallback jest oznaczony w UI.

## 2. ZTP Kraków — rozkłady jazdy (GTFS)

| | |
|---|---|
| Co | linie, przystanki, trasy, kształty, kursy |
| Źródło | [gtfs.ztp.krakow.pl](https://gtfs.ztp.krakow.pl/) |
| Pliki | `GTFS_KRK_T.zip` (tramwaje, ZTP), `GTFS_KRK_A.zip` (autobusy, MPK), `GTFS_KRK_M.zip` (autobusy, Mobilis) |
| Licencja | dane ZTP Kraków |

Indeks feedu sprawdzony na żywo (`https://gtfs.ztp.krakow.pl/`) —
aktualizowane codziennie, wersja np. `20261002`.

W skrypcie używamy: `stops.txt`, `routes.txt`, `trips.txt`, `shapes.txt`.
`stop_times.txt` (140 MB dla autobusów) celowo **pomijamy** — kolejność
przystanków odtwarzamy z kształtu trasy (`shapes.txt`), co daje identyczny wynik
przy 20× mniejszym pliku.

**Mapowanie na graf dróg.** Punkty kształtu rzutowane są na lokalne metry
i dopasowywane do najbliższego odcinka drogi (siatka przestrzenna, tolerancja 110 m).
Kolejne dopasowania tworzą sekwencję węzłów, po której jedzie symulowany pojazd.
Kształt jest jednocześnie renderowany w 3D jako realna geometria toru.

## 3. ZTP Kraków — realne pojazdy (GTFS-RT)

| | |
|---|---|
| Co | **realne pozycje tramwajów i autobusów**, kurs, poziom zakrzepienia |
| Źródło | `https://gtfs.ztp.krakow.pl/VehiclePositions_T.pb` (i `_A.pb`, `_M.pb`) |
| Format | binarny GTFS-RT `FeedMessage` (protobuf) |
| Interwał | 15 s (konfigurowalne) |

To jest jedyne miejsce, w którym pojawiają się **realne pojazdy**. Sprawdzone
na żywo: feed tramwajowy zwraca ~128 encji, autobusowy ~272, w obszarze
symulacji zostaje kilkadziesiąt.

Feed jest obsługiwany przez własny, minimalny dekoder protobuf
(`src/data/sources/mpk/gtfsrt.ts`) — brak zależności, ~180 linii.
Odczytane pola:

```
FeedMessage      { 1 header, 2 entity }
FeedEntity       { 1 id, 4 vehicle }
VehiclePosition  { 1 trip, 2 position, 3 stop_sequence, 4 timestamp,
                   5 congestion_level, 6 stop_id, 7 occupancy_status }
TripDescriptor   { 1 trip_id, 5 route_id, 6 direction_id }
Position         { 1 latitude, 2 longitude, 3 bearing }
```

**Brak CORS.** `gtfs.ztp.krakow.pl` nie zwraca nagłówków
`Access-Control-Allow-Origin` (sprawdzone curl). Przeglądarka nie może pobrać
tego feedu bezpośrednio, więc `vite.config.ts` robi przezroczyste proxy
`/api/live/ztp/* → https://gtfs.ztp.krakow.pl/*`. To nie jest pośrednik —
to ten sam publiczny adres, pod którym z TP są GTFS-y.

ZTP publikuje też `TripUpdates_*.pb` i `ServiceAlerts_*.pb`, ale **nie**
opóźnienia w sekundach dla każdego kursu w formie łatwej do odczytu —
`delay` pokazujemy tylko wtedy, gdy wynika z realnych danych, inaczej pole
pozostaje puste.

## 4. Ruch drogowy

**Uczciwa odpowiedź: Kraków nie publikuje otwartego API z natężeniem ruchu
drogowego na ulicach miejskich.** Sprawdzone i odrzucone źródła:

| Źródło | Dlaczego nie |
|---|---|
| ZDMK (`zdmk.krakow.pl`) | strona informacyjna, brak maszynowego API ani plików z liczbami |
| GDDKiA — Generalny Pomiar Ruchu | tylko drogi krajowe; Kraków to droga wojewódzka/kosćej — poza zakresem. Dane w PDF/XLSX, nie w API |
| GDDKiA — Stacje Ciągłych Pomiarów Ruchu | `dane.gov.pl`, wymaga konta, eksport CSV z autoryzacji |
| Wydział Ruchu Drogowego KSP | raporty papierowe, brak API |
| MSIP (`msip.krakow.pl`) | katalog MSIP opisuje zbiory, ale udostępnia je jako mapy WMS — nie ma warstwy z natężeniem ruchu w formie REST |
| TomTom / HERE / Google | wymagają klucza płatnego |

**Użyta alternatywa: GTFS-RT ZTP.** To jedyny publiczny, aktualny,
urzędowy sygnał o stanie ruchu w Krakowie:

* `congestion_level` (1–4) — deklarowany przez ZTP poziom zastoju, **OBSERVED**,
  przypisywany do odcinka drogi przez dopasowanie współrzędnych.
* Liczba realnych pojazdów na odcinku w danej chwili — **PREDICTED** z OBSERVED.
* Prędkość z dwóch kolejnych obserwacji tego samego pojazdu — **PREDICTED**
  (blokada: odczyt co 15 s daje prędkości do ok. 5 km/h, więc raportujemy
  tylko odcinki z kilkoma pojazdami).

Odcinki bez pomiaru dostają wartość **PREDICTED** z klasy drogi i liczby pasów
(`estimateFromRoadClass` w `src/data/adapters/cityAdapter.ts`). UI zawsze pokazuje,
który odcinek ma `OBSERVED`, a który `PREDICTED`.

## 5. Środowisko

| | |
|---|---|
| Co | temperatura, wilgotność, wiatr, opad, PM2.5/PM10/NO2/SO2/O3, AQI |
| Źródło | [Open-Meteo](https://open-meteo.com/) + [Air Quality API](https://open-meteo.com/en/docs/air-quality-api) |
| Licencja | CC BY 4.0 |
| CORS | włączony — fetchujemy prosto z przeglądarki |

**Jakość powietrza to model, nie pomiar.** Open-Meteo Air Quality to reanaliza
CAMS (Copernicus Atmosphere Monitoring Service). Publiczne API GIOŚ
(`api.gios.gov.pl/pjp-api/v3`) wymaga klucza API i zwraca 302 do logowania dla
żądań bez klucza, a WIOŚ Kraków (`monitoring.krakow.pios.gov.pl`) nie odpowiada
z tej sieci. OpenAQ v3 wymaga `X-API-Key`.

Dlatego w UI wszystkie wartości środowiskowe są oznaczone **PREDICTED**, nigdy
OBSERVED. Jeśli endpoint nie odpowiada, pokazujemy `Data unavailable` zamiast
losowej liczby.

Wpływ na symulację: temperatura < 2 °C spowalnia ruch o 10 %, PM2.5 z modelu
skaluje smog w metrykach, a komfort pieszych rośnie przy temperaturze 2–24 °C.

## 6. Czego w ogóle nie ma publicznie

Wymienione świadomie, żeby nie udawać danych:

* **Piesi** — brak publicznego API z liczbą osób na ulicach. Wszystkie sylwetki
  pieszych są **SIMULATED** i są tak podpisane w HUD.
* **Opóźnienia kursów w sekundach** — ZTP nie wystawia ich w formie łatwej do
  odczytu w VehiclePositions.
* **Ruch na ulicach nieobjętych torowiskiem w czasie rzeczywistym** — patrz punkt 4.
* **Parkingi, natężenia na wlotach do miasta (50 punktów)** — publikowane przez
  krakow.pl jako PDF, nie maszynowo.

## 7. Schemat przepływu danych

```
Overpass API ─┐
ZTP GTFS    ─┤
ZTP GTFS-RT ─┼→ scripts/ingest.ts ──→ public/data/*.json  (CACHED, prawdziwe dane)
Open-Meteo  ─┘                                     │
                                                   ▼
                          src/data/pipeline.ts  (odświeżanie co 15–600 s)
                                                   │
                    ┌──────────────────────────────┤
                    ▼                              ▼
        src/data/adapters/cityAdapter      src/data/sources/*/live.ts
                    │                              │
                    └──────────┬───────────────────┘
                               ▼
                          CityData (CityState)
                               │
                               ▼
                    src/simulation/sim.ts  ← nie wykonuje zapytań sieciowych
                               │
                               ▼
                    src/scene + src/ui
```

Symulacja nigdy nie wykonuje `fetch`. Dostaje gotowy `CityData` i nakłada na niego
zmiany gracza (`baselineState + playerChanges = simulatedFutureState`).