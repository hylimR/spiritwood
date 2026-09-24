import { expTo, hz, linTo, setAt, setValue, targetAt, type AudioParamPort } from '../ports.ts';
import { ENV, envelope, filter, gainNode, osc, vary, waveOsc, type PatchFn } from '../kit.ts';
import { mtof } from '../util.ts';
import { glassBell, leaseEnv, needNoise, noiseBand, percEnv, shape, sineDrop } from './common.ts';

/*
 * SFX patches (§5.9 SFX). Levels are calibrated so each patch alone peaks ≤ −12 dBFS per channel on its
 * bus through its voice tail (0.7071 centre gain, or a panner at |pan| ≤ 0.6); `npm run audio:render`
 * and tests/audio/render.test.ts check it. Timbres: soft air, felt, wood and glass; nothing harsh.
 */

/** Jump: a soft airy lift. */
export const jump: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const k = 0.96 + 0.08 * vary(p, 1);
  noiseBand(ctx, sink, env, buf, t, 'bandpass', 620 * k, 1500 * k, 0.07, 1.1, 1.0, 0.004, 0, vary(p, 2));
  sineDrop(ctx, sink, env, t, 300 * k, 430 * k, 0.08, 0.12, 0.06, 0.01);
  return percEnv(env.gain, t, 0.005, 0.65 * p.gain, 0.055, t + 0.22);
};

/** Air jump: the lift plus a two-note spirit sparkle from the harmony. */
export const airJump: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  noiseBand(ctx, sink, env, buf, t, 'bandpass', 900, 2100, 0.09, 1.2, 0.8, 0.005, 0, vary(p, 1));
  const n0 = p.noteCount > 0 ? (p.notes[0] as number) : 86;
  const n1 = p.noteCount > 1 ? (p.notes[1] as number) : 90;
  const sp = gainNode(ctx, sink, 1);
  sp.connect(env);
  glassBell(ctx, sink, sp, t + 0.01, mtof(n0), 0.16, 0.12, 0.5, 0.1);
  glassBell(ctx, sink, sp, t + 0.055, mtof(n1), 0.12, 0.14, 0.5, 0.1);
  return percEnv(env.gain, t, 0.006, 0.6204 * p.gain, 0.12, t + 0.42);
};

/** Wall jump: a soft wooden tok and a push of air. */
export const wallJump: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  noiseBand(ctx, sink, env, buf, t, 'bandpass', 780, 780, 0, 5, 1.3, 0.002, 0.022, vary(p, 1));
  noiseBand(ctx, sink, env, buf, t + 0.01, 'bandpass', 700, 1600, 0.08, 1.2, 0.8, 0.01, 0.05, vary(p, 2));
  sineDrop(ctx, sink, env, t, 240, 150, 0.05, 0.25, 0.03);
  return percEnv(env.gain, t, 0.003, 0.693 * p.gain, 0.07, t + 0.24);
};

/** Dash: a swift downward whoosh with a faint spirit streak. */
export const dash: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const lp = filter(ctx, sink, 'lowpass', 3200, 0);
  lp.connect(env);
  noiseBand(ctx, sink, lp, buf, t, 'bandpass', 2100, 620, 0.2, 1.3, 1.1, 0.01, 0, vary(p, 1));
  const tri = osc(ctx, sink, 'triangle', 760, t);
  setAt(tri.frequency, 760, t);
  expTo(tri.frequency, 540, t + 0.2);
  const tg = shape(ctx, sink, t, 0.08, 0.02, 0.09);
  tri.connect(tg);
  tg.connect(lp);
  return ENV.attack(env.gain, t, 0.012, 0.3774 * p.gain).hold(t + 0.07).decay(0, 0.07, t + 0.3).release(t + 0.32);
};

/** DashEnd into a wall: a muffled thud. */
export const wallThud: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  sineDrop(ctx, sink, env, t, 125, 52, 0.12, 0.9, 0.08);
  noiseBand(ctx, sink, env, buf, t, 'lowpass', 420, 420, 0, 0, 0.9, 0.002, 0.035, vary(p, 1));
  return percEnv(env.gain, t, 0.003, 0.319 * p.gain, 0.09, t + 0.3);
};

/** WallSlideStart: a tiny grip tick. */
export const gripTick: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  noiseBand(ctx, sink, env, buf, t, 'bandpass', 2300, 2300, 0, 3, 1.2, 0.0015, 0.012, vary(p, 1));
  sineDrop(ctx, sink, env, t, 1500, 1100, 0.02, 0.12, 0.012);
  return percEnv(env.gain, t, 0.002, 0.434 * p.gain, 0.02, t + 0.08);
};

/** DropThrough: a soft leafy rustle. */
export const rustle: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const bp = filter(ctx, sink, 'bandpass', 2100, 0.8);
  const lvl = gainNode(ctx, sink, 0);
  bp.connect(lvl);
  lvl.connect(env);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  sink.source(src);
  src.start(t, vary(p, 1) * (buf.length / buf.sampleRate));
  src.connect(bp);
  // Three leafy bumps.
  const g = lvl.gain;
  setAt(g, 0, t);
  linTo(g, 1, t + 0.012);
  expTo(g, 0.25, t + 0.06);
  linTo(g, 0.8, t + 0.075);
  expTo(g, 0.2, t + 0.13);
  linTo(g, 0.55, t + 0.145);
  expTo(g, 0.01, t + 0.26);
  return ENV.attack(env.gain, t, 0.004, 0.348 * p.gain).hold(t + 0.24).release(t + 0.29);
};

/** Land: a soft footfall; p.gain carries the impact loudness. */
export const land: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const heavy = p.bright;
  noiseBand(ctx, sink, env, buf, t, 'lowpass', 900 + 500 * heavy, 500, 0.06, 0.5, 0.9, 0.002, 0.04, vary(p, 1));
  sineDrop(ctx, sink, env, t, 100, 48, 0.1, 0.7 * (0.4 + 0.6 * heavy), 0.07);
  return percEnv(env.gain, t, 0.003, 0.3774 * p.gain, 0.07, t + 0.26);
};

/** OrbCollected: one glass bell note (the combo climbs the harmony's scale). */
export const orb: PatchFn = (ctx, out, t, p, sink) => {
  const env = envelope(ctx, sink, out);
  const f = mtof(p.midi);
  glassBell(ctx, sink, env, t, f, 1, 0.55, 0.8, 0.22);
  // A faint fifth above for sparkle, slightly late.
  glassBell(ctx, sink, env, t + 0.012, f * 1.5, 0.12, 0.25, 0.3, 0);
  return ENV.attack(env.gain, t, 0.003, 0.2583 * p.gain).decay(0, 0.9, t + 1.6).release(t + 1.7);
};

/** CheckpointActivated: a warm chord swell in the current harmony, crowned by a bell. */
export const checkpoint: PatchFn = (ctx, out, t, p, sink) => {
  const w = p.kit.waves;
  const env = envelope(ctx, sink, out);
  const lp = filter(ctx, sink, 'lowpass', 1700, 0);
  lp.connect(env);
  const n = Math.min(p.noteCount, 4);
  for (let i = 0; i < n; i++) {
    const f = mtof(p.notes[i] as number);
    for (let d = -1; d <= 1; d += 2) {
      const o = w ? waveOsc(ctx, sink, w.soft, f * Math.pow(2, (d * 6) / 1200), t) : osc(ctx, sink, 'triangle', f, t);
      const g = gainNode(ctx, sink, 0.13);
      o.connect(g);
      g.connect(lp);
    }
  }
  const top = n > 0 ? (p.notes[n - 1] as number) + 12 : 86;
  glassBell(ctx, sink, env, t + 0.3, mtof(top), 0.35, 0.8, 0.6, 0.15);
  return ENV.attack(env.gain, t, 0.35, 0.34 * p.gain).decay(0, 0.9, t + 3.1).release(t + 3.3);
};

/** GoalReached: a rising bell cadence onto the tonic, then a long warm chord. */
export const goal: PatchFn = (ctx, out, t, p, sink) => {
  const w = p.kit.waves;
  const env = envelope(ctx, sink, out);
  const bells = gainNode(ctx, sink, 1);
  bells.connect(env);
  const nMel = Math.min(p.noteCount, 4);
  for (let i = 0; i < nMel; i++) {
    glassBell(ctx, sink, bells, t + i * 0.24, mtof(p.notes[i] as number), i === nMel - 1 ? 0.6 : 0.45, i === nMel - 1 ? 1.6 : 0.7, 0.7, 0.2);
  }
  const lp = filter(ctx, sink, 'lowpass', 1500, 0);
  lp.connect(env);
  const tc = t + 0.24 * Math.max(0, nMel - 1);
  for (let i = 4; i < Math.min(p.noteCount, 8); i++) {
    const f = mtof(p.notes[i] as number);
    const o = w ? waveOsc(ctx, sink, w.soft, f, tc) : osc(ctx, sink, 'triangle', f, tc);
    const g = shape(ctx, sink, tc, 0.12, 0.6, 1.8);
    o.connect(g);
    g.connect(lp);
  }
  return ENV.attack(env.gain, t, 0.004, 0.2461 * p.gain).hold(tc + 0.8).decay(0, 1.1, tc + 4.6).release(tc + 4.8);
};

/** AbilityUnlocked: a grand bloom — a two-octave bell arpeggio over a swelling chord and a sub. */
export const ability: PatchFn = (ctx, out, t, p, sink) => {
  const w = p.kit.waves;
  const env = envelope(ctx, sink, out);
  const n = Math.min(p.noteCount, 8);
  const bells = gainNode(ctx, sink, 1);
  bells.connect(env);
  for (let i = 0; i < n; i++) {
    glassBell(ctx, sink, bells, t + 0.08 + i * 0.075, mtof((p.notes[i] as number) + 12), 0.2, 0.9, 0.6, 0.15);
  }
  const lp = filter(ctx, sink, 'lowpass', 1400, 0);
  lp.connect(env);
  for (let i = 0; i < Math.min(n, 4); i++) {
    const f = mtof(p.notes[i] as number);
    const o = w ? waveOsc(ctx, sink, w.soft, f, t) : osc(ctx, sink, 'triangle', f, t);
    const g = shape(ctx, sink, t, 0.1, 1.2, 0);
    o.connect(g);
    g.connect(lp);
  }
  const sub = osc(ctx, sink, 'sine', mtof(p.midi), t);
  const sg = shape(ctx, sink, t, 0.35, 1.0, 0);
  sub.connect(sg);
  sg.connect(env);
  // Shimmer: two high partials with a slow tremolo.
  const sh = gainNode(ctx, sink, 0.6);
  const lfo = osc(ctx, sink, 'sine', 5.5, t);
  const depth = gainNode(ctx, sink, 0.35);
  lfo.connect(depth);
  depth.connect(sh.gain);
  sh.connect(env);
  for (let i = 0; i < 2; i++) {
    const o = osc(ctx, sink, 'sine', mtof((p.notes[i] as number) + 24) * (1 + 0.002 * i), t + 0.5);
    const g = shape(ctx, sink, t + 0.5, 0.05, 0.8, 2.0);
    o.connect(g);
    g.connect(sh);
  }
  return ENV.attack(env.gain, t, 0.05, 0.2 * p.gain).linTo(0.25 * p.gain, t + 1.3).decay(0, 1.3, t + 5.3).release(t + 5.5);
};

/** Died: a reverse swell that falls into a low, soft thud. */
export const died: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const lp = filter(ctx, sink, 'lowpass', 300, 0.7);
  setAt(lp.frequency, 300, t);
  expTo(lp.frequency, 2600, t + 0.3);
  const swell = gainNode(ctx, sink, 0);
  setAt(swell.gain, 0, t);
  linTo(swell.gain, 0.9, t + 0.3);
  linTo(swell.gain, 0.0, t + 0.34);
  lp.connect(swell);
  swell.connect(env);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  sink.source(src);
  src.start(t, vary(p, 1) * (buf.length / buf.sampleRate));
  src.connect(lp);
  const tri = osc(ctx, sink, 'triangle', 440, t);
  setAt(tri.frequency, 440, t);
  expTo(tri.frequency, 233, t + 0.33);
  const tg = gainNode(ctx, sink, 0);
  setAt(tg.gain, 0, t);
  linTo(tg.gain, 0.22, t + 0.3);
  linTo(tg.gain, 0, t + 0.34);
  tri.connect(tg);
  tg.connect(lp);
  const tt = t + 0.32;
  sineDrop(ctx, sink, env, tt, 92, 40, 0.14, 1.0, 0.11, 0.004);
  noiseBand(ctx, sink, env, buf, tt, 'lowpass', 320, 320, 0, 0, 0.8, 0.003, 0.05, vary(p, 2));
  return ENV.attack(env.gain, t, 0.01, 0.2775 * p.gain).hold(t + 0.64).release(t + 0.69);
};

/** Respawned: a soft rising shimmer as the light gathers. */
export const respawn: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const n = Math.min(p.noteCount, 5);
  for (let i = 0; i < n; i++) {
    const tn = t + 0.05 + i * 0.065;
    const o = osc(ctx, sink, 'sine', mtof(p.notes[i] as number), tn);
    const g = shape(ctx, sink, tn, 0.22, 0.012, 0.3);
    o.connect(g);
    g.connect(env);
  }
  // Breath of air swelling with the gather.
  const bp = filter(ctx, sink, 'bandpass', 3800, 1.4);
  setAt(bp.frequency, 3800, t);
  expTo(bp.frequency, 6000, t + 0.5);
  const air = gainNode(ctx, sink, 0);
  setAt(air.gain, 0, t);
  linTo(air.gain, 0.35, t + 0.4);
  targetAt(air.gain, 0, t + 0.4, 0.2);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  sink.source(src);
  src.start(t, vary(p, 1) * (buf.length / buf.sampleRate));
  src.connect(bp);
  bp.connect(air);
  air.connect(env);
  return ENV.attack(env.gain, t, 0.02, 0.42 * p.gain).hold(t + 0.6).decay(0, 0.3, t + 1.35).release(t + 1.45);
};

/** EnemyStomped: a soft squashy thump with a small bounce. */
export const stomp: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  sineDrop(ctx, sink, env, t, 250, 105, 0.08, 0.9, 0.06);
  noiseBand(ctx, sink, env, buf, t, 'bandpass', 950, 600, 0.05, 1.8, 1.0, 0.002, 0.03, vary(p, 1));
  sineDrop(ctx, sink, env, t + 0.06, 330, 520, 0.06, 0.2, 0.05, 0.006);
  return percEnv(env.gain, t, 0.002, 0.2415 * p.gain, 0.08, t + 0.3);
};

/** EnemyReformed: a dark, bubbling swell. */
export const reform: PatchFn = (ctx, out, t, p, sink) => {
  const env = envelope(ctx, sink, out);
  const lp = filter(ctx, sink, 'lowpass', 520, 1);
  lp.connect(env);
  const tri = osc(ctx, sink, 'triangle', 70, t);
  setAt(tri.frequency, 70, t);
  expTo(tri.frequency, 140, t + 0.42);
  const tg = gainNode(ctx, sink, 0.9);
  tri.connect(tg);
  tg.connect(lp);
  sineDrop(ctx, sink, env, t + 0.36, 190, 360, 0.08, 0.35, 0.05, 0.006);
  return ENV.attack(env.gain, t, 0.3, 0.2373 * p.gain).decay(0, 0.12, t + 0.7).release(t + 0.74);
};

/** SeedFired: a wet pop (a quick sine drop plus a resonant noise bloop). */
export const seedPop: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const k = 0.94 + 0.12 * vary(p, 1);
  sineDrop(ctx, sink, env, t, 640 * k, 170 * k, 0.05, 0.9, 0.045);
  noiseBand(ctx, sink, env, buf, t, 'lowpass', 2300 * k, 480 * k, 0.05, 7, 0.35, 0.002, 0.04, vary(p, 2));
  return percEnv(env.gain, t, 0.002, 0.1943 * p.gain, 0.05, t + 0.2);
};

/** SeedBurst (terrain, expiry): a small thorny crackle. */
export const seedCrackle: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const bp = filter(ctx, sink, 'bandpass', 3000 + 800 * vary(p, 1), 1.6);
  const grains = gainNode(ctx, sink, 0);
  bp.connect(grains);
  grains.connect(env);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  sink.source(src);
  src.start(t, vary(p, 2) * (buf.length / buf.sampleRate));
  src.connect(bp);
  // Five grains; each starts after the previous one has fallen to 1e-4 (see EnvWriter.retrigger).
  const peaks = [1, 0.7, 0.55, 0.36, 0.2];
  ENV.attack(grains.gain, t, 0.001, 1).expTo(0.0001, t + 0.015);
  let tg = t;
  for (let i = 1; i < 5; i++) {
    tg += 0.02 + 0.012 * i * vary(p, 3 + i);
    ENV.retrigger(tg, 0.001, peaks[i] as number).expTo(0.0001, tg + 0.015);
  }
  sineDrop(ctx, sink, env, t, 320, 150, 0.03, 0.4, 0.025);
  return ENV.attack(env.gain, t, 0.002, 0.3968 * p.gain).hold(t + 0.15).release(t + 0.2);
};

/** SeedBurst on an enemy: a bright glass chime. */
export const seedChime: PatchFn = (ctx, out, t, p, sink) => {
  const env = envelope(ctx, sink, out);
  const f = mtof(p.midi);
  glassBell(ctx, sink, env, t, f, 1, 0.5, 1.0, 0.25);
  glassBell(ctx, sink, env, t + 0.06, f * 1.5, 0.45, 0.4, 0.6, 0.1);
  return ENV.attack(env.gain, t, 0.003, 0.1808 * p.gain).decay(0, 0.7, t + 1.45).release(t + 1.55);
};

/** EnemyHit by a flung seed: a muffled thwack and a dizzy falling tone. */
export const enemyHit: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  noiseBand(ctx, sink, env, buf, t, 'lowpass', 1500, 600, 0.05, 0.8, 1.0, 0.002, 0.035, vary(p, 1));
  sineDrop(ctx, sink, env, t, 170, 80, 0.06, 0.8, 0.06);
  const o = osc(ctx, sink, 'triangle', 560, t + 0.02);
  setAt(o.frequency, 560, t + 0.02);
  expTo(o.frequency, 270, t + 0.3);
  const vib = osc(ctx, sink, 'sine', 9, t + 0.02);
  const vd = gainNode(ctx, sink, 18);
  vib.connect(vd);
  vd.connect(o.frequency);
  const g = shape(ctx, sink, t + 0.02, 0.22, 0.01, 0.14);
  o.connect(g);
  g.connect(env);
  return percEnv(env.gain, t, 0.002, 0.2279 * p.gain, 0.12, t + 0.45);
};

/** LaunchAim: time freezes — a whoosh that sinks two octaves. */
export const launchAim: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const lp = filter(ctx, sink, 'lowpass', 2400, 0);
  lp.connect(env);
  noiseBand(ctx, sink, lp, buf, t, 'bandpass', 2600, 380, 0.45, 1.3, 1.2, 0.02, 0, vary(p, 1));
  const o = osc(ctx, sink, 'sine', mtof(p.midi), t);
  setAt(o.frequency, hz(mtof(p.midi)), t);
  expTo(o.frequency, hz(mtof(p.midi - 24)), t + 0.5);
  const g = shape(ctx, sink, t, 0.35, 0.03, 0);
  o.connect(g);
  g.connect(lp);
  return ENV.attack(env.gain, t, 0.025, 0.31 * p.gain).hold(t + 0.28).decay(0, 0.11, t + 0.64).release(t + 0.68);
};

/** Launch: a rising whoosh and a bright ping. */
export const launch: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  noiseBand(ctx, sink, env, buf, t, 'bandpass', 450, 3300, 0.18, 1.2, 1.2, 0.006, 0.11, vary(p, 1));
  glassBell(ctx, sink, env, t + 0.015, mtof(p.midi), 0.5, 0.45, 1.1, 0.25);
  return ENV.attack(env.gain, t, 0.005, 0.391 * p.gain).decay(0, 0.4, t + 1.3).release(t + 1.4);
};

/** LaunchFizzle: a soft muted tick (nothing in reach). */
export const fizzle: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  sineDrop(ctx, sink, env, t, 820, 470, 0.05, 1, 0.035);
  noiseBand(ctx, sink, env, buf, t, 'bandpass', 1800, 1800, 0, 2, 0.5, 0.002, 0.02, vary(p, 1));
  return percEnv(env.gain, t, 0.003, 0.192 * p.gain, 0.04, t + 0.16);
};

// ---- Leases (open-ended while dur ≤ 0; the lease's kill gain ends them) ----

/**
 * Wall scrape targets at slide speed k (0..1): level and band centre. The band's noise power grows with
 * its centre (constant Q), so the level folds in √(1000 / centre): only the level curve makes a faster
 * slide louder, and the peak stays within headroom at full speed.
 */
export function scrapeTargets(k: number, out: Float64Array): void {
  const x = k < 0 ? 0 : k > 1 ? 1 : k;
  const band = 1000 + 500 * x;
  out[0] = (0.55 + 0.45 * x) * Math.sqrt(1000 / band);
  out[1] = band;
}

/**
 * Wall scrape: bark-and-moss friction noise with a slow grain. Handles: 0 = level, 1 = band centre
 * (steered with scrapeTargets).
 */
export const scrape: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const level = gainNode(ctx, sink, 0.7);
  level.connect(env);
  const am = gainNode(ctx, sink, 0.7);
  am.connect(level);
  const lfo = osc(ctx, sink, 'sine', 11 + 4 * vary(p, 1), t);
  const depth = gainNode(ctx, sink, 0.3);
  lfo.connect(depth);
  depth.connect(am.gain);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  setValue(src.playbackRate, 0.9);
  sink.source(src);
  src.start(t, vary(p, 2) * (buf.length / buf.sampleRate));
  const bp = filter(ctx, sink, 'bandpass', 1100, 1.3);
  const hi = filter(ctx, sink, 'bandpass', 2400, 2);
  const hg = gainNode(ctx, sink, 0.25);
  src.connect(bp);
  src.connect(hi);
  hi.connect(hg);
  bp.connect(am);
  hg.connect(am);
  sink.handle(0, level.gain);
  sink.handle(1, bp.frequency);
  return leaseEnv(env.gain, t, 0.04, 0.55 * p.gain, p.dur, 0.08);
};

/**
 * Aim sustain: a hushed ringing chord (three harmony tones, each a slowly beating sine pair) with a
 * gentle tremolo. Handle 0 = level.
 */
export const aimSustain: PatchFn = (ctx, out, t, p, sink) => {
  const env = envelope(ctx, sink, out);
  const level = gainNode(ctx, sink, 0.8);
  level.connect(env);
  const trem = gainNode(ctx, sink, 0.8);
  trem.connect(level);
  const lfo = osc(ctx, sink, 'sine', 4.2, t);
  const depth = gainNode(ctx, sink, 0.2);
  lfo.connect(depth);
  depth.connect(trem.gain);
  const n = Math.min(p.noteCount, 3);
  for (let i = 0; i < n; i++) {
    const f = mtof(p.notes[i] as number);
    const a = osc(ctx, sink, 'sine', f, t);
    const b = osc(ctx, sink, 'sine', f * 1.0035, t);
    const g = gainNode(ctx, sink, 0.2 / (1 + i * 0.4));
    a.connect(g);
    b.connect(g);
    g.connect(trem);
  }
  sink.handle(0, level.gain);
  return leaseEnv(env.gain, t, 0.3, 0.38 * p.gain, p.dur, 0.15);
};

/** Heartbeat interval (s) at aim progress k (0..1): speeds up as the aim runs out. */
export function heartbeatInterval(k: number): number {
  const x = k < 0 ? 0 : k > 1 ? 1 : k;
  return 0.66 - 0.3 * x * x;
}

/** Length of one lub-dub; below the shortest heartbeatInterval, so beats never overlap. */
export const HEARTBEAT_BEAT_SEC = 0.33;

/**
 * One lub-dub on the heartbeat's beat gain at tb (strength 0..1); ends by tb + HEARTBEAT_BEAT_SEC. The
 * beat gain sits before the low-pass, so the thumps stay round.
 */
export function heartbeatBeat(g: AudioParamPort, tb: number, strength: number): void {
  ENV.attack(g, tb, 0.02, strength).expTo(0.0001, tb + 0.15);
  ENV.retrigger(tb + 0.17, 0.02, 0.62 * strength).expTo(0.0001, tb + HEARTBEAT_BEAT_SEC);
}

/**
 * Heartbeat: a soft low lub-dub on a persistent oscillator, gated per beat before a low-pass. The lease
 * updater books later beats through handle 0 (the beat gain) with heartbeatBeat.
 */
export const heartbeat: PatchFn = (ctx, out, t, p, sink) => {
  const w = p.kit.waves;
  const env = envelope(ctx, sink, out);
  // 64 Hz with its 2nd and 3rd harmonics kept: still a soft thump, but audible on laptop speakers.
  const lp = filter(ctx, sink, 'lowpass', 260, 0);
  const lvl = gainNode(ctx, sink, 0.293 * p.gain);
  lp.connect(lvl);
  lvl.connect(env);
  const beat = gainNode(ctx, sink, 0);
  beat.connect(lp);
  const o = w ? waveOsc(ctx, sink, w.warm, 64, t) : osc(ctx, sink, 'sine', 64, t);
  o.connect(beat);
  sink.handle(0, beat.gain);
  heartbeatBeat(beat.gain, t, 1);
  if (!(p.dur > 0)) return leaseEnv(env.gain, t, 0.01, 1, 0, 0);
  let tb = t + heartbeatInterval(0);
  while (tb < t + p.dur) {
    heartbeatBeat(beat.gain, tb, 1);
    tb += heartbeatInterval((tb - t) / p.dur);
  }
  return leaseEnv(env.gain, t, 0.01, 1, tb - t, 0.05);
};

/** Rattle level at the start of the windup (= rattleTargets(0)[0]). */
const RATTLE_LEVEL0 = 0.35;

/**
 * Windup rattle: thorny noise buzzing through a rising band with a tense undertone. Handles: 0 = level,
 * 1 = band centre, 2 = buzz rate, 3 = undertone pitch. The lease sets them from the windup progress; the
 * level carries the spatial gain (p.gain at the start, then steered), so the envelope peak is fixed.
 */
export const rattle: PatchFn = (ctx, out, t, p, sink) => {
  const buf = needNoise(p);
  const env = envelope(ctx, sink, out);
  const lv = RATTLE_LEVEL0 * p.gain;
  const level = gainNode(ctx, sink, lv);
  level.connect(env);
  const buzz = gainNode(ctx, sink, 0.55);
  buzz.connect(level);
  const lfo = osc(ctx, sink, 'sine', 16, t);
  const depth = gainNode(ctx, sink, 0.45);
  lfo.connect(depth);
  depth.connect(buzz.gain);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.loop = true;
  sink.source(src);
  src.start(t, vary(p, 1) * (buf.length / buf.sampleRate));
  const bp = filter(ctx, sink, 'bandpass', 1400, 3.2);
  src.connect(bp);
  bp.connect(buzz);
  const tone = osc(ctx, sink, 'triangle', 220, t);
  const tlp = filter(ctx, sink, 'lowpass', 900, 0);
  const tg = gainNode(ctx, sink, 0.055);
  tone.connect(tlp);
  tlp.connect(tg);
  tg.connect(level);
  sink.handle(0, level.gain);
  sink.handle(1, bp.frequency);
  sink.handle(2, lfo.frequency);
  sink.handle(3, tone.frequency);
  if (p.dur > 0) {
    // Offline render: sweep the windup over dur along rattleTargets (every curve anchored at t).
    const tg = new Float64Array(4);
    setAt(level.gain, lv, t);
    for (let i = 1; i <= 8; i++) {
      rattleTargets(i / 8, tg);
      linTo(level.gain, (tg[0] as number) * p.gain, t + (p.dur * i) / 8);
    }
    setAt(bp.frequency, 1400, t);
    expTo(bp.frequency, 3000, t + p.dur);
    setAt(lfo.frequency, 16, t);
    linTo(lfo.frequency, 38, t + p.dur);
    setAt(tone.frequency, 220, t);
    expTo(tone.frequency, 440, t + p.dur);
  }
  return leaseEnv(env.gain, t, 0.06, 0.5733, p.dur, 0.06);
};

/**
 * Windup rattle targets at progress k (0..1): level, band centre, buzz rate, undertone. As with the
 * scrape, the level folds in √(1400 / centre), so the crescendo comes from the level curve alone.
 */
export function rattleTargets(k: number, out: Float64Array): void {
  const x = k < 0 ? 0 : k > 1 ? 1 : k;
  const band = 1400 * Math.pow(3000 / 1400, x);
  out[0] = (RATTLE_LEVEL0 + (1 - RATTLE_LEVEL0) * x * x) * Math.sqrt(1400 / band);
  out[1] = band;
  out[2] = 16 + 22 * x;
  out[3] = 220 * Math.pow(2, x);
}
