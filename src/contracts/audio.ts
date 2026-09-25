import type { SimEvent, SimView } from './sim.ts';

/** Slider values 0..1 (UserSettings master/music/sfx); the engine maps v → gain v². */
export interface AudioVolumes {
  master: number;
  music: number;
  sfx: number;
}

/** Per-render-frame input to the audio engine (ARCHITECTURE.md §5.9). */
export interface AudioFrame {
  /** Render dt in seconds, clamped to MAX_RENDER_DT. Smoothing only; timing uses the context clock. */
  dt: number;
  /** Interpolated camera centre and zoom-1 view size, world units (divide by sim.camera.zoom). */
  camX: number;
  camY: number;
  viewW: number;
  viewH: number;
  sim: SimView;
  /** A menu has the game paused (music ducks, sustained SFX release, no new SFX). */
  paused: boolean;
}

export interface AudioStats {
  /** §5.9 state table. 'unavailable' and 'closed' are final. */
  state: 'unavailable' | 'locked' | 'running' | 'suspended' | 'closed';
  /** Sounding voices: SFX + music + ambience budgets. */
  voices: number;
  /** AudioContext.baseLatency + outputLatency when known, else −1 (seconds). */
  latency: number;
  /** CPU time of the last update() in ms. */
  updateMs: number;
}

/**
 * Synthesized Web Audio engine. It arms its own gesture listeners to unlock; the orchestrator also
 * calls `unlock` after polling the gamepad, forwards every drained SimEvent to `onSimEvent` with the
 * frame already filled for this render, and calls `update` once per render frame. No method throws:
 * without Web Audio, before unlock or after a failure they are no-ops and `stats.state` says why.
 */
export interface AudioEngine {
  readonly stats: AudioStats;
  /** Idempotent; safe from any context. */
  unlock(): void;
  onSimEvent(e: SimEvent, frame: AudioFrame): void;
  update(frame: AudioFrame): void;
  setVolumes(v: AudioVolumes): void;
  /** false: the page is hidden (suspend); true: visible again (resume). */
  setActive(active: boolean): void;
  destroy(): void;
}
