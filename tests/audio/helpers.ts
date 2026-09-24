import { AudioSystem } from '../../src/audio/audio.ts';
import type { Engine } from '../../src/audio/engine.ts';
import type { AudioFrame } from '../../src/contracts/audio.ts';
import { AREA_GRADES, type LevelData } from '../../src/contracts/level.ts';
import type { SimEvent } from '../../src/contracts/sim.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../shared/fixtures.ts';
import { FakeContext, FakeGestureTarget, type FakeOptions } from './fakeContext.ts';

export const TILE = 48;
/** Tiles per area in the test level. */
export const AREA_TILES = 40;

/**
 * A flat level with the six grade zones side by side (each AREA_TILES wide, blend 288) and three
 * player-aimed spitters in the veil (ids 0..2, at increasing x).
 */
export function zonedLevel(): LevelData {
  const w = AREA_TILES * AREA_GRADES.length;
  const rows: string[] = [];
  for (let y = 0; y < 20; y++) rows.push(' '.repeat(w));
  const spit = ' '.repeat(w).split('');
  spit[AREA_TILES * 4 + 10] = 'S';
  spit[AREA_TILES * 4 + 16] = 'S';
  spit[AREA_TILES * 4 + 30] = 'S';
  rows.push(spit.join(''));
  rows.push('#'.repeat(w));
  const level = levelFromAscii(rows, { id: 'audio-test', seed: 1234 });
  for (let a = 0; a < AREA_GRADES.length; a++) {
    level.gradeZones.push({
      id: a, grade: AREA_GRADES[a] as (typeof AREA_GRADES)[number], x: a * AREA_TILES * TILE, y: 0,
      w: AREA_TILES * TILE, h: level.pxHeight, blend: 288,
    });
  }
  return level;
}

/** Centre x of area i. */
export function areaX(i: number): number {
  return (i + 0.5) * AREA_TILES * TILE;
}

export interface Rig {
  audio: AudioSystem;
  fake: FakeContext;
  target: FakeGestureTarget;
  sim: FakeSim;
  frame: AudioFrame;
  /** The live engine (throws when there is none). */
  engine(): Engine;
  /** Advance the fake clock by dt and run one update (events first, like game.ts). */
  step(dt?: number, events?: readonly (Partial<SimEvent> & Pick<SimEvent, 'type'>)[]): void;
  /** Deliver events in the current frame without advancing time. */
  emit(...events: (Partial<SimEvent> & Pick<SimEvent, 'type'>)[]): void;
  /** Move the camera (and the player with it). */
  look(x: number, y?: number): void;
}

export interface RigOptions {
  fake?: FakeOptions;
  seed?: number;
  /** Unlock and run the context (default true). */
  run?: boolean;
  /** Build the noise and impulse buffers and hand them over (default true). */
  warm?: boolean;
}

export function event(e: Partial<SimEvent> & Pick<SimEvent, 'type'>, sim: FakeSim): SimEvent {
  return { tick: sim.tick, x: sim.player.x, y: sim.player.y, a: 0, b: 0, id: -1, ...e };
}

export function rig(opts: RigOptions = {}): Rig {
  const fake = new FakeContext({ autoRun: true, ...opts.fake });
  const target = new FakeGestureTarget();
  const audio = new AudioSystem({ createContext: () => fake, gestureTarget: target, seed: opts.seed ?? 1234 });
  const sim = createFakeSimView(zonedLevel());
  const frame: AudioFrame = { dt: 1 / 60, camX: areaX(0), camY: 500, viewW: sim.camera.viewW, viewH: sim.camera.viewH, sim, paused: false };
  const r: Rig = {
    audio, fake, target, sim, frame,
    engine() {
      const e = audio.inspect;
      if (!e) throw new Error('no engine');
      return e;
    },
    step(dt = 1 / 60, events = []) {
      fake.currentTime += dt;
      frame.dt = Math.min(dt, 0.05);
      for (const e of events) audio.onSimEvent(event(e, sim), frame);
      audio.update(frame);
    },
    emit(...events) {
      for (const e of events) audio.onSimEvent(event(e, sim), frame);
    },
    look(x, y = 500) {
      frame.camX = x;
      frame.camY = y;
      sim.camera.x = x;
      sim.camera.y = y;
      sim.player.x = x;
      sim.player.y = y + 200;
    },
  };
  r.look(areaX(0));
  if (opts.run ?? true) {
    audio.unlock();
    // The browser starts the context after the gesture (the fake may not do it on resume()).
    if (fake.state !== 'running') fake.setState('running');
    if (opts.warm ?? true) {
      const e = r.engine();
      e.buffers.finish();
      // Two updates: one takes the finished buffers, the next hands the impulse to the convolver.
      r.step(0);
      r.step(0);
      if (!e.kit.noise || !e.mixer.reverb.buffer) throw new Error('buffers not ready');
    }
  }
  return r;
}
