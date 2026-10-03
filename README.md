# Krakopolis

> Polska: **3D sandbox analizy i planowania miasta dla Krakowa** — prawdziwe dane OSM + ZTP, jawne rozróżnienie OBSERVED / SIMULATED.

**3D city analysis / planning sandbox for Kraków**

[Live demo](https://krakopolis.pages.dev/) · Hackathon-style OSS city lab

---

## Problem / solution

Cities publish a lot of open data — roads, buildings, transit — but decision-makers and citizens rarely get an interactive place to *try* changes and see consequences without confusing models with measurements.

**Krakopolis** loads a real Kraków downtown footprint (OSM + ZTP Kraków GTFS/GTFS-RT), lets you place or remove player-built structures, run analysis layers and disaster scenarios, and keeps source truth separate from simulation. What came from a public feed stays labeled; what the game invents is labeled too.

## Features

- **Build** — catalog placement with preview → confirm (budget in PLN, undo/redo)
- **Analysis layers** — traffic colour modes, map layers, labels (Analyze mode)
- **Disasters / events** — scenario preview then confirm
- **History** — city versions persisted in **IndexedDB** (survives refresh)
- **Live + cached data** — OSM geography, ZTP GTFS schedules, GTFS-RT vehicles when online
- **Minimap** — OSM raster tiles with attribution
- **Search** — streets, stops, POIs from ingested OSM/GTFS
- **Controls** — keyboard-first city builder UX (see cheat sheet)

## OBSERVED vs SIMULATED (honesty)

Every meaningful number and entity carries an origin:

| Tag | Meaning |
|---|---|
| **OBSERVED** | Straight from a public source (e.g. GTFS-RT GPS of an MPK vehicle) |
| **PREDICTED** | Derived from observations (e.g. reassignment after closing a road) |
| **SIMULATED** | Invented by the game (agent cars/pedestrians, some metric estimates) |

Baseline city data is never overwritten by the player. Simulation reads `baseline` and writes a separate future state. Live vehicles render with a green ring when they are **OBSERVED**.

Analysis results and disaster outcomes are **SIMULATED / model estimates** — not marketed as “AI predictions.”

## Tech stack

| Layer | Choice |
|---|---|
| App | Vite + React + TypeScript |
| 3D | React Three Fiber, Three.js, Drei |
| Deploy | Cloudflare Pages (+ Pages Functions proxy for ZTP) |
| Data pipeline | `tsx` ingest scripts → `public/data/*.json` |
| Client history | IndexedDB |

## Screenshots

Pitch deck: [`docs/Krakopolis-Hackathon.pptx`](./docs/Krakopolis-Hackathon.pptx) · Live: [https://krakopolis.pages.dev/](https://krakopolis.pages.dev/)

| | |
|---|---|
| Overview + HUD | [`docs/screens/01-overview-hud.jpg`](./docs/screens/01-overview-hud.jpg) |
| Buduj / katalog | [`docs/screens/02-buduj-katalog.jpg`](./docs/screens/02-buduj-katalog.jpg) |
| Konsekwencje / Zatwierdź | [`docs/screens/03-konsekwencje-zatwierdz.jpg`](./docs/screens/03-konsekwencje-zatwierdz.jpg) |
| Analiza / warstwy | [`docs/screens/04-analiza-warstwy.jpg`](./docs/screens/04-analiza-warstwy.jpg) |
| Historia wersji | [`docs/screens/05-historia-wersji.jpg`](./docs/screens/05-historia-wersji.jpg) |
| Minimapa OSM + Widok | [`docs/screens/06-minimapa-widok.jpg`](./docs/screens/06-minimapa-widok.jpg) |
| Overview z minimapą | [`docs/screens/06b-overview-minimapa.jpg`](./docs/screens/06b-overview-minimapa.jpg) |

| Scene | HUD / modes |
|---|---|
| ![scene](docs/screenshots/scene.png) | ![hud](docs/screenshots/hud.png) |

*(Create `docs/screenshots/` and drop PNGs when ready.)*

## Quick start

Requires Node.js 20+ and network for the first ingest (or use already baked `public/data`).

```bash
npm ci
npm run ingest      # optional if public/data is already present; ~10–20 min, needs network
npm run basemap     # optional satellite mosaic (Esri tiles → public/data/basemap.jpg)
npm run dev         # http://localhost:5173
```

```bash
npm run build       # typecheck + production build
npm run preview     # local preview (Vite proxy for live feeds)
npm run deploy      # build + wrangler pages deploy → project krakopolis
npm run sim:test    # smoke-test simulation on baked data
```

CORS: ZTP and Overpass do not send browser CORS headers. Dev/preview use Vite proxy; production uses Cloudflare Pages Functions under `/api/live/ztp/*`.

## Controls cheat sheet

| Input | Action |
|---|---|
| LMB drag | Orbit |
| Wheel | Zoom |
| RMB / middle | Pan |
| Shift + RMB | Tilt |
| WASD / arrows | Pan |
| Q / E | Rotate view |
| R | Rotate building ghost |
| Esc | Cancel pending |
| Z / Y | Undo / redo |
| Delete / Backspace | Demolish **player** building |
| Space | Pause |
| N | Fit whole city |
| 1–4 | Build / Analyze / Events / History |
| View dock (bottom-right) | Toggle Search · Metrics · Panels · Minimap · Footer · Modes |

OSM buildings cannot be demolished — only player-built volumes. Confirm dialogs apply to build preview and disaster preview.

## Data sources & licenses

Full detail: [`DATA_SOURCES.md`](./DATA_SOURCES.md).

| Layer | Source | License / note |
|---|---|---|
| Roads, buildings, greenery, water | OpenStreetMap / Overpass | **ODbL 1.0** |
| Routes, stops, shapes | ZTP Kraków GTFS | Public feed; ZTP terms |
| Live vehicles / congestion hints | ZTP Kraków GTFS-RT | Public feed; ZTP terms |
| Weather / air quality | Open-Meteo | **CC BY 4.0** |
| Satellite basemap (optional) | Esri World Imagery | © Esri, Maxar, Earthstar Geographics |
| Minimap tiles | OSM raster | © OpenStreetMap contributors |

Application code is intended to be **MIT** (add a `LICENSE` file if you fork/publish formally). Respect upstream data licenses when redistributing tiles or extracts.

## Project structure

```
functions/               Cloudflare Pages Functions (ZTP proxy, health)
public/data/             Baked OSM / GTFS / terrain / basemap
scripts/ingest.ts        Fetch & normalize city data
scripts/basemap.ts       Optional satellite mosaic
src/data/                Sources, adapters, cache, pipeline
src/simulation/          Graph, traffic assignment, city sim
src/scene/               R3F city scene, layers, models
src/ui/                  HUD, minimap, styles
wrangler.toml            Pages project name: krakopolis
```

## License

No `LICENSE` file in this tree yet. Treat application source as **MIT** unless stated otherwise; data remains under its own licenses above.
