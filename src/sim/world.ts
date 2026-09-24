import type { InputFrame } from '../contracts/input.ts';
import type { LevelData } from '../contracts/level.ts';
import type { CheckpointView, GoalView, OrbView, SimView } from '../contracts/sim.ts';
import { SimEventQueue } from '../core/events.ts';
import { todo } from '../core/todo.ts';
import { CollisionGrid } from '../level/grid.ts';
import { CameraController } from './camera.ts';
import type { Gloomcrawler } from './enemy.ts';
import { PlayerController } from './player.ts';
import type { CameraTuning, PlayerTuning, WorldTuning } from './tuning.ts';

export interface WorldOptions {
  tuning?: Partial<PlayerTuning>;
  camera?: Partial<CameraTuning>;
  world?: Partial<WorldTuning>;
  viewW?: number;
  viewH?: number;
  eventCapacity?: number;
}

/**
 * The whole deterministic simulation (ARCHITECTURE.md §5.3). `step` = one 60 Hz tick:
 * player → enemies → hazards/stomps → orbs → checkpoints → goal → death/respawn timers → camera.
 * Events accumulate in `events` until the orchestrator drains and clears them.
 */
export class GameWorld implements SimView {
  readonly level: LevelData;
  readonly grid: CollisionGrid;
  readonly player: PlayerController;
  readonly camera: CameraController;
  readonly events: SimEventQueue;
  readonly enemies: Gloomcrawler[] = [];
  readonly orbs: OrbView[] = [];
  readonly checkpoints: CheckpointView[] = [];
  goal: GoalView | null = null;
  tick = 0;
  orbsCollected = 0;
  orbsTotal = 0;
  fade = 0;
  prevFade = 0;
  elapsed = 0;
  completed = false;

  constructor(level: LevelData, options: WorldOptions = {}) {
    this.level = level;
    this.grid = CollisionGrid.fromLevel(level);
    this.player = new PlayerController(this.grid);
    this.camera = new CameraController();
    this.events = new SimEventQueue(options.eventCapacity);
    todo('SIM', 'GameWorld');
  }

  step(input: InputFrame): void {
    void input;
    todo('SIM', 'GameWorld.step');
  }

  setViewSize(viewW: number, viewH: number): void {
    void viewW; void viewH;
    todo('SIM', 'GameWorld.setViewSize');
  }

  /** Kill (DeathCause.Debug) → normal respawn sequence. */
  respawn(): void {
    todo('SIM', 'GameWorld.respawn');
  }

  /** Debug: move the player's feet to (x, y), zero velocity, snap the camera. */
  teleport(x: number, y: number): void {
    void x; void y;
    todo('SIM', 'GameWorld.teleport');
  }

  /** Restart the level from scratch (orbs, checkpoints, timer). */
  reset(): void {
    todo('SIM', 'GameWorld.reset');
  }
}
