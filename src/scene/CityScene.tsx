/**
 * Scena 3D (react-three-fiber).
 *
 * Warstwy: podłoże z wysokościami DEM, zieleń i woda z OSM, sieć drogowa
 * z torowiskami, budynki z prawdziwych obrysów, przystanki GTFS, pojazdy
 * (realne z GTFS-RT + symulowane), piesi, obiekty gracza i katastrofy.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Sim } from '../simulation/sim';
import type { CityData } from '../data/model';
import { HeightField, setHeightField } from './terrain';
import { Html } from '@react-three/drei';
import {
  areaExtent, Buildings, Closures, DisasterLayer, PlayerParks, PlayerStructures,
  RoadNetwork, Terrain, TrafficView, TransitStops, Trees,
} from './models/City';
import { BusFleet, CarFleet, ObservedMarkers, PedestrianFleet, TramFleet } from './models/Fleets';
import { PlacementGhost, type PlaceKind } from './models/Placement';
import type { FleetPose, Sel } from './types';

export interface CitySceneProps {
  sim: Sim;
  city: CityData;
  ver: number;
  tool: string;
  speed: number;
  paused: boolean;
  sel: Sel;
  trafficView: TrafficView;
  layers: Set<string>;
  placeKind: PlaceKind | null;
  roadFrom: { x: number; z: number } | null;
  selectedVehicle: string | null;
  flyTo: { x: number; z: number; token: number } | null;
  onSelect: (s: Sel) => void;
  onGround: (x: number, z: number) => void;
  onCommit: (x: number, z: number, x2: number, z2: number) => void;
  onPickVehicle: (id: string, kind: 'tram' | 'bus') => void;
}

function Driver({ sim, speed, paused }: { sim: Sim; speed: number; paused: boolean }) {
  useFrame((_, d) => { if (!paused) sim.advance(Math.min(d, 0.12) * speed); });
  return null;
}

function Rig({ focus, flyTo }: { focus: [number, number]; flyTo: CitySceneProps['flyTo'] }) {
  const { camera } = useThree();
  const ctl = useRef<any>(null);
  const t = useRef(0), done = useRef(false);
  const from = useMemo(() => new THREE.Vector3(focus[0] + 900, 620, focus[1] + 1100), [focus]);
  const to = useMemo(() => new THREE.Vector3(focus[0] + 120, 220, focus[1] + 240), [focus]);
  useEffect(() => {
    camera.position.copy(from);
    camera.lookAt(focus[0], 0, focus[1]);
  }, [camera, from, focus]);
  useEffect(() => {
    if (!flyTo) return;
    done.current = true;
    const target = new THREE.Vector3(flyTo.x, 0, flyTo.z);
    const start = camera.position.clone();
    const end = new THREE.Vector3(flyTo.x + 110, 200, flyTo.z + 210);
    const t0 = performance.now();
    const step = () => {
      const k = Math.min(1, (performance.now() - t0) / 1400);
      const e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(start, end, e);
      camera.lookAt(target);
      if (k < 1) requestAnimationFrame(step);
    };
    step();
  }, [flyTo?.token]);
  useFrame((_, dt) => {
    if (done.current) return;
    t.current = Math.min(1, t.current + dt / 5);
    camera.position.lerpVectors(from, to, 1 - Math.pow(1 - t.current, 3));
    if (ctl.current) { ctl.current.target.set(focus[0], 0, focus[1]); ctl.current.update(); }
    if (t.current >= 1) done.current = true;
  });
  return (
    <OrbitControls ref={ctl} makeDefault enableDamping dampingFactor={0.09}
      maxPolarAngle={Math.PI * 0.49} minDistance={18} maxDistance={2600}
      target={[focus[0], 0, focus[1]]} onStart={() => { done.current = true; }} />
  );
}

/** Niebieski podgląd miejsca ustawienia obiektu. */
function Ghost({ kind, roadFrom, onCommit }: { kind: PlaceKind | null; roadFrom: { x: number; z: number } | null; onCommit: CitySceneProps['onCommit'] }) {
  const pt = useRef({ x: 0, z: 0 });
  return kind ? (
    <PlacementGhost
      kind={kind}
      roadFrom={roadFrom}
      point={pt}
      onCommit={onCommit}
    />
  ) : null;
}

/**
 * Etykiety miejsc – warstwa „mapy".
 * Pokazujemy tylko te, które są w zasięgu kamery (limit 90), bo każda etykieta
 * to osobny element DOM i setki ich narastają przy każdym ruchu kamery.
 */
function Labels({ city, ver }: { city: CityData; ver: number }) {
  const { camera } = useThree();
  const [near, setNear] = useState<{ x: number; z: number; name: string; category: string }[]>([]);
  const acc = useRef(0);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 1) return;
    acc.current = 0;
    // wybieramy miejsca najbliższe punktowi, na który patrzy kamera
    const target = camera.getWorldDirection(new THREE.Vector3());
    const cx = camera.position.x + target.x * 900;
    const cz = camera.position.z + target.z * 900;
    const pois = city.pois ?? [];
    const scored = pois
      .map((p) => ({ p, d: Math.hypot(p.x - cx, p.z - cz) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 90);
    const next = scored.map((s) => ({ x: s.p.x, z: s.p.z, name: s.p.name, category: s.p.category }));
    setNear((prev) => (prev.length === next.length && prev.every((p, i) => p.name === next[i].name && p.x === next[i].x) ? prev : next));
  });
  void ver;
  return (
    <group>
      {near.map((p, i) => (
        <Html key={i} position={[p.x, 22, p.z]} center distanceFactor={1200} zIndexRange={[8, 0]} style={{ pointerEvents: 'none' }}>
          <div className="lbl poi"><b>{p.name}</b><span>{p.category}</span></div>
        </Html>
      ))}
    </group>
  );
}

/** Heatmapa ruchu pieszego – wartości z agentów symulacji. */
function PedFlow({ sim, ver }: { sim: Sim; ver: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const D = useMemo(() => new THREE.Object3D(), []);
  const C = useMemo(() => new THREE.Color(), []);
  useLayoutEffectSafe(() => {
    const m = ref.current;
    if (!m) return;
    let n = 0;
    for (const r of sim.roads) {
      const foot = Math.min(1, r.walkWeight / 16);
      if (foot < 0.15) continue;
      const e = r.edge;
      D.position.set((e.ax + e.bx) / 2, 1.4, (e.az + e.bz) / 2);
      D.rotation.set(0, Math.atan2(-e.hz, e.hx), 0);
      D.scale.set(e.len, 0.05, 4);
      D.updateMatrix();
      m.setMatrixAt(n, D.matrix);
      m.setColorAt(n, foot < 0.5 ? C.lerpColors(new THREE.Color('#2b4a7a'), new THREE.Color('#d8a53a'), foot / 0.5)
        : C.lerpColors(new THREE.Color('#d8a53a'), new THREE.Color('#e0453a'), (foot - 0.5) / 0.5));
      n++;
      if (n >= 4000) break;
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [sim, ver]);
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, 4000]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial transparent opacity={0.45} toneMapped={false} depthWrite={false} />
    </instancedMesh>
  );
}
import { useLayoutEffect } from 'react';
function useLayoutEffectSafe(fn: () => void, deps: unknown[]) {
  useLayoutEffect(fn, deps);
}

export const CityScene = memo(function CityScene(p: CitySceneProps) {
  const { sim, city } = p;
  const field = useMemo(() => (city.terrain?.heights?.length ? new HeightField(city.terrain) : null), [city.terrain]);
  setHeightField(field);
  const extent = useMemo(() => areaExtent(city.area), [city.area]);
  const focus = useMemo<[number, number]>(() => [0, Math.min(200, extent.halfZ * 0.22)], [extent]);
  const hiddenKey = useMemo(() => sim.parks.map((x) => `${Math.round(x.x)}:${Math.round(x.z)}`).join('|'), [sim.parks, p.ver]);
  // Dane statyczne (OSM/GTFS) mają własny znacznik czasu. Bez niego każde
  // odświeżenie danych live tworzyłoby nowe referencje tablic i przebudowywało
  // tysiące brył budynków oraz wielokątów terenu.
  const staticKey = city.generatedAt;

  return (
    <Canvas shadows dpr={[1, 1.25]} camera={{ fov: 45, near: 1, far: 6000, position: [focus[0] + 900, 620, focus[1] + 1100] }}>
      <color attach="background" args={['#cfe0ec']} />
      <fog attach="fog" args={['#cfe0ec', 1400, 5200]} />
      <hemisphereLight args={['#ffffff', '#7d7a68', 0.95]} />
      <directionalLight position={[280, 700, 240]} intensity={1.5} castShadow
        shadow-mapSize={[1024, 1024]} shadow-camera-left={-700} shadow-camera-right={700}
        shadow-camera-top={700} shadow-camera-bottom={-700} shadow-camera-near={1} shadow-camera-far={2600} />
      <Driver sim={sim} speed={p.speed} paused={p.paused} />
      <Rig focus={focus} flyTo={p.flyTo} />
      {p.layers.has('base') && (
        <Terrain key={`terrain-${staticKey}`} polygons={city.polygons} area={city.area} terrain={city.terrain}
          onGround={p.onGround} onClear={() => p.onSelect(null)} />
      )}
      {p.layers.has('greens') && <Trees key={`trees-${staticKey}`} polygons={city.polygons} ver={p.ver} />}
      {p.layers.has('buildings') && (
        <Buildings key={`bld-${staticKey}-${hiddenKey}`} buildings={city.buildings} hiddenKey={hiddenKey} ver={p.ver}
          onSelect={(i) => p.onSelect({ kind: 'building', id: i })} />
      )}
      <RoadNetwork key={`roads-${staticKey}`} sim={sim} ver={p.ver} sel={p.sel?.kind === 'road' ? p.sel.id : null}
        view={p.trafficView} layers={p.layers} onSelect={(id) => p.onSelect({ kind: 'road', id })} />
      {p.layers.has('transit') && <TransitStops key={`stops-${staticKey}`} stops={city.stops} ver={p.ver} />}
      <PlayerParks parks={sim.parks} ver={p.ver} />
      <PlayerStructures sim={sim} ver={p.ver} />
      {p.layers.has('disasters') && <DisasterLayer sim={sim} ver={p.ver} />}
      <Closures sim={sim} ver={p.ver} />
      <RealFleet sim={sim} onPick={p.onPickVehicle} selected={p.selectedVehicle} layers={p.layers} />
      <SimFleet sim={sim} layers={p.layers} />
      {p.layers.has('pedestrians') && <PedestrianFleet peds={sim.peds} active={Math.round(sim.activePeds)} />}
      {p.layers.has('pedflow') && <PedFlow sim={sim} ver={p.ver} />}
      {p.layers.has('labels') && <Labels key={`labels-${staticKey}`} city={city} ver={p.ver} />}
      <Ghost kind={p.placeKind} roadFrom={p.roadFrom} onCommit={p.onCommit} />
    </Canvas>
  );
});

/** Realne pojazdy MPK z GTFS-RT – pozycja prosto z feedu. */
function RealFleet({ sim, onPick, selected, layers }: {
  sim: Sim; onPick: CitySceneProps['onPickVehicle']; selected: string | null; layers: Set<string>;
}) {
  const trams = useMemo<FleetPose[]>(() => [], []);
  const buses = useMemo<FleetPose[]>(() => [], []);
  const get = useMemo(() => ({ trams: () => trams, buses: () => buses }), []);
  const prev = useRef(new Map<string, { x: number; z: number; yaw: number }>());
  const show = layers.has('live') || layers.has('transit');
  const key = useRef('');
  useFrame((_, dt) => {
    const src = show ? sim.realVehicles : [];
    const k = src.length + '|' + (src[0]?.id ?? '') + '|' + (src[0]?.timestamp ?? '');
    const fresh = k !== key.current;
    key.current = k;
    const f = fresh ? 0.55 : Math.min(1, dt * 1.6);
    trams.length = 0; buses.length = 0;
    for (const v of src) {
      const yaw = ((v.bearing ?? 0) * Math.PI) / 180;
      const p = prev.current.get(v.id);
      if (p) {
        let dy = yaw - p.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        p.x += (v.x - p.x) * f; p.z += (v.z - p.z) * f; p.yaw += dy * f;
      } else prev.current.set(v.id, { x: v.x, z: v.z, yaw });
      const s = prev.current.get(v.id)!;
      const pose = { id: v.id, x: s.x, z: s.z, yaw: s.yaw, ref: v.line, observed: true };
      if (v.type === 'tram') trams.push(pose); else buses.push(pose);
    }
  });
  return (
    <group>
      <TramFleet get={get.trams} onPick={(i) => onPick(trams[i]?.id ?? '', 'tram')} selected={selected} />
      <BusFleet get={get.buses} onPick={(i) => onPick(buses[i]?.id ?? '', 'bus')} />
      <ObservedMarkers get={get.trams} />
      <ObservedMarkers get={get.buses} />
    </group>
  );
}

/**
 * Pojazdy symulacji – MPK na realnych trasach GTFS + auta.
 * Pozycje czytamy co klatkę: agentów nie ma w reakcie, więc nie wystarczy
 * przeliczyć je raz przy montowaniu (pojazdy stałyby w miejscu).
 */
function SimFleet({ sim, layers }: { sim: Sim; layers: Set<string> }) {
  const trams = useMemo<FleetPose[]>(() => [], []);
  const buses = useMemo<FleetPose[]>(() => [], []);
  const cars = useMemo<FleetPose[]>(() => [], []);
  useFrame(() => {
    for (const v of sim.veh) {
      const p: FleetPose = {
        id: `${v.kind}-${v.edge}-${Math.round(v.x)}-${Math.round(v.z)}`,
        x: v.x, z: v.z, yaw: v.yaw, ref: v.ref,
      };
      if (v.kind === 2) trams.push(p);
      else if (v.kind === 1) buses.push(p);
      else cars.push(p);
    }
  });
  return (
    <group>
      {layers.has('transit') && (
        <>
          <TramFleet get={() => trams} />
          <BusFleet get={() => buses} />
        </>
      )}
      {layers.has('traffic') && <CarFleet get={() => cars} />}
    </group>
  );
}
