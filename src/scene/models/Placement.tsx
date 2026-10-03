/**
 * Niebieski podgląd miejsca, w którym coś postawimy.
 * Kursor śledzi podłoże, pod nim pojawia się niebieski „duch" obiektu,
 * a kliknięcie zatwierdza położenie.
 */
import { useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { groundY } from '../terrain';

export type PlaceKind = 'park' | 'mall' | 'university' | 'stop-bus' | 'stop-tram' | 'road';

const SPECS: Record<PlaceKind, { w: number; d: number; h: number }> = {
  park: { w: 52, d: 52, h: 0.8 },
  mall: { w: 78, d: 66, h: 14 },
  university: { w: 62, d: 54, h: 22 },
  'stop-bus': { w: 18, d: 9, h: 5 },
  'stop-tram': { w: 20, d: 9, h: 6 },
  road: { w: 0, d: 0, h: 0.4 },
};

export function PlacementGhost({
  kind, roadFrom, point, onCommit,
}: {
  kind: PlaceKind | null;
  roadFrom: { x: number; z: number } | null;
  point: React.MutableRefObject<{ x: number; z: number }>;
  onCommit: (x: number, z: number, x2: number, z2: number) => void;
}) {
  const box = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Mesh>(null);
  const line = useRef<THREE.Mesh>(null);

  useFrame(() => {
    const p = point.current;
    const spec = kind ? SPECS[kind] : null;
    const gy = groundY(p.x, p.z);
    const showBox = !!spec && kind !== 'stop-bus' && kind !== 'stop-tram' && kind !== 'road';
    if (box.current) {
      box.current.visible = showBox;
      if (spec) {
        box.current.position.set(p.x, gy + spec.h / 2 + 0.5, p.z);
        box.current.scale.set(spec.w, spec.h, spec.d);
      }
    }
    if (ring.current) {
      const showRing = !!spec && (kind === 'stop-bus' || kind === 'stop-tram' || kind === 'road');
      ring.current.visible = showRing;
      ring.current.position.set(p.x, gy + 0.7, p.z);
      const r = spec ? (kind === 'road' ? 12 : spec.w / 2) : 8;
      ring.current.scale.set(r, r, r);
    }
    if (line.current) {
      const showLine = kind === 'road' && !!roadFrom;
      line.current.visible = showLine;
      if (showLine && roadFrom) {
        const dx = p.x - roadFrom.x, dz = p.z - roadFrom.z;
        const len = Math.hypot(dx, dz) || 0.001;
        line.current.position.set((p.x + roadFrom.x) / 2, gy + 0.7, (p.z + roadFrom.z) / 2);
        line.current.rotation.set(0, Math.atan2(dx, dz), 0);
        line.current.scale.set(14, 0.5, len);
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
    if (kind === 'road') {
      if (roadFrom) onCommit(roadFrom.x, roadFrom.z, e.point.x, e.point.z);
    } else onCommit(e.point.x, e.point.z, e.point.x, e.point.z);
  };

  if (!kind) return null;
  return (
    <group>
      <mesh ref={box} visible={false} onPointerMove={track} onClick={commit}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#2f8fff" transparent opacity={0.34} depthWrite={false} />
      </mesh>
      <mesh ref={ring} visible={false} rotation-x={-Math.PI / 2} onPointerMove={track} onClick={commit}>
        <ringGeometry args={[0.84, 1, 32]} />
        <meshBasicMaterial color="#2f8fff" transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      <mesh ref={line} visible={false} onPointerMove={track} onClick={commit}>
        <boxGeometry args={[1, 1, 1]} />
        <meshBasicMaterial color="#2f8fff" transparent opacity={0.45} depthWrite={false} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.1, 0]} visible={false} onPointerMove={track} onClick={commit}>
        <planeGeometry args={[4000, 4000]} />
        <meshBasicMaterial />
      </mesh>
    </group>
  );
}
