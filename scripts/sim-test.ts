/**
 * Test symulacji na prawdziwych danych Krakowa.
 *
 * Uruchomienie:
 *   npm run ingest     # najpierw pobiera dane do public/data
 *   npm run sim:test
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildCityData, type BakedBundle } from '../src/data/adapters/cityAdapter';
import { Sim } from '../src/simulation/sim';
import type { BakedCity, BakedEnvironment, BakedManifest, BakedTerrain, BakedTraffic, BakedTransit } from '../src/data/baked';

const dir = join(process.cwd(), 'public', 'data');
const read = <T,>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;

const need = ['manifest.json', 'osm-city.json', 'transit.json', 'traffic.json', 'environment.json', 'vehicles-snapshot.json'];
const missing = need.filter((f) => !existsSync(join(dir, f)));
if (missing.length) {
  console.error('Brakuje plików:', missing.join(', '));
  console.error('Najpierw uruchom: npm run ingest');
  process.exit(1);
}

const bundle: BakedBundle = {
  manifest: read<BakedManifest>('manifest.json'),
  city: read<BakedCity>('osm-city.json'),
  transit: read<BakedTransit>('transit.json'),
  traffic: read<BakedTraffic>('traffic.json'),
  environment: read<BakedEnvironment>('environment.json'),
  vehicles: read<BakedBundle['vehicles']>('vehicles-snapshot.json'),
  terrain: existsSync(join(dir, 'terrain.json')) ? read<BakedTerrain>('terrain.json') : null,
};

const city = buildCityData(bundle);
console.log('— dane —');
console.log(`  obszar        ${city.area.name}`);
console.log(`  węzły/drgi    ${city.nodes.length} / ${city.roads.length}`);
console.log(`  budynki       ${city.buildings.length}`);
console.log(`  przystanki    ${city.stops.length}  (linie: ${city.routes.length})`);
console.log(`  odcinki MPK   ${city.roads.filter((r) => r.transit).length}`);
console.log(`  realne pojazdy ${city.liveVehicles.length} (zapis ${new Date(city.liveVehicles[0]?.timestamp ?? 0).toISOString()})`);
const origins = { OBSERVED: 0, PREDICTED: 0 } as Record<string, number>;
for (const r of city.roads) origins[r.baselineOrigin] = (origins[r.baselineOrigin] ?? 0) + 1;
console.log(`  baseline ruchu OBSERVED: ${origins.OBSERVED}, PREDICTED: ${origins.PREDICTED}`);
console.log(`  pogoda         ${city.environment.weather?.description ?? 'Data unavailable'}, ${city.environment.weather?.temperatureC ?? '?'}°C`);
console.log(`  powietrze      ${city.environment.airQuality?.description ?? 'Data unavailable'}`);

const sim = new Sim(city);
const byName = (n: string) => sim.roads.filter((r) => r.edge.name === n).slice(0, 4);
const rep = (t: string) => console.log(
  t.padEnd(16),
  Object.entries(sim.m).map(([k, v]) => `${k}=${Math.round(v)}`).join(' '),
  `peds=${Math.round(sim.activePeds)} pred=${sim.roads.filter((r) => r.predicted > 0).length}`,
);
const run = (sec: number) => { for (let i = 0; i < sec * 10; i++) sim.step(0.1); };

run(60);
rep('baseline');
console.log(`  symulowanych pojazdów: ${sim.veh.length}, pieszych: ${Math.round(sim.activePeds)}`);

// Wybieramy realną ulicę z ruchem, żeby sprawdzić objazdy.
const target = sim.roads
  .filter((r) => r.edge.carAccess && r.edge.name && !r.closed && r.edge.len > 80)
  .sort((a, b) => b.baseline - a.baseline)[0];
if (target) {
  const neighbours = sim.roads
    .filter((r) => r.edge.carAccess && r.edge.id !== target.edge.id)
    .sort((a, b) => Math.hypot((a.edge.ax - target.edge.ax), (a.edge.az - target.edge.az)) - Math.hypot((b.edge.ax - target.edge.ax), (b.edge.az - target.edge.az)))
    .slice(0, 3);
  const before = [
    `zamknięta ${target.edge.name}: baseline ${Math.round(target.baseline * 100)}% → predykcja ${Math.round(target.predicted * 100)}%`,
    ...neighbours.map((n) => `${n.edge.name || n.edge.id}: ${Math.round(n.baseline * 100)}% → ${Math.round(n.predicted * 100)}%`),
  ];
  console.log('\n— zamknięcie ulicy przez gracza —');
  console.log('  przed:', before.join(' | '));
  const err = sim.setClosed(target.edge.id, true);
  console.log('  setClosed:', err ?? 'OK');
  run(30);
  console.log('  po:   ', [
    `${target.edge.name}: ${Math.round(target.baseline * 100)}% → ${Math.round(target.predicted * 100)}% (closed=${target.closed})`,
    ...neighbours.map((n) => `${n.edge.name || n.edge.id}: ${Math.round(n.baseline * 100)}% → ${Math.round(n.predicted * 100)}%`),
  ].join(' | '));
  console.log('  auta na zamkniętej ulicy po 30 s:', sim.veh.filter((v) => v.edge === target.edge.id).length);
  console.log('  zmiany gracza:', sim.playerChanges().length);
  console.log('  setClosed(odwrotnie):', sim.setClosed(target.edge.id, false) ?? 'OK');
  run(20);
  rep('po otwarciu');
}

// Transit na realnych trasach + piesi.
console.log('\n— komunikacja i piesi —');
const simTransit = sim.veh.filter((v) => v.ref).length;
console.log(`  symulowanych pojazdów MPK na trasach GTFS: ${simTransit}`);
console.log(`  realnych pojazdów MPK (OBSERVED): ${sim.realVehicles.length}`);
console.log(`  przystanków na grafie: ${sim.stops.length}`);
const stopRoad = sim.roads.find((r) => !r.realStop && r.edge.carAccess && r.edge.len > 90 && !r.closed);
if (stopRoad) {
  console.log('  addStop:', sim.addStop(stopRoad.edge.id) ?? 'OK', '→ realStop=', stopRoad.realStop, 'addedStop=', stopRoad.addedStop);
}
const walkRoad = sim.roads.find((r) => r.edge.carAccess && r.edge.len > 100 && !r.closed);
if (walkRoad) {
  console.log('  setPedestrian:', sim.setPedestrian(walkRoad.edge.id, true) ?? 'OK');
}
console.log('  park na środku kwartału:', sim.addPark(220, -260) ?? 'OK');
run(60);
rep('po decyzjach');

console.log('\n— realne pojazdy (OBSERVED) —');
for (const v of city.liveVehicles.slice(0, 8)) {
  console.log(`  ${v.type.padEnd(4)} linia ${String(v.line).padEnd(4)} ${v.latitude.toFixed(5)}, ${v.longitude.toFixed(5)} → x=${v.x.toFixed(0)} z=${v.z.toFixed(0)} kurs=${Math.round(v.bearing ?? 0)}° ${v.origin} ts=${v.timestamp}`);
}
const speeds = city.liveVehicles.map((v) => v.speed).filter((s): s is number => s !== undefined);
console.log(`  prędkość z dwóch obserwacji: ${speeds.length ? `${Math.min(...speeds).toFixed(1)}–${Math.max(...speeds).toFixed(1)} m/s` : 'Data unavailable'}`);
console.log('\nOK');