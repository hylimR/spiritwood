import type { Bounds } from '../contracts/common.ts';
import type { EnemyView } from '../contracts/sim.ts';
import type { SimEventQueue } from '../core/events.ts';

/** What GameWorld needs from every enemy kind (§5.3). */
export interface SimEnemy extends EnemyView {
  /** Touching it kills the player (DeathCause.Enemy) unless stomped (crawlers only). */
  readonly harmful: boolean;
  step(tick: number, events: SimEventQueue): void;
  stomp(tick: number, events: SimEventQueue): void;
  reset(): void;
  getBounds(out: Bounds): Bounds;
  /** The box that defers re-forming while it overlaps the enemy (the live player box). */
  setReformBlocker(bounds: Bounds | null): void;
}
