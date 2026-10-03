/**
 * Modele pojazdów i pieszych.
 * Tramwaj i autobus to bryły z zaokrąglonymi krawędziami, pasem okien, kołami,
 * pantografem i tablicą z numerem linii (tekstura Canvas). Piesi mają sylwetkę
 * z głową, tułowiem, dwiema nogami i dwiema ramionami oraz animowanym krokiem.
 */
import { useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { Sim } from '../../simulation/sim';
import type { Ped } from '../../simulation/pedestrians/agents';
import { groundY } from '../terrain';
import type { FleetPose } from '../types';

const D = new THREE.Object3D();
const COL = new THREE.Color();

export function mk(geo: THREE.BufferGeometry, mat: THREE.Material, n: number, cast = true) {
  const m = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
  m.castShadow = cast;
  m.receiveShadow = false;
  m.frustumCulled = false;
  m.count = 0;
  m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  return m;
}
function put(m: THREE.InstancedMesh, i: number, x: number, y: number, z: number, yaw: number, sx = 1, sy = 1, sz = 1) {
  D.position.set(x, groundY(x, z) + y, z);
  D.rotation.set(0, yaw, 0);
  D.scale.set(sx, sy, sz);
  D.updateMatrix();
  m.setMatrixAt(i, D.matrix);
}
const flush = (...m: THREE.InstancedMesh[]) => m.forEach((x) => { x.instanceMatrix.needsUpdate = true; });

function lineTexture(ref: string) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0f1317';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#f5d03c';
  g.font = 'bold 92px Helvetica, Arial, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(String(ref).slice(0, 4), 128, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Tablica z numerem linii – osobna instancja dla każdego numeru. */
class BoardPool {
  private byRef = new Map<string, { mesh: THREE.InstancedMesh; tex: THREE.CanvasTexture; n: number }>();
  scene: THREE.Object3D | null = null;
  attach(parent: THREE.Object3D) { this.scene = parent; for (const e of this.byRef.values()) parent.add(e.mesh); }
  render(poses: FleetPose[], place: (i: number, p: FleetPose, mesh: THREE.InstancedMesh) => void) {
    if (!this.scene) return;
    const used = new Set(poses.map((p) => p.ref));
    for (const [ref, e] of this.byRef) {
      if (used.has(ref)) continue;
      this.scene.remove(e.mesh);
      e.mesh.geometry.dispose();
      (e.mesh.material as THREE.Material).dispose();
      e.tex.dispose();
      this.byRef.delete(ref);
    }
    const counts = new Map<string, number>();
    for (const p of poses) {
      let e = this.byRef.get(p.ref);
      if (!e) {
        const tex = lineTexture(p.ref);
        const mesh = new THREE.InstancedMesh(
          new THREE.PlaneGeometry(1, 1),
          new THREE.MeshBasicMaterial({ map: tex, toneMapped: false, side: THREE.DoubleSide }),
          128,
        );
        mesh.frustumCulled = false;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        e = { mesh, tex, n: 0 };
        this.byRef.set(p.ref, e);
        this.scene.add(mesh);
      }
      const i = counts.get(p.ref) ?? 0;
      counts.set(p.ref, i + 1);
      place(i, p, e.mesh);
      e.mesh.count = i + 1;
      e.mesh.instanceMatrix.needsUpdate = true;
    }
  }
}

const TRAM = { len: 21.4, wid: 2.44, lowH: 1.35, upH: 1.25, roofH: 0.26, floor: 0.5 };
const BUS = { len: 12.0, wid: 2.55, lowH: 1.5, upH: 1.05, floor: 0.45 };

export function TramFleet({ get, capacity = 200, onPick, selected }: {
  get: () => FleetPose[]; capacity?: number; onPick?: (i: number) => void; selected?: string | null;
}) {
  const group = useRef<THREE.Group>(null);
  const poses = useRef<FleetPose[]>([]);
  const pool = useMemo(() => new BoardPool(), []);
  const parts = useMemo(() => {
    const body = new THREE.MeshStandardMaterial({ color: '#f2f0e6', roughness: 0.5, metalness: 0.08 });
    const glass = new THREE.MeshStandardMaterial({ color: '#16222b', roughness: 0.15, metalness: 0.6 });
    const skirt = new THREE.MeshStandardMaterial({ color: '#39434b', roughness: 0.65 });
    const tyre = new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.95 });
    const steel = new THREE.MeshStandardMaterial({ color: '#98a0a8', roughness: 0.3, metalness: 0.75 });
    const L = TRAM.len, W = TRAM.wid;
    return {
      low: mk(new RoundedBoxGeometry(L, TRAM.lowH, W, 3, 0.3), body, capacity),
      up: mk(new RoundedBoxGeometry(L * 0.97, TRAM.upH, W * 0.93, 3, 0.28), body, capacity),
      glass: mk(new THREE.BoxGeometry(L * 0.85, 0.7, W * 1.008), glass, capacity, false),
      stripe: mk(new THREE.BoxGeometry(L * 0.99, 0.22, W * 1.014), new THREE.MeshStandardMaterial({ color: '#c8342c', roughness: 0.6 }), capacity, false),
      skirt: mk(new THREE.BoxGeometry(L * 0.9, 0.5, W * 0.84), skirt, capacity, false),
      roof: mk(new RoundedBoxGeometry(L * 0.6, TRAM.roofH, W * 0.7, 2, 0.1), new THREE.MeshStandardMaterial({ color: '#b5b2a9', roughness: 0.9 }), capacity),
      panto: mk(new THREE.BoxGeometry(2.8, 0.08, 0.08), steel, capacity, false),
      panto2: mk(new THREE.BoxGeometry(1.6, 0.08, 1.05), steel, capacity, false),
      bogie: mk(new THREE.BoxGeometry(2.7, 0.46, W * 0.86), tyre, capacity, false),
    };
  }, [capacity]);

  useFrame(() => {
    if (group.current && !pool.scene) pool.attach(group.current);
    const list = get();
    poses.current = list;
    const L = TRAM.len, fy = TRAM.floor + TRAM.lowH / 2;
    list.forEach((p, i) => {
      const cx = Math.cos(p.yaw), sz = -Math.sin(p.yaw);
      put(parts.low, i, p.x, fy, p.z, p.yaw);
      put(parts.up, i, p.x, TRAM.floor + TRAM.lowH + TRAM.upH / 2 - 0.04, p.z, p.yaw);
      put(parts.glass, i, p.x, TRAM.floor + TRAM.lowH + TRAM.upH * 0.46, p.z, p.yaw);
      put(parts.stripe, i, p.x, fy + 0.3, p.z, p.yaw);
      put(parts.skirt, i, p.x, TRAM.floor - 0.05, p.z, p.yaw);
      put(parts.roof, i, p.x, TRAM.floor + TRAM.lowH + TRAM.upH + 0.07, p.z, p.yaw);
      put(parts.panto, i, p.x, TRAM.floor + TRAM.lowH + TRAM.upH + 0.26, p.z, p.yaw);
      put(parts.panto2, i, p.x, TRAM.floor + TRAM.lowH + TRAM.upH + 0.4, p.z, p.yaw);
      put(parts.bogie, i, p.x + cx * L * 0.31, 0.24, p.z + sz * L * 0.31, p.yaw);
      put(parts.bogie, i + list.length, p.x - cx * L * 0.31, 0.24, p.z - sz * L * 0.31, p.yaw);
    });
    for (const k in parts) parts[k as keyof typeof parts].count = k === 'bogie' ? list.length * 2 : list.length;
    flush(...Object.values(parts));
    pool.render(list, (i, p, mesh) => {
      put(mesh, i, p.x + Math.cos(p.yaw) * (L / 2 + 0.07), 3.3, p.z - Math.sin(p.yaw) * (L / 2 + 0.07), p.yaw, 1.45, 0.72, 1);
    });
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    if (!onPick || e.delta > 4 || e.instanceId == null) return;
    e.stopPropagation();
    onPick(e.instanceId);
  };

  return (
    <group ref={group}>
      {Object.entries(parts).map(([k, m]) => <primitive key={k} object={m} onClick={click} />)}
      {selected ? <Ring get={get} match={selected} color="#5cc8ff" /> : null}
    </group>
  );
}

export function BusFleet({ get, capacity = 240, onPick }: { get: () => FleetPose[]; capacity?: number; onPick?: (i: number) => void }) {
  const group = useRef<THREE.Group>(null);
  const pool = useMemo(() => new BoardPool(), []);
  const parts = useMemo(() => {
    const body = new THREE.MeshStandardMaterial({ color: '#f4f2ea', roughness: 0.45, metalness: 0.06 });
    const glass = new THREE.MeshStandardMaterial({ color: '#18242c', roughness: 0.16, metalness: 0.55 });
    const skirt = new THREE.MeshStandardMaterial({ color: '#495560', roughness: 0.7 });
    const tyre = new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.95 });
    const L = BUS.len, W = BUS.wid;
    return {
      low: mk(new RoundedBoxGeometry(L, BUS.lowH, W, 3, 0.3), body, capacity),
      up: mk(new RoundedBoxGeometry(L * 0.62, BUS.upH, W * 0.95, 3, 0.26), body, capacity),
      glass: mk(new THREE.BoxGeometry(L * 0.9, 0.64, W * 1.008), glass, capacity, false),
      accent: mk(new THREE.BoxGeometry(L * 0.99, 0.18, W * 1.014), new THREE.MeshStandardMaterial({ color: '#c8342c', roughness: 0.6 }), capacity, false),
      skirt: mk(new THREE.BoxGeometry(L * 0.86, 0.46, W * 0.82), skirt, capacity, false),
      wheels: mk(new THREE.BoxGeometry(2.5, 0.8, W * 1.02), tyre, capacity, false),
    };
  }, [capacity]);

  useFrame(() => {
    if (group.current && !pool.scene) pool.attach(group.current);
    const list = get();
    const L = BUS.len;
    list.forEach((p, i) => {
      const cx = Math.cos(p.yaw), sz = -Math.sin(p.yaw);
      put(parts.low, i, p.x, BUS.floor + BUS.lowH / 2, p.z, p.yaw);
      put(parts.up, i, p.x - cx * L * 0.05, BUS.floor + BUS.lowH + BUS.upH / 2 - 0.03, p.z - sz * L * 0.05, p.yaw);
      put(parts.glass, i, p.x, BUS.floor + BUS.lowH + BUS.upH * 0.46, p.z, p.yaw);
      put(parts.accent, i, p.x, BUS.floor + BUS.lowH * 0.34, p.z, p.yaw);
      put(parts.skirt, i, p.x, BUS.floor - 0.02, p.z, p.yaw);
      put(parts.wheels, i, p.x + cx * L * 0.33, 0.4, p.z + sz * L * 0.33, p.yaw);
      put(parts.wheels, i + list.length, p.x - cx * L * 0.33, 0.4, p.z - sz * L * 0.33, p.yaw);
    });
    for (const k in parts) parts[k as keyof typeof parts].count = k === 'wheels' ? list.length * 2 : list.length;
    flush(...Object.values(parts));
    pool.render(list, (i, p, mesh) => {
      put(mesh, i, p.x + Math.cos(p.yaw) * (L / 2 + 0.06), 2.9, p.z - Math.sin(p.yaw) * (L / 2 + 0.06), p.yaw, 1.15, 0.58, 1);
    });
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    if (!onPick || e.delta > 4 || e.instanceId == null) return;
    e.stopPropagation();
    onPick(e.instanceId);
  };

  return (
    <group ref={group}>
      {Object.entries(parts).map(([k, m]) => <primitive key={k} object={m} onClick={click} />)}
    </group>
  );
}

export function CarFleet({ get, sim, capacity = 320 }: { get: () => FleetPose[]; sim: Sim; capacity?: number }) {
  const hlMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#fff2c4', transparent: true, opacity: 0, toneMapped: false, depthWrite: false,
  }), []);
  const parts = useMemo(() => ({
    low: mk(new RoundedBoxGeometry(4.3, 0.92, 1.84, 2, 0.22), new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.32, metalness: 0.3 }), capacity),
    cab: mk(new RoundedBoxGeometry(2.2, 0.8, 1.7, 2, 0.24), new THREE.MeshStandardMaterial({ color: '#1d242b', roughness: 0.2, metalness: 0.5 }), capacity),
    wheels: mk(new THREE.BoxGeometry(3.3, 0.62, 1.94), new THREE.MeshStandardMaterial({ color: '#141618', roughness: 0.95 }), capacity, false),
    hlL: mk(new THREE.BoxGeometry(0.22, 0.18, 0.35), hlMat, capacity, false),
    hlR: mk(new THREE.BoxGeometry(0.22, 0.18, 0.35), hlMat, capacity, false),
  }), [capacity, hlMat]);

  const acc = useRef(0);
  useFrame((_, dt) => {
    const list = get();
    const PAL = ['#d9d4c7', '#2f3640', '#b3262e', '#3b6ea5', '#e0b23a', '#6b7f6a', '#8a8f98', '#4a4f57', '#e8e6df'];
    const night = Math.max(0, 1 - sim.dayFactor());
    const glow = night < 0.32 ? 0 : Math.min(1, (night - 0.32) / 0.5);
    list.forEach((p, i) => {
      const fx = Math.cos(p.yaw), fz = -Math.sin(p.yaw);
      const rx = Math.sin(p.yaw), rz = Math.cos(p.yaw);
      put(parts.low, i, p.x, 0.72, p.z, p.yaw);
      put(parts.cab, i, p.x - fx * 0.22, 1.5, p.z - fz * 0.22, p.yaw);
      put(parts.wheels, i, p.x, 0.32, p.z, p.yaw);
      put(parts.hlL, i, p.x + fx * 2.05 + rx * 0.58, 0.55, p.z + fz * 2.05 + rz * 0.58, p.yaw);
      put(parts.hlR, i, p.x + fx * 2.05 - rx * 0.58, 0.55, p.z + fz * 2.05 - rz * 0.58, p.yaw);
      parts.low.setColorAt(i, COL.set(PAL[i % PAL.length]));
    });
    for (const m of Object.values(parts)) m.count = list.length;
    flush(...Object.values(parts));
    if (parts.low.instanceColor) parts.low.instanceColor.needsUpdate = true;

    acc.current += dt;
    if (acc.current >= 0.12) {
      acc.current = 0;
      hlMat.opacity = glow * 0.95;
      hlMat.visible = glow > 0.02;
    }
  });

  return <group>{Object.entries(parts).map(([k, m]) => <primitive key={k} object={m} />)}</group>;
}

function Ring({ get, match, color }: { get: () => FleetPose[]; match: string; color: string }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  useFrame(() => {
    const m = ref.current;
    if (!m) return;
    let n = 0;
    for (const p of get()) {
      if (p.id !== match) continue;
      put(m, n++, p.x, 0.45, p.z, p.yaw);
    }
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, 4]} frustumCulled={false}>
      <ringGeometry args={[1.9, 2.4, 26]} />
      <meshBasicMaterial color={color} toneMapped={false} transparent opacity={0.95} side={THREE.DoubleSide} />
    </instancedMesh>
  );
}

/** Zielony pierścień pod realnym pojazdem = oznaczenie danych OBSERVED. */
export function ObservedMarkers({ get, capacity = 260 }: { get: () => FleetPose[]; capacity?: number }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const acc = useRef(0);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.08) return; // ~12 Hz – wystarczy do pierścieni
    acc.current = 0;
    const m = ref.current;
    if (!m) return;
    const list = get();
    const n = Math.min(list.length, capacity);
    for (let i = 0; i < n; i++) put(m, i, list[i].x, 0.42, list[i].z, list[i].yaw);
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
  });
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, capacity]} frustumCulled={false}>
      <ringGeometry args={[1.35, 1.75, 16]} />
      <meshBasicMaterial color="#3ee08a" toneMapped={false} transparent opacity={0.85} side={THREE.DoubleSide} />
    </instancedMesh>
  );
}

/* ------------------------------------------------------------------ piesi */

const CLOTH = ['#3b4a63', '#6b3f3f', '#3f5f4a', '#5a4a6b', '#2f3238', '#8a6a3f', '#a83f52', '#2f6f8a', '#c47b3a', '#33404d'];
const SKIN = ['#e8c39e', '#d7a97f', '#b8895f', '#f0d3b4'];

export function PedestrianFleet({ peds, active, detailLimit = 300 }: { peds: Ped[]; active: number; detailLimit?: number }) {
  const n = Math.max(1, Math.min(peds.length, 900));
  const parts = useMemo(() => {
    const cloth = new THREE.MeshStandardMaterial({ roughness: 0.85 });
    const skin = new THREE.MeshStandardMaterial({ roughness: 0.7 });
    const leg = new THREE.MeshStandardMaterial({ color: '#2b3038', roughness: 0.88 });
    const torsoGeo = new THREE.CylinderGeometry(0.19, 0.15, 0.62, 8);
    torsoGeo.scale(1, 1, 0.62);
    const headGeo = new THREE.SphereGeometry(0.115, 10, 8);
    headGeo.scale(0.9, 1.05, 0.95);
    return {
      torso: mk(torsoGeo, cloth, n),
      head: mk(headGeo, skin, n),
      legL: mk(new THREE.CylinderGeometry(0.075, 0.055, 0.82, 6), leg, n),
      legR: mk(new THREE.CylinderGeometry(0.075, 0.055, 0.82, 6), leg, n),
      armL: mk(new THREE.CylinderGeometry(0.055, 0.045, 0.58, 6), skin, n),
      armR: mk(new THREE.CylinderGeometry(0.055, 0.045, 0.58, 6), skin, n),
      simple: mk(new THREE.CapsuleGeometry(0.17, 1.05, 3, 7), cloth, n),
    };
  }, [n]);

  useFrame(() => {
    const cnt = Math.min(active, peds.length);
    for (let i = 0; i < cnt; i++) {
      const p = peds[i];
      parts.torso.setColorAt(i, COL.set(CLOTH[p.variant % CLOTH.length]));
      parts.simple.setColorAt(i, COL.set(CLOTH[p.variant % CLOTH.length]));
      parts.head.setColorAt(i, COL.set(SKIN[p.variant % SKIN.length]));
      parts.armL.setColorAt(i, COL.set(SKIN[p.variant % SKIN.length]));
      parts.armR.setColorAt(i, COL.set(SKIN[p.variant % SKIN.length]));
    }
    for (const m of Object.values(parts)) if (m.instanceColor) m.instanceColor.needsUpdate = true;

    const detail = Math.min(cnt, detailLimit);
    let simple = 0;
    for (let i = 0; i < cnt; i++) {
      const p = peds[i];
      const s = p.height / 1.75;
      if (i >= detail) {
        put(parts.simple, detail + simple, p.x, 0.9 * s, p.z, p.yaw);
        parts.simple.scale.setScalar?.(1);
        simple++;
        continue;
      }
      const swing = Math.sin(p.phase) * 0.55;
      const swing2 = Math.sin(p.phase + Math.PI) * 0.55;
      const bob = Math.abs(Math.sin(p.phase)) * 0.035;
      const hipY = 0.9 * s + bob;
      D.position.set(p.x, groundY(p.x, p.z) + hipY + 0.31 * s, p.z);
      D.rotation.set(0, p.yaw, 0); D.scale.set(s, s, s); D.updateMatrix();
      parts.torso.setMatrixAt(i, D.matrix);
      D.position.set(p.x, groundY(p.x, p.z) + hipY + 0.76 * s, p.z);
      D.updateMatrix();
      parts.head.setMatrixAt(i, D.matrix);
      D.rotation.set(swing, p.yaw, 0);
      D.position.set(p.x + Math.cos(p.yaw) * 0.09 * s, groundY(p.x, p.z) + hipY - 0.41 * s, p.z - Math.sin(p.yaw) * 0.09 * s);
      D.updateMatrix();
      parts.legL.setMatrixAt(i, D.matrix);
      D.rotation.set(swing2, p.yaw, 0);
      D.position.set(p.x - Math.cos(p.yaw) * 0.09 * s, groundY(p.x, p.z) + hipY - 0.41 * s, p.z + Math.sin(p.yaw) * 0.09 * s);
      D.updateMatrix();
      parts.legR.setMatrixAt(i, D.matrix);
      D.rotation.set(swing2 * 0.7, p.yaw, 0);
      D.position.set(p.x + Math.cos(p.yaw + 1.5708) * 0.2 * s, groundY(p.x, p.z) + hipY + 0.33 * s, p.z - Math.sin(p.yaw + 1.5708) * 0.2 * s);
      D.updateMatrix();
      parts.armL.setMatrixAt(i, D.matrix);
      D.rotation.set(swing * 0.7, p.yaw, 0);
      D.position.set(p.x - Math.cos(p.yaw + 1.5708) * 0.2 * s, groundY(p.x, p.z) + hipY + 0.33 * s, p.z + Math.sin(p.yaw + 1.5708) * 0.2 * s);
      D.updateMatrix();
      parts.armR.setMatrixAt(i, D.matrix);
    }
    parts.torso.count = detail; parts.head.count = detail;
    parts.legL.count = detail; parts.legR.count = detail;
    parts.armL.count = detail; parts.armR.count = detail;
    parts.simple.count = simple;
    flush(...Object.values(parts));
  });

  return <group>{Object.entries(parts).map(([k, m]) => <primitive key={k} object={m} />)}</group>;
}

/** Pozycje symulowanych pojazdów MPK z symulacji. */
export function transitPoses(sim: Sim) {
  const trams: FleetPose[] = [], buses: FleetPose[] = [], cars: FleetPose[] = [];
  for (const v of sim.veh) {
    const p: FleetPose = { id: `${v.kind}-${v.edge}-${Math.round(v.x)}-${Math.round(v.z)}`, x: v.x, z: v.z, yaw: v.yaw, ref: v.ref };
    if (v.kind === 2) trams.push(p);
    else if (v.kind === 1) buses.push(p);
    else cars.push(p);
  }
  return { trams, buses, cars };
}
