export interface RenderStats {
  drawCalls: number;
  /** Estimated scene fill in full-screen equivalents (sum of on-screen mesh bounds / screen area). */
  fillScreens: number;
  rtWidth: number;
  rtHeight: number;
  renderScale: number;
  canvasWidth: number;
  canvasHeight: number;
  particles: number;
  textureMB: number;
  /** GPU frame time from EXT_disjoint_timer_query_webgl2, or -1 if unavailable. */
  gpuMs: number;
}

export interface FrameStats {
  fps: number;
  frameMsAvg: number;
  /** Average of the worst 1% frame times over the window. */
  frameMs1pLow: number;
  simStepsLastFrame: number;
  simMs: number;
  renderCpuMs: number;
  /**
   * % of rendered frames that were late (missed a render deadline). The acceptance metric: frame-time
   * percentiles include fps-cap cadence jitter on non-60-multiple displays (e.g. 13.9/20.8 ms at 144 Hz).
   */
  lateFramePct: number;
}

export interface BenchResult {
  preset: string;
  seconds: number;
  frames: number;
  fpsAvg: number;
  fps1pLow: number;
  frameMsP50: number;
  frameMsP95: number;
  frameMsP99: number;
  /** % of rendered frames that were late — the pass/fail number (target < 1%). */
  lateFramePct: number;
  renderScaleAvg: number;
  gpuMsAvg: number;
  userAgent: string;
  gpu: string;
}
