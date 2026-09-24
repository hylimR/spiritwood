import {
  EXP_FLOOR, expTo, hz, linTo, setAt, setValue, targetAt, type AudioBufferPort, type AudioNodePort,
  type AudioParamPort, type BiquadFilterNodePort, type BufferSourcePort, type FilterType, type GainNodePort,
  type GraphPort, type OscillatorNodePort, type OscType, type PeriodicWavePort, type VoiceSink,
} from './ports.ts';

/** Shared per-context resources a patch may need; a patch needing a missing one is skipped. */
export interface PatchKit {
  noise: AudioBufferPort | null;
  waves: Waves | null;
}

/**
 * Per-call patch parameters. Callers reuse one object and overwrite the fields they need; `reset`
 * restores the defaults.
 */
export interface PatchParams {
  /** Overall level scale, 0..1 (loudness × spatial gain). */
  gain: number;
  /** Main pitch, MIDI. */
  midi: number;
  /** Chord / sequence notes, MIDI (up to 8). */
  readonly notes: Float64Array;
  noteCount: number;
  /** Hold time (s). ≤ 0 = open-ended: the voice is a lease released by its kill gain. */
  dur: number;
  /** Timbre brightness 0..1. */
  bright: number;
  /** Deterministic per-instance variation 0..1. */
  variant: number;
  /** Attack and release (s) for sustained notes. */
  attack: number;
  release: number;
  kit: PatchKit;
}

export function createParams(kit: PatchKit): PatchParams {
  return {
    gain: 1, midi: 69, notes: new Float64Array(8), noteCount: 0, dur: 0, bright: 0.5, variant: 0.5,
    attack: 0.01, release: 0.2, kit,
  };
}

export function resetParams(p: PatchParams): PatchParams {
  p.gain = 1;
  p.midi = 69;
  p.noteCount = 0;
  p.dur = 0;
  p.bright = 0.5;
  p.variant = 0.5;
  p.attack = 0.01;
  p.release = 0.2;
  return p;
}

/**
 * A patch: a pure function of (ctx, out, t, params) that builds its sources → [shaping] → one envelope
 * Gain → `out`, starts its sources at or after `t`, and returns the time its release reaches 0 (the caller
 * stops every registered source 5 ms later), or −1 for an open-ended lease voice.
 */
export type PatchFn = (ctx: GraphPort, out: AudioNodePort, t: number, p: PatchParams, sink: VoiceSink) => number;

export interface Waves {
  /** Soft saw (1/n with a gentle roll-off): pads. */
  soft: PeriodicWavePort;
  /** Felt-hammered string: the felt piano body. */
  felt: PeriodicWavePort;
  /** Odd-heavy, dark: drones. */
  reed: PeriodicWavePort;
  /** Few low harmonics: bass pulse, heartbeat. */
  warm: PeriodicWavePort;
}

function wave(ctx: GraphPort, n: number, amp: (k: number) => number): PeriodicWavePort {
  const real = new Float32Array(n + 1);
  const imag = new Float32Array(n + 1);
  for (let k = 1; k <= n; k++) imag[k] = amp(k);
  return ctx.createPeriodicWave(real, imag);
}

export function createWaves(ctx: GraphPort): Waves {
  return {
    soft: wave(ctx, 24, (k) => Math.exp(-(k - 1) / 5) / k),
    felt: wave(ctx, 16, (k) => (k % 2 === 1 ? 1 : 0.6) / Math.pow(k, 1.7)),
    reed: wave(ctx, 15, (k) => (k % 2 === 1 ? 1 / k : 0.12 / k)),
    warm: wave(ctx, 6, (k) => [1, 0.5, 0.22, 0.1, 0.05, 0.025][k - 1] as number),
  };
}

export function gainNode(ctx: GraphPort, sink: VoiceSink, v: number): GainNodePort {
  const g = ctx.createGain();
  setValue(g.gain, v);
  sink.node(g);
  return g;
}

export function osc(ctx: GraphPort, sink: VoiceSink, type: OscType, f: number, t: number): OscillatorNodePort {
  const o = ctx.createOscillator();
  o.type = type;
  setValue(o.frequency, hz(f));
  sink.source(o);
  o.start(t);
  return o;
}

export function waveOsc(ctx: GraphPort, sink: VoiceSink, w: PeriodicWavePort, f: number, t: number): OscillatorNodePort {
  const o = ctx.createOscillator();
  o.setPeriodicWave(w);
  setValue(o.frequency, hz(f));
  sink.source(o);
  o.start(t);
  return o;
}

/** Looping white noise from the shared buffer, starting `offset` (0..1) into it. */
export function noise(ctx: GraphPort, sink: VoiceSink, buf: AudioBufferPort, t: number, rate: number, offset: number): BufferSourcePort {
  const s = ctx.createBufferSource();
  s.buffer = buf;
  s.loop = true;
  setValue(s.playbackRate, rate);
  sink.source(s);
  const len = buf.length / buf.sampleRate;
  const o = offset - Math.floor(offset);
  s.start(t, o * len);
  return s;
}

export function filter(ctx: GraphPort, sink: VoiceSink, type: FilterType, f: number, q: number): BiquadFilterNodePort {
  const b = ctx.createBiquadFilter();
  b.type = type;
  setValue(b.frequency, hz(f));
  setValue(b.Q, q);
  sink.node(b);
  return b;
}

/** The voice's one envelope Gain (starts silent) connected to `out`. */
export function envelope(ctx: GraphPort, sink: VoiceSink, out: AudioNodePort): GainNodePort {
  const g = ctx.createGain();
  setValue(g.gain, 0);
  g.connect(out);
  sink.node(g);
  return g;
}

/**
 * Writes click-free envelope segments onto one AudioParam and tracks its analytic value, so every
 * segment after a setTarget can be anchored exactly (§5.9 envelope rules):
 * attack = setValueAtTime(0, t0) + linear ramp; decays = exponential ramps ≥ 1e-4 or setTargetAtTime;
 * release = a final linearRampToValueAtTime(0, tEnd).
 */
export class EnvWriter {
  private p: AudioParamPort | null = null;
  private v = 0;
  private t = 0;
  private pendingAnchor = false;

  /** setValueAtTime(0, t0), then a linear ramp to `peak` over `a` seconds. */
  attack(p: AudioParamPort, t0: number, a: number, peak: number): this {
    this.p = p;
    setAt(p, 0, t0);
    linTo(p, peak, t0 + Math.max(a, 0.001));
    this.v = peak;
    this.t = t0 + Math.max(a, 0.001);
    this.pendingAnchor = false;
    return this;
  }

  /** Stay at the current level until `until` (the next segment is anchored there). */
  hold(until: number): this {
    this.anchor();
    if (until > this.t) {
      this.t = until;
      this.pendingAnchor = true;
    }
    return this;
  }

  /** Exponential approach toward `level` with time constant `tau`, until `until`. */
  decay(level: number, tau: number, until: number): this {
    const p = this.param();
    this.anchor();
    targetAt(p, level, this.t, tau);
    const dt = Math.max(0, until - this.t);
    this.v = level + (this.v - level) * Math.exp(-dt / tau);
    this.t = Math.max(this.t, until);
    this.pendingAnchor = true;
    return this;
  }

  /** Exponential ramp to `level` (≥ 1e-4) at `until`. */
  expTo(level: number, until: number): this {
    const p = this.param();
    this.anchor();
    const v = Math.max(level, EXP_FLOOR);
    const end = Math.max(until, this.t + 0.001);
    expTo(p, v, end);
    this.v = v;
    this.t = end;
    return this;
  }

  /** Linear ramp to `level` at `until` (swells). */
  linTo(level: number, until: number): this {
    const p = this.param();
    this.anchor();
    const end = Math.max(until, this.t + 0.001);
    linTo(p, level, end);
    this.v = level;
    this.t = end;
    return this;
  }

  /**
   * Re-attack from 0 at `t0` (a gated pulse inside a voice). Callers let the level fall to ≤ 1e-4 first;
   * `t0` is clamped to the end of the previous segment, so a ramp is never cut short (an event inserted
   * before a ramp's end would reshape the whole ramp).
   */
  retrigger(t0: number, a: number, peak: number): this {
    const p = this.param();
    this.anchor();
    const s = Math.max(t0, this.t);
    setAt(p, 0, s);
    linTo(p, peak, s + Math.max(a, 0.001));
    this.v = peak;
    this.t = s + Math.max(a, 0.001);
    return this;
  }

  /** The final release: a linear ramp to 0 ending at `tEnd`. Returns tEnd. */
  release(tEnd: number): number {
    const p = this.param();
    this.anchor();
    const end = Math.max(tEnd, this.t + 0.002);
    linTo(p, 0, end);
    this.v = 0;
    this.t = end;
    this.p = null;
    return end;
  }

  /** Current analytic level (for callers that shape a release from it). */
  get level(): number {
    return this.v;
  }

  get time(): number {
    return this.t;
  }

  private anchor(): void {
    if (!this.pendingAnchor || !this.p) return;
    setAt(this.p, this.v, this.t);
    this.pendingAnchor = false;
  }

  private param(): AudioParamPort {
    if (!this.p) throw new Error('EnvWriter: attack() first');
    return this.p;
  }
}

/** One writer shared by every patch (patches run synchronously, one at a time). */
export const ENV = new EnvWriter();

/** Uniform deterministic variation from p.variant for index k (0..1). */
export function vary(p: PatchParams, k: number): number {
  const x = Math.sin((p.variant * 12.9898 + k * 78.233) * 43758.5453);
  return x - Math.floor(x);
}
