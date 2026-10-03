/**
 * Niebieski podgląd miejsca, w którym coś postawimy.
 * Czerwony = lokalizacja niedozwolona (walidacja z Sim).
 */
import { useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { groundY } from '../terrain';
import { buildSpec, type BuildId } from '../../simulation/city/catalog';
import type { Sim } from '../../simulation/sim';

export type PlaceKind = 'park' | 'park-rect' | 'stop-bus' | 'stop-tram' | 'road' | 'tram-track' | 'build';

const SPECS: Record<Exclude<PlaceKind, 'build'>, { w: number; d: number; h: number }> = {
  park: { w: 52, d: 52, h: 0.8 },
  'park-rect': { w: 56, d: 36, h: 0.8 },
  'stop-bus': { w: 18, d: 9, h: 5 },
  'stop-tram': { w: 20, d: 9, h: 6 },
  road: { w: 0, d: 0, h: 0.4 },
  'tram-track': { w: 0, d: 0, h: 0.4 },
};

const isLineTool = (k: PlaceKind | null) => k === 'road' || k === 'tram-track';
const isStopTool = (k: PlaceKind | null) => k === 'stop-bus' || k === 'stop-tram';

const OK = '#4aa3ff';
const BAD = '#e0453a';

export function PlacementGhost({
  kind, buildId, roadFrom, point, onCommit, rot = 0, pending, sim,
}: {
  kind: PlaceKind | null;
  buildId?: BuildId | null;
  roadFrom: { x: number; z: number } | null;
  point: React.MutableRefObject<{ x: number; z: number }>;
  onCommit: (x: number, z: number, x2: number, z2: number) => void;
  rot?: number;
  /** Gdy jest pending – zamrażamy ghost w miejscu planu. */
  pending?: { x: number; z: number; rot: number } | null;
  sim?: Sim | null;
}) {
  const box = useRef<THREE.Mesh>(null);
  const foot = useRef<THREE.Mesh>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const disc = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const line = useRef<THREE.Mesh>(null);
  const aura = useRef<THREE.Mesh>(null);
  const validRef = useRef(true);

  const mats = useMemo(() => ({
    box: new THREE.MeshStandardMaterial({ color: OK, transparent: true, opacity: 0.45, depthWrite: false }),
    foot: new THREE.MeshBasicMaterial({ color: '#5cc8ff', transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide }),
    arrow: new THREE.MeshBasicMaterial({ color: '#ffd36a', transparent: true, opacity: 0.85, depthWrite: false }),
    aura: new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.12, depthWrite: false }),
    disc: new THREE.MeshStandardMaterial({ color: OK, transparent: true, opacity: 0.4, depthWrite: false }),
    ring: new THREE.MeshBasicMaterial({ color: '#5cc8ff', transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    line: new THREE.MeshStandardMaterial({ color: '#5cc8ff', transparent: true, opacity: 0.55, depthWrite: false }),
  }), []);

  useFrame(() => {
    const p = pending ? { x: pending.x, z: pending.z } : point.current;
    const yaw = pending ? pending.rot : rot;
    const gy = groundY(p.x, p.z);
    const catalog = kind === 'build' && buildId ? buildSpec(buildId) : null;
    const spec = catalog
      ? { w: catalog.w, d: catalog.d, h: catalog.h }
      : (kind && kind !== 'build' ? SPECS[kind] : null);

    let ok = true;
    if (kind === 'build' && buildId && sim) {
      ok = sim.validatePlacement(buildId, p.x, p.z, yaw) == null;
    }
    validRef.current = ok;
    const col = ok ? OK : BAD;
    mats.box.color.set(col);
    mats.aura.color.set(col);
    mats.disc.color.set(col);
    mats.foot.color.set(ok ? '#5cc8ff' : '#ff8a7a');
    mats.ring.color.set(ok ? '#5cc8ff' : '#ff8a7a');
    mats.line.color.set(ok ? '#5cc8ff' : '#ff8a7a');
    mats.arrow.color.set(ok ? '#ffd36a' : '#ff6a4a');

    if (box.current) {
      const showBox = !!spec && (kind === 'build' || kind === 'park-rect');
      box.current.visible = showBox;
      if (spec && showBox) {
        const isPark = catalog?.id === 'park' || catalog?.id === 'parking' || kind === 'park-rect';
        box.current.position.set(p.x, gy + (isPark ? 0.45 : spec.h / 2 + 0.5), p.z);
        box.current.rotation.y = yaw;
        box.current.scale.set(spec.w, isPark ? 0.5 : spec.h, spec.d);
      }
    }
    if (foot.current && catalog) {
      foot.current.visible = true;
      foot.current.position.set(p.x, gy + 0.12, p.z);
      foot.current.rotation.y = yaw;
      foot.current.scale.set(catalog.w + 2, 1, catalog.d + 2);
    } else if (foot.current) foot.current.visible = false;

    if (arrow.current && catalog) {
      arrow.current.visible = true;
      const fwd = catalog.d / 2 + 6;
      arrow.current.position.set(
        p.x + Math.sin(yaw) * fwd,
        gy + 0.4,
        p.z + Math.cos(yaw) * fwd,
      );
      arrow.current.rotation.y = yaw;
    } else if (arrow.current) arrow.current.visible = false;

    if (aura.current && catalog) {
      const r = Math.max(catalog.w, catalog.d) * (1.8 + catalog.trafficFactor);
      aura.current.visible = true;
      aura.current.position.set(p.x, gy + 0.08, p.z);
      aura.current.scale.set(r, r, 1);
    } else if (aura.current) aura.current.visible = false;

    if (disc.current) {
      const show = kind === 'park';
      disc.current.visible = show;
      if (show && spec) {
        disc.current.position.set(p.x, gy + 0.35, p.z);
        disc.current.scale.setScalar(spec.w / 2);
      }
    }
    if (ring.current) {
      const showRing = !!spec && (isStopTool(kind) || isLineTool(kind));
      ring.current.visible = showRing;
      if (showRing) ring.current.position.set(p.x, gy + 0.2, p.z);
    }
    if (line.current) {
      const showLine = isLineTool(kind) && !!roadFrom;
      line.current.visible = showLine;
      if (showLine && roadFrom) {
        const dx = p.x - roadFrom.x, dz = p.z - roadFrom.z;
        const len = Math.hypot(dx, dz) || 1;
        line.current.position.set((roadFrom.x + p.x) / 2, gy + 0.3, (roadFrom.z + p.z) / 2);
        line.current.rotation.set(0, Math.atan2(dx, dz), 0);
        line.current.scale.set(kind === 'tram-track' ? 4.2 : 7, 0.2, len);
      }
    }
  });

  const track = (e: ThreeEvent<PointerEvent>) => {
    if (pending) return;
    e.stopPropagation();
    point.current = { x: e.point.x, z: e.point.z };
  };
  const commit = (e: ThreeEvent<MouseEvent>) => {
    if (pending) return;
    e.stopPropagation();
    if (e.delta > 4) return;
    onCommit(e.point.x, e.point.z, e.point.x, e.point.z);
  };

  return (
    <group>
      <mesh ref={box} visible={false} material={mats.box}>
        <boxGeometry args={[1, 1, 1]} />
      </mesh>
      <mesh ref={foot} rotation-x={-Math.PI / 2} visible={false} material={mats.foot}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <mesh ref={arrow} visible={false} material={mats.arrow}>
        <coneGeometry args={[2.2, 5, 4]} />
      </mesh>
      <mesh ref={aura} rotation-x={-Math.PI / 2} visible={false} material={mats.aura}>
        <circleGeometry args={[1, 48]} />
      </mesh>
      <mesh ref={disc} rotation-x={-Math.PI / 2} visible={false} material={mats.disc}>
        <circleGeometry args={[1, 40]} />
      </mesh>
      <mesh ref={ring} visible={false} rotation-x={-Math.PI / 2} onPointerMove={track} onClick={commit} material={mats.ring}>
        <ringGeometry args={[6, 9, 28]} />
      </mesh>
      <mesh ref={line} visible={false} material={mats.line}>
        <boxGeometry args={[1, 1, 1]} />
      </mesh>
      {!pending && (
        <mesh rotation-x={-Math.PI / 2} position={[0, 0.15, 0]} onPointerMove={track} onClick={commit}>
          <planeGeometry args={[8000, 8000]} />
          <meshBasicMaterial transparent opacity={0} depthWrite={false} />
        </mesh>
      )}
    </group>
  );
}
