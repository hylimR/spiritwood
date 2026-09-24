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

  /** Request a debug death (DeathCause.Debug) handled on the next step; no-op while dead. */
  respawn(): void {
    todo('SIM', 'GameWorld.respawn');
  }

  /** Debug: move the player's feet to (x, y), zero velocity, set warpTick, snap the camera, emit Teleported. */
  teleport(x: number, y: number): void {
    void x; void y;
    todo('SIM', 'GameWorld.teleport');
  }

  /** Restart from scratch (orbs, checkpoints, enemies, timer): clears the event queue, then emits Reset. */
  reset(): void {
    todo('SIM', 'GameWorld.reset');
  }
}
