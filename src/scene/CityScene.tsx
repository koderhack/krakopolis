/**
 * Scena 3D (react-three-fiber).
 *
 * Warstwy: podłoże z wysokościami DEM, zieleń i woda z OSM, sieć drogowa
 * z torowiskami, budynki z prawdziwych obrysów, przystanki GTFS, pojazdy
 * (realne z GTFS-RT + symulowane), piesi, obiekty gracza i katastrofy.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { MapControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Sim } from '../simulation/sim';
import type { CityData } from '../data/model';
import { toLocal } from '../data/geo';
import { HeightField, setHeightField } from './terrain';
import { Html } from '@react-three/drei';
import {
  areaExtent, Buildings, Closures, DisasterLayer, MapBorder, PlayerParks, PlayerStructures,
  RoadNetwork, Terrain, TrafficView, TransitStops, Trees,
} from './models/City';
import { BusFleet, CarFleet, ObservedMarkers, PedestrianFleet, TramFleet } from './models/Fleets';
import { PlacementGhost, type PlaceKind } from './models/Placement';
import type { FleetPose, FlyTarget, Sel } from './types';
import { LandmarkExtras } from './models/Landmarks';

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
  buildId?: import('../simulation/city/catalog').BuildId | null;
  buildRot?: number;
  pendingPose?: { x: number; z: number; rot: number } | null;
  roadFrom: { x: number; z: number } | null;
  selectedVehicle: string | null;
  flyTo: FlyTarget | null;
  disasterPreview?: { x: number; z: number; radius: number } | null;
  onSelect: (s: Sel) => void;
  onGround: (x: number, z: number) => void;
  onCommit: (x: number, z: number, x2: number, z2: number) => void;
  onPickVehicle: (id: string, kind: 'tram' | 'bus') => void;
  onFocusObject?: (x: number, z: number) => void;
  /** Podgląd z góry zamiast perspektywy „z miasta”. */
  topDown: boolean;
  onBounds: (b: { minX: number; maxX: number; minZ: number; maxZ: number }) => void;
  onCameraSample?: (s: { tx: number; tz: number; dist: number; yaw: number }) => void;
}

function Driver({ sim, speed, paused }: { sim: Sim; speed: number; paused: boolean }) {
  useFrame((_, d) => {
    if (paused) return;
    const dt = Math.min(d, 0.12);
    if (speed <= 1) {
      // 1× = rzeczywisty czas Europe/Warsaw
      sim.syncClockToWall();
      sim.advance(dt);
    } else {
      sim.advanceClock(dt * speed);
      sim.advance(dt * speed);
    }
  });
  return null;
}

/** Oświetlenie i mgła zależne od godziny – łagodne przejścia, bez ostrych skoków. */
function DayNight({ sim }: { sim: Sim }) {
  const hemi = useRef<THREE.HemisphereLight>(null);
  const sun = useRef<THREE.DirectionalLight>(null);
  const amb = useRef<THREE.AmbientLight>(null);
  const sky = useRef(new THREE.Color('#c5d6e6'));
  const dawn = useRef(new THREE.Color('#f0c090'));
  const dusk = useRef(new THREE.Color('#e8a070'));
  const nightSky = useRef(new THREE.Color('#0c1424'));
  const target = useRef(new THREE.Color('#c5d6e6'));
  const acc = useRef(0);
  const { scene } = useThree();

  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.12) return; // throttling – mniej pracy na klatkę
    acc.current = 0;

    const day = sim.dayFactor();
    const { hour, minute } = sim.clockParts();
    const t = hour + minute / 60;
    const elev = Math.max(0.04, Math.sin(((t - 5.5) / 14) * Math.PI));
    const az = ((t - 12) / 12) * Math.PI * 0.75;

    target.current.setRGB(
      0.10 + day * 0.62,
      0.13 + day * 0.68,
      0.20 + day * 0.66,
    );
    if (t > 5.5 && t < 7.8) target.current.lerp(dawn.current, Math.max(0, 1 - Math.abs(t - 6.6) / 1.2) * 0.28);
    if (t > 17.8 && t < 20.8) target.current.lerp(dusk.current, Math.max(0, 1 - Math.abs(t - 19.2) / 1.4) * 0.32);
    if (t >= 21.2 || t < 5.2) target.current.copy(nightSky.current);

    sky.current.lerp(target.current, 0.18);
    scene.background = sky.current;
    if (scene.fog instanceof THREE.FogExp2) {
      scene.fog.color.copy(sky.current);
      scene.fog.density = 0.00038 + (1 - day) * 0.00022;
    }

    if (hemi.current) {
      hemi.current.color.set(day > 0.35 ? '#f4f7fb' : '#7a88a8');
      hemi.current.groundColor.set(day > 0.3 ? '#8a8578' : '#1c1a22');
      hemi.current.intensity = 0.35 + day * 0.45;
    }
    if (amb.current) amb.current.intensity = 0.18 + day * 0.22;
    if (sun.current) {
      sun.current.position.set(Math.sin(az) * 480, 90 + elev * 620, Math.cos(az) * 400);
      sun.current.intensity = 0.2 + day * 0.85;
      sun.current.color.set(day > 0.55 ? '#fff6ea' : day > 0.28 ? '#ffc090' : '#9aa8cc');
    }
  });

  return (
    <>
      <ambientLight ref={amb} intensity={0.32} />
      <hemisphereLight ref={hemi} args={['#f4f7fb', '#8a8578', 0.7]} />
      <directionalLight
        ref={sun}
        position={[260, 620, 220]}
        intensity={0.9}
        castShadow
        shadow-mapSize={[512, 512]}
        shadow-bias={-0.00015}
        shadow-camera-left={-480}
        shadow-camera-right={480}
        shadow-camera-top={480}
        shadow-camera-bottom={-480}
        shadow-camera-near={20}
        shadow-camera-far={1800}
      />
    </>
  );
}

/**
 * Obsługa kamery w stylu city-buildera:
 * LPM = przesuwanie, PPM = obrót, Shift+PPM = pochylenie, scroll = zoom.
 * Jednym źródłem prawdy jest `MapControls.target`.
 */
function Rig({
  focus, flyTo, topDown, onBounds, mapBounds, onCameraSample,
}: {
  focus: [number, number];
  flyTo: CitySceneProps['flyTo'];
  topDown: boolean;
  onBounds: (b: { minX: number; maxX: number; minZ: number; maxZ: number }) => void;
  mapBounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  onCameraSample?: CitySceneProps['onCameraSample'];
}) {
  const { camera, gl } = useThree();
  const ctl = useRef<any>(null);
  const intro = useRef(0);
  const tween = useRef<{
    from: THREE.Vector3; to: THREE.Vector3;
    fromT: THREE.Vector3; toT: THREE.Vector3; t: number; dur: number;
  } | null>(null);
  const keys = useRef<Record<string, boolean>>({});
  const dist = useRef(1500);
  const shift = useRef(false);
  const lockAz = useRef<number | null>(null);
  const sampleAcc = useRef(0);

  const HOME = useMemo(() => new THREE.Vector3(focus[0] + 470, 260, focus[1] + 620), [focus]);
  const FAR = useMemo(() => new THREE.Vector3(focus[0] + 1500, 1250, focus[1] + 2050), [focus]);
  const center = useMemo(() => new THREE.Vector3(focus[0], 0, focus[1]), [focus]);

  const clampPoint = (v: THREE.Vector3, margin = 35) => {
    v.x = Math.max(mapBounds.minX + margin, Math.min(mapBounds.maxX - margin, v.x));
    v.z = Math.max(mapBounds.minZ + margin, Math.min(mapBounds.maxZ - margin, v.z));
  };

  useEffect(() => {
    camera.position.copy(FAR);
    camera.lookAt(center);
    if (ctl.current) { ctl.current.target.copy(center); ctl.current.update(); }
    onBounds({ minX: mapBounds.minX, maxX: mapBounds.maxX, minZ: mapBounds.minZ, maxZ: mapBounds.maxZ });
  }, []);

  useEffect(() => {
    tween.current = {
      from: FAR.clone(), to: HOME.clone(),
      fromT: center.clone(), toT: center.clone(),
      t: 0, dur: 4.2,
    };
    const t = setTimeout(() => { intro.current = 1; }, 4400);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!flyTo) return;
    const toT = new THREE.Vector3(flyTo.x, 0, flyTo.z);
    clampPoint(toT, 40);
    if (flyTo.mode === 'fit') {
      const to = FAR.clone();
      clampPoint(to, 20);
      tween.current = {
        from: camera.position.clone(), to,
        fromT: ctl.current ? ctl.current.target.clone() : center.clone(),
        toT: center.clone(), t: 0, dur: 1.35,
      };
      return;
    }
    const dir = new THREE.Vector3().subVectors(camera.position, toT);
    dir.y = 0;
    if (dir.lengthSq() < 1) dir.set(0.6, 0, 0.8);
    const wantDist = flyTo.distance ?? (topDown ? 40 : 135);
    dir.normalize().multiplyScalar(wantDist);
    const to = toT.clone().add(new THREE.Vector3(dir.x, topDown ? 520 : Math.min(220, Math.max(90, wantDist * 0.9)), dir.z));
    clampPoint(to, 20);
    tween.current = {
      from: camera.position.clone(), to,
      fromT: ctl.current ? ctl.current.target.clone() : center.clone(),
      toT, t: 0, dur: 1.05,
    };
  }, [flyTo?.token]);

  useEffect(() => {
    if (!intro.current) return;
    const toT = ctl.current ? ctl.current.target.clone() : center.clone();
    clampPoint(toT, 40);
    tween.current = {
      from: camera.position.clone(),
      to: toT.clone().add(new THREE.Vector3(0.01, topDown ? 900 : 260, topDown ? 320 : 640)),
      fromT: toT, toT, t: 0, dur: 0.9,
    };
  }, [topDown]);

  useEffect(() => {
    const typing = (el: EventTarget | null) => {
      const t = el as HTMLElement | null;
      if (!t) return false;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
    };
    const down = (e: KeyboardEvent) => {
      if (typing(e.target)) return;
      keys.current[e.code] = true;
      if (e.key === 'Shift') shift.current = true;
    };
    const up = (e: KeyboardEvent) => {
      keys.current[e.code] = false;
      if (e.key === 'Shift') { shift.current = false; lockAz.current = null; }
    };
    const blur = () => { keys.current = {}; shift.current = false; lockAz.current = null; };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // Shift + PPM: blokuj azimuth → tylko pochylenie (polar).
  useEffect(() => {
    const el = gl.domElement;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 2 || !shift.current || !ctl.current) return;
      lockAz.current = ctl.current.getAzimuthalAngle();
    };
    const onUp = () => { lockAz.current = null; };
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointerup', onUp);
    };
  }, [gl]);

  useFrame((_, dt) => {
    const c = ctl.current;
    if (!c) return;

    if (lockAz.current !== null && shift.current) {
      c.minAzimuthAngle = lockAz.current;
      c.maxAzimuthAngle = lockAz.current;
    } else {
      c.minAzimuthAngle = -Infinity;
      c.maxAzimuthAngle = Infinity;
    }

    const tw = tween.current;
    if (tw) {
      tw.t = Math.min(1, tw.t + dt / tw.dur);
      const e = 1 - Math.pow(1 - tw.t, 4);
      camera.position.lerpVectors(tw.from, tw.to, e);
      c.target.lerpVectors(tw.fromT, tw.toT, e);
      clampPoint(c.target, 40);
      c.update();
      if (tw.t >= 1) { tween.current = null; c.enabled = true; }
      dist.current = camera.position.distanceTo(c.target);
      return;
    }

    const k = keys.current;
    const fwd = (k.KeyW ? 1 : 0) - (k.KeyS ? 1 : 0) + (k.ArrowUp ? 1 : 0) - (k.ArrowDown ? 1 : 0);
    const strafe = (k.KeyD ? 1 : 0) - (k.KeyA ? 1 : 0) + (k.ArrowRight ? 1 : 0) - (k.ArrowLeft ? 1 : 0);
    const yawL = (k.KeyQ ? 1 : 0);
    const yawR = (k.KeyE ? 1 : 0);
    if (fwd || strafe || yawL || yawR) {
      c.enabled = false;
      const speed = (k.ShiftLeft || k.ShiftRight ? 2.2 : 1) * Math.max(60, dist.current) * dt * 1.6;
      const f = new THREE.Vector3();
      camera.getWorldDirection(f);
      f.y = 0;
      if (f.lengthSq() < 1e-6) f.set(0, 0, -1);
      f.normalize();
      const rgt = new THREE.Vector3(f.z, 0, -f.x);
      const move = new THREE.Vector3()
        .addScaledVector(f, fwd * speed)
        .addScaledVector(rgt, strafe * speed);
      if (move.lengthSq() > 0) {
        camera.position.add(move);
        c.target.add(move);
      }
      if (yawL || yawR) {
        const ang = (yawR - yawL) * dt * 1.15;
        const offset = new THREE.Vector3().subVectors(camera.position, c.target);
        offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), ang);
        camera.position.copy(c.target).add(offset);
      }
      clampPoint(c.target, 40);
      c.update();
      c.enabled = true;
    } else {
      clampPoint(c.target, 40);
    }
    dist.current = camera.position.distanceTo(c.target);

    sampleAcc.current += dt;
    if (onCameraSample && sampleAcc.current > 0.2) {
      sampleAcc.current = 0;
      const offset = new THREE.Vector3().subVectors(camera.position, c.target);
      onCameraSample({
        tx: c.target.x, tz: c.target.z,
        dist: dist.current,
        yaw: Math.atan2(offset.x, offset.z),
      });
    }
  });

  return (
    <MapControls
      ref={ctl} makeDefault enableDamping dampingFactor={0.085}
      minPolarAngle={0.18} maxPolarAngle={Math.PI * 0.48}
      minDistance={35} maxDistance={2400}
      zoomSpeed={0.85} rotateSpeed={0.55} panSpeed={1.05}
      screenSpacePanning={false}
      mouseButtons={{
        LEFT: THREE.MOUSE.PAN,
        MIDDLE: THREE.MOUSE.DOLLY,
        RIGHT: THREE.MOUSE.ROTATE,
      }}
      touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_ROTATE }}
      target={[focus[0], 0, focus[1]]}
      onStart={() => { tween.current = null; ctl.current && (ctl.current.enabled = true); }}
    />
  );
}

/** Niebieski podgląd miejsca ustawienia obiektu. */
function Ghost({ kind, buildId, roadFrom, onCommit, rot, pendingPose }: {
  kind: PlaceKind | null;
  buildId?: import('../simulation/city/catalog').BuildId | null;
  roadFrom: { x: number; z: number } | null;
  onCommit: CitySceneProps['onCommit'];
  rot?: number;
  pendingPose?: { x: number; z: number; rot: number } | null;
}) {
  const pt = useRef({ x: 0, z: 0 });
  return kind ? (
    <PlacementGhost
      kind={kind}
      buildId={buildId}
      roadFrom={roadFrom}
      point={pt}
      onCommit={onCommit}
      rot={rot}
      pending={pendingPose}
    />
  ) : null;
}

function DisasterGhost({ preview }: { preview: { x: number; z: number; radius: number } | null }) {
  if (!preview) return null;
  const y = 0.2;
  return (
    <mesh position={[preview.x, y, preview.z]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[preview.radius * 0.92, preview.radius, 64]} />
      <meshBasicMaterial color="#e07060" transparent opacity={0.45} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
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
  const mapBounds = useMemo(() => {
    const sw = toLocal(city.area.minLat, city.area.minLon);
    const ne = toLocal(city.area.maxLat, city.area.maxLon);
    return {
      minX: Math.min(sw.x, ne.x),
      maxX: Math.max(sw.x, ne.x),
      minZ: Math.min(sw.z, ne.z),
      maxZ: Math.max(sw.z, ne.z),
    };
  }, [city.area]);
  const hiddenKey = useMemo(() => sim.parks.map((x) => `${Math.round(x.x)}:${Math.round(x.z)}`).join('|'), [sim.parks, p.ver]);
  // Dane statyczne (OSM/GTFS) mają własny znacznik czasu. Bez niego każde
  // odświeżenie danych live tworzyłoby nowe referencje tablic i przebudowywało
  // tysiące brył budynków oraz wielokątów terenu.
  const staticKey = city.generatedAt;

  return (
    <Canvas
      shadows
      dpr={[1, 1]}
      gl={{ antialias: true, powerPreference: 'high-performance', stencil: false }}
      camera={{ fov: 45, near: 1, far: 4500, position: [focus[0] + 900, 620, focus[1] + 1100] }}
    >
      <color attach="background" args={['#c5d6e6']} />
      <fogExp2 attach="fog" args={['#c5d6e6', 0.00045]} />
      <DayNight sim={sim} />
      <Driver sim={sim} speed={p.speed} paused={p.paused} />
      <Rig focus={focus} flyTo={p.flyTo} topDown={p.topDown} onBounds={p.onBounds} mapBounds={mapBounds} onCameraSample={p.onCameraSample} />
      {p.layers.has('base') && (
        <Terrain key={`terrain-${staticKey}`} polygons={city.polygons} area={city.area} terrain={city.terrain}
          showBasemap={p.layers.has('basemap')}
          onGround={p.onGround} onClear={() => p.onSelect(null)} />
      )}
      <MapBorder area={city.area} />
      {p.layers.has('trees') && <Trees key={`trees-${staticKey}`} polygons={city.polygons} ver={p.ver} />}
      {p.layers.has('buildings') && (
        <Buildings key={`bld-${staticKey}-${hiddenKey}`} buildings={city.buildings} hiddenKey={hiddenKey} ver={p.ver}
          onSelect={(i) => p.onSelect({ kind: 'building', id: i })}
          onFocus={(i) => {
            const b = city.buildings[i];
            if (b) p.onFocusObject?.(b.x, b.z);
          }}
        />
      )}
      <RoadNetwork key={`roads-${staticKey}`} sim={sim} ver={p.ver} sel={p.sel?.kind === 'road' ? p.sel.id : null}
        view={p.trafficView} layers={p.layers} onSelect={(id) => p.onSelect({ kind: 'road', id })} />
      {p.layers.has('transit') && <TransitStops key={`stops-${staticKey}`} stops={city.stops} ver={p.ver} />}
      <PlayerParks parks={sim.parks} ver={p.ver} />
      <PlayerStructures
        sim={sim}
        ver={p.ver}
        sel={p.sel?.kind === 'player' ? p.sel.id : null}
        onSelect={(id) => p.onSelect({ kind: 'player', id })}
        onFocus={(id) => {
          const b = sim.playerBuildings.find((x) => x.id === id);
          if (b) p.onFocusObject?.(b.x, b.z);
        }}
      />
      {p.layers.has('disasters') && <DisasterLayer sim={sim} ver={p.ver} />}
      <Closures sim={sim} ver={p.ver} />
      <RealFleet sim={sim} onPick={p.onPickVehicle} selected={p.selectedVehicle} layers={p.layers} />
      <SimFleet sim={sim} layers={p.layers} />
      {p.layers.has('pedestrians') && <PedestrianFleet peds={sim.peds} active={Math.round(sim.activePeds)} />}
      {p.layers.has('pedflow') && <PedFlow sim={sim} ver={p.ver} />}
      {p.layers.has('labels') && <Labels key={`labels-${staticKey}`} city={city} ver={p.ver} />}
      <Ghost kind={p.placeKind} buildId={p.buildId} roadFrom={p.roadFrom} onCommit={p.onCommit} rot={p.buildRot} pendingPose={p.pendingPose} />
      <DisasterGhost preview={p.disasterPreview ?? null} />
      {p.layers.has('buildings') && <LandmarkExtras buildings={city.buildings} />}
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
  const key = useRef('');
  const wantLive = layers.has('live') || layers.has('transit');
  useFrame((_, dt) => {
    // Live GTFS-RT to zawsze „teraz” – przy scrubbingu zegara chowamy OBSERVED.
    const liveOk = Math.abs(sim.clockOffsetMs) < 5 * 60_000;
    const src = wantLive && liveOk ? sim.realVehicles : [];
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
 * Tablice reuse'ujemy i zerujemy co klatkę (wcześniej rosły w nieskończoność).
 */
function SimFleet({ sim, layers }: { sim: Sim; layers: Set<string> }) {
  const trams = useMemo<FleetPose[]>(() => [], []);
  const buses = useMemo<FleetPose[]>(() => [], []);
  const cars = useMemo<FleetPose[]>(() => [], []);
  const get = useMemo(() => ({
    trams: () => trams,
    buses: () => buses,
    cars: () => cars,
  }), [trams, buses, cars]);
  useFrame(() => {
    trams.length = 0;
    buses.length = 0;
    cars.length = 0;
    for (const v of sim.veh) {
      const p: FleetPose = {
        id: `${v.kind}-${v.edge}`,
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
          <TramFleet get={get.trams} />
          <BusFleet get={get.buses} />
        </>
      )}
      {layers.has('traffic') && <CarFleet get={get.cars} />}
    </group>
  );
}
