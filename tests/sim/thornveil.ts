import { HAZARD_INSET, KILL_MARGIN } from '../../src/config.ts';
import { createInputFrame, type InputFrame } from '../../src/contracts/input.ts';
import type { LevelData, SpitterDef } from '../../src/contracts/level.ts';
import { Ability, SimEventType } from '../../src/contracts/sim.ts';
import { SimEventQueue } from '../../src/core/events.ts';
import { CollisionGrid } from '../../src/level/grid.ts';
import { overlapsThorns } from '../../src/sim/physics.ts';
import { PlayerController } from '../../src/sim/player.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';
import type { Cell } from '../../tools/level/analysis.ts';
import { Bot, type Dir } from './bot.ts';
import { neutral, T, WorldRig } from './helpers.ts';

/**
 * The Thornveil's §5.4 gates in forest.ldtk (tools/level/forest.map.txt), in tiles: floor cells are the
 * tiles the feet stand on. The reach tests prove each launch-only landing and the stun gate; the route
 * drives the same moves.
 */
const cells = (x0: number, x1: number, ty: number): Cell[] => {
  const out: Cell[] = [];
  for (let tx = x0; tx <= x1; tx++) out.push({ tx, ty });
  return out;
};

export interface GateStart {
  /** Feet x in tiles (fractional) and the floor row. */
  x: number;
  y: number;
  /** Run direction toward the landing. */
  dir: Dir;
}

export const VEIL = {
  /** Checkpoint 4's floor: the pit the shrine corridor opens into. */
  shrineExit: { tx: 174, ty: 31 },
  /** The reward alcove over the teach pit: the OneWay floor of a rock cup 8 tiles above level A (optional). */
  teach: {
    landing: cells(178, 183, 20),
    starts: [
      { x: 176.5, y: 28, dir: 1 },
      { x: 185.5, y: 28, dir: -1 },
      { x: 179.5, y: 30, dir: 1 },
    ] as GateStart[],
  },
  /** Rise gate: across the thorn chasm onto the OneWay step (7 up) or the lip of level B (9 up). */
  rise: {
    landing: [...cells(192, 198, 21), ...cells(199, 202, 19)],
    starts: [
      { x: 183.5, y: 28, dir: 1 },
      { x: 185.5, y: 28, dir: 1 },
    ] as GateStart[],
    /** Where the scripted launches stand: level A's last tile. */
    edge: { x: 186.9, y: 28 },
  },
  /** Stun gate: the player-aimed spitter in the 2-tile passage under the stun wall. */
  stun: {
    from: { tx: 199, ty: 19 },
    beyond: [...cells(211, 212, 22), ...cells(213, 217, 19)],
    starts: [
      { x: 199.5, y: 19, dir: 1 },
      { x: 203.5, y: 22, dir: 1 },
    ] as GateStart[],
  },
  /** Vertical gate: the thorn-walled shaft, up to the OneWay ledge (8 up) and level C beyond it. */
  vertical: {
    from: { tx: 214, ty: 19 },
    landing: [...cells(214, 217, 11), ...cells(218, 220, 10)],
    starts: [
      { x: 213.5, y: 19, dir: 1 },
      { x: 214.9, y: 19, dir: -1 },
      { x: 211.5, y: 22, dir: 1 },
    ] as GateStart[],
  },
} as const;

/** The level's player-aimed spitter (the stun gate's). */
export function stunSpitter(level: LevelData): SpitterDef {
  const s = level.enemies.find((e): e is SpitterDef => e.kind === 'thornSpitter' && e.aim === 'player');
  if (!s) throw new Error('forest.ldtk: no player-aimed spitter');
  return s;
}

/** Timings of one no-launch attempt, in ticks from the start of the run (−1 = never). */
export interface Attempt {
  groundDash: number;
  jump: number;
  /** Ticks after the jump press (the air jump may cancel the air dash, the jump the ground dash). */
  airDash: number;
  airJump: number;
}

export interface SearchSpace {
  groundDash: readonly number[];
  jump: readonly number[];
  airDash: readonly number[];
  airJump: readonly number[];
}

function standsOn(p: PlayerController, landing: readonly Cell[]): boolean {
  if (!p.grounded) return false;
  for (let i = 0; i < landing.length; i++) {
    const c = landing[i] as Cell;
    if (p.y === c.ty * T && p.x + p.width / 2 > c.tx * T && p.x - p.width / 2 < (c.tx + 1) * T) return true;
  }
  return false;
}

/**
 * One attempt with the real controller on the level's grid: run from `start`, ground dash, jump (grounded
 * or coyote), air dash and air jump at the given ticks. True if it stands on `landing`. Thorns and the
 * kill plane end it. Enemies and seeds are ignored: their contact can't end an attempt early, but a
 * crawler's stomp bounce (height, and a restored air jump) isn't modelled either, so the searches assume
 * no crawler near a gate (forest.test.ts asserts the Thornveil has none).
 */
export function attemptLands(grid: CollisionGrid, level: LevelData, start: GateStart, a: Attempt, landing: readonly Cell[]): boolean {
  const p = new PlayerController(grid, DEFAULT_TUNING);
  p.reset(start.x * T, start.y * T, 0);
  const events = new SimEventQueue(64);
  const f: InputFrame = createInputFrame();
  const last = Math.max(a.groundDash, a.jump + Math.max(a.airDash, a.airJump)) + 120;
  for (let tick = 1; tick <= last; tick++) {
    neutral(f);
    const k = tick - 1;
    f.moveX = start.dir;
    f.jumpHeld = k >= a.jump;
    f.jumpPressed = k === a.jump || (a.airJump >= 0 && k === a.jump + a.airJump);
    f.dashPressed = k === a.groundDash || (a.airDash >= 0 && k === a.jump + a.airDash);
    f.dashHeld = f.dashPressed;
    p.step(f, tick, events);
    events.clear();
    if (overlapsThorns(grid, p, HAZARD_INSET) || p.y > level.pxHeight + KILL_MARGIN) return false;
    if (standsOn(p, landing)) return true;
    if (k > a.jump + 2 && p.grounded && k > a.jump + Math.max(a.airDash, a.airJump)) return false;
  }
  return false;
}

/** Every combination of the search space from every start; returns the first that lands, or null. */
export function searchLands(level: LevelData, starts: readonly GateStart[], space: SearchSpace, landing: readonly Cell[]): { start: GateStart; a: Attempt } | null {
  const grid = CollisionGrid.fromLevel(level);
  for (const start of starts) {
    for (const groundDash of space.groundDash) {
      for (const jump of space.jump) {
        if (groundDash >= 0 && jump < groundDash) continue;
        for (const airDash of space.airDash) {
          for (const airJump of space.airJump) {
            const a = { groundDash, jump, airDash, airJump };
            if (attemptLands(grid, level, start, a, landing)) return { start, a };
          }
        }
      }
    }
  }
  return null;
}

export const range = (a: number, b: number, step = 1): number[] => {
  const out: number[] = [];
  for (let i = a; i <= b; i += step) out.push(i);
  return out;
};

/**
 * The stun gate's bot search: one GameWorld over a copy of the level holding only the stun spitter, made
 * silent (it never fires, so no seed ends an attempt early: only its body and the passage matter). Each
 * attempt runs from a start with the given timings; returns the first that gets the player's whole body
 * past the spitter alive, or null. `withSpitter: false` leaves it out (the control: then it passes).
 */
export function stunSearch(level: LevelData, starts: readonly GateStart[], space: SearchSpace, withSpitter = true): { start: GateStart; a: Attempt } | null {
  const s = stunSpitter(level);
  const silent: SpitterDef = { ...s, id: 0, period: 1_000_000, phase: 999_999 };
  const rig = new WorldRig({ ...level, enemies: withSpitter ? [silent] : [] });
  const w = rig.world;
  const past = s.x + DEFAULT_WORLD_TUNING.spitterWidth / 2 + DEFAULT_TUNING.width / 2;
  for (const start of starts) {
    for (const groundDash of space.groundDash) {
      for (const jump of space.jump) {
        if (groundDash >= 0 && jump < groundDash) continue;
        for (const airDash of space.airDash) {
          for (const airJump of space.airJump) {
            const a = { groundDash, jump, airDash, airJump };
            w.reset();
            w.teleport(start.x * T, start.y * T);
            const last = Math.max(a.groundDash, a.jump + Math.max(a.airDash, a.airJump)) + 90;
            for (let k = 0; k < last && w.player.alive; k++) {
              rig.step((f) => {
                f.moveX = start.dir;
                f.jumpHeld = k >= a.jump;
                f.jumpPressed = k === a.jump || (a.airJump >= 0 && k === a.jump + a.airJump);
                f.dashPressed = k === a.groundDash || (a.airDash >= 0 && k === a.jump + a.airDash);
                f.dashHeld = f.dashPressed;
              });
              rig.log.length = 0;
              if (w.player.alive && w.player.x > past) return { start, a };
            }
          }
        }
      }
    }
  }
  return null;
}

export interface LaunchSpot {
  /** Feet x in tiles (fractional) and the floor row. */
  x: number;
  y: number;
  /** The aim: one of the 8 keyboard directions, or (0, 0) for neutral. */
  mx: number;
  my: number;
  /** Held after the launch; air jump at the apex or not. */
  hold: Dir;
  airJump: boolean;
}

/**
 * The launch window of a seed gate: standing at `spot`, from the tick `spitter` fires, press launch d
 * ticks later (d over one period) and launch as scripted. Returns the offsets d that grab a seed and land
 * on `landing`.
 */
export function launchWindow(level: LevelData, spot: LaunchSpot, spitter: SpitterDef, landing: readonly Cell[]): number[] {
  const ok: number[] = [];
  for (let d = 0; d < spitter.period; d++) {
    const bot = gateBot(level, spot.x, spot.y);
    const w = bot.w;
    try {
      bot.hold(0, () => bot.rig.eventsOf(SimEventType.SeedFired).some((e) => e.x === spitter.x), spitter.period + 120);
      bot.idle(d);
      bot.step((f) => {
        f.launchPressed = true;
        f.launchHeld = true;
        f.moveX = spot.mx;
        f.moveY = spot.my;
      });
      if (w.player.mode !== 'launchAim' || w.launch.targetKind !== 'seed') continue;
      bot.step((f) => {
        f.launchReleased = true;
        f.moveX = spot.mx;
        f.moveY = spot.my;
      });
      bot.fly(spot.hold, { airJump: spot.airJump ? 'apex' : false });
    } catch {
      continue;
    }
    const p = w.player;
    if (p.grounded && landing.some((c) => p.y === c.ty * T && p.x + p.width / 2 > c.tx * T && p.x - p.width / 2 < (c.tx + 1) * T)) ok.push(d);
  }
  return ok;
}

/** The longest run of consecutive values in a sorted list. */
export function longestRun(values: readonly number[]): number {
  let best = 0;
  let run = 0;
  for (let i = 0; i < values.length; i++) {
    run = i > 0 && values[i] === (values[i - 1] as number) + 1 ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

/** A world at a gate with Spirit Launch unlocked (the route passes the shrine; these start past it). */
export function gateBot(level: LevelData, x: number, y: number): Bot {
  const bot = new Bot(new WorldRig(level));
  bot.w.teleport(x * T, y * T);
  bot.w.unlock(Ability.Launch);
  return bot;
}
