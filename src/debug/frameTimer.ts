import type { FrameStats } from '../contracts/debug.ts';

/**
 * Percentile (0..100) of the first `n` values of an ascending-sorted array, linearly interpolated
 * between closest ranks (NumPy's default). NaN when n = 0.
 */
export function sortedPercentile(sorted: ArrayLike<number>, n: number, p: number): number {
  if (n <= 0) return Number.NaN;
  const pos = (Math.min(100, Math.max(0, p)) / 100) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  const a = sorted[lo] as number;
  return a + ((sorted[hi] as number) - a) * (pos - lo);
}

/** Mean of the worst 1% (largest) values of an ascending-sorted array — at least one sample. */
export function sortedWorstPercentMean(sorted: ArrayLike<number>, n: number, percent = 1): number {
  if (n <= 0) return Number.NaN;
  const k = Math.max(1, Math.floor((n * percent) / 100));
  let sum = 0;
  for (let i = n - k; i < n; i++) sum += sorted[i] as number;
  return sum / k;
}

/**
 * Rolling frame statistics over the last `windowFrames` frames (ring buffer, no allocation):
 * fps, average frame ms, 1%-low (mean of the worst 1% frame times, at least 1 sample), sim/render ms.
 */
export class FrameTimer {
  readonly stats: FrameStats = {
    fps: 0, frameMsAvg: 0, frameMs1pLow: 0, simStepsLastFrame: 0, simMs: 0, renderCpuMs: 0, lateFramePct: 0,
  };

  private readonly frameMs: Float64Array;
  private readonly simMs: Float64Array;
  private readonly renderMs: Float64Array;
  private readonly late: Uint8Array;
  private readonly sorted: Float64Array;
  private head = 0;
  private count = 0;
  private lastSteps = 0;

  constructor(windowFrames = 240) {
    const n = Math.max(1, Math.floor(windowFrames));
    this.frameMs = new Float64Array(n);
    this.simMs = new Float64Array(n);
    this.renderMs = new Float64Array(n);
    this.late = new Uint8Array(n);
    this.sorted = new Float64Array(n);
  }

  /** Record a rendered frame's wall-clock delta (ms) and the loop's lateFrames for it. */
  frame(frameMs: number, lateFrames: number, simSteps: number, simMs: number, renderCpuMs: number): void {
    const i = this.head;
    this.frameMs[i] = frameMs;
    this.simMs[i] = simMs;
    this.renderMs[i] = renderCpuMs;
    this.late[i] = lateFrames > 0 ? 1 : 0;
    this.head = (i + 1) % this.frameMs.length;
    if (this.count < this.frameMs.length) this.count++;
    this.lastSteps = simSteps;
  }

  /** Recompute `stats` (call at ≤ 4 Hz; sorting a copy of the window is fine here). */
  refresh(): FrameStats {
    const s = this.stats;
    const n = this.count;
    s.simStepsLastFrame = this.lastSteps;
    if (n === 0) {
      s.fps = 0; s.frameMsAvg = 0; s.frameMs1pLow = 0; s.simMs = 0; s.renderCpuMs = 0; s.lateFramePct = 0;
      return s;
    }
    let frame = 0;
    let sim = 0;
    let render = 0;
    let late = 0;
    for (let i = 0; i < n; i++) {
      frame += this.frameMs[i] as number;
      sim += this.simMs[i] as number;
      render += this.renderMs[i] as number;
      late += this.late[i] as number;
    }
    s.frameMsAvg = frame / n;
    s.fps = s.frameMsAvg > 0 ? 1000 / s.frameMsAvg : 0;
    s.simMs = sim / n;
    s.renderCpuMs = render / n;
    s.lateFramePct = (100 * late) / n;
    s.frameMs1pLow = sortedWorstPercentMean(this.sortWindow(), n);
    return s;
  }

  /** Percentile (0..100) of the current window's frame times in ms. */
  percentile(p: number): number {
    return sortedPercentile(this.sortWindow(), this.count, p);
  }

  reset(): void {
    this.head = 0;
    this.count = 0;
    this.lastSteps = 0;
    this.refresh();
  }

  private sortWindow(): Float64Array {
    const n = this.count;
    const sorted = this.sorted;
    sorted.set(n === this.frameMs.length ? this.frameMs : this.frameMs.subarray(0, n));
    sorted.subarray(0, n).sort();
    return sorted;
  }
}
