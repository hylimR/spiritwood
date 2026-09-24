import type { GradeParams } from '../../contracts/render.ts';
import { TIME_SCALE_EASE, TIME_SCALE_FROZEN, TIME_SCALE_RELEASE } from '../../config.ts';

/**
 * The world animation clock (FrameInfo.worldTime, ARCHITECTURE.md §5.5). The time scale s relaxes
 * exponentially toward its goal g: s ← g + (s − g)·e^(−dt/τ), with g = TIME_SCALE_FROZEN and
 * τ = TIME_SCALE_EASE while the sim is frozen for a Spirit Launch aim, and g = 1, τ = TIME_SCALE_RELEASE
 * otherwise. `dt` is the exact integral of s over the frame, g·dt + (s₀ − g)·τ·(1 − e^(−dt/τ)), so
 * splitting an interval into more frames changes nothing but rounding while the goal stays put. The
 * goal comes from `sim.frozen`, read once per rendered frame, so a freeze or release on a sim tick
 * inside a frame applies to that whole frame: across frame rates, world time then differs by at most
 * one frame's worth (switches on frame boundaries are exact).
 */
export class WorldClock {
  /** Accumulated world time (s). */
  time = 0;
  /** World time advanced by the last `advance` (s). */
  dt = 0;
  /** Time scale at the end of the last `advance`. */
  scale = 1;

  /** Advance by the (already clamped) render dt. */
  advance(dt: number, frozen: boolean): void {
    if (!(dt > 0)) {
      this.dt = 0;
      return;
    }
    const g = frozen ? TIME_SCALE_FROZEN : 1;
    const tau = frozen ? TIME_SCALE_EASE : TIME_SCALE_RELEASE;
    const s0 = this.scale;
    const e = Math.exp(-dt / tau);
    this.dt = g * dt + (s0 - g) * tau * (1 - e);
    this.scale = g + (s0 - g) * e;
    this.time += this.dt;
  }

  reset(): void {
    this.time = 0;
    this.dt = 0;
    this.scale = 1;
  }
}

/** Freeze grade strengths at full freeze (§5.5): saturation ×(1 − 0.35k), temperature −0.3k, vignette +0.15k. */
export const FREEZE_GRADE = Object.freeze({
  desaturate: 0.35,
  cool: 0.3,
  vignette: 0.15,
});

/** Freeze amount k = (1 − s)/(1 − TIME_SCALE_FROZEN): 0 at full speed, 1 at the frozen crawl. */
export function freezeAmount(scale: number): number {
  const k = (1 - scale) / (1 - TIME_SCALE_FROZEN);
  return k <= 0 ? 0 : k >= 1 ? 1 : k;
}

/** Apply the freeze grade for amount `k` to the blended grade, in place (CPU only, no shader cost). */
export function applyFreezeGrade(g: GradeParams, k: number): GradeParams {
  if (k <= 0) return g;
  g.saturation *= 1 - FREEZE_GRADE.desaturate * k;
  g.temperature -= FREEZE_GRADE.cool * k;
  g.vignette += FREEZE_GRADE.vignette * k;
  return g;
}
