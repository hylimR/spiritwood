import type { Facing } from './common.ts';
import type { LevelData } from './level.ts';

/**
 * Movement mode of the player controller. `launchAim`: frozen in place while aiming a Spirit Launch
 * (the world is frozen too, SimView.frozen); `launched`: the launch flight (§5.1.1).
 */
export type PlayerMode = 'ground' | 'air' | 'wallSlide' | 'dash' | 'launchAim' | 'launched' | 'dead';

/**
 * Read-only player state for rendering. Positions are feet (bottom-centre).
 * Implementations update fields in place every tick — never allocate a new object.
 */
export interface PlayerView {
  readonly x: number;
  readonly y: number;
  readonly prevX: number;
  readonly prevY: number;
  readonly vx: number;
  readonly vy: number;
  readonly width: number;
  readonly height: number;
  readonly facing: Facing;
  readonly mode: PlayerMode;
  readonly grounded: boolean;
  /** -1/1 = touching (or stuck to) a wall on that side, 0 = none. */
  readonly wallDir: -1 | 0 | 1;
  readonly airJumpsLeft: number;
  readonly airDashesLeft: number;
  /** 0 when not dashing, else k/dashTicks on the k-th dash tick (so 1/dashTicks on the first). */
  readonly dashProgress: number;
  /** Direction of the current/last dash (0 before any dash). */
  readonly dashDir: -1 | 0 | 1;
  /** Ticks since the current mode was entered (0 on the entry tick). */
  readonly modeTicks: number;
  /** Ticks since the last grounded tick (0 while grounded). Unlike modeTicks, not reset by dash/wall. */
  readonly airTicks: number;
  /** Cumulative |Δx| while grounded, world units — drives a deterministic run-cycle phase. */
  readonly runDistance: number;
  /** Horizontal input intention this tick (-1..1), for animation. */
  readonly inputX: number;
  readonly alive: boolean;
  /** Ticks since death (0 on the Died tick), −1 while alive. */
  readonly deadTicks: number;
  /**
   * False from `deathHideTicks` after death until the Respawned tick (the `dead` clip plays in the
   * visible window). Visible during the fade-in.
   */
  readonly visible: boolean;
  /** Tick of the last respawn / teleport / reset (−1 = never). Render resets springs, scarf, trails when it changes. */
  readonly warpTick: number;
}

export type EnemyKind = 'gloomcrawler' | 'thornSpitter';

/**
 * Gloomcrawler: `patrol` | `stunned`. Thorn Spitter: `idle` (inactive) | `windup` (telegraph) | `cooldown`
 * (entered on the fire tick: SeedFired comes on the step after the windup's last tick) | `stunned` (§5.3).
 */
export type EnemyMode = 'patrol' | 'idle' | 'windup' | 'cooldown' | 'stunned';

export interface EnemyView {
  readonly id: number;
  readonly kind: EnemyKind;
  /** Length of the current mode in ticks (stun or windup length; 0 for open-ended modes). */
  readonly modeDuration: number;
  readonly x: number;
  readonly y: number;
  readonly prevX: number;
  readonly prevY: number;
  readonly vx: number;
  readonly facing: Facing;
  readonly width: number;
  readonly height: number;
  readonly mode: EnemyMode;
  readonly modeTicks: number;
}

/** Who a seed can hurt: `hostile` seeds kill the player; `reflected` seeds (launched off) stun enemies. */
export type ProjectileOwner = 'hostile' | 'reflected';

/**
 * A Thorn Spitter seed. SimView.projectiles is a fixed pool: slots are reused, `active` says whether a
 * slot is live, and `spawnTick` changes whenever a slot is (re)fired or reflected, so views reset trails.
 */
export interface ProjectileView {
  /** Pool slot index. */
  readonly id: number;
  readonly active: boolean;
  readonly owner: ProjectileOwner;
  /** Centre. */
  readonly x: number;
  readonly y: number;
  readonly prevX: number;
  readonly prevY: number;
  readonly vx: number;
  readonly vy: number;
  readonly radius: number;
  /** Tick of the last fire or reflection (−1 = never used). With `id` it identifies one flight. */
  readonly spawnTick: number;
  /** Enemy id that fired it. */
  readonly sourceId: number;
  /** Ticks stepped since the last fire or reflection (frozen ticks don't count). */
  readonly age: number;
  /** The seed expires when age reaches this (seedLifetimeTicks, or reflectedLifetimeTicks after a reflection). */
  readonly lifetime: number;
}

export type LaunchTargetKind = 'none' | 'seed' | 'enemy';

/**
 * Spirit Launch state for rendering and the HUD (§5.1.1). Target ids are ProjectileView.id (seed) or
 * EnemyView.id (enemy). Positions are target centres. Updated in place every tick.
 */
export interface LaunchView {
  /** The ability has been acquired this run (an AbilityShrine was touched). */
  readonly unlocked: boolean;
  /**
   * The target a press would grab now (nearest valid in range); `none` while aiming, dead or locked.
   * candidateId/X/Y are meaningful only while candidateKind ≠ 'none' (stale otherwise).
   */
  readonly candidateKind: LaunchTargetKind;
  readonly candidateId: number;
  readonly candidateX: number;
  readonly candidateY: number;
  /** The grabbed target while aiming, then the last launched target during the flight; X/Y = its centre at the grab. */
  readonly targetKind: LaunchTargetKind;
  readonly targetId: number;
  readonly targetX: number;
  readonly targetY: number;
  /** Unit aim direction (while aiming), then the launch direction (while launched). */
  readonly aimX: number;
  readonly aimY: number;
  /** Ticks spent aiming (0 on the LaunchAim tick) and the auto-release limit. */
  readonly aimTicks: number;
  readonly aimMaxTicks: number;
  /** Grab radius around the player's centre, world units (for the debug draw and range hints). */
  readonly range: number;
}

export interface OrbView {
  readonly id: number;
  /** Centre (orbs drift toward the player when magnetised). */
  readonly x: number;
  readonly y: number;
  readonly prevX: number;
  readonly prevY: number;
  readonly value: number;
  /** Collect radius (world units). */
  readonly radius: number;
  readonly collected: boolean;
  /** Tick when collected, -1 if not. */
  readonly collectedTick: number;
}

export interface CheckpointView {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** This is the current respawn checkpoint (ever-activated = activatedTick ≥ 0). */
  readonly active: boolean;
  /** Tick of the latest activation, -1 if never. */
  readonly activatedTick: number;
}

export interface GoalView {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly reached: boolean;
}

/** Camera centre in world units, simulated at 60 Hz. */
export interface CameraView {
  readonly x: number;
  readonly y: number;
  readonly prevX: number;
  readonly prevY: number;
  readonly zoom: number;
  readonly prevZoom: number;
  /**
   * Tick of the last snap (−1 = never). A snap sets prev = cur, so interpolation needs no special case;
   * views holding camera-relative state (ambient particles) re-seed when this changes.
   */
  readonly snapTick: number;
  /** View size in world units at zoom 1 (VIEW_H * aspect, VIEW_H). */
  readonly viewW: number;
  readonly viewH: number;
}

/**
 * Event payloads (normative). Default: x, y = player feet; unused a/b = 0; id = −1.
 *
 * | type | x, y | a | b | id |
 * |---|---|---|---|---|
 * | Jump | feet | facing | 1 if it cancelled a dash | |
 * | AirJump | feet | facing | airJumpsLeft after | |
 * | WallJump | wall face x, feet y | launch dir (−wallDir) | | |
 * | Dash | feet | dashDir | 1 if airborne | |
 * | DashEnd | feet | dashDir | 0 timed out, 1 jump-cancel, 2 hit wall, 3 launch grab | |
 * | Land | feet | impact speed u/s | fall height u (apex y of the airborne arc → landing y) | |
 * | WallSlideStart | wall face x, feet y | wallDir | | |
 * | WallSlideEnd | wall face x, feet y | wallDir | 0 released, 1 landed, 2 wall-jumped, 3 wall ended, 4 launch grab | |
 * | OrbCollected | orb centre | value | | orb id |
 * | CheckpointActivated | respawn feet | | | checkpoint id |
 * | Died | body centre | DeathCause | | |
 * | Respawned | respawn feet | | | checkpoint id or −1 |
 * | EnemyStomped | enemy top-centre | | | enemy id |
 * | EnemyReformed | enemy feet | | | enemy id |
 * | GoalReached | feet | elapsed seconds | | |
 * | DropThrough | feet | | | |  (once, when the drop starts)
 * | Reset | new player feet | | | |  (GameWorld.reset, emitted after clearing the queue)
 * | Teleported | new player feet | | | |  (GameWorld.teleport)
 * | AbilityUnlocked | shrine bottom-centre | Ability | | shrine id |
 * | LaunchAim | target centre | LaunchTargetCode | | target id |
 * | Launch | player feet | launch angle (rad, atan2(aimY, aimX)) | LaunchTargetCode | target id |
 * | LaunchFizzle | player centre | | | |  (launch pressed with nothing in range)
 * | SeedFired | seed centre | vx | vy | seed id |
 * | SeedBurst | seed centre | SeedBurstCause | owner (0 hostile, 1 reflected) | seed id |
 * | SpitterWindup | spitter muzzle | windup ticks | | enemy id |
 * | EnemyHit | enemy centre | EnemyHitCause | | enemy id |
 *
 * Views reset per-run render state (springs, scarf, trails, bursts) on Respawned, Reset and Teleported.
 */
export const SimEventType = {
  Jump: 1,
  AirJump: 2,
  WallJump: 3,
  Dash: 4,
  DashEnd: 5,
  Land: 6,
  WallSlideStart: 7,
  WallSlideEnd: 8,
  OrbCollected: 9,
  CheckpointActivated: 10,
  Died: 11,
  Respawned: 12,
  EnemyStomped: 13,
  EnemyReformed: 14,
  GoalReached: 15,
  DropThrough: 16,
  Reset: 17,
  Teleported: 18,
  AbilityUnlocked: 19,
  LaunchAim: 20,
  Launch: 21,
  LaunchFizzle: 22,
  SeedFired: 23,
  SeedBurst: 24,
  SpitterWindup: 25,
  EnemyHit: 26,
} as const;
export type SimEventType = (typeof SimEventType)[keyof typeof SimEventType];

export const DeathCause = {
  Thorns: 1,
  Enemy: 2,
  Fall: 3,
  Debug: 4,
  Seed: 5,
} as const;
export type DeathCause = (typeof DeathCause)[keyof typeof DeathCause];

/** AbilityUnlocked `a`. */
export const Ability = {
  Launch: 1,
} as const;
export type Ability = (typeof Ability)[keyof typeof Ability];

/** LaunchAim `a` / Launch `b`: the grabbed target's kind. */
export const LaunchTargetCode = {
  Seed: 1,
  Enemy: 2,
} as const;
export type LaunchTargetCode = (typeof LaunchTargetCode)[keyof typeof LaunchTargetCode];

/** SeedBurst `a`. */
export const SeedBurstCause = {
  Terrain: 1,
  Player: 2,
  Enemy: 3,
  Expired: 4,
} as const;
export type SeedBurstCause = (typeof SeedBurstCause)[keyof typeof SeedBurstCause];

/** EnemyHit `a`. */
export const EnemyHitCause = {
  /** Struck by a reflected seed. */
  Seed: 1,
  /** Launched off. */
  Launch: 2,
} as const;
export type EnemyHitCause = (typeof EnemyHitCause)[keyof typeof EnemyHitCause];

/** A pooled event record. Consumers must copy what they need; records are reused. */
export interface SimEvent {
  type: SimEventType;
  tick: number;
  x: number;
  y: number;
  a: number;
  b: number;
  id: number;
}

/** Fixed-capacity event buffer filled during sim steps and drained once per render frame. */
export interface SimEventQueueView {
  readonly count: number;
  get(index: number): SimEvent;
}

/**
 * Everything the renderer / HUD may read from the simulation.
 * `orbs`, `checkpoints` and `enemies` are allocated once in LevelData order
 * (sim.orbs[i].id === level.orbs[i].id, sim.enemies[i].id === level.enemies[i].id === i); `projectiles`
 * is a fixed pool (ProjectileView). The arrays and their element objects are never replaced, reordered
 * or resized — not even by reset(). `goal`, `launch` and `camera` keep their identity. Implementations
 * may use their own mutable classes for the elements.
 */
export interface SimView {
  readonly tick: number;
  readonly level: LevelData;
  readonly player: PlayerView;
  readonly orbs: readonly OrbView[];
  readonly checkpoints: readonly CheckpointView[];
  readonly enemies: readonly EnemyView[];
  readonly projectiles: readonly ProjectileView[];
  readonly launch: LaunchView;
  /**
   * True while the world is frozen for a Spirit Launch aim: enemies, projectiles and orbs do not step
   * (the tick counter, timer and camera do). Render eases its world clock toward a crawl (FrameInfo.timeScale).
   */
  readonly frozen: boolean;
  readonly goal: GoalView | null;
  readonly camera: CameraView;
  readonly events: SimEventQueueView;
  readonly orbsCollected: number;
  readonly orbsTotal: number;
  /** Death/respawn fade: 0 = clear, 1 = fully faded. */
  readonly fade: number;
  readonly prevFade: number;
  /**
   * Run timer in seconds: starts on the first tick with non-neutral input, stops at GoalReached.
   */
  readonly elapsed: number;
  readonly completed: boolean;
}
