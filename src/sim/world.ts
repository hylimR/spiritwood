import { KILL_MARGIN, HAZARD_INSET, MAX_PROJECTILES, SIM_DT, VIEW_H } from '../config.ts';
import type { Bounds } from '../contracts/common.ts';
import type { InputFrame } from '../contracts/input.ts';
import type { CheckpointDef, GoalDef, LevelData, OrbDef } from '../contracts/level.ts';
import {
  DeathCause, SimEventType, type CheckpointView, type GoalView, type LaunchTargetKind, type LaunchView, type OrbView,
  type ProjectileOwner, type ProjectileView, type SimView,
} from '../contracts/sim.ts';
import { SimEventQueue } from '../core/events.ts';
import { clamp01 } from '../core/math.ts';
import { CollisionGrid } from '../level/grid.ts';
import { CameraController } from './camera.ts';
import { Gloomcrawler } from './enemy.ts';
import { overlapsThorns } from './physics.ts';
import { PlayerController } from './player.ts';
import type { SimEnemy } from './simEnemy.ts';
import { ThornSpitter } from './spitter.ts';
import {
  DEFAULT_CAMERA_TUNING, DEFAULT_TUNING, DEFAULT_WORLD_TUNING, type CameraTuning, type PlayerTuning, type WorldTuning,
} from './tuning.ts';

export interface WorldOptions {
  tuning?: Partial<PlayerTuning>;
  camera?: Partial<CameraTuning>;
  world?: Partial<WorldTuning>;
  viewW?: number;
  viewH?: number;
  eventCapacity?: number;
}

/** Mutable orb state behind OrbView. */
export class OrbState implements OrbView {
  readonly id: number;
  x: number;
  y: number;
  prevX: number;
  prevY: number;
  vx = 0;
  vy = 0;
  readonly value: number;
  readonly radius: number;
  collected = false;
  collectedTick = -1;
  magnetised = false;
  readonly def: OrbDef;

  constructor(def: OrbDef, radius: number) {
    this.def = def;
    this.id = def.id;
    this.x = this.prevX = def.x;
    this.y = this.prevY = def.y;
    this.value = def.value;
    this.radius = radius;
  }

  /** Back to the spawn point, un-magnetised (keeps `collected`). */
  respawn(): void {
    this.x = this.prevX = this.def.x;
    this.y = this.prevY = this.def.y;
    this.vx = 0;
    this.vy = 0;
    this.magnetised = false;
  }
}

/** Mutable checkpoint state behind CheckpointView. */
export class CheckpointState implements CheckpointView {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  active = false;
  activatedTick = -1;

  constructor(def: CheckpointDef) {
    this.id = def.id;
    this.x = def.x;
    this.y = def.y;
    this.w = def.w;
    this.h = def.h;
  }
}

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
  radius = 12;
  spawnTick = -1;
  sourceId = -1;
  age = 0;
  lifetime = 0;

  constructor(id: number) {
    this.id = id;
  }
}

/** Mutable Spirit Launch state behind LaunchView (M2 stub: SIM implements §5.1.1). */
export class LaunchState implements LaunchView {
  unlocked = false;
  candidateKind: LaunchTargetKind = 'none';
  candidateId = -1;
  candidateX = 0;
  candidateY = 0;
  targetKind: LaunchTargetKind = 'none';
  targetId = -1;
  targetX = 0;
  targetY = 0;
  aimX = 0;
  aimY = -1;
  aimTicks = 0;
  aimMaxTicks = 0;
  range = 0;
}

/** Mutable goal state behind GoalView. */
export class GoalState implements GoalView {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  reached = false;

  constructor(def: GoalDef) {
    this.x = def.x;
    this.y = def.y;
    this.w = def.w;
    this.h = def.h;
  }
}

function overlapsRect(b: Bounds, x: number, y: number, w: number, h: number): boolean {
  return b.minX < x + w && b.maxX > x && b.minY < y + h && b.maxY > y;
}

function overlapsBounds(a: Bounds, b: Bounds): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}

function isNeutral(input: InputFrame): boolean {
  return input.moveX === 0 && input.moveY === 0 && !input.jumpHeld && !input.jumpPressed
    && !input.dashHeld && !input.dashPressed && !input.launchHeld && !input.launchPressed;
}

/**
 * The whole deterministic simulation (ARCHITECTURE.md §5.3). `step` = one 60 Hz tick.
 * The constructor places the player at playerStart and snaps the camera (the title screen shows an
 * unstepped world). Events accumulate in `events` until the orchestrator clears them after rendering.
 * `orbs` / `checkpoints` may be typed with SIM's own mutable classes (e.g. `OrbState implements
 * OrbView`); identity/order guarantees per the SimView doc.
 */
export class GameWorld implements SimView {
  readonly level: LevelData;
  readonly grid: CollisionGrid;
  readonly player: PlayerController;
  readonly camera: CameraController;
  readonly events: SimEventQueue;
  readonly enemies: SimEnemy[] = [];
  readonly projectiles: ProjectileState[] = [];
  readonly launch = new LaunchState();
  frozen = false;
  readonly orbs: OrbState[] = [];
  readonly checkpoints: CheckpointState[] = [];
  goal: GoalState | null = null;
  tick = 0;
  orbsCollected = 0;
  orbsTotal = 0;
  fade = 0;
  prevFade = 0;
  elapsed = 0;
  completed = false;

  readonly playerTuning: PlayerTuning;
  readonly cameraTuning: CameraTuning;
  readonly worldTuning: WorldTuning;

  /** Index of the current respawn checkpoint, −1 = playerStart. */
  private activeCheckpoint = -1;
  private debugDeathQueued = false;
  /** Tick the run timer started (−1 = not yet). */
  private timerStartTick = -1;
  /** Tick of the last respawn while fading in (−1 = none). */
  private respawnTick = -1;
  /** Fade at the moment of death (non-zero only when dying during a fade-in), so the fade never jumps back. */
  private fadeAtDeath = 0;
  private readonly playerBox: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  /** The player's box for enemy re-form deferral; empty while the player is dead. */
  private readonly blockerBox: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly enemyBox: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  private readonly spawn = { x: 0, y: 0 };

  constructor(level: LevelData, options: WorldOptions = {}) {
    this.level = level;
    this.playerTuning = { ...DEFAULT_TUNING, ...options.tuning };
    this.cameraTuning = { ...DEFAULT_CAMERA_TUNING, ...options.camera };
    this.worldTuning = { ...DEFAULT_WORLD_TUNING, ...options.world };
    this.grid = CollisionGrid.fromLevel(level);
    this.player = new PlayerController(this.grid, this.playerTuning);
    this.camera = new CameraController(this.cameraTuning);
    this.camera.setBounds(0, 0, level.pxWidth, level.pxHeight);
    this.camera.setViewSize(options.viewW ?? VIEW_H * (16 / 9), options.viewH ?? VIEW_H);
    this.events = new SimEventQueue(options.eventCapacity);

    const wt = this.worldTuning;
    for (const def of level.enemies) {
      const enemy: SimEnemy = def.kind === 'gloomcrawler' ? new Gloomcrawler(def, this.grid, wt) : new ThornSpitter(def, wt);
      enemy.setReformBlocker(this.blockerBox);
      this.enemies.push(enemy);
    }
    for (let i = 0; i < MAX_PROJECTILES; i++) this.projectiles.push(new ProjectileState(i));
    for (const def of level.orbs) this.orbs.push(new OrbState(def, wt.orbCollectRadius));
    for (const def of level.checkpoints) this.checkpoints.push(new CheckpointState(def));
    this.goal = level.goal ? new GoalState(level.goal) : null;
    this.orbsTotal = level.orbs.length;

    this.player.reset(level.playerStart.x, level.playerStart.y, this.tick);
    this.camera.snapTo(this.player, this.tick);
  }

  step(input: InputFrame): void {
    const tick = ++this.tick;
    const events = this.events;
    const player = this.player;

    // 1. prev ← cur.
    this.prevFade = this.fade;
    for (let i = 0; i < this.orbs.length; i++) {
      const o = this.orbs[i] as OrbState;
      o.prevX = o.x;
      o.prevY = o.y;
    }
    if (this.timerStartTick < 0 && player.alive && !isNeutral(input)) this.timerStartTick = tick;
    if (this.timerStartTick >= 0 && !this.completed) this.elapsed = (tick - this.timerStartTick + 1) * SIM_DT;

    // 2. Player (input is ignored while dead).
    player.step(input, tick, events);
    const box = player.getBounds(this.playerBox);
    if (player.alive) {
      this.blockerBox.minX = box.minX;
      this.blockerBox.minY = box.minY;
      this.blockerBox.maxX = box.maxX;
      this.blockerBox.maxY = box.maxY;
    } else {
      this.blockerBox.minX = this.blockerBox.maxX = this.blockerBox.minY = this.blockerBox.maxY = -Infinity;
    }

    // 3. Enemies.
    for (let i = 0; i < this.enemies.length; i++) (this.enemies[i] as SimEnemy).step(tick, events);

    // 4. Hazards.
    if (player.alive) this.checkHazards(tick);
    else this.debugDeathQueued = false;

    // 5–7. Orbs, checkpoints, goal.
    if (player.alive) {
      this.updateOrbs(tick);
      this.updateCheckpoints(tick);
      this.updateGoal(tick);
    }

    // 8. Death and respawn timers.
    this.updateDeath(tick);

    // 9. Camera.
    this.camera.step(player, SIM_DT);
  }

  setViewSize(viewW: number, viewH: number): void {
    this.camera.setViewSize(viewW, viewH);
  }

  /** Request a debug death (DeathCause.Debug) handled on the next step; no-op while dead. */
  respawn(): void {
    if (this.player.alive) this.debugDeathQueued = true;
  }

  /** Debug: move the player's feet to (x, y), zero velocity, set warpTick, snap the camera, emit Teleported. */
  teleport(x: number, y: number): void {
    this.player.reset(x, y, this.tick);
    this.debugDeathQueued = false;
    this.respawnTick = -1;
    this.fadeAtDeath = 0;
    this.fade = this.prevFade = 0;
    this.camera.snapTo(this.player, this.tick);
    this.events.push(SimEventType.Teleported, this.tick, x, y);
  }

  /** Restart from scratch (orbs, checkpoints, enemies, timer): clears the event queue, then emits Reset. */
  reset(): void {
    this.events.clear();
    for (let i = 0; i < this.orbs.length; i++) {
      const o = this.orbs[i] as OrbState;
      o.respawn();
      o.collected = false;
      o.collectedTick = -1;
    }
    for (let i = 0; i < this.checkpoints.length; i++) {
      const c = this.checkpoints[i] as CheckpointState;
      c.active = false;
      c.activatedTick = -1;
    }
    for (let i = 0; i < this.enemies.length; i++) (this.enemies[i] as SimEnemy).reset();
    if (this.goal) this.goal.reached = false;
    this.activeCheckpoint = -1;
    this.orbsCollected = 0;
    this.completed = false;
    this.elapsed = 0;
    this.timerStartTick = -1;
    this.debugDeathQueued = false;
    this.respawnTick = -1;
    this.fadeAtDeath = 0;
    this.fade = this.prevFade = 0;
    const start = this.level.playerStart;
    // A fresh run faces right like a new world (player.reset keeps facing across respawns).
    this.player.facing = 1;
    this.player.reset(start.x, start.y, this.tick);
    this.camera.snapTo(this.player, this.tick);
    this.events.push(SimEventType.Reset, this.tick, start.x, start.y);
  }

  /** Where the player respawns: the active checkpoint's bottom-centre, else playerStart. */
  respawnPoint(out: { x: number; y: number }): { x: number; y: number } {
    const c = this.activeCheckpoint >= 0 ? this.checkpoints[this.activeCheckpoint] : undefined;
    if (c) {
      out.x = c.x + c.w / 2;
      out.y = c.y + c.h;
    } else {
      out.x = this.level.playerStart.x;
      out.y = this.level.playerStart.y;
    }
    return out;
  }

  private kill(cause: DeathCause, tick: number): void {
    const p = this.player;
    p.kill(cause);
    this.fadeAtDeath = this.fade;
    this.respawnTick = -1;
    this.events.push(SimEventType.Died, tick, p.x, p.y - p.height / 2, cause);
  }

  private checkHazards(tick: number): void {
    const p = this.player;
    if (this.debugDeathQueued) {
      this.debugDeathQueued = false;
      this.kill(DeathCause.Debug, tick);
      return;
    }
    if (overlapsThorns(this.grid, p, HAZARD_INSET)) {
      this.kill(DeathCause.Thorns, tick);
      return;
    }
    const box = this.playerBox;
    const wt = this.worldTuning;
    const falling = p.vy > 0;
    let stomped = false;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i] as SimEnemy;
      if (!e.harmful || !overlapsBounds(box, e.getBounds(this.enemyBox))) continue;
      if (falling && p.prevY <= e.prevY - e.height + wt.stompTolerance) {
        e.stomp(tick, this.events);
        stomped = true;
        continue;
      }
      this.kill(DeathCause.Enemy, tick);
      return;
    }
    if (stomped) p.bounce(wt.stompBounceVelocity);
    if (p.y > this.level.pxHeight + KILL_MARGIN) this.kill(DeathCause.Fall, tick);
  }

  private updateOrbs(tick: number): void {
    const p = this.player;
    const wt = this.worldTuning;
    const cx = p.x;
    const cy = p.y - p.height / 2;
    const magnet2 = wt.orbMagnetRadius * wt.orbMagnetRadius;
    const dv = wt.orbMagnetAccel * SIM_DT;
    for (let i = 0; i < this.orbs.length; i++) {
      const o = this.orbs[i] as OrbState;
      if (o.collected) continue;
      let dx = cx - o.x;
      let dy = cy - o.y;
      let d2 = dx * dx + dy * dy;
      if (!o.magnetised && d2 <= magnet2) o.magnetised = true;
      if (o.magnetised && d2 > 0) {
        // v = approach(v, dir · orbMaxSpeed, orbMagnetAccel · dt), as a vector.
        const inv = wt.orbMaxSpeed / Math.sqrt(d2);
        const ex = dx * inv - o.vx;
        const ey = dy * inv - o.vy;
        const e = Math.sqrt(ex * ex + ey * ey);
        if (e <= dv) {
          o.vx += ex;
          o.vy += ey;
        } else {
          o.vx += (ex / e) * dv;
          o.vy += (ey / e) * dv;
        }
        o.x += o.vx * SIM_DT;
        o.y += o.vy * SIM_DT;
        dx = cx - o.x;
        dy = cy - o.y;
        d2 = dx * dx + dy * dy;
      }
      if (d2 <= o.radius * o.radius) {
        o.collected = true;
        o.collectedTick = tick;
        o.vx = 0;
        o.vy = 0;
        this.orbsCollected++;
        this.events.push(SimEventType.OrbCollected, tick, o.x, o.y, o.value, 0, o.id);
      }
    }
  }

  private updateCheckpoints(tick: number): void {
    const box = this.playerBox;
    let touched = -1;
    for (let i = 0; i < this.checkpoints.length; i++) {
      const c = this.checkpoints[i] as CheckpointState;
      if (overlapsRect(box, c.x, c.y, c.w, c.h)) touched = i;
    }
    if (touched < 0 || touched === this.activeCheckpoint) return;
    const prev = this.activeCheckpoint >= 0 ? this.checkpoints[this.activeCheckpoint] : undefined;
    if (prev) prev.active = false;
    const c = this.checkpoints[touched] as CheckpointState;
    c.active = true;
    c.activatedTick = tick;
    this.activeCheckpoint = touched;
    this.events.push(SimEventType.CheckpointActivated, tick, c.x + c.w / 2, c.y + c.h, 0, 0, c.id);
  }

  private updateGoal(tick: number): void {
    const g = this.goal;
    if (!g || g.reached || !overlapsRect(this.playerBox, g.x, g.y, g.w, g.h)) return;
    g.reached = true;
    this.completed = true;
    const p = this.player;
    this.events.push(SimEventType.GoalReached, tick, p.x, p.y, this.elapsed);
  }

  private updateDeath(tick: number): void {
    const p = this.player;
    const wt = this.worldTuning;
    if (!p.alive) {
      const k = p.deadTicks;
      p.visible = k < wt.deathHideTicks;
      this.fade = Math.max(this.fadeAtDeath, wt.fadeOutTicks > 0 ? Math.min(1, k / wt.fadeOutTicks) : 1);
      if (k >= wt.dyingTicks) this.respawnPlayer(tick);
      return;
    }
    if (this.respawnTick >= 0) {
      const k = tick - this.respawnTick;
      this.fade = wt.fadeInTicks > 0 ? clamp01(1 - k / wt.fadeInTicks) : 0;
      if (this.fade <= 0) this.respawnTick = -1;
    }
  }

  private respawnPlayer(tick: number): void {
    const at = this.respawnPoint(this.spawn);
    this.player.reset(at.x, at.y, tick);
    for (let i = 0; i < this.enemies.length; i++) (this.enemies[i] as SimEnemy).reset();
    for (let i = 0; i < this.orbs.length; i++) {
      const o = this.orbs[i] as OrbState;
      if (!o.collected) o.respawn();
    }
    this.camera.snapTo(this.player, tick);
    this.respawnTick = tick;
    this.fade = 1;
    const active = this.activeCheckpoint >= 0 ? (this.checkpoints[this.activeCheckpoint] as CheckpointState).id : -1;
    this.events.push(SimEventType.Respawned, tick, at.x, at.y, 0, 0, active);
  }
}
