import type { Rng } from '../../core/rng.ts';
import { ElementRaster, Mat, type FinalizeOptions } from './raster.ts';

/** Transparent border inside element rects (≥ the hull pad, so mip fringes stay inside the rect). */
export const ELEMENT_MARGIN = 6;

export const KIT_CATEGORIES = [
  'farTree', 'farCanopy', 'midTrunk', 'canopyTop', 'midBush', 'groundEdge', 'vine', 'fern', 'glowFlower',
  'nearTrunk', 'rootArch', 'mushrooms', 'rock', 'fgBottom', 'fgTop', 'fgVine', 'grass', 'flower', 'shroom',
  'floraBig', 'lantern', 'bramble', 'tendril', 'bridge', 'solid',
] as const;
export type KitCategory = (typeof KIT_CATEGORIES)[number];

/** Which end of an element is fixed when it sways ('none' = static). */
export type SwayAnchor = 'none' | 'bottom' | 'top';

export interface ElementSpec {
  category: KitCategory;
  variants: number;
  w: number;
  h: number;
  /** Layer units per texel at instance scale 1. */
  unitsPerTexel: number;
  /** Anchor in element texels (feet for grounded elements, attachment point for hanging ones). */
  anchorX: number;
  anchorY: number;
  sway: SwayAnchor;
  /** Relative sway amplitude (grass tips move more than bush tips). */
  swayScale: number;
  emissive: boolean;
  /**
   * The element's top (or bottom) edge is a hard cut meant to sit outside the visible layer: trunks
   * that rise out of frame, canopy ceilings, ground bodies. Placement keeps the cut out of view.
   */
  cut: 'none' | 'top' | 'bottom';
  /**
   * For top cuts: texel row above which the element may stretch vertically (rows below it, e.g. a
   * root flare, keep their proportions). Defaults to the anchor row.
   */
  stretchFrom?: number;
  finalize: FinalizeOptions;
  draw(r: ElementRaster, rng: Rng, variant: number): void;
}

const M = ELEMENT_MARGIN;
const P = { x: 0, y: 0 };

/** Shorten a stroke from (x, y) along `ang` so its tip (plus `pad`) stays inside the element rect. */
function fitLength(r: ElementRaster, x: number, y: number, ang: number, len: number, pad: number): number {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  let l = len;
  if (dx > 1e-6) l = Math.min(l, (r.w - M - pad - x) / dx);
  if (dx < -1e-6) l = Math.min(l, (M + pad - x) / dx);
  if (dy < -1e-6) l = Math.min(l, (M + pad - y) / dy);
  return Math.max(len * 0.35, l);
}

/** Tapered limb along a gently bent path. */
function limb(
  r: ElementRaster, x0: number, y0: number, x1: number, y1: number, bend: number, r0: number, r1: number, mat: Mat,
  k = 4, segments = 12,
): void {
  const nx = -(y1 - y0);
  const ny = x1 - x0;
  const nl = Math.hypot(nx, ny) || 1;
  r.curve(x0, y0, (x0 + x1) / 2 + (nx / nl) * bend, (y0 + y1) / 2 + (ny / nl) * bend, x1, y1, r0, r1, mat, k, segments);
}

/** Root flare: roots curving from the trunk base out and down into the ground line. */
function roots(r: ElementRaster, rng: Rng, cx: number, groundY: number, trunkR: number, spread: number, count: number): void {
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const t = (Math.floor(i / 2) + 1) / (Math.ceil(count / 2) + 0.5);
    const reach = Math.min(spread * (0.45 + 0.55 * t) * rng.range(0.8, 1.15), side < 0 ? cx - M - 8 : r.w - M - 8 - cx);
    const sx = cx + side * trunkR * rng.range(0.1, 0.5);
    const sy = groundY - trunkR * rng.range(1.4, 2.6);
    const ex = cx + side * reach;
    const ey = groundY + rng.range(0, 4);
    r.curve(sx, sy, sx + side * reach * 0.35, ey - trunkR * rng.range(0.2, 0.6), ex, ey,
      trunkR * rng.range(0.42, 0.62), 1.6, Mat.Bark, trunkR * 0.55, 8);
  }
}

/**
 * Cloud-like foliage mass: a soft body plus many leaf clumps scattered toward an irregular envelope,
 * so the outline reads as foliage rather than a blob.
 */
function cloudCrown(
  r: ElementRaster, rng: Rng, cx: number, cy: number, rx: number, ry: number, clumps: number, clumpR: number, mat: Mat = Mat.Leaf,
): void {
  const p1 = rng.range(0, 6.28);
  const p2 = rng.range(0, 6.28);
  r.ellipse(cx, cy, rx * 0.6, ry * 0.6, mat, 6);
  for (let i = 0; i < clumps; i++) {
    const a = rng.range(0, Math.PI * 2);
    const env = 1 + 0.22 * Math.sin(3 * a + p1) + 0.12 * Math.sin(5 * a + p2);
    const d = Math.pow(rng.next(), 0.4) * 0.8;
    const px = cx + Math.cos(a) * rx * d * env;
    const py = cy + Math.sin(a) * ry * d * env;
    const s = clumpR * rng.range(0.6, 1.2) * (1.1 - 0.4 * d);
    r.ellipse(px, py, s, s * rng.range(0.75, 0.95), mat, 3);
  }
}

/** A frond: curved rib with leaflets on both sides shrinking toward the tip. */
function frond(r: ElementRaster, rng: Rng, bx: number, by: number, ang: number, len: number, droop: number, leaf: number, mat: Mat, ribR = 1.4): void {
  const ex = bx + Math.cos(ang) * len;
  const ey = by + Math.sin(ang) * len + droop;
  const cx = bx + Math.cos(ang) * len * 0.55;
  const cy = by + Math.sin(ang) * len * 0.55 - droop * 0.2;
  r.curve(bx, by, cx, cy, ex, ey, ribR, ribR * 0.4, mat, 0, 8);
  const n = Math.max(4, Math.round(len / (leaf * 0.9)));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    ElementRaster.bezier(bx, by, cx, cy, ex, ey, t, P);
    const px = P.x;
    const py = P.y;
    ElementRaster.bezier(bx, by, cx, cy, ex, ey, Math.min(1, t + 0.02), P);
    const dir = Math.atan2(P.y - py, P.x - px);
    const size = leaf * (1 - t * 0.75) * rng.range(0.85, 1.1);
    r.leaf(px, py, dir - 1.05, size, size * 0.26, mat);
    r.leaf(px, py, dir + 1.05, size, size * 0.26, mat);
  }
}

/** Hanging strand with alternating small leaves (vines, moss). */
function strand(r: ElementRaster, rng: Rng, x: number, y: number, len: number, sway: number, r0: number, r1: number, leaf: number, mat: Mat): void {
  const ex = x + rng.range(-sway, sway);
  const ey = y + len;
  const cx = x + rng.range(-sway, sway) * 1.6;
  const cy = y + len * 0.5;
  r.curve(x, y, cx, cy, ex, ey, r0, r1, mat, 0, 10);
  if (leaf <= 0) return;
  const n = Math.round(len / (leaf * 0.85));
  for (let i = 1; i < n; i++) {
    const t = i / n + rng.range(-0.02, 0.02);
    ElementRaster.bezier(x, y, cx, cy, ex, ey, t, P);
    const side = i % 2 === 0 ? 1 : -1;
    const size = leaf * rng.range(0.7, 1.15) * (1 - t * 0.35);
    r.leaf(P.x, P.y, Math.PI / 2 + side * rng.range(0.5, 1.0), size, size * 0.32, mat);
  }
}

function mushroom(r: ElementRaster, rng: Rng, x: number, groundY: number, h: number, capR: number, lean: number, glow: number): void {
  const topX = x + lean;
  const topY = groundY - h;
  r.curve(x, groundY + 1, x + lean * 0.3, groundY - h * 0.5, topX, topY, capR * 0.2, capR * 0.14, Mat.Stem, 1, 5);
  r.ellipse(topX, topY - capR * 0.12, capR, capR * 0.5, Mat.Fungus, 1.5);
  r.carve(topX, topY + capR * 0.62, capR * 0.72);
  r.glow(topX, topY + capR * 0.02, capR * 0.72, glow, 1.2);
  const spots = rng.int(1, 3);
  for (let i = 0; i < spots; i++) {
    r.glow(topX + rng.range(-0.55, 0.55) * capR, topY - capR * rng.range(0.25, 0.45), capR * rng.range(0.1, 0.16), glow, 0.8);
  }
}

function glowBulb(r: ElementRaster, x: number, y: number, rad: number, halo: number, haloStrength: number): void {
  r.ellipse(x, y, rad * 0.85, rad, Mat.Petal, 1);
  r.glow(x, y, rad, 1, 1.2);
  if (halo > 0) r.haloAt(x, y, halo, haloStrength);
}

/** A trunk that rises out of the element's top edge, with a root flare at `ground`. */
function risingTrunk(r: ElementRaster, rng: Rng, cx: number, ground: number, baseR: number, topR: number, wobble: number): number[] {
  const segs = 16;
  const phase = rng.range(0, 10);
  const lean = rng.range(-1, 1) * Math.min(0.08 * r.h, r.w / 2 - M - topR - wobble * 1.3 - 6);
  const path: number[] = [];
  let px = cx;
  let py = ground + 6;
  let pr = baseR;
  path.push(px, py);
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const x = cx + lean * t + Math.sin(t * 3.7 + phase) * wobble + Math.sin(t * 9.3 + phase * 2) * wobble * 0.3;
    const y = ground + 6 - (ground + 26) * t;
    const rr = baseR + (topR - baseR) * Math.pow(t, 0.7) + Math.sin(t * 13 + phase) * baseR * 0.05;
    r.capsule(px, py, x, y, pr, rr, Mat.Bark, 6);
    px = x;
    py = y;
    pr = rr;
    path.push(px, py);
  }
  return path;
}

/** Point on a polyline path (flat x,y pairs) at fraction t. */
function pathAt(path: readonly number[], t: number): void {
  const n = path.length / 2 - 1;
  const f = Math.min(n - 1e-6, Math.max(0, t * n));
  const i = Math.floor(f);
  const u = f - i;
  P.x = (path[i * 2] as number) + ((path[i * 2 + 2] as number) - (path[i * 2] as number)) * u;
  P.y = (path[i * 2 + 1] as number) + ((path[i * 2 + 3] as number) - (path[i * 2 + 1] as number)) * u;
}

/** A spray of small leaves around a twig tip. */
function sprig(r: ElementRaster, rng: Rng, x: number, y: number, side: number, size: number): void {
  const n = 7 + Math.round(size / 6);
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + side * rng.range(-0.4, 1.3) + rng.range(-0.5, 0.5);
    const d = rng.range(0, size * 0.5);
    const bx = x + Math.cos(a) * d;
    const by = y + Math.sin(a) * d;
    r.leaf(bx, by, a + rng.range(-0.6, 0.6) + (rng.chance(0.5) ? 0.6 : -0.6), size * rng.range(0.35, 0.55), size * 0.1, Mat.Leaf);
  }
}

/** A side branch with a fork, twigs and leaf clumps, starting at (x, y) on the trunk. */
function branch(r: ElementRaster, rng: Rng, x: number, y: number, side: number, len: number, rad: number, leafy: boolean): void {
  // Keep the whole limb (and its sprigs) inside the element rect.
  const room = side > 0 ? r.w - M - 18 - x : x - M - 18;
  len = Math.max(20, Math.min(len, room / 0.95));
  const ex = x + side * len * rng.range(0.65, 0.85);
  const ey = Math.max(M + 30, y - len * rng.range(0.55, 0.9));
  const cx = x + side * len * 0.3;
  const cy = y - len * 0.15;
  r.curve(x, y + rad, cx, cy, ex, ey, rad, rad * 0.25, Mat.Bark, rad * 0.6, 10);
  ElementRaster.bezier(x, y + rad, cx, cy, ex, ey, 0.55, P);
  const fx = P.x;
  const fy = P.y;
  const tx = fx + side * len * rng.range(0.1, 0.3);
  const ty = fy - len * rng.range(0.35, 0.5);
  r.curve(fx, fy, fx + side * 6, fy - len * 0.2, tx, ty, rad * 0.45, rad * 0.15, Mat.Bark, 2, 6);
  if (leafy) {
    sprig(r, rng, ex, ey, side, len * 0.3);
    sprig(r, rng, tx, ty, side, len * 0.22);
  }
  for (let m = 0; m < 3; m++) {
    ElementRaster.bezier(x, y + rad, cx, cy, ex, ey, rng.range(0.3, 0.85), P);
    strand(r, rng, P.x, P.y + rad * 0.3, rng.range(len * 0.15, len * 0.45), 4, 1.3, 0.45, 0, Mat.Moss);
  }
}

// ---------------------------------------------------------------------------------------------

const FAR_FINAL: FinalizeOptions = { fadeBottom: [0.62, 1], rimWidth: 2, rimStrength: 0.7, dispScale: 1.2 };

export const ELEMENT_SPECS: readonly ElementSpec[] = [
  {
    category: 'farTree', variants: 6, w: 160, h: 420, unitsPerTexel: 2, anchorX: 80, anchorY: 420 - M,
    sway: 'none', swayScale: 0, emissive: false, cut: 'none', finalize: FAR_FINAL,
    draw(r, rng, v) {
      const cx = r.w / 2 + rng.range(-5, 5);
      const base = r.h - M;
      const top = M + rng.range(2, 24);
      const kind = v % 3;
      if (kind === 0) {
        // Cloud tree: slender trunk under one big irregular crown.
        const lean = rng.range(-8, 8);
        const cy = top + r.h * rng.range(0.27, 0.32);
        limb(r, cx, base, cx + lean, cy, rng.range(-6, 6), 6.5, 3, Mat.Bark);
        for (let i = 0; i < 3; i++) {
          const s = i % 2 === 0 ? -1 : 1;
          limb(r, cx + lean * 0.6, cy + 80, cx + lean + s * rng.range(24, 44), cy - rng.range(0, 40), 4, 3, 1.5, Mat.Bark, 2, 6);
        }
        cloudCrown(r, rng, cx + lean, cy, rng.range(60, 70), rng.range(100, 118), 42, 14);
      } else if (kind === 1) {
        // Spire: thin trunk with drooping tiers.
        limb(r, cx, base, cx + rng.range(-4, 4), top, 2, 5, 1.2, Mat.Bark);
        const tiers = rng.int(13, 17);
        for (let i = 0; i < tiers; i++) {
          const t = (i + 0.5) / tiers;
          const y = top + 6 + t * r.h * 0.68;
          const hw = 4 + 58 * Math.pow(t, 0.85) * rng.range(0.85, 1.1);
          for (const s of [-1, 1]) {
            r.curve(cx, y, cx + s * hw * 0.55, y + 1, cx + s * hw, y + 12 + 14 * t, 4.5 + 3 * t, 1.2, Mat.Leaf, 3, 5);
          }
          r.ellipse(cx, y + 5, hw * 0.5, 6 + 5 * t, Mat.Leaf, 4);
        }
      } else {
        // Forked tree: two or three limbs, each ending in its own crown at a different height.
        const forkY = top + r.h * rng.range(0.38, 0.46);
        limb(r, cx, base, cx, forkY, rng.range(-5, 5), 7.5, 5, Mat.Bark, 3);
        const limbs = rng.int(2, 3);
        for (let i = 0; i < limbs; i++) {
          const s = limbs === 2 ? (i === 0 ? -1 : 1) : i - 1;
          const ex = cx + s * rng.range(18, 30);
          const ey = Math.max(M + 62, forkY - rng.range(70, 130));
          limb(r, cx, forkY + 8, ex, ey, s * 10, 5, 2.5, Mat.Bark, 3, 8);
          cloudCrown(r, rng, ex, ey - 6, rng.range(36, 44), rng.range(42, 54), 20, 11);
        }
      }
    },
  },
  {
    category: 'farCanopy', variants: 3, w: 320, h: 160, unitsPerTexel: 2, anchorX: 160, anchorY: 160 - M,
    sway: 'none', swayScale: 0, emissive: false, cut: 'none', finalize: { ...FAR_FINAL, fadeBottom: [0.72, 1] },
    draw(r, rng) {
      const base = r.h - M;
      const n = rng.int(5, 7);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const x = M + 34 + t * (r.w - 2 * M - 68) + rng.range(-10, 10);
        const hgt = 60 + Math.sin(t * Math.PI) * 44 * rng.range(0.6, 1.2);
        cloudCrown(r, rng, x, base - hgt * 0.55, rng.range(34, 46), hgt * 0.6, 12, 11);
      }
      r.ellipse(r.w / 2, base - 16, r.w * 0.43, 40, Mat.Leaf, 10);
    },
  },
  {
    category: 'midTrunk', variants: 4, w: 200, h: 660, unitsPerTexel: 2, anchorX: 100, anchorY: 660 - M - 8,
    sway: 'none', swayScale: 0, emissive: false, cut: 'top', stretchFrom: 660 - M - 8 - 90,
    finalize: { rimWidth: 2.2, rimStrength: 1 },
    draw(r, rng, v) {
      const cx = r.w / 2 + rng.range(-6, 6);
      const ground = r.h - M - 8;
      const baseR = rng.range(17, 22);
      const path = risingTrunk(r, rng, cx, ground, baseR, baseR * rng.range(0.5, 0.62), 10);
      roots(r, rng, cx, ground, baseR, rng.range(50, 68), 4 + (v % 2));
      const branches = 1 + (v % 2);
      for (let i = 0; i < branches; i++) {
        pathAt(path, rng.range(0.38, 0.62) + i * 0.12);
        branch(r, rng, P.x, P.y, (i + v) % 2 === 0 ? -1 : 1, rng.range(110, 150), baseR * 0.4, rng.chance(0.8));
      }
    },
  },
  {
    category: 'canopyTop', variants: 3, w: 340, h: 230, unitsPerTexel: 2, anchorX: 170, anchorY: 0,
    sway: 'top', swayScale: 0.25, emissive: false, cut: 'top', finalize: { rimWidth: 3, rimStrength: 0.8 },
    draw(r, rng) {
      const n = rng.int(4, 5);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const x = 78 + t * (r.w - 156) + rng.range(-10, 10);
        const depth = 60 + Math.sin(t * Math.PI) * 60 * rng.range(0.7, 1.2);
        cloudCrown(r, rng, x, depth * 0.35, rng.range(40, 50), depth * 0.72, 16, 13);
      }
      r.ellipse(r.w / 2, -10, r.w * 0.36, 50, Mat.Leaf, 8);
      for (let i = 0; i < 2; i++) {
        const s = i === 0 ? -1 : 1;
        limb(r, r.w / 2 + s * 40, -6, r.w / 2 + s * rng.range(80, 110), rng.range(70, 110), s * 12, 7, 2, Mat.Bark, 3, 8);
      }
      const strands = rng.int(3, 5);
      for (let i = 0; i < strands; i++) {
        strand(r, rng, rng.range(70, r.w - 70), rng.range(50, 90), rng.range(50, r.h - 110), 6, 2, 0.8, 10, Mat.Leaf);
      }
    },
  },
  {
    category: 'midBush', variants: 3, w: 220, h: 110, unitsPerTexel: 2, anchorX: 110, anchorY: 110 - M - 4,
    sway: 'bottom', swayScale: 0.3, emissive: false, cut: 'none', finalize: { rimWidth: 3, rimStrength: 0.9 },
    draw(r, rng) {
      const base = r.h - M - 4;
      const n = rng.int(4, 6);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const x = M + 30 + t * (r.w - 2 * M - 60);
        const hgt = 30 + Math.sin(t * Math.PI) * 28 * rng.range(0.7, 1.2);
        cloudCrown(r, rng, x + rng.range(-6, 6), base - hgt * 0.5, rng.range(20, 28), hgt * 0.55, 8, 8);
      }
      for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        frond(r, rng, r.w / 2 + side * rng.range(20, 60), base - 18, -Math.PI / 2 + side * rng.range(0.4, 0.9),
          rng.range(40, 60), rng.range(6, 14), 9, Mat.Leaf, 1.2);
      }
    },
  },
  {
    category: 'groundEdge', variants: 2, w: 480, h: 100, unitsPerTexel: 2, anchorX: 240, anchorY: 36,
    sway: 'none', swayScale: 0, emissive: false, cut: 'bottom', finalize: { rimWidth: 2, rimStrength: 0.7 },
    draw(r, rng) {
      const n = 7;
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const x = 70 + t * (r.w - 140) + rng.range(-10, 10);
        r.ellipse(x, 60 + rng.range(-6, 6), rng.range(40, 52), rng.range(22, 32), Mat.Leaf, 12);
      }
      r.capsule(64, 92, r.w - 64, 92, 34, 34, Mat.Stone, 10);
      r.ellipse(r.w / 2, r.h + 30, r.w * 0.42, 70, Mat.Stone, 10);
      for (let i = 0; i < 14; i++) {
        const x = rng.range(70, r.w - 70);
        r.ellipse(x, rng.range(40, 52), rng.range(8, 14), rng.range(6, 10), Mat.Leaf, 3);
      }
    },
  },
  {
    category: 'vine', variants: 3, w: 44, h: 300, unitsPerTexel: 1.6, anchorX: 22, anchorY: M,
    sway: 'top', swayScale: 1, emissive: false, cut: 'none', finalize: { rimWidth: 2.5, rimStrength: 1 },
    draw(r, rng, v) {
      const len = r.h - 2 * M - rng.range(0, 40);
      strand(r, rng, r.w / 2, M, len, 7, 2.6, 1.1, 11 + v, Mat.Leaf);
      if (v === 2) strand(r, rng, r.w / 2 + 4, M + 10, len * 0.55, 5, 1.6, 0.8, 8, Mat.Leaf);
    },
  },
  {
    category: 'fern', variants: 3, w: 140, h: 96, unitsPerTexel: 1.5, anchorX: 70, anchorY: 96 - M - 2,
    sway: 'bottom', swayScale: 1, emissive: false, cut: 'none', finalize: { rimWidth: 2.5, rimStrength: 1, dispScale: 0.3 },
    draw(r, rng) {
      const bx = r.w / 2;
      const by = r.h - M - 2;
      const n = rng.int(5, 8);
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const ang = -Math.PI / 2 + (t - 0.5) * 2.4 + rng.range(-0.1, 0.1);
        const len = rng.range(46, 66) * (1 - Math.abs(t - 0.5) * 0.5);
        frond(r, rng, bx + (t - 0.5) * 10, by, ang, len, Math.abs(t - 0.5) * 40 + 6, 12, Mat.Leaf, 1.3);
      }
    },
  },
  {
    category: 'glowFlower', variants: 3, w: 76, h: 116, unitsPerTexel: 1.4, anchorX: 38, anchorY: 116 - M - 2,
    sway: 'bottom', swayScale: 0.9, emissive: true, cut: 'none', finalize: { rimWidth: 2, rimStrength: 0.8, dispScale: 0.3 },
    draw(r, rng) {
      const bx = r.w / 2;
      const by = r.h - M - 2;
      const stems = rng.int(1, 3);
      for (let i = 0; i < stems; i++) {
        const lean = rng.range(-16, 16);
        const hgt = rng.range(52, 78);
        const tx = bx + lean;
        const ty = by - hgt;
        r.curve(bx + (i - 1) * 3, by, bx + lean * 0.2, by - hgt * 0.6, tx, ty, 1.8, 1, Mat.Stem, 0, 6);
        glowBulb(r, tx + lean * 0.12, ty + 5, rng.range(5, 7), 26, 0.34);
      }
      r.leaf(bx, by - 2, -Math.PI / 2 - 0.9, 22, 5, Mat.Leaf);
      r.leaf(bx, by - 2, -Math.PI / 2 + 0.8, 20, 5, Mat.Leaf);
    },
  },
  {
    category: 'nearTrunk', variants: 3, w: 280, h: 900, unitsPerTexel: 1.4, anchorX: 140, anchorY: 900 - M - 10,
    sway: 'none', swayScale: 0, emissive: true, cut: 'top', stretchFrom: 900 - M - 10 - 150,
    finalize: { rimWidth: 3, rimStrength: 1.1, detail: 1.1 },
    draw(r, rng, v) {
      const cx = r.w / 2 + rng.range(-10, 10);
      const ground = r.h - M - 10;
      const baseR = rng.range(30, 36);
      const path = risingTrunk(r, rng, cx, ground, baseR, baseR * rng.range(0.52, 0.62), 18);
      roots(r, rng, cx, ground, baseR, rng.range(84, 108), 6);
      const s = rng.chance(0.5) ? -1 : 1;
      // A root arch sweeping out on one side.
      const arch = Math.min(116, s < 0 ? cx - M - 12 : r.w - M - 12 - cx);
      r.curve(cx + s * baseR * 0.4, ground - baseR * 1.8, cx + s * arch * 0.64, ground - 76, cx + s * arch, ground + 2, 9, 3, Mat.Bark, 6, 10);
      pathAt(path, rng.range(0.45, 0.6));
      branch(r, rng, P.x, P.y, -s, rng.range(150, 190), baseR * 0.42, true);
      if (v === 2) {
        pathAt(path, rng.range(0.7, 0.8));
        branch(r, rng, P.x, P.y, s, rng.range(110, 140), baseR * 0.34, true);
      }
      // Moss cushions on the lit (left) shoulder.
      for (let m = 0; m < 6; m++) {
        pathAt(path, rng.range(0.15, 0.85));
        r.ellipse(P.x - baseR * 0.62, P.y, 7, rng.range(10, 20), Mat.Moss, 3);
      }
      if (v !== 1) {
        // A few small glowing shelf fungi low on the shaded side.
        pathAt(path, rng.range(0.06, 0.12));
        const fx = P.x + baseR * 0.78 * s;
        for (let f = 0; f < 2; f++) {
          const fy = P.y - f * rng.range(14, 22);
          r.ellipse(fx + s * 5, fy, 7 - f * 2, 2.6, Mat.Fungus, 1);
          r.glow(fx + s * 5, fy + 0.5, 5 - f * 1.5, 0.75, 1);
        }
        r.haloAt(fx + s * 5, P.y - 8, 22, 0.16);
      }
    },
  },
  {
    category: 'rootArch', variants: 2, w: 360, h: 170, unitsPerTexel: 1.4, anchorX: 180, anchorY: 170 - M - 4,
    sway: 'none', swayScale: 0, emissive: true, cut: 'none', finalize: { rimWidth: 3.5, rimStrength: 1.1 },
    draw(r, rng, v) {
      const g = r.h - M - 4;
      const n = 2 + v;
      for (let i = 0; i < n; i++) {
        const x0 = M + 20 + rng.range(0, 60);
        const x1 = r.w - M - 20 - rng.range(0, 60);
        const hgt = rng.range(70, 130);
        r.curve(x0, g + 2, (x0 + x1) / 2 + rng.range(-40, 40), g - hgt * 1.9, x1, g + 2, rng.range(9, 13), rng.range(5, 8), Mat.Bark, 5, 16);
      }
      for (let i = 0; i < 6; i++) {
        const x = rng.range(M + 30, r.w - M - 30);
        r.curve(x, g - rng.range(20, 60), x + rng.range(-20, 20), g - 10, x + rng.range(-30, 30), g + 2, 3.5, 1.5, Mat.Bark, 2, 5);
      }
      r.ellipse(r.w / 2, g, r.w * 0.4, 8, Mat.Bark, 6);
      mushroom(r, rng, r.w * 0.3, g - 2, 10, 7, 1, 0.9);
      mushroom(r, rng, r.w * 0.34, g - 2, 7, 5, -1, 0.9);
      r.haloAt(r.w * 0.32, g - 12, 30, 0.22);
    },
  },
  {
    category: 'mushrooms', variants: 3, w: 104, h: 84, unitsPerTexel: 1.1, anchorX: 52, anchorY: 84 - M - 3,
    sway: 'none', swayScale: 0, emissive: true, cut: 'none', finalize: { rimWidth: 2, rimStrength: 0.9 },
    draw(r, rng) {
      const g = r.h - M - 3;
      const n = rng.int(3, 6);
      for (let i = 0; i < n; i++) {
        const x = r.w / 2 + rng.range(-26, 26);
        const big = i === 0;
        mushroom(r, rng, x, g, big ? rng.range(26, 34) : rng.range(10, 22), big ? rng.range(12, 15) : rng.range(5, 9), rng.range(-6, 6), 1);
      }
      r.ellipse(r.w / 2, g + 1, 34, 4, Mat.Moss, 3);
      r.haloAt(r.w / 2, g - 22, 44, 0.3);
    },
  },
  {
    category: 'rock', variants: 3, w: 140, h: 92, unitsPerTexel: 1.6, anchorX: 70, anchorY: 92 - M - 2,
    sway: 'none', swayScale: 0, emissive: false, cut: 'none', finalize: { rimWidth: 3, rimStrength: 1.1 },
    draw(r, rng) {
      const g = r.h - M - 2;
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        const rx = i === 0 ? rng.range(40, 54) : rng.range(18, 30);
        const ry = rx * rng.range(0.55, 0.8);
        const x = r.w / 2 + (i === 0 ? 0 : rng.range(-50, 50));
        r.ellipse(x, g - ry * 0.7, rx, ry, Mat.Stone, 4);
        r.ellipse(x - rx * 0.1, g - ry * 1.35, rx * 0.72, ry * 0.22, Mat.Moss, 2);
      }
      r.ellipse(r.w / 2, g, 56, 6, Mat.Stone, 6);
    },
  },
  {
    category: 'fgBottom', variants: 3, w: 320, h: 190, unitsPerTexel: 2.2, anchorX: 160, anchorY: 190,
    sway: 'bottom', swayScale: 0.45, emissive: false, cut: 'bottom', finalize: { softness: 9, rimWidth: 0, dispScale: 0.8 },
    draw(r, rng) {
      const g = r.h + 6;
      const n = rng.int(5, 7);
      for (let i = 0; i < n; i++) {
        const x = 70 + ((i + rng.range(-0.3, 0.3)) / Math.max(1, n - 1)) * (r.w - 140);
        const ang = -Math.PI / 2 + rng.range(-0.9, 0.9);
        const len = fitLength(r, x, g, ang, rng.range(80, 140), 24);
        r.leaf(x, g, ang, len, len * rng.range(0.26, 0.34), Mat.Soft);
      }
      for (let i = 0; i < 2; i++) {
        const x = rng.range(100, r.w - 100);
        const ang = -Math.PI / 2 + rng.range(-0.5, 0.5);
        frond(r, rng, x, g, ang, fitLength(r, x, g, ang, rng.range(100, 140), 50), 40, 28, Mat.Soft, 3);
      }
      r.ellipse(r.w / 2, g + 10, r.w * 0.38, 44, Mat.Soft, 14);
    },
  },
  {
    category: 'fgTop', variants: 3, w: 320, h: 200, unitsPerTexel: 2.2, anchorX: 160, anchorY: 0,
    sway: 'top', swayScale: 0.45, emissive: false, cut: 'top', finalize: { softness: 9, rimWidth: 0, dispScale: 0.8 },
    draw(r, rng) {
      const s = rng.chance(0.5) ? -1 : 1;
      const x0 = r.w / 2 - s * rng.range(40, 80);
      const x1 = r.w / 2 + s * rng.range(90, 120);
      const y1 = rng.range(50, 80);
      r.curve(x0, -12, (x0 + x1) / 2, rng.range(30, 50), x1, y1, 15, 6, Mat.Soft, 6, 12);
      const n = rng.int(7, 10);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        ElementRaster.bezier(x0, -12, (x0 + x1) / 2, 40, x1, y1, t, P);
        const bx = P.x;
        const by = P.y;
        const ang = Math.PI / 2 + rng.range(-0.8, 0.8);
        const len = fitLength(r, bx, by, ang, rng.range(60, 115), 20);
        r.leaf(bx, by, ang, len, len * rng.range(0.16, 0.22), Mat.Soft);
      }
      r.ellipse(x0, -6, 70, 34, Mat.Soft, 10);
      for (let i = 0; i < 2; i++) strand(r, rng, rng.range(90, r.w - 90), 20, rng.range(80, 140), 10, 3, 1.5, 16, Mat.Soft);
    },
  },
  {
    category: 'fgVine', variants: 2, w: 48, h: 330, unitsPerTexel: 2.2, anchorX: 24, anchorY: 0,
    sway: 'top', swayScale: 1, emissive: false, cut: 'top', finalize: { softness: 6, rimWidth: 0, dispScale: 0.5 },
    draw(r, rng) {
      strand(r, rng, r.w / 2, -4, r.h - M - rng.range(10, 60), 8, 3.4, 1.6, 17, Mat.Soft);
    },
  },
  {
    category: 'grass', variants: 6, w: 72, h: 50, unitsPerTexel: 1, anchorX: 36, anchorY: 50 - M - 2,
    sway: 'bottom', swayScale: 1.3, emissive: false, cut: 'none', finalize: { rimWidth: 1.8, rimStrength: 1, dispScale: 0.15 },
    draw(r, rng, v) {
      const g = r.h - M - 1;
      const n = rng.int(8, 14);
      const spread = 18 + (v % 3) * 6;
      for (let i = 0; i < n; i++) {
        const x = r.w / 2 + rng.range(-spread, spread);
        const lean = Math.max(M + 6 - x, Math.min(r.w - M - 6 - x, (x - r.w / 2) * 0.5 + rng.range(-10, 10)));
        const len = rng.range(18, 34) * (1 - Math.abs(x - r.w / 2) / (spread * 2.4));
        r.curve(x, g + 2, x + lean * 0.3, g - len * 0.6, x + lean, g - len, 1.9, 0.35, Mat.Leaf, 0, 6);
      }
    },
  },
  {
    category: 'flower', variants: 4, w: 40, h: 58, unitsPerTexel: 1, anchorX: 20, anchorY: 58 - M - 1,
    sway: 'bottom', swayScale: 1.1, emissive: true, cut: 'none', finalize: { rimWidth: 1.5, rimStrength: 0.8, dispScale: 0.2 },
    draw(r, rng, v) {
      const g = r.h - M - 1;
      const x = r.w / 2;
      const hgt = rng.range(22, 34);
      const lean = rng.range(-6, 6);
      r.curve(x, g + 2, x + lean * 0.2, g - hgt * 0.6, x + lean, g - hgt, 1.3, 0.8, Mat.Stem, 0, 5);
      if (v % 2 === 0) {
        glowBulb(r, x + lean, g - hgt - 2, 3.4, 14, 0.4);
      } else {
        for (let p = 0; p < 5; p++) r.leaf(x + lean, g - hgt, (p / 5) * Math.PI * 2, 6, 2.2, Mat.Petal);
        r.glow(x + lean, g - hgt, 5, 1, 1.5);
        r.haloAt(x + lean, g - hgt, 14, 0.36);
      }
      r.leaf(x, g - 3, -Math.PI / 2 - 0.9, 10, 2.6, Mat.Leaf);
    },
  },
  {
    category: 'shroom', variants: 3, w: 44, h: 40, unitsPerTexel: 1, anchorX: 22, anchorY: 40 - M - 1,
    sway: 'none', swayScale: 0, emissive: true, cut: 'none', finalize: { rimWidth: 1.5, rimStrength: 0.8 },
    draw(r, rng) {
      const g = r.h - M - 1;
      const n = rng.int(1, 3);
      for (let i = 0; i < n; i++) {
        mushroom(r, rng, r.w / 2 + (i - (n - 1) / 2) * 8, g + 1, i === 0 ? rng.range(10, 15) : rng.range(6, 9), i === 0 ? 6 : 4, rng.range(-3, 3), 1);
      }
      r.haloAt(r.w / 2, g - 10, 18, 0.3);
    },
  },
  {
    category: 'floraBig', variants: 2, w: 124, h: 176, unitsPerTexel: 1.1, anchorX: 62, anchorY: 176 - M - 2,
    sway: 'bottom', swayScale: 0.8, emissive: true, cut: 'none', finalize: { rimWidth: 2.5, rimStrength: 1, dispScale: 0.25 },
    draw(r, rng) {
      const g = r.h - M - 2;
      const x = r.w / 2;
      for (let i = 0; i < 5; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        r.leaf(x + side * 4, g, -Math.PI / 2 + side * rng.range(0.35, 1.15), rng.range(44, 62), rng.range(9, 13), Mat.Leaf);
      }
      const stems = rng.int(2, 4);
      for (let i = 0; i < stems; i++) {
        const lean = rng.range(-30, 30);
        const hgt = rng.range(96, 136);
        const tx = x + lean;
        const ty = g - hgt;
        r.curve(x, g, x + lean * 0.1, g - hgt * 0.7, tx, ty, 2.4, 1.3, Mat.Stem, 0, 8);
        glowBulb(r, tx + lean * 0.08, ty + 8, rng.range(7, 10), 0, 0);
        r.glow(tx + lean * 0.08, ty + 8, 13, 0.55, 5);
      }
      r.haloAt(x, g - 110, 62, 0.3);
    },
  },
  {
    category: 'lantern', variants: 2, w: 124, h: 160, unitsPerTexel: 1, anchorX: 44, anchorY: 160 - M - 2,
    sway: 'none', swayScale: 0, emissive: true, cut: 'none', finalize: { rimWidth: 2, rimStrength: 1 },
    draw(r, rng, v) {
      const g = r.h - M - 2;
      const px = 44;
      const topY = g - (v === 0 ? 118 : 96);
      r.capsule(px, g + 2, px + rng.range(-2, 2), topY, 3.4, 2.6, Mat.Wood, 1);
      r.capsule(px - 5, g + 1, px + 5, g + 1, 2.5, 2.5, Mat.Wood, 1);
      let lx = px;
      let ly = topY - 16;
      if (v === 0) {
        // Arm with a hanging lantern.
        r.curve(px, topY + 6, px + 16, topY - 6, px + 34, topY + 2, 2.2, 1.6, Mat.Wood, 1, 6);
        r.capsule(px + 34, topY + 2, px + 34, topY + 14, 0.7, 0.7, Mat.Stem);
        lx = px + 34;
        ly = topY + 30;
      }
      r.capsule(lx - 6, ly - 17, lx + 6, ly - 17, 2, 2, Mat.Wood);
      r.ellipse(lx, ly, 11, 15, Mat.Paper, 1);
      r.capsule(lx - 5, ly + 15, lx + 5, ly + 15, 1.6, 1.6, Mat.Wood);
      r.capsule(lx, ly + 16, lx, ly + 24, 0.8, 0.4, Mat.Stem);
      r.glow(lx, ly, 10.5, 1, 1.5);
      r.haloAt(lx, ly, 36, 0.34);
    },
  },
  {
    category: 'bramble', variants: 3, w: 104, h: 74, unitsPerTexel: 1, anchorX: 52, anchorY: 74 - M - 2,
    sway: 'bottom', swayScale: 0.25, emissive: true, cut: 'none', finalize: { rimWidth: 1.6, rimStrength: 0.6, dispScale: 0.2 },
    draw(r, rng) {
      const g = r.h - M - 2;
      const n = rng.int(5, 7);
      for (let i = 0; i < n; i++) {
        const x0 = r.w / 2 + rng.range(-20, 20);
        const x1 = Math.max(M + 14, Math.min(r.w - M - 14, x0 + rng.range(-40, 40)));
        const y1 = g - rng.range(26, 54);
        const cx = (x0 + x1) / 2 + rng.range(-16, 16);
        const cy = y1 - rng.range(4, 16);
        r.curve(x0, g + 2, cx, cy, x1, y1, 2.8, 1, Mat.Stem, 1, 8);
        for (let t = 0.2; t < 0.95; t += rng.range(0.12, 0.18)) {
          ElementRaster.bezier(x0, g + 2, cx, cy, x1, y1, t, P);
          const px = P.x;
          const py = P.y;
          ElementRaster.bezier(x0, g + 2, cx, cy, x1, y1, t + 0.02, P);
          const dir = Math.atan2(P.y - py, P.x - px) + (rng.chance(0.5) ? 1 : -1) * rng.range(0.9, 1.4);
          const len = rng.range(4, 7) * (1.1 - t * 0.5);
          r.capsule(px, py, px + Math.cos(dir) * len, py + Math.sin(dir) * len, 1.3, 0.1, Mat.Stem);
          if (rng.chance(0.3)) r.glow(px + Math.cos(dir) * len, py + Math.sin(dir) * len, 1.4, 1, 0.8);
        }
        r.glow(x1, y1, 2.2, 1, 1);
        r.haloAt(x1, y1, 9, 0.4);
      }
    },
  },
  {
    category: 'tendril', variants: 3, w: 48, h: 176, unitsPerTexel: 1, anchorX: 24, anchorY: M,
    sway: 'top', swayScale: 0.9, emissive: true, cut: 'none', finalize: { rimWidth: 2, rimStrength: 0.9, dispScale: 0.3 },
    draw(r, rng, v) {
      const n = rng.int(2, 4);
      for (let i = 0; i < n; i++) {
        const x = r.w / 2 + rng.range(-8, 8);
        const len = rng.range(60, r.h - 2 * M - 10) * (i === 0 ? 1 : 0.7);
        strand(r, rng, x, M + 4, len, 8, i === 0 ? 3.2 : 2.2, 0.5, 0, Mat.Bark);
        if (v === 1 && i === 0) {
          r.circle(x, M + len, 2.4, Mat.Petal);
          r.glow(x, M + len, 2.4, 1, 1);
          r.haloAt(x, M + len, 12, 0.35);
        }
      }
      r.ellipse(r.w / 2, M + 5, 14, 4, Mat.Bark, 3);
    },
  },
  {
    category: 'bridge', variants: 2, w: 320, h: 64, unitsPerTexel: 1, anchorX: 160, anchorY: M + 18,
    sway: 'none', swayScale: 0, emissive: false, cut: 'none', finalize: { rimWidth: 2.5, rimStrength: 1.1 },
    draw(r, rng) {
      const top = M + 18;
      const x0 = M + 14;
      const x1 = r.w - M - 14;
      // Log body: flat walkable top at `top`, a slight belly below.
      r.curve(x0, top + 9, r.w / 2, top + 13, x1, top + 9, 9.5, 8.5, Mat.Wood, 2, 16);
      r.capsule(x0 + 6, top + 4, x1 - 6, top + 4, 4, 4, Mat.Wood, 4);
      for (let i = 0; i < 3; i++) {
        const x = rng.range(x0 + 30, x1 - 30);
        r.curve(x, top + 6, x + rng.range(-8, 8), top - 4, x + rng.range(-14, 14), top - rng.range(8, 14), 2.2, 0.8, Mat.Wood, 1, 4);
        r.leaf(x + rng.range(-10, 10), top - 8, -Math.PI / 2 + rng.range(-1, 1), 9, 2.4, Mat.Leaf);
      }
      for (let i = 0; i < 6; i++) strand(r, rng, rng.range(x0 + 8, x1 - 8), top + 17, rng.range(8, 24), 2, 1.2, 0.4, 0, Mat.Moss);
      for (let i = 0; i < 5; i++) r.ellipse(rng.range(x0 + 10, x1 - 10), top + 1, rng.range(8, 16), 2.4, Mat.Moss, 2);
    },
  },
  {
    category: 'solid', variants: 1, w: 24, h: 24, unitsPerTexel: 1, anchorX: 12, anchorY: 12,
    sway: 'none', swayScale: 0, emissive: false, cut: 'none', finalize: { rimWidth: 0, softness: 0.5, detail: 0 },
    draw(r) {
      r.ellipse(12, 12, 40, 40, Mat.Stone);
    },
  },
];
