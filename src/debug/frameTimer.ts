import type { FrameStats } from '../contracts/debug.ts';
import { todo } from '../core/todo.ts';

/**
 * Rolling frame statistics over the last `windowFrames` frames (ring buffer, no allocation):
 * fps, average frame ms, 1%-low (mean of the worst 1% frame times, at least 1 sample), sim/render ms.
 */
export class FrameTimer {
  readonly stats: FrameStats = { fps: 0, frameMsAvg: 0, frameMs1pLow: 0, simStepsLastFrame: 0, simMs: 0, renderCpuMs: 0 };

  constructor(windowFrames = 240) {
    void windowFrames;
    todo('PIPE', 'FrameTimer');
  }

  /** Record a rendered frame's wall-clock delta (ms). */
  frame(frameMs: number, simSteps: number, simMs: number, renderCpuMs: number): void {
    void frameMs; void simSteps; void simMs; void renderCpuMs;
    todo('PIPE', 'FrameTimer.frame');
  }

  /** Recompute `stats` (call at ≤ 4 Hz; sorting a copy of the window is fine here). */
  refresh(): FrameStats {
    return todo('PIPE', 'FrameTimer.refresh');
  }

  /** Percentile (0..100) of the current window's frame times in ms. */
  percentile(p: number): number {
    void p;
    return todo('PIPE', 'FrameTimer.percentile');
  }

  reset(): void {
    todo('PIPE', 'FrameTimer.reset');
  }
}
