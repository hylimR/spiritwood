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
  /** 0 when not dashing, else 0..1 progress through the dash. */
  readonly dashProgress: number;
  /** Ticks since the current mode started. */
  readonly modeTicks: number;
  /** Horizontal input intention this tick (-1..1), for animation. */
  readonly inputX: number;
  readonly alive: boolean;
  /** False while dead/respawning (render hides the hero). */
  readonly visible: boolean;
}

export type EnemyMode = 'patrol' | 'stunned';

export interface EnemyView {
  readonly id: number;
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
  readonly active: boolean;
  /** Tick of activation, -1 if never. */
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
  /** True for the tick in which a discontinuity happened (render must not interpolate). */
  readonly snapped: boolean;
  /** View size in world units at zoom 1 (VIEW_H * aspect, VIEW_H). */
  readonly viewW: number;
  readonly viewH: number;
}

export const SimEventType = {
  Jump: 1,
  AirJump: 2,
  WallJump: 3,
  Dash: 4,
  DashEnd: 5,
  /** a = impact speed (u/s, positive). */
  Land: 6,
  /** a = wall dir. */
  WallSlideStart: 7,
  WallSlideEnd: 8,
  /** id = orb id, a = value. */
  OrbCollected: 9,
  /** id = checkpoint id. */
  CheckpointActivated: 10,
  /** a = DeathCause. */
  Died: 11,
  Respawned: 12,
  /** id = enemy id. */
  EnemyStomped: 13,
  EnemyReformed: 14,
  GoalReached: 15,
  /** a = direction (-1/1): feet touched a one-way platform while dropping through. */
  DropThrough: 16,
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

/** Everything the renderer / HUD may read from the simulation. */
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
  /** Sim time in seconds since level start (tick * SIM_DT), paused while completed. */
  readonly elapsed: number;
  readonly completed: boolean;
}
