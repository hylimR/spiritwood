import { MAX_PROJECTILES, SIM_DT } from '../config.ts';
import type { Bounds } from '../contracts/common.ts';
import { EnemyHitCause, SeedBurstCause, SimEventType, type ProjectileOwner, type ProjectileView } from '../contracts/sim.ts';
import type { SimEventQueue } from '../core/events.ts';
import type { CollisionGrid } from '../level/grid.ts';
import { circleTouchesBox } from './physics.ts';
import type { SimEnemy } from './simEnemy.ts';
import type { WorldTuning } from './tuning.ts';

/** Mutable seed state behind ProjectileView (one fixed pool slot). */
export class ProjectileState implements ProjectileView {
  readonly id: number;
  active = false;
  owner: ProjectileOwner = 'hostile';
  x = 0;
  y = 0;
  prevX = 0;
  prevY = 0;
  vx = 0;
  vy = 0;
  radius: number;
  spawnTick = -1;
  sourceId = -1;
  age = 0;
  lifetime = 0;

  constructor(id: number, radius: number) {
    this.id = id;
    this.radius = radius;
  }
}

/**
 * The Thorn Spitter seeds (§5.3): a fixed pool of MAX_PROJECTILES slots, stepped at world step 4.2
 * (age, trapezoid move in ceil(|d| / radius) equal sub-steps, terrain and enemy checks, expiry) and
 * tested against the player at step 5.3. Allocation-free.
 */
export class SeedPool {
  readonly slots: ProjectileState[] = [];

  private readonly grid: CollisionGrid;
  private readonly tuning: WorldTuning;
  /** Seeds more than seedOutMargin below this y expire. */
  private readonly bottomY: number;
  private readonly box: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };

  constructor(grid: CollisionGrid, tuning: WorldTuning, levelHeight: number) {
    this.grid = grid;
    this.tuning = tuning;
    this.bottomY = levelHeight;
    for (let i = 0; i < MAX_PROJECTILES; i++) this.slots.push(new ProjectileState(i, tuning.seedRadius));
  }

  /** Step 1: prev ← cur for every slot. */
  savePrev(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i] as ProjectileState;
      s.prevX = s.x;
      s.prevY = s.y;
    }
  }

  /** Free every slot silently (respawn, teleport, reset). */
  clear(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i] as ProjectileState;
      s.active = false;
      s.prevX = s.x;
      s.prevY = s.y;
    }
  }

  /**
   * A hostile seed from spitter `sourceId` at (x, y) in the lowest free slot (prev = cur, age 0), with
   * SeedFired. Returns null (and fires nothing) when every slot is in use. It first moves next tick.
   */
  fire(x: number, y: number, vx: number, vy: number, sourceId: number, tick: number, events: SimEventQueue): ProjectileState | null {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i] as ProjectileState;
      if (s.active) continue;
      s.active = true;
      s.owner = 'hostile';
      s.x = s.prevX = x;
      s.y = s.prevY = y;
      s.vx = vx;
      s.vy = vy;
      s.spawnTick = tick;
      s.sourceId = sourceId;
      s.age = 0;
      s.lifetime = this.tuning.seedLifetimeTicks;
      events.push(SimEventType.SeedFired, tick, x, y, vx, vy, s.id);
      return s;
    }
    return null;
  }

  /** Fling a seed off a launch: owner reflected, new velocity, a new flight (spawnTick, age, lifetime). */
  reflect(id: number, vx: number, vy: number, tick: number): void {
    const s = this.slots[id];
    if (!s || !s.active) return;
    s.owner = 'reflected';
    s.vx = vx;
    s.vy = vy;
    s.spawnTick = tick;
    s.age = 0;
    s.lifetime = this.tuning.reflectedLifetimeTicks;
  }

  /** World step 4.2 (unfrozen ticks only). Seeds fired this tick don't move until the next tick. */
  step(tick: number, enemies: readonly SimEnemy[], events: SimEventQueue): void {
    const t = this.tuning;
    const grid = this.grid;
    const ts = grid.tileSize;
    const r = t.seedRadius;
    const maxSpeed = t.seedMaxSpeed;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i] as ProjectileState;
      if (!s.active || (s.owner === 'hostile' && s.spawnTick === tick)) continue;
      // 1. Age.
      s.age++;
      // 2. Move: trapezoid integration, speed capped at seedMaxSpeed.
      const hostile = s.owner === 'hostile';
      let vxEnd = s.vx;
      let vyEnd = hostile ? s.vy + t.seedGravity * SIM_DT : s.vy;
      const speed2 = vxEnd * vxEnd + vyEnd * vyEnd;
      if (speed2 > maxSpeed * maxSpeed) {
        const k = maxSpeed / Math.sqrt(speed2);
        vxEnd *= k;
        vyEnd *= k;
      }
      const dx = (s.vx + vxEnd) * 0.5 * SIM_DT;
      const dy = (s.vy + vyEnd) * 0.5 * SIM_DT;
      s.vx = vxEnd;
      s.vy = vyEnd;
      const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy) / r));
      const x0 = s.x;
      const y0 = s.y;
      // 3. Sub-step checks, in order: terrain (centre in Solid), then a reflected seed against enemies.
      let burst = false;
      for (let k = 1; k <= n && !burst; k++) {
        const f = k / n;
        s.x = x0 + dx * f;
        s.y = y0 + dy * f;
        if (grid.isSolid(Math.floor(s.x / ts), Math.floor(s.y / ts))) {
          this.burst(s, SeedBurstCause.Terrain, tick, events);
          burst = true;
        } else if (!hostile) {
          for (let e = 0; e < enemies.length; e++) {
            const enemy = enemies[e] as SimEnemy;
            if (!circleTouchesBox(s.x, s.y, r, enemy.getBounds(this.box))) continue;
            if (enemy.stunnable) enemy.hit(EnemyHitCause.Seed, tick, events);
            this.burst(s, SeedBurstCause.Enemy, tick, events);
            burst = true;
            break;
          }
        }
      }
      if (burst) continue;
      // 4. Expiry.
      if (s.age >= s.lifetime || s.y > this.bottomY + t.seedOutMargin) this.burst(s, SeedBurstCause.Expired, tick, events);
    }
  }

  /**
   * World step 5.3: the first hostile seed (lowest slot) whose circle touches `box` bursts (Player).
   * Returns true when one did (the player dies). Reflected seeds never hurt the player.
   */
  hitPlayer(box: Bounds, tick: number, events: SimEventQueue): boolean {
    const r = this.tuning.seedRadius;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i] as ProjectileState;
      if (!s.active || s.owner !== 'hostile' || !circleTouchesBox(s.x, s.y, r, box)) continue;
      this.burst(s, SeedBurstCause.Player, tick, events);
      return true;
    }
    return false;
  }

  private burst(s: ProjectileState, cause: SeedBurstCause, tick: number, events: SimEventQueue): void {
    s.active = false;
    events.push(SimEventType.SeedBurst, tick, s.x, s.y, cause, s.owner === 'hostile' ? 0 : 1, s.id);
  }
}
