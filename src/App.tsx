import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sim as SimEngine } from './simulation/sim';
import { pipeline, type PipelineSnapshot } from './data/pipeline';
import type { CityData } from './data/model';
import { toLatLon } from './data/geo';
import { CityScene } from './scene/CityScene';
import { defaultLayers } from './scene/layers';
import type { FleetPose, FlyTarget, PlaceKind, PendingBuild, Sel, Tool, TrafficView } from './scene/types';
import type { DisasterKind } from './simulation/city/player';
import { Hud } from './ui/Hud';
import { buildSpec, type BuildId } from './simulation/city/catalog';
import {
  appendChange, ensureRootVersion, listVersions, restoreVersion,
  type CityVersion, type PlayerSnapshot,
} from './data/cityStore';
import { START_BUDGET_PLN } from './data/budget';
import {
  metricsSnapshot, previewBuild, reportAfterApply, type ConsequenceReport,
} from './simulation/consequences';

export type { PendingBuild };

export default function App() {
  const [pipe, setPipe] = useState<PipelineSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const off = pipeline.on((s) => { if (alive) setPipe(s); });
    pipeline.start().then((s) => { if (alive) setPipe(s); })
      .catch((e) => { if (alive) setError(String(e)); });
    return () => { alive = false; off(); };
  }, []);

  const city = pipe?.city ?? null;
  if (error) {
    return (
      <div className="boot">
        <h1>Brak danych</h1>
        <p>Nie udało się wczytać wypieczonego zestawu danych Krakowa.</p>
        <pre>{error}</pre>
        <p>Uruchom <code>npm run ingest</code>, aby pobrać dane z OpenStreetMap i ZTP Kraków.</p>
      </div>
    );
  }
  if (!city || !pipe) {
    return (
      <div className="boot">
        <h1>SimCity Kraków</h1>
        <p>Wczytuję dane: OpenStreetMap, GTFS i GTFS-RT ZTP Kraków…</p>
      </div>
    );
  }
  return <SimView city={city} pipe={pipe} />;
}

function toStoreSnapshot(sim: SimEngine): PlayerSnapshot {
  const s = sim.exportPlayerState();
  return {
    buildings: s.buildings.map((b) => ({
      x: b.x, z: b.z, w: b.w, d: b.d, h: b.h,
      kind: b.kind, name: b.name, color: b.color, roof: b.roof,
      residents: b.residents, jobs: b.jobs,
    })),
    parks: s.parks.map((p) => ({ x: p.x, z: p.z, r: p.r, shape: p.shape, w: p.d ? p.r * 2 : undefined, d: p.d ? p.d * 2 : undefined })),
    budget: s.budget,
  };
}

function metricsFromSim(sim: SimEngine) {
  const s = sim.exportPlayerState();
  return {
    traffic: sim.m.traffic,
    satisfaction: sim.m.satisfaction,
    budget: s.budget,
    residents: s.residents,
    jobs: s.jobs,
  };
}

function SimView({ city, pipe }: { city: CityData; pipe: PipelineSnapshot }) {
  const sim = useMemo(() => new SimEngine(city), []);
  const [ver, setVer] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [buildId, setBuildId] = useState<BuildId | null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [trafficView, setTrafficView] = useState<TrafficView>('simulated');
  const [msg, setMsg] = useState({ id: 0, text: '' });
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null);
  const [layers, setLayers] = useState<Set<string>>(defaultLayers);
  const [vehicle, setVehicle] = useState<FleetPose | null>(null);
  const [roadFrom, setRoadFrom] = useState<{ x: number; z: number } | null>(null);
  const [disaster, setDisaster] = useState<DisasterKind>('fire');
  const [topDown, setTopDown] = useState(false);
  const [pending, setPending] = useState<PendingBuild | null>(null);
  const [report, setReport] = useState<ConsequenceReport | null>(null);
  const [versions, setVersions] = useState<CityVersion[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    sim.applyCityData(pipe.city);
    setVer((v) => v + 1);
  }, [sim, pipe.city, pipe.city.liveVehicles]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const latest = await ensureRootVersion();
      if (!alive) return;
      if (latest.snapshot && (latest.snapshot.buildings.length || latest.snapshot.parks.length)) {
        sim.applyPlayerSnapshot({
          buildings: latest.snapshot.buildings.map((b, i) => ({ ...b, id: i })),
          parks: latest.snapshot.parks.map((p) => ({
            x: p.x, z: p.z, r: p.r,
            shape: p.shape,
            d: p.d ? p.d / 2 : p.d,
          })),
          budget: latest.snapshot.budget,
        });
        setVer((v) => v + 1);
      }
      const all = await listVersions();
      if (alive) {
        setVersions(all);
        setReady(true);
      }
    })().catch(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [sim]);

  const refreshVersions = useCallback(async () => {
    setVersions(await listVersions());
  }, []);

  const act = useCallback((fn: () => string | null, ok = '') => {
    const err = fn();
    setMsg((m) => ({ id: m.id + 1, text: err ?? ok }));
    setVer((v) => v + 1);
    return err;
  }, []);

  const goto = useCallback((x: number, z: number, ref?: { kind: 'road' | 'building'; id: number }) => {
    const ll = toLatLon(x, z);
    setFlyTarget({ x, z, y: 60, distance: 220, token: Date.now(), lat: ll.lat, lon: ll.lon });
    if (ref?.kind === 'road') setSel({ kind: 'road', id: ref.id });
    else if (ref?.kind === 'building') setSel({ kind: 'building', id: ref.id });
    else setSel(null);
  }, []);

  const persistAction = useCallback(async (label: string, type: string, reportData?: ConsequenceReport, payload?: Record<string, unknown>) => {
    const v = await appendChange(
      { type, label, payload, report: reportData },
      metricsFromSim(sim),
      toStoreSnapshot(sim),
    );
    await refreshVersions();
    return v;
  }, [sim, refreshVersions]);

  const confirmPending = useCallback(async () => {
    if (!pending || !ready) return;
    const before = metricsSnapshot(sim);
    const spec = buildSpec(pending.buildId);
    const err = sim.addStructure(pending.buildId, pending.x, pending.z);
    if (err) {
      setMsg((m) => ({ id: m.id + 1, text: err }));
      return;
    }
    const after = reportAfterApply(spec.label, before, metricsSnapshot(sim), pending.report.observations.slice(0, 2));
    setReport(after);
    setPending(null);
    setTool('select');
    setBuildId(null);
    setVer((v) => v + 1);
    setMsg((m) => ({ id: m.id + 1, text: `Zatwierdzono: ${spec.label}` }));
    await persistAction(`Dodano: ${spec.label}`, 'build', after, {
      buildId: pending.buildId, x: pending.x, z: pending.z,
    });
  }, [pending, sim, persistAction, ready]);

  const cancelPending = useCallback(() => {
    setPending(null);
    setMsg((m) => ({ id: m.id + 1, text: 'Anulowano planowaną budowę.' }));
  }, []);

  const commitPlace = (x: number, z: number, x2: number, z2: number) => {
    if (pending) return;
    if (tool === 'select') {
      let best = -1, bd = Infinity;
      for (const r of sim.roads) {
        const e = r.edge;
        const t = Math.max(0, Math.min(1, ((x - e.ax) * e.hx + (z - e.az) * e.hz) / e.len));
        const d = Math.hypot(x - (e.ax + e.hx * e.len * t), z - (e.az + e.hz * e.len * t));
        if (d < bd) { bd = d; best = e.id; }
      }
      if (best >= 0 && bd < 45) { setSel({ kind: 'road', id: best }); setVehicle(null); }
      return;
    }
    if (tool === 'build' && buildId) {
      const spec = buildSpec(buildId);
      const near = sim.roads.reduce((best, r) => Math.max(best, r.level), 0.2);
      setPending({
        buildId,
        x, z,
        report: previewBuild(spec, near),
      });
      setReport(previewBuild(spec, near));
      setMsg((m) => ({ id: m.id + 1, text: `Podgląd: ${spec.label} — zatwierdź lub anuluj.` }));
      return;
    }
    if (tool === 'road') {
      if (!roadFrom) { setRoadFrom({ x, z }); setMsg((m) => ({ id: m.id + 1, text: 'Kliknij drugi koniec nowej drogi.' })); return; }
      const before = metricsSnapshot(sim);
      const err = act(() => sim.addRoad(roadFrom.x, roadFrom.z, x2, z2, false), 'Dodano nową drogę.');
      setRoadFrom(null);
      if (!err) {
        const after = reportAfterApply('Nowa droga', before, metricsSnapshot(sim));
        setReport(after);
        void persistAction('Dodano nową drogę', 'road', after);
        setTool('select');
      }
      return;
    }
    if (tool === 'tram-track') {
      if (!roadFrom) { setRoadFrom({ x, z }); setMsg((m) => ({ id: m.id + 1, text: 'Kliknij drugi koniec torowiska.' })); return; }
      const before = metricsSnapshot(sim);
      const err = act(() => sim.addTramTrack(roadFrom.x, roadFrom.z, x2, z2), 'Dodano torowisko tramwajowe.');
      setRoadFrom(null);
      if (!err) {
        const after = reportAfterApply('Torowisko', before, metricsSnapshot(sim));
        setReport(after);
        void persistAction('Dodano torowisko', 'tram-track', after);
        setTool('select');
      }
      return;
    }
    if (tool === 'park') {
      const before = metricsSnapshot(sim);
      if (!act(() => sim.addPark(x, z, 'circle'), 'Posadzono park (koło).')) {
        const after = reportAfterApply('Park', before, metricsSnapshot(sim));
        setReport(after);
        void persistAction('Posadzono park', 'park', after);
        setTool('select');
      }
      return;
    }
    if (tool === 'park-rect') {
      if (!roadFrom) { setRoadFrom({ x, z }); setMsg((m) => ({ id: m.id + 1, text: 'Kliknij przeciwległy róg prostokątnego parku.' })); return; }
      const w = Math.abs(x2 - roadFrom.x) || 40;
      const d = Math.abs(z2 - roadFrom.z) || 28;
      const cx = (roadFrom.x + x2) / 2, cz = (roadFrom.z + z2) / 2;
      const before = metricsSnapshot(sim);
      const err = act(() => sim.addPark(cx, cz, 'rect', Math.max(24, w), Math.max(20, d)), 'Posadzono park (prostokąt).');
      setRoadFrom(null);
      if (!err) {
        const after = reportAfterApply('Park prostokątny', before, metricsSnapshot(sim));
        setReport(after);
        void persistAction('Posadzono park (prostokąt)', 'park', after);
        setTool('select');
      }
      return;
    }
    if (tool === 'stop-bus' || tool === 'stop-tram') {
      const mode = tool === 'stop-tram' ? 'tram' : 'bus';
      const rid = nearestRoadId(sim, x, z, mode === 'tram');
      if (rid < 0) {
        setMsg((m) => ({ id: m.id + 1, text: mode === 'tram' ? 'Kliknij bliżej torowiska.' : 'Kliknij bliżej ulicy.' }));
        return;
      }
      const before = metricsSnapshot(sim);
      const err = act(() => sim.addStopAt(rid, mode), mode === 'tram' ? 'Postawiono przystanek tramwajowy.' : 'Postawiono przystanek autobusowy.');
      if (!err) {
        const after = reportAfterApply(mode === 'tram' ? 'Przystanek tramwajowy' : 'Przystanek autobusowy', before, metricsSnapshot(sim));
        setReport(after);
        void persistAction(`Przystanek ${mode}`, 'stop', after);
        setTool('select');
      }
      return;
    }
    if (tool === 'disaster') {
      const before = metricsSnapshot(sim);
      const err = act(() => sim.triggerDisaster(disaster, x, z), 'Katastrofa wywołana.');
      if (!err) {
        const after = reportAfterApply(`Katastrofa: ${disaster}`, before, metricsSnapshot(sim));
        setReport(after);
        void persistAction(`Katastrofa: ${disaster}`, 'disaster', after);
        setTool('select');
      }
    }
  };

  const onGround = (x: number, z: number) => commitPlace(x, z, x, z);

  const toggleLayer = (id: string) => setLayers((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const onRestore = useCallback(async (id: number) => {
    const v = await restoreVersion(id);
    const snap = v.snapshot ?? { buildings: [], parks: [], budget: START_BUDGET_PLN };
    sim.applyPlayerSnapshot({
      buildings: snap.buildings.map((b, i) => ({ ...b, id: i })),
      parks: snap.parks.map((p) => ({
        x: p.x, z: p.z, r: p.r, shape: p.shape, d: p.d ? p.d / 2 : undefined,
      })),
      budget: snap.budget,
    });
    setVer((x) => x + 1);
    setReport({
      title: v.label,
      summary: 'Przywrócono wcześniejszy stan miasta. Historia wersji pozostaje kompletna.',
      observations: [{ text: `Utworzono ${v.label}.`, kind: 'info', confidence: 'wysoka' }],
      impacts: [],
      horizons: [],
      estimatedResidents: 0,
      estimatedJobs: 0,
      cost: 0,
    });
    setMsg((m) => ({ id: m.id + 1, text: v.label }));
    await refreshVersions();
  }, [sim, refreshVersions]);

  const placeKind: PlaceKind | null =
    pending ? 'build'
      : tool === 'select' || tool === 'disaster' ? null
        : tool === 'build' ? 'build'
          : (tool as PlaceKind);

  return (
    <div className="app">
      <CityScene
        sim={sim}
        city={pipe.city}
        ver={ver}
        tool={tool}
        speed={speed}
        paused={paused}
        sel={sel}
        trafficView={trafficView}
        layers={layers}
        placeKind={placeKind}
        buildId={pending?.buildId ?? buildId}
        roadFrom={roadFrom}
        selectedVehicle={vehicle?.id ?? null}
        flyTo={flyTarget}
        onSelect={(s) => { setSel(s); if (s) setVehicle(null); }}
        onGround={onGround}
        onCommit={commitPlace}
        topDown={topDown}
        onBounds={useCallback(() => undefined, [])}
        onPickVehicle={(id: string) => {
          const real = pipe.city.liveVehicles.find((v) => v.id === id);
          if (real) setVehicle({ id: real.id, x: real.x, z: real.z, yaw: 0, ref: real.line, observed: true, info: real.headsign });
        }}
      />
      <Hud
        sim={sim}
        city={pipe.city}
        ver={ver}
        sel={sel}
        tool={tool}
        buildId={buildId}
        setBuildId={(id) => { setBuildId(id); setTool(id ? 'build' : 'select'); setPending(null); setRoadFrom(null); }}
        paused={paused}
        speed={speed}
        trafficView={trafficView}
        msg={msg}
        pipe={pipe}
        flyMode={false}
        vehicle={vehicle}
        goto={goto}
        layers={layers}
        toggleLayer={toggleLayer}
        setTool={(t) => { setTool(t); setRoadFrom(null); if (t !== 'build') setBuildId(null); setPending(null); }}
        topDown={topDown}
        setTopDown={setTopDown}
        setPaused={setPaused}
        setSpeed={setSpeed}
        setTrafficView={setTrafficView}
        setVehicle={setVehicle}
        setFlyMode={() => undefined}
        disaster={disaster}
        setDisaster={setDisaster}
        roadFrom={roadFrom}
        act={act}
        pending={pending}
        report={report}
        onConfirmPending={() => void confirmPending()}
        onCancelPending={cancelPending}
        onDismissReport={() => setReport(null)}
        versions={versions}
        onRestoreVersion={(id) => void onRestore(id)}
      />
    </div>
  );
}

function nearestRoadId(sim: SimEngine, x: number, z: number, preferTram = false): number {
  let best = -1, bd = Infinity;
  for (const r of sim.roads) {
    const e = r.edge;
    if (preferTram && e.roadClass !== 'tram' && !e.hasTram) continue;
    const t = Math.max(0, Math.min(1, ((x - e.ax) * e.hx + (z - e.az) * e.hz) / e.len));
    const d = Math.hypot(x - (e.ax + e.hx * e.len * t), z - (e.az + e.hz * e.len * t));
    if (d < bd) { bd = d; best = e.id; }
  }
  return bd < (preferTram ? 55 : 45) ? best : -1;
}

export interface PlaceRef { kind: 'road' | 'building'; id: number }
