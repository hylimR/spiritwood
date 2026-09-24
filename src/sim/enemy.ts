import { SIM_DT } from '../config.ts';
import type { Bounds, Facing } from '../contracts/common.ts';
import { TileKind, type CrawlerDef } from '../contracts/level.ts';
import { SimEventType, type EnemyMode } from '../contracts/sim.ts';
import type { SimEventQueue } from '../core/events.ts';
import type { CollisionGrid } from '../level/grid.ts';
import { createSweepResult, sweepX } from './physics.ts';
import type { SimEnemy } from './simEnemy.ts';
import { DEFAULT_WORLD_TUNING, type WorldTuning } from './tuning.ts';

/**
 * Gloomcrawler: patrols [patrolMinX, patrolMaxX] on its floor, turning at range ends, walls and
 * ledges. Stomped → 'stunned' for stunTicks (harmless, emits EnemyStomped), then re-forms at its
 * current spot (EnemyReformed).
 */
export class Gloomcrawler implements SimEnemy {
  readonly id: number;
  readonly kind = 'gloomcrawler' as const;
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
  modeDuration = 0;

  private readonly def: CrawlerDef;
  private readonly grid: CollisionGrid;
  private readonly tuning: WorldTuning;
  private readonly sweep = createSweepResult();
  /** While stunned, re-forming waits as long as this box (the player) overlaps the enemy. */
  private blocker: Bounds | null = null;

  constructor(def: CrawlerDef, grid: CollisionGrid, tuning: WorldTuning = DEFAULT_WORLD_TUNING) {
    this.id = def.id;
    this.def = def;
    this.grid = grid;
    this.tuning = tuning;
    this.width = tuning.enemyWidth;
    this.height = tuning.enemyHeight;
    this.reset();
  }

  get harmful(): boolean {
    return this.mode === 'patrol';
  }

  /** The box that defers re-forming while it overlaps the enemy (GameWorld passes the live player box). */
  setReformBlocker(bounds: Bounds | null): void {
    this.blocker = bounds;
  }

  reset(): void {
    this.x = this.prevX = this.def.x;
    this.y = this.prevY = this.def.y;
    this.facing = 1;
    this.vx = this.walks() ? this.def.speed : 0;
    this.mode = 'patrol';
    this.modeTicks = 0;
    this.modeDuration = 0;
  }

  step(tick: number, events: SimEventQueue): void {
    this.prevX = this.x;
    this.prevY = this.y;
    this.modeTicks++;
    if (this.mode === 'stunned') {
      if (this.modeTicks >= this.modeDuration && !this.blocked()) {
        this.mode = 'patrol';
        this.modeTicks = 0;
        this.modeDuration = 0;
        this.vx = this.walks() ? this.facing * this.def.speed : 0;
        events.push(SimEventType.EnemyReformed, tick, this.x, this.y, 0, 0, this.id);
      }
      return;
    }
    this.patrol();
  }

  stomp(tick: number, events: SimEventQueue): void {
    this.mode = 'stunned';
    this.modeTicks = 0;
    this.modeDuration = this.tuning.stunTicks;
    this.vx = 0;
    events.push(SimEventType.EnemyStomped, tick, this.x, this.y - this.height, 0, 0, this.id);
  }

  getBounds(out: Bounds): Bounds {
    out.minX = this.x - this.width / 2;
    out.maxX = this.x + this.width / 2;
    out.minY = this.y - this.height;
    out.maxY = this.y;
    return out;
  }

  private patrol(): void {
    if (!this.walks()) {
      this.vx = 0;
      return;
    }
    const { patrolMinX, patrolMaxX, speed } = this.def;
    const ts = this.grid.tileSize;
    const half = this.width / 2;
    const x0 = this.x;
    let nx = x0 + this.facing * speed * SIM_DT;
    let turn = false;
    if (this.facing > 0) {
      if (nx >= patrolMaxX) {
        nx = patrolMaxX;
        turn = true;
      }
      const col = Math.ceil((nx + half) / ts) - 1;
      if (!this.floorAt(col)) {
        nx = Math.min(nx, Math.max(x0, col * ts - half));
        turn = true;
      }
    } else {
      if (nx <= patrolMinX) {
        nx = patrolMinX;
        turn = true;
      }
      const col = Math.floor((nx - half) / ts);
      if (!this.floorAt(col)) {
        nx = Math.max(nx, Math.min(x0, (col + 1) * ts + half));
        turn = true;
      }
    }
    sweepX(this.grid, this, nx - x0, this.sweep);
    if (this.sweep.hit) turn = true;
    if (turn) this.facing = this.facing > 0 ? -1 : 1;
    this.vx = this.facing * speed;
  }

  /**
   * False when there is nowhere to walk (an Enemy rect no wider than the crawler, or speed 0): the
   * crawler then stands guard instead of turning around every tick.
   */
  private walks(): boolean {
    return this.def.patrolMaxX > this.def.patrolMinX && this.def.speed > 0;
  }

  /** A Solid or one-way tile in column `tx` directly under the feet. */
  private floorAt(tx: number): boolean {
    const k = this.grid.get(tx, Math.round(this.y / this.grid.tileSize));
    return k === TileKind.Solid || k === TileKind.OneWay;
  }

  private blocked(): boolean {
    const b = this.blocker;
    if (!b) return false;
    const half = this.width / 2;
    return b.minX < this.x + half && b.maxX > this.x - half && b.minY < this.y && b.maxY > this.y - this.height;
  }
}
