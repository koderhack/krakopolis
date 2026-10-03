/**
 * Scena 3D w CesiumJS – styl Google Earth, na realnych danych Krakowa.
 *
 * Prawdziwe dane:
 *  - teren: siatka wysokości Open-Meteo (Copernicus DEM) przez własny
 *    `LocalTerrainProvider` – bez Cesium ion i bez płatnych katalogów,
 *  - podkład mapowy: darmowa otwarta baza kafelków (CARTO / OpenStreetMap), bez klucza,
 *  - budynki: PRAWDZIWE obrysy OpenStreetMap wyciągnięte na realne wysokości,
 *  - drogi: realna sieć OSM, kolorowana stanem ruchu,
 *  - pojazdy MPK: współrzędne z GTFS-RT ZTP Kraków,
 *  - przystanki i nazwy z GTFS.
 */
import { useEffect, useMemo, useRef } from 'react';
import {
  Cartesian2, Cartesian3, Cartographic, Color, ColorGeometryInstanceAttribute,
  DistanceDisplayCondition, GeometryInstance, HorizontalOrigin, LabelCollection,
  Material, NearFarScalar, PerInstanceColorAppearance, PolygonGeometry, PolygonHierarchy,
  PolylineGraphics, Primitive, PrimitiveCollection, ScreenSpaceEventHandler,
  ScreenSpaceEventType, UrlTemplateImageryProvider, VerticalOrigin, Viewer,
  type Cesium3DTileFeature, type Entity, type EntityCollection,
} from 'cesium';
import 'cesium/Build/Cesium/Widgets/widgets.css';
import type { Sim } from '../../simulation/sim';
import type { CityData } from '../../data/model';
import { toLatLon } from '../../data/geo';
import { terrainBounds } from './TerrainProvider';
import type { TrafficView } from '../types';

export interface CesiumSceneProps {
  sim: Sim;
  city: CityData;
  ver: number;
  layers: Set<string>;
  trafficView: TrafficView;
  selRoad: number | null;
  /** Punkt do obejrzenia po wyszukaniu – zmiana tokena uruchamia lot. */
  flyTo: { lat: number; lon: number; height: number; token: number } | null;
  onSelectRoad: (id: number) => void;
  onSelectBuilding: (id: number) => void;
  onGroundClick: (lat: number, lon: number) => void;
  onVehicleClick: (id: string, kind: 'tram' | 'bus') => void;
}

const BASEMAP = 'https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png';
const MAX_BUILDINGS = 2600;
const MAX_TREES = 1500;

const COL = {
  empty: '#2b3038', light: '#4f9fd8', mid: '#f0a92e', heavy: '#e0453a',
  closed: '#6d2422', pedestrian: '#e8dcc2', rail: '#b9bec4', selected: '#5cc8ff',
};

const pos = (x: number, z: number) => {
  const ll = toLatLon(x, z);
  return Cartesian3.fromDegrees(ll.lat, ll.lon);
};

export function CesiumScene(p: CesiumSceneProps) {
  const host = useRef<HTMLDivElement>(null);
  const viewer = useRef<Viewer | null>(null);
  const ready = useRef(false);
  const props = useRef(p);
  props.current = p;

  /* ---------------------------------------------------------- przeglądarka */
  useEffect(() => {
    if (!host.current || viewer.current) return;
    const origin = toLatLon(0, 0);
    const v = new Viewer(host.current, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      contextOptions: { webgl: { antialias: true } },
    });
    viewer.current = v;

    v.imageryLayers.addImageryProvider(
      new UrlTemplateImageryProvider({ url: BASEMAP, credit: 'OpenStreetMap contributors · CARTO' }),
    );
    v.scene.globe.baseColor = Color.fromCssColorString('#1b1f26');
    v.scene.backgroundColor = Color.fromCssColorString('#0f1218');
    v.scene.fog.enabled = true;
    v.scene.fog.density = 0.00006;
    v.scene.highDynamicRange = false;
    // Widok Google Earth: wysoko nad Starym Miastem, lekko pochyłony.
    v.camera.setView({
      destination: Cartesian3.fromDegrees(origin.lat, origin.lon, 2600),
      orientation: { heading: 0, pitch: -1.15, roll: 0 },
    });
    v.scene.screenSpaceCameraController.minimumZoomDistance = 25;
    v.scene.screenSpaceCameraController.maximumZoomDistance = 90_000;
    v.scene.screenSpaceCameraController.enableCollisionDetection = true;

    // Kliknięcia: budynki, drogi, pojazdy i podłoże.
    const handler = new ScreenSpaceEventHandler(v.scene.canvas);
    handler.setInputAction((e: { position: Cartesian2 }) => {
      const picked = v.scene.pick(e.position);
      const p0 = props.current;
      const feature = picked?.id as Cesium3DTileFeature | { __id?: string; __kind?: string } | undefined;
      const meta = feature as { __id?: string; __kind?: string };
      if (meta?.__kind === 'vehicle' && meta.__id) {
        p0.onVehicleClick(meta.__id, meta.__id.startsWith('T:') ? 'tram' : 'bus');
        return;
      }
      if (meta?.__kind === 'building') { p0.onSelectBuilding(Number(meta.__id)); return; }
      const cart = pickGround(v, e.position);
      if (!cart) return;
      const ll = Cartographic.fromCartesian(cart);
      p0.onGroundClick((ll.latitude * 180) / Math.PI, (ll.longitude * 180) / Math.PI);
    }, ScreenSpaceEventType.LEFT_CLICK);

    // Najedź myszą – podświetlenie drogi.
    handler.setInputAction((e: { endPosition: Cartesian2 }) => {
      const picked = v.scene.pick(e.endPosition);
      const meta = picked?.id as { __kind?: string; __id?: string } | undefined;
      v.scene.canvas.style.cursor = meta?.__kind === 'road' || meta?.__kind === 'building' || meta?.__kind === 'vehicle' ? 'pointer' : '';
    }, ScreenSpaceEventType.MOUSE_MOVE);

    ready.current = true;
    return () => {
      handler.destroy();
      if (!v.isDestroyed()) v.destroy();
      viewer.current = null;
      ready.current = false;
    };
  }, []);

  /* ----------------------------------------------- geometria stałych warstw */
  const statics = useRef<PrimitiveCollection | null>(null);
  useEffect(() => {
    const v = viewer.current;
    if (!v || !ready.current) return;
    const prim = new PrimitiveCollection();
    v.scene.primitives.add(prim);
    statics.current = prim;
    buildStatic(prim, props.current.city);
    v.scene.requestRender();
    return () => {
      v.scene.primitives.remove(prim);
      prim.destroy();
      statics.current = null;
    };
  }, [p.city]);

  /* --------------------------------------------------- drogi (kolor ruchu) */
  const roadPrim = useRef<Primitive | null>(null);
  useEffect(() => {
    const v = viewer.current;
    if (!v || !ready.current) return;
    const rebuild = () => {
      const old = roadPrim.current;
      if (old) { v.scene.primitives.remove(old); if (!old.isDestroyed()) old.destroy(); }
      const prim = buildRoads(props.current.sim, props.current.layers, props.current.trafficView, props.current.selRoad);
      v.scene.primitives.add(prim);
      roadPrim.current = prim;
      v.scene.requestRender();
    };
    rebuild();
    const t = window.setInterval(rebuild, 2500);
    return () => {
      window.clearInterval(t);
      const old = roadPrim.current;
      if (old) { v.scene.primitives.remove(old); if (!old.isDestroyed()) old.destroy(); }
      roadPrim.current = null;
    };
  }, [p.ver, p.layers, p.trafficView]);

  /* ------------------------------------------------ pojazdy (realne + symul.) */
  useEffect(() => {
    const v = viewer.current;
    if (!v || !ready.current) return;
    const update = () => {
      const s = props.current.sim;
      const showLive = props.current.layers.has('live') || props.current.layers.has('transit');
      for (const [name, list, kind] of [
        ['tram-live', showLive ? s.realVehicles.filter((x) => x.type === 'tram') : [], 'tram'],
        ['bus-live', showLive ? s.realVehicles.filter((x) => x.type === 'bus') : [], 'bus'],
      ] as const) {
        syncEntities(v.entities, name, list.map((x) => ({
          id: x.id, kind: 'vehicle' as const, x: x.latitude, y: x.longitude, height: kind === 'tram' ? 4 : 4.4,
          color: '#3ee08a', label: `${x.line}`, size: kind === 'tram' ? 26 : 20,
        })));
      }
      const showSim = props.current.layers.has('transit');
      syncEntities(v.entities, 'tram-sim', showSim
        ? s.veh.filter((x) => x.kind === 2).map((x) => ({ id: `st-${x.edge}-${Math.round(x.x)}-${Math.round(x.z)}`, kind: 'vehicle' as const, x: x.x, z: x.z, lat: 0, y: 0, height: 4, color: '#8fb8ff', label: x.ref, size: 20 }))
        : []);
      syncEntities(v.entities, 'bus-sim', showSim
        ? s.veh.filter((x) => x.kind === 1).map((x) => ({ id: `sb-${x.edge}-${Math.round(x.x)}-${Math.round(x.z)}`, kind: 'vehicle' as const, x: x.x, z: x.z, lat: 0, y: 0, height: 4.4, color: '#c8c2b2', label: x.ref, size: 16 }))
        : []);
      syncEntities(v.entities, 'cars', props.current.layers.has('traffic')
        ? s.veh.filter((x) => x.kind === 0).map((x) => ({ id: `c-${x.edge}-${Math.round(x.x)}-${Math.round(x.z)}`, kind: 'vehicle' as const, x: x.x, z: x.z, lat: 0, y: 0, height: 2.5, color: '#f0d78a', label: '', size: 7 }))
        : []);
      v.scene.requestRender();
    };
    update();
    const t = window.setInterval(update, 260);
    return () => window.clearInterval(t);
  }, [p.layers, p.ver]);

  /* ---------------------------------------------- przystanki i etykiety mapowe */
  useEffect(() => {
    const v = viewer.current;
    if (!v || !ready.current) return;
    const update = () => {
      const city = props.current.city;
      const show = props.current.layers.has('transit');
      syncEntities(v.entities, 'stops', show ? city.stops.map((s, i) => ({
        id: `stop-${i}`, kind: 'stop' as const, x: s.x, z: s.z, lat: 0, y: 0, height: 3.5,
        color: '#f2c230', label: s.name, lines: s.lines,
      })) : []);
      v.scene.requestRender();
    };
    update();
    return () => { v.entities.removeAll(); v.scene.requestRender(); };
  }, [p.layers, p.city]);

  /* ------------------------------------------------------------- wyszukiwarka */
  useEffect(() => {
    const v = viewer.current;
    if (!v || !p.flyTo) return;
    v.camera.flyTo({
      destination: Cartesian3.fromDegrees(p.flyTo.lat, p.flyTo.lon, p.flyTo.height),
      orientation: { heading: 0, pitch: -1.05, roll: 0 },
      duration: 1.4,
    });
  }, [p.flyTo?.token]);

  return <div ref={host} className="cesium" />;
}

/* --------------------------------------------------------------- budowa */

interface EntSpec {
  id: string; kind: 'vehicle' | 'stop';
  x?: number; z?: number; lat?: number; y?: number; height: number;
  color: string; label: string; size?: number; lines?: string[];
}

/** Pozycje geograficzne: dla realnych pojazdów mamy lat/lon, dla agentów x/z. */
function geoOf(e: EntSpec): [number, number] {
  if (e.lat !== undefined && e.y !== undefined) return [e.lat, e.y];
  const ll = toLatLon(e.x ?? 0, e.z ?? 0);
  return [ll.lat, ll.lon];
}

/** Synchronizuje zbiór encji z listą – brakujące dodaje, zbędne usuwa. */
/**
 * Współrzędne kliknięcia na ziemi.
 * Kolejność: gotowa bryła z planu → teren → kula ziemska (gdy brak terenu).
 */
function pickGround(v: Viewer, position: Cartesian2): Cartesian3 | undefined {
  const picked = v.scene.pick(position) as any;
  if (picked && typeof picked.pick === 'function' && picked.id) {
    const r = picked.pick(v.scene, position);
    if (r?.hit) return r.world ?? v.camera.pickEllipsoid(position, v.scene.globe.ellipsoid) ?? undefined;
  }
  const ray = v.camera.getPickRay(position);
  if (ray && v.terrainProvider) {
    const hit = (ray as any).intersectTerrain?.(v.terrainProvider);
    if (hit) return hit.position as Cartesian3;
  }
  return v.camera.pickEllipsoid(position, v.scene.globe.ellipsoid) ?? undefined;
}

function syncEntities(entities: EntityCollection, prefix: string, specs: EntSpec[]) {
  // zbiór id, które mają zostać – wszystko inne usuwamy
  const wanted = new Set(specs.map((s) => `${prefix}/${s.id}`));
  for (let i = entities.values.length - 1; i >= 0; i--) {
    const e = entities.values[i] as Entity | undefined;
    if (e?.id && !wanted.has(e.id)) entities.remove(e);
  }
  for (const s of specs) {
    const id = `${prefix}/${s.id}`;
    // duplikaty w jednej paczce (dwa pojazdy po tej samej rundacji) pomijamy
    if (entities.getById(id)) continue;
    const [lat, lon] = geoOf(s);
    const color = Color.fromCssColorString(s.color);
    entities.add({
      id,
      position: Cartesian3.fromDegrees(lon, lat, s.height),
      __kind: s.kind,
      __id: s.id,
      point: {
        pixelSize: s.size ?? 10,
        color: color.withAlpha(s.kind === 'vehicle' ? 0.95 : 0.9),
        outlineColor: Color.BLACK.withAlpha(0.6),
        outlineWidth: s.kind === 'vehicle' ? 1.6 : 0,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: s.label
        ? {
          text: s.kind === 'stop' ? `${s.label}${s.lines?.length ? ` · ${s.lines.slice(0, 4).join(' ')}` : ''}` : s.label,
          font: s.kind === 'stop' ? '11px sans-serif' : 'bold 11px sans-serif',
          fillColor: s.kind === 'stop' ? Color.WHITE : color,
          outlineColor: Color.BLACK.withAlpha(0.85),
          outlineWidth: 2,
          style: 2,
          showBackground: s.kind === 'stop',
          backgroundColor: Color.fromCssColorString('#101720').withAlpha(0.7),
          pixelOffset: new Cartesian2(0, -14),
          verticalOrigin: VerticalOrigin.BOTTOM,
          horizontalOrigin: HorizontalOrigin.CENTER,
          scaleByDistance: new NearFarScalar(60, 1.25, 4000, 0.4),
          translucencyByDistance: new NearFarScalar(2000, 1.0, 9000, 0.0),
          distanceDisplayCondition: new DistanceDisplayCondition(0, 14000),
        }
        : undefined,
    } as any);
  }
}

/** Drogi jako wąskie wstęgi – pełna kontrola koloru per odcinek. */
function buildRoads(sim: Sim, layers: Set<string>, view: TrafficView, selRoad: number | null): Primitive {
  const roads = sim.roads;
  const instances: GeometryInstance[] = [];
  for (const r of roads) {
    const e = r.edge;
    const isRoad = e.carAccess;
    const isRail = e.roadClass === 'tram' || e.hasTram;
    if (!isRoad && !isRail) continue;
    const w = isRail ? 4.4 : Math.min(13, 4 + (isRoad ? e.lanesForward * 1.6 : 3));
    const dx = -e.hz, dz = e.hx;
    const ring: Cartesian3[] = [
      pos(e.ax + dx * w / 2, e.az + dz * w / 2),
      pos(e.bx + dx * w / 2, e.bz + dz * w / 2),
      pos(e.bx - dx * w / 2, e.bz - dz * w / 2),
      pos(e.ax - dx * w / 2, e.az - dz * w / 2),
    ];
    let color: string;
    if (r.destroyed || r.closure === 'closed') color = COL.closed;
    else if (!isRoad) color = COL.pedestrian;
    else if (isRail) color = COL.rail;
    else {
      let level = r.level;
      if (view === 'baseline') level = r.baseline;
      else if (view === 'predicted') level = r.predicted;
      const k = Math.max(0, Math.min(1, level));
      color = k < 0.4 ? mix(COL.empty, COL.light, k / 0.4) : k < 0.7 ? mix(COL.light, COL.mid, (k - 0.4) / 0.3) : mix(COL.mid, COL.heavy, (k - 0.7) / 0.3);
    }
    if (selRoad === e.id) color = COL.selected;
    const geo = new PolygonGeometry({
      polygonHierarchy: new PolygonHierarchy(ring),
      height: isRail ? 1.6 : 1.0,
      extrudedHeight: isRail ? 2.0 : 1.4,
    });
    instances.push(
      new GeometryInstance({
        geometry: geo,
        id: { __kind: 'road', __id: e.id } as any,
        attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(color).withAlpha(0.95)) },
      }),
    );
  }
  void layers;
  return new Primitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({ flat: true, closed: true, translucent: false, renderState: { depthTest: { enabled: false } } } as any),
    asynchronous: true,
    allowPicking: true,
  });
}

/**
 * Teren z naszych wysokości (Open-Meteo DEM) jako siatka brył `PolygonGeometry`.
 * Świadomie NIE używamy `TerrainProvider` Cesium – przy tak małym obszarze
 * (2 km) wypięta siatka jest szybsza, prostsza i nie wymaga Cesium ion.
 */
function buildTerrainMesh(city: CityData): Primitive {
  const t = city.terrain!;
  const b = terrainBounds(t);
  const cols = t.cols, rows = t.rows;
  const instances: GeometryInstance[] = [];
  let base = 0;
  for (const h of t.heights) base += h;
  base /= Math.max(1, t.heights.length);

  const hAt = (c: number, r: number) => (t.heights[r * cols + c] ?? 0) - base;
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const lon0 = b.west + (b.east - b.west) * (c / (cols - 1));
      const lon1 = b.west + (b.east - b.west) * ((c + 1) / (cols - 1));
      const lat0 = b.north - (b.north - b.south) * (r / (rows - 1));
      const lat1 = b.north - (b.north - b.south) * ((r + 1) / (rows - 1));
      // nadmiar wzdłuż kierunku południkowego, żeby krawędzie się nie rozjeżdżały
      const over = (b.east - b.west) / (cols - 1) * 0.5;
      const overLat = (b.north - b.south) / (rows - 1) * 0.5;
      const h = (hAt(c, r) + hAt(c + 1, r) + hAt(c, r + 1) + hAt(c + 1, r + 1)) / 4;
      const ring = [
        Cartesian3.fromDegrees(lon0 - over / 111320 / Math.cos((lat0 * Math.PI) / 180), lat0 + overLat / 111320, h - 0.5),
        Cartesian3.fromDegrees(lon1 + over / 111320 / Math.cos((lat1 * Math.PI) / 180), lat0 + overLat / 111320, h - 0.5),
        Cartesian3.fromDegrees(lon1 + over / 111320 / Math.cos((lat1 * Math.PI) / 180), lat1 - overLat / 111320, h - 0.5),
        Cartesian3.fromDegrees(lon0 - over / 111320 / Math.cos((lat0 * Math.PI) / 180), lat1 - overLat / 111320, h - 0.5),
      ];
      // Teren w kolorze miasta (piaskowo-szary); zieleń dokładamy osobną warstwą
      // z realnych wielokątów OSM, żeby nie malować parku tam, gdzie go nie ma.
      const alt = Math.max(0, Math.min(1, h / 34));
      const color = mix('#8e8a7e', '#a49c8b', alt);
      const geo = new PolygonGeometry({ polygonHierarchy: new PolygonHierarchy(ring), height: 0 });
      instances.push(
        new GeometryInstance({
          geometry: geo,
          attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(color).withAlpha(1)) },
        }),
      );
    }
  }
  return new Primitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({ flat: true, closed: false }),
    asynchronous: true,
    allowPicking: false,
  });
}

/** Budynki z prawdziwych obrysów OSM – jedna instancja zbiorcza. */
function buildStatic(prim: PrimitiveCollection, city: CityData) {
  if (city.buildings.length) prim.add(polygons(
    city.buildings.slice(0, MAX_BUILDINGS).map((b) => {
      const ring: [number, number][] = b.ring && b.ring.length >= 3 ? b.ring : [
        [b.x - b.w / 2, b.z - b.d / 2], [b.x + b.w / 2, b.z - b.d / 2],
        [b.x + b.w / 2, b.z + b.d / 2], [b.x - b.w / 2, b.z + b.d / 2],
      ];
      return { ring, color: b.landmark ? '#e6d3b4' : b.color, height: b.h, index: city.buildings.indexOf(b) };
    }),
    { bottom: 1.4, top: 1.5, pick: 'building' },
  ));

  for (const p of city.polygons) {
    if (p.ring.length < 3) continue;
    prim.add(polygons(
      [{
        ring: p.ring,
        color: p.kind === 'water' ? '#2f6f92' : '#5f8a48',
        height: p.kind === 'water' ? 0.2 : 0.6,
        index: 0,
      }],
      { bottom: p.kind === 'water' ? 0.2 : 1.5, top: p.kind === 'water' ? 0.6 : 1.7, pick: null },
    ));
  }

  // Drzewa tylko w realnej zieleni (wielokąty OSM), zgodnie z warstwą terenu.
  prim.add(buildTrees(city));
}

function polygons(
  items: { ring: [number, number][]; color: string; height: number; index: number }[],
  opts: { bottom: number; top: number; pick: 'building' | null },
): Primitive {
  const instances: GeometryInstance[] = items.map((b) => {
    const geo = new PolygonGeometry({
      polygonHierarchy: new PolygonHierarchy(positions(b.ring)),
      height: opts.bottom,
      extrudedHeight: opts.top > opts.bottom ? b.height : opts.top,
    });
    return new GeometryInstance({
      geometry: geo,
      id: opts.pick ? ({ __kind: opts.pick, __id: String(b.index) } as any) : undefined,
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString(b.color).withAlpha(0.97)) },
    });
  });
  return new Primitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({ flat: true, closed: true, translucent: false }),
    asynchronous: true,
    allowPicking: !!opts.pick,
  });
}

function buildTrees(city: CityData): Primitive {
  const pts: [number, number][] = [];
  for (const p of city.polygons) {
    if (p.kind !== 'green' || p.ring.length < 3) continue;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const [x, z] of p.ring) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
    }
    const n = Math.min(160, Math.max(2, Math.round(((maxX - minX) * (maxZ - minZ)) / 500)));
    for (let i = 0; i < n && pts.length < MAX_TREES; i++) {
      const x = minX + Math.random() * (maxX - minX);
      const z = minZ + Math.random() * (maxZ - minZ);
      if (!insideRing(p.ring, x, z)) continue;
      pts.push([x, z]);
    }
  }
  const instances: GeometryInstance[] = pts.map(([x, z]) => {
    const ll = toLatLon(x, z);
    const geo = new PolygonGeometry({
      polygonHierarchy: new PolygonHierarchy([
        Cartesian3.fromDegrees(ll.lat, ll.lon, 0),
        Cartesian3.fromDegrees(ll.lat + 0.00028, ll.lon, 0),
        Cartesian3.fromDegrees(ll.lat + 0.00028, ll.lon + 0.0004, 0),
        Cartesian3.fromDegrees(ll.lat, ll.lon + 0.0004, 0),
      ]),
      extrudedHeight: 6,
    });
    return new GeometryInstance({
      geometry: geo,
      attributes: { color: ColorGeometryInstanceAttribute.fromColor(Color.fromCssColorString('#4d8a3f').withAlpha(1)) },
    });
  });
  return new Primitive({
    geometryInstances: instances,
    appearance: new PerInstanceColorAppearance({ flat: true, closed: true }),
    asynchronous: true,
  });
}

/** Pole powierzchni pierścienia w metrach kwadratowych. */
function ringArea(ring: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a / 2);
}

function positions(ring: [number, number][]): Cartesian3[] {
  return ring.map(([x, z]) => pos(x, z));
}

function insideRing(ring: [number, number][], x: number, z: number): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) hit = !hit;
  }
  return hit;
}

/** Łączenie dwóch kolorów CSS – używane do gradientu obciążenia drogi. */
function mix(a: string, b: string, t: number): string {
  const ca = Color.fromCssColorString(a), cb = Color.fromCssColorString(b);
  const k = Math.max(0, Math.min(1, t));
  const r = Math.round(ca.red + (cb.red - ca.red) * k);
  const g = Math.round(ca.green + (cb.green - ca.green) * k);
  const bl = Math.round(ca.blue + (cb.blue - ca.blue) * k);
  return `rgb(${r},${g},${bl})`;
}

void Material; void LabelCollection; void PolylineGraphics;