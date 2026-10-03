import { Sim } from '../src/simulation/sim';
import { demoCity } from '../src/data/cityData';

const sim = new Sim(demoCity);
const named = (n: string) => sim.edges.filter((e) => e.name === n).map((e) => `${e.id}:${Math.round(e.trafficLevel * 100)}%`).join(' ');
const rep = (t: string) => console.log(t.padEnd(14), Object.entries(sim.m).map(([k, v]) => `${k}=${Math.round(v)}`).join(' '), `peds=${Math.round(sim.activePeds)}`);
const run = (s: number) => { for (let i = 0; i < s * 10; i++) sim.step(0.1); };

run(60); rep('baseline');
const flo = sim.edges.find((e) => e.name === 'Floriańska')!;
const names = ['Sławkowska', 'Św. Jana', 'Szewska', 'Sienna'];
const before = names.map((n) => `${n} ${named(n)}`).join(' | ');
console.log('close result:', sim.setClosed(flo.id, true));
run(5);
console.log('cars still on closed road after 5s:', sim.veh.filter((v) => v.edge === flo.id && v.kind === 0).length);
run(60); rep('after close');
console.log('traffic before:', before);
console.log('traffic after: ', names.map((n) => `${n} ${named(n)}`).join(' | '));
console.log('cars on closed road after 65s:', sim.veh.filter((v) => v.edge === flo.id && v.kind === 0).length);
const ped = sim.edges.find((e) => e.name === 'Grodzka' && e.len > 150)!;
console.log('pedestrian zone:', sim.setPedestrian(ped.id, true)); run(60); rep('after ped zone');
console.log('add stop:', sim.addStop(sim.edges.find((e) => e.name === 'Sławkowska')!.id));
console.log('park:', sim.addPark(250, 150)); run(60); rep('after park');
console.log('park on plaza (should be refused):', sim.addPark(0, 0));
