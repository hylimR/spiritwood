/**
 * 2D signed distance primitives (negative inside) and combinators, in the style of Inigo Quilez.
 * All are pure scalar functions so generators can evaluate them per texel without allocating.
 */

export function sdCircle(px: number, py: number, cx: number, cy: number, r: number): number {
  return Math.hypot(px - cx, py - cy) - r;
}

export function sdEllipse(px: number, py: number, cx: number, cy: number, rx: number, ry: number): number {
  // Cheap approximation: scaled circle distance, good enough for soft shapes.
  const dx = (px - cx) / rx;
  const dy = (py - cy) / ry;
  const k = Math.hypot(dx, dy);
  return (k - 1) * Math.min(rx, ry);
}

export function sdBox(px: number, py: number, cx: number, cy: number, hw: number, hh: number): number {
  const dx = Math.abs(px - cx) - hw;
  const dy = Math.abs(py - cy) - hh;
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0);
}

export function sdRoundBox(px: number, py: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  return sdBox(px, py, cx, cy, hw - r, hh - r) - r;
}

/** Segment a→b with radius r (capsule). */
export function sdCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, r: number): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/** Segment a→b whose radius tapers from ra (at a) to rb (at b). */
export function sdTaperedCapsule(
  px: number, py: number, ax: number, ay: number, bx: number, by: number, ra: number, rb: number,
): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  return Math.hypot(pax - bax * h, pay - bay * h) - (ra + (rb - ra) * h);
}

/** Quadratic-Bezier-ish curve approximated by `segments` tapered capsules. */
export function sdCurve(
  px: number, py: number,
  ax: number, ay: number, cx: number, cy: number, bx: number, by: number,
  ra: number, rb: number, segments = 6,
): number {
  let d = Infinity;
  let x0 = ax;
  let y0 = ay;
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const it = 1 - t;
    const x1 = it * it * ax + 2 * it * t * cx + t * t * bx;
    const y1 = it * it * ay + 2 * it * t * cy + t * t * by;
    const t0 = (i - 1) / segments;
    const r0 = ra + (rb - ra) * t0;
    const r1 = ra + (rb - ra) * t;
    const s = sdTaperedCapsule(px, py, x0, y0, x1, y1, r0, r1);
    if (s < d) d = s;
    x0 = x1;
    y0 = y1;
  }
  return d;
}

export function opUnion(a: number, b: number): number {
  return a < b ? a : b;
}

export function opSubtract(a: number, b: number): number {
  return Math.max(a, -b);
}

export function opIntersect(a: number, b: number): number {
  return a > b ? a : b;
}

/** Polynomial smooth minimum (blend radius k). */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Coverage (0..1) from a signed distance with an AA/softness width in the same units. */
export function coverage(d: number, softness: number): number {
  const t = 0.5 - d / Math.max(1e-6, softness);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}
