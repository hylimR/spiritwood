import type { Facing } from '../contracts/common.ts';
import type { CameraView, PlayerMode } from '../contracts/sim.ts';
import { MIN_CAMERA_ZOOM, VIEW_H } from '../config.ts';
import { smoothDamp, type SmoothDampState } from '../core/math.ts';
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

  private minX = -Infinity;
  private minY = -Infinity;
  private maxX = Infinity;
  private maxY = Infinity;

  /** Framing focus in feet space (dead-zone followers). */
  private focusX = 0;
  private focusY = 0;
  private groundRef = 0;
  private lastGroundedY = 0;

  private lookDir: -1 | 0 | 1 = 0;
  private candidateDir: -1 | 0 | 1 = 0;
  private candidateTicks = 0;
  private slowTicks = 0;
  private readonly lookAhead: SmoothDampState = { value: 0, velocity: 0 };
  private readonly sx: SmoothDampState = { value: 0, velocity: 0 };
  private readonly sy: SmoothDampState = { value: 0, velocity: 0 };

  private overridden = false;
  private overrideX = 0;
  private overrideY = 0;

  constructor(tuning: CameraTuning = DEFAULT_CAMERA_TUNING) {
    this.tuning = tuning;
    this.zoom = this.prevZoom = Math.max(MIN_CAMERA_ZOOM, tuning.zoom);
  }

  setViewSize(viewW: number, viewH: number): void {
    this.viewW = viewW;
    this.viewH = viewH;
    this.reclamp();
  }

  /** World rect the camera centre's view must stay inside. */
  setBounds(minX: number, minY: number, maxX: number, maxY: number): void {
    this.minX = minX;
    this.minY = minY;
    this.maxX = maxX;
    this.maxY = maxY;
    this.reclamp();
  }

  /**
   * Jump straight to framing `target`: value = target, velocities 0, prev = cur, snapTick = tick.
   * While an override is set, snaps to the override point instead.
   */
  snapTo(target: CameraTarget, tick: number): void {
    this.focusX = target.x;
    this.focusY = target.y;
    this.groundRef = target.y;
    this.lastGroundedY = target.y;
    this.lookDir = 0;
    this.candidateDir = 0;
    this.candidateTicks = 0;
    this.slowTicks = 0;
    this.lookAhead.value = 0;
    this.lookAhead.velocity = 0;
    this.sx.value = this.clampX(this.overridden ? this.overrideX : this.focusX);
    this.sy.value = this.clampY(this.overridden ? this.overrideY : this.focusY + this.tuning.targetOffsetY);
    this.sx.velocity = 0;
    this.sy.velocity = 0;
    this.x = this.prevX = this.sx.value;
    this.y = this.prevY = this.sy.value;
    this.prevZoom = this.zoom;
    this.snapTick = tick;
  }

  /** Follow an explicit point (bench flythrough) instead of the target until clearOverride(). */
  setOverride(x: number, y: number): void {
    this.overridden = true;
    this.overrideX = x;
    this.overrideY = y;
  }

  clearOverride(): void {
    this.overridden = false;
  }

  step(target: CameraTarget, dt: number): void {
    const t = this.tuning;
    this.prevX = this.x;
    this.prevY = this.y;
    this.prevZoom = this.zoom;

    this.follow(target);
    let tx: number;
    let ty: number;
    if (this.overridden) {
      tx = this.overrideX;
      ty = this.overrideY;
    } else {
      this.updateLookAhead(target.vx);
      smoothDamp(this.lookAhead, this.lookDir * t.lookAheadX, t.lookAheadSmoothTime, dt);
      const drop = target.y - this.lastGroundedY;
      const lookDown = target.vy >= t.lookDownFallSpeed && drop >= t.lookDownMinDrop ? t.lookDownMax : 0;
      tx = this.focusX + this.lookAhead.value;
      ty = this.focusY + t.targetOffsetY + lookDown;
    }
    this.x = smoothDamp(this.sx, this.clampX(tx), t.smoothTimeX, dt);
    this.y = smoothDamp(this.sy, this.clampY(ty), t.smoothTimeY, dt);
  }

  /** Dead-zone followers for x and the landing-based ground reference for y. */
  private follow(target: CameraTarget): void {
    const t = this.tuning;
    const halfW = t.deadZoneW / 2;
    if (target.x > this.focusX + halfW) this.focusX = target.x - halfW;
    else if (target.x < this.focusX - halfW) this.focusX = target.x + halfW;

    if (target.grounded) this.lastGroundedY = target.y;
    if (target.mode === 'ground' || target.mode === 'wallSlide') this.groundRef = target.y;
    else if (target.y > this.groundRef) this.groundRef = target.y;
    else if (target.y < this.groundRef - t.airRiseMargin) this.groundRef = target.y + t.airRiseMargin;

    const halfH = t.deadZoneH / 2;
    if (this.groundRef > this.focusY + halfH) this.focusY = this.groundRef - halfH;
    else if (this.groundRef < this.focusY - halfH) this.focusY = this.groundRef + halfH;
  }

  /** Flip only after lookAheadCommitTicks of fast motion one way; release after lookAheadHoldTicks slow. */
  private updateLookAhead(vx: number): void {
    const t = this.tuning;
    if (Math.abs(vx) > t.lookAheadMinSpeed) {
      const dir: -1 | 1 = vx > 0 ? 1 : -1;
      this.slowTicks = 0;
      if (dir === this.lookDir) {
        this.candidateDir = 0;
        this.candidateTicks = 0;
        return;
      }
      if (dir === this.candidateDir) this.candidateTicks++;
      else {
        this.candidateDir = dir;
        this.candidateTicks = 1;
      }
      if (this.candidateTicks >= t.lookAheadCommitTicks) {
        this.lookDir = dir;
        this.candidateDir = 0;
        this.candidateTicks = 0;
      }
      return;
    }
    this.candidateDir = 0;
    this.candidateTicks = 0;
    if (this.slowTicks < t.lookAheadHoldTicks) this.slowTicks++;
    if (this.slowTicks >= t.lookAheadHoldTicks) this.lookDir = 0;
  }

  /**
   * Keep the current view inside the bounds after a resize: an unstepped world (title screen, pause)
   * would otherwise show outside the level, where static layer geometry does not reach.
   */
  private reclamp(): void {
    this.x = this.sx.value = this.clampX(this.x);
    this.y = this.sy.value = this.clampY(this.y);
    this.prevX = this.clampX(this.prevX);
    this.prevY = this.clampY(this.prevY);
  }

  private clampX(v: number): number {
    return clampAxis(v, this.minX, this.maxX, this.viewW / (2 * this.zoom));
  }

  private clampY(v: number): number {
    return clampAxis(v, this.minY, this.maxY, this.viewH / (2 * this.zoom));
  }
}

/** Keep a view of half-size `half` centred at v inside [min, max]; centre when the range is smaller. */
function clampAxis(v: number, min: number, max: number, half: number): number {
  if (max - min <= 2 * half) return (min + max) / 2;
  if (v < min + half) return min + half;
  if (v > max - half) return max - half;
  return v;
}
