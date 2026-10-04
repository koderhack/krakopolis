/**
 * Silnik dźwięku miasta – wyłącznie Web Audio API, bez plików i bez npm.
 *
 * Warstwy (max 5):
 *   city     – subtilny ambient (odległe miasto)
 *   traffic  – natężenie ruchu w okolicy kamery
 *   transit  – komunikacja miejska (autobusy/tramwaje)
 *   emergency– syreny / alarmy (jedna warstwa)
 *   disaster – ogień / woda / ostrzeżenia przy źródle
 *
 * Brak muzyki, brak audio per NPC / samochód.
 */

export type DisasterAudioKind =
  | 'fire'
  | 'flood'
  | 'airRaid'
  | 'contamination'
  | 'generic';

export interface CityAudioFrame {
  /** Master 0..1 (po sliderze). */
  master: number;
  /** Ambient miasta 0..1. */
  city: number;
  /** Ruch drogowy 0..1. */
  traffic: number;
  /** Komunikacja 0..1. */
  transit: number;
  /** Syreny / alarm 0..1. */
  emergency: number;
  /** Warstwa katastrofy 0..1. */
  disaster: number;
  disasterKind: DisasterAudioKind;
}

function clamp01(n: number) {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function makeNoiseBuffer(ctx: AudioContext, seconds: number, kind: 'white' | 'brown' | 'pink'): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  if (kind === 'white') {
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  } else if (kind === 'brown') {
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    }
  } else {
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.96900 * b2 + w * 0.1538520;
      b3 = 0.86650 * b3 + w * 0.3104856;
      b4 = 0.55000 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.0168980;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
      b6 = w * 0.115926;
    }
  }
  return buf;
}

function ramp(g: GainNode, value: number, t: number, seconds = 0.35) {
  const now = t;
  g.gain.cancelScheduledValues(now);
  g.gain.setValueAtTime(g.gain.value, now);
  g.gain.linearRampToValueAtTime(clamp01(value), now + Math.max(0.05, seconds));
}

class NoiseLoop {
  readonly out: GainNode;
  private src: AudioBufferSourceNode | null = null;
  private filter: BiquadFilterNode;
  private started = false;

  constructor(
    private ctx: AudioContext,
    buffer: AudioBuffer,
    filterType: BiquadFilterType,
    freq: number,
    q = 0.7,
  ) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;
    this.filter = ctx.createBiquadFilter();
    this.filter.type = filterType;
    this.filter.frequency.value = freq;
    this.filter.Q.value = q;
    this.filter.connect(this.out);
    this.buffer = buffer;
  }

  private buffer: AudioBuffer;

  start() {
    if (this.started) return;
    this.started = true;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.loop = true;
    src.connect(this.filter);
    src.start();
    this.src = src;
  }

  setFilter(freq: number, q?: number) {
    const now = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(freq, now, 0.08);
    if (q !== undefined) this.filter.Q.setTargetAtTime(q, now, 0.08);
  }

  setLevel(v: number, seconds = 0.4) {
    ramp(this.out, v, this.ctx.currentTime, seconds);
  }

  stop() {
    try { this.src?.stop(); } catch { /* already stopped */ }
    this.src = null;
    this.started = false;
  }
}

/** Dwutonowa syrena / alarm z LFO – jedna instancja na całą sesję. */
class SirenVoice {
  readonly out: GainNode;
  private a: OscillatorNode;
  private b: OscillatorNode;
  private lfo: OscillatorNode;
  private lfoGain: GainNode;
  private started = false;
  private mode: 'wail' | 'alarm' | 'pulse' = 'wail';

  constructor(private ctx: AudioContext) {
    this.out = ctx.createGain();
    this.out.gain.value = 0;

    this.a = ctx.createOscillator();
    this.b = ctx.createOscillator();
    this.a.type = 'sawtooth';
    this.b.type = 'triangle';
    this.a.frequency.value = 680;
    this.b.frequency.value = 820;

    const ga = ctx.createGain();
    const gb = ctx.createGain();
    ga.gain.value = 0.22;
    gb.gain.value = 0.16;
    this.a.connect(ga);
    this.b.connect(gb);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 900;
    filter.Q.value = 1.2;
    ga.connect(filter);
    gb.connect(filter);
    filter.connect(this.out);

    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = 0.35;
    this.lfoGain = ctx.createGain();
    this.lfoGain.gain.value = 220;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.a.frequency);
    this.lfoGain.connect(this.b.frequency);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.a.start();
    this.b.start();
    this.lfo.start();
  }

  setMode(mode: 'wail' | 'alarm' | 'pulse') {
    if (this.mode === mode) return;
    this.mode = mode;
    const now = this.ctx.currentTime;
    if (mode === 'wail') {
      this.lfo.frequency.setTargetAtTime(0.32, now, 0.1);
      this.lfoGain.gain.setTargetAtTime(240, now, 0.1);
      this.a.frequency.setTargetAtTime(620, now, 0.1);
      this.b.frequency.setTargetAtTime(780, now, 0.1);
    } else if (mode === 'alarm') {
      this.lfo.frequency.setTargetAtTime(1.15, now, 0.1);
      this.lfoGain.gain.setTargetAtTime(180, now, 0.1);
      this.a.frequency.setTargetAtTime(880, now, 0.1);
      this.b.frequency.setTargetAtTime(1100, now, 0.1);
    } else {
      this.lfo.frequency.setTargetAtTime(2.4, now, 0.1);
      this.lfoGain.gain.setTargetAtTime(90, now, 0.1);
      this.a.frequency.setTargetAtTime(540, now, 0.1);
      this.b.frequency.setTargetAtTime(720, now, 0.1);
    }
  }

  setLevel(v: number, seconds = 0.5) {
    ramp(this.out, v, this.ctx.currentTime, seconds);
  }

  stop() {
    try {
      this.a.stop();
      this.b.stop();
      this.lfo.stop();
    } catch { /* already stopped */ }
    this.started = false;
  }
}

export class CityAudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private city: NoiseLoop | null = null;
  private traffic: NoiseLoop | null = null;
  private transit: NoiseLoop | null = null;
  private fire: NoiseLoop | null = null;
  private water: NoiseLoop | null = null;
  private warn: NoiseLoop | null = null;
  private siren: SirenVoice | null = null;
  private running = false;
  private lastKind: DisasterAudioKind = 'generic';
  private muted = true;

  get isRunning() { return this.running; }
  get audioContext() { return this.ctx; }

  /** Wymaga gestu użytkownika (autoplay policy). */
  async ensureStarted(): Promise<boolean> {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.buildGraph(this.ctx);
    }
    if (this.ctx.state === 'suspended') {
      try { await this.ctx.resume(); } catch { return false; }
    }
    this.running = this.ctx.state === 'running';
    this.muted = false;
    return this.running;
  }

  private buildGraph(ctx: AudioContext) {
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    const brown = makeNoiseBuffer(ctx, 3.2, 'brown');
    const pink = makeNoiseBuffer(ctx, 2.6, 'pink');
    const white = makeNoiseBuffer(ctx, 1.8, 'white');

    this.city = new NoiseLoop(ctx, brown, 'lowpass', 280, 0.6);
    this.traffic = new NoiseLoop(ctx, pink, 'bandpass', 420, 0.55);
    this.transit = new NoiseLoop(ctx, pink, 'bandpass', 180, 0.9);
    this.fire = new NoiseLoop(ctx, white, 'highpass', 900, 0.5);
    this.water = new NoiseLoop(ctx, brown, 'lowpass', 360, 0.8);
    this.warn = new NoiseLoop(ctx, pink, 'bandpass', 1400, 1.4);
    this.siren = new SirenVoice(ctx);

    this.city.out.connect(this.master);
    this.traffic.out.connect(this.master);
    this.transit.out.connect(this.master);
    this.fire.out.connect(this.master);
    this.water.out.connect(this.master);
    this.warn.out.connect(this.master);
    this.siren.out.connect(this.master);

    this.city.start();
    this.traffic.start();
    this.transit.start();
    this.fire.start();
    this.water.start();
    this.warn.start();
    this.siren.start();
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (!this.master || !this.ctx) return;
    if (muted) {
      ramp(this.master, 0, this.ctx.currentTime, 0.25);
    }
  }

  apply(frame: CityAudioFrame) {
    if (!this.running || !this.ctx || !this.master || this.muted) return;

    const m = clamp01(frame.master) * 0.55;
    ramp(this.master, m, this.ctx.currentTime, 0.2);

    this.city?.setLevel(clamp01(frame.city) * 0.28, 0.5);
    this.traffic?.setLevel(clamp01(frame.traffic) * 0.38, 0.35);
    this.traffic?.setFilter(280 + clamp01(frame.traffic) * 520, 0.5 + frame.traffic * 0.4);
    this.transit?.setLevel(clamp01(frame.transit) * 0.22, 0.45);

    const em = clamp01(frame.emergency);
    const ds = clamp01(frame.disaster);
    const kind = frame.disasterKind;
    this.lastKind = kind;

    if (kind === 'fire') {
      this.siren?.setMode('wail');
      this.siren?.setLevel(em * 0.32, 0.55);
      this.fire?.setLevel(ds * 0.26, 0.6);
      this.water?.setLevel(0, 0.8);
      this.warn?.setLevel(0, 0.6);
    } else if (kind === 'flood') {
      this.siren?.setMode('pulse');
      this.siren?.setLevel(em * 0.22, 0.6);
      this.water?.setLevel(ds * 0.34, 0.7);
      this.fire?.setLevel(0, 0.8);
      this.warn?.setLevel(em * 0.08, 0.6);
    } else if (kind === 'airRaid' || kind === 'contamination') {
      this.siren?.setMode('alarm');
      this.siren?.setLevel(em * 0.36, 0.45);
      this.warn?.setLevel(ds * 0.22, 0.5);
      this.fire?.setLevel(kind === 'contamination' ? ds * 0.08 : 0, 0.7);
      this.water?.setLevel(0, 0.7);
    } else {
      this.siren?.setMode('pulse');
      this.siren?.setLevel(em * 0.26, 0.55);
      this.warn?.setLevel(ds * 0.14, 0.55);
      this.fire?.setLevel(0, 0.7);
      this.water?.setLevel(0, 0.7);
    }

    // Gdy katastrofa zanika – warstwy emergency/disaster same schodzą do 0 (fade).
    if (em < 0.01 && ds < 0.01 && this.lastKind) {
      this.siren?.setLevel(0, 0.9);
      this.fire?.setLevel(0, 1.0);
      this.water?.setLevel(0, 1.0);
      this.warn?.setLevel(0, 0.9);
    }
  }

  dispose() {
    this.city?.stop();
    this.traffic?.stop();
    this.transit?.stop();
    this.fire?.stop();
    this.water?.stop();
    this.warn?.stop();
    this.siren?.stop();
    try { void this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
    this.master = null;
    this.running = false;
  }
}
