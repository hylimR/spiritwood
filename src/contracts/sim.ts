import type { Facing } from './common.ts';
import type { LevelData } from './level.ts';

/** Movement mode of the player controller. */
export type PlayerMode = 'ground' | 'air' | 'wallSlide' | 'dash' | 'dead';

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

export type EnemyMode = 'patrol' | 'stunned';

export interface EnemyView {
  readonly id: number;
  /** Length of the current mode in ticks (stunTicks while stunned, 0 on patrol). */
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
 * | DashEnd | feet | dashDir | 0 timed out, 1 jump-cancel, 2 hit wall | |
 * | Land | feet | impact speed u/s | fall height u (apex y of the airborne arc → landing y) | |
 * | WallSlideStart | wall face x, feet y | wallDir | | |
 * | WallSlideEnd | wall face x, feet y | wallDir | 0 released, 1 landed, 2 wall-jumped, 3 wall ended | |
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
} as const;
export type SimEventType = (typeof SimEventType)[keyof typeof SimEventType];

export const DeathCause = {
  Thorns: 1,
  Enemy: 2,
  Fall: 3,
  Debug: 4,
} as const;
export type DeathCause = (typeof DeathCause)[keyof typeof DeathCause];

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
 * (sim.orbs[i].id === level.orbs[i].id); the arrays and their element objects are never replaced,
 * reordered or resized — not even by reset(). `goal` keeps its identity. Implementations may use their
 * own mutable classes for the elements.
 */
export interface SimView {
  readonly tick: number;
  readonly level: LevelData;
  readonly player: PlayerView;
  readonly orbs: readonly OrbView[];
  readonly checkpoints: readonly CheckpointView[];
  readonly enemies: readonly EnemyView[];
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
