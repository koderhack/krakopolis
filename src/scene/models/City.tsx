/**
 * Warstwy statyczne miasta: teren z realnych wysokości, woda, zieleń,
 * sieć drogowa z torowiskami, budynki z prawdziwych obrysów OSM,
 * przystanki MPK oraz obiekty postawione przez gracza.
 */
import { memo, useLayoutEffect, useMemo, useRef, useState, useEffect } from 'react';
import { useFrame, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Sim, RoadSim } from '../../simulation/sim';
import type { CityData, SimPolygon } from '../../data/model';
import { toLocal } from '../../data/geo';
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

type LocalBBox = { minX: number; maxX: number; minZ: number; maxZ: number };

/** Przycięcie pierścienia do AABB (Sutherland–Hodgman) – raz przy budowie geometrii. */
function clipRingToBBox(ring: [number, number][], box: LocalBBox): [number, number][] {
  const clipEdge = (
    input: [number, number][],
    inside: (x: number, z: number) => boolean,
    intersect: (a: [number, number], b: [number, number]) => [number, number],
  ): [number, number][] => {
    if (input.length === 0) return [];
    const out: [number, number][] = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i];
      const prev = input[(i + input.length - 1) % input.length];
      const curIn = inside(cur[0], cur[1]);
      const prevIn = inside(prev[0], prev[1]);
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur));
        out.push(cur);
      } else if (prevIn) {
        out.push(intersect(prev, cur));
      }
    }
    return out;
  };

  let r = ring;
  r = clipEdge(r, (x) => x >= box.minX, (a, b) => {
    const t = (box.minX - a[0]) / ((b[0] - a[0]) || 1e-12);
    return [box.minX, a[1] + t * (b[1] - a[1])];
  });
  r = clipEdge(r, (x) => x <= box.maxX, (a, b) => {
    const t = (box.maxX - a[0]) / ((b[0] - a[0]) || 1e-12);
    return [box.maxX, a[1] + t * (b[1] - a[1])];
  });
  r = clipEdge(r, (_x, z) => z >= box.minZ, (a, b) => {
    const t = (box.minZ - a[1]) / ((b[1] - a[1]) || 1e-12);
    return [a[0] + t * (b[0] - a[0]), box.minZ];
  });
  r = clipEdge(r, (_x, z) => z <= box.maxZ, (a, b) => {
    const t = (box.maxZ - a[1]) / ((b[1] - a[1]) || 1e-12);
    return [a[0] + t * (b[0] - a[0]), box.maxZ];
  });
  return r;
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
  polygons, area, terrain, showBasemap = true, onGround, onClear,
}: {
  polygons: SimPolygon[];
  area: { minLat: number; maxLat: number; minLon: number; maxLon: number; origin: { lat: number; lon: number } };
  terrain?: { minX: number; maxX: number; minZ: number; maxZ: number; cols: number; rows: number; heights: number[] } | null;
  /** Ortofotomapa / OSM pod miastem (public/data/basemap.jpg). */
  showBasemap?: boolean;
  onGround: (x: number, z: number) => void;
  onClear: () => void;
}) {
  void onClear;
  const { halfX, halfZ } = useMemo(() => areaExtent(area), [area]);
  const groundMap = useMemo(() => groundTex(), []);
  const grassMap = useMemo(() => grassTex(), []);
  const [basemap, setBasemap] = useState<THREE.Texture | null>(null);

  // Dokładny bbox obszaru w metrach lokalnych – ten sam co MapBorder.
  const mapBounds = useMemo(() => {
    const sw = toLocal(area.minLat, area.minLon);
    const ne = toLocal(area.maxLat, area.maxLon);
    const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x);
    const minZ = Math.min(sw.z, ne.z), maxZ = Math.max(sw.z, ne.z);
    return {
      minX, maxX, minZ, maxZ,
      cx: (minX + maxX) / 2,
      cz: (minZ + maxZ) / 2,
      w: maxX - minX,
      d: maxZ - minZ,
    };
  }, [area]);

  useEffect(() => {
    let alive = true;
    let loaded: THREE.Texture | null = null;
    const loader = new THREE.TextureLoader();
    loader.load(
      '/data/basemap.jpg',
      (tex) => {
        if (!alive) { tex.dispose(); return; }
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        tex.minFilter = THREE.LinearMipmapLinearFilter;
        tex.magFilter = THREE.LinearFilter;
        tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
        loaded = tex;
        setBasemap(tex);
      },
      undefined,
      () => { /* brak pliku – zostaje proceduralne podłoże */ },
    );
    return () => {
      alive = false;
      loaded?.dispose();
      setBasemap(null);
    };
  }, []);

  // Podłoże dokładnie pod bboxem – bez „wystających” 700 m, które psuły krawędź.
  const terrainGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(mapBounds.w, mapBounds.d, 1, 1);
    geo.rotateX(-Math.PI / 2);
    void terrain;
    void halfX;
    void halfZ;
    return geo;
  }, [mapBounds.w, mapBounds.d, terrain, halfX, halfZ]);

  const basemapGeo = useMemo(() => {
    const geo = new THREE.PlaneGeometry(mapBounds.w, mapBounds.d, 1, 1);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }, [mapBounds.w, mapBounds.d]);

  // Woda/zieleń: przycinamy do bbox MapBorder, żeby nic nie wyciekało poza czerwoną granicę.
  const { waterGeos, greenGeos } = useMemo(() => {
    const box: LocalBBox = {
      minX: mapBounds.minX, maxX: mapBounds.maxX,
      minZ: mapBounds.minZ, maxZ: mapBounds.maxZ,
    };
    const w: THREE.BufferGeometry[] = [], g: THREE.BufferGeometry[] = [];
    for (const p of polygons) {
      if (p.ring.length < 3) continue;
      if (p.kind === 'water' && ringArea(p.ring) < 5000) continue;
      const clipped = clipRingToBBox(p.ring, box);
      if (clipped.length < 3) continue;
      try {
        const geo = polygonGeo(clipped, p.kind === 'water' ? 0.1 : 0.25);
        (p.kind === 'water' ? w : g).push(geo);
      } catch { /* pomijamy uszkodzony pierścień */ }
    }
    return { waterGeos: w, greenGeos: g };
  }, [polygons, mapBounds]);

  useLayoutEffect(() => () => {
    for (const geo of waterGeos) geo.dispose();
    for (const geo of greenGeos) geo.dispose();
  }, [waterGeos, greenGeos]);

  const clickGround = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return;
    onGround(e.point.x, e.point.z);
  };

  return (
    <group>
      <mesh
        geometry={terrainGeo}
        position={[mapBounds.cx, 0.02, mapBounds.cz]}
        receiveShadow
        onClick={clickGround}
      >
        <meshStandardMaterial map={groundMap} color="#d8cfb8" roughness={1} />
      </mesh>
      {showBasemap && basemap && (
        <mesh
          geometry={basemapGeo}
          position={[mapBounds.cx, 0.05, mapBounds.cz]}
          receiveShadow
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            clickGround(e);
          }}
        >
          <meshStandardMaterial map={basemap} color="#ffffff" roughness={0.95} metalness={0} />
        </mesh>
      )}
      {greenGeos.map((geo, i) => (
        <mesh key={`g${i}`} geometry={geo} receiveShadow>
          <meshStandardMaterial
            map={grassMap}
            color="#8fbf6a"
            roughness={1}
            transparent={showBasemap && !!basemap}
            opacity={showBasemap && basemap ? 0.55 : 1}
          />
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
  empty: new THREE.Color('#5a5f68'),
  light: new THREE.Color('#4f9fd8'),
  mid: new THREE.Color('#f0a92e'),
  heavy: new THREE.Color('#e0453a'),
  closed: new THREE.Color('#6d2422'),
  pedestrian: new THREE.Color('#cfc6b4'),
  footway: new THREE.Color('#b9b3a6'),
  rail: new THREE.Color('#c3c8cf'),
  sel: new THREE.Color('#5cc8ff'),
};

export function roadWidth(r: RoadSim): number {
  const e = r.edge;
  if (e.roadClass === 'tram') return 4.6;
  if (!e.carAccess) {
    if (e.roadClass === 'pedestrian') return 6.5;
    if (e.roadClass === 'living_street') return 5.8;
    if (e.roadClass === 'footway' || e.roadClass === 'path') return 1.8;
    if (e.roadClass === 'steps') return 1.4;
    return 1.6;
  }
  const by: Record<string, number> = {
    motorway: 12, trunk: 11, primary: 10, secondary: 8.5, tertiary: 7.5,
    unclassified: 6.5, residential: 6, living_street: 5.5, service: 4.2, track: 3.5,
  };
  return by[e.roadClass] ?? 5.5;
}

export const RoadNetwork = memo(function RoadNetwork({
  sim, ver, sel, view, layers, onSelect, onDisasterPick,
}: {
  sim: Sim;
  ver: number;
  sel: number | null;
  view: TrafficView;
  layers: Set<string>;
  onSelect: (id: number) => void;
  /** Gdy ustawione – klik w drogę przekazuje dokładny punkt (katastrofa). */
  onDisasterPick?: (x: number, z: number) => void;
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
    road: new THREE.MeshStandardMaterial({ map: asphaltTex(), roughness: 0.95, metalness: 0.02, transparent: true, opacity: 1 }),
    walk: new THREE.MeshStandardMaterial({ map: pavementTex(), roughness: 0.98, metalness: 0, transparent: true, opacity: 1 }),
    ballast: new THREE.MeshStandardMaterial({ color: '#8d8578', roughness: 1 }),
    sleeper: new THREE.MeshStandardMaterial({ color: '#4a4238', roughness: 0.95 }),
    steel: new THREE.MeshStandardMaterial({ color: '#b9bec4', roughness: 0.22, metalness: 0.85 }),
    railBed: new THREE.MeshStandardMaterial({ map: pavementTex(), color: '#cfd3d8', roughness: 0.9 }),
  }), []);

  useLayoutEffect(() => {
    const onMap = layers.has('basemap');
    mats.road.opacity = onMap ? 0.78 : 1;
    mats.walk.opacity = onMap ? 0.55 : 1;
  }, [layers, mats]);

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
      const isFoot = e.roadClass === 'footway' || e.roadClass === 'path' || e.roadClass === 'steps';
      const deckH = isFoot ? 0.12 : 0.34;
      const deckY = isFoot ? 0.14 : 0.24;
      // +0.9 m: odcinki lekko na siebie zachodzą – siatka wygląda na ciągłą,
      // bez „dziur” na skrzyżowaniach przy różnym kącie sąsiadów.
      const len = e.len + (isFoot ? 0.35 : 0.9);
      D.position.set(cx, y + deckY, cz);
      D.rotation.set(0, Math.atan2(-e.hz, e.hx), pitch, 'YXZ');
      D.scale.set(len, deckH, w);
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
      else if (r.edge.roadClass === 'tram') t = PALETTE.rail;
      else if (r.edge.roadClass === 'footway' || r.edge.roadClass === 'path' || r.edge.roadClass === 'steps') t = PALETTE.footway;
      else if (!r.edge.carAccess) t = PALETTE.pedestrian;
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
          if (e.delta > 4) return;
          if (onDisasterPick) {
            onDisasterPick(e.point.x, e.point.z);
            return;
          }
          if (e.instanceId == null) return;
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
function orientedBoxRing(b: { x: number; z: number; w: number; d: number; rot?: number }): [number, number][] {
  const rot = b.rot ?? 0;
  const c = Math.cos(rot), s = Math.sin(rot);
  const hw = b.w / 2, hd = b.d / 2;
  return ([[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]] as [number, number][])
    .map(([u, v]) => [b.x + u * c - v * s, b.z + u * s + v * c]);
}

export function buildingMass(buildings: { x: number; z: number; w: number; d: number; h: number; color: string; roof: string; landmark: boolean; rot?: number; ring?: [number, number][] }[], hidden: Set<number>) {
  const walls: THREE.BufferGeometry[] = [];
  const roofs: THREE.BufferGeometry[] = [];
  buildings.forEach((b, idx) => {
    if (hidden.has(idx)) return;
    const ring: [number, number][] = b.ring && b.ring.length >= 3 ? b.ring : orientedBoxRing(b);
    if (ring.length < 3) return;
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
    // UV elewacji: odległość wzdłuż obwodu + wysokość kondygnacji (~3.3 m)
    const edgeLen: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      edgeLen.push(Math.hypot(c[0] - a[0], c[1] - a[1]));
    }
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      let bestU = 0, bestD = Infinity, acc = 0;
      for (let e = 0; e < ring.length; e++) {
        const a = ring[e], c = ring[(e + 1) % ring.length];
        const dx = c[0] - a[0], dz = c[1] - a[1];
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / l2));
        const px = a[0] + dx * t, pz = a[1] + dz * t;
        const d = Math.hypot(x - px, z - pz);
        if (d < bestD) { bestD = d; bestU = (acc + edgeLen[e] * t) / 3.4; }
        acc += edgeLen[e];
      }
      uv.setXY(i, bestU, (y - gy) / 3.3);
    }
    const col = new THREE.Color(b.landmark ? '#e8dcc4' : b.color);
    const cols = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { cols[i * 3] = col.r; cols[i * 3 + 1] = col.g; cols[i * 3 + 2] = col.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    walls.push(geo);

    // Dach: niski „czepiec” jak na mapie (nie wysoki ostrosłup)
    const rh = b.landmark ? Math.max(1.4, Math.min(4.5, b.h * 0.18)) : Math.max(0.55, Math.min(2.8, b.h * 0.1));
    const roofShape = new THREE.Shape();
    // lekko wsunięty obrys dachu – realistyczny okap
    const cx = ring.reduce((t, p) => t + p[0], 0) / ring.length;
    const cz = ring.reduce((t, p) => t + p[1], 0) / ring.length;
    const inset = ring.map(([x, z]) => {
      const dx = x - cx, dz = z - cz;
      const l = Math.hypot(dx, dz) || 1;
      const pull = Math.min(0.45, l * 0.04);
      return [x - (dx / l) * pull, z - (dz / l) * pull] as [number, number];
    });
    inset.forEach(([x, z], i) => (i === 0 ? roofShape.moveTo(x, -z) : roofShape.lineTo(x, -z)));
    roofShape.closePath();
    let roof: THREE.BufferGeometry;
    try {
      roof = new THREE.ExtrudeGeometry(roofShape, { depth: rh, bevelEnabled: false, curveSegments: 1, steps: 1 });
    } catch { return; }
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

/** 0 = dzień (światła off), 1 = głęboka noc – włącza się już o zmierzchu. */
export function nightGlow(dayFactor: number): number {
  const n = 1 - dayFactor;
  if (n < 0.18) return 0;
  return Math.min(1, (n - 0.18) / 0.42);
}

function hash01(a: number, b = 0, c = 0, d = 0): number {
  let h = (Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263)
    ^ Math.imul(c | 0, 2147483647) ^ Math.imul(d | 0, 1442695041)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h >>> 0) % 10000) / 10000;
}

export const Buildings = memo(function Buildings({
  buildings, hiddenKey, ver, onSelect, onFocus,
}: {
  buildings: Parameters<typeof buildingMass>[0];
  hiddenKey: string;
  ver: number;
  onSelect: (i: number) => void;
  onFocus?: (i: number) => void;
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

  const findNear = (x: number, z: number) => {
    let best = -1, bd = Infinity;
    buildings.forEach((b, i) => {
      const d = Math.hypot(x - b.x, z - b.z);
      if (d < bd) { bd = d; best = i; }
    });
    return best >= 0 && bd < Math.max(30, buildings[best].w) ? best : -1;
  };

  const pick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.delta > 4) return;
    const best = findNear(e.point.x, e.point.z);
    if (best >= 0) onSelect(best);
  };

  const focus = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    const best = findNear(e.point.x, e.point.z);
    if (best >= 0) onFocus?.(best);
  };

  return (
    <group>
      <mesh ref={w} material={wallMat} castShadow receiveShadow onClick={pick} onDoubleClick={focus} />
      <mesh ref={r} material={roofMat} castShadow receiveShadow onClick={pick} onDoubleClick={focus} />
    </group>
  );
});

const WINDOW_TONES = ['#ffd89a', '#ffe6b8', '#ffc978', '#fff0d0', '#e8f0ff', '#ffb86a', '#fff8e8', '#ffcc88'];
const MAX_WINDOW_LIGHTS = 16_000;

/** Nierównomierne światła okien – na prawdziwym obrysie OSM (ring), nie na AABB. */
export const WindowLights = memo(function WindowLights({
  buildings, hiddenKey, sim,
}: {
  buildings: Parameters<typeof buildingMass>[0];
  hiddenKey: string;
  sim: Sim;
}) {
  const mesh = useRef<THREE.InstancedMesh>(null);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#ffffff', transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
  }), []);
  const hidden = useMemo(() => new Set<number>(), [hiddenKey]);

  useLayoutEffect(() => {
    const m = mesh.current;
    if (!m) return;
    let n = 0;
    const col = new THREE.Color();
    buildings.forEach((b, bi) => {
      if (n >= MAX_WINDOW_LIGHTS) return;
      if (hidden.has(bi) || b.h < 5.2) return;
      const ring: [number, number][] = b.ring && b.ring.length >= 3 ? b.ring : orientedBoxRing(b);
      if (ring.length < 3) return;
      const occupancy = hash01(bi, 17);
      // Prawie wszystkie budynki mają światła; część jasniej, część ciemniej.
      if (occupancy < 0.04) return;
      const litBias = 0.48 + occupancy * 0.45;
      const floors = Math.min(22, Math.max(1, Math.floor(b.h / 2.85)));
      const gy = groundY(b.x, b.z);
      let cx = 0, cz = 0;
      for (const p of ring) { cx += p[0]; cz += p[1]; }
      cx /= ring.length;
      cz /= ring.length;

      for (let ei = 0; ei < ring.length && n < MAX_WINDOW_LIGHTS; ei++) {
        const a = ring[ei];
        const c = ring[(ei + 1) % ring.length];
        const dx = c[0] - a[0], dz = c[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < 2.2) continue;
        // Normalna na zewnątrz (od środka budynku).
        let nx = -dz / len, nz = dx / len;
        const mx = (a[0] + c[0]) * 0.5, mz = (a[1] + c[1]) * 0.5;
        if (nx * (mx - cx) + nz * (mz - cz) < 0) { nx = -nx; nz = -nz; }
        const nWin = Math.max(1, Math.min(12, Math.floor(len / 2.35)));
        const yaw = Math.atan2(-nz, nx);

        for (let fl = 0; fl < floors && n < MAX_WINDOW_LIGHTS; fl++) {
          if (hash01(bi, fl, ei + 91) < 0.08) continue;
          const y = gy + 1.35 + fl * 2.85;
          if (y > gy + b.h - 0.85) continue;
          for (let wi = 0; wi < nWin && n < MAX_WINDOW_LIGHTS; wi++) {
            if (hash01(bi, fl, ei * 17 + wi, 3) > litBias) continue;
            const t = (wi + 0.5) / nWin;
            // Lekko na powierzchni elewacji (nie „w powietrzu” poza bryłą).
            const x = a[0] + dx * t + nx * 0.08;
            const z = a[1] + dz * t + nz * 0.08;
            D.position.set(x, y, z);
            D.rotation.set(0, yaw, 0);
            D.scale.set(Math.min(1.55, len / nWin * 0.72), 1.55, 0.1);
            D.updateMatrix();
            m.setMatrixAt(n, D.matrix);
            m.setColorAt(n, col.set(WINDOW_TONES[(bi + fl + wi) % WINDOW_TONES.length]));
            n++;
          }
        }
      }
    });
    m.count = n;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
  }, [buildings, hidden, hiddenKey]);

  const acc = useRef(0);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.15) return;
    acc.current = 0;
    const g = nightGlow(sim.dayFactor());
    mat.opacity = g * 1;
    mat.visible = g > 0.02;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, mat, MAX_WINDOW_LIGHTS]} frustumCulled={false}>
      <boxGeometry args={[1, 1, 1]} />
    </instancedMesh>
  );
});

/** Lampy uliczne wzdłuż dłuższych odcinków – emissive meshes (bez PointLight per lampa). */
export const StreetLamps = memo(function StreetLamps({ sim, ver }: { sim: Sim; ver: number }) {
  const poles = useRef<THREE.InstancedMesh>(null);
  const bulbs = useRef<THREE.InstancedMesh>(null);
  const halos = useRef<THREE.InstancedMesh>(null);
  const bulbMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#ffe6b8', transparent: true, opacity: 0, toneMapped: false, depthWrite: false,
  }), []);
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({
    color: '#ffc878', transparent: true, opacity: 0, toneMapped: false, depthWrite: false,
  }), []);
  const poleMat = useMemo(() => new THREE.MeshStandardMaterial({
    color: '#2a2e34', roughness: 0.85, transparent: true, opacity: 1,
  }), []);

  const spots = useMemo(() => {
    const out: { x: number; z: number }[] = [];
    const MAX = 4800;
    const SPACING = 26;
    for (const r of sim.roads) {
      if (out.length >= MAX) break;
      const e = r.edge;
      if (!e.carAccess || e.len < 28) continue;
      if (e.roadClass === 'track') continue;
      const w = roadWidth(r);
      const n = Math.max(1, Math.floor(e.len / SPACING));
      for (let i = 1; i <= n && out.length < MAX; i++) {
        const t = i / (n + 1);
        const x = e.ax + (e.bx - e.ax) * t;
        const z = e.az + (e.bz - e.az) * t;
        const side = i % 2 === 0 ? 1 : -1;
        const off = w * 0.5 + 1.05;
        out.push({ x: x - e.hz * off * side, z: z + e.hx * off * side });
      }
    }
    return out;
  }, [sim.roads, ver]);

  useLayoutEffect(() => {
    const p = poles.current, b = bulbs.current, h = halos.current;
    if (!p || !b || !h) return;
    spots.forEach((s, i) => {
      const gy = groundY(s.x, s.z);
      D.position.set(s.x, gy + 2.7, s.z);
      D.rotation.set(0, 0, 0);
      D.scale.set(1, 1, 1);
      D.updateMatrix();
      p.setMatrixAt(i, D.matrix);
      D.position.set(s.x, gy + 5.45, s.z);
      D.scale.set(1, 1, 1);
      D.updateMatrix();
      b.setMatrixAt(i, D.matrix);
      D.position.set(s.x, gy + 5.2, s.z);
      D.scale.set(1, 1, 1);
      D.updateMatrix();
      h.setMatrixAt(i, D.matrix);
    });
    p.count = spots.length;
    b.count = spots.length;
    h.count = spots.length;
    p.instanceMatrix.needsUpdate = true;
    b.instanceMatrix.needsUpdate = true;
    h.instanceMatrix.needsUpdate = true;
  }, [spots]);

  const acc = useRef(0);
  useFrame((_, dt) => {
    acc.current += dt;
    if (acc.current < 0.15) return;
    acc.current = 0;
    const g = nightGlow(sim.dayFactor());
    bulbMat.opacity = g * 1;
    haloMat.opacity = g * 0.28;
    bulbMat.visible = haloMat.visible = g > 0.02;
    poleMat.opacity = 0.35 + g * 0.65;
  });

  if (!spots.length) return null;
  return (
    <group>
      <instancedMesh ref={poles} args={[undefined, poleMat, spots.length]} frustumCulled={false}>
        <cylinderGeometry args={[0.07, 0.1, 5.4, 5]} />
      </instancedMesh>
      <instancedMesh ref={bulbs} args={[undefined, bulbMat, spots.length]} frustumCulled={false}>
        <sphereGeometry args={[0.42, 6, 4]} />
      </instancedMesh>
      <instancedMesh ref={halos} args={[undefined, haloMat, spots.length]} frustumCulled={false}>
        <sphereGeometry args={[2.4, 8, 6]} />
      </instancedMesh>
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

export const PlayerParks = memo(function PlayerParks({ parks, ver }: { parks: { x: number; z: number; r: number; d?: number; shape?: 'circle' | 'rect' }[]; ver: number }) {
  return (
    <group key={ver}>
      {parks.map((p, i) => {
        const y = groundY(p.x, p.z) + 0.3;
        if (p.shape === 'rect') {
          return (
            <mesh key={i} position={[p.x, y, p.z]} rotation-x={-Math.PI / 2} receiveShadow>
              <planeGeometry args={[(p.r ?? 26) * 2, (p.d ?? p.r ?? 18) * 2]} />
              <meshStandardMaterial color="#5f9a4f" roughness={1} />
            </mesh>
          );
        }
        return (
          <mesh key={i} position={[p.x, y, p.z]} rotation-x={-Math.PI / 2} receiveShadow>
            <circleGeometry args={[p.r, 28]} />
            <meshStandardMaterial color="#5f9a4f" roughness={1} />
          </mesh>
        );
      })}
    </group>
  );
});

export function PlayerStructures({
  sim, ver, sel, onSelect, onFocus,
}: {
  sim: Sim;
  ver: number;
  sel?: number | null;
  onSelect?: (id: number) => void;
  onFocus?: (id: number) => void;
}) {
  return (
    <group key={ver}>
      {sim.playerBuildings.map((b) => {
        const flat = b.kind === 'park' || b.kind === 'parking';
        const rot = b.rot ?? 0;
        const selected = sel === b.id;
        return (
          <group
            key={b.id}
            onClick={(e) => { e.stopPropagation(); if (e.delta > 4) return; onSelect?.(b.id); }}
            onDoubleClick={(e) => { e.stopPropagation(); onFocus?.(b.id); }}
          >
            <mesh
              position={[b.x, groundY(b.x, b.z) + (flat ? 0.35 : b.h / 2 + 0.4), b.z]}
              rotation-y={rot}
              castShadow receiveShadow
            >
              <boxGeometry args={[b.w, flat ? 0.5 : b.h, b.d]} />
              <meshStandardMaterial color={selected ? '#7ec8ff' : b.color} roughness={0.7} />
            </mesh>
            {!flat && (
              <mesh position={[b.x, groundY(b.x, b.z) + b.h + 1.0, b.z]} rotation-y={rot} castShadow>
                <boxGeometry args={[b.w + 1.2, Math.min(2.2, b.h * 0.12), b.d + 1.2]} />
                <meshStandardMaterial color={b.roof} roughness={0.6} />
              </mesh>
            )}
            {b.kind === 'school' && (
              <mesh position={[b.x, groundY(b.x, b.z) + b.h + 3.2, b.z]}>
                <boxGeometry args={[2.2, 2.2, 0.3]} />
                <meshStandardMaterial color="#f2c230" />
              </mesh>
            )}
            {b.kind === 'hospital' && (
              <mesh position={[b.x, groundY(b.x, b.z) + b.h + 3.5, b.z]}>
                <boxGeometry args={[3.5, 1.2, 0.35]} />
                <meshStandardMaterial color="#e8eef4" emissive="#ffffff" emissiveIntensity={0.15} />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}

export function DisasterLayer({ sim, ver }: { sim: Sim; ver: number }) {
  return (
    <group key={ver}>
      {/* ŹRÓDŁO = dokładny punkt kliknięcia (cx, cz) */}
      {sim.disasters.map((d) => {
        const y = groundY(d.cx, d.cz);
        if (d.kind === 'fire') {
          return (
            <group key={`src-fire-${d.id}`}>
              <FireFx x={d.cx} y={y} z={d.cz} intensity={d.intensity} />
              <mesh position={[d.cx, y + 0.35, d.cz]} rotation-x={-Math.PI / 2}>
                <ringGeometry args={[4.5, 6.2, 28]} />
                <meshBasicMaterial color="#ff5a20" transparent opacity={0.75} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
              </mesh>
            </group>
          );
        }
        if (d.kind === 'flood' || d.kind === 'rain') {
          const waterH = 0.5 + 3.2 * d.intensity;
          const r = 18 + 40 * d.intensity;
          return (
            <group key={`src-flood-${d.id}`}>
              <mesh position={[d.cx, y + waterH * 0.4, d.cz]}>
                <cylinderGeometry args={[r, r * 1.05, waterH, 28]} />
                <meshStandardMaterial
                  color={d.kind === 'rain' ? '#3a7a9a' : '#2a6a8e'}
                  transparent
                  opacity={0.4 + 0.35 * d.intensity}
                  roughness={0.12}
                  metalness={0.4}
                  depthWrite={false}
                />
              </mesh>
              <mesh position={[d.cx, y + 0.3, d.cz]} rotation-x={-Math.PI / 2}>
                <ringGeometry args={[5, 7, 28]} />
                <meshBasicMaterial color="#5cc8ff" transparent opacity={0.7} toneMapped={false} side={THREE.DoubleSide} depthWrite={false} />
              </mesh>
            </group>
          );
        }
        if (d.kind === 'earthquake') {
          return (
            <mesh key={`src-eq-${d.id}`} position={[d.cx, y + 4 * d.intensity, d.cz]}>
              <coneGeometry args={[5 * d.intensity, 12 * d.intensity, 6]} />
              <meshBasicMaterial color="#ff7a1a" transparent opacity={0.75} toneMapped={false} />
            </mesh>
          );
        }
        if (d.kind === 'heat' || d.kind === 'blackout') {
          return (
            <mesh key={`src-h-${d.id}`} position={[d.cx, y + 0.5, d.cz]} rotation-x={-Math.PI / 2}>
              <circleGeometry args={[22 + 30 * d.intensity, 32]} />
              <meshBasicMaterial
                color={d.kind === 'heat' ? '#e08040' : '#606878'}
                transparent
                opacity={0.28 * d.intensity}
                toneMapped={false}
                depthWrite={false}
              />
            </mesh>
          );
        }
        return null;
      })}
      {/* Skutki uboczne na drogach – słabsze, wokół źródła */}
      {sim.disasters.map((d) =>
        d.roads.map((rid) => {
          const e = sim.roads[rid]?.edge;
          if (!e) return null;
          const x = (e.ax + e.bx) / 2, z = (e.az + e.bz) / 2;
          const y = groundY(x, z);
          if (d.kind === 'fire') {
            return <FireFx key={`f${d.id}-${rid}`} x={x} y={y} z={z} intensity={d.intensity * 0.55} />;
          }
          if (d.kind === 'flood' || d.kind === 'rain') {
            const waterH = 0.35 + 2.2 * d.intensity;
            return (
              <mesh key={`w${d.id}-${rid}`} position={[x, y + waterH * 0.45, z]} rotation-y={Math.atan2(-e.hz, e.hx)}>
                <boxGeometry args={[e.len * 0.98, waterH, 10 + 3 * d.intensity]} />
                <meshStandardMaterial
                  color={d.kind === 'rain' ? '#3a7a9a' : '#2a6a8e'}
                  transparent
                  opacity={0.3 + 0.3 * d.intensity}
                  roughness={0.15}
                  metalness={0.35}
                  depthWrite={false}
                />
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

/** Lekka animacja pożaru: poziom z intensywności (LOW→CRITICAL). */
function FireFx({ x, y, z, intensity }: { x: number; y: number; z: number; intensity: number }) {
  const g = useRef<THREE.Group>(null);
  useFrame((_, dt) => {
    const t = performance.now() * 0.001;
    const root = g.current;
    if (!root) return;
    root.children.forEach((ch, i) => {
      const mesh = ch as THREE.Mesh;
      const wobble = 1 + Math.sin(t * (3.2 + i * 0.7) + i) * 0.12;
      mesh.scale.setScalar(wobble);
      mesh.position.y = (i < 3 ? 4 + i * 3.5 : 12 + (i - 3) * 5) * intensity + Math.sin(t * 2 + i) * 0.4;
      mesh.rotation.y += dt * (0.4 + i * 0.15);
    });
  });
  const s = Math.max(0.2, intensity);
  const glow = intensity >= 0.85 ? 1.15 : intensity >= 0.6 ? 1 : intensity >= 0.35 ? 0.85 : 0.65;
  return (
    <group ref={g} position={[x, y, z]}>
      <mesh position={[0, 5 * s, 0]}>
        <coneGeometry args={[3.2 * s * glow, 9 * s * glow, 6]} />
        <meshBasicMaterial color="#ff9a2a" transparent opacity={0.92} toneMapped={false} />
      </mesh>
      <mesh position={[1.2 * s, 8 * s, -0.6 * s]}>
        <coneGeometry args={[2.4 * s, 8 * s, 5]} />
        <meshBasicMaterial color="#ff5a14" transparent opacity={0.78} toneMapped={false} />
      </mesh>
      <mesh position={[-1.1 * s, 7 * s, 0.8 * s]}>
        <coneGeometry args={[2.1 * s, 7 * s, 5]} />
        <meshBasicMaterial color="#ffd060" transparent opacity={0.7} toneMapped={false} />
      </mesh>
      {intensity >= 0.35 && (
        <mesh position={[0.4 * s, 14 * s, 0.2 * s]}>
          <coneGeometry args={[4.5 * s, 12 * s, 6]} />
          <meshStandardMaterial color="#5a5a5a" transparent opacity={0.28 * s} depthWrite={false} />
        </mesh>
      )}
      {intensity >= 0.6 && (
        <mesh position={[-0.6 * s, 19 * s, -0.4 * s]}>
          <coneGeometry args={[5.5 * s, 14 * s, 6]} />
          <meshStandardMaterial color="#3a3a3a" transparent opacity={0.22 * s} depthWrite={false} />
        </mesh>
      )}
      {intensity >= 0.85 && (
        <pointLight color="#ff6a20" intensity={2.2 * s} distance={48} decay={2} position={[0, 6 * s, 0]} />
      )}
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

/** Drzewa i krzewy wyłącznie w realnej zieleni z OSM (parki, Planty, skwery). */
export const Trees = memo(function Trees({
  polygons, area, ver,
}: {
  polygons: SimPolygon[];
  area: { minLat: number; maxLat: number; minLon: number; maxLon: number; origin: { lat: number; lon: number } };
  ver: number;
}) {
  const crown = useRef<THREE.InstancedMesh>(null);
  const trunk = useRef<THREE.InstancedMesh>(null);
  const bush = useRef<THREE.InstancedMesh>(null);
  const spots = useMemo(() => {
    // Deterministyczny RNG – drzewa nie „skaczą” przy odświeżeniu warstwy.
    let seed = 0xC0FFEE;
    const rnd = () => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x45d9f3b) + 1) >>> 0;
      return (seed & 0xffff) / 0x10000;
    };
    const sw = toLocal(area.minLat, area.minLon);
    const ne = toLocal(area.maxLat, area.maxLon);
    const box: LocalBBox = {
      minX: Math.min(sw.x, ne.x), maxX: Math.max(sw.x, ne.x),
      minZ: Math.min(sw.z, ne.z), maxZ: Math.max(sw.z, ne.z),
    };
    const inBox = (x: number, z: number) =>
      x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ;
    const trees: { x: number; z: number; s: number }[] = [];
    const bushes: { x: number; z: number; s: number }[] = [];
    for (const p of polygons) {
      if (p.kind !== 'green' || p.ring.length < 3) continue;
      const clipped = clipRingToBBox(p.ring, box);
      if (clipped.length < 3) continue;
      const areaM2 = ringArea(clipped);
      if (areaM2 < 40) continue;
      // gęstość obniżona pod płynność: ~1 drzewo / 320 m²
      const nTree = Math.min(120, Math.max(1, Math.round(areaM2 / 320)));
      const nBush = Math.min(80, Math.round(areaM2 / 280));
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (const [x, z] of clipped) {
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      let placed = 0, tries = 0;
      while (placed < nTree && trees.length < 1800 && tries < nTree * 6) {
        tries++;
        const x = minX + rnd() * (maxX - minX), z = minZ + rnd() * (maxZ - minZ);
        if (!inBox(x, z) || !insideRing(clipped, x, z)) continue;
        trees.push({ x, z, s: 0.7 + rnd() * 1.0 });
        placed++;
      }
      placed = 0; tries = 0;
      while (placed < nBush && bushes.length < 1000 && tries < nBush * 6) {
        tries++;
        const x = minX + rnd() * (maxX - minX), z = minZ + rnd() * (maxZ - minZ);
        if (!inBox(x, z) || !insideRing(clipped, x, z)) continue;
        bushes.push({ x, z, s: 0.5 + rnd() * 0.75 });
        placed++;
      }
    }
    return { trees, bushes };
  }, [polygons, area]);

  useLayoutEffect(() => {
    const c = crown.current, t = trunk.current, b = bush.current;
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
    c.count = spots.trees.length;
    t.count = spots.trees.length;
    c.instanceMatrix.needsUpdate = true;
    t.instanceMatrix.needsUpdate = true;
    if (b) {
      spots.bushes.forEach((s, i) => {
        const y = groundY(s.x, s.z);
        D.position.set(s.x, y + 0.55 * s.s, s.z);
        D.rotation.set(0, (i % 5) * 1.1, 0);
        D.scale.set(s.s * 1.3, s.s * 0.85, s.s * 1.3);
        D.updateMatrix();
        b.setMatrixAt(i, D.matrix);
      });
      b.count = spots.bushes.length;
      b.instanceMatrix.needsUpdate = true;
    }
  }, [spots, ver]);

  const bark = useMemo(() => new THREE.MeshStandardMaterial({ color: '#5b4632', roughness: 1 }), []);
  const leaf = useMemo(() => new THREE.MeshStandardMaterial({ color: '#4f8c40', roughness: 0.95, flatShading: true }), []);
  const scrub = useMemo(() => new THREE.MeshStandardMaterial({ color: '#5a9a48', roughness: 0.98, flatShading: true }), []);

  return (
    <group>
      <instancedMesh ref={trunk} args={[undefined, bark, Math.max(1, spots.trees.length)]} frustumCulled>
        <cylinderGeometry args={[0.16, 0.24, 2.8, 5]} />
      </instancedMesh>
      <instancedMesh ref={crown} args={[undefined, leaf, Math.max(1, spots.trees.length)]} frustumCulled>
        <icosahedronGeometry args={[1.9, 0]} />
      </instancedMesh>
      <instancedMesh ref={bush} args={[undefined, scrub, Math.max(1, spots.bushes.length)]} frustumCulled>
        <icosahedronGeometry args={[0.85, 0]} />
      </instancedMesh>
    </group>
  );
});

/** Czerwony mur granicy obszaru – poza nim pustka (mapa się nie psuje). */
export const MapBorder = memo(function MapBorder({
  area,
}: {
  area: { minLat: number; maxLat: number; minLon: number; maxLon: number; origin: { lat: number; lon: number } };
}) {
  const b = useMemo(() => {
    const sw = toLocal(area.minLat, area.minLon);
    const ne = toLocal(area.maxLat, area.maxLon);
    const minX = Math.min(sw.x, ne.x), maxX = Math.max(sw.x, ne.x);
    const minZ = Math.min(sw.z, ne.z), maxZ = Math.max(sw.z, ne.z);
    return { minX, maxX, minZ, maxZ, cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, w: maxX - minX, d: maxZ - minZ };
  }, [area]);

  const wallH = 32;
  const thick = 5;
  const mat = useMemo(() => new THREE.MeshStandardMaterial({
    color: '#c62828',
    emissive: '#7a1010',
    emissiveIntensity: 0.22,
    roughness: 0.85,
    metalness: 0.05,
    transparent: true,
    opacity: 0.88,
  }), []);
  const voidMat = useMemo(() => new THREE.MeshBasicMaterial({ color: '#06080c' }), []);

  // Ściany na krawędzi + czarne „void” poza mapą (4 płaskie pasy).
  const voidPad = 2200;
  return (
    <group>
      {/* N / S / E / W – czerwony mur */}
      <mesh position={[b.cx, wallH / 2, b.minZ]} material={mat}>
        <boxGeometry args={[b.w + thick, wallH, thick]} />
      </mesh>
      <mesh position={[b.cx, wallH / 2, b.maxZ]} material={mat}>
        <boxGeometry args={[b.w + thick, wallH, thick]} />
      </mesh>
      <mesh position={[b.minX, wallH / 2, b.cz]} material={mat}>
        <boxGeometry args={[thick, wallH, b.d + thick]} />
      </mesh>
      <mesh position={[b.maxX, wallH / 2, b.cz]} material={mat}>
        <boxGeometry args={[thick, wallH, b.d + thick]} />
      </mesh>
      {/* Poza granicą – czarna pustka */}
      <mesh position={[b.cx, -0.5, b.minZ - voidPad / 2]} material={voidMat} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[b.w + voidPad * 2, voidPad]} />
      </mesh>
      <mesh position={[b.cx, -0.5, b.maxZ + voidPad / 2]} material={voidMat} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[b.w + voidPad * 2, voidPad]} />
      </mesh>
      <mesh position={[b.minX - voidPad / 2, -0.5, b.cz]} material={voidMat} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[voidPad, b.d]} />
      </mesh>
      <mesh position={[b.maxX + voidPad / 2, -0.5, b.cz]} material={voidMat} rotation-x={-Math.PI / 2}>
        <planeGeometry args={[voidPad, b.d]} />
      </mesh>
    </group>
  );
});

void C;