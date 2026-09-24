import { todo } from '../core/todo.ts';

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

/** Pure dynamic-resolution policy (ARCHITECTURE.md §5.7). No allocation per update. */
export class DynamicResolution {
  constructor(options: Partial<DynResOptions> = {}) {
    void options;
    todo('PIPE', 'DynamicResolution');
  }

  get scale(): number {
    return todo('PIPE', 'DynamicResolution.scale');
  }

  /** Feed one rendered frame. `gpuMs` < 0 when unknown. Returns the (possibly changed) scale. */
  update(lateFrames: number, gpuMs: number, nowSec: number): number {
    void lateFrames; void gpuMs; void nowSec;
    return todo('PIPE', 'DynamicResolution.update');
  }

  reset(initial: number, min: number, nowSec: number): void {
    void initial; void min; void nowSec;
    todo('PIPE', 'DynamicResolution.reset');
  }
}
