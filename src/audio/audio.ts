import type { AudioEngine, AudioFrame, AudioStats, AudioVolumes } from '../contracts/audio.ts';
import type { SimEvent } from '../contracts/sim.ts';

export interface AudioSystemOptions {
  /** Context factory (tests inject a fake); null or a throw → 'unavailable'. Default: a 48 kHz AudioContext. */
  createContext?: () => BaseAudioContext | null;
  /** Where the capture-phase unlock listeners go (default: window; null disables them). */
  gestureTarget?: EventTarget | null;
  /** false constructs a silent engine ('unavailable'), e.g. for ?bench. */
  enabled?: boolean;
  /** Music Rng seed (level.seed). */
  seed?: number;
}

/**
 * Synthesized Web Audio engine (ARCHITECTURE.md §5.9). M2 stub: the orchestrator wiring is final; the
 * AUDIO role implements synthesis, music, ambience and mixing behind this class.
 */
export class AudioSystem implements AudioEngine {
  readonly stats: AudioStats = { state: 'unavailable', voices: 0, latency: -1, updateMs: 0 };

  constructor(options: AudioSystemOptions = {}) {
    void options;
  }

  unlock(): void {}

  onSimEvent(e: SimEvent, frame: AudioFrame): void {
    void e;
    void frame;
  }

  update(frame: AudioFrame): void {
    void frame;
  }

  setVolumes(v: AudioVolumes): void {
    void v;
  }

  setActive(active: boolean): void {
    void active;
  }

  destroy(): void {}
}
