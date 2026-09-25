import { describe, expect, test } from 'vitest';
import { MAX_RENDER_DT, TIME_SCALE_EASE, TIME_SCALE_FROZEN, TIME_SCALE_RELEASE } from '../../src/config.ts';
import { FixedStepLoop } from '../../src/core/loop.ts';
import { applyFreezeGrade, FREEZE_GRADE, freezeAmount, WorldClock } from '../../src/render/post/worldClock.ts';
import { createGradeParams } from '../../src/render/post/grade.ts';

/** Frozen on [0.5 s, 1.5 s) and [2 s, 2 + 1/6 s), released otherwise, for 3 s at `fps`. */
function scenario(fps: number): WorldClock {
  const clock = new WorldClock();
  const n = Math.round(3 * fps);
  for (let i = 0; i < n; i++) {
    const t = i / fps;
    const frozen = (t >= 0.5 - 1e-9 && t < 1.5 - 1e-9) || (t >= 2 - 1e-9 && t < 2 + 1 / 6 - 1e-9);
    clock.advance(1 / fps, frozen);
  }
  return clock;
}

/** s(t) under a constant goal: g + (s0 − g)·e^(−t/τ). */
function relax(s0: number, g: number, tau: number, t: number): number {
  return g + (s0 - g) * Math.exp(-t / tau);
}

/**
 * The real loop at `fps` for `seconds`: sim ticks set `frozen` on tick `from` and clear it on tick `to`
 * (a LaunchAim and its Launch), and each rendered frame advances the clock by its clamped dt, reading
 * `frozen` after the frame's steps like pipeline.render.
 */
function loopRun(fps: number, from: number, to: number, seconds: number): number {
  let tick = 0;
  let frozen = false;
  const clock = new WorldClock();
  const loop = new FixedStepLoop({
    beginFrame() {},
    step() {
      tick++;
      if (tick === from) frozen = true;
      if (tick === to) frozen = false;
    },
    render(_alpha, frameDt) {
      clock.advance(frameDt > 0 ? Math.min(frameDt, MAX_RENDER_DT) : 0, frozen);
    },
  }, { fpsCap: 0 });
  const n = Math.round(seconds * fps);
  for (let i = 0; i <= n; i++) loop.frame((i * 1000) / fps);
  return clock.time;
}

describe('world clock', () => {
  test('switches on frame boundaries: the same worldTime at 30, 60 and 144 fps (1e-6)', () => {
    const a = scenario(30);
    const b = scenario(60);
    const c = scenario(144);
    expect(Math.abs(a.time - b.time)).toBeLessThan(1e-6);
    expect(Math.abs(b.time - c.time)).toBeLessThan(1e-6);
    expect(Math.abs(a.scale - c.scale)).toBeLessThan(1e-9);
    // The freezes really slowed the world: about 1.07 s of the 3 s were lost to them.
    expect(c.time).toBeGreaterThan(1.9);
    expect(c.time).toBeLessThan(2.2);
  });

  test('switches on sim ticks inside frames: 30, 60 and 144 fps differ by at most one frame\'s worth', () => {
    const rates = [30, 60, 144];
    for (const [from, to] of [[31, 97], [32, 98], [31, 33], [45, 46], [50, 170]] as const) {
      const times = rates.map((fps) => loopRun(fps, from, to, 4));
      // A freeze of a second or more really slows the world.
      if (to - from >= 60) expect(times[2] as number).toBeLessThan(3.5);
      for (let a = 0; a < rates.length; a++) {
        for (let b = a + 1; b < rates.length; b++) {
          const frame = 1 / Math.min(rates[a] as number, rates[b] as number);
          expect(Math.abs((times[a] as number) - (times[b] as number)), `ticks [${from}, ${to}) ${rates[a]} vs ${rates[b]} fps`)
            .toBeLessThanOrEqual(frame);
        }
      }
    }
  });

  test('worldDt is the exact integral of the eased scale over the frame', () => {
    for (const [frozen, s0, dt] of [[true, 1, 1 / 60], [false, TIME_SCALE_FROZEN, 1 / 60], [true, 0.5, 1 / 20], [false, 0.3, 0.004]] as const) {
      const clock = new WorldClock();
      clock.scale = s0;
      clock.advance(dt, frozen);
      const g = frozen ? TIME_SCALE_FROZEN : 1;
      const tau = frozen ? TIME_SCALE_EASE : TIME_SCALE_RELEASE;
      // Midpoint-rule integral of s(t) over [0, dt].
      const steps = 20000;
      let sum = 0;
      for (let k = 0; k < steps; k++) sum += relax(s0, g, tau, ((k + 0.5) / steps) * dt);
      expect(clock.dt).toBeCloseTo((sum * dt) / steps, 9);
      expect(clock.dt).toBeCloseTo(g * dt + (s0 - g) * tau * (1 - Math.exp(-dt / tau)), 12);
      expect(clock.scale).toBeCloseTo(relax(s0, g, tau, dt), 12);
      expect(clock.time).toBe(clock.dt);
    }
  });

  test('freeze eases toward TIME_SCALE_FROZEN with τ = TIME_SCALE_EASE; release snaps back with τ = TIME_SCALE_RELEASE', () => {
    const clock = new WorldClock();
    const dt = TIME_SCALE_EASE / 15;
    for (let i = 0; i < 15; i++) clock.advance(dt, true);
    expect(clock.scale).toBeCloseTo(TIME_SCALE_FROZEN + (1 - TIME_SCALE_FROZEN) / Math.E, 9);
    for (let i = 0; i < 240; i++) clock.advance(dt, true);
    expect(clock.scale).toBeCloseTo(TIME_SCALE_FROZEN, 6);
    const s0 = clock.scale;
    clock.advance(TIME_SCALE_RELEASE, false);
    expect(clock.scale).toBeCloseTo(1 + (s0 - 1) / Math.E, 9);
    // Release is fast: back above 99 % within 5 τ.
    for (let i = 0; i < 4; i++) clock.advance(TIME_SCALE_RELEASE, false);
    expect(clock.scale).toBeGreaterThan(0.99);
    expect(TIME_SCALE_RELEASE).toBeLessThan(TIME_SCALE_EASE);
  });

  test('zero-length frames change nothing', () => {
    const clock = new WorldClock();
    clock.advance(1 / 60, true);
    const { time, scale } = clock;
    clock.advance(0, true);
    expect(clock.dt).toBe(0);
    expect(clock.time).toBe(time);
    expect(clock.scale).toBe(scale);
  });
});

describe('freeze grade', () => {
  test('k = (1 − s)/(1 − TIME_SCALE_FROZEN), clamped to 0..1', () => {
    expect(freezeAmount(1)).toBe(0);
    expect(freezeAmount(TIME_SCALE_FROZEN)).toBeCloseTo(1, 12);
    expect(freezeAmount((1 + TIME_SCALE_FROZEN) / 2)).toBeCloseTo(0.5, 12);
    expect(freezeAmount(1.2)).toBe(0);
    expect(freezeAmount(0)).toBe(1);
  });

  test('saturation × (1 − 0.35k), temperature − 0.3k, vignette + 0.15k; nothing else', () => {
    expect(FREEZE_GRADE).toEqual({ desaturate: 0.35, cool: 0.3, vignette: 0.15 });
    for (const k of [0, 0.25, 1]) {
      const g = createGradeParams();
      g.saturation = 1.04;
      g.temperature = -0.06;
      g.vignette = 0.3;
      g.exposure = 1.1;
      applyFreezeGrade(g, k);
      expect(g.saturation).toBeCloseTo(1.04 * (1 - 0.35 * k), 12);
      expect(g.temperature).toBeCloseTo(-0.06 - 0.3 * k, 12);
      expect(g.vignette).toBeCloseTo(0.3 + 0.15 * k, 12);
      expect(g.exposure).toBe(1.1);
      expect(g.lift).toEqual([0, 0, 0]);
    }
  });
});
