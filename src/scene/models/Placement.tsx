/**
 * Niebieski podgląd miejsca, w którym coś postawimy.
 */
import { useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { groundY } from '../terrain';
import { buildSpec, type BuildId } from '../../simulation/city/catalog';

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

export function PlacementGhost({
  kind, buildId, roadFrom, point, onCommit, rot = 0, pending,
}: {
  kind: PlaceKind | null;
  buildId?: BuildId | null;
  roadFrom: { x: number; z: number } | null;
  point: React.MutableRefObject<{ x: number; z: number }>;
  onCommit: (x: number, z: number, x2: number, z2: number) => void;
  rot?: number;
  /** Gdy jest pending – zamrażamy ghost w miejscu planu. */
  pending?: { x: number; z: number; rot: number } | null;
}) {
  const box = useRef<THREE.Mesh>(null);
  const foot = useRef<THREE.Mesh>(null);
  const arrow = useRef<THREE.Mesh>(null);
  const disc = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const line = useRef<THREE.Mesh>(null);
  const aura = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const p = pending ? { x: pending.x, z: pending.z } : point.current;
    const yaw = pending ? pending.rot : rot;
    const gy = groundY(p.x, p.z);
    const catalog = kind === 'build' && buildId ? buildSpec(buildId) : null;
    const spec = catalog
      ? { w: catalog.w, d: catalog.d, h: catalog.h }
      : (kind && kind !== 'build' ? SPECS[kind] : null);

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
      <mesh ref={box} visible={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#4aa3ff" transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <mesh ref={foot} rotation-x={-Math.PI / 2} visible={false}>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial color="#5cc8ff" transparent opacity={0.22} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={arrow} visible={false}>
        <coneGeometry args={[2.2, 5, 4]} />
        <meshBasicMaterial color="#ffd36a" transparent opacity={0.85} depthWrite={false} />
      </mesh>
      <mesh ref={aura} rotation-x={-Math.PI / 2} visible={false}>
        <circleGeometry args={[1, 48]} />
        <meshBasicMaterial color="#4aa3ff" transparent opacity={0.12} depthWrite={false} />
      </mesh>
      <mesh ref={disc} rotation-x={-Math.PI / 2} visible={false}>
        <circleGeometry args={[1, 40]} />
        <meshStandardMaterial color="#4aa3ff" transparent opacity={0.4} depthWrite={false} />
      </mesh>
      <mesh ref={ring} visible={false} rotation-x={-Math.PI / 2} onPointerMove={track} onClick={commit}>
        <ringGeometry args={[6, 9, 28]} />
        <meshBasicMaterial color="#5cc8ff" transparent opacity={0.55} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={line} visible={false}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#5cc8ff" transparent opacity={0.55} depthWrite={false} />
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
