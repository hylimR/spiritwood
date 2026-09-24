import type { SimEvent, SimView } from './sim.ts';

/** Linear gains 0..1 (UserSettings master/music/sfx). */
export interface AudioVolumes {
  master: number;
  music: number;
  sfx: number;
}

/** Per-render-frame input to the audio engine (ARCHITECTURE.md §5.9). */
export interface AudioFrame {
  /** Render dt in seconds, clamped to MAX_RENDER_DT. */
  dt: number;
  /** Interpolated camera centre and view size, world units (stereo panning, area weights). */
  camX: number;
  camY: number;
  viewW: number;
  viewH: number;
  sim: SimView;
  /** A menu has the game paused (music ducks, the world ambience holds, no new SFX). */
  paused: boolean;
}

export interface AudioStats {
  state: 'unavailable' | 'locked' | 'running' | 'suspended' | 'closed';
  /** Sounding voices (SFX + music notes) right now. */
  voices: number;
  /** AudioContext.baseLatency + outputLatency when known, else −1 (seconds). */
  latency: number;
}

/**
 * Synthesized Web Audio engine. The orchestrator calls `unlock` from the first user gesture, forwards
 * every drained SimEvent to `onSimEvent`, and calls `update` once per render frame. None of these may
 * throw: without Web Audio (or before unlock) they are no-ops and `stats.state` says why.
 */
export interface AudioEngine {
  readonly stats: AudioStats;
  unlock(): void;
  onSimEvent(e: SimEvent): void;
  update(frame: AudioFrame): void;
  setVolumes(v: AudioVolumes): void;
  destroy(): void;
}
