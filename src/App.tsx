import { useMemo, useState } from 'react';
import type { CityData } from './data/cityData';
import { Sim } from './simulation/sim';
import { genBuildings } from './scene/buildings';
import { CityScene, type Sel, type Tool } from './scene/CityScene';
import { Hud } from './ui/Hud';

export default function App({ city }: { city: CityData }) {
  const sim = useMemo(() => new Sim(city), [city]);
  const buildings = useMemo(() => genBuildings(sim.edges), [sim]);
  const [ver, setVer] = useState(0);
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<Sel>(null);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [msg, setMsg] = useState({ id: 0, text: '' });

  const act = (fn: () => string | null, ok = '') => {
    const err = fn();
    setMsg((m) => ({ id: m.id + 1, text: err ?? ok }));
    setVer((v) => v + 1);
    return err;
  };
  const onPark = (x: number, z: number) => { if (!act(() => sim.addPark(x, z), 'Posadzono park. Znikają kamienice w pobliżu.')) setTool('select'); };

  return (
    <div className="app">
      <CityScene sim={sim} ver={ver} tool={tool} speed={speed} paused={paused} sel={sel} buildings={buildings} onSelect={setSel} onPark={onPark} />
      <Hud sim={sim} ver={ver} sel={sel} buildings={buildings} tool={tool} paused={paused} speed={speed} msg={msg} setTool={setTool} setPaused={setPaused} setSpeed={setSpeed} act={act} />
    </div>
  );
}
