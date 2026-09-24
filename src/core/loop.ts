import { MAX_STEPS_PER_FRAME, SIM_HZ, VSYNC_SNAP_EPSILON } from '../config.ts';
import { todo } from './todo.ts';

export interface LoopHooks {
  /** Once per processed animation frame, before any sim steps (sample input here). */
  beginFrame(nowSec: number): void;
  /** One fixed simulation step of `dt` seconds. */
  step(dt: number): void;
  /**
   * Render with interpolation factor `alpha` (0..1). `frameDt` is the wall time since the previous
   * rendered frame in seconds (unclamped).
   */
  render(alpha: number, frameDt: number, nowSec: number): void;
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
}

/**
 * Fixed-timestep loop with accumulator, vsync snapping, max-step clamp and an fps cap.
 * `frame(nowMs)` is the whole algorithm and is deterministic given the timestamps (tests drive it
 * directly); `start()` just feeds it from requestAnimationFrame.
 */
export class FixedStepLoop {
  readonly stats: LoopStats = { stepsLastFrame: 0, framesRendered: 0, framesSkipped: 0, droppedSeconds: 0, lastFrameDt: 0 };

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

  /** Forget accumulated time (after pause, tab switch or a long hitch). */
  resetClock(nowMs: number): void {
    void nowMs;
    todo('SIM', 'FixedStepLoop.resetClock');
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
