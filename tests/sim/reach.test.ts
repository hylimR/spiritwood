import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { SIM_DT } from '../../src/config.ts';
import type { InputFrame } from '../../src/contracts/input.ts';
import type { LevelData, SpitterDef } from '../../src/contracts/level.ts';
import { SimEventType } from '../../src/contracts/sim.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { DEFAULT_TUNING, deriveTuning } from '../../src/sim/tuning.ts';
import type { GameWorld } from '../../src/sim/world.ts';
import { NO_LAUNCH_PLANS, noLaunchClosure, noLaunchLead, spitterBox, type Cell } from '../../tools/level/analysis.ts';
import { LDTK_PATH } from '../../tools/level/build-level.ts';
import { Bot } from './bot.ts';
import { MapBuilder, T, WorldRig } from './helpers.ts';
import { anchorSeed, FreeBody, launchRig } from './launchKit.ts';
import { gateBot, launchWindow, longestRun, range as ticks, searchLands, stunSearch, stunSpitter, VEIL, type LaunchSpot, type SearchSpace } from './thornveil.ts';

/**
 * ARCHITECTURE.md §5.4 reach gates: for each design rule the intended move succeeds and the
 * next-weaker move fails — the latter over every takeoff tick and air-jump timing we can script.
 */

const tun = DEFAULT_TUNING;
const der = deriveTuning(tun);
const RUNWAY = 16;
const FLOOR = 10;
const PIT = 16;

interface Attempt {
  /** Ticks after the last tick that starts over the runway to press jump (> 0 = a coyote jump). */
  jumpAt: number;
  /** Ticks after the first jump to press the air jump (−1 = none). */
  doubleAt: number;
  /** Ticks after the air jump to dash (−1 = none). */
  dashAt: number;
}

/** Runway (top row FLOOR) → gap of `gap` columns → landing block `rise` tiles higher. A pit floor below. */
function course(gap: number, rise: number): string[] {
  const w = RUNWAY + gap + 12;
  const m = new MapBuilder(w, PIT + 2, false);
  m.fill(0, FLOOR, RUNWAY - 1, PIT + 1, '#');
  m.fill(RUNWAY + gap, FLOOR - rise, w - 1, PIT + 1, '#');
  m.fill(RUNWAY, PIT, RUNWAY + gap - 1, PIT + 1, '#');
  m.put(2, FLOOR - 1, 'P');
  return m.rows();
}

/** Run at full speed and perform `a`; true if the player ends standing on the landing block. */
function attempt(gap: number, rise: number, a: Attempt): boolean {
  const rig = new WorldRig(course(gap, rise));
  const p = rig.world.player;
  const edge = RUNWAY * T;
  // Reference tick 0: the last tick that still starts with the body over the runway.
  new Bot(rig).hold(1, () => p.x - tun.width / 2 + p.vx * SIM_DT >= edge || !p.grounded, 400);
  let jumped = -1;
  let doubled = -1;
  for (let tick = 0; tick < 400; tick++) {
    let jumpPressed = false;
    let dashPressed = false;
    if (jumped < 0 && tick >= a.jumpAt) jumpPressed = true;
    else if (jumped >= 0 && doubled < 0 && a.doubleAt >= 0 && tick - jumped === a.doubleAt) jumpPressed = true;
    if (doubled >= 0 && a.dashAt >= 0 && tick - doubled === a.dashAt) dashPressed = true;
    rig.step((f: InputFrame) => {
      f.moveX = 1;
      f.jumpHeld = true;
      f.jumpPressed = jumpPressed;
      f.dashPressed = dashPressed;
    });
    if (jumpPressed) {
      if (jumped < 0) jumped = tick;
      else doubled = tick;
    }
    if (!p.alive) return false;
    if (jumped >= 0 && tick - jumped > 2 && p.grounded) break;
  }
  return p.grounded && p.y === (FLOOR - rise) * T && p.x + tun.width / 2 > (RUNWAY + gap) * T;
}

/** True if any take-off tick (edge … end of coyote) combined with the given air-jump / dash timings lands. */
function anySucceeds(gap: number, rise: number, doubles: number[], dashes: number[]): boolean {
  for (let jumpAt = 0; jumpAt <= tun.coyoteTicks + 1; jumpAt++) {
    for (const doubleAt of doubles) {
      for (const dashAt of dashes) {
        if (attempt(gap, rise, { jumpAt, doubleAt, dashAt })) return true;
      }
    }
  }
  return false;
}

const range = (a: number, b: number, step = 1): number[] => {
  const out: number[] = [];
  for (let i = a; i <= b; i += step) out.push(i);
  return out;
};

/** Ticks from take-off to the apex of a held jump. */
const APEX = Math.round(((der.jumpVelocity - tun.apexThreshold) / der.gravity + tun.apexThreshold / (der.gravity * tun.apexGravityMult)) / SIM_DT);
const AIR_APEX = Math.round((der.airJumpVelocity / der.gravity) / SIM_DT);

describe('reach gates (§5.4 design rules)', () => {
  test('single-jump ledge: 3 tiles succeeds; 4 tiles fails with a single jump', () => {
    // From a standing start close to the wall, like a player hopping up a step.
    expect(ledge(3, false)).toBe(true);
    expect(ledge(4, false)).toBe(false);
  });

  test('jump + double-jump ledge: 5 tiles succeeds; a single jump fails', () => {
    expect(ledge(5, true)).toBe(true);
    expect(ledge(5, false)).toBe(false);
  });

  test('a 6-tile gap is crossable without the double jump; walking off is not', () => {
    expect(attempt(6, 0, { jumpAt: 0, doubleAt: -1, dashAt: -1 })).toBe(true);
    expect(walkOff(6)).toBe(false);
  });

  test('double-jump gaps: 10 tiles succeeds with jump + double; 9 tiles fails with any single jump', () => {
    expect(attempt(10, 0, { jumpAt: 0, doubleAt: APEX, dashAt: -1 })).toBe(true);
    expect(anySucceeds(9, 0, [-1], [-1])).toBe(false);
  });

  test('dash + double-jump gap (14 tiles, landing 2 up): the dash clears it; no jump + double jump timing does', () => {
    // A late air jump restarts the arc, so jump + double jump reaches ≈ 650 u on the flat; the 2-tile
    // rise keeps the dash mandatory (the level's canopy gaps use this shape).
    expect(attempt(14, 2, { jumpAt: 0, doubleAt: APEX, dashAt: AIR_APEX })).toBe(true);
    expect(anySucceeds(14, 2, range(1, 70), [-1])).toBe(false);
  });

  test('a late double jump outreaches the apex one (why flat 13–14-tile gaps do not gate the dash)', () => {
    expect(attempt(13, 0, { jumpAt: 0, doubleAt: APEX, dashAt: -1 })).toBe(false);
    expect(anySucceeds(13, 0, range(APEX, 70), [-1])).toBe(true);
  });

  test('wall-jump shafts 3–5 tiles wide are climbable; jumping alone is not', () => {
    for (const width of [3, 5]) {
      expect(shaft(width, true), `width ${width}`).toBe(true);
      expect(shaft(width, false), `width ${width}`).toBe(false);
    }
  });
});

/** A standing hop onto a block `h` tiles high, one tile in front of the player. */
function ledge(h: number, double: boolean): boolean {
  const m = new MapBuilder(20, 16).fill(9, 15 - h, 18, 14, '#').put(6, 14, 'P');
  const rig = new WorldRig(m.rows());
  const bot = new Bot(rig);
  try {
    bot.arc(1, { double: double ? true : undefined, max: 200 });
  } catch {
    return false;
  }
  return rig.world.player.grounded && rig.world.player.y === (15 - h) * T;
}

function walkOff(gap: number): boolean {
  const rig = new WorldRig(course(gap, 0));
  const bot = new Bot(rig);
  const p = rig.world.player;
  bot.hold(1, () => p.x > (RUNWAY + gap + 2) * T || (!p.grounded && p.y > FLOOR * T + T), 400);
  bot.land(1);
  return p.y === FLOOR * T;
}

/** A shaft `width` tiles wide and 12 tall; the top exit is a floor to the right. */
function shaft(width: number, wallJumps: boolean): boolean {
  const H = 20;
  const x0 = 5;
  const m = new MapBuilder(x0 + width + 10, H);
  m.fill(1, 1, x0 - 1, H - 2, '#');
  m.fill(x0 + width, 7, x0 + width + 8, H - 2, '#');
  m.put(x0 + 1, H - 2, 'P');
  const rig = new WorldRig(m.rows());
  const bot = new Bot(rig);
  const top = 7 * T;
  try {
    if (wallJumps) {
      bot.arc(1, { until: (w) => w.player.mode === 'wallSlide' });
      bot.climb(1, top, 900);
    } else {
      // Jump + double jump while never pressing into a wall (no slides, no wall jumps).
      bot.arc(0, { double: true, max: 200 });
      bot.hold(1, (w) => w.player.grounded, 120);
    }
  } catch {
    return false;
  }
  return rig.world.player.grounded && rig.world.player.y <= top;
}

/**
 * §5.4 reach for DEFAULT_TUNING (u). Air jump at the first apex, dash at the second apex. ARCHITECTURE
 * lists 293.7 / 535 / 739 for the peak and the last two flights; the trapezoid physics it specifies
 * gives 293.9 / 550 / 765 (reported for the table).
 */
const REACH = {
  fullJumpRise: 172.9,
  doubleJumpPeak: 293.9,
  runJump: 345,
  jumpDouble: 550,
  jumpDoubleDash: 765,
  dash: 196.7,
} as const;

describe('reach table (§5.4, DEFAULT_TUNING, jump held, running at maxRunSpeed)', () => {
  /** Feet travel from take-off to the return to take-off height (interpolated inside the tick). */
  function flight(o: { double: boolean; dash: boolean }): { travel: number; peak: number } {
    const m = new MapBuilder(300, 20).put(4, 18, 'P');
    const rig = new WorldRig(m.rows());
    const p = rig.world.player;
    rig.run(20, (f) => {
      f.moveX = 1;
    });
    const x0 = p.x;
    const y0 = p.y;
    let minY = y0;
    let doubled = false;
    let dashed = false;
    let prevVy = 0;
    for (let i = 0; i < 300; i++) {
      const px = p.x;
      const py = p.y;
      const jumpPressed = i === 0 || (o.double && !doubled && i > 1 && p.vy >= 0);
      if (jumpPressed && i > 0) doubled = true;
      const dashPressed = o.dash && doubled && !dashed && p.vy >= 0 && prevVy < 0;
      if (dashPressed) dashed = true;
      prevVy = p.vy;
      rig.step((f) => {
        f.moveX = 1;
        f.jumpHeld = true;
        f.jumpPressed = jumpPressed;
        f.dashPressed = dashPressed;
      });
      minY = Math.min(minY, p.y);
      if (i > 2 && p.y >= y0) {
        const k = (y0 - py) / (p.y - py);
        return { travel: px + (p.x - px) * k - x0, peak: y0 - minY };
      }
    }
    throw new Error('no landing');
  }

  test('rises and flights match the documented reach', () => {
    const single = flight({ double: false, dash: false });
    expect(single.peak).toBeCloseTo(REACH.fullJumpRise, 0);
    expect(Math.abs(single.travel - REACH.runJump)).toBeLessThan(2);
    const dbl = flight({ double: true, dash: false });
    expect(Math.abs(dbl.peak - REACH.doubleJumpPeak)).toBeLessThan(1);
    expect(Math.abs(dbl.travel - REACH.jumpDouble)).toBeLessThan(2);
    const dash = flight({ double: true, dash: true });
    expect(Math.abs(dash.travel - REACH.jumpDoubleDash)).toBeLessThan(2);
    expect(tun.dashSpeed * tun.dashTicks * SIM_DT).toBeCloseTo(REACH.dash, 1);
  });
});

/**
 * §5.4 Spirit Launch reach (DEFAULT_LAUNCH_TUNING, the §5.1.1 tick convention): the real controller
 * against the reference integrator (FreeBody, derived from the tunings), ± 2 u. The documented values
 * are asserted for the default tunings.
 */
const LAUNCH_REACH = {
  up: 416.2,
  upAirJump: 537.3,
  doublePeakUpAirJump: 831,
  flat45: 495,
  flat45Ticks: 51,
  flat45Peak: 233.6,
  midAir: 1166,
} as const;

const DIAG = Math.SQRT1_2;

/** The reference flight from rest after a release along (ax, ay); k = 0 is the release tick R. */
function freeFlight(ax: number, ay: number, press: { airJump?: number; dash?: number; hold?: number } = {}): { apex: number; travel: number; airtime: number } {
  const b = new FreeBody();
  b.release(ax, ay);
  let minY = 0;
  for (let k = 0; k < 600; k++) {
    const px = b.x;
    const py = b.y;
    b.step({ moveX: press.hold ?? 0, jumpHeld: true, jumpPressed: k === press.airJump, dashPressed: k === press.dash });
    minY = Math.min(minY, b.y);
    if (k > 0 && b.vy > 0 && b.y >= 0) {
      const f = (0 - py) / (b.y - py);
      return { apex: -minY, travel: px + (b.x - px) * f, airtime: k + f };
    }
  }
  throw new Error('freeFlight: no return to launch height');
}

/** The best reference apex over every air-jump tick. */
function bestFreeAirJump(): { apex: number; at: number } {
  let best = { apex: 0, at: -1 };
  for (let k = 0; k < 90; k++) {
    const r = freeFlight(0, -1, { airJump: k });
    if (r.apex > best.apex) best = { apex: r.apex, at: k };
  }
  return best;
}

/** A 1-tile pillar (top row 30) in open air, so flights are measured back to launch height over the void. */
function pillar(): WorldRig {
  const rig = launchRig(new MapBuilder(160, 48).fill(8, 30, 8, 46, '#').put(8, 29, 'P').rows());
  rig.step();
  return rig;
}

/** Park an anchor seed 60 u in front of the player's centre, let the next tick publish it, and grab it. */
function grabAnchor(rig: WorldRig, set?: (f: InputFrame) => void): void {
  const p = rig.world.player;
  anchorSeed(rig.world, p.x + 60, p.y - p.height / 2);
  rig.step(set);
  rig.step((f) => {
    set?.(f);
    f.launchPressed = true;
    f.launchHeld = true;
  });
  expect(p.mode).toBe('launchAim');
}

/** Release along (ax, ay) (tick R), then fly with `press` (k counted from R = 0) back to the grab height. */
function realFlight(rig: WorldRig, ax: number, ay: number, press: { airJump?: number; dash?: number; hold?: number } = {}): { apex: number; travel: number; airtime: number } {
  const p = rig.world.player;
  const x0 = p.x;
  const y0 = p.y;
  let minY = y0;
  for (let k = 0; k < 600; k++) {
    const px = p.x;
    const py = p.y;
    rig.step((f) => {
      f.moveX = k === 0 ? ax : (press.hold ?? 0);
      f.moveY = k === 0 ? ay : 0;
      f.launchReleased = k === 0;
      f.jumpHeld = true;
      f.jumpPressed = k === press.airJump;
      f.dashPressed = k === press.dash;
    });
    minY = Math.min(minY, p.y);
    if (k > 0 && p.vy >= 0 && p.y >= y0) {
      const f = p.y === py ? 0 : (y0 - py) / (p.y - py);
      return { apex: y0 - minY, travel: px + (p.x - px) * f - x0, airtime: k + f };
    }
  }
  throw new Error('realFlight: no return to launch height');
}

describe('Spirit Launch reach (§5.4): the real controller against the integration, ± 2 u', () => {
  test('straight up from rest: apex gain; with the restored air jump at its best tick', () => {
    const free = freeFlight(0, -1);
    expect(free.apex).toBeCloseTo(LAUNCH_REACH.up, 1);
    const rig = pillar();
    grabAnchor(rig);
    expect(Math.abs(realFlight(rig, 0, -1).apex - free.apex)).toBeLessThan(2);

    const best = bestFreeAirJump();
    expect(best.apex).toBeCloseTo(LAUNCH_REACH.upAirJump, 1);
    const rig2 = pillar();
    grabAnchor(rig2);
    expect(Math.abs(realFlight(rig2, 0, -1, { airJump: best.at }).apex - best.apex)).toBeLessThan(2);
  });

  test('jump + double jump, grab at the double-jump peak, launch up, air jump', () => {
    // Find the tick of the double-jump apex, then run again and grab there (the anchor is placed a
    // tick early so the candidate is published by then).
    const climb = (rig: WorldRig, stopBefore: number): number => {
      const p = rig.world.player;
      let doubled = false;
      for (let i = 0; i < 200; i++) {
        if (i === stopBefore) return i;
        const jp = i === 0 || (!doubled && i > 1 && p.vy >= 0);
        if (jp && i > 0) doubled = true;
        const prevVy = p.vy;
        rig.step((f) => {
          f.jumpHeld = true;
          f.jumpPressed = jp;
        });
        if (doubled && prevVy < 0 && p.vy >= 0) return i + 1;
      }
      throw new Error('no double-jump apex');
    };
    const probe = pillar();
    const y0 = probe.world.player.y;
    const apexTick = climb(probe, -1);
    const peak = y0 - probe.world.player.y;
    expect(Math.abs(peak - REACH.doubleJumpPeak)).toBeLessThan(1);

    const rig = pillar();
    climb(rig, apexTick - 1);
    const p = rig.world.player;
    anchorSeed(rig.world, p.x + 60, p.y - p.height / 2);
    rig.step((f) => {
      f.jumpHeld = true;
    });
    rig.step((f) => {
      f.jumpHeld = true;
      f.launchPressed = true;
      f.launchHeld = true;
    });
    expect(p.mode).toBe('launchAim');
    expect(Math.abs(y0 - p.y - peak)).toBeLessThan(1);
    const best = bestFreeAirJump();
    const total = y0 - p.y + realFlight(rig, 0, -1, { airJump: best.at }).apex;
    expect(Math.abs(total - (peak + best.apex))).toBeLessThan(2);
    expect(Math.abs(total - LAUNCH_REACH.doublePeakUpAirJump)).toBeLessThan(2);
  });

  test('45° from standing, holding forward after the phase: distance, airtime and peak back at launch height', () => {
    const free = freeFlight(DIAG, -DIAG, { hold: 1 });
    expect(Math.abs(free.travel - LAUNCH_REACH.flat45)).toBeLessThan(2);
    expect(Math.round(free.airtime)).toBe(LAUNCH_REACH.flat45Ticks);
    expect(free.apex).toBeCloseTo(LAUNCH_REACH.flat45Peak, 1);
    const rig = pillar();
    grabAnchor(rig);
    const real = realFlight(rig, DIAG, -DIAG, { hold: 1 });
    expect(Math.abs(real.travel - free.travel)).toBeLessThan(2);
    expect(Math.abs(real.airtime - free.airtime)).toBeLessThan(0.1);
    expect(Math.abs(real.apex - free.apex)).toBeLessThan(2);
  });

  test('off a mid-air seed, flat, then air jump + dash (the jump cancels the dash): the longest launch', () => {
    // The best of the reference over analog aims and press ticks is at 32°, dash at R+39, air jump at R+48.
    const aimDeg = 32;
    const plan = { hold: 1, dash: 39, airJump: 48 };
    const a = (aimDeg * Math.PI) / 180;
    const free = freeFlight(Math.cos(a), -Math.sin(a), plan);
    expect(Math.abs(free.travel - LAUNCH_REACH.midAir)).toBeLessThan(2);
    for (const deg of [aimDeg - 2, aimDeg + 2]) {
      const r = (deg * Math.PI) / 180;
      expect(freeFlight(Math.cos(r), -Math.sin(r), plan).travel).toBeLessThan(free.travel);
    }
    // In the air at the top of a jump (vx = 0, vy ≈ 0), grab a seed and launch.
    const rig = pillar();
    const p = rig.world.player;
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.until((w) => w.player.vy >= 0, (f) => {
      f.jumpHeld = true;
    }, 60);
    grabAnchor(rig, (f) => {
      f.jumpHeld = true;
    });
    expect(p.grounded).toBe(false);
    const real = realFlight(rig, Math.cos(a), -Math.sin(a), plan);
    expect(Math.abs(real.travel - free.travel)).toBeLessThan(2);
    expect(rig.eventsOf(SimEventType.DashEnd).at(-1)?.b).toBe(1);
  });
});

/** The corrected no-launch rows of §5.4 (documented values; the plans live in tools/level/analysis.ts). */
const NO_LAUNCH = {
  airDashJump: 1064,
  dashJump: 1346,
} as const;

describe('no-launch reach (§5.4, the corrected rows)', () => {
  test('jump + air dash, cancelled by the air jump (keeps the dash speed): ≈ 1064 u', () => {
    expect(Math.abs(noLaunchLead(NO_LAUNCH_PLANS.airDashJump) - NO_LAUNCH.airDashJump)).toBeLessThan(2);
  });

  test('ground dash → coyote jump (cancels) + air dash + air jump (cancels): ≈ 1346 u', () => {
    expect(Math.abs(noLaunchLead(NO_LAUNCH_PLANS.dashJump) - NO_LAUNCH.dashJump)).toBeLessThan(2);
  });
});

/**
 * The Thornveil's launch-only landings and its stun gate (§5.4), on forest.ldtk: the conservative
 * no-launch closure excludes each, a bot search over ground dash × jump (grounded or coyote) × air dash
 * × air jump timings fails, and a scripted launch with a keyboard direction lands (or passes).
 */
const forest: LevelData = parseLdtk(JSON.parse(readFileSync(LDTK_PATH, 'utf8')));
const SPACE: SearchSpace = {
  groundDash: [-1, ...ticks(0, 12, 4)],
  jump: ticks(0, 44, 2),
  airDash: [-1, ...ticks(1, 37, 6)],
  airJump: [-1, ...ticks(1, 61, 2)],
};
/** The bot searches run tens of thousands of attempts. */
const SEARCH_TIMEOUT = 60_000;
const key = (c: Cell): string => `${c.tx},${c.ty}`;
const standsOn = (w: GameWorld, landing: readonly Cell[]): boolean =>
  w.player.grounded && landing.some((c) => w.player.y === c.ty * T && Math.abs(w.player.x - (c.tx + 0.5) * T) < T / 2 + w.player.width / 2);

describe('Thornveil gates (§5.4 launch-only landings and the stun gate, forest.ldtk)', () => {
  test('controls: the closure from the shrine exit reaches level A and the pit; the bot search finds level A', () => {
    const closure = noLaunchClosure(forest, [VEIL.shrineExit]);
    const levelA = [...cellsOf(176, 178, 28), ...cellsOf(183, 186, 28)];
    const pit = cellsOf(179, 182, 30);
    expect(levelA.filter((c) => closure.floors.has(key(c)))).toEqual(levelA);
    expect(pit.filter((c) => closure.floors.has(key(c)))).toEqual(pit);
    const start = { x: VEIL.shrineExit.tx + 0.5, y: VEIL.shrineExit.ty, dir: 1 as const };
    expect(searchLands(forest, [start], { groundDash: [-1], jump: ticks(0, 20, 2), airDash: [-1], airJump: [-1, ...ticks(1, 30, 2)] }, cellsOf(176, 178, 28))).not.toBeNull();
  });

  test('the teach alcove: out of the closure, no no-launch timing lands, a straight-up launch off a seed does', () => {
    const closure = noLaunchClosure(forest, [VEIL.shrineExit]);
    expect(VEIL.teach.landing.filter((c) => closure.floors.has(key(c)))).toEqual([]);
    expect(searchLands(forest, VEIL.teach.starts, SPACE, VEIL.teach.landing)).toBeNull();
    // From level A at the pit's west edge, off a seed of the teach stream.
    const bot = gateBot(forest, 178.96, 28);
    bot.launch(0, -1, (w) => w.launch.candidateKind === 'seed');
    expect(bot.w.launch.targetKind).toBe('seed');
    bot.fly(0);
    expect(standsOn(bot.w, VEIL.teach.landing)).toBe(true);
  }, SEARCH_TIMEOUT);

  test('the rise gate: out of the closure, no no-launch timing lands, launching off a lobbed seed does', () => {
    const closure = noLaunchClosure(forest, [VEIL.shrineExit]);
    const beyond = [...VEIL.rise.landing, ...VEIL.stun.beyond, ...VEIL.vertical.landing];
    expect(beyond.filter((c) => closure.floors.has(key(c)))).toEqual([]);
    expect(searchLands(forest, VEIL.rise.starts, SPACE, VEIL.rise.landing)).toBeNull();
    // Off a seed from the chasm: straight up, then drift over the step (with or without the air jump);
    // or up-right with the air jump at the apex (the diagonal from standing).
    for (const [mx, my, airJump] of [[0, -1, false], [0, -1, 'apex'], [DIAG, -DIAG, 'apex']] as const) {
      const bot = gateBot(forest, VEIL.rise.edge.x, VEIL.rise.edge.y);
      bot.launch(mx, my, (w) => w.launch.candidateKind === 'seed');
      bot.fly(1, { airJump });
      expect(standsOn(bot.w, VEIL.rise.landing), `aim (${mx.toFixed(2)}, ${my.toFixed(2)}) air jump ${airJump}`).toBe(true);
    }
    // The diagonal: as a seed leaves the chasm spitter, jump, and grab it near the top of the jump.
    const chasm = anchorSpitter(VEIL.rise.edge.x, 4);
    const diag = gateBot(forest, VEIL.rise.edge.x, VEIL.rise.edge.y);
    diag.hold(0, () => diag.rig.eventsOf(SimEventType.SeedFired).some((e) => e.x === chasm.x), 300);
    diag.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    for (let i = 0; i < 7; i++) {
      diag.step((f) => {
        f.jumpHeld = true;
      });
    }
    diag.launch(DIAG, -DIAG, (w) => w.launch.candidateKind === 'seed', 40, 0, (f) => {
      f.jumpHeld = true;
    });
    expect(diag.w.launch.targetKind).toBe('seed');
    diag.fly(1);
    expect(standsOn(diag.w, VEIL.rise.landing)).toBe(true);
  }, SEARCH_TIMEOUT);

  test('the stun gate: sealed by the spitter in the closure, no timing gets past it, a launch off it does', () => {
    const s = stunSpitter(forest);
    const closure = noLaunchClosure(forest, [VEIL.stun.from], { blockers: [spitterBox(s)] });
    expect(VEIL.stun.beyond.filter((c) => closure.floors.has(key(c)))).toEqual([]);
    const space: SearchSpace = { groundDash: [-1, 0, 3, 6], jump: ticks(0, 30, 3), airDash: [-1, 2, 6, 10, 14], airJump: [-1, 2, 6, 10, 14, 20] };
    expect(stunSearch(forest, VEIL.stun.starts, space)).toBeNull();
    expect(stunSearch(forest, VEIL.stun.starts, space, false)).not.toBeNull();
    // Launch off its body (aiming up into the passage ceiling stuns it and goes nowhere), then walk through.
    const body = gateBot(forest, 203.5, 22);
    body.hold(1, (w) => w.launch.candidateKind === 'enemy' && w.launch.candidateId === s.id, 200);
    body.launch(0, -1);
    expect(body.w.enemies[s.id]?.mode).toBe('stunned');
    body.hold(1, (w) => w.player.x > VEIL.stun.beyond[0]!.tx * T + T / 2, 300);
    // Or fling one of its own seeds back at it (launch away from it along the passage).
    const seed = gateBot(forest, 203.5, 22);
    seed.launch(-1, 0, (w) => w.launch.candidateKind === 'seed', 400);
    seed.hold(0, (w) => w.enemies[s.id]?.mode === 'stunned', 60);
    expect(seed.rig.eventsOf(SimEventType.EnemyHit).at(-1)?.id).toBe(s.id);
    seed.hold(1, (w) => w.player.x > VEIL.stun.beyond[0]!.tx * T + T / 2, 300);
  }, SEARCH_TIMEOUT);

  test('the vertical gate: out of the closure, no no-launch timing lands, a straight-up launch off a seed does', () => {
    const closure = noLaunchClosure(forest, [VEIL.vertical.from]);
    expect(VEIL.vertical.landing.filter((c) => closure.floors.has(key(c)))).toEqual([]);
    expect(searchLands(forest, VEIL.vertical.starts, SPACE, VEIL.vertical.landing)).toBeNull();
    const bot = gateBot(forest, 214.9, 19);
    bot.launch(0, -1, (w) => w.launch.candidateKind === 'seed');
    expect(bot.w.launch.targetKind).toBe('seed');
    bot.fly(0);
    expect(standsOn(bot.w, VEIL.vertical.landing)).toBe(true);
    expect(bot.p.y).toBe(VEIL.vertical.landing[0]!.ty * T);
  }, SEARCH_TIMEOUT);

  test('the seed gates are comfortable: every shot gives a window of several ticks, not one frame', () => {
    // Press launch d ticks after the stream fires (d over one period), grab a seed and launch as scripted.
    const gates: [string, LaunchSpot, ReturnType<typeof anchorSpitter>, readonly Cell[]][] = [
      ['teach', { x: 178.96, y: 28, mx: 0, my: -1, hold: 0, airJump: false }, anchorSpitter(181.5, 1), VEIL.teach.landing],
      ['rise, up', { x: VEIL.rise.edge.x, y: VEIL.rise.edge.y, mx: 0, my: -1, hold: 1, airJump: true }, anchorSpitter(VEIL.rise.edge.x, 4), VEIL.rise.landing],
      ['rise, up-right', { x: VEIL.rise.edge.x, y: VEIL.rise.edge.y, mx: DIAG, my: -DIAG, hold: 1, airJump: true }, anchorSpitter(VEIL.rise.edge.x, 4), VEIL.rise.landing],
      ['vertical', { x: 214.9, y: 19, mx: 0, my: -1, hold: 0, airJump: false }, anchorSpitter(216.5, 1), VEIL.vertical.landing],
    ];
    for (const [name, spot, spitter, landing] of gates) {
      const ok = launchWindow(forest, spot, spitter, landing);
      expect(longestRun(ok), `${name}: landing press offsets ${JSON.stringify(ok)}`).toBeGreaterThanOrEqual(MIN_WINDOW);
    }
  }, SEARCH_TIMEOUT);
});

/** Consecutive press ticks per shot that a seed gate must accept. */
const MIN_WINDOW = 8;

function cellsOf(x0: number, x1: number, ty: number): Cell[] {
  const out: Cell[] = [];
  for (let tx = x0; tx <= x1; tx++) out.push({ tx, ty });
  return out;
}

/** The fixed-aim spitter within `within` tiles of column x (tiles). */
function anchorSpitter(x: number, within: number): SpitterDef {
  const s = forest.enemies.find((e): e is SpitterDef => e.kind === 'thornSpitter' && e.aim === 'fixed' && Math.abs(e.x - x * T) < within * T);
  if (!s) throw new Error(`forest.ldtk: no fixed-aim spitter near column ${x}`);
  return s;
}
