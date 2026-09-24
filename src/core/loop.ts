import { MAX_STEPS_PER_FRAME, SIM_HZ, VSYNC_SNAP_EPSILON } from '../config.ts';
import { todo } from './todo.ts';

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

/**
 * Fixed-timestep loop with accumulator, vsync snapping, max-step clamp and an fps cap.
 * `frame(nowMs)` is the whole algorithm and is deterministic given the timestamps (tests drive it
 * directly); `start()` just feeds it from requestAnimationFrame.
 */
export class FixedStepLoop {
  readonly stats: LoopStats = {
    stepsLastFrame: 0, framesRendered: 0, framesSkipped: 0, droppedSeconds: 0, lastFrameDt: 0, lateFrames: 0, lateFramesTotal: 0,
  };

  constructor(hooks: LoopHooks, options: Partial<LoopOptions> = {}) {
    void hooks;
    void options;
    todo('SIM', 'FixedStepLoop');
  }

  get running(): boolean {
    return todo('SIM', 'FixedStepLoop.running');
  }

  setFpsCap(cap: number): void {
    void cap;
    todo('SIM', 'FixedStepLoop.setFpsCap');
  }

  /**
   * Process one animation-frame callback at `nowMs`. The first call only initialises the clock.
   * Returns true if the frame was rendered (false if skipped by the fps cap or first call).
   */
  frame(nowMs: number): boolean {
    void nowMs;
    return todo('SIM', 'FixedStepLoop.frame');
  }

  /**
   * Forget accumulated time (after pause, tab switch or a long hitch): the next frame() re-initialises
   * the clock and runs no steps. Safe to call from inside hooks.
   */
  resetClock(): void {
    todo('SIM', 'FixedStepLoop.resetClock');
  }

  /** Paused: no steps, accumulator 0, alpha 1 (no interpolation wobble); beginFrame/render still run. */
  setPaused(paused: boolean): void {
    void paused;
    todo('SIM', 'FixedStepLoop.setPaused');
  }

  start(
    raf: (cb: FrameRequestCallback) => number = requestAnimationFrame,
    caf: (id: number) => void = cancelAnimationFrame,
  ): void {
    void raf;
    void caf;
    todo('SIM', 'FixedStepLoop.start');
  }

  stop(): void {
    todo('SIM', 'FixedStepLoop.stop');
  }
}
