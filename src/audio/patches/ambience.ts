import { expTo, linTo, setAt, setValue, type AudioParamPort } from '../ports.ts';
import { ENV, envelope, filter, gainNode, noise, osc, vary, type PatchFn } from '../kit.ts';
import { AUDIO_TUNING } from '../tuning.ts';
import { mtof } from '../util.ts';
import { leaseEnv, needNoise, shape } from './common.ts';


/*
 * Ambience (§5.9 Ambience): the wind and cricket beds are long-lived lease voices outside the budgets;
 * owls, creaks and drips are rare one-shots in the ambience budget.
 */

/**
 * Wind bed: two decorrelated noise bands (a low moan and an airy hiss) whose centres and levels drift on
 * slow LFOs, panned apart. Handles: 0 = area level, 1 = gust level.
 */
export const windBed: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const level = gainNode(ctx, sink, p.gain);
  level.connect(env);
  const gust = gainNode(ctx, sink, 1);
  gust.connect(level);
  const lp = filter(ctx, sink, 'lowpass', 1800, 0);
  lp.connect(gust);

  const a = noise(ctx, sink, buf, t, 0.87, vary(p, 1));
  const bpA = filter(ctx, sink, 'bandpass', 420, 2.2);
  const lfoA = osc(ctx, sink, 'sine', 0.061, t);
  const dA = gainNode(ctx, sink, 160);
  lfoA.connect(dA);
  dA.connect(bpA.frequency);
  const gA = gainNode(ctx, sink, 0.95);
  const lfoAmp = osc(ctx, sink, 'sine', 0.093, t);
  const dAmp = gainNode(ctx, sink, 0.35);
  lfoAmp.connect(dAmp);
  dAmp.connect(gA.gain);
  const panA = ctx.createStereoPanner();
  setValue(panA.pan, -0.3);
  sink.node(panA);
  a.connect(bpA);
  bpA.connect(gA);
  gA.connect(panA);
  panA.connect(lp);

  const b = noise(ctx, sink, buf, t, 1.13, vary(p, 2));
  const bpB = filter(ctx, sink, 'bandpass', 900, 1.4);
  const lfoB = osc(ctx, sink, 'sine', 0.043, t);
  const dB = gainNode(ctx, sink, 300);
  lfoB.connect(dB);
  dB.connect(bpB.frequency);
  const gB = gainNode(ctx, sink, 0.22);
  const panB = ctx.createStereoPanner();
  setValue(panB.pan, 0.35);
  sink.node(panB);
  b.connect(bpB);
  bpB.connect(gB);
  gB.connect(panB);
  panB.connect(lp);

  sink.handle(0, level.gain);
  sink.handle(1, gust.gain);
  return leaseEnv(env.gain, t, p.attack > 0.05 ? p.attack : AUDIO_TUNING.bedFadeIn, 0.48, p.dur, 1.2);
};

/** Pulse-train curve for the cricket gates: max(0, x)² of the pulse LFO. */
function pulseCurve(): Float32Array<ArrayBuffer> {
  const n = 257;
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = x > 0 ? x * x : 0;
  }
  return c;
}

/** Three crickets: carrier Hz, pulse Hz, pan. */
export const CRICKETS = [
  [4460, 31, -0.45],
  [4930, 37, 0.35],
  [4180, 27, 0.1],
] as const;

/** Chirp length (s) of cricket i: about three and a half pulses. */
export function chirpLength(i: number): number {
  return 3.5 / ((CRICKETS[i] as readonly number[])[1] as number);
}

/** One chirp on a cricket gate: open at tc, closed by tc + len (the next chirp may start there). */
export function cricketChirp(gate: AudioParamPort, tc: number, len: number, peak: number): void {
  setAt(gate, 0, tc);
  linTo(gate, peak, tc + 0.008);
  setAt(gate, peak, tc + len - 0.012);
  linTo(gate, 0, tc + len);
}

/**
 * Cricket bed: gain-gated FM on persistent oscillators. Each cricket's carrier is frequency-modulated by
 * its pulse LFO (a small glide per pulse), amplitude-pulsed through a WaveShaper, and opened per chirp
 * by its gate. Handles: 0 = area level, 1..3 = the three chirp gates.
 */
export const cricketBed: PatchFn = (ctx, out, t, p, sink) => {
  const env = envelope(ctx, sink, out);
  const level = gainNode(ctx, sink, p.gain);
  level.connect(env);
  const lp = filter(ctx, sink, 'lowpass', 6500, 0);
  lp.connect(level);
  const curve = pulseCurve();
  for (let i = 0; i < 3; i++) {
    const c = CRICKETS[i] as readonly number[];
    const car = osc(ctx, sink, 'sine', (c[0] as number) * (0.98 + 0.04 * vary(p, i)), t);
    const lfo = osc(ctx, sink, 'sine', c[1] as number, t);
    const fm = gainNode(ctx, sink, 70);
    lfo.connect(fm);
    fm.connect(car.frequency);
    const ws = ctx.createWaveShaper();
    ws.curve = curve;
    sink.node(ws);
    const pg = gainNode(ctx, sink, 0);
    lfo.connect(ws);
    ws.connect(pg.gain);
    const gate = gainNode(ctx, sink, 0);
    const pan = ctx.createStereoPanner();
    setValue(pan.pan, c[2] as number);
    sink.node(pan);
    car.connect(pg);
    pg.connect(gate);
    gate.connect(pan);
    pan.connect(lp);
    sink.handle(1 + i, gate.gain);
    if (p.dur > 0) {
      // Offline render: a steady chorus of chirps.
      const len = chirpLength(i);
      let tc = t + 0.4 + 0.3 * i;
      let k = 0;
      while (tc + len < t + p.dur) {
        cricketChirp(gate.gain, tc, len, 1);
        k++;
        tc += len + 0.22 + 0.25 * vary(p, 10 + i * 31 + k);
      }
    }
  }
  sink.handle(0, level.gain);
  return leaseEnv(env.gain, t, p.attack > 0.05 ? p.attack : AUDIO_TUNING.bedFadeIn, 0.055, p.dur, 1.0);
};

/** A distant owl: two (sometimes three) soft hoots on p.midi, each breathy, falling, with a slight vibrato. */
export const owl: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const f = mtof(p.midi);
  const formant = filter(ctx, sink, 'bandpass', f * 1.5, 1.1);
  const fg = gainNode(ctx, sink, 0.5);
  formant.connect(fg);
  fg.connect(env);
  const breath = filter(ctx, sink, 'bandpass', f * 1.2, 1.4);
  const src = noise(ctx, sink, buf, t, 1, vary(p, 2));
  src.connect(breath);
  const vib = osc(ctx, sink, 'sine', 5.2, t);
  const three = vary(p, 1) > 0.55;
  const starts = [0, 0.62, 1.02];
  const lens = [0.42, 0.34, 0.5];
  const n = three ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const th = t + (starts[i] as number);
    const len = lens[i] as number;
    const o = osc(ctx, sink, 'sine', f * 1.03, th);
    setAt(o.frequency, f * 1.03, th);
    expTo(o.frequency, f * 0.93, th + len);
    const vd = gainNode(ctx, sink, f * 0.006);
    vib.connect(vd);
    vd.connect(o.frequency);
    const g = gainNode(ctx, sink, 0);
    ENV.attack(g.gain, th, 0.08, 1).decay(0, len * 0.45, th + len - 0.02).release(th + len);
    o.connect(g);
    g.connect(env);
    g.connect(formant);
    const bg = gainNode(ctx, sink, 0);
    ENV.attack(bg.gain, th, 0.05, 0.12).decay(0, len * 0.3, th + len - 0.02).release(th + len);
    breath.connect(bg);
    bg.connect(env);
  }
  const end = t + (starts[n - 1] as number) + (lens[n - 1] as number);
  return ENV.attack(env.gain, t, 0.02, 0.08216 * p.gain).hold(end).release(end + 0.05);
};

/** A slow wood creak: a stick-slip sawtooth through two body resonances. */
export const creak: PatchFn = (ctx, out, t, p, sink) => {
  const env = envelope(ctx, sink, out);
  const saw = osc(ctx, sink, 'sawtooth', 46 + 20 * vary(p, 1), t);
  const lfo = osc(ctx, sink, 'sine', 3 + 2.5 * vary(p, 2), t);
  const d = gainNode(ctx, sink, 12);
  lfo.connect(d);
  d.connect(saw.frequency);
  const bend = osc(ctx, sink, 'sine', 0.6, t);
  const d2 = gainNode(ctx, sink, 18);
  bend.connect(d2);
  d2.connect(saw.frequency);
  const b1 = filter(ctx, sink, 'bandpass', 620 + 220 * vary(p, 3), 6);
  const b2 = filter(ctx, sink, 'bandpass', 1450, 8);
  const g1 = gainNode(ctx, sink, 1);
  const g2 = gainNode(ctx, sink, 0.45);
  saw.connect(b1);
  saw.connect(b2);
  b1.connect(g1);
  b2.connect(g2);
  g1.connect(env);
  g2.connect(env);
  return ENV.attack(env.gain, t, 0.18, 0.297 * p.gain).hold(t + 0.75).decay(0, 0.12, t + 1.15).release(t + 1.2);
};

/** A water drip in the Rootwell: a quick upward sine plink and a tiny splash. */
export const waterDrip: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const f0 = 950 + 500 * vary(p, 1);
  const o = osc(ctx, sink, 'sine', f0, t);
  setAt(o.frequency, f0, t);
  expTo(o.frequency, f0 * 1.9, t + 0.035);
  const og = shape(ctx, sink, t, 1, 0.0015, 0.05);
  o.connect(og);
  og.connect(env);
  const bp = filter(ctx, sink, 'bandpass', 3800, 2);
  const src = noise(ctx, sink, buf, t, 1, vary(p, 2));
  const ng = shape(ctx, sink, t, 0.5, 0.001, 0.006);
  src.connect(bp);
  bp.connect(ng);
  ng.connect(env);
  return ENV.attack(env.gain, t, 0.0015, 0.0948 * p.gain).decay(0, 0.07, t + 0.4).release(t + 0.44);
};
