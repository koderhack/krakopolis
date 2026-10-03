/**
 * Ukryty mieszkaniec-easter-egg „Neo”.
 * Wizualna warstwa nad systemem pieszych – własna pozycja, bez wpływu na sim.
 */
import { useMemo, useRef, useState } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { Sim } from '../../simulation/sim';
import { PedestrianPool, makeRnd } from '../../simulation/pedestrians/agents';
import { groundY } from '../terrain';

const GENERIC = [
  'Czy to na pewno Kraków?',
  'Coś tu nie gra.',
  'Widziałem ten samochód wcześniej.',
  'Czy ktoś jeszcze to zauważa?',
  'To miasto ma dziwną rytmikę.',
  'Która ulica jest prawdziwa?',
];

const CTX = {
  traffic: 'Dlaczego wszyscy jadą tędy?',
  undo: 'Mam wrażenie, że już to widziałem.',
  build: 'Coś się zmieniło.',
  disaster: 'To zdecydowanie nie wygląda dobrze.',
} as const;

type Bubble = { text: string; until: number };

export function NeoAgent({
  sim,
  paused,
  speed,
  selected,
  onPick,
}: {
  sim: Sim;
  paused: boolean;
  speed: number;
  selected: boolean;
  onPick: () => void;
}) {
  const pool = useMemo(() => new PedestrianPool(sim.g, makeRnd(19990331), 1), [sim.g]);
  const ped = pool.peds[0];
  const group = useRef<THREE.Group>(null);
  const coat = useRef<THREE.Mesh>(null);
  const phase = useRef(0);
  const bubbleAt = useRef(12 + Math.random() * 40);
  const relocateAt = useRef(80 + Math.random() * 100);
  const prevUndo = useRef(sim.history.depth);
  const prevBuilt = useRef(sim.playerBuildings.length);
  const pendingCtx = useRef<string | null>(null);
  const bubbleRef = useRef<Bubble | null>(null);
  const [bubble, setBubble] = useState<Bubble | null>(null);

  useFrame((_, rawDt) => {
    if (paused) return;
    const dt = Math.min(rawDt, 0.12) * Math.max(0.25, speed);

    // kontekst – tylko odczyt, bez mutacji symulacji
    const undo = sim.history.depth;
    if (undo < prevUndo.current) pendingCtx.current = CTX.undo;
    prevUndo.current = undo;
    const built = sim.playerBuildings.length;
    if (built > prevBuilt.current) pendingCtx.current = CTX.build;
    prevBuilt.current = built;

    pool.step(ped, dt);
    phase.current = ped.phase;
    relocateAt.current -= dt;
    if (relocateAt.current <= 0) {
      const edges = sim.g.edges;
      if (edges.length) {
        const id = edges[Math.floor(Math.random() * edges.length)]!.id;
        pool.place(ped, id);
      }
      relocateAt.current = 90 + Math.random() * 140;
    }

    const g = group.current;
    if (g) {
      const gy = groundY(ped.x, ped.z);
      const bob = Math.abs(Math.sin(phase.current)) * 0.03;
      g.position.set(ped.x, gy + bob, ped.z);
      g.rotation.y = ped.yaw;
    }
    if (coat.current) {
      coat.current.rotation.x = Math.sin(phase.current) * 0.04;
    }

    const now = performance.now() / 1000;
    const cur = bubbleRef.current;
    if (cur && now >= cur.until) {
      bubbleRef.current = null;
      setBubble(null);
    }

    bubbleAt.current -= dt;
    if (bubbleAt.current <= 0 && !bubbleRef.current) {
      let text: string;
      if (pendingCtx.current) {
        text = pendingCtx.current;
        pendingCtx.current = null;
      } else if (sim.disasters.length > 0) {
        text = CTX.disaster;
      } else if (sim.m.traffic >= 68) {
        text = CTX.traffic;
      } else {
        text = GENERIC[Math.floor(Math.random() * GENERIC.length)]!;
      }
      const next = { text, until: now + 3.2 };
      bubbleRef.current = next;
      setBubble(next);
      bubbleAt.current = 55 + Math.random() * 90;
    }
  });

  const click = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return;
    e.stopPropagation();
    onPick();
  };

  return (
    <group ref={group} onClick={click}>
      {/* lekki hitbox – opacity 0, ale raycastable */}
      <mesh position={[0, 0.95, 0]}>
        <capsuleGeometry args={[0.28, 1.15, 4, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>

      {/* nogi */}
      <mesh position={[-0.09, 0.42, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.055, 0.84, 6]} />
        <meshStandardMaterial color="#14161a" roughness={0.92} />
      </mesh>
      <mesh position={[0.09, 0.42, 0]} castShadow>
        <cylinderGeometry args={[0.07, 0.055, 0.84, 6]} />
        <meshStandardMaterial color="#14161a" roughness={0.92} />
      </mesh>

      {/* długi ciemny płaszcz */}
      <mesh ref={coat} position={[0, 1.05, 0]} castShadow>
        <cylinderGeometry args={[0.22, 0.28, 1.15, 10]} />
        <meshStandardMaterial color="#0c0e12" roughness={0.78} metalness={0.05} />
      </mesh>
      {/* kołnierz */}
      <mesh position={[0, 1.58, 0.02]} castShadow>
        <boxGeometry args={[0.38, 0.14, 0.22]} />
        <meshStandardMaterial color="#0a0b0e" roughness={0.8} />
      </mesh>

      {/* głowa */}
      <mesh position={[0, 1.82, 0]} castShadow>
        <sphereGeometry args={[0.12, 10, 8]} />
        <meshStandardMaterial color="#c9a882" roughness={0.7} />
      </mesh>
      {/* krótkie ciemne włosy */}
      <mesh position={[0, 1.9, -0.01]}>
        <sphereGeometry args={[0.125, 8, 6]} />
        <meshStandardMaterial color="#0a0a0c" roughness={0.95} />
      </mesh>

      {/* ciemne okulary */}
      <mesh position={[0, 1.84, 0.1]}>
        <boxGeometry args={[0.2, 0.05, 0.04]} />
        <meshStandardMaterial color="#050608" roughness={0.35} metalness={0.4} />
      </mesh>

      {selected && (
        <mesh position={[0, 0.04, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.35, 0.48, 24]} />
          <meshBasicMaterial color="#5cc8ff" transparent opacity={0.55} toneMapped={false} />
        </mesh>
      )}

      {bubble && (
        <Html
          position={[0, 2.35, 0]}
          center
          distanceFactor={28}
          zIndexRange={[12, 0]}
          style={{ pointerEvents: 'none' }}
        >
          <div className="neo-bubble" style={{ pointerEvents: 'none' }}>{bubble.text}</div>
        </Html>
      )}
    </group>
  );
}

export function NeoCard({ onClose }: { onClose: () => void }) {
  return (
    <aside className="panel vehicle">
      <h2>NEO</h2>
      <p className="sub">Mieszkaniec</p>
      <dl>
        <dt>Status</dt>
        <dd><span className="tag simulated">SIMULATED</span></dd>
        <dt>Opis</dt>
        <dd>Od czasu do czasu zadaje dziwne pytania.</dd>
      </dl>
      <div className="acts">
        <button type="button" onClick={onClose}>Zamknij</button>
      </div>
      <p className="note">Jeden z mieszkańców poruszających się po ulicach miasta.</p>
    </aside>
  );
}
