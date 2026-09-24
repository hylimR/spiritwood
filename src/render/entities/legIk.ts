/** Pure helpers for the Gloomcrawler's procedural legs. */

export interface Point {
  x: number;
  y: number;
}

/**
 * Two-bone IK: knee position for a hip at (hx, hy) reaching (fx, fy) with segment lengths l1, l2.
 * `bend` (±1) picks the side the knee bends to (−1 = counter-clockwise of the hip→foot line, which is
 * "up" for a leg reaching right in y-down space). Unreachable targets straighten the leg toward them.
 */
export function solveTwoBone(hx: number, hy: number, fx: number, fy: number, l1: number, l2: number, bend: number, out: Point): Point {
  const dx = fx - hx;
  const dy = fy - hy;
  const dist = Math.hypot(dx, dy);
  const base = Math.atan2(dy, dx);
  const d = Math.min(l1 + l2 - 1e-6, Math.max(Math.abs(l1 - l2) + 1e-6, dist));
  const cos = (l1 * l1 + d * d - l2 * l2) / (2 * l1 * d);
  const a = Math.acos(Math.max(-1, Math.min(1, cos)));
  const ang = base + bend * a;
  out.x = hx + Math.cos(ang) * l1;
  out.y = hy + Math.sin(ang) * l1;
  return out;
}

/**
 * Foot position of a walking leg at gait `phase` (radians, one cycle per 2π of body travel / stride).
 * Stance (first half): on the ground, moving linearly from +reach to −reach relative to the hip, so
 * with reach = stride / 4 the foot is stationary in the world. Swing (second half): lifted by up to
 * `lift` and eased forward back to +reach.
 */
export function gaitFoot(phase: number, hipX: number, groundY: number, reach: number, lift: number, out: Point): Point {
  const c = phase / (Math.PI * 2);
  const t = c - Math.floor(c);
  if (t < 0.5) {
    out.x = hipX + reach * (1 - 4 * t);
    out.y = groundY;
  } else {
    const u = (t - 0.5) * 2;
    out.x = hipX - reach + 2 * reach * u * u * (3 - 2 * u);
    out.y = groundY - lift * Math.sin(Math.PI * u);
  }
  return out;
}
