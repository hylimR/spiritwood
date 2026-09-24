import { describe, expect, test } from 'vitest';
import { DEFAULT_DYNRES, DynamicResolution } from '../../src/settings/dynres.ts';

const D = DEFAULT_DYNRES;
const FRAME = 1 / 60;

/** Feed `frames` frames of the given kind starting at `t`, returning the time after the last one. */
function run(dr: DynamicResolution, t: number, frames: number, late: number, gpuMs: number, dt = FRAME): number {
  for (let i = 0; i < frames; i++) {
    t += dt;
    dr.update(late, gpuMs, t);
  }
  return t;
}

const CLEAN_AFTER_BURST = Math.ceil(D.cooldownSec / FRAME) + 2;

/** Two misses (one step down) followed by a cooldown's worth of clean frames. */
function burst(dr: DynamicResolution, t: number): number {
  return run(dr, run(dr, t, 2, 1, -1), CLEAN_AFTER_BURST, 0, -1);
}

function fresh(): { dr: DynamicResolution; t: number } {
  const dr = new DynamicResolution({ initial: 1, min: 0.7 });
  dr.reset(1, 0.7, 0);
  return { dr, t: D.cooldownSec + 0.001 };
}

describe('DynamicResolution', () => {
  test('starts at initial and does not change on clean frames', () => {
    const { dr, t } = fresh();
    run(dr, t, 600, 0, 8);
    expect(dr.scale).toBe(1);
  });

  test('two misses in the window drop one step; one miss does not', () => {
    const { dr, t } = fresh();
    let now = run(dr, t, 1, 1, -1);
    now = run(dr, now, 10, 0, -1);
    expect(dr.scale).toBe(1);
    run(dr, now, 1, 1, -1);
    expect(dr.scale).toBeCloseTo(1 - D.step, 9);
  });

  test('misses older than the window do not count', () => {
    const { dr, t } = fresh();
    let now = run(dr, t, 1, 1, -1);
    now = run(dr, now, D.windowFrames, 0, -1);
    run(dr, now, 1, 1, -1);
    expect(dr.scale).toBe(1);
  });

  test('a late frame with a fast GPU is not a miss (CPU hitch)', () => {
    const { dr, t } = fresh();
    run(dr, t, 60, 1, D.dropGpuMs - 1);
    expect(dr.scale).toBe(1);
    run(dr, t + 2, 3, 1, D.dropGpuMs + 1);
    expect(dr.scale).toBeCloseTo(1 - D.step, 9);
  });

  test('a slow GPU without late frames is not a miss', () => {
    const { dr, t } = fresh();
    run(dr, t, 120, 0, 30);
    expect(dr.scale).toBe(1);
  });

  test('cooldown: continuous misses step down at most once per cooldown', () => {
    const { dr, t } = fresh();
    const changes: number[] = [];
    let prev = dr.scale;
    let now = t;
    for (let i = 0; i < 60 * 5; i++) {
      now += FRAME;
      dr.update(1, -1, now);
      if (dr.scale !== prev) {
        changes.push(now);
        prev = dr.scale;
      }
    }
    expect(changes.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < changes.length; i++) {
      expect((changes[i] as number) - (changes[i - 1] as number)).toBeGreaterThanOrEqual(D.cooldownSec - 1e-9);
    }
  });

  test('reset starts a cooldown (start-up hitches do not drop)', () => {
    const dr = new DynamicResolution();
    dr.reset(1, 0.7, 10);
    run(dr, 10, Math.floor(D.cooldownSec / FRAME) - 2, 1, -1);
    expect(dr.scale).toBe(1);
  });

  test('clamped to min', () => {
    const { dr, t } = fresh();
    run(dr, t, 60 * 30, 1, -1);
    expect(dr.scale).toBeCloseTo(0.7, 9);
  });

  test('raises one step per quiet period, clamped to initial', () => {
    const { dr, t } = fresh();
    let now = t;
    for (let i = 0; i < 3; i++) now = burst(dr, now);
    expect(dr.scale).toBeCloseTo(1 - 3 * D.step, 9);
    const quietFrom = now - CLEAN_AFTER_BURST * FRAME;
    now = run(dr, now, Math.floor((quietFrom + D.raiseAfterSec - 0.05 - now) / FRAME), 0, -1);
    expect(dr.scale).toBeCloseTo(1 - 3 * D.step, 9);
    now = run(dr, now, 6, 0, -1);
    expect(dr.scale).toBeCloseTo(1 - 2 * D.step, 9);
    now = run(dr, now, Math.floor((D.raiseAfterSec - 0.05) / FRAME), 0, -1);
    expect(dr.scale).toBeCloseTo(1 - 2 * D.step, 9);
    run(dr, now, 60 * 60, 0, 5);
    expect(dr.scale).toBe(1);
  });

  test('raise is gated on GPU time when known', () => {
    const { dr, t } = fresh();
    const now = burst(dr, t);
    const low = dr.scale;
    expect(low).toBeCloseTo(1 - D.step, 9);
    const later = run(dr, now, 60 * 10, 0, D.raiseGpuMs + 0.5);
    expect(dr.scale).toBe(low);
    run(dr, later, 12, 0, D.raiseGpuMs - 0.5);
    expect(dr.scale).toBe(1);
  });

  test('144 Hz display with the 60 fps cap (13.9 / 20.8 ms cadence, lateFrames 0) never drops', () => {
    const { dr } = fresh();
    let now = 5;
    for (let i = 0; i < 144 * 60; i++) {
      now += i % 2 === 0 ? 0.0139 : 0.0208;
      dr.update(0, -1, now);
    }
    expect(dr.scale).toBe(1);
  });

  test('reset changes the range', () => {
    const dr = new DynamicResolution();
    dr.reset(0.9, 0.6, 0);
    expect(dr.scale).toBe(0.9);
    run(dr, 1.01, 60 * 40, 1, -1);
    expect(dr.scale).toBeCloseTo(0.6, 9);
    dr.reset(0.8, 0.9, 100);
    expect(dr.scale).toBe(0.8);
    run(dr, 101.01, 60 * 5, 1, -1);
    expect(dr.scale).toBe(0.8);
  });

  test('scale values stay on the 0.05 grid (no float drift)', () => {
    const { dr, t } = fresh();
    let now = t;
    for (let cycle = 0; cycle < 5; cycle++) {
      now = run(dr, now, 60 * 8, 1, -1);
      now = run(dr, now, 60 * 30, 0, -1);
    }
    expect(Math.abs(dr.scale * 20 - Math.round(dr.scale * 20))).toBeLessThan(1e-9);
    expect(dr.scale).toBe(1);
  });
});
