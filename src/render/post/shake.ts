import { SimEventType, type SimEvent } from '../../contracts/sim.ts';
import { Noise } from '../gen/noise.ts';

/** Screen-shake tuning (trauma model: offset ∝ trauma², trauma decays linearly). */
export const SHAKE = Object.freeze({
  /** Max offset in view units at trauma 1. */
  maxOffset: 14,
  /** Trauma lost per second. */
  decayPerSec: 2.5,
  /** Noise frequency (≈ oscillations per second). */
  frequency: 13,
  /** Landings from lower than this fall height (u) don't shake. */
  landMinFall: 240,
  landBase: 0.22,
  landPerUnit: 0.0004,
  landMax: 0.55,
  died: 0.45,
  stomp: 0.25,
});

/** Trauma a sim event adds (0 for events that don't shake). */
export function traumaForEvent(e: SimEvent): number {
  switch (e.type) {
    case SimEventType.Land:
      return e.b < SHAKE.landMinFall ? 0 : Math.min(SHAKE.landMax, SHAKE.landBase + (e.b - SHAKE.landMinFall) * SHAKE.landPerUnit);
    case SimEventType.Died:
      return SHAKE.died;
    case SimEventType.EnemyStomped:
      return SHAKE.stomp;
    default:
      return 0;
  }
}

/** Smooth, deterministic trauma-based shake. Allocation-free after construction. */
export class ScreenShake {
  trauma = 0;
  x = 0;
  y = 0;
  private readonly noise: Noise;

  constructor(seed = 0x5eed) {
    this.noise = new Noise(seed);
  }

  add(amount: number): void {
    if (amount > 0) this.trauma = Math.min(1, this.trauma + amount);
  }

  /** Decay trauma by `dt` and sample the offset at render time `time` (seconds). */
  update(dt: number, time: number): void {
    this.trauma = Math.max(0, this.trauma - SHAKE.decayPerSec * dt);
    const s = this.trauma * this.trauma * SHAKE.maxOffset;
    if (s <= 0) {
      this.x = 0;
      this.y = 0;
      return;
    }
    const t = (time % 3600) * SHAKE.frequency;
    this.x = s * Math.max(-1, Math.min(1, this.noise.noise2(t, 0.37)));
    this.y = s * Math.max(-1, Math.min(1, this.noise.noise2(t, 17.91)));
  }

  reset(): void {
    this.trauma = 0;
    this.x = 0;
    this.y = 0;
  }
}
