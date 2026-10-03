/**
 * Lepsze bryły dla znanych zabytków Krakowa – wieże, arkady, bryły charakterystyczne.
 * Reszta zabudowy zostaje z obrysów OSM.
 */
import { memo, useMemo } from 'react';
import * as THREE from 'three';
import { groundY } from '../terrain';
import type { SimBuilding } from '../../data/model';

type Style = 'cloth-hall' | 'castle' | 'church' | 'tower' | 'synagogue';

function classify(name?: string, landmark?: boolean): Style | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('sukiennice')) return 'cloth-hall';
  if (n.includes('wawel') || n.includes('zamek królewski') || n.includes('zamku królewskiego')) return 'castle';
  if (n.includes('mariack')) return 'church';
  if (n.includes('bazylika') || n.includes('kościół') || n.includes('katedr')) return 'church';
  if (n.includes('baszta') || n.includes('wieża')) return 'tower';
  if (n.includes('synagog')) return 'synagogue';
  if (landmark && (n.includes('pałac') || n.includes('ratusz'))) return 'castle';
  // Nie doklejamy wież do zwykłych kamienic z tagiem landmark (np. na Rynku).
  return null;
}

export const LandmarkExtras = memo(function LandmarkExtras({ buildings }: { buildings: SimBuilding[] }) {
  const items = useMemo(() => {
    return buildings
      .map((b, i) => ({ b, i, style: classify(b.name, b.landmark) }))
      .filter((x): x is { b: SimBuilding; i: number; style: Style } => !!x.style)
      .slice(0, 80);
  }, [buildings]);

  return (
    <group>
      {items.map(({ b, i, style }) => {
        const y = groundY(b.x, b.z);
        if (style === 'cloth-hall') {
          // Arkady Sukiennic – rząd kolumn + wyższy środkowy dach
          return (
            <group key={i}>
              {[-0.35, -0.18, 0, 0.18, 0.35].map((t, k) => (
                <mesh key={k} position={[b.x + t * b.w * 0.85, y + b.h * 0.55, b.z + b.d * 0.42]} castShadow>
                  <cylinderGeometry args={[0.55, 0.65, b.h * 0.7, 6]} />
                  <meshStandardMaterial color="#e8dcc8" roughness={0.85} />
                </mesh>
              ))}
              <mesh position={[b.x, y + b.h + 3.2, b.z]} castShadow>
                <boxGeometry args={[b.w * 0.55, 4.5, b.d * 0.55]} />
                <meshStandardMaterial color="#7a3f36" roughness={0.9} />
              </mesh>
            </group>
          );
        }
        if (style === 'church' || style === 'castle') {
          const th = style === 'castle' ? b.h * 0.85 : b.h * 1.35;
          return (
            <group key={i}>
              <mesh position={[b.x - b.w * 0.28, y + b.h + th / 2, b.z - b.d * 0.1]} castShadow>
                <boxGeometry args={[Math.min(8, b.w * 0.22), th, Math.min(8, b.d * 0.22)]} />
                <meshStandardMaterial color="#d9cbb6" roughness={0.88} />
              </mesh>
              <mesh position={[b.x - b.w * 0.28, y + b.h + th + 2.2, b.z - b.d * 0.1]} castShadow>
                <coneGeometry args={[Math.min(5, b.w * 0.14), 6, 4]} />
                <meshStandardMaterial color="#5c3a32" roughness={0.92} />
              </mesh>
              {style === 'church' && (
                <mesh position={[b.x + b.w * 0.22, y + b.h + th * 0.75, b.z]} castShadow>
                  <boxGeometry args={[Math.min(6, b.w * 0.16), th * 0.75, Math.min(6, b.d * 0.16)]} />
                  <meshStandardMaterial color="#d2c4ae" roughness={0.88} />
                </mesh>
              )}
            </group>
          );
        }
        if (style === 'tower') {
          return (
            <mesh key={i} position={[b.x, y + b.h + 6, b.z]} castShadow>
              <cylinderGeometry args={[Math.min(b.w, b.d) * 0.28, Math.min(b.w, b.d) * 0.32, 12, 8]} />
              <meshStandardMaterial color="#cfc3b0" roughness={0.9} />
            </mesh>
          );
        }
        if (style === 'synagogue') {
          return (
            <mesh key={i} position={[b.x, y + b.h + 2.4, b.z]} castShadow>
              <boxGeometry args={[b.w * 0.4, 3.2, b.d * 0.4]} />
              <meshStandardMaterial color="#8a6a3a" roughness={0.85} />
            </mesh>
          );
        }
        return null;
      })}
    </group>
  );
});

void THREE;
