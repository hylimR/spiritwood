import { SIM_DT } from '../../src/config.ts';
import type { InputFrame } from '../../src/contracts/input.ts';
import { Ability } from '../../src/contracts/sim.ts';
import { approach, sign } from '../../src/core/math.ts';
import {
  DEFAULT_LAUNCH_TUNING, DEFAULT_TUNING, deriveTuning, type LaunchTuning, type PlayerTuning,
} from '../../src/sim/tuning.ts';
import type { GameWorld, ProjectileState, WorldOptions } from '../../src/sim/world.ts';
import { WorldRig } from './helpers.ts';

export interface FreeInput {
  moveX?: number;
  moveY?: number;
  jumpHeld?: boolean;
  jumpPressed?: boolean;
  dashPressed?: boolean;
}

/**
 * Reference free-flight integrator: the §5.1 airborne rules plus the §5.1.1 launched phase and input
 * lock, with no terrain, derived only from the tuning. It derives the expectations of the launch reach
 * tests; the tests themselves drive the real PlayerController through GameWorld.
 */
export class FreeBody {
  x = 0;
  y = 0;
  vx = 0;
  vy = 0;
  facing: 1 | -1 = 1;
  readonly t: PlayerTuning;
  readonly lt: LaunchTuning;
  private readonly g: number;
  private readonly airJumpVelocity: number;
  private inJumpArc = false;
  private jumpCuttable = false;
  private airJumpsLeft: number;
  private airDashesLeft: number;
  private jumpBuffer = 0;
  private dashCooldown = 0;
  private dashing = false;
  private dashTick = 0;
  private dashDir: 1 | -1 = 1;
  private flightLeft = 0;
  private inputLock = 0;
  private releasedNow = false;

  constructor(t: PlayerTuning = DEFAULT_TUNING, lt: LaunchTuning = DEFAULT_LAUNCH_TUNING) {
    this.t = t;
    this.lt = lt;
    const d = deriveTuning(t);
    this.g = d.gravity;
    this.airJumpVelocity = d.airJumpVelocity;
    this.airJumpsLeft = t.airJumps;
    this.airDashesLeft = t.airDashes;
  }

  /** The release (tick R, flight tick 1): velocity = aim × speed and the release's controller state. */
  release(ax: number, ay: number): void {
    const t = this.t;
    this.vx = ax * this.lt.speed;
    this.vy = ay * this.lt.speed;
    this.airJumpsLeft = t.airJumps;
    this.airDashesLeft = t.airDashes;
    this.inJumpArc = false;
    this.jumpCuttable = false;
    this.jumpBuffer = 0;
    this.dashCooldown = 0;
    this.dashing = false;
    if (Math.abs(ax) >= t.dirThreshold) this.facing = ax > 0 ? 1 : -1;
    this.flightLeft = this.lt.flightTicks;
    this.inputLock = this.lt.inputLockTicks;
    this.releasedNow = true;
  }

  step(i: FreeInput = {}): void {
    const t = this.t;
    if (!this.releasedNow && this.inputLock > 0) this.inputLock--;
    this.releasedNow = false;
    if (this.jumpBuffer > 0) this.jumpBuffer--;
    if (this.dashCooldown > 0) this.dashCooldown--;
    if (this.dashing && this.dashTick >= t.dashTicks) {
      this.dashing = false;
      this.vx = this.dashDir * t.dashEndSpeed;
    }
    const moveX = i.moveX ?? 0;
    const locked = this.inputLock > 0;
    const jumpPressed = (i.jumpPressed ?? false) && !locked;
    const dashPressed = (i.dashPressed ?? false) && !locked;
    const jumpHeld = (i.jumpHeld ?? false) || jumpPressed;
    const holdDir = Math.abs(moveX) >= t.dirThreshold ? sign(moveX) : 0;
    const holdingDown = (i.moveY ?? 0) >= t.downThreshold;
    if (jumpPressed) this.jumpBuffer = t.jumpBufferTicks;
    if (holdDir !== 0 && !this.dashing) this.facing = holdDir;
    const dashStarts = dashPressed && !this.dashing && this.dashCooldown === 0 && this.airDashesLeft > 0;
    if (this.jumpBuffer > 0 && !dashStarts && this.airJumpsLeft > 0 && this.vy >= -this.airJumpVelocity) {
      this.dashing = false;
      this.airJumpsLeft--;
      this.vy = -this.airJumpVelocity;
      this.jumpBuffer = 0;
      this.inJumpArc = true;
      this.jumpCuttable = true;
      this.flightLeft = 0;
    }
    if (dashStarts) {
      const dir: 1 | -1 = holdDir !== 0 ? holdDir : this.facing;
      this.airDashesLeft--;
      this.dashing = true;
      this.dashTick = 0;
      this.dashDir = dir;
      this.dashCooldown = t.dashCooldownTicks;
      this.facing = dir;
      this.vx = dir * t.dashSpeed;
      this.vy = 0;
      this.flightLeft = 0;
    }
    let vxEnd: number;
    let vyEnd: number;
    let dx: number;
    let dy: number;
    if (this.dashing) {
      vxEnd = this.vx;
      vyEnd = 0;
      dx = this.dashDir * t.dashSpeed * SIM_DT;
      dy = 0;
      this.dashTick++;
    } else if (this.flightLeft > 0) {
      this.flightLeft--;
      vxEnd = this.vx;
      const cap = Math.max(holdingDown ? t.fastFallSpeed : t.maxFallSpeed, this.lt.speed);
      vyEnd = Math.min(this.vy + this.g * this.lt.flightGravityMult * SIM_DT, cap);
      dx = (this.vx + vxEnd) * 0.5 * SIM_DT;
      dy = (this.vy + vyEnd) * 0.5 * SIM_DT;
    } else {
      const vx = this.vx;
      const target = moveX * t.maxRunSpeed;
      let rate: number;
      if (moveX === 0) rate = t.airDecel;
      else if (vx !== 0 && sign(moveX) !== sign(vx)) rate = t.airTurnAccel;
      else rate = t.airAccel;
      if (Math.abs(vx) > Math.abs(moveX) * t.maxRunSpeed && (moveX === 0 || sign(moveX) === sign(vx))) rate = t.airDecel;
      vxEnd = approach(vx, target, rate * SIM_DT);
      const vy = this.vy;
      let mult = 1;
      if (vy < 0 && !jumpHeld && this.jumpCuttable) mult = t.jumpCutGravityMult;
      else if (Math.abs(vy) < t.apexThreshold && jumpHeld && this.inJumpArc) mult = t.apexGravityMult;
      else if (vy > 0) mult = t.fallGravityMult;
      vyEnd = Math.min(vy + this.g * mult * SIM_DT, holdingDown ? t.fastFallSpeed : t.maxFallSpeed);
      dx = (vx + vxEnd) * 0.5 * SIM_DT;
      dy = (vy + vyEnd) * 0.5 * SIM_DT;
    }
    this.x += dx;
    this.y += dy;
    this.vx = vxEnd;
    this.vy = vyEnd;
  }
}

/** Unit aim of the 8 keyboard directions: (moveX, moveY) normalised. */
export function keyAim(mx: -1 | 0 | 1, my: -1 | 0 | 1): [number, number] {
  const len = Math.hypot(mx, my);
  return len > 0 ? [mx / len, my / len] : [0, 0];
}

/** A WorldRig with Spirit Launch unlocked. */
export function launchRig(rows: readonly string[], options: WorldOptions = {}): WorldRig {
  const rig = new WorldRig(rows, options);
  rig.world.unlock(Ability.Launch);
  return rig;
}

/**
 * A test anchor: a seed parked at (x, y) with zero velocity (fired, then reflected in place, so it
 * neither falls nor hurts the player; it expires after reflectedLifetimeTicks stepped ticks).
 */
export function anchorSeed(w: GameWorld, x: number, y: number): ProjectileState {
  const s = w.seeds.fire(x, y, 0, 0, -1, w.tick, w.events);
  if (!s) throw new Error('anchorSeed: no free slot');
  w.seeds.reflect(s.id, 0, 0, w.tick);
  return s;
}

/** Input setters for a launch press / a held aim / a release in direction (mx, my). */
export function press(mx = 0, my = 0) {
  return (f: InputFrame): void => {
    f.moveX = mx;
    f.moveY = my;
    f.launchPressed = true;
    f.launchHeld = true;
  };
}

export function aim(mx = 0, my = 0) {
  return (f: InputFrame): void => {
    f.moveX = mx;
    f.moveY = my;
    f.launchHeld = true;
  };
}

export function letGo(mx = 0, my = 0) {
  return (f: InputFrame): void => {
    f.moveX = mx;
    f.moveY = my;
    f.launchReleased = true;
  };
}
