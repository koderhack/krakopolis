import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Sim as SimEngine } from './simulation/sim';
import { pipeline, type PipelineSnapshot } from './data/pipeline';
import type { CityData } from './data/model';
import { toLatLon } from './data/geo';
import { CityScene } from './scene/CityScene';
import { defaultLayers } from './scene/layers';
import type {
  FleetPose, FlyTarget, PlaceKind, PendingBuild, PendingDisaster,
  Sel, Tool, TrafficView, WorkspaceMode,
} from './scene/types';
import type { DisasterKind } from './simulation/city/player';
import { Hud } from './ui/Hud';
import { buildSpec, type BuildId } from './simulation/city/catalog';
import {
  appendChange, ensureRootVersion, listVersions, restoreVersion,
  type CityVersion, type PlayerSnapshot,
} from './data/cityStore';
import { START_BUDGET_PLN } from './data/budget';
import {
  metricsSnapshot, previewBuild, previewDisasterReport, reportAfterApply, type ConsequenceReport,
} from './simulation/consequences';
import type { MiniCam } from './ui/Minimap';
import { ANALYSIS_LAYERS } from './scene/analysis';

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
        <h1>Krakopolis</h1>
        <p>Nie udało się wczytać miasta. Odśwież stronę lub spróbuj później.</p>
        <pre>{error}</pre>
      </div>
    );
  }
  if (!city || !pipe) {
    return (
      <div className="boot">
        <h1>Krakopolis</h1>
        <p>Wczytuję Kraków…</p>
      </div>
    );
  }
  return <SimView city={city} pipe={pipe} />;
}

function toStoreSnapshot(sim: SimEngine): PlayerSnapshot {
  const s = sim.exportPlayerState();
  return {
    buildings: s.buildings.map((b) => ({
      x: b.x, z: b.z, w: b.w, d: b.d, h: b.h, rot: b.rot,
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

function isTypingTarget(el: EventTarget | null) {
  const t = el as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

function SimView({ city, pipe }: { city: CityData; pipe: PipelineSnapshot }) {
  const sim = useMemo(() => new SimEngine(city), []);
  const [ver, setVer] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [mode, setMode] = useState<WorkspaceMode>(null);
  const [buildId, setBuildId] = useState<BuildId | null>(null);
  const [buildRot, setBuildRot] = useState(0);
  const [sel, setSel] = useState<Sel>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [trafficView, setTrafficView] = useState<TrafficView>('simulated');
  const [msg, setMsg] = useState({ id: 0, text: '' });
  const [flyTarget, setFlyTarget] = useState<FlyTarget | null>(null);
  const [layers, setLayers] = useState<Set<string>>(defaultLayers);
  const [analysis, setAnalysis] = useState<Set<string>>(new Set());
  const [vehicle, setVehicle] = useState<FleetPose | null>(null);
  const [neoSelected, setNeoSelected] = useState(false);
  const [roadFrom, setRoadFrom] = useState<{ x: number; z: number } | null>(null);
  const [disaster, setDisaster] = useState<DisasterKind>('fire');
  const [topDown, setTopDown] = useState(false);
  const [pending, setPending] = useState<PendingBuild | null>(null);
  const [pendingDisaster, setPendingDisaster] = useState<PendingDisaster | null>(null);
  const [report, setReport] = useState<ConsequenceReport | null>(null);
  const [versions, setVersions] = useState<CityVersion[]>([]);
  const [ready, setReady] = useState(false);
  const [mapBounds, setMapBounds] = useState({ minX: -800, maxX: 800, minZ: -800, maxZ: 800 });
  const [camSample, setCamSample] = useState<MiniCam | null>(null);
  const camRef = useRef<MiniCam | null>(null);

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

  const goto = useCallback((x: number, z: number, ref?: { kind: 'road' | 'building'; id: number }, modeFly: FlyTarget['mode'] = 'focus') => {
    const ll = toLatLon(x, z);
    setFlyTarget({
      x, z, y: 60, distance: modeFly === 'fit' ? 1800 : 160,
      token: Date.now(), lat: ll.lat, lon: ll.lon, mode: modeFly,
    });
    if (ref?.kind === 'road') setSel({ kind: 'road', id: ref.id });
    else if (ref?.kind === 'building') setSel({ kind: 'building', id: ref.id });
  }, []);

  const fitCity = useCallback(() => {
    goto(0, 0, undefined, 'fit');
  }, [goto]);

  const persistAction = useCallback(async (label: string, type: string, reportData?: ConsequenceReport, payload?: Record<string, unknown>) => {
    const v = await appendChange(
      { type, label, payload, report: reportData },
      metricsFromSim(sim),
      toStoreSnapshot(sim),
    );
    await refreshVersions();
    return v;
  }, [sim, refreshVersions]);

  const cancelAll = useCallback(() => {
    setPending(null);
    setPendingDisaster(null);
    setRoadFrom(null);
    setBuildId(null);
    setBuildRot(0);
    setTool('select');
    setReport(null);
    setMsg((m) => ({ id: m.id + 1, text: 'Anulowano.' }));
  }, []);

  const confirmPending = useCallback(async () => {
    if (!pending || !ready) return;
    const before = metricsSnapshot(sim);
    const spec = buildSpec(pending.buildId);
    const err = sim.addStructure(pending.buildId, pending.x, pending.z, pending.rot);
    if (err) {
      setMsg((m) => ({ id: m.id + 1, text: err }));
      return;
    }
    const after = reportAfterApply(spec.label, before, metricsSnapshot(sim), pending.report.observations.slice(0, 2));
    setReport(after);
    setPending(null);
    setTool('select');
    setBuildId(null);
    setBuildRot(0);
    setMode(null);
    setVer((v) => v + 1);
    setMsg((m) => ({ id: m.id + 1, text: `Zatwierdzono: ${spec.label}` }));
    await persistAction(`Dodano: ${spec.label}`, 'build', after, {
      buildId: pending.buildId, x: pending.x, z: pending.z, rot: pending.rot,
    });
  }, [pending, sim, persistAction, ready]);

  const confirmDisaster = useCallback(async () => {
    if (!pendingDisaster || !ready) return;
    const before = metricsSnapshot(sim);
    const err = act(() => sim.triggerDisaster(pendingDisaster.kind, pendingDisaster.x, pendingDisaster.z), 'Scenariusz uruchomiony.');
    if (!err) {
      const after = reportAfterApply(pendingDisaster.label, before, metricsSnapshot(sim));
      setReport(after);
      setPendingDisaster(null);
      setTool('select');
      setMode(null);
      await persistAction(`Scenariusz: ${pendingDisaster.label}`, 'disaster', after);
    }
  }, [pendingDisaster, ready, sim, act, persistAction]);

  const cancelPending = useCallback(() => {
    setPending(null);
    setPendingDisaster(null);
    setMsg((m) => ({ id: m.id + 1, text: 'Anulowano planowaną zmianę.' }));
  }, []);

  /** Tylko preview / pending – bez kasowania istniejących budynków. */
  const cancelPreviewOnly = useCallback(() => {
    if (pending || pendingDisaster || roadFrom || buildId) {
      setPending(null);
      setPendingDisaster(null);
      setRoadFrom(null);
      setBuildId(null);
      setBuildRot(0);
      setReport(null);
      if (mode === 'build') setTool('build');
      else if (mode === 'events') setTool('disaster');
      else setTool('select');
      setMsg((m) => ({ id: m.id + 1, text: 'Anulowano podgląd.' }));
      return true;
    }
    return false;
  }, [pending, pendingDisaster, roadFrom, buildId, mode]);

  const deleteArmed = useRef<number | null>(null);

  const setWorkspaceMode = useCallback((m: WorkspaceMode) => {
    setMode((prev) => {
      const next = prev === m ? null : m;
      setPending(null);
      setPendingDisaster(null);
      setRoadFrom(null);
      if (next === 'build') {
        setTool('build');
      } else if (next === 'events') {
        setTool('disaster');
        setBuildId(null);
      } else if (next === 'analyze' || next === null) {
        setTool('select');
        setBuildId(null);
      }
      return next;
    });
  }, []);

  const toggleAnalysis = useCallback((id: string) => {
    setAnalysis((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      const def = ANALYSIS_LAYERS.find((a) => a.id === id);
      if (def?.mapLayer) {
        setLayers((L) => {
          const n = new Set(L);
          if (next.has(id)) n.add(def.mapLayer!);
          return n;
        });
      }
      if (id === 'ax-traffic' || id === 'ax-infra' || id === 'ax-problem') {
        setTrafficView('simulated');
      }
      return next;
    });
  }, []);

  const commitPlace = (x: number, z: number, x2: number, z2: number) => {
    if (pending || pendingDisaster) return;
    if (tool === 'select') {
      let best = -1, bd = Infinity;
      for (const r of sim.roads) {
        const e = r.edge;
        const t = Math.max(0, Math.min(1, ((x - e.ax) * e.hx + (z - e.az) * e.hz) / e.len));
        const d = Math.hypot(x - (e.ax + e.hx * e.len * t), z - (e.az + e.hz * e.len * t));
        if (d < bd) { bd = d; best = e.id; }
      }
      if (best >= 0 && bd < 45) { setSel({ kind: 'road', id: best }); setVehicle(null); setNeoSelected(false); }
      else { setSel(null); setVehicle(null); setNeoSelected(false); }
      return;
    }
    if (tool === 'build' && buildId) {
      const spec = buildSpec(buildId);
      const near = sim.roads.reduce((best, r) => Math.max(best, r.level), 0.2);
      const rep = previewBuild(spec, near);
      setPending({ buildId, x, z, rot: buildRot, report: rep });
      setReport(rep);
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
        setMode(null);
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
        setMode(null);
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
        setMode(null);
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
        setMode(null);
      }
      return;
    }
    if (tool === 'stop-bus' || tool === 'stop-tram') {
      const stopMode = tool === 'stop-tram' ? 'tram' : 'bus';
      const rid = nearestRoadId(sim, x, z, stopMode === 'tram');
      if (rid < 0) {
        setMsg((m) => ({ id: m.id + 1, text: stopMode === 'tram' ? 'Kliknij bliżej torowiska.' : 'Kliknij bliżej ulicy.' }));
        return;
      }
      const before = metricsSnapshot(sim);
      const err = act(() => sim.addStopAt(rid, stopMode), stopMode === 'tram' ? 'Postawiono przystanek tramwajowy.' : 'Postawiono przystanek autobusowy.');
      if (!err) {
        const after = reportAfterApply(stopMode === 'tram' ? 'Przystanek tramwajowy' : 'Przystanek autobusowy', before, metricsSnapshot(sim));
        setReport(after);
        void persistAction(`Przystanek ${stopMode}`, 'stop', after);
        setTool('select');
        setMode(null);
      }
      return;
    }
    if (tool === 'disaster') {
      const prev = sim.previewDisaster(disaster, x, z);
      const rep = previewDisasterReport({
        label: prev.label,
        cost: prev.cost,
        roads: prev.roads.length,
        radius: prev.radius,
        estimatedAffected: prev.estimatedAffected,
        effects: prev.effects,
      });
      setPendingDisaster({
        kind: disaster, x, z,
        roads: prev.roads,
        radius: prev.radius,
        estimatedAffected: prev.estimatedAffected,
        cost: prev.cost,
        label: prev.label,
        report: rep,
      });
      setReport(rep);
      setMsg((m) => ({ id: m.id + 1, text: `Podgląd: ${prev.label} — uruchom lub anuluj.` }));
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
      summary: 'Przywrócono wcześniejszy stan miasta jako nową wersję. Historia pozostaje kompletna.',
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

  // Skróty klawiszowe (nie działają w input/textarea).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const k = e.key.toLowerCase();

      // ENTER — zatwierdź podgląd (budowa / katastrofa)
      if (e.key === 'Enter') {
        if (pending) {
          e.preventDefault();
          void confirmPending();
          return;
        }
        if (pendingDisaster) {
          e.preventDefault();
          void confirmDisaster();
          return;
        }
      }

      // BACKSPACE — tylko anuluj preview (NIGDY nie usuwa budynku)
      if (e.key === 'Backspace') {
        if (pending || pendingDisaster || roadFrom || (tool === 'build' && buildId)) {
          e.preventDefault();
          cancelPreviewOnly();
          return;
        }
        return;
      }

      if (k === 'escape') {
        e.preventDefault();
        if (pending || pendingDisaster || roadFrom || buildId) {
          cancelPreviewOnly();
          return;
        }
        cancelAll();
        setSel(null);
        setVehicle(null);
        setNeoSelected(false);
        setMode(null);
        return;
      }
      if (k === ' ' || e.code === 'Space') {
        e.preventDefault();
        setPaused((p) => !p);
        return;
      }
      if (k === 'z' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        act(() => sim.undo(), '');
        return;
      }
      if (k === 'y' && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        act(() => sim.redo(), '');
        return;
      }
      if (k === 'r' && (tool === 'build' || pending)) {
        e.preventDefault();
        setBuildRot((r) => {
          const next = (r + Math.PI / 2) % (Math.PI * 2);
          if (pending) setPending({ ...pending, rot: next });
          return next;
        });
        return;
      }
      // DELETE — tylko zaznaczony budynek gracza, po potwierdzeniu (2× Delete)
      if (e.key === 'Delete') {
        if (sel?.kind === 'player') {
          e.preventDefault();
          const id = sel.id;
          if (deleteArmed.current !== id) {
            deleteArmed.current = id;
            const name = sim.playerBuildings.find((b) => b.id === id)?.name ?? 'budynek';
            setMsg((m) => ({ id: m.id + 1, text: `Naciśnij Delete ponownie, aby zburzyć: ${name}.` }));
            window.setTimeout(() => { if (deleteArmed.current === id) deleteArmed.current = null; }, 3500);
            return;
          }
          deleteArmed.current = null;
          const name = sim.playerBuildings.find((b) => b.id === id)?.name ?? 'budynek';
          act(() => sim.removePlayerBuilding(id), `Zburzono: ${name}.`);
          setSel(null);
          return;
        }
        if (sel?.kind === 'building') {
          e.preventDefault();
          setMsg((m) => ({
            id: m.id + 1,
            text: 'Tego budynku nie można zburzyć — tylko budynki, które sam postawiłeś.',
          }));
          return;
        }
      }
      if (k === 'n') {
        e.preventDefault();
        fitCity();
        return;
      }
      if (k === '1') { e.preventDefault(); setWorkspaceMode('build'); return; }
      if (k === '2') { e.preventDefault(); setWorkspaceMode('analyze'); return; }
      if (k === '3') { e.preventDefault(); setWorkspaceMode('events'); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    act, buildId, cancelAll, cancelPreviewOnly, confirmDisaster, confirmPending,
    fitCity, pending, pendingDisaster, roadFrom, sel, setWorkspaceMode, sim, tool,
  ]);

  // Komunikaty z modelu katastrof
  useEffect(() => {
    const t = window.setInterval(() => {
      const notes = sim.takeNotices();
      if (notes.length) {
        setMsg((m) => ({ id: m.id + 1, text: notes[notes.length - 1] }));
      }
    }, 500);
    return () => window.clearInterval(t);
  }, [sim]);

  const placeKind: PlaceKind | null =
    pending ? 'build'
      : tool === 'select' || tool === 'disaster' ? null
        : tool === 'build' ? 'build'
          : (tool as PlaceKind);

  const landmarks = useMemo(
    () => city.buildings.filter((b) => b.landmark).map((b) => ({ x: b.x, z: b.z })),
    [city.buildings],
  );

  const onCameraSample = useCallback((s: MiniCam) => {
    camRef.current = s;
    // throttled state update for minimap (Rig already samples ~5 Hz)
    setCamSample(s);
  }, []);

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
        buildRot={pending?.rot ?? buildRot}
        pendingPose={pending ? { x: pending.x, z: pending.z, rot: pending.rot } : null}
        roadFrom={roadFrom}
        selectedVehicle={vehicle?.id ?? null}
        neoSelected={neoSelected}
        flyTo={flyTarget}
        disasterPreview={pendingDisaster ? { x: pendingDisaster.x, z: pendingDisaster.z, radius: pendingDisaster.radius } : null}
        onSelect={(s) => { setSel(s); if (s) { setVehicle(null); setNeoSelected(false); } }}
        onGround={onGround}
        onCommit={commitPlace}
        onFocusObject={(x, z) => goto(x, z, undefined, 'focus')}
        topDown={topDown}
        onBounds={setMapBounds}
        onCameraSample={onCameraSample}
        onPickVehicle={(id: string) => {
          const real = pipe.city.liveVehicles.find((v) => v.id === id);
          if (real) {
            setNeoSelected(false);
            setVehicle({ id: real.id, x: real.x, z: real.z, yaw: 0, ref: real.line, observed: true, info: real.headsign });
          }
        }}
        onPickNeo={() => { setNeoSelected(true); setVehicle(null); setSel(null); }}
      />
      <Hud
        sim={sim}
        city={pipe.city}
        ver={ver}
        sel={sel}
        tool={tool}
        mode={mode}
        setMode={setWorkspaceMode}
        buildId={buildId}
        setBuildId={(id) => {
          setBuildId(id);
          setTool(id ? 'build' : 'select');
          setMode(id ? 'build' : null);
          setPending(null);
          setRoadFrom(null);
          setBuildRot(0);
        }}
        buildRot={buildRot}
        rotateBuild={() => setBuildRot((r) => (r + Math.PI / 2) % (Math.PI * 2))}
        paused={paused}
        speed={speed}
        trafficView={trafficView}
        msg={msg}
        pipe={pipe}
        vehicle={vehicle}
        neoSelected={neoSelected}
        setNeoSelected={setNeoSelected}
        goto={goto}
        fitCity={fitCity}
        layers={layers}
        toggleLayer={toggleLayer}
        analysis={analysis}
        toggleAnalysis={toggleAnalysis}
        setTool={(t) => {
          setTool(t);
          setRoadFrom(null);
          if (t !== 'build') setBuildId(null);
          setPending(null);
          setPendingDisaster(null);
          if (t === 'build' || t === 'park' || t === 'park-rect' || t === 'stop-bus' || t === 'stop-tram' || t === 'road' || t === 'tram-track') {
            setMode('build');
          } else if (t === 'disaster') {
            setMode('events');
          } else {
            setMode(null);
          }
        }}
        topDown={topDown}
        setTopDown={setTopDown}
        setPaused={setPaused}
        setSpeed={setSpeed}
        setTrafficView={setTrafficView}
        setVehicle={setVehicle}
        setSel={setSel}
        disaster={disaster}
        setDisaster={setDisaster}
        roadFrom={roadFrom}
        act={act}
        pending={pending}
        pendingDisaster={pendingDisaster}
        report={report}
        onConfirmPending={() => void confirmPending()}
        onConfirmDisaster={() => void confirmDisaster()}
        onCancelPending={cancelPending}
        onDismissReport={() => setReport(null)}
        versions={versions}
        onRestoreVersion={onRestore}
        mapBounds={mapBounds}
        camSample={camSample}
        landmarks={landmarks}
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
