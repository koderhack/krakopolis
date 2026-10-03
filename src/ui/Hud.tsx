import { useEffect, useState } from 'react';
import { COST, type Sim } from '../simulation/sim';
import type { Sel, Tool } from '../scene/CityScene';
import type { B } from '../scene/buildings';

interface Props {
  sim: Sim; ver: number; sel: Sel; buildings: B[]; tool: Tool; paused: boolean; speed: number; msg: { id: number; text: string };
  setTool: (t: Tool) => void; setPaused: (b: boolean) => void; setSpeed: (n: number) => void; act: (fn: () => string | null, ok?: string) => void;
}
const METRICS = [
  { k: 'traffic', label: 'Ruch', bad: true }, { k: 'transit', label: 'Komunikacja', bad: false }, { k: 'pedestrians', label: 'Piesi', bad: false },
  { k: 'pollution', label: 'Smog', bad: true }, { k: 'noise', label: 'Hałas', bad: true }, { k: 'satisfaction', label: 'Zadowolenie', bad: false },
] as const;
const tone = (v: number, bad: boolean) => `hsl(${Math.round((bad ? 100 - v : v) * 1.15)} 55% 42%)`;
const Bar = ({ v, bad = true }: { v: number; bad?: boolean }) => <span className="bar"><i style={{ width: `${Math.round(v)}%`, background: tone(v, bad) }} /></span>;

export function Hud({ sim, sel, buildings, tool, paused, speed, msg, setTool, setPaused, setSpeed, act }: Props) {
  const [s, setS] = useState(() => sim.snapshot());
  const [toast, setToast] = useState('');
  useEffect(() => { const t = setInterval(() => setS(sim.snapshot()), 250); return () => clearInterval(t); }, [sim]);
  useEffect(() => { if (!msg.text) return; setToast(msg.text); const t = setTimeout(() => setToast(''), 4500); return () => clearTimeout(t); }, [msg]);

  const e = sel?.kind === 'road' ? sim.edges[sel.id] : null;
  const b = sel?.kind === 'building' ? buildings[sel.id] : null;
  const status = e ? (e.closed ? 'Zamknięta' : e.pedestrian ? 'Strefa dla pieszych' : 'Otwarta') : '';
  const acts = e ? [
    { label: e.closed ? 'Otwórz ulicę' : 'Zamknij ulicę', cost: e.closed ? 0 : COST.close, run: () => act(() => sim.setClosed(e.id, !e.closed), e.closed ? 'Ulica otwarta. Auta wracają.' : `Zamknięto ulicę ${e.name}. Auta szukają objazdów.`) },
    { label: e.pedestrian ? 'Przywróć ruch aut' : 'Strefa dla pieszych', cost: e.pedestrian ? 0 : COST.pedestrian, run: () => act(() => sim.setPedestrian(e.id, !e.pedestrian), e.pedestrian ? 'Ulica znów dla aut.' : `${e.name} jest teraz strefą dla pieszych.`) },
    { label: 'Dodaj przystanek', cost: COST.stop, run: () => act(() => sim.addStop(e.id), 'Dodano przystanek.') },
  ] : [];

  return (
    <>
      <header className="top">
        <div className="brand"><b>SimCity Kraków</b><span>Stare Miasto, prototyp HackYeah</span></div>
        <div className="metrics">
          {METRICS.map((m) => (
            <div key={m.k} className="metric"><span>{m.label}</span><strong>{Math.round(s[m.k])}</strong><Bar v={s[m.k]} bad={m.bad} /></div>
          ))}
          <div className="metric"><span>Budżet</span><strong>{Math.round(s.budget).toLocaleString('pl-PL')} zł</strong></div>
        </div>
        <div className="ctrl">
          <button className={paused ? '' : 'on'} onClick={() => setPaused(!paused)}>{paused ? 'Play' : 'Pauza'}</button>
          {[1, 2, 5].map((n) => <button key={n} className={speed === n ? 'on' : ''} onClick={() => setSpeed(n)}>{n}x</button>)}
        </div>
      </header>

      {(e || b) && (
        <aside className="panel">
          {e ? (
            <>
              <h2>{e.name}</h2><p className="sub">Odcinek ulicy, {Math.round(e.len)} m</p>
              <dl>
                <dt>Ruch</dt><dd><Bar v={Math.min(1, e.trafficLevel) * 100} /> {Math.round(Math.min(1, e.trafficLevel) * 100)}%</dd>
                <dt>Pojazdy</dt><dd>{e.load} (przepustowość {e.capacity})</dd>
                <dt>Limit</dt><dd>{Math.round(e.speedLimit * 3.6)} km/h</dd>
                <dt>Przystanek</dt><dd>{e.hasStop ? 'Jest' : 'Brak'}</dd>
                <dt>Status</dt><dd className={e.closed ? 'bad' : ''}>{status}</dd>
              </dl>
              <div className="acts">{acts.map((a) => <button key={a.label} onClick={a.run}>{a.label}{a.cost ? <small> {a.cost} zł</small> : null}</button>)}</div>
            </>
          ) : b ? (
            <>
              <h2>{b.name}</h2><p className="sub">{b.landmark ? 'Obiekt charakterystyczny' : 'Zabudowa generowana proceduralnie'}</p>
              <dl><dt>Wysokość</dt><dd>ok. {Math.round(b.h)} m (szacunek)</dd><dt>Kondygnacje</dt><dd>ok. {Math.max(1, Math.round(b.h / 3.4))}</dd><dt>Obrys</dt><dd>{Math.round(b.w)} × {Math.round(b.d)} m</dd></dl>
            </>
          ) : null}
        </aside>
      )}

      <nav className="tools">
        <button className={tool === 'select' ? 'on' : ''} onClick={() => setTool('select')}>Zaznacz</button>
        {[
          { l: 'Zamknij ulicę', i: 0 }, { l: 'Strefa dla pieszych', i: 1 }, { l: 'Przystanek', i: 2 },
        ].map((t) => (
          <button key={t.l} disabled={!e} title={e ? '' : 'Najpierw kliknij ulicę w mieście'} onClick={() => acts[t.i]?.run()}>{e ? acts[t.i].label : t.l}</button>
        ))}
        <button className={tool === 'park' ? 'on' : ''} onClick={() => setTool(tool === 'park' ? 'select' : 'park')}>Park <small>{COST.park} zł</small></button>
      </nav>
      <div className="hint">{tool === 'park' ? 'Kliknij w środek kwartału, aby założyć park.' : e || b ? '' : 'Kliknij ulicę lub budynek. Lewy przycisk obraca widok, prawy przesuwa, kółko przybliża.'}</div>
      {toast && <div className="toast">{toast}</div>}
      <div className="foot">{s.cars} aut, {s.peds} pieszych, {sim.stops.length} przystanków. {sim.data.source}</div>
    </>
  );
}
