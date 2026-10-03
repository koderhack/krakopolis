/**
 * Warstwy statyczne miasta: teren z realnych wysokości, woda, zieleń,
 * sieć drogowa z torowiskami, budynki z prawdziwych obrysów OSM,
 * przystanki MPK oraz obiekty postawione przez gracza.
 */
import { memo, useLayoutEffect, useMemo, useRef } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Sim, RoadSim } from '../../simulation/sim';
import type { CityData, SimPolygon } from '../../data/model';
import { asphaltTex, grassTex, groundTex, groundY, HeightField, pavementTex } from '../terrain';

const D = new THREE.Object3D();
const C = new THREE.Color();
const boxGeo = new THREE.BoxGeometry(1, 1, 1);

/* ------------------------------------------------------------------ teren */

function polygonGeo(ring: [number, number][], y: number) {
  const shape = new THREE.Shape();
  ring.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
  shape.closePath();
  const geo = new THREE.ShapeGeometry(shape, 1);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i);
    pos.setY(i, groundY(x, z) + y);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

/** Pole powierzchni pierścienia [m²]. */
export function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

function insideRing(ring: [number, number][], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

export function areaExtent(area: { minLat: number; maxLat: number; minLon: number; maxLon: number; origin: { lat: number; lon: number } }) {
  const mLon = 111_320 * Math.cos((area.origin.lat * Math.PI) / 180);
  return {
    halfX: ((area.maxLon - area.origin.lon) * mLon) / 2,
    halfZ: ((area.origin.lat - area.minLat) * 111_320) / 2,
  };
}

export const Terrain = memo(function Terrain({
  polygons, area, terrain, onGround, onClear,
}: {
  polygons: SimPolygon[];
  area: { minLat: number; maxLat: number; minLon: number; maxLon: number; origin: { lat: number; lon: number } };
  terrain?: { minX: number; maxX: number; minZ: number; maxZ: number; cols: number; rows: number; heights: number[] } | null;
  onGround: (x: number, z: number) => void;
  onClear: () => void;
}) {
  const { halfX, halfZ } = useMemo(() => areaExtent(area), [area]);
  const groundMap = useMemo(() => groundTex(), []);
  const grassMap = useMemo(() => grassTex(), []);

  // Płaskie podłoże – tak wyglądała mapa przed wprowadzeniem wzniesień.
  // Siatka wysokości z DEM jest w pliku danych, ale nie unosi terenu.
  const terrainGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(halfX * 2 + 700, halfZ * 2 + 700, 1, 1);
    geo.rotateX(-Math.PI / 2);
    void terrain;
    return geo;
  }, [halfX, halfZ, terrain]);

  // Woda: przed dodaniem Wisły rysowaliśmy tylko realne poligony OSM
  // (natural=water) – koryto rzeki jako linia nie tworzyło wielokąta.
  const { waterGeos, greenGeos } = useMemo(() => {
    const w: THREE.BufferGeometry[] = [], g: THREE.BufferGeometry[] = [];
    for (const p of polygons) {
      if (p.ring.length < 3) continue;
      if (p.kind === 'water' && ringArea(p.ring) < 5000) continue;
      try {
        const geo = polygonGeo(p.ring, p.kind === 'water' ? 0.1 : 0.25);
        (p.kind === 'water' ? w : g).push(geo);
      } catch { /* pomijamy uszkodzony pierścień */ }
    }
    return { waterGeos: w, greenGeos: g };
  }, [polygons]);

  useLayoutEffect(() => () => {
    for (const geo of waterGeos) geo.dispose();
    for (const geo of greenGeos) geo.dispose();
  }, [waterGeos, greenGeos]);

  return (
    <group>
      <mesh
        geometry={terrainGeo}
        position={[0, 0.02, 0]}
        receiveShadow
        onClick={(e: ThreeEvent<MouseEvent>) => {
          if (e.delta > 4) return;
          onGround(e.point.x, e.point.z);
        }}
      >
        <meshStandardMaterial map={groundMap} color="#d8cfb8" roughness={1} />
      </mesh>
      {greenGeos.map((geo, i) => (
        <mesh key={`g${i}`} geometry={geo} receiveShadow>
          <meshStandardMaterial map={grassMap} color="#8fbf6a" roughness={1} />
        </mesh>
      ))}
      {waterGeos.map((geo, i) => (
        <mesh key={`w${i}`} geometry={geo}>
          <meshStandardMaterial color="#2f6f92" roughness={0.12} metalness={0.45} transparent opacity={0.94} />
        </mesh>
      ))}
    </group>
  );
});

/* ----------------------------------------------------------------- drogi */

export type TrafficView = 'simulated' | 'baseline' | 'predicted';

const PALETTE = {
  empty: new THREE.Color('#2b3038'),
  light: new THREE.Color('#4f9fd8'),
  mid: new THREE.Color('#f0a92e'),
  heavy: new THREE.Color('#e0453a'),
  closed: new THREE.Color('#6d2422'),
  pedestrian: new THREE.Color('#e8dcc2'),
  rail: new THREE.Color('#c3c8cf'),
  sel: new THREE.Color('#5cc8ff'),
};

export function roadWidth(r: RoadSim): number {
  const e = r.edge;
  if (e.roadClass === 'tram') return 4.6;
  if (!e.carAccess) return e.roadClass === 'pedestrian' ? 7 : e.roadClass === 'living_street' ? 6 : 2.2;
  const by: Record<string, number> = {
    motorway: 13, trunk: 12, primary: 11, secondary: 9.5, tertiary: 8.5,
    unclassified: 7, residential: 6.5, living_street: 6, service: 5, track: 4,
  };
  return by[e.roadClass] ?? 6;
}

export const RoadNetwork = memo(function RoadNetwork({
  sim, ver, sel, view, layers, onSelect,
}: {
  sim: Sim;
  ver: number;
  sel: number | null;
  view: TrafficView;
  layers: Set<string>;
  onSelect: (id: number) => void;
}) {
  const roads = sim.roads;
  const deck = useRef<THREE.InstancedMesh>(null);
  const marks = useRef<THREE.InstancedMesh>(null);
  const ballast = useRef<THREE.InstancedMesh>(null);
  const sleepers = useRef<THREE.InstancedMesh>(null);
  const railL = useRef<THREE.InstancedMesh>(null);
  const railR = useRef<THREE.InstancedMesh>(null);

  const railCount = useMemo(() => roads.filter((r) => r.edge.hasTram || r.edge.roadClass === 'tram').length, [roads, ver]);
  const sleeperCount = Math.min(9000, railCount * 7);

  const mats = useMemo(() => ({
    road: new THREE.MeshStandardMaterial({ map: asphaltTex(), roughness: 0.95, metalness: 0.02 }),
    walk: new THREE.MeshStandardMaterial({ map: pavementTex(), roughness: 0.98, metalness: 0 }),
    ballast: new THREE.MeshStandardMaterial({ color: '#8d8578', roughness: 1 }),
    sleeper: new THREE.MeshStandardMaterial({ color: '#4a4238', roughness: 0.95 }),
    steel: new THREE.MeshStandardMaterial({ color: '#b9bec4', roughness: 0.22, metalness: 0.85 }),
    railBed: new THREE.MeshStandardMaterial({ map: pavementTex(), color: '#cfd3d8', roughness: 0.9 }),
  }), []);

  useLayoutEffect(() => {
    const m = deck.current, mk = marks.current;
    if (!m || !mk) return;
    const bl = ballast.current, sl = sleepers.current, rL = railL.current, rR = railR.current;
    let rail = 0, sleeper = 0;
    roads.forEach((r, i) => {
      const e = r.edge;
      const w = roadWidth(r);
      const cx = (e.ax + e.bx) / 2, cz = (e.az + e.bz) / 2;
      const ya = groundY(e.ax, e.az), yb = groundY(e.bx, e.bz);
      const y = (ya + yb) / 2;
      const pitch = Math.atan2(yb - ya, e.len);
      D.position.set(cx, y + 0.24, cz);
      D.rotation.set(0, Math.atan2(-e.hz, e.hx), pitch, 'YXZ');
      D.scale.set(e.len, 0.34, w);
      D.updateMatrix();
      m.setMatrixAt(i, D.matrix);

      const center = e.carAccess && e.lanesForward >= 2;
      D.position.set(cx, y + 0.44, cz);
      D.scale.set(center ? e.len * 0.96 : 0.0001, center ? 0.07 : 0.0001, center ? 0.26 : 0.0001);
      D.updateMatrix();
      mk.setMatrixAt(i, D.matrix);

      if ((e.hasTram || e.roadClass === 'tram') && rail < railCount) {
        const isTrack = e.roadClass === 'tram';
        const gauge = 1.435;
        const rw = isTrack ? 3.4 : w * 0.52;
        if (bl) {
          D.position.set(cx, y + 0.36, cz);
          D.scale.set(e.len, 0.16, rw + (isTrack ? 0.6 : 0));
          D.updateMatrix();
          bl.setMatrixAt(rail, D.matrix);
        }
        if (sl) {
          const n = Math.min(7, Math.max(1, Math.floor(e.len / 22)));
          for (let k = 0; k < n && sleeper < sleeperCount; k++) {
            const t = (k + 0.5) / n;
            const sx = e.ax + e.hx * e.len * t, sz = e.az + e.hz * e.len * t;
            D.position.set(sx, groundY(sx, sz) + 0.42, sz);
            D.scale.set(0.5, 0.1, gauge + 0.6);
            D.updateMatrix();
            sl.setMatrixAt(sleeper++, D.matrix);
          }
        }
        const nx = -e.hz, nz = e.hx, off = gauge / 2;
        if (rL && rR) {
          D.position.set(cx + nx * off, y + 0.55, cz + nz * off);
          D.scale.set(e.len, 0.17, 0.14);
          D.updateMatrix();
          rL.setMatrixAt(rail, D.matrix);
          D.position.set(cx - nx * off, y + 0.55, cz - nz * off);
          D.updateMatrix();
          rR.setMatrixAt(rail, D.matrix);
        }
        D.position.set(cx, y + 0.5, cz);
        D.scale.set(e.len, 0.11, rw);
        D.updateMatrix();
        m === null; // nic – środek torowiska dodaje osobna bryła poniżej
        rail++;
      }
    });
    for (const mesh of [m, mk]) mesh.instanceMatrix.needsUpdate = true;
    if (bl) { bl.count = rail; bl.instanceMatrix.needsUpdate = true; }
    if (rL) { rL.count = rail; rL.instanceMatrix.needsUpdate = true; }
    if (rR) { rR.count = rail; rR.instanceMatrix.needsUpdate = true; }
    if (sl) { sl.count = sleeper; sl.instanceMatrix.needsUpdate = true; }
    m.computeBoundingSphere();
  }, [sim, ver, railCount, sleeperCount]);

  const paint = () => {
    const m = deck.current, mk = marks.current;
    if (!m || !mk) return;
    roads.forEach((r, i) => {
      let level = r.level;
      if (view === 'baseline') level = r.baseline;
      else if (view === 'predicted') level = r.predicted;
      const k = Math.max(0, Math.min(1, level));
      let t: THREE.Color;
      if (r.destroyed || r.closure === 'closed') t = PALETTE.closed;
      else if (!r.edge.carAccess) t = PALETTE.pedestrian;
      else if (r.edge.roadClass === 'tram') t = PALETTE.rail;
      else if (k < 0.4) t = C.lerpColors(PALETTE.empty, PALETTE.light, k / 0.4);
      else if (k < 0.7) t = C.lerpColors(PALETTE.light, PALETTE.mid, (k - 0.4) / 0.3);
      else t = C.lerpColors(PALETTE.mid, PALETTE.heavy, (k - 0.7) / 0.3);
      if (sel === i) t = C.lerpColors(t, PALETTE.sel, 0.6);
      if (!layers.has('traffic') && r.edge.carAccess) t = C.lerpColors(PALETTE.empty, t, 0.25);
      m.setColorAt(i, t);
      const center = r.edge.carAccess && r.edge.lanesForward >= 2 && level > 0.35;
      mk.setColorAt(i, center ? PALETTE.mid : C.set('#000000'));
    });
    m.instanceColor!.needsUpdate = true;
    mk.instanceColor!.needsUpdate = true;
  };

  const acc = useRef(0);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current > 0.35) { acc.current = 0; paint(); }
  });
  useLayoutEffect(paint, [sel, ver, view, roads, layers]);

  if (!layers.has('roads')) return null;

  return (
    <group>
      <instancedMesh
        ref={deck}
        args={[boxGeo, mats.road, Math.max(1, roads.length)]}
        receiveShadow
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.delta > 4 || e.instanceId == null) return;
          onSelect(e.instanceId);
        }}
      />
      <instancedMesh ref={marks} args={[boxGeo, mats.walk, Math.max(1, roads.length)]} frustumCulled={false} />
      <instancedMesh ref={ballast} args={[boxGeo, mats.ballast, Math.max(1, railCount + 8)]} frustumCulled={false} />
      <instancedMesh ref={sleepers} args={[boxGeo, mats.sleeper, Math.max(1, sleeperCount)]} frustumCulled={false} />
      <instancedMesh ref={railL} args={[boxGeo, mats.steel, Math.max(1, railCount + 8)]} frustumCulled={false} />
      <instancedMesh ref={railR} args={[boxGeo, mats.steel, Math.max(1, railCount + 8)]} frustumCulled={false} />
    </group>
  );
});

/* ------------------------------------------------------------- budynki */

/**
 * Bryły z PRAWDZIWYCH obrysów OSM, scalone w jeden bufor (jeden draw call
 * dla tysięcy budynków). Elewacje mają UV liczone z obwodu i wysokości, więc
 * okna powtarzają się jak rzędki kondygnacji.
 */
export function buildingMass(buildings: { x: number; z: number; w: number; d: number; h: number; color: string; roof: string; landmark: boolean; ring?: [number, number][] }[], hidden: Set<number>) {
  const walls: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  buildings.forEach((b, idx) => {
    if (hidden.has(idx)) return;
    const ring: [number, number][] = b.ring && b.ring.length >= 3 ? b.ring : [
      [b.x - b.w / 2, b.z - b.d / 2], [b.x + b.w / 2, b.z - b.d / 2],
      [b.x + b.w / 2, b.z + b.d / 2], [b.x - b.w / 2, b.z + b.d / 2],
    ];
    const shape = new THREE.Shape();
    ring.forEach(([x, z], i) => (i === 0 ? shape.moveTo(x, -z) : shape.lineTo(x, -z)));
    shape.closePath();
    const gy = groundY(b.x, b.z);
    let geo: THREE.BufferGeometry;
    try {
      geo = new THREE.ExtrudeGeometry(shape, { depth: b.h, bevelEnabled: false, curveSegments: 1, steps: 1 });
    } catch { return; }
    // ExtrudeGeometry wyciąga w +Z – obracamy, żeby wysokość szła w górę.
    geo.rotateX(-Math.PI / 2);
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + gy);
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2));
    const uv = geo.attributes.uv as THREE.BufferAttribute;
    const perim = ring.reduce((a, [x, z], i) => {
      const [nx, nz] = ring[(i + 1) % ring.length];
      return a + Math.hypot(nx - x, nz - z);
    }, 0);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      uv.setXY(i, (Math.atan2(-z, x) * perim) / (2 * Math.PI) / 3.4, y / 3.3);
    }
    const col = new THREE.Color(b.landmark ? '#e6d3b4' : b.color);
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { cols[i * 3] = col.r; cols[i * 3 + 1] = col.g; cols[i * 3 + 2] = col.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    walls.push(geo);

    const rh = b.landmark || b.h * 0.28 > 6 ? Math.max(1.2, b.h * 0.28) : Math.max(0.5, b.h * 0.12);
    const roofShape = new THREE.Shape();
    ring.forEach(([x, z], i) => (i === 0 ? roofShape.moveTo(x, -z) : roofShape.lineTo(x, -z)));
    roofShape.closePath();
    const roof = new THREE.ExtrudeGeometry(roofShape, { depth: rh, bevelEnabled: false, curveSegments: 1, steps: 1 });
    roof.rotateX(-Math.PI / 2);
    roof.translate(0, b.h + gy, 0);
    roof.computeVertexNormals();
    const rc = new THREE.Color(b.roof);
    const rp = roof.attributes.position as THREE.BufferAttribute;
    const rcols = new Float32Array(rp.count * 3);
    for (let i = 0; i < rp.count; i++) { rcols[i * 3] = rc.r; rcols[i * 3 + 1] = rc.g; rcols[i * 3 + 2] = rc.b; }
    roof.setAttribute('color', new THREE.BufferAttribute(rcols, 3));
    roofs.push(roof);
  });
  return {
    walls: walls.length ? mergeGeometries(walls, false) ?? new THREE.BufferGeometry() : new THREE.BufferGeometry(),
    roofs: roofs.length ? mergeGeometries(roofs, false) ?? new THREE.BufferGeometry() : new THREE.BufferGeometry(),
  };
}

export const Buildings = memo(function Buildings({
  buildings, hiddenKey, ver, onSelect,
}: {
  buildings: Parameters<typeof buildingMass>[0];
  hiddenKey: string;
  ver: number;
  onSelect: (i: number) => void;
}) {
  const w = useRef<THREE.Mesh>(null);
  const r = useRef<THREE.Mesh>(null);
  const hidden = useMemo(() => new Set<number>(), [hiddenKey]);
  const mass = useMemo(() => buildingMass(buildings, hidden), [buildings, hiddenKey]);
  const facade = useMemo(() => facadeTexture(), []);
  const wallMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, map: facade, roughness: 0.86 }), [facade]);
  const roofMat = useMemo(() => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }), []);

  useLayoutEffect(() => {
    const m = w.current, rr = r.current;
    if (!m || !rr) return;
    m.geometry = mass.walls;
    rr.geometry = mass.roofs;
    mass.walls.computeBoundingSphere();
    mass.roofs.computeBoundingSphere();
    return () => { mass.walls.dispose(); mass.roofs.dispose(); };
  }, [mass]);

  useLayoutEffect(() => {
    const m = w.current;
    if (m) m.geometry.computeBoundingSphere();
  }, [ver]);

  const pick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 4) return;
    // najbliższy budynek do punktu trafienia
    const x = e.point.x, z = e.point.z;
    let best = -1, bd = Infinity;
    buildings.forEach((b, i) => {
      const d = Math.hypot(x - b.x, z - b.z);
      if (d < bd) { bd = d; best = i; }
    });
    if (best >= 0 && bd < Math.max(30, buildings[best].w)) onSelect(best);
  };

  return (
    <group>
      <mesh ref={w} material={wallMat} castShadow receiveShadow onClick={pick} />
      <mesh ref={r} material={roofMat} castShadow receiveShadow />
    </group>
  );
});

let facadeTex: THREE.Texture | null = null;
function facadeTexture(): THREE.Texture {
  if (facadeTex) return facadeTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = 'rgba(30,38,48,0.9)';
  g.fillRect(38, 33, 52, 62);
  g.fillStyle = 'rgba(130,160,185,0.35)';
  g.fillRect(38, 33, 52, 12);
  g.fillStyle = 'rgba(0,0,0,0.14)';
  g.fillRect(0, 0, 128, 5);
  facadeTex = new THREE.CanvasTexture(c);
  facadeTex.wrapS = facadeTex.wrapT = THREE.RepeatWrapping;
  facadeTex.colorSpace = THREE.SRGBColorSpace;
  facadeTex.anisotropy = 8;
  return facadeTex;
}

/* ------------------------------------------------------------ przystanki */

export const TransitStops = memo(function TransitStops({
  stops, ver,
}: { stops: { x: number; z: number; name: string; lines: string[] }[]; ver: number }) {
  const pole = useRef<THREE.InstancedMesh>(null);
  const flag = useRef<THREE.InstancedMesh>(null);
  useLayoutEffect(() => {
    const p = pole.current, f = flag.current;
    if (!p || !f) return;
    stops.forEach((s, i) => {
      const y = groundY(s.x, s.z);
      D.position.set(s.x, y + 1.4, s.z);
      D.rotation.set(0, 0, 0); D.scale.set(1, 1, 1); D.updateMatrix();
      p.setMatrixAt(i, D.matrix);
      D.position.set(s.x, y + 2.9, s.z); D.updateMatrix();
      f.setMatrixAt(i, D.matrix);
    });
    p.count = stops.length;
    f.count = stops.length;
    p.instanceMatrix.needsUpdate = true;
    f.instanceMatrix.needsUpdate = true;
  }, [stops, ver]);
  if (!stops.length) return null;
  return (
    <group>
      <instancedMesh ref={pole} args={[undefined, undefined, stops.length]} castShadow frustumCulled={false}>
        <cylinderGeometry args={[0.09, 0.09, 2.8, 6]} />
        <meshStandardMaterial color="#d8d4c8" roughness={0.8} />
      </instancedMesh>
      <instancedMesh ref={flag} args={[undefined, undefined, stops.length]} frustumCulled={false}>
        <boxGeometry args={[0.9, 0.6, 0.12]} />
        <meshStandardMaterial color="#f2c230" roughness={0.6} />
      </instancedMesh>
    </group>
  );
});

/* --------------------------------------------------- obiekty gracza i katastrofy */

export const PlayerParks = memo(function PlayerParks({ parks, ver }: { parks: { x: number; z: number; r: number }[]; ver: number }) {
  return (
    <group key={ver}>
      {parks.map((p, i) => (
        <mesh key={i} position={[p.x, groundY(p.x, p.z) + 0.3, p.z]} rotation-x={-Math.PI / 2} receiveShadow>
          <circleGeometry args={[p.r, 28]} />
          <meshStandardMaterial color="#5f9a4f" roughness={1} />
        </mesh>
      ))}
    </group>
  );
});

export function PlayerStructures({ sim, ver }: { sim: Sim; ver: number }) {
  return (
    <group key={ver}>
      {sim.playerBuildings.map((b) => (
        <group key={b.id}>
          <mesh position={[b.x, groundY(b.x, b.z) + b.h / 2 + 0.4, b.z]} castShadow receiveShadow>
            <boxGeometry args={[b.w, b.h, b.d]} />
            <meshStandardMaterial color={b.kind === 'mall' ? '#c8b7a0' : '#d8cdb8'} roughness={0.7} />
          </mesh>
          <mesh position={[b.x, groundY(b.x, b.z) + b.h + 1.3, b.z]} castShadow>
            <boxGeometry args={[b.w + 1.6, 1.8, b.d + 1.6]} />
            <meshStandardMaterial color={b.kind === 'mall' ? '#4a6a8a' : '#7a5f8a'} roughness={0.6} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

export function DisasterLayer({ sim, ver }: { sim: Sim; ver: number }) {
  return (
    <group key={ver}>
      {sim.disasters.map((d, i) =>
        d.roads.map((rid) => {
          const e = sim.roads[rid]?.edge;
          if (!e) return null;
          const x = (e.ax + e.bx) / 2, z = (e.az + e.bz) / 2;
          const y = groundY(x, z);
          if (d.kind === 'fire' || d.kind === 'earthquake') {
            return (
              <group key={`f${i}-${rid}`}>
                <mesh position={[x, y + 6 * d.intensity, z]}>
                  <coneGeometry args={[5 * d.intensity, 14 * d.intensity, 7]} />
                  <meshBasicMaterial color="#ff7a1a" transparent opacity={0.8} toneMapped={false} />
                </mesh>
                <mesh position={[x, y + 18 * d.intensity, z]}>
                  <coneGeometry args={[7 * d.intensity, 20 * d.intensity, 6]} />
                  <meshStandardMaterial color="#4a4a4a" transparent opacity={0.32 * d.intensity} />
                </mesh>
              </group>
            );
          }
          if (d.kind === 'flood') {
            return (
              <mesh key={`w${i}-${rid}`} position={[x, y + 0.9, z]} rotation-y={Math.atan2(-e.hz, e.hx)}>
                <boxGeometry args={[e.len, 1.2, 9]} />
                <meshStandardMaterial color="#2f6f92" transparent opacity={0.5 * d.intensity} />
              </mesh>
            );
          }
          return null;
        }),
      )}
      {sim.roads.filter((r) => r.destroyed).map((r) => {
        const e = r.edge;
        const x = (e.ax + e.bx) / 2, z = (e.az + e.bz) / 2;
        return (
          <mesh key={`d${r.edge.id}`} position={[x, groundY(x, z) + 1.6, z]} rotation-y={Math.atan2(-e.hz, e.hx)}>
            <boxGeometry args={[e.len * 0.8, 2.8, 7]} />
            <meshStandardMaterial color="#5c544a" roughness={1} />
          </mesh>
        );
      })}
    </group>
  );
}

/** Barierki na zamkniętych ulicach. */
export function Closures({ sim, ver }: { sim: Sim; ver: number }) {
  const closed = sim.roads.filter((r) => r.closed || r.closure === 'closed');
  return (
    <group key={ver}>
      {closed.map((r) => {
        const e = r.edge;
        const yaw = Math.atan2(-e.hz, e.hx);
        return [0.3, 0.65, 0.95].map((t, k) => {
          const x = e.ax + e.hx * e.len * t, z = e.az + e.hz * e.len * t;
          return (
            <group key={k} position={[x, groundY(x, z), z]} rotation-y={yaw}>
              <mesh position={[0, 0.6, 0]}>
                <boxGeometry args={[1.8, 1.1, 0.16]} />
                <meshStandardMaterial color="#f2c230" roughness={0.7} />
              </mesh>
              <mesh position={[0, 0.09, 0]}>
                <boxGeometry args={[1.9, 0.18, 0.5]} />
                <meshStandardMaterial color="#c0392b" roughness={0.8} />
              </mesh>
            </group>
          );
        });
      })}
    </group>
  );
}

/** Drzewa wyłącznie w realnej zieleni z OSM. */
export const Trees = memo(function Trees({ polygons, ver }: { polygons: SimPolygon[]; ver: number }) {
  const crown = useRef<THREE.InstancedMesh>(null);
  const trunk = useRef<THREE.InstancedMesh>(null);
  const spots = useMemo(() => {
    const rnd = () => Math.random();
    const trees: { x: number; z: number; s: number }[] = [];
    const bushes: { x: number; z: number; s: number }[] = [];
    for (const p of polygons) {
      if (p.kind !== 'green' || p.ring.length < 3) continue;
      const area = ringArea(p.ring);
      const nTree = Math.min(200, Math.round(area / 500));
      const nBush = Math.min(300, Math.round(area / 220));
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of p.ring) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      for (let i = 0; i < nTree && trees.length < 2200; i++) {
        const x = minX + rnd() * (maxX - minX), z = minZ + rnd() * (maxZ - minZ);
        if (insideRing(p.ring, x, z)) trees.push({ x, z, s: 0.75 + rnd() * 0.85 });
      }
      for (let i = 0; i < nBush && bushes.length < 2000; i++) {
        const x = minX + rnd() * (maxX - minX), z = minZ + rnd() * (maxZ - minZ);
        if (insideRing(p.ring, x, z)) bushes.push({ x, z, s: 0.6 + rnd() * 0.7 });
      }
    }
    return { trees, bushes };
  }, [polygons]);

  useLayoutEffect(() => {
    const c = crown.current, t = trunk.current;
    if (!c || !t) return;
    spots.trees.forEach((s, i) => {
      const y = groundY(s.x, s.z);
      D.position.set(s.x, y + 2.9 * s.s, s.z);
      D.rotation.set(0, (i % 7) * 0.9, 0);
      D.scale.set(s.s * 1.15, s.s, s.s * 1.15);
      D.updateMatrix();
      c.setMatrixAt(i, D.matrix);
      D.position.set(s.x, y + 1.35 * s.s, s.z);
      D.scale.set(s.s, s.s, s.s);
      D.updateMatrix();
      t.setMatrixAt(i, D.matrix);
    });
    for (const m of [c, t]) m.instanceMatrix.needsUpdate = true;
    c.count = spots.trees.length;
    t.count = spots.trees.length;
  }, [spots, ver]);

  const bark = useMemo(() => new THREE.MeshStandardMaterial({ color: '#5b4632', roughness: 1 }), []);
  return (
    <group>
      <instancedMesh ref={trunk} args={[undefined, bark, Math.max(1, spots.trees.length)]} castShadow frustumCulled={false}>
        <cylinderGeometry args={[0.16, 0.24, 2.8, 6]} />
      </instancedMesh>
      <instancedMesh ref={crown} args={[undefined, undefined, Math.max(1, spots.trees.length)]} castShadow frustumCulled={false}>
        <icosahedronGeometry args={[1.9, 1]} />
        <meshStandardMaterial color="#4f8c40" roughness={0.95} flatShading />
      </instancedMesh>
    </group>
  );
});

void C;