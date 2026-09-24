import { SIM_DT } from '../config.ts';
import type { Bounds, Facing } from '../contracts/common.ts';
import type { SpitterDef } from '../contracts/level.ts';
import { SimEventType, type EnemyHitCause, type EnemyMode } from '../contracts/sim.ts';
import type { SimEventQueue } from '../core/events.ts';
import { mod } from '../core/math.ts';
import type { CollisionGrid } from '../level/grid.ts';
import { lineOfSight } from './physics.ts';
import type { SeedPool } from './seeds.ts';
import type { SimEnemy } from './simEnemy.ts';
import { DEFAULT_WORLD_TUNING, type WorldTuning } from './tuning.ts';

/** What a spitter reads from the world: the player, the sim camera's current view and the seed pool. */
export interface SpitterEnv {
  readonly grid: CollisionGrid;
  readonly player: { readonly alive: boolean; readonly x: number; readonly y: number; readonly height: number };
  readonly camera: { readonly x: number; readonly y: number; readonly zoom: number; readonly viewW: number; readonly viewH: number };
  readonly seeds: SeedPool;
}

/**
 * Thorn Spitter (§5.3): a rooted plant with a spitterWidth × spitterHeight contact box on its feet and
 * its muzzle spitterMuzzleHeight above them. Harmful from every side except while stunned; never
 * stomped. Active while the player is alive with its centre within `range` of the muzzle; a player-aimed
 * spitter also needs line of sight and its muzzle inside the camera view inset by spitterViewInset.
 * Cycle: idle → (cooldown for phase mod period) → windup (W ticks, SpitterWindup) → fire (SeedFired) +
 * cooldown (max(1, period − W)) → windup …, so shots are exactly `period` ticks apart. Player-aimed
 * spitters are stunned by EnemyHit (spitterStunTicks), then re-form into cooldown for a full period (or
 * idle when inactive), deferred while the player overlaps them. Fixed-aim spitters are never stunned and
 * are not launch targets (their seeds are).
 */
export class ThornSpitter implements SimEnemy {
  readonly id: number;
  readonly kind = 'thornSpitter' as const;
  readonly stompable = false;
  readonly stunnable: boolean;
  readonly launchTarget: boolean;
  x = 0;
  y = 0;
  prevX = 0;
  prevY = 0;
  readonly vx = 0;
  facing: Facing = 1;
  readonly width: number;
  readonly height: number;
  mode: EnemyMode = 'idle';
  modeTicks = 0;
  modeDuration = 0;

  private readonly def: SpitterDef;
  private readonly tuning: WorldTuning;
  private readonly env: SpitterEnv;
  private blocker: Bounds | null = null;
  /** Tick a stun began from a hit; a launch hit at world step 2 precedes this tick's step, which skips counting it. */
  private stunTick = -1;

  constructor(def: SpitterDef, env: SpitterEnv, tuning: WorldTuning = DEFAULT_WORLD_TUNING) {
    this.id = def.id;
    this.def = def;
    this.env = env;
    this.tuning = tuning;
    this.width = tuning.spitterWidth;
    this.height = tuning.spitterHeight;
    this.stunnable = def.aim === 'player';
    this.launchTarget = def.aim === 'player';
    this.reset();
  }

  get harmful(): boolean {
    return this.mode !== 'stunned';
  }

  get muzzleX(): number {
    return this.x;
  }

  get muzzleY(): number {
    return this.y - this.tuning.spitterMuzzleHeight;
  }

  setReformBlocker(bounds: Bounds | null): void {
    this.blocker = bounds;
  }

  reset(): void {
    this.x = this.prevX = this.def.x;
    this.y = this.prevY = this.def.y;
    this.facing = this.def.aim === 'fixed' && this.def.fixedVx < 0 ? -1 : 1;
    this.stunTick = -1;
    this.enter('idle', 0);
  }

  savePrev(): void {
    this.prevX = this.x;
    this.prevY = this.y;
  }

  step(tick: number, events: SimEventQueue): void {
    if (tick !== this.stunTick) this.modeTicks++;
    const active = this.isActive();
    if (this.mode === 'stunned') {
      if (this.modeTicks >= this.modeDuration && !this.blocked()) {
        events.push(SimEventType.EnemyReformed, tick, this.x, this.y, 0, 0, this.id);
        if (active) this.enter('cooldown', this.def.period);
        else this.enter('idle', 0);
      }
      return;
    }
    if (!active) {
      if (this.mode !== 'idle') this.enter('idle', 0);
      return;
    }
    if (this.mode === 'idle') {
      const wait = mod(this.def.phase, this.def.period);
      if (wait > 0) this.enter('cooldown', wait);
      else this.enterWindup(tick, events);
    } else if (this.mode === 'windup') {
      if (this.modeTicks >= this.modeDuration) {
        this.fire(tick, events);
        this.enter('cooldown', Math.max(1, this.def.period - this.tuning.spitterWindupTicks));
      }
    } else if (this.modeTicks >= this.modeDuration) {
      this.enterWindup(tick, events);
    }
  }

  stomp(tick: number, events: SimEventQueue): void {
    void tick;
    void events;
  }

  hit(cause: EnemyHitCause, tick: number, events: SimEventQueue): void {
    events.push(SimEventType.EnemyHit, tick, this.x, this.y - this.height / 2, cause, 0, this.id);
    if (!this.stunnable) return;
    this.stunTick = tick;
    this.enter('stunned', this.tuning.spitterStunTicks);
  }

  getBounds(out: Bounds): Bounds {
    out.minX = this.x - this.width / 2;
    out.maxX = this.x + this.width / 2;
    out.minY = this.y - this.height;
    out.maxY = this.y;
    return out;
  }

  private enter(mode: EnemyMode, duration: number): void {
    this.mode = mode;
    this.modeTicks = 0;
    this.modeDuration = duration;
  }

  private enterWindup(tick: number, events: SimEventQueue): void {
    const w = this.tuning.spitterWindupTicks;
    this.enter('windup', w);
    if (this.def.aim === 'fixed') {
      if (this.def.fixedVx !== 0) this.facing = this.def.fixedVx > 0 ? 1 : -1;
    } else {
      const dx = this.env.player.x - this.x;
      if (dx !== 0) this.facing = dx > 0 ? 1 : -1;
    }
    events.push(SimEventType.SpitterWindup, tick, this.muzzleX, this.muzzleY, w, 0, this.id);
  }

  /** A seed from the muzzle: the fixed velocity, or the ballistic shot onto the player centre. */
  private fire(tick: number, events: SimEventQueue): void {
    const mx = this.muzzleX;
    const my = this.muzzleY;
    let vx = this.def.fixedVx;
    let vy = this.def.fixedVy;
    if (this.def.aim === 'player') {
      const p = this.env.player;
      const T = this.def.flightTicks * SIM_DT;
      vx = (p.x - mx) / T;
      vy = (p.y - p.height / 2 - my) / T - 0.5 * this.tuning.seedGravity * T;
      const max = this.tuning.seedMaxSpeed;
      const speed2 = vx * vx + vy * vy;
      if (speed2 > max * max) {
        const k = max / Math.sqrt(speed2);
        vx *= k;
        vy *= k;
      }
    }
    this.env.seeds.fire(mx, my, vx, vy, this.id, tick, events);
  }

  private isActive(): boolean {
    const p = this.env.player;
    if (!p.alive) return false;
    const mx = this.muzzleX;
    const my = this.muzzleY;
    const cx = p.x;
    const cy = p.y - p.height / 2;
    const dx = cx - mx;
    const dy = cy - my;
    const range = this.def.range;
    if (dx * dx + dy * dy > range * range) return false;
    if (this.def.aim === 'fixed') return true;
    const cam = this.env.camera;
    const inset = this.tuning.spitterViewInset;
    if (Math.abs(mx - cam.x) > cam.viewW / (2 * cam.zoom) - inset) return false;
    if (Math.abs(my - cam.y) > cam.viewH / (2 * cam.zoom) - inset) return false;
    return lineOfSight(this.env.grid, mx, my, cx, cy);
  }

  private blocked(): boolean {
    const b = this.blocker;
    if (!b) return false;
    const half = this.width / 2;
    return b.minX < this.x + half && b.maxX > this.x - half && b.minY < this.y && b.maxY > this.y - this.height;
  }
}
