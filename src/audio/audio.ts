import type { SimEvent } from '../contracts/sim.ts';

/** Milestone 2: Web Audio music + SFX. M1 keeps the hook so the orchestrator wiring is final. */
export class AudioSystem {
  onSimEvent(e: SimEvent): void {
    void e;
  }

  /** Browsers require a user gesture before audio can start. */
  unlock(): void {}

  destroy(): void {}
}
