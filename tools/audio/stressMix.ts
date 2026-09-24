import { join } from 'node:path';
import { AudioSystem } from '../../src/audio/audio.ts';
import type { AudioFrame, AudioVolumes } from '../../src/contracts/audio.ts';
import { AREA_GRADES, type LevelData } from '../../src/contracts/level.ts';
import { DeathCause, EnemyHitCause, SeedBurstCause, SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../../tests/shared/fixtures.ts';
import { db, peakOf, rmsOf } from './analyze.ts';
import { OfflineRealtime } from './offlineContext.ts';
import type { OfflineCtor } from './patchRender.ts';
import { writeSpectrogramPng } from './spectrogram.ts';
import { writeWav16 } from './wav.ts';

const SR = 48000;
const FPS = 60;
/** Tiles per area in the synthetic tour level (six areas side by side). */
const AREA_TILES = 32;
const TILE = 48;

/** A flat tour level: six grade zones left to right, two player-aimed spitters in the veil. */
export function tourLevel(): LevelData {
  const w = AREA_TILES * AREA_GRADES.length;
  const rows: string[] = [];
  for (let y = 0; y < 22; y++) rows.push(' '.repeat(w));
  const spit = ' '.repeat(w).split('');
  spit[AREA_TILES * 4 + 8] = 'S';
  spit[AREA_TILES * 4 + 18] = 'S';
  rows.push(spit.join(''));
  rows.push('#'.repeat(w));
  const level = levelFromAscii(rows, { id: 'audio-tour', seed: 20260924 });
  for (let a = 0; a < AREA_GRADES.length; a++) {
    level.gradeZones.push({
      id: a, grade: AREA_GRADES[a] as (typeof AREA_GRADES)[number], x: a * AREA_TILES * TILE, y: 0,
      w: AREA_TILES * TILE, h: level.pxHeight, blend: 288,
    });
  }
  return level;
}

/** Centre x of area i in the tour level. */
export function areaX(i: number): number {
  return (i + 0.5) * AREA_TILES * TILE;
}

export interface SceneResult {
  seconds: number;
  events: number;
  preDb: number;
  postDb: number;
  rmsDb: number;
  maxVoices: number;
  renderMs: number;
  cpuPct: number;
  updateAvgMs: number;
  updateMaxMs: number;
  post: Float32Array[];
  /** Voices started per patch over the scene. */
  started: Record<string, number>;
  /** Frames node-web-audio-api skipped (a rejected suspend point); their events land on the next frame. */
  skipped: number;
  /** Channels 2–3: the master Gain (the compressor's input), or the dry SFX bus with tapSfx. */
  tap: Float32Array[];
  /** currentTime at the last update() (see stopUpdatesAt). */
  lastUpdate: number;
}

export interface SceneScript {
  seconds: number;
  volumes: AudioVolumes;
  /** Stop calling update() (and delivering events) after this time, like a hidden tab. */
  stopUpdatesAt?: number;
  /** Tap the dry SFX bus (its volume Gain) instead of the master Gain on channels 2–3. */
  tapSfx?: boolean;
  /**
   * Called every driven frame before update(): move the camera and player, set state, emit events. `prev`
   * is the time of the previous driven frame; an event belongs to the first frame whose (prev, t] holds its
   * time (node-web-audio-api occasionally skips a few suspend points, so exact frames can be missed).
   */
  frame(t: number, prev: number, sim: FakeSim, af: AudioFrame, emit: (e: Partial<SimEvent> & Pick<SimEvent, 'type'>) => void): void;
}

/**
 * Run the real AudioSystem on an OfflineAudioContext, suspending at every 60 Hz frame to deliver events
 * and call update(). Channels 0–1 are the output after the master chain; 2–3 tap the master Gain (the
 * compressor's input), for the pre/post headroom check.
 */
export async function runScene(Offline: OfflineCtor, script: SceneScript, seed = 20260924): Promise<SceneResult> {
  const level = tourLevel();
  const sim = createFakeSimView(level);
  const len = Math.round(script.seconds * SR);
  const off = new Offline(4, len, SR);
  const merger = off.createChannelMerger(4);
  merger.connect(off.destination);
  const post = off.createChannelSplitter(2);
  post.connect(merger, 0, 0);
  post.connect(merger, 1, 1);
  const pre = off.createChannelSplitter(2);
  pre.connect(merger, 0, 2);
  pre.connect(merger, 1, 3);
  const port = new OfflineRealtime(off, post);
  const audio = new AudioSystem({ createContext: () => port, gestureTarget: null, seed });
  audio.setVolumes(script.volumes);
  audio.unlock();
  const engine = audio.inspect;
  if (!engine) throw new Error('engine did not start');
  (script.tapSfx ? engine.mixer.sfx : engine.mixer.master).connect(pre);
  // Build the buffers up front, as the first frames of a session would.
  engine.buffers.finish();
  engine.kit.noise = engine.buffers.noise;

  const af: AudioFrame = { dt: 1 / FPS, camX: 0, camY: 0, viewW: sim.camera.viewW, viewH: sim.camera.viewH, sim, paused: false };
  let events = 0;
  let skipped = 0;
  let maxVoices = 0;
  let updSum = 0;
  let updMax = 0;
  let updN = 0;
  const pending: SimEvent[] = [];
  const emit = (e: Partial<SimEvent> & Pick<SimEvent, 'type'>): void => {
    pending.push({ tick: 0, x: sim.player.x, y: sim.player.y, a: 0, b: 0, id: -1, ...e });
  };
  // node-web-audio-api rejects suspend points in the last moments of a render; stop driving 1 s early.
  const frames = Math.floor((Math.min(script.seconds - 1, script.stopUpdatesAt ?? Infinity)) * FPS);
  let prev = 0;
  let lastUpdate = 0;
  for (let k = 1; k <= frames; k++) {
    void off.suspend(k / FPS).then(() => {
      const t = k / FPS;
      pending.length = 0;
      script.frame(t, prev, sim, af, emit);
      prev = t;
      sim.camera.x = af.camX;
      sim.camera.y = af.camY;
      for (const e of pending) audio.onSimEvent(e, af);
      events += pending.length;
      audio.update(af);
      lastUpdate = engine.now;
      if (k > 30) {
        updSum += audio.stats.updateMs;
        updMax = Math.max(updMax, audio.stats.updateMs);
        updN++;
      }
      maxVoices = Math.max(maxVoices, audio.stats.voices);
      void off.resume();
    }, () => {
      skipped++;
    });
  }
  const t0 = performance.now();
  const buf = await off.startRendering();
  const renderMs = performance.now() - t0;
  if (audio.stats.state !== 'running') throw new Error(`audio ended ${audio.stats.state}`);
  const started: Record<string, number> = {};
  for (const [id, n] of Object.entries(engine.started)) if (n > 0) started[id] = n;
  audio.destroy();
  const outL = buf.getChannelData(0);
  const outR = buf.getChannelData(1);
  const preL = buf.getChannelData(2);
  const preR = buf.getChannelData(3);
  return {
    seconds: script.seconds, events, maxVoices, renderMs, cpuPct: (renderMs / (script.seconds * 1000)) * 100,
    preDb: db(Math.max(peakOf(preL), peakOf(preR))), postDb: db(Math.max(peakOf(outL), peakOf(outR))),
    rmsDb: db(Math.max(rmsOf(outL), rmsOf(outR))), updateAvgMs: updSum / Math.max(1, updN), updateMaxMs: updMax,
    post: [new Float32Array(outL), new Float32Array(outR)], started, skipped,
    tap: [new Float32Array(preL), new Float32Array(preR)], lastUpdate,
  };
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * Math.min(1, Math.max(0, t));
}

/** Camera x along the tour: glade → gully → rootwell (freeze) → canopy → veil (windups) → shrine. */
function tourX(t: number): number {
  if (t < 6) return areaX(0);
  if (t < 9) return lerp(areaX(0), areaX(1), (t - 6) / 3);
  if (t < 11) return lerp(areaX(1), areaX(2), (t - 9) / 2);
  if (t < 13.5) return areaX(2);
  if (t < 16) return lerp(areaX(2), areaX(3), (t - 13.5) / 2.5);
  if (t < 19) return lerp(areaX(3), areaX(4), (t - 16) / 3);
  if (t < 22) return lerp(areaX(4), areaX(5), (t - 19) / 3);
  return areaX(5);
}

/** The frame covering (prev, t] contains `when`. */
function at(t: number, prev: number, when: number): boolean {
  return prev < when && when <= t;
}

type FrameFn = SceneScript['frame'];

/**
 * The worst case: sliders at 1, a frame with ~40 simultaneous events of every kind, an eight-orb pickup,
 * area cross-fades through all six moods (camera `camAt`), a wall slide, a 1.8 s freeze, two spitter
 * windups, a death and a respawn, and a pause.
 */
function stressFrame(camAt: (t: number) => number): FrameFn {
  return (t, prev, sim, af, emit) => {
    af.camX = camAt(t);
    af.camY = 700;
    const p = sim.player;
    p.x = af.camX;
    p.y = af.camY + 300;
    p.mode = 'ground';
    p.vy = 0;
    af.paused = t >= 24 && t < 25;
    // Movement rhythm.
    const beat = Math.floor((t - 0.5) / 0.7);
    if (t >= 0.5 && at(t, prev, 0.5 + beat * 0.7)) emit({ type: SimEventType.Jump, a: 1 });
    if (t >= 0.95 && at(t, prev, 0.95 + Math.floor((t - 0.95) / 0.7) * 0.7)) emit({ type: SimEventType.Land, a: 820, b: 170 });
    if (at(t, prev, 2) || at(t, prev, 7.5) || at(t, prev, 15)) emit({ type: SimEventType.Dash, a: 1 });
    // Orb burst: eight in one frame, then the combo continues.
    if (at(t, prev, 3)) for (let i = 0; i < 8; i++) emit({ type: SimEventType.OrbCollected, a: 1, id: i });
    if (at(t, prev, 3.3) || at(t, prev, 3.6) || at(t, prev, 3.9)) emit({ type: SimEventType.OrbCollected, a: 1, id: 9 });
    // The pile-up frame.
    if (at(t, prev, 4.5)) {
      const x = af.camX + 200;
      const y = af.camY;
      const types = [
        SimEventType.Jump, SimEventType.AirJump, SimEventType.WallJump, SimEventType.Dash, SimEventType.DropThrough,
        SimEventType.WallSlideStart, SimEventType.LaunchFizzle, SimEventType.CheckpointActivated, SimEventType.AbilityUnlocked,
        SimEventType.GoalReached, SimEventType.EnemyStomped, SimEventType.EnemyReformed,
      ];
      for (const type of types) emit({ type, x, y });
      emit({ type: SimEventType.DashEnd, b: 2 });
      emit({ type: SimEventType.Land, a: 1300, b: 400 });
      emit({ type: SimEventType.EnemyHit, x, y, a: EnemyHitCause.Seed, id: 0 });
      for (let i = 0; i < 5; i++) emit({ type: SimEventType.SeedFired, x: x - 300 + 100 * i, y, id: i });
      for (let i = 0; i < 6; i++) emit({ type: SimEventType.SeedBurst, x: x - 400 + 150 * i, y, a: SeedBurstCause.Terrain, id: i });
      for (let i = 0; i < 2; i++) emit({ type: SimEventType.SeedBurst, x, y, a: SeedBurstCause.Enemy, b: 1, id: 6 + i });
      for (let i = 0; i < 4; i++) emit({ type: SimEventType.OrbCollected, a: 1, id: 20 + i });
    }
    // Wall slide.
    if (t >= 9 && t < 10.5) {
      p.mode = 'wallSlide';
      p.vy = 190;
    }
    if (at(t, prev, 9)) emit({ type: SimEventType.WallSlideStart, a: 1 });
    if (at(t, prev, 10.5)) emit({ type: SimEventType.WallSlideEnd, a: 1 });
    // Freeze: aim for 1.8 s, then launch.
    const L = sim.launch;
    L.aimMaxTicks = 120;
    sim.frozen = t >= 12 && t < 13.8;
    if (sim.frozen) {
      p.mode = 'launchAim';
      L.aimTicks = Math.floor((t - 12) * 60);
    }
    if (at(t, prev, 12)) emit({ type: SimEventType.LaunchAim, x: af.camX + 120, y: af.camY, a: 1, id: 3 });
    if (at(t, prev, 13.8)) emit({ type: SimEventType.Launch, a: -1.2, b: 1, id: 3 });
    // Two spitters wind up in the veil.
    for (let i = 0; i < sim.enemies.length; i++) {
      const en = sim.enemies[i];
      if (!en || en.kind !== 'thornSpitter') continue;
      const start = i === 0 ? 16.8 : 17.2;
      const on = t >= start && t < start + 0.6;
      en.mode = on ? 'windup' : 'cooldown';
      en.modeDuration = on ? 36 : 0;
      en.modeTicks = on ? Math.floor((t - start) * 60) : 0;
      if (at(t, prev, start)) emit({ type: SimEventType.SpitterWindup, x: en.x, y: en.y - 50, a: 36, id: en.id });
      if (at(t, prev, start + 0.6)) emit({ type: SimEventType.SeedFired, x: en.x, y: en.y - 50, id: 10 + i });
      if (at(t, prev, start + 1.3)) emit({ type: SimEventType.SeedBurst, x: en.x + 200, y: en.y - 200, a: SeedBurstCause.Terrain, id: 10 + i });
    }
    if (at(t, prev, 20)) emit({ type: SimEventType.CheckpointActivated, id: 2 });
    if (at(t, prev, 21)) emit({ type: SimEventType.Died, a: DeathCause.Thorns });
    if (at(t, prev, 21.7)) emit({ type: SimEventType.Respawned, id: 2 });
    if (at(t, prev, 23)) emit({ type: SimEventType.GoalReached, a: 300 });
  };
}

export const STRESS: SceneScript = { seconds: 26, volumes: { master: 1, music: 1, sfx: 1 }, frame: stressFrame(tourX) };

const veilFrame = stressFrame(() => areaX(4));

/**
 * The pile-up staged in the veil, whose harmony is the loudest for the ability bloom: an aim held at its
 * end (aim sustain at level 1, the fastest heartbeat) from 3.8 s to 6.5 s, both spitters' windups peaking
 * at the pile-up, and a second ability bloom 20 ms after it.
 */
export const STRESS_VEIL: SceneScript = {
  seconds: 9,
  volumes: { master: 1, music: 1, sfx: 1 },
  frame(t, prev, sim, af, emit) {
    veilFrame(t, prev, sim, af, emit);
    const L = sim.launch;
    if (t >= 3.8 && t < 6.5) {
      sim.frozen = true;
      L.aimTicks = L.aimMaxTicks - 1;
      sim.player.mode = 'launchAim';
    }
    if (at(t, prev, 3.8)) emit({ type: SimEventType.LaunchAim, x: af.camX + 120, y: af.camY, a: 1, id: 3 });
    for (let i = 0; i < sim.enemies.length; i++) {
      const en = sim.enemies[i];
      if (!en || en.kind !== 'thornSpitter') continue;
      const on = t >= 3.9 && t < 4.55;
      en.mode = on ? 'windup' : 'cooldown';
      en.modeDuration = on ? 36 : 0;
      en.modeTicks = on ? Math.min(36, Math.floor((t - 3.9) * 60)) : 0;
      if (at(t, prev, 3.9)) emit({ type: SimEventType.SpitterWindup, x: en.x, y: en.y - 50, a: 36, id: en.id });
    }
    if (at(t, prev, 4.52)) emit({ type: SimEventType.AbilityUnlocked, a: 1, id: 0 });
  },
};

/**
 * The live lease fade path: a wall slide at full speed and an aim at its end (scrape, aim sustain and
 * heartbeat, renewed every frame), then update() stops at 1.5 s, like a hidden tab. Taps the dry SFX bus.
 */
export const LEASE_STALL: SceneScript = {
  seconds: 3,
  volumes: { master: 1, music: 0, sfx: 1 },
  stopUpdatesAt: 1.5,
  tapSfx: true,
  frame(_t, _prev, sim, af) {
    af.camX = areaX(0);
    af.camY = 700;
    const p = sim.player;
    p.x = af.camX;
    p.y = af.camY + 300;
    p.mode = 'wallSlide';
    p.vy = 190;
    sim.frozen = true;
    sim.launch.aimMaxTicks = 120;
    sim.launch.aimTicks = 119;
  },
};

/** A calm listening tour at the default sliders: music and ambience through all six areas (no SFX). */
export const TOUR: SceneScript = {
  seconds: 96,
  volumes: { master: 0.8, music: 0.6, sfx: 0.8 },
  frame(t, _prev, sim, af) {
    // 14 s in each area, 2 s cross-fades.
    const seg = 16;
    const i = Math.min(5, Math.floor(t / seg));
    const u = t - i * seg;
    af.camX = u < 14 || i === 5 ? areaX(i) : lerp(areaX(i), areaX(i + 1), (u - 14) / 2);
    af.camY = 700;
    sim.player.x = af.camX;
    sim.player.y = af.camY + 300;
  },
};

/** One area's music and ambience for `seconds` with a still camera, at the default sliders. */
export function moodScene(area: number, seconds = 34): SceneScript {
  return {
    seconds,
    volumes: { master: 0.8, music: 0.6, sfx: 0.8 },
    frame(_t, _prev, sim, af) {
      af.camX = areaX(area);
      af.camY = 700;
      sim.player.x = af.camX;
      sim.player.y = af.camY + 300;
    },
  };
}

export async function renderStressMix(Offline: OfflineCtor, outDir: string): Promise<SceneResult> {
  const r = await runScene(Offline, STRESS);
  writeWav16(join(outDir, 'stress-mix.wav'), r.post, SR);
  writeSpectrogramPng(join(outDir, 'stress-mix.png'), r.post[0] as Float32Array, SR);
  return r;
}
