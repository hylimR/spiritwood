import type { Bounds, Facing } from '../contracts/common.ts';
import type { InputFrame } from '../contracts/input.ts';
import type { DeathCause, PlayerMode, PlayerView } from '../contracts/sim.ts';
import type { SimEventQueue } from '../core/events.ts';
import { todo } from '../core/todo.ts';
import type { CollisionGrid } from '../level/grid.ts';
import { DEFAULT_TUNING, deriveTuning, type DerivedTuning, type PlayerTuning } from './tuning.ts';

/**
 * Kinematic platformer controller (ARCHITECTURE.md §5.1). One `step` = one 60 Hz tick.
 * Emits Jump/AirJump/WallJump/Dash/DashEnd/Land/WallSlideStart/WallSlideEnd/DropThrough events.
 * Hazard/enemy deaths are decided by GameWorld, which calls `kill`.
 */
export class PlayerController implements PlayerView {
  x = 0;
  y = 0;
  prevX = 0;
  prevY = 0;
  vx = 0;
  vy = 0;
  readonly width: number;
  readonly height: number;
  facing: Facing = 1;
  mode: PlayerMode = 'air';
  grounded = false;
  wallDir: -1 | 0 | 1 = 0;
  airJumpsLeft = 0;
  airDashesLeft = 0;
  dashProgress = 0;
  dashDir: -1 | 0 | 1 = 0;
  modeTicks = 0;
  airTicks = 0;
  runDistance = 0;
  inputX = 0;
  alive = true;
  deadTicks = -1;
  visible = true;
  warpTick = -1;

  readonly tuning: PlayerTuning;
  readonly derived: DerivedTuning;

  constructor(grid: CollisionGrid, tuning: PlayerTuning = DEFAULT_TUNING) {
    void grid;
    this.tuning = tuning;
    this.derived = deriveTuning(tuning);
    this.width = tuning.width;
    this.height = tuning.height;
  }

  /** Spawn at a feet position: alive, visible, zero velocity, abilities restored, prev = cur, warpTick = tick. */
  reset(x: number, y: number, tick: number): void {
    void x; void y; void tick;
    todo('SIM', 'PlayerController.reset');
  }

  step(input: InputFrame, tick: number, events: SimEventQueue): void {
    void input; void tick; void events;
    todo('SIM', 'PlayerController.step');
  }

  /** Enter 'dead' mode (stops moving; deadTicks = 0). Emitting Died and hiding are GameWorld's job. */
  kill(cause: DeathCause): void {
    void cause;
    todo('SIM', 'PlayerController.kill');
  }

  /** Enemy stomp: vy = −velocity (cuttable like a jump), restores air jump and dash, ends dash/wall slide. */
  bounce(velocity: number): void {
    void velocity;
    todo('SIM', 'PlayerController.bounce');
  }

  getBounds(out: Bounds): Bounds {
    out.minX = this.x - this.width / 2;
    out.maxX = this.x + this.width / 2;
    out.minY = this.y - this.height;
    out.maxY = this.y;
    return out;
  }
}
