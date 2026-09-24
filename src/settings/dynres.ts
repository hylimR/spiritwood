import { todo } from '../core/todo.ts';

export interface DynResOptions {
  initial: number;
  min: number;
  step: number;
  /** Frame time (ms) above which a frame counts as a miss. */
  missMs: number;
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
  initial: 1, min: 0.7, step: 0.05, missMs: 17.5, missesToDrop: 2, windowFrames: 30,
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

  /** Feed one frame. `gpuMs` < 0 when unknown. Returns the (possibly changed) scale. */
  update(frameMs: number, gpuMs: number, nowSec: number): number {
    void frameMs; void gpuMs; void nowSec;
    return todo('PIPE', 'DynamicResolution.update');
  }

  reset(initial: number, min: number, nowSec: number): void {
    void initial; void min; void nowSec;
    todo('PIPE', 'DynamicResolution.reset');
  }
}
