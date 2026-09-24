import { expTo, setAt, setValue } from '../ports.ts';
import { ENV, envelope, filter, gainNode, osc, vary, waveOsc, type PatchFn } from '../kit.ts';
import { mtof } from '../util.ts';
import { detuned, glassBell, needNoise, shape } from './common.ts';

/*
 * Music instruments (§5.9 Music). Every note is a voice in the music budget; pan, filter and the reverb
 * send are bus-level. Timbres: breathy pads, glass bells, felt piano, a soft low pulse, a dark reed
 * drone, resonant drips, whole-tone shimmer and natural harmonics. p.notes / p.midi come from the
 * shared Harmony.
 */

/**
 * Breathy pad chord: per note two detuned soft-saw oscillators, a sine sub on p.midi (when > 0), a
 * breath of band-passed noise, through one static low-pass (p.bright). Attack p.attack, hold p.dur,
 * exponential release p.release.
 */
export const pad: PatchFn = (ctx, out, t, p, sink) => {
  const w = p.kit.waves;
  const env = envelope(ctx, sink, out);
  const cutoff = 450 + 2600 * p.bright * p.bright;
  const lp = filter(ctx, sink, 'lowpass', cutoff, 0);
  lp.connect(env);
  const n = Math.min(p.noteCount, 4);
  const per = 0.24 / Math.max(1, n);
  for (let i = 0; i < n; i++) {
    const m = p.notes[i] as number;
    for (let d = 0; d < 2; d++) {
      const f = detuned(m, d === 0 ? 0.15 * vary(p, i) : 1 - 0.15 * vary(p, i + 7), 7);
      const o = w ? waveOsc(ctx, sink, w.soft, f, t) : osc(ctx, sink, 'sawtooth', f, t);
      // Unequal pair: a gentle chorus rather than full-depth beating.
      const g = gainNode(ctx, sink, d === 0 ? per * 1.15 : per * 0.65);
      o.connect(g);
      g.connect(lp);
    }
  }
  if (p.midi > 0) {
    const sub = osc(ctx, sink, 'sine', mtof(p.midi), t);
    const sg = gainNode(ctx, sink, 0.07);
    sub.connect(sg);
    sg.connect(env);
  }
  const buf = p.kit.noise;
  if (buf) {
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    setValue(src.playbackRate, 0.8 + 0.3 * vary(p, 3));
    sink.source(src);
    src.start(t, vary(p, 4) * (buf.length / buf.sampleRate));
    const bp = filter(ctx, sink, 'bandpass', Math.min(cutoff * 1.6, 5000), 0.9);
    const bg = gainNode(ctx, sink, 0.06 + 0.1 * p.bright);
    src.connect(bp);
    bp.connect(bg);
    bg.connect(env);
  }
  const hold = t + p.attack + Math.max(0, p.dur);
  return ENV.attack(env.gain, t, p.attack, 0.57 * p.gain).hold(hold).decay(0, p.release / 4, hold + p.release - 0.05).release(hold + p.release);
};

/**
 * Glass bell melody note: p.midi, ring time p.dur (tau). The body decays with tau under an envelope
 * decaying with 1.1·tau, so by 2·tau the note is 33 dB down and the voice ends (the reverb carries on).
 */
export const bell: PatchFn = (ctx, out, t, p, sink) => {
  const env = envelope(ctx, sink, out);
  const f = mtof(p.midi);
  const tau = Math.max(0.3, p.dur);
  glassBell(ctx, sink, env, t, f, 1, tau, 0.55 + 0.4 * p.bright, 0.18);
  return ENV.attack(env.gain, t, 0.004, 0.213 * p.gain).decay(0, tau * 1.1, t + tau * 2).release(t + tau * 2 + 0.1);
};

/**
 * Felt piano note: a felt-hammered body (bright, fast decay, static low-pass) over a pure core that
 * rings longer, with a whisper of hammer felt. p.dur = hold before a gentle damper release.
 */
export const piano: PatchFn = (ctx, out, t, p, sink) => {
  const w = p.kit.waves;
  const env = envelope(ctx, sink, out);
  const f = mtof(p.midi);
  const lp = filter(ctx, sink, 'lowpass', Math.min(f * (5 + 4 * p.bright), 5200), 0);
  lp.connect(env);
  const body = w ? waveOsc(ctx, sink, w.felt, f, t) : osc(ctx, sink, 'triangle', f, t);
  const bg = shape(ctx, sink, t, 0.55, 0.004, 0.32);
  body.connect(bg);
  bg.connect(lp);
  const core = osc(ctx, sink, 'sine', f * 1.0008, t);
  const ring = 1.6 * Math.pow(261.6 / f, 0.35);
  const cg = shape(ctx, sink, t, 0.45, 0.006, ring);
  core.connect(cg);
  cg.connect(env);
  const h2 = osc(ctx, sink, 'sine', f * 2.0015, t);
  const hg = shape(ctx, sink, t, 0.08, 0.005, ring * 0.4);
  h2.connect(hg);
  hg.connect(lp);
  const hold = t + Math.max(0.2, p.dur);
  return ENV.attack(env.gain, t, 0.005, 0.2385 * p.gain).hold(hold).decay(0, 0.12, hold + 0.45).release(hold + 0.5);
};

/** Low pulse: a soft, round bass beat on p.midi (audible on small speakers through its harmonics). */
export const pulse: PatchFn = (ctx, out, t, p, sink) => {
  const w = p.kit.waves;
  const env = envelope(ctx, sink, out);
  const f = mtof(p.midi);
  const lp = filter(ctx, sink, 'lowpass', 340, 0);
  lp.connect(env);
  const o = w ? waveOsc(ctx, sink, w.warm, f, t) : osc(ctx, sink, 'triangle', f, t);
  setAt(o.frequency, f * 1.06, t);
  expTo(o.frequency, f, t + 0.04);
  o.connect(lp);
  return ENV.attack(env.gain, t, 0.012, 0.245 * p.gain).decay(0, 0.26, t + 0.95).release(t + 1.0);
};

/** Dark drone: reed tones on the bass and its fifth, plus a detuned octave, under a low low-pass. */
export const drone: PatchFn = (ctx, out, t, p, sink) => {
  const w = p.kit.waves;
  const env = envelope(ctx, sink, out);
  // Slow breathing on the drone level.
  const breath = gainNode(ctx, sink, 0.8);
  breath.connect(env);
  const lfo = osc(ctx, sink, 'sine', 0.11 + 0.05 * vary(p, 1), t);
  const depth = gainNode(ctx, sink, 0.2);
  lfo.connect(depth);
  depth.connect(breath.gain);
  const lp = filter(ctx, sink, 'lowpass', 300 + 250 * p.bright, 0.5);
  lp.connect(breath);
  const f = mtof(p.midi);
  const parts = [1, 1.5, 2.004];
  const lv = [0.5, 0.26, 0.2];
  for (let i = 0; i < 3; i++) {
    const o = w ? waveOsc(ctx, sink, w.reed, f * (parts[i] as number), t) : osc(ctx, sink, 'triangle', f * (parts[i] as number), t);
    const g = gainNode(ctx, sink, lv[i] as number);
    o.connect(g);
    g.connect(lp);
  }
  const hold = t + p.attack + Math.max(0, p.dur);
  return ENV.attack(env.gain, t, p.attack, 0.261 * p.gain).hold(hold).decay(0, p.release / 4, hold + p.release - 0.05).release(hold + p.release);
};

/** Resonant drip: a sine that slides up into p.midi, plus noise ringing through a narrow band. */
export const drip: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const f = mtof(p.midi);
  const o = osc(ctx, sink, 'sine', f * 0.74, t);
  setAt(o.frequency, f * 0.74, t);
  expTo(o.frequency, f, t + 0.022);
  const og = shape(ctx, sink, t, 0.8, 0.002, 0.16);
  o.connect(og);
  og.connect(env);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  sink.source(src);
  src.start(t, vary(p, 1) * (buf.length / buf.sampleRate));
  const bp = filter(ctx, sink, 'bandpass', f, 40);
  const ng = shape(ctx, sink, t, 6, 0.001, 0.012);
  src.connect(ng);
  ng.connect(bp);
  bp.connect(env);
  // The plink (τ 0.16 under the envelope's 0.3) is 58 dB down by 0.7 s.
  return ENV.attack(env.gain, t, 0.002, 0.2044 * p.gain).decay(0, 0.3, t + 0.7).release(t + 0.75);
};

/** Whole-tone shimmer: a high sine with a soft second harmonic under a slow tremolo. */
export const shimmer: PatchFn = (ctx, out, t, p, sink) => {
  const env = envelope(ctx, sink, out);
  const f = mtof(p.midi);
  const trem = gainNode(ctx, sink, 0.7);
  trem.connect(env);
  const lfo = osc(ctx, sink, 'sine', 4.6 + 1.4 * vary(p, 1), t);
  const depth = gainNode(ctx, sink, 0.3);
  lfo.connect(depth);
  depth.connect(trem.gain);
  const a = osc(ctx, sink, 'sine', f, t);
  const ag = gainNode(ctx, sink, 0.8);
  a.connect(ag);
  ag.connect(trem);
  const b = osc(ctx, sink, 'sine', f * 2.003, t);
  const bg = gainNode(ctx, sink, 0.12);
  b.connect(bg);
  bg.connect(trem);
  return ENV.attack(env.gain, t, 0.5, 0.237 * p.gain).decay(0, 0.7, t + 2.6).release(t + 2.7);
};

/**
 * Natural harmonics of p.midi (5th, 7th, 9th, 11th partials, picked by p.variant): tense, pure and very
 * quiet, each swelling on its own.
 */
export const harmonics: PatchFn = (ctx, out, t, p, sink) => {
  const env = envelope(ctx, sink, out);
  const f = mtof(p.midi);
  const set = [5, 7, 9, 11];
  const skip = Math.floor(vary(p, 1) * 4);
  let k = 0;
  for (let i = 0; i < 4; i++) {
    if (i === skip) continue;
    const h = set[i] as number;
    const o = osc(ctx, sink, 'sine', f * h * (1 + 0.0015 * (vary(p, 2 + i) - 0.5)), t);
    const tn = t + k * 0.9 * (0.6 + vary(p, 5 + i));
    const g = shape(ctx, sink, tn, 0.22 / (1 + 0.25 * k), 1.6, 0);
    o.connect(g);
    g.connect(env);
    k++;
  }
  const hold = t + p.attack + Math.max(0, p.dur);
  return ENV.attack(env.gain, t, p.attack, 0.323 * p.gain).hold(hold).decay(0, p.release / 4, hold + p.release - 0.05).release(hold + p.release);
};
