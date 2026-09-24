export interface DynResOptions {
  initial: number;
  min: number;
  step: number;
  /**
   * A frame is a miss when the loop reports lateFrames > 0 AND (GPU time unknown OR GPU time > this).
   * CPU hitches with a fast GPU are not misses (lowering resolution cannot fix them).
   */
  dropGpuMs: number;
  /** Misses within the window that trigger a step down. */
  missesToDrop: number;
  windowFrames: number;
  /** Seconds without misses before stepping up. */
  raiseAfterSec: number;
  /** When GPU time is known, only raise if it is below this (ms). */
  raiseGpuMs: number;
  /** Minimum seconds between changes. */
  cooldownSec: number;
}

export const DEFAULT_DYNRES: Readonly<DynResOptions> = Object.freeze({
  initial: 1, min: 0.7, step: 0.05, dropGpuMs: 14, missesToDrop: 2, windowFrames: 30,
  raiseAfterSec: 3, raiseGpuMs: 13, cooldownSec: 1,
});

/** Snap to 1e-4 so repeated ±step never accumulates float drift. */
function snap(v: number): number {
  return Math.round(v * 1e4) / 1e4;
}

/**
 * Pure dynamic-resolution policy (ARCHITECTURE.md §5.7). No allocation per update.
 *
 * - miss = lateFrames > 0 && (gpuMs < 0 || gpuMs > dropGpuMs); ≥ missesToDrop misses among the last
 *   windowFrames frames step the scale down (and clear the window).
 * - raiseAfterSec without a miss *and* without a change, with gpuMs unknown or < raiseGpuMs, steps up.
 * - At most one change per cooldownSec; the scale stays within [min, initial]. `reset` starts a cooldown
 *   so start-up hitches (shader compiles, uploads) cannot drop the scale immediately.
 */
export class DynamicResolution {
  private readonly opts: DynResOptions;
  private readonly misses: Uint8Array;
  private head = 0;
  private missCount = 0;
  private current: number;
  private initial: number;
  private min: number;
  private lastChangeAt = -Infinity;
  private lastMissAt = -Infinity;

  constructor(options: Partial<DynResOptions> = {}) {
    this.opts = { ...DEFAULT_DYNRES, ...options };
    this.misses = new Uint8Array(Math.max(1, Math.floor(this.opts.windowFrames)));
    this.initial = this.opts.initial;
    this.min = Math.min(this.opts.min, this.opts.initial);
    this.current = this.initial;
  }

  get scale(): number {
    return this.current;
  }

  /** Misses currently inside the window (for the debug overlay and tests). */
  get recentMisses(): number {
    return this.missCount;
  }

  /** Feed one rendered frame. `gpuMs` < 0 when unknown. Returns the (possibly changed) scale. */
  update(lateFrames: number, gpuMs: number, nowSec: number): number {
    const o = this.opts;
    const miss = lateFrames > 0 && (gpuMs < 0 || gpuMs > o.dropGpuMs) ? 1 : 0;
    this.missCount += miss - (this.misses[this.head] as number);
    this.misses[this.head] = miss;
    this.head = (this.head + 1) % this.misses.length;
    if (miss) this.lastMissAt = nowSec;

    if (nowSec - this.lastChangeAt < o.cooldownSec) return this.current;

    if (this.missCount >= o.missesToDrop) {
      if (this.current > this.min) {
        this.current = snap(Math.max(this.min, this.current - o.step));
        this.lastChangeAt = nowSec;
        this.clearWindow();
      }
      return this.current;
    }

    const quietSince = Math.max(this.lastMissAt, this.lastChangeAt);
    const gpuOk = gpuMs < 0 || gpuMs < o.raiseGpuMs;
    if (this.current < this.initial && gpuOk && nowSec - quietSince >= o.raiseAfterSec) {
      this.current = snap(Math.min(this.initial, this.current + o.step));
      this.lastChangeAt = nowSec;
    }
    return this.current;
  }

  reset(initial: number, min: number, nowSec: number): void {
    this.initial = initial;
    this.min = Math.min(min, initial);
    this.current = initial;
    this.lastChangeAt = nowSec;
    this.lastMissAt = -Infinity;
    this.clearWindow();
  }

  private clearWindow(): void {
    this.misses.fill(0);
    this.missCount = 0;
    this.head = 0;
  }
}
