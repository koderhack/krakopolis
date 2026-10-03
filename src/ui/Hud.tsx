import { useEffect, useMemo, useState } from 'react';
import { COST, type Sim } from '../simulation/sim';
import type { CityData } from '../data/model';
import type {
  FleetPose, Sel, Tool, TrafficView, PendingBuild, PendingDisaster, WorkspaceMode,
} from '../scene/types';
import { LAYERS } from '../scene/layers';
import { ANALYSIS_LAYERS } from '../scene/analysis';
import { DISASTERS, type DisasterKind } from '../simulation/city/player';
import type { PipelineSnapshot } from '../data/pipeline';
import { formatAge } from '../data/cache/store';
import type { Origin } from '../data/types';
import { formatCoords } from '../data/adapters/cityAdapter';
import { buildIndex, search, KIND_LABEL, type Place } from '../scene/search';
import type { PlaceRef } from '../scene/types';
import { BUILD_GROUPS, CATALOG, type BuildId } from '../simulation/city/catalog';
import type { ConsequenceReport } from '../simulation/consequences';
import type { CityVersion, VersionCompare } from '../data/cityStore';
import { compareVersions } from '../data/cityStore';
import { formatBudgetPln, KRAKOW_BUDGET_2025 } from '../data/budget';
import { Minimap, type MiniCam } from './Minimap';

interface Props {
  sim: Sim;
  city: CityData;
  ver: number;
  sel: Sel;
  tool: Tool;
  mode: WorkspaceMode;
  setMode: (m: WorkspaceMode) => void;
  buildId: BuildId | null;
  setBuildId: (id: BuildId | null) => void;
  buildRot: number;
  rotateBuild: () => void;
  pending: PendingBuild | null;
  pendingDisaster: PendingDisaster | null;
  report: ConsequenceReport | null;
  versions: CityVersion[];
  onConfirmPending: () => void;
  onConfirmDisaster: () => void;
  onCancelPending: () => void;
  onDismissReport: () => void;
  onRestoreVersion: (id: number) => void | Promise<void>;
  paused: boolean;
  speed: number;
  trafficView: TrafficView;
  msg: { id: number; text: string };
  pipe: PipelineSnapshot;
  vehicle: FleetPose | null;
  neoSelected?: boolean;
  setNeoSelected?: (v: boolean) => void;
  goto: (x: number, z: number, ref?: PlaceRef) => void;
  fitCity: () => void;
  layers: Set<string>;
  toggleLayer: (id: string) => void;
  analysis: Set<string>;
  toggleAnalysis: (id: string) => void;
  disaster: DisasterKind;
  setDisaster: (d: DisasterKind) => void;
  roadFrom: { x: number; z: number } | null;
  setTool: (t: Tool) => void;
  topDown: boolean;
  setTopDown: (v: boolean) => void;
  setPaused: (b: boolean) => void;
  setSpeed: (n: number) => void;
  setTrafficView: (v: TrafficView) => void;
  setVehicle: (v: FleetPose | null) => void;
  setSel: (s: Sel) => void;
  act: (fn: () => string | null, ok?: string) => void;
  mapBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  camSample: MiniCam | null;
  landmarks: { x: number; z: number }[];
}

const METRICS = [
  { k: 'traffic', label: 'Ruch', bad: true },
  { k: 'transit', label: 'Komunikacja', bad: false },
  { k: 'pedestrians', label: 'Piesi', bad: false },
  { k: 'pollution', label: 'Smog', bad: true },
  { k: 'noise', label: 'Hałas', bad: true },
  { k: 'satisfaction', label: 'Zadowolenie', bad: false },
] as const;

const tone = (v: number, bad: boolean) => `hsl(${Math.round((bad ? 100 - v : v) * 1.15)} 55% 42%)`;
const Bar = ({ v, bad = true }: { v: number; bad?: boolean }) => (
  <span className="bar"><i style={{ width: `${Math.max(0, Math.min(100, Math.round(v)))}%`, background: tone(v, bad) }} /></span>
);

const ORIGIN_LABEL: Record<Origin, string> = { OBSERVED: 'OBSERVED', PREDICTED: 'PREDICTED', SIMULATED: 'SIMULATED' };
const ORIGIN_TITLE: Record<Origin, string> = {
  OBSERVED: 'Wprost z publicznego źródła danych',
  PREDICTED: 'Policzone z danych zaobserwowanych',
  SIMULATED: 'Wygenerowane przez symulację gry',
};

const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
const fmtLat = (v: number) => v.toFixed(5);

const CHANGE_LABEL: Record<string, string> = {
  closed: 'zamknięta dla wszystkich',
  'cars-only': 'zamknięta dla aut',
  'stop-bus': 'nowy przystanek autobusowy',
  'stop-tram': 'nowy przystanek tramwajowy',
  destroyed: 'zniszczona',
  opened: 'otwarta',
};

/* ------------------------------------------------------------ wyszukiwarka */

function SearchBox({
  city, goto, topOffset, visible, onHide,
}: {
  city: CityData;
  goto: Props['goto'];
  topOffset?: boolean;
  visible: boolean;
  onHide: () => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const index = useMemo(() => buildIndex(city), [city]);
  const results = useMemo(() => (q.length >= 2 ? search(index, q) : []), [index, q]);
  const style = topOffset ? { top: 44 } : undefined;

  const pick = (p: Place) => {
    goto(p.x, p.z, p.ref as PlaceRef | undefined);
    setOpen(false);
  };

  if (!visible) return null;

  return (
    <div className="search" style={style}>
      <div className="search-bar">
        <input
          value={q}
          placeholder="Szukaj: Poczta Główna, Rynek, Wawel, linia 18…"
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 180)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && results[0]) pick(results[0]);
            if (e.key === 'Escape') { setOpen(false); onHide(); (e.target as HTMLInputElement).blur(); }
          }}
        />
      </div>
      {open && results.length > 0 && (
        <ul>
          {results.map((p, i) => (
            <li key={i} onMouseDown={() => pick(p)}>
              <b>{p.name}</b>
              <span>
                {KIND_LABEL[p.kind]}
                {p.detail ? ` · ${p.detail}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
      {open && q.length >= 2 && results.length === 0 && (
        <ul><li className="none">Brak wyników w danych OSM / GTFS dla „{q}”</li></ul>
      )}
    </div>
  );
}

/* ------------------------------------------------- panel wybranego pojazdu */

function VehicleCard({ vehicle, city, setVehicle }: { vehicle: FleetPose; city: CityData; setVehicle: (v: FleetPose | null) => void }) {
  // Czy to realny pojazd z GTFS-RT? Sprawdzamy po identyfikatorze.
  const real = city.liveVehicles.find((v) => v.id === vehicle.id);
  const kind = vehicle.id.startsWith('T:') ? 'tramwaj' : vehicle.id.startsWith('A:') || vehicle.id.startsWith('M:') ? 'autobus' : 'pojazd symulacji';
  const line = real?.line ?? vehicle.ref;
  return (
    <aside className="panel vehicle">
      <h2>Linia {line}</h2>
      <p className="sub">{real ? 'REALNY POJAZD z GTFS-RT' : 'pojazd symulacji na trasie GTFS'}</p>
      <dl>
        <dt>Typ</dt><dd>{kind}</dd>
        <dt>Kierunek</dt><dd>{real?.headsign ?? (vehicle.info ?? 'z GTFS')}</dd>
        <dt>Status</dt>
        <dd>
          {real ? <span className="tag observed">OBSERVED</span> : <span className="tag simulated">SIMULATED</span>}
        </dd>
        <dt>Pozycja</dt>
        <dd>{real ? `${real.latitude.toFixed(5)}, ${real.longitude.toFixed(5)}` : `x ${vehicle.x.toFixed(0)} m, z ${vehicle.z.toFixed(0)} m`}</dd>
        <dt>Prędkość</dt>
        <dd>{real?.speed !== undefined ? `${(real.speed * 3.6).toFixed(0)} km/h` : 'brak w feedzie'}</dd>
        <dt>Globalny poziom</dt>
        <dd><span className="tag observed">OBSERVED</span> {fmtLat(50.06162 + (vehicle.z ?? 0) / 111320).slice(0, 8)}</dd>
        <dt>Dane</dt><dd>{real ? new Date(real.timestamp).toLocaleTimeString('pl-PL') : '—'}</dd>
      </dl>
      <div className="acts">
        <button onClick={() => setVehicle(null)}>Zamknij</button>
      </div>
      <p className="note">
        {real
          ? 'Pozycja i kurs odczytane wprost z feedu GTFS-RT ZTP Kraków. Zielony pierścień pod pojazdem oznacza dane obserwowane.'
          : 'Pojazd jedzie po realnej trasie z GTFS, ale jego pozycja jest generowana przez symulację.'}
      </p>
    </aside>
  );
}

/* ------------------------------------------------------------- warstwy */

function LayersPanel({ layers, toggle }: { layers: Set<string>; toggle: (id: string) => void }) {
  return (
    <aside className="layers">
      <h3>Warstwy <small>{layers.size}/{LAYERS.length}</small></h3>
      {LAYERS.map((l) => (
        <button
          key={l.id}
          className={layers.has(l.id) ? 'on' : ''}
          onClick={() => toggle(l.id)}
          title={l.hint}
        >
          <i className={`dot ${l.observed ? 'obs' : ''}`} />
          {l.label}
        </button>
      ))}
      {layers.has('basemap') && (
        <p className="layer-attr">Podkład: Esri World Imagery · © Esri, Maxar</p>
      )}
    </aside>
  );
}

/* ----------------------------------------------- lista zrealizowanych rzeczy */

const DONE: { t: string; d: string }[] = [
  { t: 'Prawdziwe drogi z OSM', d: 'graf 5866 odcinków, w tym torowiska' },
  { t: 'Budynki z obrysów OSM', d: '3600 brył wyciągniętych na realne wysokości' },
  { t: 'Linie i przystanki MPK', d: '120 linii, 72 przystanki z GTFS ZTP' },
  { t: 'Realne pojazdy LIVE', d: 'pozycje GPS z GTFS-RT co 15 s' },
  { t: 'Ruch z danych', d: 'poziom zakrzepienia z ZTP + predykcja objazdów' },
  { t: 'Pogoda i powietrze', d: 'Open-Meteo, LIVE' },
  { t: 'Wyszukiwarka miejsc', d: 'ulice, przystanki, urzędy z OSM' },
  { t: 'Swobodna kamera', d: 'WASD + mysz w trybie lotu' },
  { t: 'Edytor miasta', d: 'droga, przystanki, centrum handlowe, uczelnia' },
  { t: 'Cofanie zmian', d: 'historia z ' },
  { t: 'Katastrofy', d: 'pożar, powódź, blackout, trzęsienie ziemi' },
  { t: 'Warstwy mapy', d: 'ruch pieszy, transport, etykiety, zniszczenia' },
];

function DonePanel({ sim }: { sim: Sim }) {
  const [open, setOpen] = useState(false);
  return (
    <aside className="done">
      <button className="dp-head" onClick={() => setOpen(!open)}>
        <span>ZROBIONE</span>
        <em className="live">{DONE.length} punktów</em>
        <i>{open ? '–' : '+'}</i>
      </button>
      {open && (
        <div className="dp-body">
          {DONE.map((d, i) => (
            <div key={i} className="done-row">
              <b>✓ {d.t}</b>
              <span>{d.t.includes('histor') ? d.d + sim.history.depth + ' kroków' : d.d}</span>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}

/* ------------------------------------------------------- panel źródeł danych */

function DataPanel({ pipe, city }: { pipe: PipelineSnapshot; city: CityData }) {
  const [open, setOpen] = useState(true);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const counts = useMemo(() => ({
    roads: city.roads.length,
    buildings: city.buildings.length,
    stops: city.stops.length,
    routes: city.routes.length,
    signals: city.signals.length,
  }), [city]);

  const anyLive = pipe.statuses.some((s) => s.live);

  return (
    <aside className="datapanel">
      <button className="dp-head" onClick={() => setOpen(!open)}>
        <span>DANE</span>
        <em className={anyLive ? 'live' : 'cached'}>
          {anyLive ? 'część LIVE' : 'tryb CACHED'}
        </em>
        <i>{open ? '–' : '+'}</i>
      </button>
      {open && (
        <div className="dp-body">
          {pipe.statuses.map((s) => (
            <div className="dp-row" key={s.id} title={s.error ?? s.note ?? ''}>
              <span className="dp-name">{s.name}</span>
              <span className={`dp-state ${s.live ? 'live' : s.freshness === 'CACHED' ? 'cached' : 'off'}`}>
                {s.live ? 'LIVE' : s.freshness === 'CACHED' ? 'CACHED' : 'BRAK'}
              </span>
              <span className="dp-time">
                {s.dataTimestamp ? formatAge(s.dataTimestamp) : s.error ? 'Data unavailable' : '—'}
              </span>
              {s.records !== undefined && <span className="dp-rec">{s.records} rek.</span>}
            </div>
          ))}
          <div className="dp-sep" />
          <div className="dp-row"><span className="dp-name">Dane statyczne</span><span className="dp-state cached">CACHED</span>
            <span className="dp-time">{formatAge(city.generatedAt)}</span></div>
          <dl className="dp-counts">
            <div><dt>odcinków dróg</dt><dd>{counts.roads}</dd></div>
            <div><dt>budynków</dt><dd>{counts.buildings}</dd></div>
            <div><dt>przystanków</dt><dd>{counts.stops}</dd></div>
            <div><dt>linii MPK</dt><dd>{counts.routes}</dd></div>
            <div><dt>skrzyżowań ze światłami</dt><dd>{counts.signals}</dd></div>
          </dl>
          <p className="dp-foot">
            Obszar: {city.area.name}. Dane offline zapisane {formatAge(city.generatedAt)} skryptem <code>npm run ingest</code>.
          </p>
          {pipe.errors.length > 0 && <p className="dp-err">{pipe.errors[0]}</p>}
        </div>
      )}
    </aside>
  );
}

/* --------------------------------------------------------------- środowisko */

function EnvironmentCard({ city }: { city: CityData }) {
  const w = city.environment.weather;
  const a = city.environment.airQuality;
  if (!w && !a) return null;
  return (
    <aside className="envcard">
      <h3>Środowisko <small>dane zewnętrzne</small></h3>
      {w && (
        <div className="env-row">
          <span>{w.description}, {w.temperatureC?.toFixed(1)}°C</span>
          <em title={ORIGIN_TITLE.PREDICTED}>{ORIGIN_LABEL.PREDICTED}</em>
        </div>
      )}
      {a && (
        <div className="env-row">
          <span>powietrze: {a.description}{a.pm25 !== undefined ? ` · PM2.5 ${a.pm25.toFixed(1)} µg/m³` : ''}</span>
          <em title={ORIGIN_TITLE.PREDICTED}>{ORIGIN_LABEL.PREDICTED}</em>
        </div>
      )}
      <p className="env-note">Open-Meteo (model). Kraków nie udostępnia otwartego API stacji pomiarowych.</p>
    </aside>
  );
}

/* ------------------------------------------------ konsekwencje / katalog */

function ConsequencePanel({
  report, pending, pendingDisaster, onConfirm, onConfirmDisaster, onCancel, onDismiss,
}: {
  report: ConsequenceReport;
  pending: PendingBuild | null;
  pendingDisaster: PendingDisaster | null;
  onConfirm: () => void;
  onConfirmDisaster: () => void;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  return (
    <aside className="panel consequence">
      <h2>{report.title}</h2>
      <p className="sub">{report.summary}</p>
      <div className="impact-grid">
        {report.impacts.map((row) => (
          <div key={row.label} className={`impact lvl-${row.level.toLowerCase()}`}>
            <span>{row.label}</span>
            <b>{row.level}</b>
            {row.delta && <em>{row.delta}</em>}
          </div>
        ))}
      </div>
      <h3 className="obs-h">Obserwacje <small>szacunek modelu</small></h3>
      <ul className="obs-list">
        {report.observations.map((o, i) => (
          <li key={i} className={`obs-${o.kind}`}>
            {o.text}
            <small>pewność: {o.confidence}</small>
          </li>
        ))}
      </ul>
      <div className="horizons">
        {report.horizons.map((h) => (
          <div key={h.label}><b>{h.label}</b><span>{h.note}</span></div>
        ))}
      </div>
      {pending || pendingDisaster ? (
        <div className="acts confirm-acts">
          <button type="button" onClick={onCancel}>Anuluj</button>
          <button type="button" className="primary" onClick={pending ? onConfirm : onConfirmDisaster}>
            {pendingDisaster ? 'Uruchom symulację' : 'Zatwierdź'}
          </button>
        </div>
      ) : (
        <div className="acts">
          <button type="button" onClick={onDismiss}>Zamknij</button>
        </div>
      )}
      <p className="note">Wyniki to SIMULATED / szacunek modelu – nie „AI predictions”.</p>
    </aside>
  );
}

const INFRA_TOOLS: { id: Tool; label: string; cost: number }[] = [
  { id: 'stop-bus', label: 'Przyst. aut.', cost: COST.stop },
  { id: 'stop-tram', label: 'Przyst. tram.', cost: COST.stopTram },
  { id: 'tram-track', label: 'Torowisko', cost: COST.road },
  { id: 'road', label: 'Droga', cost: COST.road },
];

function CatalogPanel({
  buildId, setBuildId, tool, setTool, buildRot, rotateBuild, open,
}: {
  buildId: BuildId | null;
  setBuildId: (id: BuildId | null) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  buildRot: number;
  rotateBuild: () => void;
  open: boolean;
}) {
  if (!open) return null;
  const selectedSpec = buildId ? CATALOG.find((c) => c.id === buildId) : null;
  return (
    <aside className="panel catalog">
      <h2>Buduj <small>katalog</small></h2>
      <p className="sub">Wybierz → kliknij mapę → R obraca → zatwierdź</p>
      {BUILD_GROUPS.map((g) => {
        const items = CATALOG.filter((c) => c.group === g);
        if (!items.length) return null;
        return (
          <div key={g} className="cat-group">
            <h3>{g}</h3>
            {items.map((c) => (
              <button
                key={c.id}
                type="button"
                className={buildId === c.id && tool === 'build' ? 'on' : ''}
                onClick={() => setBuildId(c.id)}
                title={c.desc}
              >
                <i className="swatch" style={{ background: c.color }} />
                <span>{c.label}</span>
                <small>{formatBudgetPln(c.cost)}</small>
              </button>
            ))}
          </div>
        );
      })}
      <div className="cat-group">
        <h3>Sieć / przystanki</h3>
        {INFRA_TOOLS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={tool === t.id ? 'on' : ''}
            onClick={() => setTool(tool === t.id ? 'build' : t.id)}
          >
            <i className="swatch" style={{ background: '#6a849c' }} />
            <span>{t.label}</span>
            <small>{formatBudgetPln(t.cost)}</small>
          </button>
        ))}
      </div>
      {selectedSpec?.rotatable && tool === 'build' && (
        <button type="button" className="on catalog-rotate" onClick={rotateBuild} title="R">
          Obróć <small>{Math.round((buildRot * 180) / Math.PI)}°</small>
        </button>
      )}
    </aside>
  );
}

function AnalysisPanel({
  analysis, toggleAnalysis, layers, toggleLayer,
}: {
  analysis: Set<string>;
  toggleAnalysis: (id: string) => void;
  layers: Set<string>;
  toggleLayer: (id: string) => void;
}) {
  return (
    <>
      <aside className="panel analysis">
        <h2>Analiza <small>warstwy modelu</small></h2>
        <p className="sub">Wyniki modelu – bez fałszywej precyzji</p>
        {ANALYSIS_LAYERS.map((l) => (
          <button
            key={l.id}
            type="button"
            className={analysis.has(l.id) ? 'on' : ''}
            title={l.hint}
            onClick={() => toggleAnalysis(l.id)}
          >
            <i className="dot" />
            <span>{l.label}</span>
            {l.estimate && <small>szacunek</small>}
          </button>
        ))}
      </aside>
      <aside className="panel analysis map-layers">
        <h2>Mapa <small>warstwy / napisy</small></h2>
        <p className="sub">Włącz lub wyłącz elementy sceny</p>
        {LAYERS.map((l) => (
          <button
            key={l.id}
            type="button"
            className={layers.has(l.id) ? 'on' : ''}
            title={l.hint}
            onClick={() => toggleLayer(l.id)}
          >
            <i className={`dot ${l.observed ? 'obs' : ''}`} />
            <span>{l.label}</span>
          </button>
        ))}
      </aside>
    </>
  );
}

function EventsPanel({
  disaster, setDisaster,
}: {
  disaster: DisasterKind;
  setDisaster: (d: DisasterKind) => void;
}) {
  return (
    <aside className="panel events">
      <h2>Zdarzenia <small>scenariusze</small></h2>
      <p className="sub">Wybierz → kliknij mapę → podgląd → uruchom</p>
      <div className="event-list">
        {(Object.keys(DISASTERS) as DisasterKind[]).map((k) => (
          <button
            key={k}
            type="button"
            className={disaster === k ? 'on danger' : ''}
            onClick={() => setDisaster(k)}
          >
            <span>{DISASTERS[k].label}</span>
            <small>{formatBudgetPln(DISASTERS[k].cost)}</small>
          </button>
        ))}
      </div>
    </aside>
  );
}

function fmtSigned(n: number, digits = 0): string {
  const v = digits > 0 ? n.toFixed(digits) : String(Math.round(n));
  if (n > 0) return `+${v}`;
  return v;
}

function fmtMetricDelta(key: string, n: number): string {
  if (key === 'budget') {
    const s = formatBudgetPln(Math.abs(n));
    return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
  }
  return fmtSigned(n, key === 'traffic' || key === 'satisfaction' ? 1 : 0);
}

const DIFF_ROWS: { key: keyof VersionCompare['delta']; label: string }[] = [
  { key: 'residents', label: 'Mieszkańcy' },
  { key: 'jobs', label: 'Praca' },
  { key: 'buildings', label: 'Budynki' },
  { key: 'parks', label: 'Parki' },
  { key: 'budget', label: 'Budżet' },
  { key: 'satisfaction', label: 'Satysfakcja' },
  { key: 'traffic', label: 'Ruch' },
  { key: 'changes', label: 'Zmiany' },
];

function wersjeLabel(n: number): string {
  if (n === 1) return 'wersja';
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'wersje';
  return 'wersji';
}

function HistoryPanel({
  versions,
  onRestore,
}: {
  versions: CityVersion[];
  onRestore: (id: number) => void | Promise<void>;
}) {
  const latest = versions[versions.length - 1] ?? null;
  const latestId = latest?.id ?? 0;
  const ordered = useMemo(() => [...versions].reverse(), [versions]);
  const [cmp, setCmp] = useState<VersionCompare | null>(null);
  const [cmpA, setCmpA] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (versions.length < 2) {
        setCmp(null);
        setCmpA(null);
        return;
      }
      const a = versions[versions.length - 2];
      const b = versions[versions.length - 1];
      const d = await compareVersions(a.id, b.id);
      if (!alive || !d) return;
      setCmp(d);
      setCmpA(a.id);
    })();
    return () => { alive = false; };
  }, [versions]);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 4200);
    return () => clearTimeout(t);
  }, [flash]);

  const runCompare = async (id: number) => {
    if (!latest || latest.id === id) return;
    const d = await compareVersions(id, latest.id);
    if (!d) return;
    setCmpA(id);
    setCmp(d);
  };

  const runRestore = async (id: number) => {
    if (restoring != null || id === latestId) return;
    setRestoring(id);
    try {
      await onRestore(id);
      setFlash(`Przywrócono v${id} jako nową wersję — historia bez skasowań.`);
    } catch {
      setFlash(`Nie udało się przywrócić v${id}.`);
    } finally {
      setRestoring(null);
    }
  };

  if (!versions.length) {
    return (
      <aside className="changes history">
        <h3>Historia miasta</h3>
        <p className="hist-empty">
          Brak zapisanych wersji. Po pierwszej zmianie w mieście pojawi się tu oś czasu
          (IndexedDB — przeżywa odświeżenie strony).
        </p>
      </aside>
    );
  }

  return (
    <aside className="changes history">
      <h3>
        Historia miasta
        <small>{versions.length} {wersjeLabel(versions.length)}</small>
      </h3>

      {flash && <p className="hist-flash" role="status">{flash}</p>}

      {cmp && (
        <div className="hist-diff" aria-live="polite">
          <header className="hist-diff-head">
            <strong>Porównanie</strong>
            <span>v{cmp.a} → v{cmp.b}</span>
          </header>
          <p className="hist-diff-sub">
            {cmp.labelA}
            <span aria-hidden> · </span>
            vs aktualna
          </p>
          <ul className="hist-diff-metrics">
            {DIFF_ROWS.map(({ key, label }) => {
              const n = cmp.delta[key];
              if (n === 0) return null;
              return (
                <li key={key} className={n > 0 ? 'up' : 'down'}>
                  <span>{label}</span>
                  <b>{fmtMetricDelta(key, n)}</b>
                </li>
              );
            })}
            {DIFF_ROWS.every(({ key }) => cmp.delta[key] === 0) && (
              <li className="flat"><span>Bez różnic metryk</span><b>—</b></li>
            )}
          </ul>
          {cmp.newChanges.length > 0 && (
            <div className="hist-diff-changes">
              <span>Od v{cmp.a}</span>
              <ul>
                {cmp.newChanges.map((c, i) => (
                  <li key={`${c.type}-${i}`}>{c.label}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="hist-list">
        {ordered.map((v) => {
          const isLatest = v.id === latestId;
          const canAct = !isLatest;
          return (
            <div
              key={v.id}
              className={`hist-item${cmpA === v.id ? ' cmp-on' : ''}${isLatest ? ' is-latest' : ''}`}
            >
              <div className="hist-item-top">
                <b className="hist-ver">v{v.id}</b>
                {isLatest && <span className="hist-badge">aktualna</span>}
                {v.restoredFrom != null && (
                  <span className="hist-badge from">z v{v.restoredFrom}</span>
                )}
                <em className="hist-date">
                  {new Date(v.createdAt).toLocaleString('pl-PL', {
                    hour: '2-digit',
                    minute: '2-digit',
                    day: '2-digit',
                    month: '2-digit',
                  })}
                </em>
              </div>
              <p className="hist-label">{v.label}</p>
              {v.metrics && (
                <div className="hist-metrics-mini" title="Metryki zapisane w tej wersji">
                  <span>{Math.round(v.metrics.residents)} mieszk.</span>
                  <span>{Math.round(v.metrics.jobs)} praca</span>
                  <span>{formatBudgetPln(v.metrics.budget)}</span>
                </div>
              )}
              {canAct && (
                <div className="chg-acts">
                  <button
                    type="button"
                    className="mini"
                    onClick={() => void runCompare(v.id)}
                    title="Porównaj metryki z aktualną wersją"
                  >
                    Porównaj
                  </button>
                  <button
                    type="button"
                    className="mini restore"
                    disabled={restoring != null}
                    onClick={() => void runRestore(v.id)}
                    title="Przywróć ten stan jako nową wersję (historia zostaje)"
                  >
                    {restoring === v.id ? 'Przywracam…' : 'Przywróć'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <p className="dp-note">
        Przywrócenie tworzy nową wersję — nic nie kasuje. Z = undo, Y = redo w bieżącej sesji.
      </p>
    </aside>
  );
}

function HelpSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return (
    <div className="help-sheet" role="dialog" aria-label="Sterowanie">
      <header>
        <h2>Sterowanie</h2>
        <button type="button" onClick={onClose} aria-label="Zamknij">×</button>
      </header>
      <ul>
        <li><kbd>LPM</kbd> wybierz / obrót kamery</li>
        <li><kbd>Scroll</kbd> zoom</li>
        <li><kbd>PPM</kbd> / środkowy — przesuwanie</li>
        <li><kbd>Shift</kbd>+<kbd>PPM</kbd> pochylenie</li>
        <li><kbd>WASD</kbd> / strzałki — przesuwanie</li>
        <li><kbd>Q</kbd> / <kbd>E</kbd> — obrót widoku</li>
        <li><kbd>R</kbd> obrót budynku</li>
        <li><kbd>Esc</kbd> anuluj</li>
        <li><kbd>Z</kbd> / <kbd>Y</kbd> cofnij / ponów</li>
        <li><kbd>Delete</kbd> / <kbd>Backspace</kbd> zburz budynek gracza</li>
        <li><kbd>Space</kbd> pauza</li>
        <li><kbd>N</kbd> całe miasto</li>
        <li><kbd>1–4</kbd> Buduj / Analiza / Zdarzenia / Historia</li>
        <li>Widok (prawy dół): Szukaj · Metryki · Panele · Minimapa · Stopka · Tryby — zwijanie etykietą Widok</li>
        <li>Chevrony z boków zwijają pojedynczy panel</li>
        <li>Warstwy mapy i napisy: tryb <b>Analiza</b> (panel Mapa)</li>
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------- HUD */

export function Hud({
  sim, city, sel, tool, mode, setMode, buildId, setBuildId, buildRot, rotateBuild,
  pending, pendingDisaster, report, versions,
  onConfirmPending, onConfirmDisaster, onCancelPending, onDismissReport, onRestoreVersion,
  paused, speed, trafficView, msg, pipe, vehicle, goto, fitCity,
  layers, toggleLayer, analysis, toggleAnalysis, disaster, setDisaster, roadFrom, setTool,
  topDown, setTopDown, setPaused, setSpeed, setTrafficView, setVehicle, setSel, act,
  mapBounds, camSample, landmarks,
}: Props) {
  const [s, setS] = useState(() => sim.snapshot());
  const [toast, setToast] = useState('');
  const [leftCollapsed, setLeftCollapsed] = useState(true);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [showMetrics, setShowMetrics] = useState(true);
  const [showSearch, setShowSearch] = useState(true);
  const [showMinimap, setShowMinimap] = useState(true);
  const [showFoot, setShowFoot] = useState(true);
  const [showModeBar, setShowModeBar] = useState(true);
  const [dockOpen, setDockOpen] = useState(true);
  const [clockOpen, setClockOpen] = useState(false);
  const [clockOffsetUi, setClockOffsetUi] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);

  const sidesHidden = leftCollapsed && rightCollapsed;
  const toggleSides = () => {
    if (sidesHidden) {
      setLeftCollapsed(false);
      setRightCollapsed(false);
    } else {
      setLeftCollapsed(true);
      setRightCollapsed(true);
    }
  };

  useEffect(() => {
    const t = setInterval(() => {
      setS(sim.snapshot());
      setClockOffsetUi(sim.clockOffsetHours());
    }, 400);
    return () => clearInterval(t);
  }, [sim]);
  useEffect(() => {
    if (!msg.text) return;
    setToast(msg.text);
    const t = setTimeout(() => setToast(''), 5200);
    return () => clearTimeout(t);
  }, [msg]);
  useEffect(() => {
    const app = document.querySelector('.app');
    if (!app) return;
    app.classList.toggle('no-foot', !showFoot);
    app.classList.toggle('no-mini', !showMinimap);
    app.classList.toggle('no-mode-bar', !showModeBar);
    app.classList.toggle('dock-collapsed', !dockOpen);
  }, [showFoot, showMinimap, showModeBar, dockOpen]);

  const r = sel?.kind === 'road' ? sim.roads[sel.id] : null;
  const b = sel?.kind === 'building' ? city.buildings[sel.id] : null;
  const pb = sel?.kind === 'player' ? sim.playerBuildings.find((x) => x.id === sel.id) : null;

  const status = r ? (r.closed ? 'Zamknięta przez gracza' : r.pedestrian ? 'Strefa dla pieszych (gracz)' : 'Otwarta (stan z danych)') : '';
  const acts = r ? [
    {
      label: r.closed ? 'Otwórz ulicę' : 'Zamknij ulicę',
      cost: r.closed ? 0 : COST.close,
      run: () => act(() => sim.setClosed(r.edge.id, !r.closed),
        r.closed ? 'Ulica otwarta – ruch wraca na bazowy poziom.' : `Zamknięto ${r.edge.name}. Symulacja przeliczyła objazdy.`),
    },
    {
      label: r.pedestrian ? 'Przywróć ruch aut' : 'Strefa dla pieszych',
      cost: r.pedestrian ? 0 : COST.pedestrian,
      run: () => act(() => sim.setPedestrian(r.edge.id, !r.pedestrian),
        r.pedestrian ? 'Ulica znów dla aut.' : `${r.edge.name} – strefa piesza (zmiana gracza).`),
    },
  ] : [];

  const changes = sim.playerChanges();
  const selectedSpec = buildId ? CATALOG.find((c) => c.id === buildId) : null;
  const showCatalog = mode === 'build';
  const showAnalysis = mode === 'analyze';
  const showEvents = mode === 'events';
  const showHistory = mode === 'history';

  return (
    <>
      <header className={`top${!showMetrics ? ' collapsed' : ''}`}>
        {showMetrics && (
          <>
            <div className="brand">
              <b>Krakopolis</b>
              <span>laboratorium miasta · OSM + ZTP</span>
            </div>
            <div className="metrics">
              {METRICS.map((m) => (
                <div key={m.k} className="metric">
                  <span>{m.label}</span>
                  <strong>{Math.round(s[m.k])}</strong>
                  <Bar v={s[m.k]} bad={m.bad} />
                </div>
              ))}
              <div className="metric" title={`Fundusz inwestycyjny · Kraków ${KRAKOW_BUDGET_2025.year}`}>
                <span>Budżet</span>
                <strong>{formatBudgetPln(s.budget)}</strong>
              </div>
            </div>
            <div className="ctrl">
              <div className={`sim-clock${clockOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  className="sim-clock-btn"
                  title="Przewiń czas ±24 h"
                  onClick={() => setClockOpen((v) => !v)}
                >
                  <span className="sim-clock-label">Czas</span>
                  <strong className="sim-clock-time">{s.clock}</strong>
                  <span className="sim-clock-meta">
                    {Math.abs(clockOffsetUi) < 0.02 && speed === 1 && !paused
                      ? 'na żywo'
                      : paused ? 'pauza' : `${clockOffsetUi >= 0 ? '+' : ''}${clockOffsetUi.toFixed(1)} h · ${speed}×`}
                  </span>
                </button>
                {clockOpen && (
                  <div className="clock-scrub" onClick={(e) => e.stopPropagation()}>
                    <div className="clock-scrub-row">
                      <button type="button" onClick={() => { sim.nudgeClockHours(-1); setClockOffsetUi(sim.clockOffsetHours()); }}>−1 h</button>
                      <button type="button" onClick={() => { sim.resetClockToNow(); setClockOffsetUi(0); }}>Teraz</button>
                      <button type="button" onClick={() => { sim.nudgeClockHours(1); setClockOffsetUi(sim.clockOffsetHours()); }}>+1 h</button>
                    </div>
                    <label className="clock-scrub-label">
                      −24 h
                      <input
                        type="range" min={-24} max={24} step={0.25} value={clockOffsetUi}
                        onChange={(e) => {
                          sim.setClockOffsetHours(Number(e.target.value));
                          setClockOffsetUi(sim.clockOffsetHours());
                        }}
                      />
                      +24 h
                    </label>
                  </div>
                )}
              </div>
              <button type="button" className={paused ? '' : 'on'} onClick={() => setPaused(!paused)}>{paused ? 'Play' : 'Pauza'}</button>
              {[1, 2, 5].map((n) => (
                <button key={n} type="button" className={speed === n ? 'on' : ''} onClick={() => setSpeed(n)}>{n}×</button>
              ))}
              <button type="button" className={topDown ? 'on' : ''} onClick={() => setTopDown(!topDown)} title="Perspektywa">Perspektywa</button>
              <button type="button" className="help-btn" onClick={() => setHelpOpen(true)} title="Sterowanie">?</button>
            </div>
          </>
        )}
      </header>

      <SearchBox
        city={city}
        goto={goto}
        topOffset={!showMetrics}
        visible={showSearch}
        onHide={() => setShowSearch(false)}
      />

      {showModeBar && (
        <nav className="mode-bar" aria-label="Tryby pracy">
          {([
            ['build', 'Buduj', '1'],
            ['analyze', 'Analiza', '2'],
            ['events', 'Zdarzenia', '3'],
            ['history', 'Historia', '4'],
          ] as const).map(([id, label, key]) => (
            <button
              key={id}
              type="button"
              className={mode === id ? 'on' : ''}
              onClick={() => setMode(mode === id ? null : id)}
            >
              {label} <small>{key}</small>
            </button>
          ))}
          <button type="button" disabled={!sim.history.canUndo} onClick={() => act(() => sim.undo(), '')} title="Z">↶</button>
          <button type="button" disabled={!sim.history.canRedo} onClick={() => act(() => sim.redo(), '')} title="Y">↷</button>
        </nav>
      )}

      <div className={`col left${leftCollapsed ? ' collapsed' : ''}`}>
        <button type="button" className="side-toggle left-toggle" title="Warstwy mapy i dane" onClick={() => setLeftCollapsed((v) => !v)}>
          {leftCollapsed ? '›' : '‹'}
        </button>
        <div className="side-stack">
          <DataPanel pipe={pipe} city={city} />
          <LayersPanel layers={layers} toggle={toggleLayer} />
        </div>
      </div>

      <div className={`col right${rightCollapsed ? ' collapsed' : ''}${showHistory ? ' history-wide' : ''}`}>
        <button type="button" className="side-toggle right-toggle" onClick={() => setRightCollapsed((v) => !v)}>
          {rightCollapsed ? '‹' : '›'}
        </button>
        <div className="side-stack">
          {showCatalog && (
            <CatalogPanel
              buildId={buildId}
              setBuildId={setBuildId}
              tool={tool}
              setTool={setTool}
              buildRot={buildRot}
              rotateBuild={rotateBuild}
              open
            />
          )}
          {showAnalysis && (
            <AnalysisPanel
              analysis={analysis}
              toggleAnalysis={toggleAnalysis}
              layers={layers}
              toggleLayer={toggleLayer}
            />
          )}
          {showEvents && <EventsPanel disaster={disaster} setDisaster={setDisaster} />}
          {showHistory && <HistoryPanel versions={versions} onRestore={onRestoreVersion} />}
          {report && (
            <ConsequencePanel
              report={report}
              pending={pending}
              pendingDisaster={pendingDisaster}
              onConfirm={onConfirmPending}
              onConfirmDisaster={onConfirmDisaster}
              onCancel={onCancelPending}
              onDismiss={onDismissReport}
            />
          )}
          {vehicle && <VehicleCard vehicle={vehicle} city={city} setVehicle={setVehicle} />}
          {r && !report && (
            <aside className="panel">
              <h2>{r.edge.name || formatCoords((r.edge.ax + r.edge.bx) / 2, (r.edge.az + r.edge.bz) / 2)}</h2>
              <p className="sub">{r.edge.roadClass} · {Math.round(r.edge.len)} m</p>
              <dl>
                <dt>DANE ŹRÓDŁOWE</dt>
                <dd><span className={`tag ${r.baselineOrigin.toLowerCase()}`}>{r.baselineOrigin}</span> {pct(r.baseline)}</dd>
                <dt>PREDYKCJA</dt>
                <dd>{pct(r.predicted)} <small>szacunek</small></dd>
                <dt>Status</dt>
                <dd className={r.closed ? 'bad' : ''}>{status}</dd>
              </dl>
              <div className="acts">
                {acts.map((a) => <button key={a.label} type="button" onClick={a.run}>{a.label}{a.cost ? <small> {formatBudgetPln(a.cost)}</small> : null}</button>)}
              </div>
            </aside>
          )}
          {b && !report && (
            <aside className="panel">
              <h2>{b.name ?? (b.landmark ? 'Obiekt charakterystyczny' : 'Budynek OSM')}</h2>
              <p className="sub">Obrys OpenStreetMap</p>
              <dl>
                <dt>Typ</dt><dd>zabudowa / obiekt miejski</dd>
                <dt>Wysokość</dt><dd>{b.h.toFixed(1)} m</dd>
                <dt>Obrys</dt><dd>{b.w.toFixed(0)} × {b.d.toFixed(0)} m</dd>
              </dl>
              <p className="note">Budynków OSM nie można zburzyć — dane źródłowe zostają nietknięte. Zburz działa tylko dla budynków gracza.</p>
              <div className="acts">
                <button type="button" onClick={() => goto(b.x, b.z, { kind: 'building', id: sel!.id })}>Wycentruj</button>
              </div>
            </aside>
          )}
          {pb && !report && (
            <aside className="panel">
              <h2>{pb.name}</h2>
              <p className="sub">SIMULATED · budynek gracza</p>
              <dl>
                <dt>Typ</dt><dd>{pb.kind}</dd>
                <dt>Mieszkańcy</dt><dd>{pb.residents}</dd>
                <dt>Praca</dt><dd>{pb.jobs}</dd>
                <dt>Ruch</dt><dd>szacunek modelu</dd>
              </dl>
              <div className="acts">
                <button type="button" onClick={() => goto(pb.x, pb.z)}>Wycentruj</button>
                <button type="button" className="danger" title="Delete / Backspace" onClick={() => {
                  act(() => sim.removePlayerBuilding(pb.id), `Zburzono: ${pb.name}.`);
                  setSel(null);
                  setVehicle(null);
                }}>Zburz</button>
              </div>
            </aside>
          )}
          {!showHistory && !showCatalog && !showAnalysis && !showEvents && <EnvironmentCard city={city} />}
        </div>
      </div>

      {mode === 'analyze' && (
        <nav className="tools">
          {(['simulated', 'baseline', 'predicted'] as TrafficView[]).map((v) => (
            <button key={v} type="button" className={trafficView === v ? 'on' : ''} onClick={() => setTrafficView(v)}>
              {v === 'simulated' ? 'Kolor: symulacja' : v === 'baseline' ? 'Kolor: dane' : 'Kolor: predykcja'}
            </button>
          ))}
          <button
            type="button"
            className={layers.has('labels') ? 'on' : ''}
            title="Etykiety miejsc, przystanków i ulic"
            onClick={() => toggleLayer('labels')}
          >
            Napisy
          </button>
        </nav>
      )}

      <div className="hint">
        {pending ? 'Podgląd budowy – Anuluj / Zatwierdź w panelu.'
          : pendingDisaster ? 'Podgląd scenariusza – Anuluj / Uruchom symulację.'
            : mode === 'build' ? (selectedSpec ? `${selectedSpec.label}: kliknij mapę · R obraca.`
              : tool === 'road' || tool === 'tram-track' ? 'Kliknij początek, potem koniec odcinka.'
                : tool === 'stop-bus' || tool === 'stop-tram' ? 'Kliknij miejsce przystanku na mapie.'
                  : 'Wybierz obiekt z katalogu po prawej.')
              : mode === 'events' ? `Kliknij miejsce: ${DISASTERS[disaster].label}.`
                : mode === 'analyze' ? 'Warstwy modelu i mapy w panelu po prawej · Napisy na dole.'
                  : mode === 'history' ? 'Porównaj lub przywróć wersję jako nową.'
                    : 'LPM = obrót · PPM = przesuwanie · ? = sterowanie · Widok = prawy dół.'}
      </div>
      {toast && <div className="toast">{toast}</div>}

      <div className="chrome-br">
        {showMinimap && (
          <Minimap
            bounds={mapBounds}
            area={city.area}
            cam={camSample}
            landmarks={landmarks}
            onGoto={(x, z) => goto(x, z)}
            onFitCity={fitCity}
          />
        )}
        {dockOpen ? (
          <div className="ui-dock" role="toolbar" aria-label="Widok">
            <div className="ui-dock-head">
              <span className="ui-dock-label">Widok</span>
              <button
                type="button"
                className="ui-dock-collapse"
                title="Zwiń Widok"
                aria-label="Zwiń Widok"
                onClick={() => setDockOpen(false)}
              >
                ▾
              </button>
            </div>
            <button type="button" className={showSearch ? 'on' : ''} onClick={() => setShowSearch((v) => !v)}>Szukaj</button>
            <button
              type="button"
              className={showMetrics ? 'on' : ''}
              onClick={() => { setShowMetrics((v) => !v); setClockOpen(false); }}
            >
              Metryki
            </button>
            <button type="button" className={sidesHidden ? '' : 'on'} onClick={toggleSides}>Panele</button>
            <button type="button" className={showMinimap ? 'on' : ''} onClick={() => setShowMinimap((v) => !v)}>Minimapa</button>
            <button type="button" className={showFoot ? 'on' : ''} onClick={() => setShowFoot((v) => !v)}>Stopka</button>
            <button type="button" className={showModeBar ? 'on' : ''} onClick={() => setShowModeBar((v) => !v)}>Tryby</button>
          </div>
        ) : (
          <button
            type="button"
            className="ui-dock-fab"
            title="Pokaż Widok"
            aria-label="Pokaż Widok"
            onClick={() => setDockOpen(true)}
          >
            Widok
          </button>
        )}
      </div>

      <HelpSheet open={helpOpen} onClose={() => setHelpOpen(false)} />

      {showFoot && (
        <div className="foot">
          <span className="sim">SIMULATED</span> {s.cars} aut, {s.trams} tram., {s.buses} autob., {s.peds} pieszych ·
          <span className="obs"> OBSERVED</span> {s.realVehicles} live MPK ·
          v{versions[versions.length - 1]?.id ?? 1} · {formatAge(s.assignmentAt)}
          {roadFrom ? ' · punkt startowy zaznaczony' : ''}
          {changes.length ? ` · zmian ${changes.length}` : ''}
        </div>
      )}
    </>
  );
}
