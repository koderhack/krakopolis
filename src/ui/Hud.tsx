import { useEffect, useMemo, useState } from 'react';
import { COST, type Sim } from '../simulation/sim';
import type { CityData } from '../data/model';
import type { FleetPose, Sel, Tool, TrafficView, PendingBuild } from '../scene/types';
import { LAYERS } from '../scene/layers';
import { DISASTERS, type DisasterKind } from '../simulation/city/player';
import type { PipelineSnapshot } from '../data/pipeline';
import { formatAge } from '../data/cache/store';
import type { Origin } from '../data/types';
import { formatCoords } from '../data/adapters/cityAdapter';
import { buildIndex, search, KIND_LABEL, type Place } from '../scene/search';
import type { PlaceRef } from '../scene/types';
import { BUILD_GROUPS, CATALOG, type BuildId } from '../simulation/city/catalog';
import type { ConsequenceReport } from '../simulation/consequences';
import type { CityVersion } from '../data/cityStore';
import { compareVersions } from '../data/cityStore';
import { formatBudgetPln, KRAKOW_BUDGET_2025 } from '../data/budget';

interface Props {
  sim: Sim;
  city: CityData;
  ver: number;
  sel: Sel;
  tool: Tool;
  buildId: BuildId | null;
  setBuildId: (id: BuildId | null) => void;
  pending: PendingBuild | null;
  report: ConsequenceReport | null;
  versions: CityVersion[];
  onConfirmPending: () => void;
  onCancelPending: () => void;
  onDismissReport: () => void;
  onRestoreVersion: (id: number) => void;
  paused: boolean;
  speed: number;
  trafficView: TrafficView;
  msg: { id: number; text: string };
  pipe: PipelineSnapshot;
  flyMode: boolean;
  vehicle: FleetPose | null;
  goto: (x: number, z: number, ref?: PlaceRef) => void;
  layers: Set<string>;
  toggleLayer: (id: string) => void;
  disaster: DisasterKind;
  setDisaster: (d: DisasterKind) => void;
  roadFrom: { x: number; z: number } | null;
  setTool: (t: Tool) => void;
  topDown: boolean;
  setTopDown: (v: boolean) => void;
  setPaused: (b: boolean) => void;
  setSpeed: (n: number) => void;
  setTrafficView: (v: TrafficView) => void;
  setFlyMode: (v: boolean) => void;
  setVehicle: (v: FleetPose | null) => void;
  act: (fn: () => string | null, ok?: string) => void;
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
  city, goto, topOffset, collapsed, setCollapsed,
}: {
  city: CityData;
  goto: Props['goto'];
  topOffset?: boolean;
  collapsed: boolean;
  setCollapsed: (v: boolean) => void;
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

  if (collapsed) return null;

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
            if (e.key === 'Escape') { setOpen(false); setCollapsed(true); (e.target as HTMLInputElement).blur(); }
          }}
        />
        <button
          type="button"
          className="search-collapse"
          title="Ukryj wyszukiwarkę"
          aria-label="Ukryj wyszukiwarkę"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => { setCollapsed(true); setOpen(false); }}
        >
          Ukryj
        </button>
      </div>
      {open && results.length > 0 && (
        <ul>
          {results.map((p, i) => (
            <li key={i} onMouseDown={() => pick(p)}>
              <b>{p.name}</b>
              <span>{p.detail ?? KIND_LABEL[p.kind]}</span>
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
  report, pending, onConfirm, onCancel, onDismiss,
}: {
  report: ConsequenceReport;
  pending: PendingBuild | null;
  onConfirm: () => void;
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
      {pending ? (
        <div className="acts confirm-acts">
          <button className="primary" onClick={onConfirm}>Zatwierdź zmianę</button>
          <button onClick={onCancel}>Anuluj</button>
        </div>
      ) : (
        <div className="acts">
          <button onClick={onDismiss}>Zamknij</button>
        </div>
      )}
      <p className="note">Wyniki to SIMULATED / szacunek modelu – nie „AI predictions”.</p>
    </aside>
  );
}

function CatalogPanel({
  buildId, setBuildId, open, setOpen,
}: {
  buildId: BuildId | null;
  setBuildId: (id: BuildId | null) => void;
  open: boolean;
  setOpen: (v: boolean) => void;
}) {
  if (!open) return null;
  return (
    <aside className="panel catalog">
      <h2>Zbuduj <small>katalog</small></h2>
      <p className="sub">Wybierz typ → kliknij mapę → zatwierdź</p>
      {BUILD_GROUPS.map((g) => (
        <div key={g} className="cat-group">
          <h3>{g}</h3>
          {CATALOG.filter((c) => c.group === g).map((c) => (
            <button
              key={c.id}
              className={buildId === c.id ? 'on' : ''}
              onClick={() => { setBuildId(c.id); setOpen(false); }}
              title={c.desc}
            >
              <i className="swatch" style={{ background: c.color }} />
              <span>{c.label}</span>
              <small>{formatBudgetPln(c.cost)}</small>
            </button>
          ))}
        </div>
      ))}
    </aside>
  );
}

function HistoryPanel({ versions, onRestore }: { versions: CityVersion[]; onRestore: (id: number) => void }) {
  const recent = versions.slice(-8).reverse();
  const [cmp, setCmp] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      if (versions.length < 2) { setCmp(null); return; }
      const a = versions[versions.length - 2];
      const b = versions[versions.length - 1];
      const d = await compareVersions(a.id, b.id);
      if (!alive || !d) return;
      const x = d.delta;
      setCmp(`v${a.id}→v${b.id}: mieszkańcy ${x.residents >= 0 ? '+' : ''}${x.residents}, praca ${x.jobs >= 0 ? '+' : ''}${x.jobs}, budżet ${x.budget >= 0 ? '+' : ''}${Math.round(x.budget)}, budynki ${x.buildings >= 0 ? '+' : ''}${x.buildings}`);
    })();
    return () => { alive = false; };
  }, [versions]);
  if (!recent.length) return null;
  return (
    <aside className="changes history">
      <h3>Historia miasta <small>IndexedDB</small></h3>
      {cmp && <p className="cmp-line">{cmp}</p>}
      {recent.map((v) => (
        <div key={v.id} className="chg">
          <span>v{v.id} · {v.label}</span>
          <em>{new Date(v.createdAt).toLocaleString('pl-PL', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })}</em>
          {v.id < (versions[versions.length - 1]?.id ?? 0) && (
            <button type="button" className="mini" onClick={() => onRestore(v.id)} title="Nowa wersja z tego stanu">Przywróć</button>
          )}
        </div>
      ))}
      <p className="dp-note">Przywrócenie tworzy nową wersję – historia zostaje.</p>
    </aside>
  );
}

/* ------------------------------------------------------------------- HUD */

export function Hud({
  sim, city, sel, tool, buildId, setBuildId, pending, report, versions,
  onConfirmPending, onCancelPending, onDismissReport, onRestoreVersion,
  paused, speed, trafficView, msg, pipe, flyMode, vehicle, goto,
  layers, toggleLayer, disaster, setDisaster, roadFrom, setTool, topDown, setTopDown,
  setPaused, setSpeed, setTrafficView, setFlyMode, setVehicle, act,
}: Props) {
  const [s, setS] = useState(() => sim.snapshot());
  const [toast, setToast] = useState('');
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [topCollapsed, setTopCollapsed] = useState(false);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  const [clockOffsetUi, setClockOffsetUi] = useState(0);

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

  const r = sel?.kind === 'road' ? sim.roads[sel.id] : null;
  const b = sel?.kind === 'building' ? city.buildings[sel.id] : null;

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
    {
      label: 'Dodaj przystanek',
      cost: COST.stop,
      run: () => act(() => sim.addStop(r.edge.id), 'Dodano przystanek (zmiana gracza).'),
    },
  ] : [];

  const changes = sim.playerChanges();
  const selectedSpec = buildId ? CATALOG.find((c) => c.id === buildId) : null;

  return (
    <>
      <header className={`top${topCollapsed ? ' collapsed' : ''}`}>
        {!topCollapsed && (
          <>
            <div className="brand">
              <b>SimCity Kraków</b>
              <span>3D z prawdziwymi danymi OSM + ZTP</span>
            </div>
            <div className="metrics">
              {METRICS.map((m) => (
                <div key={m.k} className="metric">
                  <span>{m.label}</span>
                  <strong>{Math.round(s[m.k])}</strong>
                  <Bar v={s[m.k]} bad={m.bad} />
                </div>
              ))}
              <div className="metric" title={`Fundusz inwestycyjny obszaru · baseline z budżetu Krakowa ${KRAKOW_BUDGET_2025.year} (${KRAKOW_BUDGET_2025.origin})`}>
                <span>Budżet</span>
                <strong>{formatBudgetPln(s.budget)}</strong>
              </div>
            </div>
            <div className="ctrl">
              <div className={`sim-clock${clockOpen ? ' open' : ''}`}>
                <button
                  type="button"
                  className="sim-clock-btn"
                  title="Kliknij, aby przewinąć czas ±24 h"
                  onClick={() => setClockOpen((v) => !v)}
                >
                  <span className="sim-clock-label">Czas</span>
                  <strong className="sim-clock-time">{s.clock}</strong>
                  <span className="sim-clock-meta">
                    {Math.abs(clockOffsetUi) < 0.02 && speed === 1 && !paused
                      ? 'na żywo'
                      : paused
                        ? 'pauza'
                        : `${clockOffsetUi >= 0 ? '+' : ''}${clockOffsetUi.toFixed(1)} h · ${speed}×`}
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
                        type="range"
                        min={-24}
                        max={24}
                        step={0.25}
                        value={clockOffsetUi}
                        onChange={(e) => {
                          const h = Number(e.target.value);
                          sim.setClockOffsetHours(h);
                          setClockOffsetUi(sim.clockOffsetHours());
                        }}
                      />
                      +24 h
                    </label>
                    <p className="clock-scrub-hint">Flota MPK (SIMULATED) zależy od godziny. Live GTFS chowa się przy scrubbingu. 2×/5× też przesuwa zegar (max ±24 h).</p>
                  </div>
                )}
              </div>
              <button className={paused ? '' : 'on'} onClick={() => setPaused(!paused)}>{paused ? 'Play' : 'Pauza'}</button>
              {[1, 2, 5].map((n) => <button key={n} className={speed === n ? 'on' : ''} onClick={() => setSpeed(n)}>{n}×</button>)}
              <button className={topDown ? 'on' : ''} onClick={() => setTopDown(!topDown)} title="Perspektywa: z góry albo poziomo z ulicy">Perspektywa</button>
              <button className={flyMode ? 'on' : ''} onClick={() => setFlyMode(!flyMode)} title="Tryb lotu: WASD, Q/E góra-dół, mysz rozglądanie, Shift przyspieszenie">
                Tryb lotu
              </button>
            </div>
          </>
        )}
        <button
          type="button"
          className="chrome-toggle top-chrome-toggle"
          title={topCollapsed ? 'Rozwiń pasek górny' : 'Zwiń pasek górny'}
          aria-label={topCollapsed ? 'Rozwiń pasek górny' : 'Zwiń pasek górny'}
          onClick={() => { setTopCollapsed((v) => !v); setClockOpen(false); }}
        >
          {topCollapsed ? '▾ metryki' : '▴'}
        </button>
      </header>

      <SearchBox
        city={city}
        goto={goto}
        topOffset={topCollapsed}
        collapsed={searchCollapsed}
        setCollapsed={setSearchCollapsed}
      />

      <div className="ui-dock" title="Pokaż / ukryj elementy UI">
        <button
          type="button"
          className={searchCollapsed ? '' : 'on'}
          onClick={() => setSearchCollapsed((v) => !v)}
        >
          {searchCollapsed ? 'Pokaż szukaj' : 'Ukryj szukaj'}
        </button>
        <button
          type="button"
          className={bottomCollapsed ? '' : 'on'}
          onClick={() => setBottomCollapsed((v) => !v)}
        >
          {bottomCollapsed ? 'Pokaż narzędzia' : 'Ukryj narzędzia'}
        </button>
        <button
          type="button"
          className={topCollapsed ? '' : 'on'}
          onClick={() => { setTopCollapsed((v) => !v); setClockOpen(false); }}
        >
          {topCollapsed ? 'Pokaż metryki' : 'Ukryj metryki'}
        </button>
      </div>

      <div className={`col left${leftCollapsed ? ' collapsed' : ''}`}>
        <button
          type="button"
          className="side-toggle left-toggle"
          aria-label={leftCollapsed ? 'Rozwiń panel danych' : 'Zwiń panel danych'}
          title={leftCollapsed ? 'Rozwiń panel' : 'Zwiń panel'}
          onClick={() => setLeftCollapsed((v) => !v)}
        >
          {leftCollapsed ? '›' : '‹'}
        </button>
        <div className="side-stack">
          <DataPanel pipe={pipe} city={city} />
          <LayersPanel layers={layers} toggle={toggleLayer} />
        </div>
      </div>

      <div className={`col right${rightCollapsed ? ' collapsed' : ''}`}>
        <button
          type="button"
          className="side-toggle right-toggle"
          aria-label={rightCollapsed ? 'Rozwiń panel szczegółów' : 'Zwiń panel szczegółów'}
          title={rightCollapsed ? 'Rozwiń panel' : 'Zwiń panel'}
          onClick={() => setRightCollapsed((v) => !v)}
        >
          {rightCollapsed ? '‹' : '›'}
        </button>
        <div className="side-stack">
          <DonePanel sim={sim} />
          {report && (
            <ConsequencePanel
              report={report}
              pending={pending}
              onConfirm={onConfirmPending}
              onCancel={onCancelPending}
              onDismiss={onDismissReport}
            />
          )}
          <CatalogPanel
            buildId={buildId}
            setBuildId={setBuildId}
            open={catalogOpen}
            setOpen={setCatalogOpen}
          />
          {vehicle && <VehicleCard vehicle={vehicle} city={city} setVehicle={setVehicle} />}
          {r && (
            <aside className="panel">
              <h2>{r.edge.name || formatCoords((r.edge.ax + r.edge.bx) / 2, (r.edge.az + r.edge.bz) / 2)}</h2>
              <p className="sub">
                {r.edge.roadClass} · {Math.round(r.edge.len)} m · {r.edge.carAccess ? `drogi ${r.edge.roadClass}` : 'chodnik / torowisko'}
              </p>
              <dl>
                <dt title={ORIGIN_TITLE[r.baselineOrigin]}>DANE ŹRÓDŁOWE</dt>
                <dd>
                  <span className={`tag ${r.baselineOrigin.toLowerCase()}`}>{r.baselineOrigin}</span>
                  <Bar v={r.baseline * 100} /> {pct(r.baseline)}
                </dd>
                <dt title="Wynik przypisania ruchu po zmianach gracza">PREDYKCJA SYMULACJI</dt>
                <dd>
                  <Bar v={r.predicted * 100} /> {pct(r.predicted)}
                </dd>
                <dt>Prędkość</dt>
                <dd>{r.baselineSpeed ? `${(r.baselineSpeed * 3.6).toFixed(0)} km/h` : '—'}</dd>
                <dt>Przepustowość</dt>
                <dd>{r.capacity > 0 ? `${r.capacity} poj./15 min (${r.edge.lanesForward} pas.)` : 'Data unavailable'}</dd>
                <dt>Komunikacja</dt>
                <dd>{r.transit ? 'tak – trasa z GTFS' : 'nie'}{r.realStop ? ' · przystanek' : ''}</dd>
                <dt>Status</dt>
                <dd className={r.closed ? 'bad' : ''}>{status}</dd>
              </dl>
              <div className="acts">
                {acts.map((a) => <button key={a.label} onClick={a.run}>{a.label}{a.cost ? <small> {formatBudgetPln(a.cost)}</small> : null}</button>)}
              </div>
              <p className="note">Wartości „DANE ŹRÓDŁOWE” pochodzą z OSM/ZTP i nie zmieniają się przez grę.</p>
            </aside>
          )}
          {b && (
            <aside className="panel">
              <h2>{b.name ?? (b.landmark ? 'Obiekt charakterystyczny' : 'Budynk z OSM')}</h2>
              <p className="sub">
                {b.name === 'zabudowa uzupełniająca'
                  ? 'SIMULATED – uzupełnienie pustych działek przy ulicach'
                  : 'Obrys z OpenStreetMap · wysokość z tagów OSM'}
              </p>
              <dl>
                <dt>Wysokość</dt><dd>{b.h.toFixed(1)} m</dd>
                <dt>Obrys</dt><dd>{b.w.toFixed(0)} × {b.d.toFixed(0)} m</dd>
                <dt>Kolor</dt><dd><span className="swatch" style={{ background: b.color }} /> {b.color} · dach {b.roof}</dd>
              </dl>
              <p className="note">Jeśli brak tagu <code>height</code> / <code>building:levels</code>, przyjęto wartość domyślną dla typu budynku.</p>
            </aside>
          )}
          <EnvironmentCard city={city} />
          <HistoryPanel versions={versions} onRestore={onRestoreVersion} />
          {changes.length > 0 && (
            <aside className="changes">
              <h3>Zmiany gracza <small>scenariusz</small></h3>
              {changes.slice(0, 8).map((c, i) => (
                <div key={i} className="chg">
                  <span>{c.roadId} · {c.name || '—'}</span>
                  <em>{CHANGE_LABEL[c.change]}</em>
                </div>
              ))}
              {changes.length > 8 && <p className="dp-note">…i {changes.length - 8} więcej</p>}
              <p className="dp-note">Konsekwencje są <b>symulowane</b>. Dane źródłowe pozostają bez zmian.</p>
            </aside>
          )}
        </div>
      </div>

      {bottomCollapsed ? null : (
      <nav className="tools">
        <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')}>Zaznacz</button>
        <button
          disabled={!sim.history.canUndo}
          title="Cofnij ostatnią decyzję"
          onClick={() => act(() => sim.undo(), '')}
        >
          ↶ Cofnij <small>{sim.history.depth}</small>
        </button>
        <span className="toolsep" />
        {r && acts.map((a) => (
          <button key={a.label} onClick={a.run}>{a.label}{a.cost ? <small> {formatBudgetPln(a.cost)}</small> : null}</button>
        ))}
        <span className="toolsep" />
        <button
          className={tool === 'build' || catalogOpen ? 'on' : ''}
          onClick={() => {
            if (tool === 'build' && catalogOpen) { setCatalogOpen(false); setTool('select'); setBuildId(null); }
            else { setCatalogOpen(true); setTool('build'); }
          }}
        >
          Zbuduj {selectedSpec ? <small>{selectedSpec.label}</small> : <small>katalog</small>}
        </button>
        {([
          ['park', 'Park (koło)', COST.park],
          ['park-rect', 'Park (prostokąt)', COST.park],
          ['stop-bus', 'Przystanek autobusowy', COST.stop],
          ['stop-tram', 'Przystanek tramwajowy', COST.stopTram],
          ['tram-track', 'Torowisko', COST.road],
          ['road', 'Nowa droga', COST.road],
        ] as const).map(([k, label, cost]) => (
          <button key={k} className={tool === k ? 'on' : ''} onClick={() => { setTool(tool === k ? 'select' : k); setCatalogOpen(false); }}>
            {label} <small>{formatBudgetPln(cost)}</small>
          </button>
        ))}
        <button
          className={tool === 'disaster' ? 'on danger' : ''}
          onClick={() => setTool(tool === 'disaster' ? 'select' : 'disaster')}
        >
          Katastrofa <small>{formatBudgetPln(DISASTERS[disaster].cost)}</small>
        </button>
        {tool === 'disaster' && (
          <select className="disaster-pick" value={disaster} onChange={(e) => setDisaster(e.target.value as DisasterKind)}>
            {(Object.keys(DISASTERS) as DisasterKind[]).map((k) => (
              <option key={k} value={k}>{DISASTERS[k].label}</option>
            ))}
          </select>
        )}
        <span className="toolsep" />
        {(['simulated', 'baseline', 'predicted'] as TrafficView[]).map((v) => (
          <button key={v} className={trafficView === v ? 'on' : ''} onClick={() => setTrafficView(v)}>
            {v === 'simulated' ? 'Kolor: symulacja' : v === 'baseline' ? 'Kolor: dane' : 'Kolor: predykcja'}
          </button>
        ))}
        <button
          type="button"
          className="chrome-toggle bottom-chrome-toggle"
          title="Ukryj pasek narzędzi"
          onClick={() => setBottomCollapsed(true)}
        >
          Ukryj
        </button>
      </nav>
      )}

      {!bottomCollapsed && (
        <div className="hint">
          {pending ? 'Podgląd budowy – zatwierdź lub anuluj w panelu konsekwencji.'
            : tool === 'build' ? (selectedSpec ? `Kliknij mapę, aby zaplanować: ${selectedSpec.label}.` : 'Wybierz typ budynku z katalogu.')
              : tool === 'park' ? 'Kliknij w teren, aby posadzić park okrągły.'
                : tool === 'park-rect' ? (roadFrom ? 'Kliknij przeciwległy róg prostokąta.' : 'Kliknij pierwszy róg prostokątnego parku.')
                  : tool === 'stop-bus' ? 'Kliknij przy ulicy, aby postawić przystanek autobusowy.'
                    : tool === 'stop-tram' ? 'Kliknij przy torowisku, aby postawić przystanek tramwajowy.'
                      : tool === 'tram-track' ? (roadFrom ? 'Kliknij drugi koniec torowiska.' : 'Kliknij początek nowego torowiska.')
                        : tool === 'road' ? (roadFrom ? 'Kliknij drugi koniec drogi.' : 'Kliknij pierwszy koniec drogi.')
                          : tool === 'disaster' ? `Kliknij miejsce katastrofy: ${DISASTERS[disaster].label}.`
                            : flyMode
                              ? 'Tryb lotu: WASD / strzałki – ruch, Q i E – wysokość, mysz – rozglądanie, Shift – przyspieszenie, kółko – zbliżenie.'
                              : r || b || vehicle ? '' : 'UI: pasek „Ukryj…” w prawym dolnym rogu.'}
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}

      {!bottomCollapsed && (
        <div className="foot">
          <span className="sim">SIMULATED</span> {s.cars} aut, {s.trams} tramwajów, {s.buses} autobusów, {s.peds} pieszych ·
          <span className="obs"> OBSERVED</span> {s.realVehicles} realnych pojazdów MPK ({s.realTrams} tram., {s.realBuses} autob.) ·
          realnych przystanków {city.stops.length} · zmian gracza {changes.length} ·
          wersja miasta v{versions[versions.length - 1]?.id ?? 1} ·
          predykcja przeliczona {formatAge(s.assignmentAt)}
        </div>
      )}
    </>
  );
}