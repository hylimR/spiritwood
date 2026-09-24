import { describe, expect, test } from 'vitest';
import { SIM_DT } from '../../src/config.ts';
import type { InputFrame } from '../../src/contracts/input.ts';
import { DEFAULT_TUNING, deriveTuning } from '../../src/sim/tuning.ts';
import { Bot } from './bot.ts';
import { MapBuilder, T, WorldRig } from './helpers.ts';

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
