import type { Facing } from '../contracts/common.ts';
import type { CameraView, PlayerMode } from '../contracts/sim.ts';
import { VIEW_H } from '../config.ts';
import { todo } from '../core/todo.ts';
import { DEFAULT_CAMERA_TUNING, type CameraTuning } from './tuning.ts';

export interface CameraTarget {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly facing: Facing;
  readonly grounded: boolean;
  readonly mode: PlayerMode;
}

/**
 * Platformer camera (ARCHITECTURE.md §5.2): dead zone, look-ahead, landing-based vertical follow,
 * look-down when falling fast, smoothDamp per axis, clamped to bounds. Simulated at 60 Hz.
 */
export class CameraController implements CameraView {
  x = 0;
  y = 0;
  prevX = 0;
  prevY = 0;
  zoom = 1;
  prevZoom = 1;
  snapTick = -1;
  viewW = VIEW_H * (16 / 9);
  viewH = VIEW_H;
  readonly tuning: CameraTuning;

  constructor(tuning: CameraTuning = DEFAULT_CAMERA_TUNING) {
    this.tuning = tuning;
    this.zoom = this.prevZoom = tuning.zoom;
  }

  setViewSize(viewW: number, viewH: number): void {
    void viewW; void viewH;
    todo('SIM', 'CameraController.setViewSize');
  }

  /** World rect the camera centre's view must stay inside. */
  setBounds(minX: number, minY: number, maxX: number, maxY: number): void {
    void minX; void minY; void maxX; void maxY;
    todo('SIM', 'CameraController.setBounds');
  }

  /** Jump straight to framing `target`: value = target, velocities 0, prev = cur, snapTick = tick. */
  snapTo(target: CameraTarget, tick: number): void {
    void target; void tick;
    todo('SIM', 'CameraController.snapTo');
  }

  /** Follow an explicit point (bench flythrough) instead of the target until clearOverride(). */
  setOverride(x: number, y: number): void {
    void x; void y;
    todo('SIM', 'CameraController.setOverride');
  }

  clearOverride(): void {
    todo('SIM', 'CameraController.clearOverride');
  }

  step(target: CameraTarget, dt: number): void {
    void target; void dt;
    todo('SIM', 'CameraController.step');
  }
}
