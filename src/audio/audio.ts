import type { AudioEngine, AudioFrame, AudioStats, AudioVolumes } from '../contracts/audio.ts';
import type { SimEvent } from '../contracts/sim.ts';

/**
 * Synthesized Web Audio engine (ARCHITECTURE.md §5.9). M2 stub: the orchestrator wiring is final; the
 * AUDIO role implements synthesis, music, ambience and mixing behind this class.
 */
export class AudioSystem implements AudioEngine {
  readonly stats: AudioStats = { state: 'unavailable', voices: 0, latency: -1 };

  unlock(): void {}

  onSimEvent(e: SimEvent): void {
    void e;
  }

  update(frame: AudioFrame): void {
    void frame;
  }

  setVolumes(v: AudioVolumes): void {
    void v;
  }

  destroy(): void {}
}
