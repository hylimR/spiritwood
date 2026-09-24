import type { Bounds, Facing } from '../contracts/common.ts';
import type { EnemyDef } from '../contracts/level.ts';
import type { EnemyMode, EnemyView } from '../contracts/sim.ts';
import type { SimEventQueue } from '../core/events.ts';
import { todo } from '../core/todo.ts';
import type { CollisionGrid } from '../level/grid.ts';
import { DEFAULT_WORLD_TUNING, type WorldTuning } from './tuning.ts';

/**
 * Gloomcrawler: patrols [patrolMinX, patrolMaxX] on its floor, turning at range ends, walls and
 * ledges. Stomped → 'stunned' for stunTicks (harmless, emits EnemyStomped), then re-forms at its
 * current spot (EnemyReformed).
 */
export class Gloomcrawler implements EnemyView {
  readonly id: number;
  x = 0;
  y = 0;
  prevX = 0;
  prevY = 0;
  vx = 0;
  facing: Facing = 1;
  readonly width: number;
  readonly height: number;
  mode: EnemyMode = 'patrol';
  modeTicks = 0;

  constructor(def: EnemyDef, grid: CollisionGrid, tuning: WorldTuning = DEFAULT_WORLD_TUNING) {
    void grid;
    this.id = def.id;
    this.width = tuning.enemyWidth;
    this.height = tuning.enemyHeight;
  }

  get harmful(): boolean {
    return this.mode === 'patrol';
  }

  reset(): void {
    todo('SIM', 'Gloomcrawler.reset');
  }

  step(tick: number, events: SimEventQueue): void {
    void tick; void events;
    todo('SIM', 'Gloomcrawler.step');
  }

  stomp(tick: number, events: SimEventQueue): void {
    void tick; void events;
    todo('SIM', 'Gloomcrawler.stomp');
  }

  getBounds(out: Bounds): Bounds {
    out.minX = this.x - this.width / 2;
    out.maxX = this.x + this.width / 2;
    out.minY = this.y - this.height;
    out.maxY = this.y;
    return out;
  }
}
