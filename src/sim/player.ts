import { SIM_DT } from '../config.ts';
import type { Bounds, Facing } from '../contracts/common.ts';
import type { InputFrame } from '../contracts/input.ts';
import { TileKind } from '../contracts/level.ts';
import { SimEventType, type DeathCause, type PlayerMode, type PlayerView } from '../contracts/sim.ts';
import type { SimEventQueue } from '../core/events.ts';
import { approach, sign } from '../core/math.ts';
import type { CollisionGrid } from '../level/grid.ts';
import { createSweepResult, groundKindUnder, isTouchingWall, overlapsSolid, sweepX, sweepY } from './physics.ts';
import { DEFAULT_TUNING, deriveTuning, type DerivedTuning, type PlayerTuning } from './tuning.ts';

const DT = SIM_DT;

/** DashEnd `b` payloads. */
const DASH_END_TIMEOUT = 0;
const DASH_END_JUMP = 1;
const DASH_END_WALL = 2;

/** WallSlideEnd `b` payloads. */
const SLIDE_END_RELEASED = 0;
const SLIDE_END_LANDED = 1;
const SLIDE_END_WALL_JUMP = 2;
const SLIDE_END_WALL_ENDED = 3;

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

  private readonly grid: CollisionGrid;
  private readonly sweep = createSweepResult();
  private events: SimEventQueue | null = null;
  private tick = 0;

  private coyote = 0;
  private jumpBuffer = 0;
  private wallStick = 0;
  private wallCoyote = 0;
  private dashCooldown = 0;
  private dropThrough = 0;
  /** Counts down from wallJumpLockTicks after a wall jump; horizontal rates scale by (lock − this)/lock. */
  private wallJumpLock = 0;

  private dashing = false;
  /** k of the current dash tick (1 on the start tick). */
  private dashTick = 0;

  /** What the feet stood on at the end of the last tick (Empty = airborne). */
  private groundKind: TileKind = TileKind.Empty;
  /** Wall within wallJumpProbe at the end of the last tick (0 = none or grounded). */
  private wallProbeDir: -1 | 0 | 1 = 0;
  private sliding = false;
  private slideDir: -1 | 1 = 1;
  private lastWallDir: -1 | 1 = 1;
  private lastWallFaceX = 0;

  private inJumpArc = false;
  private jumpCuttable = false;
  /** Highest point (min y) of the current airborne arc. */
  private arcTopY = 0;
  /** vy at the moment of this tick's landing (the Land impact speed). */
  private landingSpeed = 0;

  constructor(grid: CollisionGrid, tuning: PlayerTuning = DEFAULT_TUNING) {
    this.grid = grid;
    this.tuning = tuning;
    this.derived = deriveTuning(tuning);
    this.width = tuning.width;
    this.height = tuning.height;
  }

  /** Spawn at a feet position: alive, visible, zero velocity, abilities restored, prev = cur, warpTick = tick. */
  reset(x: number, y: number, tick: number): void {
    const t = this.tuning;
    this.x = this.prevX = x;
    this.y = this.prevY = y;
    this.vx = 0;
    this.vy = 0;
    this.alive = true;
    this.deadTicks = -1;
    this.visible = true;
    this.warpTick = tick;
    this.tick = tick;
    this.airJumpsLeft = t.airJumps;
    this.airDashesLeft = t.airDashes;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.wallStick = 0;
    this.wallCoyote = 0;
    this.dashCooldown = 0;
    this.dropThrough = 0;
    this.wallJumpLock = 0;
    this.dashing = false;
    this.dashTick = 0;
    this.dashProgress = 0;
    this.dashDir = 0;
    this.sliding = false;
    this.inJumpArc = false;
    this.jumpCuttable = false;
    this.inputX = 0;
    this.airTicks = 0;
    this.runDistance = 0;
    this.arcTopY = y;
    this.groundKind = groundKindUnder(this.grid, this, true);
    this.grounded = this.groundKind !== TileKind.Empty;
    this.wallDir = this.flushWall();
    this.wallProbeDir = this.grounded ? 0 : this.probeWall(this.wallDir);
    this.mode = this.grounded ? 'ground' : 'air';
    this.modeTicks = 0;
  }

  step(input: InputFrame, tick: number, events: SimEventQueue): void {
    this.events = events;
    this.tick = tick;
    this.prevX = this.x;
    this.prevY = this.y;
    if (!this.alive) {
      this.deadTicks++;
      this.modeTicks++;
      return;
    }
    const t = this.tuning;
    const d = this.derived;
    const wasGrounded = this.groundKind !== TileKind.Empty;

    // 2. Timers.
    if (this.coyote > 0) this.coyote--;
    if (this.jumpBuffer > 0) this.jumpBuffer--;
    if (this.wallStick > 0) this.wallStick--;
    if (this.wallCoyote > 0) this.wallCoyote--;
    if (this.dashCooldown > 0) this.dashCooldown--;
    if (this.dropThrough > 0) this.dropThrough--;
    if (this.wallJumpLock > 0) this.wallJumpLock--;
    if (wasGrounded) this.coyote = t.coyoteTicks;
    if (this.dashing && this.dashTick >= t.dashTicks) this.endDash(DASH_END_TIMEOUT);

    // 3. Input.
    const moveX = input.moveX;
    const moveY = input.moveY;
    const jumpHeld = input.jumpHeld || input.jumpPressed;
    const holdDir = Math.abs(moveX) >= t.dirThreshold ? sign(moveX) : 0;
    const holdingDown = moveY >= t.downThreshold;
    if (input.jumpPressed) this.jumpBuffer = t.jumpBufferTicks;
    this.inputX = moveX;
    if (holdDir !== 0 && !this.dashing && !this.sliding && this.wallJumpLock === 0) this.facing = holdDir;

    // 4–5. Jump resolution, then dash start (a same-tick jump stays buffered and cancels the dash next tick).
    const dashStarts = input.dashPressed && !this.dashing && this.dashCooldown === 0
      && (wasGrounded || this.airDashesLeft > 0);
    if (this.jumpBuffer > 0 && !dashStarts) this.resolveJump(holdingDown);
    if (dashStarts) this.startDash(holdDir);

    let airborne = this.groundKind === TileKind.Empty;
    let vxEnd: number;
    let vyEnd: number;
    let dx: number;
    let dy: number;
    if (this.dashing) {
      // 6–8 while dashing: exact dashSpeed·dt per tick, no gravity.
      this.vy = 0;
      vxEnd = this.vx;
      vyEnd = 0;
      dx = this.dashDir * t.dashSpeed * DT;
      dy = 0;
      this.dashTick++;
      this.dashProgress = this.dashTick / t.dashTicks;
    } else {
      // 6. Horizontal velocity.
      let mx = moveX;
      if (this.wallStick > 0 && this.wallDir !== 0 && mx * this.wallDir < 0) mx = 0;
      const target = mx * t.maxRunSpeed;
      const vx = this.vx;
      let rate: number;
      if (mx === 0) rate = airborne ? t.airDecel : t.groundDecel;
      else if (vx !== 0 && sign(mx) !== sign(vx)) rate = airborne ? t.airTurnAccel : t.turnAccel;
      else rate = airborne ? t.airAccel : t.groundAccel;
      if (Math.abs(vx) > Math.abs(mx) * t.maxRunSpeed && (mx === 0 || sign(mx) === sign(vx))) {
        rate = airborne ? t.airDecel : t.groundDecel;
      }
      if (this.wallJumpLock > 0) rate *= (t.wallJumpLockTicks - this.wallJumpLock) / t.wallJumpLockTicks;
      vxEnd = approach(vx, target, rate * DT);

      // 7. Gravity (multiplier from vy after impulses; jump release ignored during the wall-jump lock).
      const held = jumpHeld || this.wallJumpLock > 0;
      const vy = this.vy;
      let mult = 1;
      if (vy < 0 && !held && this.jumpCuttable) mult = t.jumpCutGravityMult;
      else if (Math.abs(vy) < t.apexThreshold && held && this.inJumpArc) mult = t.apexGravityMult;
      else if (vy > 0) mult = t.fallGravityMult;

      // 8. Trapezoid integration.
      let cap = holdingDown ? t.fastFallSpeed : t.maxFallSpeed;
      if (this.sliding) {
        cap = Math.min(cap, t.wallSlideMaxSpeed);
        if (this.vy > cap) this.vy = cap;
      }
      vyEnd = Math.min(this.vy + d.gravity * mult * DT, cap);
      dx = (vx + vxEnd) * 0.5 * DT;
      dy = (this.vy + vyEnd) * 0.5 * DT;
    }

    // 9. Move: X (ledge assist), then Y (corner correction, one-ways landable iff not dropping).
    const s = this.sweep;
    if (dx !== 0) {
      sweepX(this.grid, this, dx, s);
      if (s.hit) {
        const remaining = dx - s.moved;
        const assisted = (this.dashing || (airborne && vyEnd >= 0)) && this.ledgeAssist(remaining);
        if (assisted) {
          if (vyEnd > 0) vyEnd = 0;
          if (dy > 0) dy = 0;
        }
        if (!assisted || s.hit) {
          vxEnd = 0;
          if (this.dashing) {
            this.vx = 0;
            this.endDash(DASH_END_WALL);
          }
        }
      }
    }
    this.landingSpeed = vyEnd;
    if (dy !== 0) {
      sweepY(this.grid, this, dy, this.dropThrough === 0, s);
      if (s.hit) {
        if (dy < 0) {
          if (this.dashing || !this.cornerCorrect(dy - s.moved, vxEnd)) vyEnd = 0;
        } else {
          this.landingSpeed = vyEnd;
          vyEnd = 0;
        }
      }
    }
    this.vx = vxEnd;
    this.vy = vyEnd;

    // 10. Contacts.
    this.updateContacts(holdDir, wasGrounded);
    airborne = !this.grounded;
    if (!airborne) this.runDistance += Math.abs(this.x - this.prevX);
    this.airTicks = airborne ? this.airTicks + 1 : 0;
  }

  /** Enter 'dead' mode (stops moving; deadTicks = 0). Emitting Died and hiding are GameWorld's job. */
  kill(cause: DeathCause): void {
    void cause;
    if (!this.alive) return;
    this.alive = false;
    this.deadTicks = 0;
    this.vx = 0;
    this.vy = 0;
    this.dashing = false;
    this.dashProgress = 0;
    this.sliding = false;
    this.jumpBuffer = 0;
    this.setMode('dead');
  }

  /** Enemy stomp: vy = −velocity (cuttable like a jump), restores air jump and dash, ends dash/wall slide. */
  bounce(velocity: number): void {
    if (!this.alive) return;
    if (this.dashing) this.endDash(DASH_END_JUMP);
    if (this.sliding) this.endSlide(SLIDE_END_RELEASED);
    this.vy = -velocity;
    this.inJumpArc = true;
    this.jumpCuttable = true;
    this.airJumpsLeft = this.tuning.airJumps;
    this.airDashesLeft = this.tuning.airDashes;
    this.groundKind = TileKind.Empty;
    this.grounded = false;
    this.coyote = 0;
    this.arcTopY = this.y;
    this.setMode('air');
  }

  getBounds(out: Bounds): Bounds {
    out.minX = this.x - this.width / 2;
    out.maxX = this.x + this.width / 2;
    out.minY = this.y - this.height;
    out.maxY = this.y;
    return out;
  }

  /** §5.1 step 4: the first legal option of drop-through, ground, wall and air jump fires. */
  private resolveJump(holdingDown: boolean): void {
    const t = this.tuning;
    if (this.groundKind === TileKind.OneWay && holdingDown) {
      this.jumpBuffer = 0;
      this.dropThrough = t.dropThroughTicks;
      this.y += 1;
      this.groundKind = TileKind.Empty;
      this.coyote = 0;
      this.inJumpArc = false;
      this.jumpCuttable = false;
      this.emit(SimEventType.DropThrough, this.x, this.y);
      return;
    }
    if (this.groundKind !== TileKind.Empty || this.coyote > 0) {
      const cancelled = this.dashing;
      if (cancelled) this.endDash(DASH_END_JUMP);
      this.launch(-this.derived.jumpVelocity);
      this.coyote = 0;
      this.emit(SimEventType.Jump, this.x, this.y, this.facing, cancelled ? 1 : 0);
      return;
    }
    const wall = this.wallProbeDir !== 0 ? this.wallProbeDir : this.wallCoyote > 0 ? this.lastWallDir : 0;
    if (wall !== 0) {
      if (this.dashing) this.endDash(DASH_END_JUMP);
      const faceX = this.wallProbeDir !== 0 ? this.wallFaceX(wall) : this.lastWallFaceX;
      if (this.sliding) this.endSlide(SLIDE_END_WALL_JUMP);
      this.launch(-this.derived.wallJumpVelocity);
      this.vx = -wall * t.wallJumpVx;
      this.facing = wall > 0 ? -1 : 1;
      this.wallJumpLock = t.wallJumpLockTicks;
      this.wallCoyote = 0;
      this.wallStick = 0;
      this.airJumpsLeft = t.airJumps;
      this.airDashesLeft = t.airDashes;
      this.emit(SimEventType.WallJump, faceX, this.y, -wall);
      return;
    }
    if (this.airJumpsLeft > 0 && this.vy >= -this.derived.airJumpVelocity) {
      if (this.dashing) this.endDash(DASH_END_JUMP);
      this.airJumpsLeft--;
      this.launch(-this.derived.airJumpVelocity);
      this.emit(SimEventType.AirJump, this.x, this.y, this.facing, this.airJumpsLeft);
    }
  }

  /** Common part of every jump impulse. */
  private launch(vy: number): void {
    this.vy = vy;
    this.jumpBuffer = 0;
    this.groundKind = TileKind.Empty;
    this.inJumpArc = true;
    this.jumpCuttable = true;
  }

  private startDash(holdDir: -1 | 0 | 1): void {
    const t = this.tuning;
    const dir: -1 | 1 = holdDir !== 0 ? holdDir : this.sliding ? (this.slideDir > 0 ? -1 : 1) : this.facing;
    const airborne = this.groundKind === TileKind.Empty;
    if (airborne) this.airDashesLeft--;
    if (this.sliding) this.endSlide(SLIDE_END_RELEASED);
    this.dashing = true;
    this.dashTick = 0;
    this.dashDir = dir;
    this.dashCooldown = t.dashCooldownTicks;
    this.wallStick = 0;
    this.wallJumpLock = 0;
    this.facing = dir;
    this.vx = dir * t.dashSpeed;
    this.vy = 0;
    this.emit(SimEventType.Dash, this.x, this.y, dir, airborne ? 1 : 0);
  }

  private endDash(reason: number): void {
    this.dashing = false;
    this.dashProgress = 0;
    if (reason === DASH_END_TIMEOUT) this.vx = this.dashDir * this.tuning.dashEndSpeed;
    this.emit(SimEventType.DashEnd, this.x, this.y, this.dashDir, reason);
  }

  /** Pop up onto a ledge whose top is within ledgeAssist u above the feet, then finish the X move. */
  private ledgeAssist(remaining: number): boolean {
    const dir = remaining > 0 ? 1 : -1;
    const max = this.tuning.ledgeAssist;
    for (let k = 1; k <= max; k++) {
      if (overlapsSolid(this.grid, this, 0, -k) || overlapsSolid(this.grid, this, dir, -k)) continue;
      this.y -= k;
      sweepX(this.grid, this, remaining, this.sweep);
      return true;
    }
    return false;
  }

  /** Nudge a rising head past a ceiling corner (≤ cornerCorrection u), redo the rest of the Y move. */
  private cornerCorrect(remaining: number, vx: number): boolean {
    const max = this.tuning.cornerCorrection;
    const first = vx !== 0 ? sign(vx) : this.freerSide();
    for (let pass = 0; pass < 2; pass++) {
      const s = pass === 0 ? first : -first;
      for (let n = 1; n <= max; n++) {
        const ox = s * n;
        if (overlapsSolid(this.grid, this, ox, 0) || overlapsSolid(this.grid, this, ox, remaining)) continue;
        this.x += ox;
        sweepY(this.grid, this, remaining, false, this.sweep);
        return true;
      }
    }
    return false;
  }

  /** With vx = 0: the side whose nudge clears the ceiling tile above the head with less overlap. */
  private freerSide(): -1 | 1 {
    const ts = this.grid.tileSize;
    const half = this.width / 2;
    const row = Math.floor((this.y - this.height) / ts) - 1;
    const left = this.x - half;
    const right = this.x + half;
    // Overlap of the head with the blocking tile nearest each edge.
    const lt = Math.floor(left / ts);
    const rt = Math.ceil(right / ts) - 1;
    const leftBlocked = this.grid.isSolid(lt, row);
    const rightBlocked = this.grid.isSolid(rt, row);
    if (leftBlocked && !rightBlocked) return 1;
    if (rightBlocked && !leftBlocked) return -1;
    const overlapLeft = (lt + 1) * ts - left;
    const overlapRight = right - rt * ts;
    return overlapLeft <= overlapRight ? 1 : -1;
  }

  private updateContacts(holdDir: -1 | 0 | 1, wasGrounded: boolean): void {
    const t = this.tuning;
    const moveX = this.inputX;
    const ts = this.grid.tileSize;

    let ground: TileKind = TileKind.Empty;
    if (this.vy >= 0) ground = groundKindUnder(this.grid, this, this.dropThrough === 0);
    if (ground !== TileKind.Empty) {
      const top = Math.ceil(this.y / ts) * ts;
      if (top - this.y < 1) this.y = top;
      this.vy = 0;
    }
    this.groundKind = ground;
    this.grounded = ground !== TileKind.Empty;

    const flush = this.flushWall();
    this.wallDir = flush;
    this.wallProbeDir = this.grounded ? 0 : this.probeWall(flush);

    if (this.grounded) {
      // Also when a jump bonked on a flush ceiling and never left the ground (no Land): the arc is over.
      this.inJumpArc = false;
      this.jumpCuttable = false;
    }
    if (this.grounded && !wasGrounded) {
      if (this.sliding) this.endSlide(SLIDE_END_LANDED);
      this.airJumpsLeft = t.airJumps;
      this.airDashesLeft = t.airDashes;
      this.emit(SimEventType.Land, this.x, this.y, this.landingSpeed, Math.max(0, this.y - this.arcTopY));
    }
    if (this.grounded) this.arcTopY = this.y;
    else if (this.y < this.arcTopY) this.arcTopY = this.y;

    let slide = false;
    if (!this.grounded && !this.dashing && this.vy > 0 && flush !== 0) {
      if (moveX * flush >= t.dirThreshold) this.wallStick = t.wallStickTicks;
      slide = moveX * flush >= t.dirThreshold || this.wallStick > 0;
    }
    if (this.sliding && !slide) {
      this.endSlide(this.grounded ? SLIDE_END_LANDED : flush === 0 ? SLIDE_END_WALL_ENDED : SLIDE_END_RELEASED);
    } else if (slide && this.sliding && flush !== this.slideDir) {
      this.endSlide(SLIDE_END_WALL_ENDED);
    }
    if (slide) {
      const faceX = this.wallFaceX(flush as -1 | 1);
      if (!this.sliding) {
        this.sliding = true;
        this.slideDir = flush as -1 | 1;
        this.airJumpsLeft = t.airJumps;
        this.airDashesLeft = t.airDashes;
        this.emit(SimEventType.WallSlideStart, faceX, this.y, flush);
      }
      this.wallCoyote = t.wallCoyoteTicks;
      this.lastWallDir = this.slideDir;
      this.lastWallFaceX = faceX;
      // The cap holds from the entry tick, so a view never sees a wallSlide faster than the cap.
      if (this.vy > t.wallSlideMaxSpeed) this.vy = t.wallSlideMaxSpeed;
    } else {
      this.wallStick = 0;
    }

    if (this.dashing) this.facing = this.dashDir as Facing;
    else if (this.sliding) this.facing = this.slideDir > 0 ? -1 : 1;
    else if (holdDir !== 0 && this.wallJumpLock === 0) this.facing = holdDir;

    this.setMode(this.dashing ? 'dash' : this.grounded ? 'ground' : this.sliding ? 'wallSlide' : 'air');
  }

  private endSlide(reason: number): void {
    this.sliding = false;
    this.emit(SimEventType.WallSlideEnd, this.wallFaceX(this.slideDir), this.y, this.slideDir, reason);
  }

  private setMode(mode: PlayerMode): void {
    if (mode === this.mode) {
      this.modeTicks++;
      return;
    }
    this.mode = mode;
    this.modeTicks = 0;
  }

  /** Side with a Solid tile flush against the body (1 u probe), 0 if none. */
  private flushWall(): -1 | 0 | 1 {
    const right = isTouchingWall(this.grid, this, 1, 1);
    const left = isTouchingWall(this.grid, this, -1, 1);
    if (right && left) return this.facing;
    return right ? 1 : left ? -1 : 0;
  }

  /** Wall side within wallJumpProbe, preferring the flush side. */
  private probeWall(flush: -1 | 0 | 1): -1 | 0 | 1 {
    if (flush !== 0) return flush;
    const probe = this.tuning.wallJumpProbe;
    if (isTouchingWall(this.grid, this, 1, probe)) return 1;
    if (isTouchingWall(this.grid, this, -1, probe)) return -1;
    return 0;
  }

  /** x of the wall face on side `dir` (the nearest tile boundary beyond that edge). */
  private wallFaceX(dir: -1 | 1): number {
    const ts = this.grid.tileSize;
    const half = this.width / 2;
    return dir > 0 ? Math.ceil((this.x + half) / ts) * ts : Math.floor((this.x - half) / ts) * ts;
  }

  private emit(type: SimEventType, x: number, y: number, a = 0, b = 0): void {
    this.events?.push(type, this.tick, x, y, a, b);
  }
}
