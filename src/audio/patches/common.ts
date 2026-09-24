import {
  expTo, hz, linTo, setAt, targetAt, type AudioBufferPort, type AudioNodePort, type AudioParamPort,
  type GainNodePort, type GraphPort, type VoiceSink,
} from '../ports.ts';
import { ENV, filter, gainNode, osc, type PatchParams } from '../kit.ts';
import { mtof } from '../util.ts';

export function needNoise(p: PatchParams): AudioBufferPort {
  const n = p.kit.noise;
  if (!n) throw new Error('patch needs the noise buffer');
  return n;
}

/**
 * A shaping gain for one component of a voice: silent until `t`, a short linear rise to `level`, then an
 * exponential fall with `tau` (0 = held). Components that start after the voice envelope's attack get
 * their own rise, so no component ever steps.
 */
export function shape(ctx: GraphPort, sink: VoiceSink, t: number, level: number, a: number, tau: number): GainNodePort {
  const g = gainNode(ctx, sink, 0);
  setAt(g.gain, 0, t);
  linTo(g.gain, level, t + a);
  if (tau > 0) targetAt(g.gain, 0, t + a, tau);
  return g;
}

/**
 * A glass-bell partial stack into `dest`: a sine carrier with a light inharmonic FM shimmer (ratio 3.5,
 * index decaying fast) plus a soft octave partial. The index shrinks for high notes, so their sidebands
 * sparkle instead of piercing.
 */
export function glassBell(
  ctx: GraphPort, sink: VoiceSink, dest: AudioNodePort, t: number, f: number, level: number, tau: number,
  index = 0.9, octave = 0.2,
): void {
  const car = osc(ctx, sink, 'sine', f, t);
  const mod = osc(ctx, sink, 'sine', f * 3.5, t);
  const depth = gainNode(ctx, sink, 0);
  const beta = index * Math.min(1, Math.pow(700 / f, 0.75));
  setAt(depth.gain, f * 3.5 * beta, t);
  targetAt(depth.gain, f * 3.5 * beta * 0.04, t + 0.004, 0.09);
  mod.connect(depth);
  depth.connect(car.frequency);
  const body = shape(ctx, sink, t, level, 0.005, tau);
  car.connect(body);
  body.connect(dest);
  if (octave > 0) {
    const o2 = osc(ctx, sink, 'sine', f * 2.003, t);
    const g2 = shape(ctx, sink, t, level * octave, 0.003, tau * 0.45);
    o2.connect(g2);
    g2.connect(dest);
  }
}

/** A percussive sine drop (thumps, pops): f0 → f1 exponentially over `glide` s, decaying with `tau`. */
export function sineDrop(
  ctx: GraphPort, sink: VoiceSink, dest: AudioNodePort, t: number, f0: number, f1: number, glide: number,
  level: number, tau: number, a = 0.002,
): void {
  const o = osc(ctx, sink, 'sine', f0, t);
  setAt(o.frequency, hz(f0), t);
  expTo(o.frequency, hz(f1), t + glide);
  const g = shape(ctx, sink, t, level, a, tau);
  o.connect(g);
  g.connect(dest);
}

/**
 * Filtered noise with its own level shape into `dest`: the filter sweeps f0 → f1 over `sweep` s and the
 * level rises over `a` then decays with `tau` (0 = held). Returns the level gain for extra shaping.
 */
export function noiseBand(
  ctx: GraphPort, sink: VoiceSink, dest: AudioNodePort, buf: AudioBufferPort, t: number,
  type: 'bandpass' | 'lowpass' | 'highpass', f0: number, f1: number, sweep: number, q: number, level: number,
  a: number, tau: number, offset: number,
): GainNodePort {
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  sink.source(src);
  src.start(t, (offset - Math.floor(offset)) * (buf.length / buf.sampleRate));
  const f = filter(ctx, sink, type, f0, q);
  if (sweep > 0 && f1 !== f0) {
    setAt(f.frequency, hz(f0), t);
    expTo(f.frequency, hz(f1), t + sweep);
  }
  const g = shape(ctx, sink, t, level, a, tau);
  src.connect(f);
  f.connect(g);
  g.connect(dest);
  return g;
}

/** Midi → Hz with a deterministic detune of ±cents·(2·v − 1). */
export function detuned(midi: number, v: number, cents: number): number {
  return mtof(midi) * Math.pow(2, ((2 * v - 1) * cents) / 1200);
}

/** The standard percussive voice envelope: attack, exponential tail, final linear release at tEnd. */
export function percEnv(g: AudioParamPort, t: number, a: number, peak: number, tau: number, tEnd: number): number {
  return ENV.attack(g, t, a, peak).decay(0, tau, tEnd - 0.02).release(tEnd);
}

/** Open-ended envelope for leases; with dur > 0 (offline renders) it releases over `rel` after `dur`. */
export function leaseEnv(g: AudioParamPort, t: number, a: number, peak: number, dur: number, rel: number): number {
  ENV.attack(g, t, a, peak);
  if (!(dur > 0)) return -1;
  return ENV.hold(t + a + dur).decay(0, rel / 4, t + a + dur + rel - 0.02).release(t + a + dur + rel);
}
