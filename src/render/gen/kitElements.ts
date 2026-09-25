import { MAX_ASPECT, VIEW_H } from '../../config.ts';
import type { Rng } from '../../core/rng.ts';
import { QUALITY_PRESETS } from '../../settings/quality.ts';
import { renderScaleCap } from '../post/viewport.ts';
import { STROKE, strokeWidthTexels, type StrokeOptions } from './brush.ts';
import { ElementRaster, Mat, type FinalizeOptions } from './raster.ts';
import {
  broadTree, canopyCeiling, clump, coniferTree, LEAFY, midBirchPair, midCrown, nearTrunk, midConiferTrunk, midOakTrunk, midWillowTrunk, slenderTree, snagTree,
  willowTree,
} from './trees.ts';

/** Transparent border inside element rects (≥ the hull pad, so mip fringes stay inside the rect). */
export const ELEMENT_MARGIN = 6;

export const KIT_CATEGORIES = [
  'farTree', 'farCanopy', 'midTrunk', 'midCrown', 'canopyTop', 'midBush', 'groundEdge', 'vine', 'fern', 'glowFlower',
  'nearTrunk', 'rootArch', 'mushrooms', 'rock', 'fgBottom', 'fgTop', 'fgVine', 'grass', 'flower', 'shroom',
  'floraBig', 'lantern', 'bramble', 'tendril', 'bridge', 'solid',
] as const;
export type KitCategory = (typeof KIT_CATEGORIES)[number];

/** Which end of an element is fixed when it sways ('none' = static). */
export type SwayAnchor = 'none' | 'bottom' | 'top';

export interface ElementSpec {
  category: KitCategory;
  /** Seed key (defaults to the category); distinct specs of one category need distinct keys. */
  key?: string;
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
/** Texel density of the (baked-soft) foreground frame elements relative to their 2.2 u/texel design. */
const FG_K = 2 / 3;

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

/** A frond: curved rib with leaflets on both sides shrinking toward the tip. */
function frond(r: ElementRaster, rng: Rng, bx: number, by: number, ang: number, len: number, droop: number, leaf: number, mat: Mat, ribR = 1.4): void {
  const ex = bx + Math.cos(ang) * len;
  const ey = by + Math.sin(ang) * len + droop;
  const cx = bx + Math.cos(ang) * len * 0.55;
  const cy = by + Math.sin(ang) * len * 0.55 - droop * 0.2;
  r.frameLine(bx, by, ex, ey);
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
  r.releaseFrame();
}

/** Hanging strand with alternating small leaves (vines, moss). */
function strand(r: ElementRaster, rng: Rng, x: number, y: number, len: number, sway: number, r0: number, r1: number, leaf: number, mat: Mat): void {
  const ex = x + rng.range(-sway, sway);
  const ey = y + len;
  const cx = x + rng.range(-sway, sway) * 1.6;
  const cy = y + len * 0.5;
  r.frameLine(x, y, ex, ey);
  r.curve(x, y, cx, cy, ex, ey, r0, r1, mat, 0, 10);
  if (leaf > 0) {
    const n = Math.round(len / (leaf * 0.85));
    for (let i = 1; i < n; i++) {
      const t = i / n + rng.range(-0.02, 0.02);
      ElementRaster.bezier(x, y, cx, cy, ex, ey, t, P);
      const side = i % 2 === 0 ? 1 : -1;
      const size = leaf * rng.range(0.7, 1.15) * (1 - t * 0.35);
      r.leaf(P.x, P.y, Math.PI / 2 + side * rng.range(0.5, 1.0), size, size * 0.32, mat);
    }
  }
  r.releaseFrame();
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

// ---------------------------------------------------------------------------------------------

const FAR_FINAL: FinalizeOptions = { fadeBottom: [0.66, 1], rimWidth: 1.6, rimStrength: 0.7, softness: 1.3 };

type TreeFn = (r: ElementRaster, rng: Rng, cx: number, ground: number, s: number) => void;

/** Far trees are stored at this fraction of their 2 u/texel design density (they are the softest layers). */
const FAR_K = 0.8;

/** A far-layer tree archetype spec (whole tree standing on the anchor, fading into mist at its base). */
function farArchetype(key: string, fn: TreeFn, w: number, h: number, variants: number): ElementSpec {
  const tw = Math.round(w * FAR_K);
  const th = Math.round(h * FAR_K);
  return {
    category: 'farTree', key, variants, w: tw, h: th, unitsPerTexel: 2 / FAR_K, anchorX: Math.round(tw / 2), anchorY: th - M,
    sway: 'none', swayScale: 0, emissive: false, cut: 'none', finalize: FAR_FINAL,
    draw(r, rng) {
      fn(r, rng, r.w / 2 + rng.range(-3, 3), r.h - M - 2, FAR_K);
    },
  };
}

/** Near trunks stretch above this texel row (everything organic sits below it). */
const NEAR_STRETCH = 240;

/** Mid-layer trunk rects: the rows above MID_STRETCH are a plain column that placement stretches. */
const MID_H = 620;
const MID_STRETCH = 170;

type TrunkFn = (r: ElementRaster, rng: Rng, cx: number, ground: number, stretchRow: number, s: number) => void;

function midTrunkSpec(key: string, fn: TrunkFn, w: number, variants = 1): ElementSpec {
  const ground = MID_H - M - 8;
  return {
    category: 'midTrunk', key, variants, w, h: MID_H, unitsPerTexel: 2, anchorX: w / 2, anchorY: ground,
    sway: 'none', swayScale: 0, emissive: false, cut: 'top', stretchFrom: MID_STRETCH,
    finalize: { rimWidth: 2.2, rimStrength: 1 },
    draw(r, rng) {
      fn(r, rng, r.w / 2 + rng.range(-5, 5), ground, MID_STRETCH, 1);
    },
  };
}

/**
 * Painterly strokes (ARCHITECTURE.md §5.5): the finest stroke width per category, in layer units at
 * the element's own scale (converted with its unitsPerTexel). Far planes take broad strokes (few
 * per tree), near ones finer; decor is small and seen up close.
 */
export const STROKE_UNITS: Readonly<Record<KitCategory, number>> = {
  farTree: 10, farCanopy: 10, midTrunk: 8, midCrown: 8, canopyTop: 8, midBush: 8, groundEdge: 8, vine: 8, fern: 8, glowFlower: 8,
  nearTrunk: 9, rootArch: 9, mushrooms: 7, rock: 8, fgBottom: 10, fgTop: 10, fgVine: 10, grass: 6, flower: 6, shroom: 6,
  floraBig: 7, lantern: 6, bramble: 6, tendril: 6, bridge: 7, solid: 8,
};

/**
 * Smallest instance scale each category is drawn at (layer scale × recipe stream range; decor from
 * src/render/fx/decorPlacement.ts: min |sx|, |sy|, and for bridge logs |sy|, since they stretch only
 * along their strokes), so strokes stay ≥ 2 px at the minimum render scale. tests/world/strokes.test.ts
 * checks them against the manifest's recipes and against decor placed by placeDecor.
 */
export const MIN_INSTANCE_SCALE: Readonly<Record<KitCategory, number>> = {
  farTree: 0.36, farCanopy: 0.25, midTrunk: 0.62, midCrown: 0.62, canopyTop: 0.55, midBush: 0.49, groundEdge: 0.55, vine: 0.49,
  fern: 0.55, glowFlower: 0.55, nearTrunk: 0.85, rootArch: 0.76, mushrooms: 0.85, rock: 0.49, fgBottom: 0.42, fgTop: 0.42,
  fgVine: 0.33, grass: 0.6, flower: 0.85, shroom: 0.8, floraBig: 0.95, lantern: 1, bramble: 0.45, tendril: 0.7, bridge: 0.9,
  solid: 1,
};

/**
 * The fewest screen pixels per layer unit the game renders at: every quality preset at its dynamic-
 * resolution floor (minRenderScale) on the widest supported canvas (MAX_ASPECT), large enough that the
 * preset's pixel budget caps its render scale (a bigger canvas renders the same pixels; a smaller one
 * is a smaller window than the preset is sized for). Low: 0.388 px/u. (The camera never zooms out.)
 */
export function minPxPerUnit(): number {
  let min = Infinity;
  for (const q of Object.values(QUALITY_PRESETS)) {
    // The first canvas height at which the pixel budget, not renderScale, sets the render scale.
    const h = Math.ceil(Math.sqrt(q.maxRenderPixels / MAX_ASPECT) / q.renderScale) + 1;
    const w = Math.round(h * MAX_ASPECT);
    const maxScale = Math.min(q.renderScale, renderScaleCap(w, h, q.maxRenderPixels));
    const minScale = Math.min(maxScale, maxScale * (q.minRenderScale / q.renderScale));
    min = Math.min(min, (h * minScale) / VIEW_H);
  }
  return min;
}

/** minPxPerUnit(), evaluated once: strokes are ≥ STROKE.minPixels wide there. */
export const MIN_PX_PER_UNIT = minPxPerUnit();

/**
 * Stroke gain of the mid and near planes (L4–L8), so their strokes read at 1:1 (art direction, M2 GPU
 * review: 1.5× the gain-1 visibility). It multiplies the strokes only, not the dry-brush edges or the
 * rim mask, so it sits above 1.5: the post-grade |Δ luma| on L4–L8 pixels comes out ×1.53.
 */
export const STROKE_NEAR_GAIN = 1.75;

/**
 * Stroke gain of the kit shading that shows each category (StrokeOptions.gain; the layer's
 * `strokeGain`): the mid and near planes STROKE_NEAR_GAIN; the far planes (already fogged), the
 * frame (dark, soft) and gameplay decor (its own shading, DECOR_SHADE) 1. Every category of one layer
 * must share its value (kitShadeParams checks it).
 */
export const STROKE_GAIN: Readonly<Record<KitCategory, number>> = {
  farTree: 1, farCanopy: 1, midTrunk: STROKE_NEAR_GAIN, midCrown: STROKE_NEAR_GAIN, canopyTop: STROKE_NEAR_GAIN,
  midBush: STROKE_NEAR_GAIN, groundEdge: STROKE_NEAR_GAIN, vine: STROKE_NEAR_GAIN, fern: STROKE_NEAR_GAIN,
  glowFlower: STROKE_NEAR_GAIN, nearTrunk: STROKE_NEAR_GAIN, rootArch: STROKE_NEAR_GAIN, mushrooms: STROKE_NEAR_GAIN,
  rock: STROKE_NEAR_GAIN, fgBottom: 1, fgTop: 1, fgVine: 1, grass: 1, flower: 1, shroom: 1, floraBig: 1, lantern: 1,
  bramble: 1, tendril: 1, bridge: 1, solid: STROKE_NEAR_GAIN,
};

/** The stroke options of an element spec (every kit element is painted; `solid` has no detail to stroke). */
export function strokeOptionsFor(spec: Pick<ElementSpec, 'category' | 'unitsPerTexel'>): StrokeOptions {
  return {
    width: strokeWidthTexels(STROKE_UNITS[spec.category], spec.unitsPerTexel, MIN_INSTANCE_SCALE[spec.category], MIN_PX_PER_UNIT),
    stretch: STROKE.stretch,
    amount: STROKE.amount,
    rim: STROKE.rim,
    dry: STROKE.dry,
    gain: STROKE_GAIN[spec.category],
  };
}

function painted(specs: readonly ElementSpec[]): readonly ElementSpec[] {
  return specs.map((s) => ({ ...s, finalize: { ...s.finalize, strokes: strokeOptionsFor(s) } }));
}

export const ELEMENT_SPECS: readonly ElementSpec[] = painted([
  farArchetype('farBroad', broadTree, 300, 400, 2),
  farArchetype('farWillow', willowTree, 280, 400, 2),
  farArchetype('farSlender', slenderTree, 150, 430, 1),
  farArchetype('farConifer', coniferTree, 160, 440, 3),
  farArchetype('farSnag', snagTree, 170, 380, 1),
  {
    category: 'farCanopy', variants: 2, w: 360, h: 150, unitsPerTexel: 2, anchorX: 180, anchorY: 150 - M,
    sway: 'none', swayScale: 0, emissive: false, cut: 'none', finalize: { ...FAR_FINAL, fadeBottom: [0.55, 1] },
    draw(r, rng) {
      // A continuous far treeline: fused crowns of different kinds with spires poking through.
      const base = r.h - M;
      let x = M + 18;
      while (x < r.w - M - 18) {
        const kind = rng.next();
        if (kind < 0.35) {
          const h = rng.range(60, 110);
          const hw = rng.range(10, 16);
          r.volume(x - 4, base - h * 0.6, h * 0.5, 0.14);
          r.frameLine(x, base - h, x, base);
          for (let t = 0; t < 7; t++) {
            const u = t / 7;
            const y = base - h + u * h * 0.9;
            r.ellipse(x + rng.range(-2, 2), y + 6, 3 + hw * u * rng.range(0.7, 1.2), 3 + 3 * u, Mat.Needle, 2);
          }
          r.releaseFrame();
          r.noVolume();
          r.capsule(x, base - h, x, base, 1.5, 3, Mat.Bark, 1);
          x += hw * rng.range(1.1, 1.8);
        } else {
          const rx = rng.range(20, 36);
          const ry = rx * rng.range(0.7, 1.1);
          const cy = base - ry - rng.range(10, 45);
          clump(r, rng, x + rx * 0.5, cy, rx, ry, { ...LEAFY, lobes: 5, tufts: 4, holes: 0.3 });
          x += rx * rng.range(1.0, 1.6);
        }
      }
      r.volume(r.w / 2, base - 30, r.w * 0.5, 0.05, -0.04);
      r.ellipse(r.w / 2, base - 8, r.w * 0.44, 24, Mat.Leaf, 10);
      r.noVolume();
    },
  },
  midTrunkSpec('midOak', midOakTrunk, 300, 2),
  midTrunkSpec('midWillow', midWillowTrunk, 260),
  midTrunkSpec('midConifer', midConiferTrunk, 220),
  midTrunkSpec('midBirch', midBirchPair, 170),
  {
    category: 'midCrown', variants: 2, w: 360, h: 250, unitsPerTexel: 2, anchorX: 180, anchorY: 125,
    sway: 'none', swayScale: 0, emissive: false, cut: 'none', finalize: { rimWidth: 2.2, rimStrength: 1 },
    draw(r, rng) {
      midCrown(r, rng, 1);
    },
  },
  {
    category: 'canopyTop', variants: 2, w: 340, h: 230, unitsPerTexel: 2, anchorX: 170, anchorY: 0,
    sway: 'top', swayScale: 0.25, emissive: false, cut: 'top', finalize: { rimWidth: 3, rimStrength: 0.8 },
    draw(r, rng) {
      canopyCeiling(r, rng, 1);
    },
  },
  {
    category: 'midBush', variants: 3, w: 220, h: 110, unitsPerTexel: 2, anchorX: 110, anchorY: 110 - M - 4,
    sway: 'bottom', swayScale: 0.3, emissive: false, cut: 'none', finalize: { rimWidth: 3, rimStrength: 0.9 },
    draw(r, rng) {
      // A low shrub: heaped clumps with fern fronds and leaf sprays breaking the outline.
      const base = r.h - M - 4;
      const n = rng.int(3, 5);
      for (let i = 0; i < 4; i++) {
        const side = i % 2 === 0 ? -1 : 1;
        frond(r, rng, r.w / 2 + side * rng.range(24, 64), base - 10, -Math.PI / 2 + side * rng.range(0.5, 1.0),
          rng.range(40, 58), rng.range(8, 16), 9, Mat.Leaf, 1.2);
      }
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        const x = 50 + t * (r.w - 100) + rng.range(-8, 8);
        const hgt = 22 + Math.sin(t * Math.PI) * 22 * rng.range(0.8, 1.2);
        clump(r, rng, x, base - hgt * 0.75, rng.range(20, 28), hgt * 0.7, { ...LEAFY, lobes: 5, tufts: 5, flat: -0.02 });
      }
      r.ellipse(r.w / 2, base - 4, r.w * 0.36, 8, Mat.Leaf, 6);
    },
  },
  {
    category: 'groundEdge', variants: 2, w: 480, h: 100, unitsPerTexel: 2, anchorX: 240, anchorY: 36,
    sway: 'none', swayScale: 0, emissive: false, cut: 'bottom', finalize: { rimWidth: 2, rimStrength: 0.7 },
    draw(r, rng) {
      // An earth bank whose top edge is broken by low clumps, stones and grass blades.
      r.volume(r.w / 2, 30, r.w * 0.5, 0.06, -0.02);
      r.strokeFrame('xy');
      r.capsule(64, 92, r.w - 64, 92, 36, 36, Mat.Stone, 10);
      r.ellipse(r.w / 2, r.h + 30, r.w * 0.42, 70, Mat.Stone, 10);
      r.strokeFrame('shape');
      r.noVolume();
      let x = 60;
      while (x < r.w - 60) {
        const k = rng.next();
        if (k < 0.55) {
          const rx = rng.range(18, 30);
          clump(r, rng, x, rng.range(44, 56), rx, rx * rng.range(0.55, 0.75), { ...LEAFY, lobes: 5, tufts: 4, flat: -0.03 });
          x += rx * rng.range(1.1, 1.7);
        } else if (k < 0.75) {
          const rx = rng.range(12, 20);
          r.volume(x - 4, 52, rx, 0.18);
          r.strokeFrame('xy');
          r.ellipse(x, 60, rx, rx * 0.6, Mat.Stone, 4);
          r.strokeFrame('shape');
          r.noVolume();
          x += rx * 1.6;
        } else {
          for (let g = 0; g < 7; g++) {
            const gx = x + rng.range(-10, 10);
            const len = rng.range(10, 22);
            r.curve(gx, 62, gx + rng.range(-4, 4), 62 - len * 0.6, gx + rng.range(-8, 8), 62 - len, 1.6, 0.4, Mat.Leaf, 0, 4);
          }
          x += 24;
        }
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
    category: 'nearTrunk', variants: 3, w: 300, h: 900, unitsPerTexel: 1.4, anchorX: 150, anchorY: 900 - M - 10,
    sway: 'none', swayScale: 0, emissive: true, cut: 'top', stretchFrom: NEAR_STRETCH,
    finalize: { rimWidth: 3, rimStrength: 1.1, detail: 1.1 },
    draw(r, rng, v) {
      nearTrunk(r, rng, r.w / 2 + rng.range(-10, 10), r.h - M - 10, NEAR_STRETCH, v);
    },
  },
  {
    category: 'rootArch', variants: 2, w: 360, h: 170, unitsPerTexel: 1.4, anchorX: 180, anchorY: 170 - M - 4,
    sway: 'none', swayScale: 0, emissive: true, cut: 'none', finalize: { rimWidth: 3.5, rimStrength: 1.1 },
    draw(r, rng, v) {
      const g = r.h - M - 4;
      const n = 2 + v;
      r.strokeFrame('xy');
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
      r.strokeFrame('shape');
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
      r.strokeFrame('xy');
      for (let i = 0; i < n; i++) {
        const rx = i === 0 ? rng.range(40, 54) : rng.range(18, 30);
        const ry = rx * rng.range(0.55, 0.8);
        const x = r.w / 2 + (i === 0 ? 0 : rng.range(-50, 50));
        r.ellipse(x, g - ry * 0.7, rx, ry, Mat.Stone, 4);
        r.ellipse(x - rx * 0.1, g - ry * 1.35, rx * 0.72, ry * 0.22, Mat.Moss, 2);
      }
      r.ellipse(r.w / 2, g, 56, 6, Mat.Stone, 6);
      r.strokeFrame('shape');
    },
  },
  {
    // Foreground framing is baked soft, so it lives at 2/3 of the texel density (FG_K).
    category: 'fgBottom', variants: 3, w: 214, h: 127, unitsPerTexel: 2.2 / FG_K, anchorX: 107, anchorY: 127,
    sway: 'bottom', swayScale: 0.45, emissive: false, cut: 'bottom', finalize: { softness: 9 * FG_K, rimWidth: 0, dispScale: 0.8 * FG_K },
    draw(r, rng) {
      const k = FG_K;
      const g = r.h + 6 * k;
      const n = rng.int(5, 7);
      for (let i = 0; i < n; i++) {
        const x = (70 + ((i + rng.range(-0.3, 0.3)) / Math.max(1, n - 1)) * 180) * k;
        const ang = -Math.PI / 2 + rng.range(-0.9, 0.9);
        const len = fitLength(r, x, g, ang, rng.range(80, 140) * k, 24 * k);
        r.leaf(x, g, ang, len, len * rng.range(0.26, 0.34), Mat.Soft);
      }
      for (let i = 0; i < 2; i++) {
        const x = rng.range(100, 220) * k;
        const ang = -Math.PI / 2 + rng.range(-0.5, 0.5);
        frond(r, rng, x, g, ang, fitLength(r, x, g, ang, rng.range(100, 140) * k, 50 * k), 40 * k, 28 * k, Mat.Soft, 3 * k);
      }
      r.ellipse(r.w / 2, g + 10 * k, r.w * 0.38, 44 * k, Mat.Soft, 14 * k);
    },
  },
  {
    category: 'fgTop', variants: 3, w: 214, h: 134, unitsPerTexel: 2.2 / FG_K, anchorX: 107, anchorY: 0,
    sway: 'top', swayScale: 0.45, emissive: false, cut: 'top', finalize: { softness: 9 * FG_K, rimWidth: 0, dispScale: 0.8 * FG_K },
    draw(r, rng) {
      const k = FG_K;
      const sd = rng.chance(0.5) ? -1 : 1;
      const x0 = r.w / 2 - sd * rng.range(40, 80) * k;
      const x1 = r.w / 2 + sd * rng.range(90, 120) * k;
      const y1 = rng.range(50, 80) * k;
      const cy = rng.range(30, 50) * k;
      r.curve(x0, -12 * k, (x0 + x1) / 2, cy, x1, y1, 15 * k, 6 * k, Mat.Soft, 6 * k, 12);
      const n = rng.int(7, 10);
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        ElementRaster.bezier(x0, -12 * k, (x0 + x1) / 2, 40 * k, x1, y1, t, P);
        const bx = P.x;
        const by = P.y;
        const ang = Math.PI / 2 + rng.range(-0.8, 0.8);
        const len = fitLength(r, bx, by, ang, rng.range(60, 115) * k, 20 * k);
        r.leaf(bx, by, ang, len, len * rng.range(0.16, 0.22), Mat.Soft);
      }
      r.ellipse(x0, -6 * k, 70 * k, 34 * k, Mat.Soft, 10 * k);
      for (let i = 0; i < 2; i++) strand(r, rng, rng.range(90, 230) * k, 20 * k, rng.range(80, 140) * k, 10 * k, 3 * k, 1.5 * k, 16 * k, Mat.Soft);
    },
  },
  {
    category: 'fgVine', variants: 2, w: 32, h: 220, unitsPerTexel: 2.2 / FG_K, anchorX: 16, anchorY: 0,
    sway: 'top', swayScale: 1, emissive: false, cut: 'top', finalize: { softness: 6 * FG_K, rimWidth: 0, dispScale: 0.5 * FG_K },
    draw(r, rng) {
      const k = FG_K;
      strand(r, rng, r.w / 2, -4 * k, r.h - M - rng.range(10, 60) * k, 8 * k, 3.4 * k, 1.6 * k, 17 * k, Mat.Soft);
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
      r.frameLine(x0, top + 9, x1, top + 9);
      r.curve(x0, top + 9, r.w / 2, top + 13, x1, top + 9, 9.5, 8.5, Mat.Wood, 2, 16);
      r.capsule(x0 + 6, top + 4, x1 - 6, top + 4, 4, 4, Mat.Wood, 4);
      r.releaseFrame();
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
]);
