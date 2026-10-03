import { useCallback, useEffect, useMemo, useState } from 'react';
import { Sim as SimEngine } from './simulation/sim';
import { pipeline, type PipelineSnapshot } from './data/pipeline';
import type { CityData } from './data/model';
import { toLatLon } from './data/geo';
import { CityScene } from './scene/CityScene';
import { defaultLayers } from './scene/layers';
import type { FleetPose, FlyTarget, PlaceKind, Sel, Tool, TrafficView } from './scene/types';
import type { DisasterKind } from './simulation/city/player';
import { Hud } from './ui/Hud';


export default function App() {
  // Stan miasta przychodzi wyłącznie z warstwy danych – nie ma lokalnego fallbacku.
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
        <p>Uruchom <code>npm run ingest</code>, aby pobrać prawdziwe dane z OpenStreetMap i ZTP Kraków.</p>
      </div>
    );
  }
  if (!city || !pipe) {
    return (
      <div className="boot">
        <h1>SimCity Kraków</h1>
        <p>Wczytuję prawdziwe dane: OpenStreetMap, GTFS i GTFS-RT ZTP Kraków…</p>
      </div>
    );
  }
  return <SimView city={city} pipe={pipe} />;
}

function SimView({ city, pipe }: { city: CityData; pipe: PipelineSnapshot }) {
  const sim = useMemo(() => new SimEngine(city), []);
  const [ver, setVer] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
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

  useEffect(() => {
    sim.applyCityData(pipe.city);
    setVer((v) => v + 1);
  }, [sim, pipe.city, pipe.city.liveVehicles]);

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

  /** Zatwierdzenie ustawienia obiektu (niebieski duch w Cesium). */
  const commitPlace = (x: number, z: number, x2: number, z2: number) => {
    if (tool === 'select') {
      // kliknięcie w podłoże bez narzędzia – wybieramy najbliższą ulicę
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
    if (tool === 'road') {
      if (!roadFrom) { setRoadFrom({ x, z }); setMsg((m) => ({ id: m.id + 1, text: 'Kliknij drugi koniec nowej drogi.' })); return; }
      const err = act(() => sim.addRoad(roadFrom.x, roadFrom.z, x2, z2, false), 'Dodano nową drogę.');
      setRoadFrom(null);
      if (!err) setTool('select');
      return;
    }
    if (tool === 'mall' || tool === 'university') {
      const err = act(() => sim.addStructure(tool, x, z), tool === 'mall' ? 'Wybudowano centrum handlowe.' : 'Wybudowano uczelnię.');
      if (!err) setTool('select');
      return;
    }
    if (tool === 'park') {
      if (!act(() => sim.addPark(x, z), 'Posadzono park.')) setTool('select');
      return;
    }
    if (tool === 'stop-bus' || tool === 'stop-tram') {
      const rid = nearestRoadId(sim, x, z);
      if (rid < 0) { setMsg((m) => ({ id: m.id + 1, text: 'Kliknij bliżej ulicy, aby postawić przystanek.' })); return; }
      const mode = tool === 'stop-tram' ? 'tram' : 'bus';
      const err = act(() => sim.addStopAt(rid, mode), mode === 'tram' ? 'Postawiono przystanek tramwajowy.' : 'Postawiono przystanek autobusowy.');
      if (!err) setTool('select');
      return;
    }
    if (tool === 'disaster') {
      const err = act(() => sim.triggerDisaster(disaster, x, z), 'Katastrofa wywołana.');
      if (!err) setTool('select');
    }
  };

  /** Kliknięcie w podłoże – stawianie obiektów albo wybór najbliższej ulicy. */
  const onGround = (x: number, z: number) => commitPlace(x, z, x, z);

  const toggleLayer = (id: string) => setLayers((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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
        placeKind={tool === 'select' || tool === 'disaster' ? null : (tool as PlaceKind)}
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
        setTool={setTool}
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
      />
    </div>
  );
}

function nearestRoadId(sim: SimEngine, x: number, z: number): number {
  let best = -1, bd = Infinity;
  for (const r of sim.roads) {
    const e = r.edge;
    const t = Math.max(0, Math.min(1, ((x - e.ax) * e.hx + (z - e.az) * e.hz) / e.len));
    const d = Math.hypot(x - (e.ax + e.hx * e.len * t), z - (e.az + e.hz * e.len * t));
    if (d < bd) { bd = d; best = e.id; }
  }
  return bd < 45 ? best : -1;
}

export interface PlaceRef { kind: 'road' | 'building'; id: number }