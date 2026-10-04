import { useEffect, useMemo, useRef, useState } from 'react';
import { COST, type Sim, type RoadSim } from '../simulation/sim';
import type { CityData } from '../data/model';
import type {
  FleetPose, Sel, Tool, TrafficView, PendingBuild, PendingDisaster, WorkspaceMode,
} from '../scene/types';
import { LAYERS } from '../scene/layers';
import {
  DEFAULT_TRAFFIC_INTENSITY,
  TRAFFIC_INTENSITY_LEVELS,
  sampleRoadTraffic,
  type TrafficIntensityId,
} from '../scene/analysis';
import { DISASTERS, type DisasterKind } from '../simulation/city/player';
import type { PipelineSnapshot } from '../data/pipeline';
import type { Origin } from '../data/types';
import { formatCoords } from '../data/adapters/cityAdapter';
import { buildIndex, search, KIND_LABEL, type Place } from '../scene/search';
import type { PlaceRef } from '../scene/types';
import { BUILD_GROUPS, CATALOG, buildSpec, type BuildId } from '../simulation/city/catalog';
import { osmBuildingResidents } from '../simulation/city/population';
import type { ConsequenceReport } from '../simulation/consequences';
import type { CityVersion, VersionCompare } from '../data/cityStore';
import { compareVersions } from '../data/cityStore';
import { formatBudgetPln, KRAKOW_BUDGET_2025 } from '../data/budget';
import { useCityAudio, useCityAudioSettings } from '../audio/CityAudio';
import { Minimap, type MiniCam } from './Minimap';
import type { SimBuilding } from '../data/model';

function ringAreaM2(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a) * 0.5;
}

function buildingFootprintM2(b: { w: number; d: number; ring?: [number, number][] }): number {
  if (b.ring && b.ring.length >= 3) return Math.max(1, Math.round(ringAreaM2(b.ring)));
  return Math.max(1, Math.round(b.w * b.d));
}

function osmBuildingTypeLabel(b: SimBuilding): string {
  if (b.landmark) return 'obiekt charakterystyczny';
  if (b.name?.trim()) return 'obiekt nazwany (OSM)';
  const levels = Math.max(1, b.levels ?? Math.round(b.h / 3.3));
  if (b.h >= 28 || levels >= 8) return 'wysoka zabudowa';
  if (b.h >= 14 || levels >= 4) return 'zabudowa wielorodzinna';
  if (b.h >= 8) return 'zabudowa niska / usługowa';
  return 'zabudowa niska';
}

function osmTrafficEstimate(b: SimBuilding, residents: number): number {
  const levels = Math.max(1, b.levels ?? Math.round(b.h / 3.3));
  const area = buildingFootprintM2(b);
  return Math.max(0, Math.round(residents * 0.14 + (area * levels) / 900));
}

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
  trafficIntensity: TrafficIntensityId;
  setTrafficIntensity: (id: TrafficIntensityId) => void;
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

const ORIGIN_LABEL: Record<Origin, string> = {
  OBSERVED: 'na żywo',
  PREDICTED: 'przybliżenie',
  SIMULATED: 'w grze',
};

const pct = (v: number) => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;

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
        <ul><li className="none">Brak wyników dla „{q}”</li></ul>
      )}
    </div>
  );
}

/* ------------------------------------------------- panel wybranego pojazdu */

function VehicleCard({ vehicle, city, setVehicle }: { vehicle: FleetPose; city: CityData; setVehicle: (v: FleetPose | null) => void }) {
  const real = city.liveVehicles.find((v) => v.id === vehicle.id);
  const kind = vehicle.id.startsWith('T:') ? 'tramwaj' : vehicle.id.startsWith('A:') || vehicle.id.startsWith('M:') ? 'autobus' : 'pojazd';
  const line = real?.line ?? vehicle.ref;
  return (
    <aside className="panel vehicle">
      <h2>Linia {line}</h2>
      <p className="sub">{real ? 'Pojazd MPK na żywo' : 'Pojazd w symulacji'}</p>
      <dl>
        <dt>Typ</dt><dd>{kind}</dd>
        <dt>Kierunek</dt><dd>{real?.headsign ?? (vehicle.info ?? '—')}</dd>
        <dt>Status</dt>
        <dd>
          {real
            ? <span className="tag observed">{ORIGIN_LABEL.OBSERVED}</span>
            : <span className="tag simulated">{ORIGIN_LABEL.SIMULATED}</span>}
        </dd>
        {real && (
          <>
            <dt>Prędkość</dt>
            <dd>{real.speed !== undefined ? `${(real.speed * 3.6).toFixed(0)} km/h` : '—'}</dd>
            <dt>Aktualizacja</dt>
            <dd>{new Date(real.timestamp).toLocaleTimeString('pl-PL')}</dd>
          </>
        )}
      </dl>
      <div className="acts">
        <button onClick={() => setVehicle(null)}>Zamknij</button>
      </div>
      <p className="note">
        {real
          ? 'Zielony pierścień oznacza prawdziwy tramwaj lub autobus jadący teraz po Krakowie.'
          : 'Ten pojazd jeździ po trasie MPK w ramach gry.'}
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



/* --------------------------------------------------------------- środowisko */

function EnvironmentCard({ city }: { city: CityData }) {
  const w = city.environment.weather;
  const a = city.environment.airQuality;
  if (!w && !a) return null;
  return (
    <aside className="envcard">
      <h3>Pogoda <small>Kraków</small></h3>
      {w && (
        <div className="env-row">
          <span>{w.description}, {w.temperatureC?.toFixed(1)}°C</span>
        </div>
      )}
      {a && (
        <div className="env-row">
          <span>powietrze: {a.description}{a.pm25 !== undefined ? ` · PM2.5 ${a.pm25.toFixed(1)} µg/m³` : ''}</span>
        </div>
      )}
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
      <h3 className="obs-h">Co się zmieni</h3>
      <ul className="obs-list">
        {report.observations.map((o, i) => (
          <li key={i} className={`obs-${o.kind}`}>
            {o.text}
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
            {pendingDisaster ? 'Uruchom' : 'Zatwierdź'} <small>Enter</small>
          </button>
        </div>
      ) : (
        <div className="acts">
          <button type="button" onClick={onDismiss}>Zamknij</button>
        </div>
      )}
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
  intensity, setIntensity,
}: {
  intensity: TrafficIntensityId;
  setIntensity: (id: TrafficIntensityId) => void;
}) {
  const scaleHint = (() => {
    const l = TRAFFIC_INTENSITY_LEVELS.find((x) => x.id === intensity);
    if (!l || l.id === DEFAULT_TRAFFIC_INTENSITY) return 'bez skalowania';
    return `×${l.scale}`;
  })();
  return (
    <aside className="panel analysis compact">
      <h2>Analiza</h2>
      <p className="sub">Natężenie ruchu na sieci drogowej</p>
      <div className="intensity-block">
        <h3>Natężenie ruchu</h3>
        <div className="intensity-levels" role="radiogroup" aria-label="Natężenie ruchu">
          {TRAFFIC_INTENSITY_LEVELS.map((l) => (
            <button key={l.id} type="button" role="radio" aria-checked={intensity === l.id}
              className={intensity === l.id ? 'on' : ''} onClick={() => setIntensity(l.id)}>
              <i className="dot" style={{ background: l.color }} />
              <span>{l.label}</span>
            </button>
          ))}
        </div>
        <p className="note intensity-hint">Skala względem danych symulacji · {scaleHint}</p>
      </div>
    </aside>
  );
}

function TrafficLegend() {
  return (
    <div className="traffic-legend" aria-label="Legenda natężenia ruchu">
      <strong>NATĘŻENIE RUCHU</strong>
      <ul>
        {TRAFFIC_INTENSITY_LEVELS.map((l) => (
          <li key={l.id}><i style={{ background: l.color }} /><span>{l.label}</span></li>
        ))}
      </ul>
    </div>
  );
}

function RoadAnalysisCard({
  road, intensity, view, acts,
}: {
  road: RoadSim;
  intensity: TrafficIntensityId;
  view: TrafficView;
  acts: { label: string; cost: number; run: () => void }[];
}) {
  const sample = sampleRoadTraffic(road, view, intensity);
  const name = road.edge.name || formatCoords((road.edge.ax + road.edge.bx) / 2, (road.edge.az + road.edge.bz) / 2);
  const pctVal = Math.round(Math.min(1, sample.display) * 100);
  const vehPerH = road.capacity > 0 ? Math.round(sample.display * road.capacity * 4) : 0;
  const speed = road.baselineSpeed != null
    ? Math.round(road.baselineSpeed * (1 - 0.55 * Math.min(1, sample.display)))
    : road.edge.speedLimit > 0
      ? Math.round(road.edge.speedLimit * (1 - 0.7 * Math.min(1, sample.display)))
      : 0;
  const cap = road.capacity > 0 ? Math.round(road.capacity * 4) : 0;
  return (
    <aside className="panel road-analysis">
      <h2>{name}</h2>
      <p className="sub">{sample.level.label}</p>
      <dl>
        <dt>Wartość</dt>
        <dd>
          <span className="intensity-swatch" style={{ background: sample.level.color }} />
          {pctVal}%
          {sample.kind === 'fallback' && <small className="tag predicted">szacunek klasy</small>}
        </dd>
        {vehPerH > 0 && (<><dt>Pojazdy/h</dt><dd>~{vehPerH}</dd></>)}
        {speed > 0 && (<><dt>Prędkość</dt><dd>~{speed} km/h</dd></>)}
        {cap > 0 && (<><dt>Przepustowość</dt><dd>~{cap} poj./h</dd></>)}
      </dl>
      {acts.length > 0 && (
        <div className="acts">
          {acts.map((a) => (
            <button key={a.label} type="button" onClick={a.run}>
              {a.label}{a.cost ? <small> {formatBudgetPln(a.cost)}</small> : null}
            </button>
          ))}
        </div>
      )}
    </aside>
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
      <div className="aim-banner">
        <b>WYBIERZ MIEJSCE</b>
        <span>Kliknij na mapie, aby rozpocząć: {DISASTERS[disaster].label}.</span>
        <small>Esc / Backspace anuluje · bez tworzenia zdarzenia</small>
      </div>
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
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: {
  versions: CityVersion[];
  onRestore: (id: number) => void | Promise<void>;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
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
      setFlash(`Przywrócono v${id} jako nową wersję.`);
    } catch {
      setFlash(`Nie udało się przywrócić v${id}.`);
    } finally {
      setRestoring(null);
    }
  };

  return (
    <div className="brand-hist-body">
      <div className="brand-hist-acts">
        <button type="button" disabled={!canUndo} onClick={onUndo} title="Cofnij (Z)">↶ Cofnij</button>
        <button type="button" disabled={!canRedo} onClick={onRedo} title="Ponów (Y)">↷ Ponów</button>
      </div>

      {!versions.length ? (
        <p className="hist-empty">Brak zapisanych wersji. Po zmianie w mieście pojawi się tu oś czasu.</p>
      ) : (
        <>
          <header className="brand-hist-head">
            <strong>Historia miasta</strong>
            <small>{versions.length} {wersjeLabel(versions.length)}</small>
          </header>

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
                        title="Porównaj z aktualną wersją"
                      >
                        Porównaj
                      </button>
                      <button
                        type="button"
                        className="mini restore"
                        disabled={restoring != null}
                        onClick={() => void runRestore(v.id)}
                        title="Przywróć ten stan jako nową wersję"
                      >
                        {restoring === v.id ? 'Przywracam…' : 'Przywróć'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <p className="dp-note">Przywrócenie tworzy nową wersję — nic nie kasuje.</p>
        </>
      )}
    </div>
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
        <li><kbd>LPM</kbd> przeciągnij — przesuwanie mapy · klik — wybór</li>
        <li><kbd>Scroll</kbd> zoom</li>
        <li><kbd>PPM</kbd> przeciągnij — obrót kamery</li>
        <li><kbd>Shift</kbd>+<kbd>PPM</kbd> pochylenie</li>
        <li><kbd>WASD</kbd> / strzałki — przesuwanie</li>
        <li><kbd>Q</kbd> / <kbd>E</kbd> — obrót widoku</li>
        <li><kbd>R</kbd> obrót budynku (podgląd)</li>
        <li><kbd>Enter</kbd> zatwierdź podgląd</li>
        <li><kbd>Backspace</kbd> anuluj niebieski podgląd</li>
        <li><kbd>Esc</kbd> anuluj akcję</li>
        <li><kbd>Delete</kbd>×2 zburz zaznaczony budynek gracza</li>
        <li><kbd>Z</kbd> / <kbd>Y</kbd> cofnij / ponów</li>
        <li><kbd>Space</kbd> pauza</li>
        <li><kbd>N</kbd> całe miasto</li>
        <li><kbd>1–3</kbd> Buduj / Analiza / Zdarzenia</li>
        <li>Najedź na <b>Krakopolis</b> — historia miasta</li>
        <li>Widok (prawy dół): Szukaj · Metryki · Panele · Minimapa · Stopka · Tryby · Dźwięk miasta</li>
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------- HUD */

export function Hud({
  sim, city, sel, tool, mode, setMode, buildId, setBuildId, buildRot, rotateBuild,
  pending, pendingDisaster, report, versions,
  onConfirmPending, onConfirmDisaster, onCancelPending, onDismissReport, onRestoreVersion,
  paused, speed, trafficView, msg, vehicle, goto, fitCity,
  layers, toggleLayer, trafficIntensity, setTrafficIntensity, disaster, setDisaster, roadFrom, setTool,
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
  const [histOpen, setHistOpen] = useState(false);
  const [histPinned, setHistPinned] = useState(false);
  const histLeaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [clockOffsetUi, setClockOffsetUi] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const audioSettings = useCityAudioSettings();
  const [soundOn, setSoundOn] = useState(audioSettings.initialEnabled);
  const [soundVol, setSoundVol] = useState(audioSettings.initialVolume);
  const { unlock: unlockAudio } = useCityAudio(sim, camSample, soundOn, soundVol);

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
  useEffect(() => () => {
    if (histLeaveTimer.current) clearTimeout(histLeaveTimer.current);
  }, []);

  const r = sel?.kind === 'road' ? sim.roads[sel.id] : null;
  const b = sel?.kind === 'building' ? city.buildings[sel.id] : null;
  const pb = sel?.kind === 'player' ? sim.playerBuildings.find((x) => x.id === sel.id) : null;
  const osmResidents = b ? osmBuildingResidents(b) : 0;
  const osmArea = b ? buildingFootprintM2(b) : 0;
  const osmTraffic = b ? osmTrafficEstimate(b, osmResidents) : 0;
  const pbSpec = pb ? buildSpec(pb.kind) : null;
  const pbArea = pb ? buildingFootprintM2(pb) : 0;
  const pbTraffic = pbSpec ? Math.round(pbSpec.trafficFactor * 100) : 0;

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

  const openHist = () => {
    if (histLeaveTimer.current) {
      clearTimeout(histLeaveTimer.current);
      histLeaveTimer.current = null;
    }
    setClockOpen(false);
    setHistOpen(true);
  };
  const scheduleCloseHist = () => {
    if (histPinned) return;
    if (histLeaveTimer.current) clearTimeout(histLeaveTimer.current);
    histLeaveTimer.current = setTimeout(() => setHistOpen(false), 220);
  };

  return (
    <>
      <header className={`top${!showMetrics ? ' collapsed' : ''}`}>
        {showMetrics && (
          <>
            <div
              className={`brand-hist${histOpen ? ' open' : ''}`}
              onMouseEnter={openHist}
              onMouseLeave={scheduleCloseHist}
            >
              <button
                type="button"
                className="brand-hist-btn"
                title="Historia miasta"
                aria-expanded={histOpen}
                onClick={() => {
                  setClockOpen(false);
                  if (histPinned && histOpen) {
                    setHistPinned(false);
                    setHistOpen(false);
                  } else {
                    setHistPinned(true);
                    setHistOpen(true);
                  }
                }}
              >
                <b>Krakopolis</b>
                <span>planista miejski · historia</span>
              </button>
              {histOpen && (
                <div
                  className="brand-hist-pop"
                  role="dialog"
                  aria-label="Historia miasta"
                  onMouseEnter={openHist}
                  onMouseLeave={scheduleCloseHist}
                >
                  <HistoryPanel
                    versions={versions}
                    onRestore={onRestoreVersion}
                    canUndo={sim.history.canUndo}
                    canRedo={sim.history.canRedo}
                    onUndo={() => act(() => sim.undo(), '')}
                    onRedo={() => act(() => sim.redo(), '')}
                  />
                </div>
              )}
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
                  onClick={() => {
                    setHistOpen(false);
                    setHistPinned(false);
                    setClockOpen((v) => !v);
                  }}
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
          <LayersPanel layers={layers} toggle={toggleLayer} />
        </div>
      </div>

      <div className={`col right${rightCollapsed ? ' collapsed' : ''}${showMinimap ? '' : ' no-mini'}`}>
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
              intensity={trafficIntensity}
              setIntensity={setTrafficIntensity}
            />
          )}
          {showEvents && <EventsPanel disaster={disaster} setDisaster={setDisaster} />}
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
          {r && !report && showAnalysis && (
            <RoadAnalysisCard road={r} intensity={trafficIntensity} view={trafficView} acts={acts} />
          )}
          {r && !report && !showAnalysis && (
            <aside className="panel">
              <h2>{r.edge.name || formatCoords((r.edge.ax + r.edge.bx) / 2, (r.edge.az + r.edge.bz) / 2)}</h2>
              <p className="sub">{Math.round(r.edge.len)} m</p>
              <dl>
                <dt>Ruch teraz</dt>
                <dd><span className={`tag ${r.baselineOrigin.toLowerCase()}`}>{ORIGIN_LABEL[r.baselineOrigin]}</span> {pct(r.baseline)}</dd>
                <dt>Prognoza</dt>
                <dd>{pct(r.predicted)}</dd>
                <dt>Status</dt>
                <dd className={r.closed ? 'bad' : ''}>{status}</dd>
              </dl>
              <div className="acts">
                {acts.map((a) => <button key={a.label} type="button" onClick={a.run}>{a.label}{a.cost ? <small> {formatBudgetPln(a.cost)}</small> : null}</button>)}
              </div>
            </aside>
          )}
          {b && !report && (
            <aside className="panel building-sel">
              <h2>{b.name?.trim() || (b.landmark ? 'Obiekt charakterystyczny' : `Budynek #${sel!.id}`)}</h2>
              <p className="sub">BUDYNEK · mapa miasta (OSM)</p>
              <dl>
                <dt>ID</dt><dd>#{sel!.id}</dd>
                <dt>Typ</dt><dd>{osmBuildingTypeLabel(b)}</dd>
                <dt>Wysokość</dt><dd>{b.h.toFixed(1)} m{(b.levels ?? 0) > 0 ? ` · ~${b.levels} kond.` : ''}</dd>
                <dt>Powierzchnia</dt><dd>{osmArea.toLocaleString('pl-PL')} m²</dd>
                <dt>Mieszkańcy</dt><dd>~{osmResidents} (szacunek)</dd>
                <dt>Ruch</dt><dd>~{osmTraffic} poj./cykl (szacunek)</dd>
                <dt>Status</dt><dd>mapa miasta · nietykalny</dd>
              </dl>
              <p className="note">Tego budynku nie można zburzyć — należy do mapy miasta. Dostępny dla Analizy i Zdarzeń (np. pożar).</p>
              <div className="acts">
                <button type="button" onClick={() => goto(b.x, b.z, { kind: 'building', id: sel!.id })}>Wycentruj</button>
                <button type="button" onClick={() => setSel(null)}>Odznacz</button>
              </div>
            </aside>
          )}
          {pb && !report && (
            <aside className="panel building-sel">
              <h2>{pb.name}</h2>
              <p className="sub">BUDYNEK · Twój obiekt</p>
              <dl>
                <dt>ID</dt><dd>#{pb.id}</dd>
                <dt>Typ</dt><dd>{pbSpec?.label ?? pb.kind}</dd>
                <dt>Wysokość</dt><dd>{pb.h.toFixed(1)} m</dd>
                <dt>Powierzchnia</dt><dd>{pbArea.toLocaleString('pl-PL')} m²</dd>
                <dt>Mieszkańcy</dt><dd>{pb.residents}{pb.jobs ? ` · praca ${pb.jobs}` : ''}</dd>
                <dt>Ruch</dt><dd>~{pbTraffic} (wzgl. katalogu)</dd>
                <dt>Status</dt><dd>postawiony · edytowalny</dd>
              </dl>
              <div className="acts">
                <button type="button" onClick={() => goto(pb.x, pb.z, { kind: 'player', id: pb.id })}>Wycentruj</button>
                <button type="button" onClick={() => setSel(null)}>Odznacz</button>
                <button type="button" className="danger" title="Delete ×2" onClick={() => {
                  act(() => sim.removePlayerBuilding(pb.id), `Zburzono: ${pb.name}.`);
                  setSel(null);
                  setVehicle(null);
                }}>Zburz</button>
              </div>
            </aside>
          )}
          {!showCatalog && !showAnalysis && !showEvents && <EnvironmentCard city={city} />}
        </div>
      </div>

      {showAnalysis && <TrafficLegend />}

      <div className="hint">
        {pending ? 'Podgląd budowy – Enter zatwierdza · Backspace / Esc anuluje.'
          : pendingDisaster ? 'Podgląd scenariusza – Enter uruchamia · Esc anuluje.'
            : mode === 'build' ? (selectedSpec ? `${selectedSpec.label}: kliknij mapę · R obraca · Enter zatwierdza.`
              : tool === 'road' || tool === 'tram-track' ? 'Kliknij początek, potem koniec odcinka.'
                : tool === 'stop-bus' || tool === 'stop-tram' ? 'Kliknij miejsce przystanku na mapie.'
                  : 'Wybierz obiekt z katalogu po prawej.')
              : mode === 'events' ? `WYBIERZ MIEJSCE · ${DISASTERS[disaster].label} — kliknij budynek lub teren · Esc anuluje.`
                : mode === 'analyze' ? 'Wybierz natężenie — mapa koloruje drogi. Kliknij ulicę, by zobaczyć parametry.'
                    : 'LPM = pan · PPM = obrót · ? = sterowanie · Krakopolis = historia.'}
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
            <button
              type="button"
              className={soundOn ? 'on' : ''}
              title="Dźwięk miasta (ambient, ruch, katastrofy)"
              onClick={() => {
                const next = !soundOn;
                setSoundOn(next);
                audioSettings.persistEnabled(next);
                if (next) void unlockAudio();
              }}
            >
              Dźwięk {soundOn ? 'ON' : 'OFF'}
            </button>
            <label className="ui-dock-volume" title="Głośność dźwięku miasta">
              Głośność
              <input
                type="range"
                min={0}
                max={100}
                value={Math.round(soundVol * 100)}
                disabled={!soundOn}
                onChange={(e) => {
                  const v = Number(e.target.value) / 100;
                  setSoundVol(v);
                  audioSettings.persistVolume(v);
                  if (soundOn) void unlockAudio();
                }}
              />
            </label>
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
          <span>{s.cars} aut · {s.trams} tram. · {s.buses} autob. · {s.peds} pieszych</span>
          {s.realVehicles > 0 && <span> · {s.realVehicles} pojazdów MPK na żywo</span>}
          {roadFrom ? ' · punkt startowy zaznaczony' : ''}
          {changes.length ? ` · zmian ${changes.length}` : ''}
        </div>
      )}
    </>
  );
}
