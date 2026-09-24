import { stepSpring, type Spring1D } from '../../core/math.ts';

/**
 * Procedural secondary motion for the hero (render-only, allocation-free): the squash & stretch
 * spring, the sprout's inertial spring and the verlet scarf ribbon.
 */

export const SQUASH = Object.freeze({
  stiffness: 420,
  damping: 17,
  /** Log-scale limits: sy = e^s, sx = e^−s, so sx·sy = 1 always (volume preserving). */
  min: -0.42,
  max: 0.34,
  substep: 1 / 240,
  jump: 0.2,
  airJump: 0.17,
  wallJump: 0.15,
  stompBounce: 0.18,
  /** Held while dashing (negative = wide and short). */
  dash: -0.2,
  /** Land squash = −(landBase + landScale · (impact / landRef)^landPow), capped at `min`. */
  landBase: 0.04,
  landScale: 0.3,
  landRef: 1020,
  landPow: 1.15,
  /** Impacts slower than this don't squash. */
  landMinSpeed: 120,
});

/** Squash (negative) for a landing at `impactSpeed` u/s. */
export function landSquash(impactSpeed: number): number {
  if (impactSpeed < SQUASH.landMinSpeed) return 0;
  const k = SQUASH.landBase + SQUASH.landScale * Math.pow(impactSpeed / SQUASH.landRef, SQUASH.landPow);
  return -Math.min(-SQUASH.min, k);
}

/**
 * Volume-preserving squash & stretch around the feet: `s` is the log vertical stretch, a damped spring
 * toward `target` (0 at rest). `kick` sets an immediate deformation that springs back with a little
 * overshoot.
 */
export class SquashStretch implements Spring1D {
  value = 0;
  velocity = 0;

  kick(amount: number): void {
    this.value = Math.max(SQUASH.min, Math.min(SQUASH.max, amount));
    this.velocity = 0;
  }

  update(dt: number, target = 0): void {
    let t = dt;
    while (t > 1e-6) {
      const h = Math.min(SQUASH.substep, t);
      stepSpring(this, target, SQUASH.stiffness, SQUASH.damping, h);
      t -= h;
    }
    if (this.value < SQUASH.min) this.value = SQUASH.min;
    else if (this.value > SQUASH.max) this.value = SQUASH.max;
  }

  get scaleX(): number {
    return Math.exp(-this.value);
  }

  get scaleY(): number {
    return Math.exp(this.value);
  }

  reset(): void {
    this.value = 0;
    this.velocity = 0;
  }
}

/** A damped angular spring driven by an external torque (the sprout lagging behind head motion). */
export class InertialSpring implements Spring1D {
  value = 0;
  velocity = 0;

  readonly stiffness: number;
  readonly damping: number;
  readonly limit: number;

  constructor(stiffness: number, damping: number, limit: number) {
    this.stiffness = stiffness;
    this.damping = damping;
    this.limit = limit;
  }

  /** `drive` is the target angle this frame (e.g. −acceleration · gain). */
  update(dt: number, drive: number): void {
    let t = dt;
    while (t > 1e-6) {
      const h = Math.min(1 / 240, t);
      stepSpring(this, drive, this.stiffness, this.damping, h);
      t -= h;
    }
    if (this.value > this.limit) {
      this.value = this.limit;
      this.velocity = Math.min(0, this.velocity);
    } else if (this.value < -this.limit) {
      this.value = -this.limit;
      this.velocity = Math.max(0, this.velocity);
    }
  }

  reset(): void {
    this.value = 0;
    this.velocity = 0;
  }
}

export const RIBBON = Object.freeze({
  points: 8,
  segment: 5.2,
  /** Fixed substep for the verlet integration. */
  substep: 1 / 120,
  maxSubsteps: 8,
  gravity: 150,
  /** Velocity damping per second (fraction of velocity lost ≈ 1 − e^−drag·t). */
  drag: 2.6,
  /** Pull toward the rest trail (per second²), weak so motion dominates. */
  restPull: 26,
  /** Bending passes per substep. */
  iterations: 4,
  /** Bending stiffness per iteration (0 = a limp chain). */
  bend: 0.06,
  /**
   * Follow-the-leader velocity correction (Müller et al. 2012): how much of the next point's length
   * correction is fed back into each point's velocity. Keeps sudden anchor jumps (dash starts) from
   * leaving the chain stretched and then zig-zagging.
   */
  ftlDamping: 0.9,
  flutter: 22,
});

/**
 * Verlet ribbon (the scarf of light): point 0 is pinned to the anchor; the rest integrate with light
 * gravity, drag, a weak pull toward a floating rest trail behind the hero and a travelling flutter,
 * then a light bending pass and an exact follow-the-leader length pass (inextensible in one sweep, so
 * a fast-moving anchor drags the scarf smoothly instead of kinking it). World space.
 */
export class Ribbon {
  readonly count: number;
  readonly segment: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  private readonly px: Float32Array;
  private readonly py: Float32Array;
  /** Per-point length corrections of the last follow-the-leader pass. */
  private readonly cx: Float32Array;
  private readonly cy: Float32Array;
  private anchorX = 0;
  private anchorY = 0;
  private lastH = RIBBON.substep;

  constructor(count: number = RIBBON.points, segment: number = RIBBON.segment) {
    this.count = count;
    this.segment = segment;
    this.x = new Float32Array(count);
    this.y = new Float32Array(count);
    this.px = new Float32Array(count);
    this.py = new Float32Array(count);
    this.cx = new Float32Array(count);
    this.cy = new Float32Array(count);
  }

  /** Lay the ribbon out straight from the anchor along (dirX, dirY), at rest. */
  reset(ax: number, ay: number, dirX: number, dirY: number): void {
    const len = Math.hypot(dirX, dirY) || 1;
    for (let i = 0; i < this.count; i++) {
      this.x[i] = ax + (dirX / len) * this.segment * i;
      this.y[i] = ay + (dirY / len) * this.segment * i;
      this.px[i] = this.x[i] as number;
      this.py[i] = this.y[i] as number;
    }
    this.anchorX = ax;
    this.anchorY = ay;
    this.lastH = RIBBON.substep;
  }

  /**
   * Advance by `dt`. The anchor moves linearly from its previous position to (ax, ay) across the
   * substeps; (restX, restY) is the direction the ribbon floats toward when still.
   */
  update(dt: number, ax: number, ay: number, restX: number, restY: number, time: number): void {
    if (!(dt > 0)) return;
    const steps = Math.min(RIBBON.maxSubsteps, Math.max(1, Math.ceil(dt / RIBBON.substep - 1e-6)));
    const h = dt / steps;
    const rl = Math.hypot(restX, restY) || 1;
    const rx = restX / rl;
    const ry = restY / rl;
    const keep = Math.exp(-RIBBON.drag * h);
    const n = this.count;
    const x0 = this.anchorX;
    const y0 = this.anchorY;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const axS = x0 + (ax - x0) * t;
      const ayS = y0 + (ay - y0) * t;
      this.px[0] = this.x[0] as number;
      this.py[0] = this.y[0] as number;
      this.x[0] = axS;
      this.y[0] = ayS;
      const ratio = h / this.lastH;
      const tm = time - (1 - t) * dt;
      for (let i = 1; i < n; i++) {
        const xi = this.x[i] as number;
        const yi = this.y[i] as number;
        const k = i / (n - 1);
        const tx = axS + rx * this.segment * i;
        const ty = ayS + ry * this.segment * i;
        const fx = (tx - xi) * RIBBON.restPull + Math.cos(tm * 2.3 + i * 1.1) * RIBBON.flutter * 0.6 * k;
        const fy = (ty - yi) * RIBBON.restPull + RIBBON.gravity * 0.35 + Math.sin(tm * 3.1 + i * 0.85) * RIBBON.flutter * k;
        const vx = (xi - (this.px[i] as number)) * ratio * keep;
        const vy = (yi - (this.py[i] as number)) * ratio * keep;
        this.px[i] = xi;
        this.py[i] = yi;
        this.x[i] = xi + vx + fx * h * h;
        this.y[i] = yi + vy + fy * h * h;
      }
      this.lastH = h;
      this.solve();
    }
    this.anchorX = ax;
    this.anchorY = ay;
  }

  private solve(): void {
    const seg = this.segment;
    const n = this.count;
    const x = this.x;
    const y = this.y;
    for (let it = 0; it < RIBBON.iterations; it++) {
      // Bending: pull interior points toward their neighbours' midpoint so anchor jitter can't kink it.
      for (let i = 1; i < n - 1; i++) {
        const mx = ((x[i - 1] as number) + (x[i + 1] as number)) * 0.5;
        const my = ((y[i - 1] as number) + (y[i + 1] as number)) * 0.5;
        x[i] = (x[i] as number) + (mx - (x[i] as number)) * RIBBON.bend;
        y[i] = (y[i] as number) + (my - (y[i] as number)) * RIBBON.bend;
      }
    }
    // Follow the leader: place each point exactly one segment from its (already final) parent.
    for (let i = 1; i < n; i++) {
      const dx = (x[i] as number) - (x[i - 1] as number);
      const dy = (y[i] as number) - (y[i - 1] as number);
      const d = Math.hypot(dx, dy);
      if (d < 1e-6) {
        this.cx[i] = 0;
        this.cy[i] = 0;
        continue;
      }
      const nx = (x[i - 1] as number) + (dx / d) * seg;
      const ny = (y[i - 1] as number) + (dy / d) * seg;
      this.cx[i] = nx - (x[i] as number);
      this.cy[i] = ny - (y[i] as number);
      x[i] = nx;
      y[i] = ny;
    }
    // Velocity correction: cancel the part of each correction that was only there to satisfy the child.
    for (let i = 1; i < n - 1; i++) {
      this.px[i] = (this.px[i] as number) + (this.cx[i + 1] as number) * RIBBON.ftlDamping;
      this.py[i] = (this.py[i] as number) + (this.cy[i + 1] as number) * RIBBON.ftlDamping;
    }
  }
}
