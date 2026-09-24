export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function invLerp(a: number, b: number, v: number): number {
  return a === b ? 0 : (v - a) / (b - a);
}

export function remap(v: number, a0: number, a1: number, b0: number, b1: number): number {
  return lerp(b0, b1, invLerp(a0, a1, v));
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** Move `v` toward `target` by at most `maxDelta`. */
export function approach(v: number, target: number, maxDelta: number): number {
  if (v < target) return v + maxDelta < target ? v + maxDelta : target;
  return v - maxDelta > target ? v - maxDelta : target;
}

/** Framerate-independent exponential decay toward `target`; `lambda` is the rate (1/s). */
export function damp(v: number, target: number, lambda: number, dt: number): number {
  return lerp(v, target, 1 - Math.exp(-lambda * dt));
}

export function sign(v: number): -1 | 0 | 1 {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Euclidean modulo (always >= 0 for positive m). */
export function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

export function wrapAngle(a: number): number {
  return mod(a + Math.PI, TAU) - Math.PI;
}

export interface SmoothDampState {
  value: number;
  velocity: number;
}

/**
 * Critically damped spring toward `target` (Game Programming Gems 4, 1.10). Mutates `s` in place.
 * `smoothTime` ≈ time to reach the target; `maxSpeed` caps the change rate (Infinity for none).
 */
export function smoothDamp(s: SmoothDampState, target: number, smoothTime: number, dt: number, maxSpeed = Infinity): number {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const maxChange = maxSpeed * st;
  const change = clamp(s.value - target, -maxChange, maxChange);
  const clampedTarget = s.value - change;
  const temp = (s.velocity + omega * change) * dt;
  s.velocity = (s.velocity - omega * temp) * exp;
  let out = clampedTarget + (change + temp) * exp;
  if (target - s.value > 0 === out > target) {
    out = target;
    s.velocity = (out - target) / dt;
  }
  s.value = out;
  return out;
}

export interface Spring1D {
  value: number;
  velocity: number;
}

/** Semi-implicit damped spring toward `target`. `stiffness` (1/s²), `damping` (1/s). Mutates in place. */
export function stepSpring(s: Spring1D, target: number, stiffness: number, damping: number, dt: number): number {
  s.velocity += ((target - s.value) * stiffness - s.velocity * damping) * dt;
  s.value += s.velocity * dt;
  return s.value;
}
