import type { Bounds } from '../contracts/common.ts';
import type { EnemyHitCause, EnemyView } from '../contracts/sim.ts';
import type { SimEventQueue } from '../core/events.ts';

/** What GameWorld needs from every enemy kind (§5.3). */
export interface SimEnemy extends EnemyView {
  /** Touching it kills the player (DeathCause.Enemy) unless stomped (crawlers only). */
  readonly harmful: boolean;
  /** Crawlers can be stomped; spitters can't. */
  readonly stompable: boolean;
  /** EnemyHit stuns it. Fixed-aim spitters are anchors and never stunned. */
  readonly stunnable: boolean;
  /**
   * A Spirit Launch target (§5.1.1): crawlers and player-aimed spitters, in every mode. Fixed-aim spitters
   * are emitters, not targets: their seeds are the anchors.
   */
  readonly launchTarget: boolean;
  /** Step 1 of every tick (frozen or not): prev ← cur. */
  savePrev(): void;
  /** Step 4.1, only on unfrozen ticks. */
  step(tick: number, events: SimEventQueue): void;
  stomp(tick: number, events: SimEventQueue): void;
  /**
   * A reflected seed or a launch off it: EnemyHit (cause) at the box centre, then a stun (restarting a
   * running stun). Callers hit only stunnable enemies (a reflected seed bursts on a fixed-aim spitter
   * without a hit, and those are never launch targets). Enemies are never displaced.
   */
  hit(cause: EnemyHitCause, tick: number, events: SimEventQueue): void;
  /** Back to the spawn state (respawn and reset). */
  reset(): void;
  getBounds(out: Bounds): Bounds;
  /** The box that defers re-forming while it overlaps the enemy (the live player box). */
  setReformBlocker(bounds: Bounds | null): void;
}
