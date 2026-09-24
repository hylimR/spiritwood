import type { Rng } from '../../core/rng.ts';
import { ElementRaster, Mat } from './raster.ts';

/**
 * Organic tree building blocks for kit elements (texel space, y down, angles in radians with −π/2 =
 * up). Everything is original: recursive branching with gravity and light-seeking, foliage built as
 * fractal clumps (lobes with tufted rims, volume-shaded from the upper-left moon), willow curtains,
 * ragged conifer tiers and broken snags.
 */

const UP = -Math.PI / 2;
const P = { x: 0, y: 0 };

export interface BranchStyle {
  mat: Mat;
  /** Child radius / parent radius. */
  taper: number;
  /** Child length / parent length range. */
  lenMin: number;
  lenMax: number;
  /** Angle between siblings (radians) and random jitter. */
  spread: number;
  jitter: number;
  /** Pull of each child toward straight up (0..1) — light-seeking. */
  rise: number;
  /** Downward sag of long limbs (texels per texel² of length / 100). */
  droop: number;
  /** Chance of three children instead of two. */
  tri: number;
  /** Stop recursing below this radius. */
  minRad: number;
  /** Smooth-union blend radius at joints (× radius). */
  blend: number;
  /** Limb ends stay this far inside the rect (room for the foliage they carry). */
  pad?: number;
}

export const OAK: BranchStyle = {
  mat: Mat.Bark, taper: 0.68, lenMin: 0.62, lenMax: 0.82, spread: 0.85, jitter: 0.28, rise: 0.18, droop: 0.12, tri: 0.3,
  minRad: 1.1, blend: 0.55,
};
export const TWIG: BranchStyle = {
  mat: Mat.Bark, taper: 0.62, lenMin: 0.55, lenMax: 0.75, spread: 0.95, jitter: 0.35, rise: 0.1, droop: 0.04, tri: 0.2,
  minRad: 0.7, blend: 0.4,
};

/** Keep a point inside the element rect (plus `pad` texels of margin). */
function clampIn(r: ElementRaster, pad: number): void {
  P.x = Math.min(r.w - pad, Math.max(pad, P.x));
  P.y = Math.min(r.h - pad, Math.max(pad, P.y));
}

/**
 * One bent, tapered limb from (x, y) along `ang` (with sag). Returns the end point in `P` and the
 * direction at the end.
 */
export function limbAlong(
  r: ElementRaster, x: number, y: number, ang: number, len: number, r0: number, r1: number, mat: Mat, sag: number, bend: number,
  k: number, pad = 8,
): number {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  P.x = x + dx * len;
  P.y = y + dy * len + sag * len * len * 0.01;
  clampIn(r, pad);
  const ex = P.x;
  const ey = P.y;
  const mx = (x + ex) / 2 - dy * bend * len;
  const my = (y + ey) / 2 + dx * bend * len - sag * len * len * 0.004;
  r.curve(x, y, mx, my, ex, ey, r0, r1, mat, k, Math.max(4, Math.min(12, Math.round(len / 7))));
  P.x = ex;
  P.y = ey;
  return Math.atan2(ey - my, ex - mx);
}

export type TipFn = (x: number, y: number, ang: number, rad: number, depth: number) => void;

/** Recursive branching. `tip` is called at every terminal twig (and optionally at forks via `forkTip`). */
export function branchSystem(
  r: ElementRaster, rng: Rng, x: number, y: number, ang: number, len: number, rad: number, depth: number, s: BranchStyle,
  tip: TipFn | null, forkTip: TipFn | null = null,
): void {
  const a = ang + rng.range(-s.jitter, s.jitter) * 0.5;
  const endR = rad * s.taper;
  const endAng = limbAlong(r, x, y, a, len, rad, endR, s.mat, s.droop, rng.range(-0.12, 0.12), rad * s.blend, s.pad ?? 8);
  const ex = P.x;
  const ey = P.y;
  if (depth <= 0 || endR < s.minRad) {
    if (tip) tip(ex, ey, endAng, endR, depth);
    return;
  }
  if (forkTip) forkTip(ex, ey, endAng, endR, depth);
  const n = rng.chance(s.tri) ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * s.spread * rng.range(0.75, 1.2) + rng.range(-s.jitter, s.jitter);
    let ca = endAng + off;
    // Light-seeking: pull toward straight up.
    ca += (UP - ca) * s.rise;
    branchSystem(r, rng, ex, ey, ca, len * rng.range(s.lenMin, s.lenMax), endR * rng.range(0.85, 1), depth - 1, s, tip, forkTip);
  }
}

export interface ClumpStyle {
  mat: Mat;
  /** Lobes around the envelope. */
  lobes: number;
  /** Tufts per lobe rim (the fractal edge). */
  tufts: number;
  /** Volume shading strength of the clump and of each lobe. */
  shade: number;
  lobeShade: number;
  /** Constant luminance offset (e.g. darker undergrowth). */
  flat: number;
  /** Chance of carving a small sky hole into the clump. */
  holes: number;
}

export const LEAFY: ClumpStyle = { mat: Mat.Leaf, lobes: 6, tufts: 6, shade: 0.2, lobeShade: 0.1, flat: 0, holes: 0 };

/**
 * A foliage clump: a body, lobes around an irregular envelope (each with its own volume), tufted rims
 * that make the outline fractal, and sometimes a hole. Lit from the upper left, darker underneath.
 */
export function clump(r: ElementRaster, rng: Rng, cx: number, cy: number, rx: number, ry: number, s: ClumpStyle = LEAFY): void {
  const p1 = rng.range(0, 6.28);
  const p2 = rng.range(0, 6.28);
  const env = (a: number): number => 1 + 0.2 * Math.sin(3 * a + p1) + 0.1 * Math.sin(5 * a + p2);
  r.volume(cx - rx * 0.12, cy - ry * 0.18, Math.max(rx, ry) * 1.1, s.shade, s.flat);
  r.ellipse(cx, cy + ry * 0.06, rx * 0.64, ry * 0.6, s.mat, 3);
  const n = Math.max(3, s.lobes);
  const a0 = rng.range(0, 6.28);
  const m = Math.min(rx, ry);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const e = env(a) * rng.range(0.85, 1.05);
    // Lobes along the upper rim sit a little higher and larger (foliage heaps up toward the light).
    const upness = Math.max(0, -Math.sin(a));
    const lr = m * rng.range(0.34, 0.48) * (0.9 + 0.25 * upness);
    const lx = cx + Math.cos(a) * rx * 0.55 * e;
    const ly = cy + Math.sin(a) * ry * 0.55 * e;
    r.lobe(lx - lr * 0.3, ly - lr * 0.35, lr * 1.1, s.lobeShade);
    r.ellipse(lx, ly, lr, lr * rng.range(0.78, 0.95), s.mat, 2.5);
    const tufts = s.tufts;
    for (let t = 0; t < tufts; t++) {
      const ta = a + rng.range(-1.35, 1.35);
      const tr = lr * rng.range(0.18, 0.3);
      const d = lr * rng.range(0.78, 0.98);
      r.ellipse(lx + Math.cos(ta) * d, ly + Math.sin(ta) * d * 0.92, tr, tr * rng.range(0.75, 1), s.mat, 1.2);
      // Big clumps (seen up close) get pointed leaves breaking their rim.
      if (lr > 12 && rng.chance(0.7)) {
        const len = tr * rng.range(1.2, 1.8);
        const bx = lx + Math.cos(ta) * (d + tr * 0.4);
        const by = ly + Math.sin(ta) * (d + tr * 0.4) * 0.92;
        r.leaf(bx, by, ta + rng.range(-0.5, 0.5) + 0.25, len, len * 0.3, s.mat);
      }
    }
  }
  r.noVolume();
  if (m > 9 && rng.chance(s.holes)) {
    const ha = rng.range(0, 6.28);
    const hd = rng.range(0.25, 0.5);
    r.carve(cx + Math.cos(ha) * rx * hd, cy + Math.sin(ha) * ry * hd, m * rng.range(0.1, 0.16));
  }
}

/** Hanging strand of small leaves (willow curtains, moss). Length in texels; returns nothing. */
export function curtainStrand(
  r: ElementRaster, rng: Rng, x: number, y: number, len: number, drift: number, r0: number, leaf: number, mat: Mat,
): void {
  const ex = x + drift;
  const ey = Math.min(r.h - 8, y + len);
  const cx = x + drift * 0.2 + rng.range(-2, 2);
  const cy = y + (ey - y) * 0.5;
  r.curve(x, y, cx, cy, ex, ey, r0, r0 * 0.45, mat, 0, Math.max(4, Math.round(len / 10)));
  if (leaf <= 0) return;
  const n = Math.round((ey - y) / (leaf * 0.75));
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 0.5);
    ElementRaster.bezier(x, y, cx, cy, ex, ey, t, P);
    const side = i % 2 === 0 ? 1 : -1;
    const size = leaf * rng.range(0.75, 1.15) * (1 - 0.35 * t);
    r.leaf(P.x, P.y, Math.PI / 2 + side * rng.range(0.35, 0.8), size, size * 0.34, mat);
  }
}

/** A root flare: roots curving from the trunk base out and down to the ground line. */
export function rootFlare(r: ElementRaster, rng: Rng, cx: number, groundY: number, trunkR: number, spread: number, count: number, mat: Mat = Mat.Bark): void {
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const t = (Math.floor(i / 2) + 1) / (Math.ceil(count / 2) + 0.5);
    const room = side < 0 ? cx - 12 : r.w - 12 - cx;
    const reach = Math.min(spread * (0.4 + 0.6 * t) * rng.range(0.8, 1.15), room);
    const sx = cx + side * trunkR * rng.range(0.1, 0.5);
    const sy = groundY - trunkR * rng.range(1.2, 2.4);
    const ex = cx + side * reach;
    const ey = groundY + rng.range(0, 3);
    r.curve(sx, sy, sx + side * reach * 0.35, ey - trunkR * rng.range(0.2, 0.6), ex, ey, trunkR * rng.range(0.4, 0.6), 1.2, mat, Math.min(8, trunkR * 0.4), 8);
  }
}

/** A trunk as a gently wandering tapered path from the ground up to `topY`. Returns the path (x,y pairs). */
export function trunkPath(
  r: ElementRaster, rng: Rng, cx: number, ground: number, topY: number, baseR: number, topR: number, wobble: number, lean: number,
  mat: Mat = Mat.Bark, segs = 14,
): number[] {
  const phase = rng.range(0, 10);
  const path: number[] = [cx, ground + 4];
  let px = cx;
  let py = ground + 4;
  let pr = baseR;
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const x = cx + lean * t * t + Math.sin(t * 3.4 + phase) * wobble + Math.sin(t * 8.7 + phase * 2) * wobble * 0.3;
    const y = ground + 4 + (topY - ground - 4) * t;
    const rr = baseR + (topR - baseR) * Math.pow(t, 0.75) + Math.sin(t * 13 + phase) * baseR * 0.04;
    r.capsule(px, py, x, y, pr, rr, mat, Math.min(6, baseR * 0.5));
    px = x;
    py = y;
    pr = rr;
    path.push(px, py);
  }
  return path;
}

/** Point on a polyline path (flat x,y pairs) at fraction t → `out`. */
export function pathPoint(path: readonly number[], t: number, out: { x: number; y: number }): void {
  const n = path.length / 2 - 1;
  const f = Math.min(n - 1e-6, Math.max(0, t * n));
  const i = Math.floor(f);
  const u = f - i;
  out.x = (path[i * 2] as number) + ((path[i * 2 + 2] as number) - (path[i * 2] as number)) * u;
  out.y = (path[i * 2 + 1] as number) + ((path[i * 2 + 3] as number) - (path[i * 2 + 1] as number)) * u;
}

// ---------------------------------------------------------------------------------------------
// Archetypes. Each draws a whole tree standing on (cx, ground) inside the element rect, scaled by
// `s` (1 = the far-layer size, ~400 texels tall).

/**
 * Draw recorded clumps (x, y, radius triples) from the lowest up, so higher clumps overlap lower ones.
 * Clumps are nudged inside the rect; `topCut` lets them run through the top edge (hanging ceilings).
 */
function drawClumps(r: ElementRaster, rng: Rng, list: number[], squash: number, style: ClumpStyle, topCut = false): void {
  const order: number[] = [];
  for (let i = 0; i < list.length; i += 3) order.push(i);
  order.sort((a, b) => (list[b + 1] as number) - (list[a + 1] as number));
  for (const i of order) {
    const rad = list[i + 2] as number;
    const rx = Math.min(rad * 1.2, r.w / 2 - 10);
    const x = Math.min(r.w - 10 - rx, Math.max(10 + rx, list[i] as number));
    const y0 = list[i + 1] as number;
    const ry = topCut ? rad * squash : Math.min(rad * squash, r.h / 2 - 10);
    const y = topCut ? y0 : Math.max(10 + ry, y0);
    if (rx < 4 || ry < 4) continue;
    clump(r, rng, x, y, rx, ry, { ...style, lobes: rad > 18 ? 6 : 5, tufts: rad > 18 ? 6 : 4 });
  }
}

/** Broad old tree: short thick trunk, wide-spreading limbs, a broken dome of heaped clumps. */
export function broadTree(r: ElementRaster, rng: Rng, cx: number, ground: number, s: number): void {
  const trunkH = r.h * rng.range(0.3, 0.36);
  const baseR = 11.5 * s;
  const lean = rng.range(-12, 12) * s;
  const path = trunkPath(r, rng, cx, ground, ground - trunkH, baseR, baseR * 0.66, 4 * s, lean);
  rootFlare(r, rng, cx, ground, baseR, 36 * s, 4);
  const forkX = path[path.length - 2] as number;
  const forkY = path[path.length - 1] as number;
  const limbs = rng.int(3, 5);
  const halfW = r.w / 2 - 14;
  const clumps: number[] = [];
  const crownH = forkY - 10;
  const tip: TipFn = (x, y) => {
    const high = Math.min(1, Math.max(0, (forkY - y) / crownH));
    clumps.push(x, y - 4 * s, (19 + 15 * high) * s * rng.range(0.85, 1.15));
  };
  const fork: TipFn = (x, y, _a, _r, depth) => {
    if (depth <= 1 && rng.chance(0.8)) clumps.push(x + rng.range(-4, 4) * s, y - 8 * s, rng.range(14, 20) * s);
  };
  const style: BranchStyle = { ...OAK, taper: 0.64 };
  for (let i = 0; i < limbs; i++) {
    const t = i / (limbs - 1);
    const ang = UP + (t - 0.5) * rng.range(1.6, 2.1) + rng.range(-0.15, 0.15);
    const len = halfW * 0.46 * rng.range(0.85, 1.1) * (1.1 - 0.3 * Math.abs(t - 0.5));
    branchSystem(r, rng, forkX, forkY + 4 * s, ang, len, baseR * 0.6, 2, style, tip, fork);
  }
  // A lower, older limb reaching sideways gives the characteristic broad profile.
  pathPoint(path, rng.range(0.62, 0.78), P);
  const side = rng.chance(0.5) ? -1 : 1;
  branchSystem(r, rng, P.x, P.y, UP + side * rng.range(1.0, 1.2), halfW * 0.44, baseR * 0.42, 2, style, tip, fork);
  drawClumps(r, rng, clumps, 0.82, LEAFY);
}

/** Willow: a leaning trunk, arching limbs under a low dome, and dense curtains of hanging strands. */
export function willowTree(r: ElementRaster, rng: Rng, cx: number, ground: number, s: number): void {
  const trunkH = r.h * rng.range(0.34, 0.42);
  const baseR = 9 * s;
  const lean = rng.range(-14, 14) * s;
  const path = trunkPath(r, rng, cx, ground, ground - trunkH, baseR, baseR * 0.62, 5 * s, lean);
  rootFlare(r, rng, cx, ground, baseR, 26 * s, 4);
  const topX = path[path.length - 2] as number;
  const topY = path[path.length - 1] as number;
  const halfW = Math.min(r.w / 2 - 12, (r.w / 2 - 12) * rng.range(0.85, 1));
  const domeH = r.h * rng.range(0.14, 0.2);
  // Arching limbs.
  const arches = rng.int(4, 5);
  for (let i = 0; i < arches; i++) {
    const t = i / (arches - 1);
    const ex = Math.min(r.w - 14, Math.max(14, cx + (t - 0.5) * 2 * halfW * rng.range(0.75, 0.95)));
    const ey = topY - domeH * rng.range(0.2, 0.5) * (1 - Math.abs(t - 0.5));
    const px = topX + (ex - topX) * 0.45;
    const py = topY - domeH * rng.range(0.9, 1.3);
    const r0 = baseR * rng.range(0.4, 0.52);
    r.curve(topX, topY + 4, px, py, ex, ey, r0, r0 * 0.3, Mat.Bark, r0 * 0.6, 12);
  }
  // The dome: overlapping flattened clumps along an arc.
  const clumps: number[] = [];
  const nDome = rng.int(7, 9);
  for (let i = 0; i < nDome; i++) {
    const t = (i + rng.range(0.2, 0.8)) / nDome;
    const x = cx + (t - 0.5) * 2 * halfW * 0.9;
    const arc = 1 - Math.pow(2 * t - 1, 2);
    const y = topY - domeH * (0.35 + 0.75 * arc) + rng.range(-4, 4) * s;
    clumps.push(x, y, rng.range(17, 25) * s * (0.8 + 0.3 * arc));
  }
  drawClumps(r, rng, clumps, 0.62, { ...LEAFY, holes: 0 });
  // Curtains: dense strands from the dome's underside, longest at the rim.
  const step = 3.4 * s;
  for (let x = cx - halfW * 0.95; x <= cx + halfW * 0.95; x += step * rng.range(0.7, 1.3)) {
    const u = (x - cx) / halfW;
    const arc = 1 - u * u;
    const y0 = topY - domeH * (0.1 + 0.55 * arc) + rng.range(0, 8) * s;
    const rim = Math.min(1, Math.abs(u) * 1.2);
    const len = (ground - y0) * rng.range(0.3, 0.55) * (0.45 + 0.75 * rim);
    if (rng.chance(0.12)) continue;
    curtainStrand(r, rng, x, y0, len, u * rng.range(2, 7) * s, 1.25 * s, 3.4 * s, Mat.Leaf);
  }
}

/** A drooping fan of small leaves at a twig end (feathery crowns). */
function leafSpray(r: ElementRaster, rng: Rng, x: number, y: number, ang: number, size: number, s: number): void {
  const n = Math.round(9 + size / (2 * s));
  for (let i = 0; i < n; i++) {
    const u = rng.next();
    // Leaves fan around the twig direction and droop under gravity toward the outside.
    const a = ang + rng.range(-1.2, 1.2) + (Math.PI / 2 - ang) * 0.35 * u;
    const d = size * rng.range(0.05, 0.55);
    const bx = x + Math.cos(a) * d;
    const by = y + Math.sin(a) * d;
    const len = size * rng.range(0.35, 0.6);
    r.leaf(bx, by, a + rng.range(-0.5, 0.5) + 0.4, len, len * 0.3, Mat.Leaf);
  }
  r.ellipse(x, y, size * 0.32, size * 0.26, Mat.Leaf, 2);
}

/** Slender pale-barked trees (one to three stems) with a narrow, airy crown of small clumps. */
export function slenderTree(r: ElementRaster, rng: Rng, cx: number, ground: number, s: number): void {
  const stems = rng.int(2, 3);
  for (let i = 0; i < stems; i++) {
    const off = (i - (stems - 1) / 2) * 14 * s + rng.range(-3, 3);
    const topY = Math.max(24, ground - r.h * rng.range(0.78, 0.92) * (i === 0 ? 1 : rng.range(0.78, 0.92)));
    const baseR = rng.range(4.8, 6) * s * (i === 0 ? 1 : 0.82);
    const lean = (off * 0.9 + rng.range(-8, 8)) * s;
    const path = trunkPath(r, rng, cx + off, ground, topY, baseR, baseR * 0.4, 2.5 * s, lean, Mat.PaleBark, 12);
    const twigs = rng.int(8, 11);
    r.volume(cx + off, topY + r.h * 0.12, r.h * 0.22, 0.14);
    for (let t = 0; t < twigs; t++) {
      const at = 0.48 + 0.5 * (t / (twigs - 1)) + rng.range(-0.03, 0.03);
      pathPoint(path, at, P);
      const side = t % 2 === 0 ? -1 : 1;
      const x = P.x;
      const y = P.y;
      const ang = UP + side * rng.range(0.5, 1.15) * (1.15 - at * 0.5);
      const len = rng.range(12, 22) * s * (1.3 - at * 0.6);
      const endAng = limbAlong(r, x, y, ang, len, baseR * 0.3, 0.55, Mat.PaleBark, 0.05, rng.range(-0.1, 0.1), 1);
      leafSpray(r, rng, P.x, P.y, endAng, rng.range(9, 14) * s * (1.2 - at * 0.35), s);
    }
    pathPoint(path, 1, P);
    leafSpray(r, rng, P.x, P.y, UP, 11 * s, s);
    r.noVolume();
  }
  rootFlare(r, rng, cx, ground, 5 * s, 14 * s, 2, Mat.PaleBark);
}

/** Conifer with ragged, drooping tiers: fringed skirts, uneven reach, missing branches, a bent leader. */
export function coniferTree(r: ElementRaster, rng: Rng, cx: number, ground: number, s: number): void {
  const top = Math.max(14, ground - r.h * rng.range(0.84, 0.95));
  const baseR = 5.5 * s;
  const lean = rng.range(-6, 6) * s;
  trunkPath(r, rng, cx, ground, top, baseR, 1.2, 1.5 * s, lean, Mat.Bark, 12);
  const H = ground - top;
  const halfW = r.w / 2 - 10;
  const spacing = rng.range(12, 16) * s;
  const tiers = Math.floor((H * 0.9) / spacing);
  for (let i = 0; i < tiers; i++) {
    const t = (i + 0.5) / tiers;
    const y = top + 10 * s + H * 0.88 * t + rng.range(-3, 3) * s;
    const x = cx + lean * t * t;
    const w = (5 * s + halfW * 0.95 * Math.pow(t, 0.8)) * rng.range(0.6, 1.1);
    for (let side = -1; side <= 1; side += 2) {
      if (t > 0.2 && t < 0.85 && rng.chance(0.12)) continue;
      // Ragged: now and then a branch reaches far out or stays stunted.
      const reach = rng.chance(0.15) ? rng.range(1.15, 1.35) : rng.chance(0.2) ? rng.range(0.45, 0.65) : rng.range(0.78, 1.04);
      const len = Math.min(w * reach, side < 0 ? x - 10 : r.w - 10 - x);
      const droop = (4 + 16 * t) * s * rng.range(0.6, 1.5);
      const ex = x + side * len;
      const ey = y + droop;
      const mx = x + side * len * 0.55;
      const my = y - 2 * s;
      r.volume(x + side * len * 0.3, y - 8 * s, len * 0.75 + 8, 0.18, -0.02);
      r.curve(x, y, mx, my, ex, ey, 1.8 * s, 0.7 * s, Mat.Needle, 1, 6);
      // A fringed skirt hangs from the rib; its teeth make the sawtooth conifer edge.
      const n = Math.max(4, Math.round(len / (2.6 * s)));
      for (let k = 0; k <= n; k++) {
        const u = k / n;
        ElementRaster.bezier(x, y, mx, my, ex, ey, u, P);
        const hang = (6 + 12 * t) * s * (0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.95))) * rng.range(0.7, 1.25);
        const a = Math.PI / 2 - side * rng.range(0.35, 0.85);
        r.leaf(P.x, P.y - 1.5 * s, a, hang, Math.max(1.5, hang * 0.3), Mat.Needle);
        if (k % 2 === 0) r.leaf(P.x, P.y, -Math.PI / 2 + side * rng.range(0.6, 1.1), 3.5 * s, 1.2 * s, Mat.Needle);
      }
      r.noVolume();
    }
  }
  // Leader: a thin, slightly bent spire.
  r.curve(cx, top + 16 * s, cx + rng.range(-3, 3) * s, top + 6 * s, cx + rng.range(-5, 5) * s, top - 4 * s, 1.8 * s, 0.5, Mat.Needle, 0, 5);
}

/** Dead snag: a broken, jagged top, bare forking branches, hanging moss. */
export function snagTree(r: ElementRaster, rng: Rng, cx: number, ground: number, s: number): void {
  const topY = ground - r.h * rng.range(0.7, 0.84);
  const baseR = rng.range(8.5, 10.5) * s;
  const lean = rng.range(-12, 12) * s;
  const path = trunkPath(r, rng, cx, ground, topY, baseR, baseR * 0.6, 5 * s, lean);
  rootFlare(r, rng, cx, ground, baseR, 30 * s, 4);
  const tx = path[path.length - 2] as number;
  const ty = path[path.length - 1] as number;
  // Splintered top: a few sharp shards.
  for (let i = 0; i < 4; i++) {
    const a = UP + rng.range(-0.45, 0.45);
    const len = rng.range(8, 24) * s;
    r.capsule(tx + rng.range(-4, 4) * s, ty + 3, tx + Math.cos(a) * len, ty + Math.sin(a) * len, baseR * 0.38, 0.3, Mat.Bark, 1);
  }
  const branches = rng.int(4, 6);
  const halfW = r.w / 2 - 12;
  const moss: TipFn = (x, y) => {
    if (rng.chance(0.5)) curtainStrand(r, rng, x, y, rng.range(10, 30) * s, rng.range(-2, 2), 0.9 * s, 0, Mat.Moss);
  };
  for (let i = 0; i < branches; i++) {
    pathPoint(path, 0.3 + 0.62 * (i / (branches - 1)) + rng.range(-0.04, 0.04), P);
    const side = i % 2 === 0 ? -1 : 1;
    const ang = UP + side * rng.range(0.5, 1.1);
    const len = halfW * rng.range(0.4, 0.62) * (rng.chance(0.25) ? 0.45 : 1);
    branchSystem(r, rng, P.x, P.y, ang, len, baseR * 0.4, 2, { ...TWIG, rise: 0.2 }, moss);
  }
}

// ---------------------------------------------------------------------------------------------
// Rising trunks for mid/near layers: the element's top rows (above `stretchRow`) are a plain vertical
// column that placement stretches out of frame; everything organic sits below it.

/** Wandering trunk from the ground up to `stretchRow`, then a straight column out of the rect top. */
export function risingColumn(
  r: ElementRaster, rng: Rng, cx: number, ground: number, stretchRow: number, baseR: number, topR: number, wobble: number,
  mat: Mat = Mat.Bark,
): number[] {
  const lean = rng.range(-1, 1) * Math.min(wobble * 1.5, r.w / 2 - topR - wobble * 1.3 - 10);
  const path = trunkPath(r, rng, cx, ground, stretchRow, baseR, topR, wobble, lean, mat, 12);
  const tx = path[path.length - 2] as number;
  const ty = path[path.length - 1] as number;
  r.capsule(tx, ty, tx, -16, topR, topR, mat, 2);
  if (Number.isNaN(r.columnX)) r.columnX = tx;
  return path;
}

/** Mid-layer gnarled oak trunk with a big foliage-bearing limb and a smaller one. */
export function midOakTrunk(r: ElementRaster, rng: Rng, cx: number, ground: number, stretchRow: number, s: number): void {
  const baseR = rng.range(17, 21) * s;
  const path = risingColumn(r, rng, cx, ground, stretchRow, baseR, baseR * 0.64, 8 * s);
  rootFlare(r, rng, cx, ground, baseR, rng.range(58, 72) * s, 5);
  const clumps: number[] = [];
  const minY = stretchRow + 30 * s;
  const tip: TipFn = (x, y) => {
    clumps.push(x, Math.max(minY, y - 6 * s), rng.range(20, 28) * s);
  };
  const fork: TipFn = (x, y) => {
    if (rng.chance(0.75)) clumps.push(x, Math.max(minY, y - 8 * s), rng.range(15, 21) * s);
  };
  const side = rng.chance(0.5) ? -1 : 1;
  const halfW = r.w / 2 - 16;
  const style: BranchStyle = { ...OAK, taper: 0.62, pad: 30 * s, rise: 0.25 };
  pathPoint(path, rng.range(0.45, 0.55), P);
  branchSystem(r, rng, P.x, P.y, UP + side * rng.range(0.7, 0.95), halfW * rng.range(0.32, 0.38), baseR * 0.46, 2, style, tip, fork);
  pathPoint(path, rng.range(0.74, 0.84), P);
  branchSystem(r, rng, P.x, P.y, UP - side * rng.range(0.5, 0.8), halfW * rng.range(0.24, 0.28), baseR * 0.32, 2, style, tip, fork);
  // A leafy cap where the trunk leaves the frame's stretch row, so the column rises out of foliage.
  pathPoint(path, 0.97, P);
  clumps.push(P.x + rng.range(-10, 10) * s, P.y + 10 * s, rng.range(22, 28) * s);
  drawClumps(r, rng, clumps, 0.78, LEAFY);
  // Moss cushions on the lit shoulder and a knot.
  for (let m = 0; m < 5; m++) {
    pathPoint(path, rng.range(0.15, 0.7), P);
    r.ellipse(P.x - baseR * 0.6, P.y, 5 * s, rng.range(8, 16) * s, Mat.Moss, 2);
  }
}

/** Mid-layer willow trunk: a fork into arching limbs with long curtains of strands. */
export function midWillowTrunk(r: ElementRaster, rng: Rng, cx: number, ground: number, stretchRow: number, s: number): void {
  const baseR = rng.range(14, 17) * s;
  const path = risingColumn(r, rng, cx, ground, stretchRow, baseR, baseR * 0.55, 6 * s);
  rootFlare(r, rng, cx, ground, baseR, 50 * s, 4);
  pathPoint(path, rng.range(0.55, 0.68), P);
  const fx = P.x;
  const fy = P.y;
  const halfW = r.w / 2 - 12;
  const arches = rng.int(2, 3);
  for (let i = 0; i < arches; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const ex = cx + side * halfW * rng.range(0.8, 0.98);
    const ey = fy - rng.range(10, 60) * s;
    const px = fx + side * halfW * 0.3;
    const py = Math.max(stretchRow + 10, fy - rng.range(90, 130) * s);
    const r0 = baseR * rng.range(0.38, 0.48);
    r.curve(fx, fy, px, py, ex, ey, r0, r0 * 0.35, Mat.Bark, r0 * 0.6, 12);
    const clumps: number[] = [];
    for (let c = 0; c < 4; c++) {
      ElementRaster.bezier(fx, fy, px, py, ex, ey, 0.3 + c * 0.2, P);
      clumps.push(P.x, Math.max(stretchRow + 14, P.y - 4 * s), rng.range(18, 26) * s);
    }
    drawClumps(r, rng, clumps, 0.6, LEAFY);
    const strands = Math.round(22 * s);
    for (let k = 0; k < strands; k++) {
      const u = 0.25 + 0.75 * (k / (strands - 1));
      ElementRaster.bezier(fx, fy, px, py, ex, ey, u, P);
      const len = (ground - P.y) * rng.range(0.35, 0.7) * (0.5 + 0.5 * u);
      curtainStrand(r, rng, P.x, P.y + 3, len, side * rng.range(0, 8) * s, 1.9 * s, 4.4 * s, Mat.Leaf);
    }
  }
}

/** Mid-layer conifer trunk: ragged fringed tiers in the upper part, dead stubs lower down. */
export function midConiferTrunk(r: ElementRaster, rng: Rng, cx: number, ground: number, stretchRow: number, s: number): void {
  const baseR = rng.range(11, 14) * s;
  const path = risingColumn(r, rng, cx, ground, stretchRow, baseR, baseR * 0.7, 2 * s);
  rootFlare(r, rng, cx, ground, baseR, 40 * s, 4);
  const halfW = r.w / 2 - 10;
  const lowest = stretchRow + (ground - stretchRow) * rng.range(0.42, 0.55);
  const spacing = 17 * s;
  for (let y = stretchRow + 8 * s; y < lowest; y += spacing * rng.range(0.8, 1.2)) {
    const t = (y - stretchRow) / (lowest - stretchRow);
    pathPoint(path, 1 - (y - stretchRow) / (ground - stretchRow) * 1.0, P);
    const x = P.x;
    for (let side = -1; side <= 1; side += 2) {
      if (rng.chance(0.12)) continue;
      const reach = rng.chance(0.15) ? rng.range(1.1, 1.25) : rng.chance(0.2) ? rng.range(0.4, 0.6) : rng.range(0.72, 1);
      const len = Math.min(halfW * (0.55 + 0.45 * t) * reach, side < 0 ? x - 10 : r.w - 10 - x);
      const droop = (8 + 18 * t) * s * rng.range(0.7, 1.3);
      const ex = x + side * len;
      const ey = y + droop;
      const mx = x + side * len * 0.55;
      const my = y - 3 * s;
      r.volume(x + side * len * 0.3, y - 10 * s, len * 0.75 + 10, 0.18, -0.02);
      r.curve(x, y, mx, my, ex, ey, 2.4 * s, 0.9 * s, Mat.Needle, 1, 8);
      const n = Math.max(5, Math.round(len / (2.8 * s)));
      for (let k = 0; k <= n; k++) {
        const u = k / n;
        ElementRaster.bezier(x, y, mx, my, ex, ey, u, P);
        const hang = (9 + 12 * t) * s * (0.45 + 0.55 * Math.sin(Math.PI * Math.min(1, 0.15 + u * 0.95))) * rng.range(0.7, 1.25);
        r.leaf(P.x, P.y - 2 * s, Math.PI / 2 - side * rng.range(0.35, 0.85), hang, Math.max(1.8, hang * 0.3), Mat.Needle);
        if (k % 2 === 0) r.leaf(P.x, P.y, -Math.PI / 2 + side * rng.range(0.6, 1.1), 4.5 * s, 1.5 * s, Mat.Needle);
      }
      r.noVolume();
    }
  }
  // Dead stubs below the living crown.
  for (let i = 0; i < 4; i++) {
    const t = rng.range(0.15, 0.45);
    pathPoint(path, t, P);
    if (P.y < lowest) continue;
    const side = rng.chance(0.5) ? -1 : 1;
    const len = rng.range(14, 34) * s;
    const a = UP + side * rng.range(1.0, 1.4);
    r.capsule(P.x, P.y, P.x + Math.cos(a) * len, P.y + Math.sin(a) * len, 2.4 * s, 0.6, Mat.Bark, 1.5);
  }
}

/** Mid-layer pale birch pair: two slim pale trunks with feathery sprays on side twigs. */
export function midBirchPair(r: ElementRaster, rng: Rng, cx: number, ground: number, stretchRow: number, s: number): void {
  const stems = 2;
  for (let i = 0; i < stems; i++) {
    const off = (i === 0 ? -1 : 1) * rng.range(11, 17) * s;
    const baseR = (i === 0 ? rng.range(10.5, 12) : rng.range(8, 9.5)) * s;
    const path = risingColumn(r, rng, cx + off, ground, stretchRow, baseR, baseR * 0.72, 4 * s, Mat.PaleBark);
    const twigs = rng.int(4, 6);
    r.volume(cx + off, stretchRow + 120 * s, 140 * s, 0.14);
    for (let t = 0; t < twigs; t++) {
      pathPoint(path, rng.range(0.45, 0.9), P);
      const side = (t + i) % 2 === 0 ? -1 : 1;
      const x = P.x;
      const y = P.y;
      const ang = UP + side * rng.range(0.7, 1.25);
      const len = rng.range(24, 44) * s;
      const endAng = limbAlong(r, x, y, ang, len, baseR * 0.26, 0.7, Mat.PaleBark, 0.06, rng.range(-0.1, 0.1), 1);
      leafSpray(r, rng, P.x, Math.max(stretchRow + 20, P.y), endAng, rng.range(20, 28) * s, s);
    }
    r.noVolume();
  }
  rootFlare(r, rng, cx, ground, 8 * s, 26 * s, 3, Mat.PaleBark);
}

/** A hanging canopy ceiling: limbs from the top edge carrying heavy, overlapping clumps and a few curtains. */
export function canopyCeiling(r: ElementRaster, rng: Rng, s: number): void {
  const clumps: number[] = [];
  // A continuous band of foliage through the top edge (which sits above the frame).
  for (let x = 10 * s; x < r.w; x += rng.range(34, 48) * s) clumps.push(x, rng.range(0, 26) * s, rng.range(34, 46) * s);
  const limbs = rng.int(3, 4);
  for (let i = 0; i < limbs; i++) {
    const x0 = r.w * ((i + 0.5) / limbs) + rng.range(-20, 20) * s;
    const ang = Math.PI / 2 + rng.range(-0.8, 0.8);
    const len = rng.range(70, 120) * s;
    limbAlong(r, x0, -14, ang, len, 10 * s, 3.5 * s, Mat.Bark, 0.1, rng.range(-0.15, 0.15), 3, 40 * s);
    const ex = P.x;
    const ey = P.y;
    // Heavy lobes hang from each limb, the lowest ones smaller.
    clumps.push(ex, Math.min(r.h - 70 * s, ey + 6 * s), rng.range(28, 38) * s);
    clumps.push((x0 + ex) / 2 + rng.range(-16, 16) * s, Math.max(36 * s, (ey - 14) * 0.5), rng.range(32, 44) * s);
  }
  drawClumps(r, rng, clumps, 0.7, { ...LEAFY, shade: 0.18, flat: -0.02 }, true);
  const strands = rng.int(6, 10);
  for (let k = 0; k < strands; k++) {
    const x = rng.range(30, r.w - 30);
    curtainStrand(r, rng, x, rng.range(50, 100) * s, rng.range(50, r.h - 120 * s), rng.range(-4, 4), 1.5 * s, 5 * s, Mat.Leaf);
  }
}

/**
 * Near-layer gnarled trunk (variant 0: a great foliage-bearing limb; 1: a broken stub with hanging moss;
 * 2: two limbs), a root arch on one side, moss on the lit shoulder and glowing shelf fungi in the shade.
 */
export function nearTrunk(r: ElementRaster, rng: Rng, cx: number, ground: number, stretchRow: number, variant: number): void {
  const baseR = rng.range(30, 36);
  const path = risingColumn(r, rng, cx, ground, stretchRow, baseR, baseR * 0.6, 14);
  rootFlare(r, rng, cx, ground, baseR, rng.range(90, 112), 6);
  const s = rng.chance(0.5) ? -1 : 1;
  const arch = Math.min(120, s < 0 ? cx - 18 : r.w - 18 - cx);
  r.curve(cx + s * baseR * 0.4, ground - baseR * 1.8, cx + s * arch * 0.64, ground - 80, cx + s * arch, ground + 2, 10, 3.5, Mat.Bark, 6, 12);
  const clumps: number[] = [];
  const minY = stretchRow + 40;
  const tip: TipFn = (x, y) => {
    clumps.push(x, Math.max(minY, y - 8), rng.range(26, 36));
  };
  const fork: TipFn = (x, y) => {
    if (rng.chance(0.7)) clumps.push(x, Math.max(minY, y - 10), rng.range(18, 26));
  };
  const halfW = r.w / 2 - 16;
  const style: BranchStyle = { ...OAK, taper: 0.62, pad: 40, rise: 0.22 };
  if (variant !== 1) {
    pathPoint(path, rng.range(0.5, 0.6), P);
    branchSystem(r, rng, P.x, P.y, UP - s * rng.range(0.75, 0.95), halfW * rng.range(0.32, 0.38), baseR * 0.42, 2, style, tip, fork);
  }
  if (variant === 2) {
    pathPoint(path, rng.range(0.78, 0.86), P);
    branchSystem(r, rng, P.x, P.y, UP + s * rng.range(0.6, 0.85), halfW * rng.range(0.26, 0.3), baseR * 0.3, 2, style, tip, fork);
  }
  if (variant === 1) {
    // A broken limb stub draped in moss.
    pathPoint(path, rng.range(0.55, 0.65), P);
    const a = UP - s * 1.05;
    const len = rng.range(50, 70);
    r.capsule(P.x, P.y, P.x + Math.cos(a) * len, P.y + Math.sin(a) * len, baseR * 0.35, baseR * 0.22, Mat.Bark, 4);
    for (let k = 0; k < 6; k++) {
      const t = rng.range(0.3, 1);
      curtainStrand(r, rng, P.x + Math.cos(a) * len * t, P.y + Math.sin(a) * len * t + 4, rng.range(20, 60), rng.range(-3, 3), 1.8, 0, Mat.Moss);
    }
  }
  drawClumps(r, rng, clumps, 0.78, LEAFY);
  // Moss cushions on the lit (left) shoulder.
  for (let m = 0; m < 7; m++) {
    pathPoint(path, rng.range(0.12, 0.8), P);
    r.ellipse(P.x - baseR * 0.6, P.y, 7, rng.range(10, 22), Mat.Moss, 3);
  }
  if (variant !== 2) {
    // A few small glowing shelf fungi low on the shaded side.
    pathPoint(path, rng.range(0.06, 0.12), P);
    const fx = P.x + baseR * 0.78 * s;
    for (let f = 0; f < 3; f++) {
      const fy = P.y - f * rng.range(14, 22);
      r.ellipse(fx + s * 5, fy, 7 - f * 1.5, 2.6, Mat.Fungus, 1);
      r.glow(fx + s * 5, fy + 0.5, 5 - f, 0.8, 1);
    }
    r.haloAt(fx + s * 5, P.y - 14, 26, 0.18);
  }
}

/**
 * A crown section for a mid-layer trunk column: limbs from a short hidden column segment carry a
 * broad, broken mass of clumps. Placement hangs these on the stretched upper part
 * of trunk columns, so tall trees keep foliage when the camera climbs.
 */
export function midCrown(r: ElementRaster, rng: Rng, s: number): void {
  const cx = r.w / 2;
  const top = 34 * s;
  const bot = r.h - 34 * s;
  r.capsule(cx, top, cx, bot, 10 * s, 11 * s, Mat.Bark, 2);
  const clumps: number[] = [];
  const tip: TipFn = (x, y) => {
    clumps.push(x, y - 4 * s, rng.range(24, 32) * s);
  };
  const fork: TipFn = (x, y) => {
    clumps.push(x, y - 6 * s, rng.range(22, 28) * s);
  };
  const style: BranchStyle = { ...OAK, taper: 0.6, pad: 34 * s, rise: 0.3, tri: 0.15 };
  const limbs = rng.int(4, 5);
  const halfW = r.w / 2 - 16;
  for (let i = 0; i < limbs; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const y = top + (bot - top) * (0.2 + 0.7 * (i / (limbs - 1))) + rng.range(-10, 10) * s;
    branchSystem(r, rng, cx, y, UP + side * rng.range(0.7, 1.2), halfW * rng.range(0.38, 0.46), 6 * s, 1, style, tip, fork);
  }
  // A heap of foliage around the column in the middle of the section.
  clumps.push(cx + rng.range(-12, 12) * s, (top + bot) / 2, rng.range(26, 32) * s);
  // Foliage closes over the column at both ends of the section (the real trunk continues there).
  clumps.push(cx, top + 14 * s, rng.range(22, 26) * s);
  clumps.push(cx + rng.range(-8, 8) * s, bot - 20 * s, rng.range(20, 24) * s);
  drawClumps(r, rng, clumps, 0.72, LEAFY);
}
