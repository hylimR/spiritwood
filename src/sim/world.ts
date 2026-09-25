import { KILL_MARGIN, HAZARD_INSET, SIM_DT, VIEW_H } from '../config.ts';
import type { Bounds } from '../contracts/common.ts';
import { createInputFrame, type InputFrame } from '../contracts/input.ts';
import type { AbilityShrineDef, CheckpointDef, GoalDef, LevelData, OrbDef } from '../contracts/level.ts';
import {
  Ability, DeathCause, EnemyHitCause, LaunchTargetCode, SimEventType, type CheckpointView, type GoalView, type LaunchTargetKind,
  type LaunchView, type OrbView, type SimView,
} from '../contracts/sim.ts';
import { SimEventQueue } from '../core/events.ts';
import { clamp01 } from '../core/math.ts';
import { CollisionGrid } from '../level/grid.ts';
import { CameraController } from './camera.ts';
import { Gloomcrawler } from './enemy.ts';
import { lineOfSight, overlapsThorns } from './physics.ts';
import { PlayerController } from './player.ts';
import { ProjectileState, SeedPool } from './seeds.ts';
import type { SimEnemy } from './simEnemy.ts';
import { ThornSpitter } from './spitter.ts';
import {
  DEFAULT_CAMERA_TUNING, DEFAULT_LAUNCH_TUNING, DEFAULT_TUNING, DEFAULT_WORLD_TUNING, type CameraTuning, type LaunchTuning,
  type PlayerTuning, type WorldTuning,
} from './tuning.ts';

export { ProjectileState };

export interface WorldOptions {
  tuning?: Partial<PlayerTuning>;
  camera?: Partial<CameraTuning>;
  world?: Partial<WorldTuning>;
  launch?: Partial<LaunchTuning>;
  viewW?: number;
  viewH?: number;
  /** Event queue capacity (default 256). */
  eventCapacity?: number;
}

const DEFAULT_EVENT_CAPACITY = 256;

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

/** Mutable Spirit Launch state behind LaunchView (§5.1.1), updated in place every tick. */
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

function targetCode(kind: LaunchTargetKind): number {
  return kind === 'seed' ? LaunchTargetCode.Seed : kind === 'enemy' ? LaunchTargetCode.Enemy : 0;
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
  readonly projectiles: ProjectileState[];
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
  readonly launchTuning: LaunchTuning;
  readonly seeds: SeedPool;

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
  /** The input the player step sees: presses dropped during the launch input lock. */
  private readonly playerInput: InputFrame = createInputFrame();

  // Spirit Launch world countdowns (§5.1.1): set at step 2 of the release, decremented at step 1.
  private grace = 0;
  private inputLock = 0;
  private regrab = 0;
  private launchBuffer = 0;
  /** Identity of the last launched target: (kind, id) for an enemy, (id, spawnTick) for a seed. */
  private lastTargetKind: LaunchTargetKind = 'none';
  private lastTargetId = -1;
  private lastTargetSpawnTick = -1;
  /** spawnTick of the published candidate / the grabbed target when they are seeds. */
  private candidateSpawnTick = -1;
  private targetSpawnTick = -1;

  constructor(level: LevelData, options: WorldOptions = {}) {
    this.level = level;
    this.playerTuning = { ...DEFAULT_TUNING, ...options.tuning };
    this.cameraTuning = { ...DEFAULT_CAMERA_TUNING, ...options.camera };
    this.worldTuning = { ...DEFAULT_WORLD_TUNING, ...options.world };
    this.launchTuning = { ...DEFAULT_LAUNCH_TUNING, ...options.launch };
    this.grid = CollisionGrid.fromLevel(level);
    this.player = new PlayerController(this.grid, this.playerTuning, this.launchTuning);
    this.camera = new CameraController(this.cameraTuning);
    this.camera.setBounds(0, 0, level.pxWidth, level.pxHeight);
    this.camera.setViewSize(options.viewW ?? VIEW_H * (16 / 9), options.viewH ?? VIEW_H);
    this.events = new SimEventQueue(options.eventCapacity ?? DEFAULT_EVENT_CAPACITY);
    this.seeds = new SeedPool(this.grid, this.worldTuning, level.pxHeight);
    this.projectiles = this.seeds.slots;
    this.launch.range = this.launchTuning.range;
    this.launch.aimMaxTicks = this.launchTuning.aimMaxTicks;

    const wt = this.worldTuning;
    const env = { grid: this.grid, player: this.player, camera: this.camera, seeds: this.seeds };
    for (const def of level.enemies) {
      const enemy: SimEnemy = def.kind === 'gloomcrawler' ? new Gloomcrawler(def, this.grid, wt) : new ThornSpitter(def, env, wt);
      enemy.setReformBlocker(this.blockerBox);
      this.enemies.push(enemy);
    }
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

    // 1. prev ← cur for everything; the world countdowns.
    this.prevFade = this.fade;
    for (let i = 0; i < this.orbs.length; i++) {
      const o = this.orbs[i] as OrbState;
      o.prevX = o.x;
      o.prevY = o.y;
    }
    for (let i = 0; i < this.enemies.length; i++) (this.enemies[i] as SimEnemy).savePrev();
    this.seeds.savePrev();
    if (this.grace > 0) this.grace--;
    if (this.inputLock > 0) this.inputLock--;
    if (this.regrab > 0) this.regrab--;
    if (this.launchBuffer > 0) {
      this.launchBuffer--;
      if (this.launchBuffer === 0) events.push(SimEventType.LaunchFizzle, tick, player.x, player.y - player.height / 2);
    }
    if (this.timerStartTick < 0 && player.alive && !isNeutral(input)) this.timerStartTick = tick;
    if (this.timerStartTick >= 0 && !this.completed) this.elapsed = (tick - this.timerStartTick + 1) * SIM_DT;

    // 2. A queued debug respawn kills (cancelling an aim), then Spirit Launch: aim/release, buffer, grab.
    if (this.debugDeathQueued) {
      this.debugDeathQueued = false;
      if (player.alive) this.kill(DeathCause.Debug, tick);
    }
    this.updateLaunch(input, tick);

    // 3. Player (input is ignored while dead; presses are dropped during the input lock).
    const pin = this.playerInput;
    pin.moveX = input.moveX;
    pin.moveY = input.moveY;
    pin.jumpHeld = input.jumpHeld;
    pin.dashHeld = input.dashHeld;
    pin.jumpPressed = input.jumpPressed && this.inputLock === 0;
    pin.dashPressed = input.dashPressed && this.inputLock === 0;
    pin.launchHeld = input.launchHeld;
    pin.launchPressed = input.launchPressed;
    pin.launchReleased = input.launchReleased;
    player.step(pin, tick, events);
    const box = player.getBounds(this.playerBox);
    if (player.alive) {
      this.blockerBox.minX = box.minX;
      this.blockerBox.minY = box.minY;
      this.blockerBox.maxX = box.maxX;
      this.blockerBox.maxY = box.maxY;
    } else {
      this.blockerBox.minX = this.blockerBox.maxX = this.blockerBox.minY = this.blockerBox.maxY = -Infinity;
    }

    // 4. Unless frozen: enemies (spitters may fire), then projectiles.
    if (!this.frozen) {
      for (let i = 0; i < this.enemies.length; i++) (this.enemies[i] as SimEnemy).step(tick, events);
      this.seeds.step(tick, this.enemies, events);
    }

    // 5. Hazards, if alive and not aiming.
    if (player.alive && !this.frozen) this.checkHazards(tick);

    // 6. Orbs, checkpoints, ability shrines, goal, if alive and not frozen.
    if (player.alive && !this.frozen) {
      this.updateOrbs(tick);
      this.updateCheckpoints(tick);
      this.updateShrines(tick);
      this.updateGoal(tick);
    }

    // 7. Death and respawn timers.
    this.updateDeath(tick);

    // 8. Launch candidate refresh (LaunchView).
    this.refreshCandidate();

    // 9. Camera.
    this.camera.step(player, SIM_DT);
  }

  setViewSize(viewW: number, viewH: number): void {
    this.camera.setViewSize(viewW, viewH);
  }

  /** Request a debug death (DeathCause.Debug) handled at step 2 of the next step; no-op while dead. */
  respawn(): void {
    if (this.player.alive) this.debugDeathQueued = true;
  }

  /** Test/debug hook: acquire an ability without touching a shrine (no event). reset() clears it. */
  unlock(ability: Ability): void {
    if (ability === Ability.Launch) this.launch.unlocked = true;
  }

  /**
   * Debug: move the player's feet to (x, y), zero velocity, set warpTick, cancel an aim, free every seed
   * slot silently, snap the camera, emit Teleported.
   */
  teleport(x: number, y: number): void {
    this.cancelLaunch();
    this.player.reset(x, y, this.tick);
    this.seeds.clear();
    this.debugDeathQueued = false;
    this.respawnTick = -1;
    this.fadeAtDeath = 0;
    this.fade = this.prevFade = 0;
    this.camera.snapTo(this.player, this.tick);
    this.events.push(SimEventType.Teleported, this.tick, x, y);
  }

  /**
   * Restart from scratch (orbs, checkpoints, enemies, seeds, unlocks, timer): clears the event queue,
   * then emits Reset.
   */
  reset(): void {
    this.events.clear();
    this.cancelLaunch();
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
    this.seeds.clear();
    const l = this.launch;
    l.unlocked = false;
    l.targetKind = 'none';
    l.targetId = -1;
    l.targetX = 0;
    l.targetY = 0;
    l.candidateX = 0;
    l.candidateY = 0;
    l.aimX = 0;
    l.aimY = -1;
    l.aimTicks = 0;
    this.lastTargetKind = 'none';
    this.lastTargetId = -1;
    this.lastTargetSpawnTick = -1;
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

  /** Spirit Launch, world step 2 (§5.1.1): aiming and release, then the buffer, then the grab. */
  private updateLaunch(input: InputFrame, tick: number): void {
    const l = this.launch;
    const lt = this.launchTuning;
    let released = false;
    if (this.frozen) {
      l.aimTicks++;
      this.computeAim(input);
      if (input.launchReleased || !input.launchHeld || l.aimTicks >= lt.aimMaxTicks) {
        this.release(tick);
        released = true;
      }
    }
    if (input.launchPressed && l.unlocked && this.player.alive && !this.frozen) this.launchBuffer = lt.bufferTicks;
    if (!released && this.launchBuffer > 0 && l.candidateKind !== 'none' && this.player.alive && !this.frozen) {
      this.grab(input, tick);
    }
  }

  /** Grab the candidate published at the previous step 8: the player aims, the world freezes. */
  private grab(input: InputFrame, tick: number): void {
    const l = this.launch;
    this.launchBuffer = 0;
    this.player.enterAim(tick, this.events);
    this.frozen = true;
    l.aimTicks = 0;
    l.targetKind = l.candidateKind;
    l.targetId = l.candidateId;
    l.targetX = l.candidateX;
    l.targetY = l.candidateY;
    this.targetSpawnTick = this.candidateSpawnTick;
    this.computeAim(input);
    this.events.push(SimEventType.LaunchAim, tick, l.targetX, l.targetY, targetCode(l.targetKind), 0, l.targetId);
  }

  /**
   * The aim: the input vector when its length reaches dirThreshold, else from the target centre to the
   * player centre (a neutral release pushes away from the target), else straight up.
   */
  private computeAim(input: InputFrame): void {
    const l = this.launch;
    const mx = input.moveX;
    const my = input.moveY;
    const len = Math.sqrt(mx * mx + my * my);
    if (len >= this.playerTuning.dirThreshold) {
      l.aimX = mx / len;
      l.aimY = my / len;
      return;
    }
    const p = this.player;
    const dx = p.x - l.targetX;
    const dy = p.y - p.height / 2 - l.targetY;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0) {
      l.aimX = dx / d;
      l.aimY = dy / d;
    } else {
      l.aimX = 0;
      l.aimY = -1;
    }
  }

  /** The release: the player launches along the aim; a seed target is flung the opposite way, an enemy hit. */
  private release(tick: number): void {
    const l = this.launch;
    const lt = this.launchTuning;
    const p = this.player;
    const ax = l.aimX;
    const ay = l.aimY;
    p.release(ax, ay);
    const kind = l.targetKind;
    const id = l.targetId;
    let spawnTick = -1;
    if (kind === 'seed') {
      const s = this.projectiles[id];
      if (s && s.active && s.spawnTick === this.targetSpawnTick) {
        this.seeds.reflect(id, -ax * lt.seedSpeed, -ay * lt.seedSpeed, tick);
        spawnTick = s.spawnTick;
      }
    } else if (kind === 'enemy') {
      const e = this.enemies[id];
      if (e) e.hit(EnemyHitCause.Launch, tick, this.events);
    }
    this.events.push(SimEventType.Launch, tick, p.x, p.y, Math.atan2(ay, ax), targetCode(kind), id);
    this.frozen = false;
    this.grace = lt.graceTicks;
    this.inputLock = lt.inputLockTicks;
    this.regrab = lt.regrabTicks;
    this.lastTargetKind = kind;
    this.lastTargetId = id;
    this.lastTargetSpawnTick = spawnTick;
  }

  /** Death, respawn, teleport and reset cancel an aim (no Launch) and clear the launch countdowns. */
  private cancelLaunch(): void {
    this.frozen = false;
    this.launchBuffer = 0;
    this.grace = 0;
    this.inputLock = 0;
    this.regrab = 0;
    this.launch.candidateKind = 'none';
    this.launch.candidateId = -1;
  }

  /**
   * World step 8: the valid target nearest the player centre (within range inclusive, line of sight, not
   * the last target during regrab) among active seeds, crawlers and player-aimed spitters; ties go to
   * seeds, then to the lower id. Empty while aiming, dead or locked.
   */
  private refreshCandidate(): void {
    const l = this.launch;
    const p = this.player;
    l.candidateKind = 'none';
    l.candidateId = -1;
    if (!p.alive || this.frozen || !l.unlocked) return;
    const grid = this.grid;
    const cx = p.x;
    const cy = p.y - p.height / 2;
    const range2 = this.launchTuning.range * this.launchTuning.range;
    const regrab = this.regrab > 0;
    let best = Infinity;
    for (let i = 0; i < this.projectiles.length; i++) {
      const s = this.projectiles[i] as ProjectileState;
      if (!s.active) continue;
      const dx = s.x - cx;
      const dy = s.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > range2 || d2 >= best) continue;
      if (regrab && this.lastTargetKind === 'seed' && this.lastTargetId === s.id && this.lastTargetSpawnTick === s.spawnTick) continue;
      if (!lineOfSight(grid, cx, cy, s.x, s.y)) continue;
      best = d2;
      l.candidateKind = 'seed';
      l.candidateId = s.id;
      l.candidateX = s.x;
      l.candidateY = s.y;
      this.candidateSpawnTick = s.spawnTick;
    }
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i] as SimEnemy;
      if (!e.launchTarget) continue;
      const ex = e.x;
      const ey = e.y - e.height / 2;
      const dx = ex - cx;
      const dy = ey - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 > range2 || d2 >= best) continue;
      if (regrab && this.lastTargetKind === 'enemy' && this.lastTargetId === e.id) continue;
      if (!lineOfSight(grid, cx, cy, ex, ey)) continue;
      best = d2;
      l.candidateKind = 'enemy';
      l.candidateId = e.id;
      l.candidateX = ex;
      l.candidateY = ey;
      this.candidateSpawnTick = -1;
    }
  }

  private kill(cause: DeathCause, tick: number): void {
    const p = this.player;
    this.cancelLaunch();
    p.kill(cause, tick);
    this.fadeAtDeath = this.fade;
    this.respawnTick = -1;
    this.events.push(SimEventType.Died, tick, p.x, p.y - p.height / 2, cause);
  }

  /** World step 5: thorns, enemies (grace skips only the kill), hostile seeds (skipped during grace), kill plane. */
  private checkHazards(tick: number): void {
    const p = this.player;
    if (overlapsThorns(this.grid, p, HAZARD_INSET)) {
      this.kill(DeathCause.Thorns, tick);
      return;
    }
    const box = this.playerBox;
    const wt = this.worldTuning;
    const grace = this.grace > 0;
    const falling = p.vy > 0;
    let stomped = false;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i] as SimEnemy;
      if (!e.harmful || !overlapsBounds(box, e.getBounds(this.enemyBox))) continue;
      if (e.stompable && falling && p.prevY <= e.prevY - e.height + wt.stompTolerance) {
        e.stomp(tick, this.events);
        stomped = true;
        continue;
      }
      if (grace) continue;
      this.kill(DeathCause.Enemy, tick);
      return;
    }
    if (stomped) p.bounce(wt.stompBounceVelocity);
    if (!grace && this.seeds.hitPlayer(box, tick, this.events)) {
      this.kill(DeathCause.Seed, tick);
      return;
    }
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

  /** The first overlap with an AbilityShrine unlocks Spirit Launch for the rest of the run. */
  private updateShrines(tick: number): void {
    if (this.launch.unlocked) return;
    const shrines = this.level.abilityShrines;
    for (let i = 0; i < shrines.length; i++) {
      const s = shrines[i] as AbilityShrineDef;
      if (!overlapsRect(this.playerBox, s.x, s.y, s.w, s.h)) continue;
      this.launch.unlocked = true;
      this.events.push(SimEventType.AbilityUnlocked, tick, s.x + s.w / 2, s.y + s.h, Ability.Launch, 0, s.id);
      return;
    }
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
    this.cancelLaunch();
    this.player.reset(at.x, at.y, tick);
    for (let i = 0; i < this.enemies.length; i++) (this.enemies[i] as SimEnemy).reset();
    this.seeds.clear();
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
