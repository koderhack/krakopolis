/**
 * Testy akceptacyjne katastrof: lokalizacja kliknięcia + gęstość ludności.
 *   npx tsx scripts/disaster-click-test.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildCityData, type BakedBundle } from '../src/data/adapters/cityAdapter';
import { Sim } from '../src/simulation/sim';
import { estimateAffectedResidents } from '../src/simulation/city/population';
import type { BakedCity, BakedEnvironment, BakedManifest, BakedTerrain, BakedTraffic, BakedTransit } from '../src/data/baked';

const dir = join(process.cwd(), 'public', 'data');
const read = <T,>(name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;
const need = ['manifest.json', 'osm-city.json', 'transit.json', 'traffic.json', 'environment.json', 'vehicles-snapshot.json'];
for (const f of need) {
  if (!existsSync(join(dir, f))) {
    console.error('Brak', f);
    process.exit(1);
  }
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
const sim = new Sim(city);
sim.m.budget = 50_000_000;

let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(ok ? `  ✓ ${name}` : `  ✗ ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
};

console.log('— TEST 1/2: pożar na budynku A, potem B —');
const bA = city.buildings.find((b) => b.h > 20 && !b.landmark) ?? city.buildings[10];
const bB = city.buildings.find((b) => Math.hypot(b.x - bA.x, b.z - bA.z) > 200 && b.h > 15) ?? city.buildings[80];
const iA = city.buildings.indexOf(bA);
const iB = city.buildings.indexOf(bB);

sim.triggerDisaster('fire', bA.x, bA.z, { buildingId: iA, buildingKind: 'osm', label: 'Budynek A' });
const dA = sim.disasters[sim.disasters.length - 1];
check('pożar A @ dokładnie bA', !!dA && Math.hypot(dA.cx - bA.x, dA.cz - bA.z) < 0.01, `got ${dA?.cx},${dA?.cz}`);
check('targetBuildingId A', dA?.targetBuildingId === iA);

// zakończ A (usuń przez undo lub intensity)
sim.disasters = [];
sim.triggerDisaster('fire', bB.x, bB.z, { buildingId: iB, buildingKind: 'osm', label: 'Budynek B' });
const dB = sim.disasters[sim.disasters.length - 1];
check('pożar B @ dokładnie bB (nie A)', !!dB && Math.hypot(dB.cx - bB.x, dB.cz - bB.z) < 0.01);
check('B ≠ A', Math.hypot(dB.cx - bA.x, dB.cz - bA.z) > 50);

console.log('— TEST 3: pusty teren —');
sim.disasters = [];
const gx = bA.x + 180, gz = bA.z + 180;
sim.triggerDisaster('fire', gx, gz);
const dG = sim.disasters[sim.disasters.length - 1];
check('źródło na klikniętym terenie', !!dG && Math.hypot(dG.cx - gx, dG.cz - gz) < 0.01);

console.log('— TEST 4: powódź w punkcie —');
sim.disasters = [];
const fx = bA.x - 90, fz = bA.z + 40;
sim.triggerDisaster('flood', fx, fz);
const dF = sim.disasters[sim.disasters.length - 1];
check('powódź startuje w kliknięciu', !!dF && Math.hypot(dF.cx - fx, dF.cz - fz) < 0.01);

console.log('— TEST 5: snapshot persist (cx/cz) —');
const snap = sim.exportPlayerState();
const sim2 = new Sim(city);
sim2.applyPlayerSnapshot({
  buildings: snap.buildings,
  parks: snap.parks,
  budget: snap.budget,
  disasters: snap.disasters,
});
const restored = sim2.disasters[0];
check('po restore cx/cz identyczne', !!restored && restored.cx === dF.cx && restored.cz === dF.cz);

console.log('— TEST 6: trzy zdarzenia A/B/C —');
sim.disasters = [];
const pts = [
  { x: bA.x, z: bA.z },
  { x: bB.x, z: bB.z },
  { x: gx, z: gz },
];
for (const p of pts) sim.triggerDisaster('fire', p.x, p.z);
check('3 aktywne źródła', sim.disasters.length === 3, `n=${sim.disasters.length}`);
check('każde w swoim punkcie', sim.disasters.every((d, i) => Math.hypot(d.cx - pts[i].x, d.cz - pts[i].z) < 0.01));

console.log('— GĘSTOŚĆ LUDNOŚCI (zabudowa OSM) —');
// Znajdź gęsty vs rzadki obszar
let dense = { x: 0, z: 0, n: 0 };
let sparse = { x: 0, z: 0, n: Infinity };
for (let i = 0; i < city.buildings.length; i += 17) {
  const b = city.buildings[i];
  const n = estimateAffectedResidents({
    cx: b.x, cz: b.z, radius: 220,
    osmBuildings: city.buildings,
    playerBuildings: [],
  });
  if (n > dense.n) dense = { x: b.x, z: b.z, n };
  if (n < sparse.n && n >= 0) sparse = { x: b.x, z: b.z, n };
}
console.log(`  gęsty obszar: ~${dense.n} osób / r=220`);
console.log(`  rzadki obszar: ~${sparse.n} osób / r=220`);
check('gęsty ≫ rzadki (różne części Krakowa)', dense.n > sparse.n * 1.5, `${dense.n} vs ${sparse.n}`);

sim.disasters = [];
sim.triggerDisaster('fire', dense.x, dense.z);
const dDense = sim.disasters[0];
check('affectedResidents zapisane', (dDense?.affectedResidents ?? 0) > 0, String(dDense?.affectedResidents));

console.log(failed ? `\nFAILED: ${failed}` : '\nALL OK');
process.exit(failed ? 1 : 0);
