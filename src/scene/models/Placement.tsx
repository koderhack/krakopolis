/**
 * Niebieski podgląd miejsca, w którym coś postawimy.
 * Kursor śledzi podłoże, pod nim pojawia się niebieski „duch" obiektu,
 * a kliknięcie zatwierdza położenie.
 */
import { useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { groundY } from '../terrain';

export type PlaceKind = 'park' | 'park-rect' | 'mall' | 'university' | 'stop-bus' | 'stop-tram' | 'road' | 'tram-track';

const SPECS: Record<PlaceKind, { w: number; d: number; h: number }> = {
  park: { w: 52, d: 52, h: 0.8 },
  'park-rect': { w: 56, d: 36, h: 0.8 },
  mall: { w: 78, d: 66, h: 14 },
  university: { w: 62, d: 54, h: 22 },
  'stop-bus': { w: 18, d: 9, h: 5 },
  'stop-tram': { w: 20, d: 9, h: 6 },
  road: { w: 0, d: 0, h: 0.4 },
  'tram-track': { w: 0, d: 0, h: 0.4 },
};

const isLineTool = (k: PlaceKind | null) => k === 'road' || k === 'tram-track';
const isStopTool = (k: PlaceKind | null) => k === 'stop-bus' || k === 'stop-tram';

export function PlacementGhost({
  kind, roadFrom, point, onCommit,
}: {
  kind: PlaceKind | null;
  roadFrom: { x: number; z: number } | null;
  point: React.MutableRefObject<{ x: number; z: number }>;
  onCommit: (x: number, z: number, x2: number, z2: number) => void;
}) {
  const box = useRef<THREE.Mesh>(null);
  const disc = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const line = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const p = point.current;
    const spec = kind ? SPECS[kind] : null;
    const gy = groundY(p.x, p.z);

    if (box.current) {
      const showBox = !!spec && (kind === 'mall' || kind === 'university' || kind === 'park-rect');
      box.current.visible = showBox;
      if (spec && showBox) {
        box.current.position.set(p.x, gy + (kind === 'park-rect' ? 0.45 : spec.h / 2 + 0.5), p.z);
        box.current.scale.set(spec.w, kind === 'park-rect' ? 0.5 : spec.h, spec.d);
      }
    }
    if (disc.current) {
      const show = kind === 'park';
      disc.current.visible = show;
      if (show && spec) {
        disc.current.position.set(p.x, gy + 0.45, p.z);
        disc.current.scale.set(spec.w / 2, spec.d / 2, 1);
      }
    }
    if (ring.current) {
      const showRing = !!spec && (isStopTool(kind) || isLineTool(kind));
      ring.current.visible = showRing;
      ring.current.position.set(p.x, gy + 0.7, p.z);
      const r = kind === 'tram-track' ? 10 : kind === 'road' ? 12 : (spec?.w ?? 16) / 2;
      ring.current.scale.set(r, r, r);
    }
    if (line.current) {
      const showLine = isLineTool(kind) && !!roadFrom;
      line.current.visible = showLine;
      if (showLine && roadFrom) {
        const dx = p.x - roadFrom.x, dz = p.z - roadFrom.z;
        const len = Math.hypot(dx, dz) || 0.001;
        line.current.position.set((p.x + roadFrom.x) / 2, gy + 0.7, (p.z + roadFrom.z) / 2);
        line.current.rotation.set(0, Math.atan2(dx, dz), 0);
        line.current.scale.set(kind === 'tram-track' ? 5.2 : 14, 0.5, len);
      }
    }
  });

  const track = (e: ThreeEvent<PointerEvent>) => {
    if (!kind) return;
    point.current.x = e.point.x;
    point.current.z = e.point.z;
  };
  const commit = (e: ThreeEvent<MouseEvent>) => {
    if (!kind || e.delta > 4) return;
    e.stopPropagation();
    if (isLineTool(kind)) {
      if (roadFrom) onCommit(roadFrom.x, roadFrom.z, e.point.x, e.point.z);
    } else onCommit(e.point.x, e.point.z, e.point.x, e.point.z);
  };

  if (!kind) return null;
  const lineColor = kind === 'tram-track' ? '#5cc8ff' : '#2f8fff';
  return (
    <group>
      <mesh ref={box} visible={false} onPointerMove={track} onClick={commit}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#2f8fff" transparent opacity={0.34} depthWrite={false} />
      </mesh>
      <mesh ref={disc} visible={false} rotation-x={-Math.PI / 2} onPointerMove={track} onClick={commit}>
        <circleGeometry args={[1, 36]} />
        <meshBasicMaterial color="#2f8fff" transparent opacity={0.32} depthWrite={false} />
      </mesh>
      <mesh ref={ring} visible={false} rotation-x={-Math.PI / 2} onPointerMove={track} onClick={commit}>
        <ringGeometry args={[0.84, 1, 32]} />
        <meshBasicMaterial color={lineColor} transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={line} visible={false} onPointerMove={track} onClick={commit}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color={lineColor} transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.1, 0]} visible={false} onPointerMove={track} onClick={commit}>
        <planeGeometry args={[4000, 4000]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  );
}
