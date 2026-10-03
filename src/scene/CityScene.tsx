import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Edge, Sim } from '../simulation/sim';
import { MAX_PEDS } from '../simulation/sim';
import { genTrees, parkTrees, type B } from './buildings';

export type Tool = 'select' | 'park';
export type Sel = { kind: 'road'; id: number } | { kind: 'building'; id: number } | null;
interface Props { sim: Sim; ver: number; tool: Tool; speed: number; paused: boolean; sel: Sel; buildings: B[]; onSelect: (s: Sel) => void; onPark: (x: number, z: number) => void }

const CAR_COLORS = ['#d9d4c7', '#2f3640', '#b3262e', '#3b6ea5', '#e0b23a', '#6b7f6a', '#8a8f98'];
const roadWidth = (e: Edge) => (e.pedestrian ? 9 : e.name === 'Rynek Główny' ? 6 : e.speedLimit >= 14 ? 11 : 8);

function Driver({ sim, speed, paused }: { sim: Sim; speed: number; paused: boolean }) {
  useFrame((_, d) => { if (!paused) sim.advance(Math.min(d, 0.1) * speed); });
  return null;
}

function Rig() {
  const { camera } = useThree();
  const ctl = useRef<any>(null);
  const t = useRef(0), done = useRef(false);
  const a = useMemo(() => new THREE.Vector3(420, 330, 540), []), b = useMemo(() => new THREE.Vector3(150, 105, 215), []);
  useFrame((_, d) => {
    if (done.current) return;
    t.current = Math.min(1, t.current + d / 5);
    camera.position.lerpVectors(a, b, 1 - Math.pow(1 - t.current, 3));
    if (t.current >= 1) done.current = true;
    ctl.current?.update();
  });
  return <OrbitControls ref={ctl} makeDefault enableDamping dampingFactor={0.08} maxPolarAngle={Math.PI * 0.47} minDistance={25} maxDistance={900} target={[0, 0, 40]} onStart={() => { done.current = true; }} />;
}

function Ground({ tool, onSelect, onPark }: Pick<Props, 'tool' | 'onSelect' | 'onPark'>) {
  const band = (x: number, z: number, w: number, d: number, c: string, y = 0.08) => (
    <mesh position={[x, y, z]} receiveShadow><boxGeometry args={[w, 0.1, d]} /><meshStandardMaterial color={c} /></mesh>
  );
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} receiveShadow onClick={(e: ThreeEvent<MouseEvent>) => { if (e.delta > 4) return; if (tool === 'park') onPark(e.point.x, e.point.z); else onSelect(null); }}>
        <planeGeometry args={[3000, 3000]} /><meshStandardMaterial color="#c4bca7" />
      </mesh>
      {band(0, -263, 772, 46, '#7aa862')}{band(0, 263, 772, 46, '#7aa862')}{band(-363, 0, 46, 480, '#7aa862')}{band(363, 0, 46, 480, '#7aa862')}
      {band(0, 0, 184, 184, '#dcd3bc', 0.06)}
      {band(30, 548, 190, 80, '#8d8a72', 3)}
    </group>
  );
}

function Buildings({ sim, ver, buildings, tool, onSelect, onPark }: Pick<Props, 'sim' | 'ver' | 'buildings' | 'tool' | 'onSelect' | 'onPark'>) {
  const body = useRef<THREE.InstancedMesh>(null), roof = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const d = new THREE.Object3D(), c = new THREE.Color();
    buildings.forEach((b, i) => {
      const hide = !b.landmark && sim.parks.some((p) => Math.hypot(p.x - b.x, p.z - b.z) < p.r + b.w * 0.5), k = hide ? 0 : 1;
      d.position.set(b.x, b.h / 2, b.z); d.scale.set(b.w * k, b.h * k, b.d * k); d.updateMatrix(); body.current!.setMatrixAt(i, d.matrix); body.current!.setColorAt(i, c.set(b.color));
      d.position.set(b.x, b.h + 0.7, b.z); d.scale.set((b.w + 1.2) * k, 1.4 * k, (b.d + 1.2) * k); d.updateMatrix(); roof.current!.setMatrixAt(i, d.matrix); roof.current!.setColorAt(i, c.set(b.roof));
    });
    for (const m of [body.current!, roof.current!]) { m.instanceMatrix.needsUpdate = true; m.instanceColor!.needsUpdate = true; m.computeBoundingSphere(); }
  }, [buildings, ver, sim]);
  const click = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 4) return;
    if (tool === 'park') onPark(e.point.x, e.point.z);
    else if (e.instanceId != null) onSelect({ kind: 'building', id: e.instanceId });
  };
  return (
    <>
      <instancedMesh ref={body} args={[undefined, undefined, buildings.length]} castShadow receiveShadow onClick={click}><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial /></instancedMesh>
      <instancedMesh ref={roof} args={[undefined, undefined, buildings.length]} castShadow><boxGeometry args={[1, 1, 1]} /><meshStandardMaterial /></instancedMesh>
    </>
  );
}

function Roads({ sim, ver, sel, tool, onSelect, onPark }: Pick<Props, 'sim' | 'ver' | 'sel' | 'tool' | 'onSelect' | 'onPark'>) {
  const ref = useRef<THREE.InstancedMesh>(null), acc = useRef(0);
  const col = useMemo(() => ({ a: new THREE.Color('#4b5261'), b: new THREE.Color('#e0a93a'), r: new THREE.Color('#dc4437'), t: new THREE.Color(), x: new THREE.Color('#6b2b2b'), p: new THREE.Color('#d9c9a3'), s: new THREE.Color('#5cc8ff') }), []);
  const paint = () => {
    const m = ref.current; if (!m) return;
    sim.edges.forEach((e, i) => {
      const k = Math.min(1, e.trafficLevel), t = col.t;
      if (e.closed) t.copy(col.x); else if (e.pedestrian) t.copy(col.p);
      else if (k < 0.5) t.lerpColors(col.a, col.b, k * 2); else t.lerpColors(col.b, col.r, (k - 0.5) * 2);
      if (sel?.kind === 'road' && sel.id === i) t.lerp(col.s, 0.65);
      m.setColorAt(i, t);
    });
    m.instanceColor!.needsUpdate = true;
  };
  useLayoutEffect(() => {
    const d = new THREE.Object3D();
    sim.edges.forEach((e, i) => {
      d.position.set((e.ax + e.bx) / 2, 0.2, (e.az + e.bz) / 2); d.rotation.set(0, Math.atan2(-e.hz, e.hx), 0); d.scale.set(e.len + 4, 0.4, roadWidth(e)); d.updateMatrix(); ref.current!.setMatrixAt(i, d.matrix);
    });
    ref.current!.instanceMatrix.needsUpdate = true; paint(); ref.current!.computeBoundingSphere();
  }, [sim, ver]);
  useLayoutEffect(paint, [sel, ver]);
  useFrame((_, dt) => { acc.current += dt; if (acc.current > 0.25) { acc.current = 0; paint(); } });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, sim.edges.length]} receiveShadow
      onClick={(e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if (e.delta > 4) return; if (tool === 'park') onPark(e.point.x, e.point.z); else if (e.instanceId != null) onSelect({ kind: 'road', id: e.instanceId }); }}>
      <boxGeometry args={[1, 1, 1]} /><meshStandardMaterial />
    </instancedMesh>
  );
}

const D = new THREE.Object3D();
function sync(mesh: THREE.InstancedMesh | null, list: { x: number; z: number; yaw?: number }[], n: number, y: number, along = 0) {
  if (!mesh) return;
  for (let i = 0; i < n; i++) {
    const v = list[i], yaw = v.yaw ?? 0;
    D.position.set(v.x + Math.cos(yaw) * along, y, v.z - Math.sin(yaw) * along); D.rotation.set(0, yaw, 0); D.updateMatrix(); mesh.setMatrixAt(i, D.matrix);
  }
  mesh.count = n; mesh.instanceMatrix.needsUpdate = true;
}
function paintOnce(mesh: THREE.InstancedMesh | null, colors: string[]) {
  if (!mesh) return; const c = new THREE.Color();
  colors.forEach((s, i) => mesh.setColorAt(i, c.set(s))); mesh.instanceColor!.needsUpdate = true;
}

function Traffic({ sim }: { sim: Sim }) {
  const cars = sim.veh.filter((v) => v.kind === 0), buses = sim.veh.filter((v) => v.kind === 1), trams = sim.veh.filter((v) => v.kind === 2);
  const car = useRef<THREE.InstancedMesh>(null), cab = useRef<THREE.InstancedMesh>(null), bus = useRef<THREE.InstancedMesh>(null), tram = useRef<THREE.InstancedMesh>(null), ped = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    paintOnce(car.current, cars.map((_, i) => CAR_COLORS[i % CAR_COLORS.length]));
    paintOnce(cab.current, cars.map(() => '#2b3440'));
    paintOnce(bus.current, buses.map(() => '#f1eee4'));
    paintOnce(tram.current, trams.map((_, i) => (i % 2 ? '#2f6fb3' : '#3b82c4')));
    paintOnce(ped.current, sim.peds.map((_, i) => ['#b3262e', '#2f6fb3', '#e0b23a', '#4f8a45', '#3b3f4a', '#d9d4c7'][i % 6]));
  }, [sim]);
  useFrame(() => {
    sync(car.current, cars, cars.length, 0.95); sync(cab.current, cars, cars.length, 1.75, -0.3);
    sync(bus.current, buses, buses.length, 1.9); sync(tram.current, trams, trams.length, 2.1);
    sync(ped.current, sim.peds, Math.min(MAX_PEDS, Math.round(sim.activePeds)), 0.9);
  });
  const mats = <meshStandardMaterial />;
  return (
    <>
      <instancedMesh ref={car} args={[undefined, undefined, cars.length]} frustumCulled={false}><boxGeometry args={[4.2, 1.5, 2]} />{mats}</instancedMesh>
      <instancedMesh ref={cab} args={[undefined, undefined, cars.length]} frustumCulled={false}><boxGeometry args={[2.2, 0.9, 1.7]} />{mats}</instancedMesh>
      <instancedMesh ref={bus} args={[undefined, undefined, buses.length]} frustumCulled={false}><boxGeometry args={[10, 3, 2.6]} />{mats}</instancedMesh>
      <instancedMesh ref={tram} args={[undefined, undefined, trams.length]} frustumCulled={false}><boxGeometry args={[22, 3.2, 2.6]} />{mats}</instancedMesh>
      <instancedMesh ref={ped} args={[undefined, undefined, MAX_PEDS]} frustumCulled={false}><cylinderGeometry args={[0.35, 0.35, 1.8, 6]} />{mats}</instancedMesh>
    </>
  );
}

function Trees({ sim, ver }: { sim: Sim; ver: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const base = useMemo(() => genTrees(sim.edges), [sim]);
  useLayoutEffect(() => {
    const all = [...base, ...sim.parks.flatMap((p, i) => parkTrees(i, p.x, p.z, p.r))], d = new THREE.Object3D(), c = new THREE.Color(), m = ref.current!;
    all.forEach((t, i) => { d.position.set(t.x, 4.2 * t.s, t.z); d.scale.set(t.s, t.s, t.s); d.updateMatrix(); m.setMatrixAt(i, d.matrix); m.setColorAt(i, c.set(t.c)); });
    m.count = all.length; m.instanceMatrix.needsUpdate = true; m.instanceColor!.needsUpdate = true;
  }, [base, ver, sim]);
  return <instancedMesh ref={ref} args={[undefined, undefined, 900]} frustumCulled={false} castShadow><coneGeometry args={[3.2, 8.4, 6]} /><meshStandardMaterial /></instancedMesh>;
}

function Markers({ sim, ver }: { sim: Sim; ver: number }) {
  void ver;
  return (
    <group>
      {sim.parks.map((p, i) => <mesh key={'p' + i} position={[p.x, 0.25, p.z]} rotation-x={-Math.PI / 2}><circleGeometry args={[p.r, 28]} /><meshStandardMaterial color="#6aa84f" /></mesh>)}
      {sim.edges.filter((e) => e.closed).flatMap((e) => [10, e.len - 10].map((t, k) => (
        <mesh key={`c${e.id}-${k}`} position={[e.ax + e.hx * t, 1, e.az + e.hz * t]} rotation-y={Math.atan2(-e.hz, e.hx) + Math.PI / 2}><boxGeometry args={[10, 1.6, 0.7]} /><meshStandardMaterial color="#c8312b" /></mesh>
      )))}
      {sim.edges.filter((e) => e.hasStop).map((e) => (
        <mesh key={'s' + e.id} position={[e.ax + e.hx * e.len / 2 - e.hz * 7.5, 2.6, e.az + e.hz * e.len / 2 + e.hx * 7.5]}><boxGeometry args={[1.2, 5.2, 1.2]} /><meshStandardMaterial color="#f2c230" /></mesh>
      ))}
    </group>
  );
}

export const CityScene = memo(function CityScene(p: Props) {
  return (
    <Canvas shadows dpr={[1, 1.75]} camera={{ fov: 45, near: 1, far: 4000, position: [420, 330, 540] }}>
      <color attach="background" args={['#cfe0ec']} />
      <fog attach="fog" args={['#cfe0ec', 700, 2200]} />
      <hemisphereLight args={['#ffffff', '#8a8570', 1.0]} />
      <directionalLight position={[300, 500, 200]} intensity={1.7} castShadow shadow-mapSize={[2048, 2048]} shadow-camera-left={-640} shadow-camera-right={640} shadow-camera-top={640} shadow-camera-bottom={-640} shadow-camera-near={1} shadow-camera-far={1600} />
      <Driver sim={p.sim} speed={p.speed} paused={p.paused} />
      <Rig />
      <Ground tool={p.tool} onSelect={p.onSelect} onPark={p.onPark} />
      <Buildings sim={p.sim} ver={p.ver} buildings={p.buildings} tool={p.tool} onSelect={p.onSelect} onPark={p.onPark} />
      <Roads sim={p.sim} ver={p.ver} sel={p.sel} tool={p.tool} onSelect={p.onSelect} onPark={p.onPark} />
      <Trees sim={p.sim} ver={p.ver} />
      <Markers sim={p.sim} ver={p.ver} />
      <Traffic sim={p.sim} />
    </Canvas>
  );
});
