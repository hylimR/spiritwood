import type { Bounds, Facing } from '../contracts/common.ts';
import type { SpitterDef } from '../contracts/level.ts';
import type { EnemyMode } from '../contracts/sim.ts';
import type { SimEventQueue } from '../core/events.ts';
import type { SimEnemy } from './simEnemy.ts';
import { DEFAULT_WORLD_TUNING, type WorldTuning } from './tuning.ts';

/**
 * Thorn Spitter (§5.3). M2 stub: stands idle and harmless so the world typechecks; SIM implements the
 * windup/fire/cooldown cycle, seeds, stun and contact rules.
 */
export class ThornSpitter implements SimEnemy {
  readonly id: number;
  readonly kind = 'thornSpitter' as const;
  x = 0;
  y = 0;
  prevX = 0;
  prevY = 0;
  vx = 0;
  facing: Facing = 1;
  readonly width: number;
  readonly height: number;
  mode: EnemyMode = 'idle';
  modeTicks = 0;
  modeDuration = 0;

  private readonly def: SpitterDef;

  constructor(def: SpitterDef, tuning: WorldTuning = DEFAULT_WORLD_TUNING) {
    this.id = def.id;
    this.def = def;
    this.width = tuning.enemyWidth;
    this.height = tuning.enemyHeight;
    this.reset();
  }

  get harmful(): boolean {
    return false;
  }

  setReformBlocker(bounds: Bounds | null): void {
    void bounds;
  }

  reset(): void {
    this.x = this.prevX = this.def.x;
    this.y = this.prevY = this.def.y;
    this.mode = 'idle';
    this.modeTicks = 0;
    this.modeDuration = 0;
  }

  step(tick: number, events: SimEventQueue): void {
    void tick;
    void events;
    this.prevX = this.x;
    this.prevY = this.y;
    this.modeTicks++;
  }

  stomp(tick: number, events: SimEventQueue): void {
    void tick;
    void events;
  }

  getBounds(out: Bounds): Bounds {
    out.minX = this.x - this.width / 2;
    out.maxX = this.x + this.width / 2;
    out.minY = this.y - this.height;
    out.maxY = this.y;
    return out;
  }
}
