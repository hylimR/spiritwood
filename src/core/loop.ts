import { MAX_STEPS_PER_FRAME, SIM_HZ, VSYNC_SNAP_EPSILON } from '../config.ts';
import { clamp, clamp01 } from './math.ts';

export interface LoopHooks {
  /** Once per processed animation frame, before any sim steps (sample input here). */
  beginFrame(nowSec: number): void;
  /** One fixed simulation step of `dt` seconds. */
  step(dt: number): void;
  /**
   * Render with interpolation factor `alpha` (0..1). `frameDt` is the wall time since the previous
   * rendered frame in seconds (unclamped). `lateFrames` = render deadlines missed before this frame
   * (see LoopStats.lateFrames) — the only honest "dropped frame" signal under an fps cap.
   */
  render(alpha: number, frameDt: number, nowSec: number, lateFrames: number): void;
}

export interface LoopOptions {
  hz: number;
  maxStepsPerFrame: number;
  /** 0 = render every rAF; otherwise cap to this many fps (ARCHITECTURE.md §2.2). */
  fpsCap: number;
  vsyncSnapEpsilon: number;
}

export const DEFAULT_LOOP_OPTIONS: LoopOptions = {
  hz: SIM_HZ,
  maxStepsPerFrame: MAX_STEPS_PER_FRAME,
  fpsCap: 60,
  vsyncSnapEpsilon: VSYNC_SNAP_EPSILON,
};

export interface LoopStats {
  /** Sim steps run by the last rendered frame. */
  stepsLastFrame: number;
  framesRendered: number;
  /** rAF callbacks skipped by the fps cap. */
  framesSkipped: number;
  /** Seconds of sim time discarded because of the max-steps clamp. */
  droppedSeconds: number;
  /** Seconds between the last two rendered frames. */
  lastFrameDt: number;
  /**
   * Render deadlines missed before the last rendered frame. Capped: the number of 1/cap-s deadlines
   * that passed without a render (0 for the steady 13.9/20.8 ms cadence of a 60 cap on 144 Hz).
   * Uncapped: 1 when frameDt > 1.5 × EMA(rAF interval), else 0.
   */
  lateFrames: number;
  /** Total late frames since start. */
  lateFramesTotal: number;
}

/** Initial rAF interval estimate and the clamp for its samples (ms). */
const RAF_EST_INITIAL_MS = 1000 / 60;
const RAF_SAMPLE_MIN_MS = 4;
const RAF_SAMPLE_MAX_MS = 50;
/** EMA weight of each new rAF interval sample. */
const RAF_EMA_WEIGHT = 0.1;
/** Uncapped: a frame is late when its interval exceeds this multiple of the rAF estimate. */
const UNCAPPED_LATE_FACTOR = 1.5;
/** Accumulator tolerance so float round-off never costs a whole tick. */
const TICK_EPSILON = 1e-6;

/**
 * Fixed-timestep loop with accumulator, vsync snapping, max-step clamp and an fps cap.
 * `frame(nowMs)` is the whole algorithm and is deterministic given the timestamps (tests drive it
 * directly); `start()` just feeds it from requestAnimationFrame.
 */
export class FixedStepLoop {
  readonly stats: LoopStats = {
    stepsLastFrame: 0, framesRendered: 0, framesSkipped: 0, droppedSeconds: 0, lastFrameDt: 0, lateFrames: 0, lateFramesTotal: 0,
  };

  private readonly hooks: LoopHooks;
  private readonly hz: number;
  private readonly dt: number;
  private readonly maxSteps: number;
  private readonly snapEpsilon: number;
  private capIntervalMs = 0;

  private needsInit = true;
  private clockReset = false;
  private paused = false;
  private accTicks = 0;
  private lastRafMs = 0;
  private lastRenderMs = 0;
  private deadlineMs = 0;
  private rafEstMs = RAF_EST_INITIAL_MS;

  private isRunning = false;
  private rafId = 0;
  private raf: ((cb: FrameRequestCallback) => number) | null = null;
  private caf: ((id: number) => void) | null = null;
  private readonly onRaf: FrameRequestCallback;

  constructor(hooks: LoopHooks, options: Partial<LoopOptions> = {}) {
    const o = { ...DEFAULT_LOOP_OPTIONS, ...options };
    this.hooks = hooks;
    this.hz = o.hz;
    this.dt = 1 / o.hz;
    this.maxSteps = Math.max(1, Math.floor(o.maxStepsPerFrame));
    this.snapEpsilon = o.vsyncSnapEpsilon;
    this.capIntervalMs = o.fpsCap > 0 ? 1000 / o.fpsCap : 0;
    this.onRaf = (now: number): void => {
      if (!this.isRunning || !this.raf) return;
      this.rafId = this.raf(this.onRaf);
      this.frame(now);
    };
  }

  get running(): boolean {
    return this.isRunning;
  }

  setFpsCap(cap: number): void {
    const interval = cap > 0 ? 1000 / cap : 0;
    if (interval === this.capIntervalMs) return;
    this.capIntervalMs = interval;
    this.deadlineMs = this.lastRenderMs + interval;
  }

  /**
   * Process one animation-frame callback at `nowMs`. The first call only initialises the clock.
   * Returns true if the frame was rendered (false if skipped by the fps cap or first call).
   */
  frame(nowMs: number): boolean {
    if (this.needsInit) {
      this.needsInit = false;
      this.clockReset = false;
      this.accTicks = 0;
      this.lastRafMs = nowMs;
      this.lastRenderMs = nowMs;
      this.deadlineMs = nowMs + this.capIntervalMs;
      return false;
    }

    // A reset requested between frames: render now, owe no deadlines, learn nothing from the gap.
    const resync = this.clockReset;
    const rafDt = nowMs - this.lastRafMs;
    this.lastRafMs = nowMs;
    const rafEstBefore = this.rafEstMs;
    if (!resync) this.rafEstMs += (clamp(rafDt, RAF_SAMPLE_MIN_MS, RAF_SAMPLE_MAX_MS) - this.rafEstMs) * RAF_EMA_WEIGHT;

    // After a reset the gap since the last render is forgotten time: report one nominal rAF interval.
    const frameMs = resync ? this.rafEstMs : Math.max(0, nowMs - this.lastRenderMs);
    let late = 0;
    const interval = this.capIntervalMs;
    if (interval > 0) {
      const opensAt = this.deadlineMs - this.rafEstMs / 2;
      if (!resync && nowMs < opensAt) {
        this.stats.framesSkipped++;
        return false;
      }
      if (!resync) late = Math.floor((nowMs - opensAt) / interval);
      // A late frame resyncs like a hitch. Keeping the backlog (deadline += interval) would count the
      // same missed deadline again on every following frame of a display slightly slower than the cap
      // (59.94 Hz under a 60 cap reported ~45% late frames).
      this.deadlineMs = resync || late > 0 ? nowMs + interval : this.deadlineMs + interval;
      if (this.deadlineMs <= nowMs) this.deadlineMs = nowMs + interval;
    } else if (!resync && frameMs > UNCAPPED_LATE_FACTOR * rafEstBefore) {
      late = 1;
    }
    this.lastRenderMs = nowMs;

    const nowSec = nowMs / 1000;
    const frameDt = frameMs / 1000;
    this.hooks.beginFrame(nowSec);

    let steps = 0;
    let alpha = 1;
    if (!this.paused && !this.clockReset) {
      this.accTicks += this.ticksFor(frameDt);
      while (this.accTicks >= 1 - TICK_EPSILON && steps < this.maxSteps && !this.clockReset) {
        this.hooks.step(this.dt);
        this.accTicks -= 1;
        steps++;
      }
      if (this.accTicks >= 1 - TICK_EPSILON && !this.clockReset) {
        const dropped = Math.floor(this.accTicks + TICK_EPSILON);
        this.accTicks -= dropped;
        this.stats.droppedSeconds += dropped * this.dt;
      }
      alpha = clamp01(this.accTicks);
    }
    if (this.paused || this.clockReset) {
      this.accTicks = 0;
      this.clockReset = false;
      alpha = 1;
    }

    const s = this.stats;
    s.stepsLastFrame = steps;
    s.framesRendered++;
    s.lastFrameDt = frameDt;
    s.lateFrames = late;
    s.lateFramesTotal += late;
    this.hooks.render(alpha, frameDt, nowSec, late);
    return true;
  }

  /**
   * Forget accumulated time (after pause, tab switch or a long hitch): the next frame() re-initialises
   * the clock and runs no steps. Safe to call from inside hooks: from beginFrame or step it applies to
   * the current frame (no further steps), from render or between frames to the next one. The reset
   * frame still renders (alpha 1), so resuming never drops a frame; a reset requested between frames
   * reports one nominal rAF interval as its frameDt instead of the forgotten gap, and no late frames.
   */
  resetClock(): void {
    this.clockReset = true;
  }

  /** Paused: no steps, accumulator 0, alpha 1 (no interpolation wobble); beginFrame/render still run. */
  setPaused(paused: boolean): void {
    this.paused = paused;
    if (paused) this.accTicks = 0;
  }

  start(
    raf: (cb: FrameRequestCallback) => number = requestAnimationFrame,
    caf: (id: number) => void = cancelAnimationFrame,
  ): void {
    if (this.isRunning) return;
    this.raf = raf;
    this.caf = caf;
    this.isRunning = true;
    this.needsInit = true;
    this.rafId = raf(this.onRaf);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    this.caf?.(this.rafId);
    this.rafId = 0;
  }

  /** Sim ticks for a frame delta: snapped to a whole k ≥ 1 ticks when within the vsync epsilon. */
  private ticksFor(frameDt: number): number {
    const ticks = frameDt * this.hz;
    const k = Math.round(ticks);
    if (k >= 1 && Math.abs(frameDt - k * this.dt) <= this.snapEpsilon) return k;
    return ticks;
  }
}
