import { clamp01 } from '../../core/math.ts';
import { BRUSH_BODY, BRUSH_POLAR_BASE, BRUSH_SIZE, BrushKernel, DRY_SCALE, POLAR_BODY, sample, strokeHash, type StrokeOptions } from './brush.ts';
import { coverage, smin } from './sdf.ts';
import type { NoiseTable } from './noiseTable.ts';

export type { StrokeOptions } from './brush.ts';

/**
 * CPU rasteriser for kit elements. Shapes are splatted into a signed-distance buffer (texels,
 * negative inside) only within their bounding boxes, each tagged with a material; `finalize` turns
 * distance + material into the atlas channels (R luminance detail, G rim mask, B emissive, A coverage).
 * Inner loops use sqrt-based distances (Math.hypot is several times slower in V8).
 *
 * Painterly pass (ARCHITECTURE.md §5.5): every shape also has a stroke frame — along/across a capsule
 * or curve (arc length), (r̄·φ, r) around an ellipse, along a leaf blade, or plain (x, y) for ground,
 * rocks and roots — and the shape that owns a texel records its index, next to `mat`/`shade`, plus the
 * nearest shape of another frame group (the runner-up). `finalize` evaluates the stroke coordinate
 * (u, v) of covered texels in their shape's frame and paints brush strokes that follow each form and
 * cross-fade where two forms meet. Texel coordinates are never rotated by a per-texel direction.
 */
export const Mat = {
  None: 0,
  Bark: 1,
  Leaf: 2,
  Stone: 3,
  Soft: 4,
  Petal: 5,
  Stem: 6,
  Moss: 7,
  Paper: 8,
  Wood: 9,
  Fungus: 10,
  /** Pale, marked bark (birch-like trunks). */
  PaleBark: 11,
  /** Fine conifer needles: small, frequent edge displacement. */
  Needle: 12,
} as const;
export type Mat = (typeof Mat)[keyof typeof Mat];

const FAR = 1e4;
/** Per material: edge displacement amplitude (texels), noise frequency (table units/texel), rim response. */
const DISP = new Float32Array([0, 1.2, 3.2, 1.6, 6, 0.4, 0.3, 2.2, 0, 0.8, 0.6, 0.9, 2.2]);
const FREQ = new Float32Array([0, 0.9, 1.6, 0.6, 0.35, 1.5, 1.5, 1.2, 0, 0.8, 1, 0.9, 2.6]);
const RIM = new Float32Array([0, 1, 0.85, 1, 0, 0.6, 0.7, 0.9, 0.3, 1, 0.8, 1.1, 0.8]);
/** Direction toward the moon (upper left), normalised. */
const LX = -0.55;
const LY = -0.83;

export interface FinalizeOptions {
  /** AA / softness width in texels (large values bake a blur, e.g. for the foreground frame). */
  softness?: number;
  /** Scales every material's edge displacement. */
  dispScale?: number;
  /** Alpha fades to 0 between these fractions of the height (e.g. [0.7, 1] for mist-drowned bases). */
  fadeBottom?: [number, number] | null;
  /** Rim light reach in texels (0 = none) and strength. */
  rimWidth?: number;
  rimStrength?: number;
  /** Multiplier on luminance detail amplitude. */
  detail?: number;
  /** Multiplier on the final coverage (translucent elements such as mist banks). */
  alphaScale?: number;
  /**
   * Alpha fades to 0 over this many texels at the rect edges (a safety net so nothing is hard-cut by
   * the rect), except at an intentionally cut edge.
   */
  edgeFade?: number;
  cut?: 'none' | 'top' | 'bottom';
  /** Painterly brush strokes (null/absent = the plain channels, byte for byte as before the pass). */
  strokes?: StrokeOptions | null;
}

/** Stroke frame kinds: along/across a segment, around a centre, plain element (x, y). */
export const FRAME = { Line: 0, Polar: 1, Xy: 2 } as const;
/** Every 'xy' shape of an element shares this group: one continuous frame, no seams between them. */
const XY_GROUP = 0;
/**
 * Where a shape takes texels over from a shape of another frame group, its strokes fade in from the
 * previous owner's over this much SDF distance gap (about STROKE_SEAM / 2 texels of the new owner's
 * side): the brush is continuous across the boundary, and each form keeps its own strokes.
 */
export const STROKE_SEAM = 5;
/** Polar frames fade their strokes toward the frame's mean near the centre (normalised radius), where φ bunches up. */
export const POLAR_FADE_IN = 0.12;
export const POLAR_FADE_OUT = 0.45;

/** Per-shape frame parameters (FrameTable.f stride): the frame itself, then its brush-table map. */
const SF = 20;
const F_OX = 0;
const F_OY = 1;
const F_AX = 2;
const F_AY = 3;
const F_U0 = 4;
const F_IRX = 5;
const F_IRY = 6;
const F_RB = 7;
const F_OFFU = 8;
const F_OFFV = 9;
const F_C = 10;
/** Along scale of the brush (BrushKernel.along). */
const F_KA = 11;
/**
 * The frame mapped to brush-table coordinates (TABLE_BIAS included), for the hot path. Line and xy
 * frames are affine: X = x·H0 + y·H1 + H2, Y = x·H3 + y·H4 + H5 at texel (x, y). Polar frames:
 * q = ((x − H0)·H2, (y − H1)·H3), X = atan2(q)·H4 + H5, Y = |q|·H6 + H7.
 */
const F_H0 = 12;
const F_H1 = 13;
const F_H2 = 14;
const F_H3 = 15;
const F_H4 = 16;
const F_H5 = 17;
const F_H6 = 18;
const F_H7 = 19;
const POLAR_FADE_K = 1 / (POLAR_FADE_OUT - POLAR_FADE_IN);

/** frameAt output layout (ElementRaster.fr): along, across, polar fade weight, along period, faded-to value. */
const FR_U = 0;
const FR_V = 1;
const FR_W = 2;
const FR_P = 3;
const FR_C = 4;
const FR_STRIDE = 5;

/** Stroke frames of one element's shapes: kind, group and parameters (growable, reused across elements). */
export class FrameTable {
  kind = new Uint8Array(1024);
  group = new Int32Array(1024);
  f = new Float64Array(1024 * SF);
  count = 0;

  add(kind: number, group: number): number {
    if (this.count === this.kind.length) {
      const n = this.kind.length * 2;
      const kind = new Uint8Array(n);
      kind.set(this.kind);
      const g = new Int32Array(n);
      g.set(this.group);
      const f = new Float64Array(n * SF);
      f.set(this.f);
      this.kind = kind;
      this.group = g;
      this.f = f;
    }
    const s = this.count++;
    this.kind[s] = kind;
    this.group[s] = group;
    return s;
  }
}

/**
 * Per-texel stroke records (owner and runner-up shape) and finalize scratch, reused across elements.
 * A record is an interleaved pair [shape index, the shape's own unblended distance] (shape indices stay
 * far below 2^24, exact in float32), so recording a texel touches one cache line; a shape's frame
 * group comes from the frame table.
 */
export interface StrokeBuffers {
  /** Owner (valid where `mat` ≠ 0). */
  own: Float32Array;
  /** Runner-up: the nearest shape of another group that the owner took the texel from (distance FAR: none). */
  run: Float32Array;
  /**
   * Brush value and luminance amplitude of stroked texels, their indices, and runner-up texels, later
   * the rim blocks (finalize scratch); `mark` flags listed rim blocks (all zero between elements).
   */
  bm: Float32Array;
  ba: Float32Array;
  list: Int32Array;
  aux: Int32Array;
  mark: Uint8Array;
}

function strokeBuffers(n: number): StrokeBuffers {
  return {
    own: new Float32Array(n * 2), run: new Float32Array(n * 2),
    bm: new Float32Array(n), ba: new Float32Array(n), list: new Int32Array(n), aux: new Int32Array(n), mark: new Uint8Array(n),
  };
}

function strokeViews(s: StrokeBuffers, n: number): StrokeBuffers {
  return {
    own: s.own.subarray(0, n * 2), run: s.run.subarray(0, n * 2).fill(FAR),
    bm: s.bm.subarray(0, n), ba: s.ba.subarray(0, n), list: s.list.subarray(0, n), aux: s.aux.subarray(0, n), mark: s.mark.subarray(0, n),
  };
}

/** Reusable buffers for rasterising many elements in sequence (one element at a time). */
export class Scratch {
  dist = new Float32Array(0);
  mat = new Uint8Array(0);
  emit = new Float32Array(0);
  halo = new Float32Array(0);
  alpha = new Float32Array(0);
  shade = new Float32Array(0);
  rowMin = new Int32Array(0);
  rowMax = new Int32Array(0);
  stroke: StrokeBuffers = strokeBuffers(0);
  readonly frames = new FrameTable();
  private byteBuf = new Uint8Array(0);

  /** A reusable byte buffer of at least `n` bytes (a view of exactly `n`). */
  bytes(n: number): Uint8Array {
    if (this.byteBuf.length < n) this.byteBuf = new Uint8Array(n);
    return this.byteBuf.subarray(0, n);
  }

  ensure(n: number, rows: number): void {
    if (this.dist.length < n) {
      this.dist = new Float32Array(n);
      this.mat = new Uint8Array(n);
      this.emit = new Float32Array(n);
      this.halo = new Float32Array(n);
      this.alpha = new Float32Array(n);
      this.shade = new Float32Array(n);
      this.stroke = strokeBuffers(n);
    }
    if (this.rowMin.length < rows) {
      this.rowMin = new Int32Array(rows);
      this.rowMax = new Int32Array(rows);
    }
  }
}

/**
 * Bound on |edge displacement| (in units of the material displacement) with the dry brush mixed in: it
 * stays below the plain two-octave noise's peak (≈ 0.6), so with strokes, finalize skips the noise
 * where |d| exceeds this band (checked in tests/world/strokes.test.ts).
 */
export const EDGE_NOISE_MAX = 0.75;

/** Scratch for the rim redistribution of one 2×2 block (atlas offsets, alphas, rim values, new rim values). */
const RIM_BLOCK_I = new Int32Array(4);
const RIM_BLOCK_A = new Float64Array(4);
const RIM_BLOCK_G = new Float64Array(4);
const RIM_BLOCK_W = new Float64Array(4);

/** atan2 to about 1e-5 rad (a minimax arctangent): frames are evaluated for every covered texel. */
function fastAtan2(y: number, x: number): number {
  const ax = x < 0 ? -x : x;
  const ay = y < 0 ? -y : y;
  const mx = ax > ay ? ax : ay;
  if (mx === 0) return 0;
  const t = (ax < ay ? ax : ay) / mx;
  const s = t * t;
  let r = ((((-0.0117212 * s + 0.05265332) * s - 0.11643287) * s + 0.19354346) * s - 0.33262347) * s + 0.99997726;
  r *= t;
  if (ay > ax) r = 1.5707963267948966 - r;
  if (x < 0) r = 3.141592653589793 - r;
  return y < 0 ? -r : r;
}

/** Offset (a multiple of the brush table size) that keeps table coordinates positive, so `| 0` floors. */
const TABLE_BIAS = 1 << 20;
/** Counts returned by brushOwners (listed texels, runner-ups). */
const STROKE_OUT = new Float64Array(2);

/*
 * The brush passes of the painterly finalize. The frame evaluation is written out in both loops: as a
 * function it exceeds V8's inlining size, and every call would box its result.
 */

/**
 * Brush value of every texel that can end up covered (distance below `coverM` of its material) into
 * `bm`, in its owner's frame: the frame's brush-table coordinates, one bilinear lookup, and a polar
 * frame's fade toward its mean near the centre. The texels go to `list`, and those whose runner-up
 * (the shape of another frame group the owner took them from) is within STROKE_SEAM also to
 * `runList` for brushRunners. STROKE_OUT = [listed, runner-ups].
 */
function brushOwners(
  w: number, h: number, rowMin: Int32Array, rowMax: Int32Array, dist: Float32Array, mats: Uint8Array, coverM: Float32Array,
  own: Float32Array, run: Float32Array, bm: Float32Array, list: Int32Array, runList: Int32Array, kinds: Uint8Array, f: Float64Array,
): void {
  const body = BRUSH_BODY;
  const mask = BRUSH_SIZE - 1;
  let ln = 0;
  let rn = 0;
  // The current owner's frame, reloaded only when the owner changes (runs along a row share one).
  let cs = -1;
  let polar = false;
  let h0 = 0;
  let h1 = 0;
  let h2 = 0;
  let h3 = 0;
  let h4 = 0;
  let h5 = 0;
  let h6 = 0;
  let h7 = 0;
  let c = 0;
  for (let y = 0; y < h; y++) {
    const r0 = rowMin[y] as number;
    const xs = r0 < 0 ? 0 : r0;
    const r1 = (rowMax[y] as number) + 1;
    const xe = r1 > w ? w : r1;
    for (let x = xs; x < xe; x++) {
      const i = y * w + x;
      if (!((dist[i] as number) < (coverM[mats[i] as number] as number))) continue;
      list[ln++] = i;
      const td = run[i * 2 + 1] as number;
      if (td < FAR && td - (own[i * 2 + 1] as number) < STROKE_SEAM) runList[rn++] = i;
      const s = own[i * 2] as number;
      if (s !== cs) {
        cs = s;
        const o = s * SF;
        polar = kinds[s] === FRAME.Polar;
        h0 = f[o + F_H0] as number;
        h1 = f[o + F_H1] as number;
        h2 = f[o + F_H2] as number;
        h3 = f[o + F_H3] as number;
        h4 = f[o + F_H4] as number;
        h5 = f[o + F_H5] as number;
        h6 = f[o + F_H6] as number;
        h7 = f[o + F_H7] as number;
        c = f[o + F_C] as number;
      }
      let X = 0;
      let Y = 0;
      let wt = 1;
      let base = 0;
      if (!polar) {
        X = x * h0 + y * h1 + h2;
        Y = x * h3 + y * h4 + h5;
      } else {
        const qx = (x - h0) * h2;
        const qy = (y - h1) * h3;
        const rho = Math.sqrt(qx * qx + qy * qy);
        X = fastAtan2(qy, qx) * h4 + h5;
        Y = rho * h6 + h7;
        const t = (rho - POLAR_FADE_IN) * POLAR_FADE_K;
        wt = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
        base = BRUSH_POLAR_BASE;
      }
      const fx = X | 0;
      const fy = Y | 0;
      const tx = X - fx;
      const ty = Y - fy;
      const x0 = fx & mask;
      const x1 = (x0 + 1) & mask;
      const y0 = base + (fy & mask) * BRUSH_SIZE;
      const y1 = base + ((fy + 1) & mask) * BRUSH_SIZE;
      const a = body[y0 + x0] as number;
      const top = a + ((body[y0 + x1] as number) - a) * tx;
      const c0 = body[y1 + x0] as number;
      const bot = c0 + ((body[y1 + x1] as number) - c0) * tx;
      bm[i] = c + (top + (bot - top) * ty - c) * wt;
    }
  }
  STROKE_OUT[0] = ln;
  STROKE_OUT[1] = rn;
}

/**
 * Near a boundary where the owner took a texel from a shape of another frame group, its strokes fade
 * in from the runner-up's over STROKE_SEAM of distance gap: the brush is continuous across the
 * boundary and each form keeps its own strokes (the same evaluation as brushOwners, in the runner-up's
 * frame).
 */
function brushRunners(
  list: Int32Array, count: number, w: number, own: Float32Array, run: Float32Array, bm: Float32Array, kinds: Uint8Array, f: Float64Array,
): void {
  const body = BRUSH_BODY;
  const mask = BRUSH_SIZE - 1;
  // The current runner-up's frame, reloaded only when it changes.
  let cs = -1;
  let polar = false;
  let h0 = 0;
  let h1 = 0;
  let h2 = 0;
  let h3 = 0;
  let h4 = 0;
  let h5 = 0;
  let h6 = 0;
  let h7 = 0;
  let c = 0;
  for (let n = 0; n < count; n++) {
    const i = list[n] as number;
    const y = (i / w) | 0;
    const x = i - y * w;
    const s = run[i * 2] as number;
    if (s !== cs) {
      cs = s;
      const o = s * SF;
      polar = kinds[s] === FRAME.Polar;
      h0 = f[o + F_H0] as number;
      h1 = f[o + F_H1] as number;
      h2 = f[o + F_H2] as number;
      h3 = f[o + F_H3] as number;
      h4 = f[o + F_H4] as number;
      h5 = f[o + F_H5] as number;
      h6 = f[o + F_H6] as number;
      h7 = f[o + F_H7] as number;
      c = f[o + F_C] as number;
    }
    let X = 0;
    let Y = 0;
    let wt = 1;
    let base = 0;
    if (!polar) {
      X = x * h0 + y * h1 + h2;
      Y = x * h3 + y * h4 + h5;
    } else {
      const qx = (x - h0) * h2;
      const qy = (y - h1) * h3;
      const rho = Math.sqrt(qx * qx + qy * qy);
      X = fastAtan2(qy, qx) * h4 + h5;
      Y = rho * h6 + h7;
      const t = (rho - POLAR_FADE_IN) * POLAR_FADE_K;
      wt = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
      base = BRUSH_POLAR_BASE;
    }
    const fx = X | 0;
    const fy = Y | 0;
    const tx = X - fx;
    const ty = Y - fy;
    const x0 = fx & mask;
    const x1 = (x0 + 1) & mask;
    const y0 = base + (fy & mask) * BRUSH_SIZE;
    const y1 = base + ((fy + 1) & mask) * BRUSH_SIZE;
    const a = body[y0 + x0] as number;
    const top = a + ((body[y0 + x1] as number) - a) * tx;
    const c0 = body[y1 + x0] as number;
    const bot = c0 + ((body[y1 + x1] as number) - c0) * tx;
    const val = c + (top + (bot - top) * ty - c) * wt;
    const t = ((run[i * 2 + 1] as number) - (own[i * 2 + 1] as number)) / STROKE_SEAM;
    const mine = bm[i] as number;
    bm[i] = t <= 0 ? val : val + (mine - val) * (t * t * (3 - 2 * t));
  }
}

/** R += amplitude·(brush − mean) on the stroked texels (bm keeps the centred value for the rim pass). */
function paintLum(
  out: Uint8ClampedArray, dstW: number, dx: number, dy: number, w: number, list: Int32Array, bm: Float32Array, ba: Float32Array,
  listN: number, mean: number,
): void {
  for (let n = 0; n < listN; n++) {
    const i = list[n] as number;
    const y = (i / w) | 0;
    const o4 = ((dy + y) * dstW + dx + i - y * w) * 4;
    const v = (bm[i] as number) - mean;
    bm[i] = v;
    out[o4] = (out[o4] as number) + (ba[i] as number) * v * 255;
  }
}

/** Rim-mask blocks whose brightest texel is below this (8-bit) are left as they are (too faint to matter). */
const RIM_MIN = 4;

/**
 * The rim pass: every 2×2 atlas block (aligned to even atlas rows and columns, as mip 1 averages
 * them) that holds a rim mask byte ≥ RIM_MIN, listed by finalize (its index in the element's block
 * grid, `stride` blocks wide), is redistributed once, and its mark cleared. A light stroke (the block's
 * mean centred brush s > 0) sharpens its rim mask toward the block's brightest texel, a dark one
 * (s < 0) flattens it; the premultiplied sum Σ G·A stays (a blend toward the original keeps G ≤ 255).
 * Stroke values count only on covered texels (`alpha` > 0; halo texels carry none). Blocks are
 * independent: any order.
 */
function rimPass(
  dst: Uint8Array, dstW: number, dx: number, dy: number, w: number, h: number, blocks: Int32Array, count: number, stride: number,
  mark: Uint8Array, k: number, alpha: Float32Array, bm: Float32Array, ba: Float32Array,
): void {
  const bi = RIM_BLOCK_I;
  const bA = RIM_BLOCK_A;
  const bg = RIM_BLOCK_G;
  const bw = RIM_BLOCK_W;
  for (let b = 0; b < count; b++) {
    const m = blocks[b] as number;
    mark[m] = 0;
    const row = (m / stride) | 0;
    // The block's top-left texel, local (−1 where the element starts on an odd atlas column or row).
    const bx = ((m - row * stride + (dx >> 1)) << 1) - dx;
    const by = ((row + (dy >> 1)) << 1) - dy;
    let n = 0;
    let sum = 0;
    let am = 0;
    let aa = 0;
    let gmax = 0;
    for (let j = 0; j < 2; j++) {
      const y = by + j;
      if (y < 0 || y >= h) continue;
      for (let q = 0; q < 2; q++) {
        const x = bx + q;
        if (x < 0 || x >= w) continue;
        const o4 = ((dy + y) * dstW + dx + x) * 4;
        const a = dst[o4 + 3] as number;
        if (a === 0) continue;
        const g = dst[o4 + 1] as number;
        const i = y * w + x;
        bi[n] = o4;
        bA[n] = a;
        bg[n] = g;
        n++;
        sum += g * a;
        if (g > gmax) gmax = g;
        if ((alpha[i] as number) > 0 && (ba[i] as number) > 0) {
          am += a * (bm[i] as number);
          aa += a;
        }
      }
    }
    if (n < 2 || aa === 0) continue;
    const sv = k * (am / aa);
    const ig = 1 / gmax;
    // Weights: sharpen (s > 0) favours texels above half the block's peak; flatten (s < 0) lifts all toward it.
    let wsum = 0;
    for (let q = 0; q < n; q++) {
      const g = bg[q] as number;
      let wq = 0;
      if (g > 0) {
        if (sv >= 0) {
          const t = 1 + sv * (2 * g * ig - 1);
          wq = t > 0 ? g * t : 0;
        } else {
          wq = g - (gmax - g) * sv * 0.5;
        }
      }
      bw[q] = wq;
      wsum += wq * (bA[q] as number);
    }
    if (wsum <= 0) continue;
    const sc = sum / wsum;
    // New values, pulled back toward the old ones just enough that none passes 255 (the sum is kept).
    let lam = 1;
    for (let q = 0; q < n; q++) {
      const g = bg[q] as number;
      const nv = (bw[q] as number) * sc;
      bw[q] = nv;
      if (nv > 255 && nv > g) {
        const l = (255 - g) / (nv - g);
        if (l < lam) lam = l;
      }
    }
    // Round, carrying the premultiplied error to the next texel so the block sum stays exact.
    let err = 0;
    for (let q = 0; q < n; q++) {
      const a = bA[q] as number;
      const g = bg[q] as number;
      const want = g + ((bw[q] as number) - g) * lam + err / a;
      const v = want < 0 ? 0 : want > 255 ? 255 : Math.round(want);
      err = (want - v) * a;
      dst[(bi[q] as number) + 1] = v;
    }
  }
}

export class ElementRaster {
  readonly w: number;
  readonly h: number;
  readonly dist: Float32Array;
  readonly mat: Uint8Array;
  readonly emit: Float32Array;
  readonly halo: Float32Array;
  readonly alpha: Float32Array;
  /** Texel x of a trunk column leaving the rect (set by rising-trunk drawers; NaN = none). */
  columnX = Number.NaN;
  /** Per-texel volume shading (added to luminance), written by the shape that owns the texel. */
  readonly shade: Float32Array;
  /** Per-texel owner / runner-up shape records (painterly pass), and the owner records themselves. */
  readonly stroke: StrokeBuffers;
  private readonly own: Float32Array;
  /** Stroke frames of the shapes drawn so far. */
  readonly frames: FrameTable;
  private readonly noise: NoiseTable;
  /** Per-element salt of the stroke pattern (from the element's noise offset). */
  private readonly seed: number;
  /** A held frame (framePolar / frameLine / strokeFrame('xy')) is used by every shape until released. */
  private held = false;
  /** The current shape's frame index and group; the next free group; an open beginStroke() group (−1 = none). */
  private shape = 0;
  private group = 1;
  private nextGroup = 1;
  private openGroup = -1;
  private openDepth = 0;
  /** Along offset accumulated by the segments of the current curve / beginStroke() group. */
  private groupAlong = 0;
  /** The element's brush, from `configure`. */
  private kernel: BrushKernel | null = null;
  /** The brush's across scale (table units per texel) and open frames' along scale, from the kernel. */
  private kv = 0;
  private kaLine = 0;
  /** frameAt output: [u, v, weight, period, faded-to value]. */
  private readonly fr = new Float64Array(FR_STRIDE);
  private volOn = false;
  private v1x = 0;
  private v1y = 0;
  private v1r = 1;
  private v1k = 0;
  private v2x = 0;
  private v2y = 0;
  private v2r = 1;
  private v2k = 0;
  private flat = 0;
  /** Per material: how far outside a shape its distance must be recorded (finalize's edge band). */
  private readonly reach = new Float32Array(DISP.length).fill(8);
  private readonly nox: number;
  private readonly noy: number;
  private bx0 = 0;
  private by0 = 0;
  private bx1 = 0;
  private by1 = 0;

  /** Per row: the touched column range [rowMin, rowMax] (finalize skips everything else). */
  private readonly rowMin: Int32Array;
  private readonly rowMax: Int32Array;

  constructor(w: number, h: number, noise: NoiseTable, noiseOffset: number, scratch: Scratch | null = null) {
    this.w = w;
    this.h = h;
    const n = w * h;
    if (scratch) {
      scratch.ensure(n, h);
      this.dist = scratch.dist.subarray(0, n).fill(FAR);
      this.mat = scratch.mat.subarray(0, n).fill(0);
      this.emit = scratch.emit.subarray(0, n).fill(0);
      this.halo = scratch.halo.subarray(0, n).fill(0);
      this.alpha = scratch.alpha.subarray(0, n).fill(0);
      this.shade = scratch.shade.subarray(0, n).fill(0);
      this.rowMin = scratch.rowMin.subarray(0, h).fill(w);
      this.rowMax = scratch.rowMax.subarray(0, h).fill(-1);
      this.stroke = strokeViews(scratch.stroke, n);
      this.frames = scratch.frames;
    } else {
      this.dist = new Float32Array(n).fill(FAR);
      this.mat = new Uint8Array(n);
      this.emit = new Float32Array(n);
      this.halo = new Float32Array(n);
      this.alpha = new Float32Array(n);
      this.shade = new Float32Array(n);
      this.rowMin = new Int32Array(h).fill(w);
      this.rowMax = new Int32Array(h).fill(-1);
      this.stroke = strokeViews(strokeBuffers(n), n);
      this.frames = new FrameTable();
    }
    this.own = this.stroke.own;
    this.frames.count = 0;
    this.noise = noise;
    this.nox = (noiseOffset * 97.13) % 256;
    this.noy = (noiseOffset * 57.71) % 256;
    this.seed = Math.imul(noiseOffset + 1, 0x9e3779b1) >>> 0;
  }

  /** Mark the box [bx0, bx1) × [by0, by1) as touched (called once per shape). */
  private touch(): void {
    const x0 = this.bx0;
    const x1 = this.bx1 - 1;
    for (let y = this.by0; y < this.by1; y++) {
      if (x0 < (this.rowMin[y] as number)) this.rowMin[y] = x0;
      if (x1 > (this.rowMax[y] as number)) this.rowMax[y] = x1;
    }
  }

  /**
   * Size the per-material distance band to what `finalize(o)` reads (edge displacement + softness),
   * instead of a generous default. Call before drawing (with the stroke options, if any).
   */
  configure(o: FinalizeOptions): void {
    const soft = o.softness ?? 1.25;
    const dispScale = o.dispScale ?? 1;
    for (let m = 0; m < DISP.length; m++) this.reach[m] = (DISP[m] as number) * dispScale * 1.2 + soft + 0.75;
    this.kernel = o.strokes ? new BrushKernel(o.strokes) : null;
    this.kv = this.kernel ? this.kernel.kv : 0;
    this.kaLine = this.kernel ? this.kernel.along(0) : 0;
  }

  /** Element-specific noise in about [-1, 1]. */
  n(x: number, y: number): number {
    return this.noise.sample(x + this.nox, y + this.noy);
  }

  // ---------------------------------------------------------------------------------------------
  // Stroke frames

  /**
   * Stroke frame of the shapes drawn next: 'shape' (default) paints along each shape's own form;
   * 'xy' holds the element's plain (x, y) frame — horizontal strokes for ground, rocks and roots, with
   * no seams between the shapes that share it — until `strokeFrame('shape')` or `releaseFrame()`.
   */
  strokeFrame(mode: 'shape' | 'xy'): void {
    if (mode === 'shape') {
      this.held = false;
      return;
    }
    this.group = XY_GROUP;
    const s = this.frames.add(FRAME.Xy, XY_GROUP);
    const f = this.frames.f;
    const o = s * SF;
    const offU = (this.seed & 1023) * 0.37;
    const offV = ((this.seed >>> 10) & 1023) * 0.53;
    const ka = this.kaLine;
    const kv = this.kv;
    f[o + F_OFFU] = offU;
    f[o + F_OFFV] = offV;
    f[o + F_C] = 0;
    f[o + F_KA] = ka;
    f[o + F_H0] = ka;
    f[o + F_H1] = 0;
    f[o + F_H2] = ka * (0.5 + offU) + TABLE_BIAS;
    f[o + F_H3] = 0;
    f[o + F_H4] = kv;
    f[o + F_H5] = kv * (0.5 + offV) + TABLE_BIAS;
    this.shape = s;
    this.held = true;
  }

  /**
   * Hold a polar frame around (cx, cy) for the shapes drawn next (a lobe with its tufts and leaves,
   * a leaf spray): they paint as one form, strokes wrapping around its centre.
   */
  framePolar(cx: number, cy: number, rx: number, ry: number): void {
    this.held = false;
    this.startGroup(false);
    this.polarFrame(cx, cy, rx, ry);
    this.held = true;
  }

  /**
   * Hold a line frame from (ax, ay) toward (bx, by) for the shapes drawn next (a conifer tier with its
   * fringe, a frond with its leaflets, a strand with its leaves): strokes run along the whole form.
   */
  frameLine(ax: number, ay: number, bx: number, by: number): void {
    this.held = false;
    this.startGroup(false);
    const dx = bx - ax;
    const dy = by - ay;
    const l = Math.sqrt(dx * dx + dy * dy);
    this.lineFrame(ax, ay, l > 1e-6 ? dx / l : 0, l > 1e-6 ? dy / l : 1, 0);
    this.held = true;
  }

  /** Back to per-shape frames. */
  releaseFrame(): void {
    this.held = false;
  }

  /**
   * The capsules and curves drawn until `endStroke()` form one stroke (trunk paths, rising columns):
   * one frame group with a continuous along coordinate, instead of a new frame per segment. Nests.
   */
  beginStroke(): void {
    if (this.openDepth++ > 0) return;
    this.openGroup = this.nextGroup++;
    this.groupAlong = 0;
  }

  endStroke(): void {
    if (this.openDepth > 0 && --this.openDepth === 0) this.openGroup = -1;
  }

  /** Start a shape's frame group: the open beginStroke() group for segments, else a new one. */
  private startGroup(line: boolean): void {
    if (line && this.openGroup >= 0) {
      this.group = this.openGroup;
      return;
    }
    this.group = this.nextGroup++;
    // A standalone segment starts its own along coordinate (an open group keeps accumulating).
    if (line) this.groupAlong = 0;
  }

  /** New line frame from (ax, ay) along the unit axis (dx, dy), with along offset u0, in the current group. */
  private lineFrame(ax: number, ay: number, dx: number, dy: number, u0: number): void {
    const g = this.group;
    const s = this.frames.add(FRAME.Line, g);
    const f = this.frames.f;
    const o = s * SF;
    f[o + F_OX] = ax;
    f[o + F_OY] = ay;
    f[o + F_AX] = dx;
    f[o + F_AY] = dy;
    f[o + F_U0] = u0;
    // Each stroke group reads its own stretch of the brush lattice.
    const offU = strokeHash(g, 11, this.seed) * 4096;
    const offV = strokeHash(g, 23, this.seed) * 4096;
    const ka = this.kaLine;
    const kv = this.kv;
    f[o + F_OFFU] = offU;
    f[o + F_OFFV] = offV;
    f[o + F_C] = 0;
    f[o + F_KA] = ka;
    // u = u0 + p·(dx, dy) + offU and v = p × (dx, dy) + offV at p = texel centre − origin, in table units.
    const px = 0.5 - ax;
    const py = 0.5 - ay;
    f[o + F_H0] = ka * dx;
    f[o + F_H1] = ka * dy;
    f[o + F_H2] = ka * (u0 + px * dx + py * dy + offU) + TABLE_BIAS;
    f[o + F_H3] = -kv * dy;
    f[o + F_H4] = kv * dx;
    f[o + F_H5] = kv * (py * dx - px * dy + offV) + TABLE_BIAS;
    this.shape = s;
  }

  /** New polar frame around (cx, cy), normalised to the ellipse (rx, ry) so iso-lines follow its outline. */
  private polarFrame(cx: number, cy: number, rx: number, ry: number): void {
    const g = this.group;
    const s = this.frames.add(FRAME.Polar, g);
    const f = this.frames.f;
    const o = s * SF;
    f[o + F_OX] = cx;
    f[o + F_OY] = cy;
    f[o + F_IRX] = 1 / rx;
    f[o + F_IRY] = 1 / ry;
    // (r̄·φ, ρ·r̄): strokes keep the element's layer-unit width across and wrap the lobe in whole
    // table periods along (at least 4 broad cells around: dabs, not a light and a dark half).
    const rb = (rx + ry) * 0.5;
    f[o + F_RB] = rb;
    const offU = strokeHash(g, 11, this.seed) * 4096;
    const offV = strokeHash(g, 23, this.seed) * 4096;
    f[o + F_OFFU] = offU;
    f[o + F_OFFV] = offV;
    // Toward the centre φ bunches up, so strokes fade to the frame's mean around its fade ring.
    let c = 0;
    let ka = 0;
    const kv = this.kv;
    const kernel = this.kernel;
    if (kernel) {
      const p = 2 * Math.PI * rb;
      ka = kernel.along(p);
      const Y = (POLAR_FADE_OUT * rb + offV) * kv;
      for (let k = 0; k < 16; k++) c += sample(POLAR_BODY, (offU + (k / 16) * p) * ka, Y);
      c /= 16;
    }
    f[o + F_KA] = ka;
    f[o + F_C] = c;
    f[o + F_H0] = cx - 0.5;
    f[o + F_H1] = cy - 0.5;
    f[o + F_H2] = 1 / rx;
    f[o + F_H3] = 1 / ry;
    f[o + F_H4] = rb * ka;
    f[o + F_H5] = offU * ka + TABLE_BIAS;
    f[o + F_H6] = rb * kv;
    f[o + F_H7] = offV * kv + TABLE_BIAS;
    this.shape = s;
  }

  /** Stroke coordinate of texel (x, y) in frame s → fr: along, across, polar fade weight, along period, faded-to value. */
  private frameAt(s: number, x: number, y: number): void {
    const at = 0;
    const f = this.frames.f;
    const r = this.fr;
    const o = s * SF;
    const kind = this.frames.kind[s] as number;
    r[at + FR_C] = f[o + F_C] as number;
    if (kind === FRAME.Xy) {
      r[at + FR_U] = x + 0.5 + (f[o + F_OFFU] as number);
      r[at + FR_V] = y + 0.5 + (f[o + F_OFFV] as number);
      r[at + FR_W] = 1;
      r[at + FR_P] = 0;
      return;
    }
    const px = x + 0.5 - (f[o + F_OX] as number);
    const py = y + 0.5 - (f[o + F_OY] as number);
    if (kind === FRAME.Line) {
      const ax = f[o + F_AX] as number;
      const ay = f[o + F_AY] as number;
      r[at + FR_U] = (f[o + F_U0] as number) + px * ax + py * ay + (f[o + F_OFFU] as number);
      r[at + FR_V] = py * ax - px * ay + (f[o + F_OFFV] as number);
      r[at + FR_W] = 1;
      r[at + FR_P] = 0;
      return;
    }
    const qx = px * (f[o + F_IRX] as number);
    const qy = py * (f[o + F_IRY] as number);
    const rho = Math.sqrt(qx * qx + qy * qy);
    const rb = f[o + F_RB] as number;
    r[at + FR_U] = rb * fastAtan2(qy, qx) + (f[o + F_OFFU] as number);
    r[at + FR_V] = rho * rb + (f[o + F_OFFV] as number);
    const t = (rho - POLAR_FADE_IN) / (POLAR_FADE_OUT - POLAR_FADE_IN);
    r[at + FR_W] = t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    r[at + FR_P] = 2 * Math.PI * rb;
  }

  /**
   * Stroke coordinate of texel i = (x, y) in its owner's frame (for tests and tools): writes
   * [u, v, weight, period, faded-to value] into `out`; false where no shape owns the texel.
   */
  strokeCoord(x: number, y: number, out: Float64Array | number[]): boolean {
    const i = y * this.w + x;
    if (this.mat[i] === 0) return false;
    this.frameAt(this.own[i * 2] as number, x, y);
    const r = this.fr;
    for (let k = 0; k < 5; k++) out[k] = r[k] as number;
    return true;
  }

  // ---------------------------------------------------------------------------------------------

  private box(x0: number, y0: number, x1: number, y1: number, pad: number): boolean {
    this.bx0 = Math.max(0, Math.floor(x0 - pad));
    this.by0 = Math.max(0, Math.floor(y0 - pad));
    this.bx1 = Math.min(this.w, Math.ceil(x1 + pad));
    this.by1 = Math.min(this.h, Math.ceil(y1 + pad));
    return this.bx1 > this.bx0 && this.by1 > this.by0;
  }

  /**
   * Volume shading for the shapes drawn next: texels get lighter toward the moon (upper left) across
   * a sphere of radius `r` around (cx, cy), with strength `k` (luminance units). Two nested volumes
   * (a whole clump and one of its lobes) add up; `flat` is a constant luminance offset.
   */
  volume(cx: number, cy: number, r: number, k: number, flat = 0): void {
    this.volOn = true;
    this.v1x = cx;
    this.v1y = cy;
    this.v1r = Math.max(1, r);
    this.v1k = k;
    this.v2k = 0;
    this.flat = flat;
  }

  /** Inner (lobe) volume on top of the current outer volume. */
  lobe(cx: number, cy: number, r: number, k: number): void {
    this.volOn = true;
    this.v2x = cx;
    this.v2y = cy;
    this.v2r = Math.max(1, r);
    this.v2k = k;
  }

  /** Back to flat shading (offset `flat`). */
  noVolume(flat = 0): void {
    this.volOn = flat !== 0;
    this.v1k = 0;
    this.v2k = 0;
    this.flat = flat;
  }

  private volAt(x: number, y: number): number {
    let s = this.flat;
    if (this.v1k !== 0) {
      const t = ((x + 0.5 - this.v1x) * LX + (y + 0.5 - this.v1y) * LY) / this.v1r;
      s += this.v1k * (t < -1 ? -1 : t > 1 ? 1 : t);
    }
    if (this.v2k !== 0) {
      const t = ((x + 0.5 - this.v2x) * LX + (y + 0.5 - this.v2y) * LY) / this.v2r;
      s += this.v2k * (t < -1 ? -1 : t > 1 ? 1 : t);
    }
    return s;
  }

  /*
   * Recording a shape's distance d at texel i (written out in capsule, ellipse and leaf): the nearer
   * shape owns the texel's material, shading and stroke frame (a smooth union blends only the
   * distance); when it takes the texel from a shape of another frame group, that shape is kept as the
   * runner-up (the nearest such), whose strokes the new owner's fade in from across the boundary.
   */

  /**
   * Texel i passes from a shape of another group to the current one: the old owner becomes the
   * runner-up when it is nearer than the one on record (or that one is of the new owner's group).
   */
  private demote(i: number): void {
    const own = this.own;
    const run = this.stroke.run;
    const r = i * 2;
    const td = run[r + 1] as number;
    if (td >= FAR || (own[r + 1] as number) < td || (this.frames.group[run[r] as number] as number) === this.group) {
      run[r] = own[r] as number;
      run[r + 1] = own[r + 1] as number;
    }
  }

  /** Tapered capsule a→b (radius ra at a, rb at b), smooth-unioned with blend radius k. */
  capsule(ax: number, ay: number, bx: number, by: number, ra: number, rb: number, mat: Mat, k = 0): void {
    const bax = bx - ax;
    const bay = by - ay;
    const len2 = bax * bax + bay * bay;
    const ilen = len2 > 1e-6 ? 1 / Math.sqrt(len2) : 0;
    // Stroke frame: along / across the segment, continuing the along coordinate of its curve or group.
    if (!this.held) {
      this.startGroup(true);
      this.lineFrame(ax, ay, ilen > 0 ? bax * ilen : 0, ilen > 0 ? bay * ilen : 1, this.groupAlong);
      this.groupAlong += ilen > 0 ? len2 * ilen : 0;
    }
    const reach = (this.reach[mat] as number) + k;
    if (!this.box(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), Math.max(ra, rb) + reach)) return;
    this.touch();
    const inv = 1 / (len2 || 1);
    const w = this.w;
    const dist = this.dist;
    const mats = this.mat;
    const own = this.own;
    const shade = this.shade;
    const grp = this.group;
    // (Frames are only added between shapes: the group table stays put during the loops.)
    const groups = this.frames.group;
    const shape = this.shape;
    const volOn = this.volOn;
    // Rows only need the slab within `rm` of the segment's line (exact for diagonal limbs).
    const rm = Math.max(ra, rb) + reach;
    const nx = -bay * ilen;
    const ny = bax * ilen;
    const slab = Math.abs(nx) > 0.2;
    for (let y = this.by0; y < this.by1; y++) {
      const pay = y + 0.5 - ay;
      let x0 = this.bx0;
      let x1 = this.bx1;
      if (slab) {
        const c = pay * ny;
        const ea = (-rm - c) / nx;
        const eb = (rm - c) / nx;
        x0 = Math.max(x0, Math.floor(ax + Math.min(ea, eb) - 0.5));
        x1 = Math.min(x1, Math.ceil(ax + Math.max(ea, eb) + 0.5));
      }
      for (let x = x0; x < x1; x++) {
        const pax = x + 0.5 - ax;
        let t = (pax * bax + pay * bay) * inv;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = pax - bax * t;
        const dy = pay - bay * t;
        const d = Math.sqrt(dx * dx + dy * dy) - (ra + (rb - ra) * t);
        if (d < reach) {
          // Record d (see "Recording" above demote), written out: these loops are the bake's hottest code.
          const i = y * w + x;
          const old = dist[i] as number;
          if (d < old) {
            if (mats[i] !== 0 && (groups[own[i * 2] as number] as number) !== grp) this.demote(i);
            own[i * 2] = shape;
            own[i * 2 + 1] = d;
            dist[i] = k > 0 && old < FAR ? smin(old, d, k) : d;
            mats[i] = mat;
            shade[i] = volOn ? this.volAt(x, y) : 0;
          } else if (k > 0 && d < old + k && old < FAR) {
            dist[i] = smin(old, d, k);
          }
        }
      }
    }
  }

  /** Quadratic Bézier a→c→b made of tapered capsule segments (one stroke frame group along its arc length). */
  curve(
    ax: number, ay: number, cx: number, cy: number, bx: number, by: number,
    ra: number, rb: number, mat: Mat, k = 0, segments = 8,
  ): void {
    this.beginStroke();
    let px = ax;
    let py = ay;
    for (let i = 1; i <= segments; i++) {
      const t = i / segments;
      const it = 1 - t;
      const x = it * it * ax + 2 * it * t * cx + t * t * bx;
      const y = it * it * ay + 2 * it * t * cy + t * t * by;
      const r0 = ra + (rb - ra) * ((i - 1) / segments);
      const r1 = ra + (rb - ra) * t;
      this.capsule(px, py, x, y, r0, r1, mat, i === 1 ? k : Math.max(k, 0.6));
      px = x;
      py = y;
    }
    this.endStroke();
  }

  /** Point on the quadratic Bézier a→c→b at t. */
  static bezier(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, t: number, out: { x: number; y: number }): void {
    const it = 1 - t;
    out.x = it * it * ax + 2 * it * t * cx + t * t * bx;
    out.y = it * it * ay + 2 * it * t * cy + t * t * by;
  }

  /** Ellipse (scaled-circle distance approximation — fine for soft organic masses). */
  ellipse(cx: number, cy: number, rx: number, ry: number, mat: Mat, k = 0): void {
    // Stroke frame: (r̄·φ, r) around the centre.
    if (!this.held) {
      this.startGroup(false);
      this.polarFrame(cx, cy, rx, ry);
    }
    const reach = (this.reach[mat] as number) + k;
    if (!this.box(cx - rx, cy - ry, cx + rx, cy + ry, reach)) return;
    this.touch();
    const irx = 1 / rx;
    const iry = 1 / ry;
    const m = Math.min(rx, ry);
    const w = this.w;
    const dist = this.dist;
    const mats = this.mat;
    const own = this.own;
    const shade = this.shade;
    const grp = this.group;
    // (Frames are only added between shapes: the group table stays put during the loops.)
    const groups = this.frames.group;
    const shape = this.shape;
    const volOn = this.volOn;
    const lim = 1 + reach / m;
    const lim2 = lim * lim;
    for (let y = this.by0; y < this.by1; y++) {
      const dy = (y + 0.5 - cy) * iry;
      // Only |dx| < sqrt(lim² − dy²)·rx can land inside the recorded band.
      const q = lim2 - dy * dy;
      if (q <= 0) continue;
      const span = Math.sqrt(q) * rx;
      const x0 = Math.max(this.bx0, Math.floor(cx - span - 0.5));
      const x1 = Math.min(this.bx1, Math.ceil(cx + span + 0.5));
      for (let x = x0; x < x1; x++) {
        const dx = (x + 0.5 - cx) * irx;
        const d = (Math.sqrt(dx * dx + dy * dy) - 1) * m;
        if (d < reach) {
          // Record d (see "Recording" above demote), written out: these loops are the bake's hottest code.
          const i = y * w + x;
          const old = dist[i] as number;
          if (d < old) {
            if (mats[i] !== 0 && (groups[own[i * 2] as number] as number) !== grp) this.demote(i);
            own[i * 2] = shape;
            own[i * 2 + 1] = d;
            dist[i] = k > 0 && old < FAR ? smin(old, d, k) : d;
            mats[i] = mat;
            shade[i] = volOn ? this.volAt(x, y) : 0;
          } else if (k > 0 && d < old + k && old < FAR) {
            dist[i] = smin(old, d, k);
          }
        }
      }
    }
  }

  circle(cx: number, cy: number, r: number, mat: Mat, k = 0): void {
    this.ellipse(cx, cy, r, r, mat, k);
  }

  /** A leaf blade from base (bx, by) along angle `ang`: rounded base, pointed tip. */
  leaf(bx: number, by: number, ang: number, len: number, hw: number, mat: Mat): void {
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    const ex = bx + dx * len;
    const ey = by + dy * len;
    // Stroke frame: along / across the blade.
    if (!this.held) {
      this.startGroup(false);
      this.lineFrame(bx, by, dx, dy, 0);
    }
    const reach = this.reach[mat] as number;
    if (!this.box(Math.min(bx, ex), Math.min(by, ey), Math.max(bx, ex), Math.max(by, ey), hw + reach)) return;
    this.touch();
    const w = this.w;
    const dist = this.dist;
    const mats = this.mat;
    const own = this.own;
    const shade = this.shade;
    const grp = this.group;
    // (Frames are only added between shapes: the group table stays put during the loops.)
    const groups = this.frames.group;
    const shape = this.shape;
    const volOn = this.volOn;
    const il = 1 / len;
    // Row spans: across the blade |v| < R, along it u ∈ [−0.05, 1.05] (each exact where it applies).
    const R = hw * 1.01 + 0.4 + reach;
    for (let y = this.by0; y < this.by1; y++) {
      const py = y + 0.5 - by;
      let xa = this.bx0;
      let xb = this.bx1;
      if (Math.abs(dy) > 0.2) {
        const c = py * dx;
        const e0 = (c - R) / dy;
        const e1 = (c + R) / dy;
        xa = Math.max(xa, Math.floor(bx + Math.min(e0, e1) - 0.5));
        xb = Math.min(xb, Math.ceil(bx + Math.max(e0, e1) + 0.5));
      }
      if (Math.abs(dx) > 0.2) {
        const c = py * dy;
        const e0 = (-0.05 * len - c) / dx;
        const e1 = (1.05 * len - c) / dx;
        xa = Math.max(xa, Math.floor(bx + Math.min(e0, e1) - 0.5));
        xb = Math.min(xb, Math.ceil(bx + Math.max(e0, e1) + 0.5));
      }
      for (let x = xa; x < xb; x++) {
        const px = x + 0.5 - bx;
        const u = (px * dx + py * dy) * il;
        if (u < -0.05 || u > 1.05) continue;
        const v = -px * dy + py * dx;
        const t = u < 0 ? 0 : u > 1 ? 1 : u;
        // ≈ hw·sin(π·t^0.8) (rounded base, pointed tip) without transcendental calls.
        const prof = hw * 3.98 * t * (1 - t) * (1.2 - 0.4 * t) + 0.4;
        const d = (v < 0 ? -v : v) - prof + (u < 0 ? -u * len : u > 1 ? (u - 1) * len : 0);
        if (d < reach) {
          // Record d (see "Recording" above demote), k = 0.
          const i = y * w + x;
          const old = dist[i] as number;
          if (d < old) {
            if (mats[i] !== 0 && (groups[own[i * 2] as number] as number) !== grp) this.demote(i);
            own[i * 2] = shape;
            own[i * 2 + 1] = d;
            dist[i] = d;
            mats[i] = mat;
            shade[i] = volOn ? this.volAt(x, y) : 0;
          }
        }
      }
    }
  }

  /** Remove material inside a circle (hollows, knots, mushroom undersides). */
  carve(cx: number, cy: number, r: number): void {
    if (!this.box(cx - r, cy - r, cx + r, cy + r, 4)) return;
    const w = this.w;
    for (let y = this.by0; y < this.by1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = this.bx0; x < this.bx1; x++) {
        const dx = x + 0.5 - cx;
        const i = y * w + x;
        const d = r - Math.sqrt(dx * dx + dy * dy);
        if (d > (this.dist[i] as number)) this.dist[i] = d;
      }
    }
  }

  /** Emissive disc (max-blended), softness in texels. */
  glow(cx: number, cy: number, r: number, value: number, soft = 2): void {
    if (!this.box(cx - r, cy - r, cx + r, cy + r, soft + 1)) return;
    this.touch();
    const w = this.w;
    for (let y = this.by0; y < this.by1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = this.bx0; x < this.bx1; x++) {
        const dx = x + 0.5 - cx;
        const i = y * w + x;
        const e = value * coverage(Math.sqrt(dx * dx + dy * dy) - r, soft);
        if (e > (this.emit[i] as number)) this.emit[i] = e;
      }
    }
  }

  /** Baked emissive halo: a soft radial alpha that reads as light around glowing parts. */
  haloAt(cx: number, cy: number, r: number, strength: number): void {
    if (!this.box(cx - r, cy - r, cx + r, cy + r, 1)) return;
    this.touch();
    const w = this.w;
    const ir = 1 / r;
    for (let y = this.by0; y < this.by1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = this.bx0; x < this.bx1; x++) {
        const dx = x + 0.5 - cx;
        const t = 1 - Math.sqrt(dx * dx + dy * dy) * ir;
        if (t <= 0) continue;
        const i = y * w + x;
        const a = strength * t * t * t;
        if (a > (this.halo[i] as number)) this.halo[i] = a;
      }
    }
  }

  /**
   * Resolve channels into `dst` (straight RGBA8) at (dx, dy) with row stride `dstW`, and fill
   * `this.alpha` (0..1). Material-specific edge displacement and luminance detail come from the
   * noise table; the rim mask lights edges that face the upper-left moonlight.
   *
   * With `o.strokes`, the painterly pass: part of the edge noise becomes dry-brush streaks along each
   * shape's stroke direction (same amplitude budget); R gains zero-mean brush strokes (alpha-weighted
   * over the element, so the layer's mean value does not move); and inside every 2×2 atlas block the
   * rim mask concentrates into light strokes and spreads out of dark ones, keeping the block's
   * premultiplied sum (the mip-1 rim is unchanged).
   */
  finalize(dst: Uint8Array, dstW: number, dx: number, dy: number, o: FinalizeOptions = {}): void {
    const w = this.w;
    const h = this.h;
    const soft = o.softness ?? 1.25;
    const dispScale = o.dispScale ?? 1;
    const fade = o.fadeBottom ?? null;
    const rimWidth = o.rimWidth ?? 3;
    const rimStrength = o.rimStrength ?? 1;
    const detail = o.detail ?? 1;
    const edge = o.edgeFade ?? 0;
    const cut = o.cut ?? 'none';
    const alphaScale = o.alphaScale ?? 1;
    const shadeBuf = this.shade;
    const alpha = this.alpha;
    const dist = this.dist;
    const mats = this.mat;
    const halo = this.halo;
    const emit = this.emit;
    const noise = this.noise;
    const nox = this.nox;
    const noy = this.noy;
    const so = o.strokes ?? null;
    const st = this.stroke;
    const dry = so ? so.dry : 0;
    const strokeAmp = so ? so.amount * detail : 0;
    const invGain = so && so.gain > 0 ? 1 / so.gain : 1;
    // Clamped view: stores round and clamp to 0..255 natively.
    const out = new Uint8ClampedArray(dst.buffer, dst.byteOffset, dst.length);
    const nm = DISP.length;
    const dispM = new Float32Array(nm);
    const reachM = new Float32Array(nm);
    const rimM = new Float32Array(nm);
    const dryReachM = new Float32Array(nm);
    for (let m = 0; m < nm; m++) {
      dispM[m] = (DISP[m] as number) * dispScale;
      reachM[m] = (dispM[m] as number) * 1.2 + soft;
      rimM[m] = (RIM[m] as number) * rimStrength;
      dryReachM[m] = (dispM[m] as number) * EDGE_NOISE_MAX + soft * 0.5;
    }
    const invSoft = 1 / Math.max(1e-6, soft);
    // The brush value of every texel that can end up covered (bm), listed for the second pass.
    let evalN = 0;
    if (so && (dry > 0 || strokeAmp > 0)) {
      const kinds = this.frames.kind;
      const fr = this.frames.f;
      // Texels beyond the dry-brush band stay uncovered whatever the displacement: no brush needed.
      const coverM = dry > 0 ? dryReachM : reachM;
      brushOwners(w, h, this.rowMin, this.rowMax, dist, mats, coverM, st.own, st.run, st.bm, st.list, st.aux, kinds, fr);
      evalN = STROKE_OUT[0] as number;
      brushRunners(st.aux, STROKE_OUT[1] as number, w, st.own, st.run, st.bm, kinds, fr);
    }
    const bmv = st.bm;
    const bav = st.ba;
    const strokeList = st.list;
    // Stroked texels, compacted into `list` (brushOwners' list is spent) in row-major order, with the
    // alpha·amplitude-weighted sums of their brush values for the stroke mean.
    const strokeOn = so !== null;
    let strokeN = 0;
    let sumAM = 0;
    let sumA = 0;
    // The rim pass's blocks, listed here (aux is free once the runner-ups are done): 2×2 atlas blocks
    // with a rim byte ≥ RIM_MIN, as indices into the element's block grid (it fits the n-texel mark
    // and list arrays for w, h ≥ 2).
    const listRim = so !== null && so.rim > 0 && evalN > 0 && w > 1 && h > 1;
    const mark = st.mark;
    const rimBlocks = st.aux;
    let rimN = 0;
    const bx0 = dx >> 1;
    const by0 = dy >> 1;
    const bStride = ((dx + w - 1) >> 1) - bx0 + 1;
    // Rim samples toward the upper-left light. Both offsets point to earlier rows, so a single
    // row-major pass can read their final alpha.
    const lx1 = Math.round(-0.55 * rimWidth);
    const ly1 = Math.min(-1, Math.round(-0.83 * rimWidth));
    const lx2 = Math.round(-0.55 * rimWidth * 0.45);
    const ly2 = Math.min(-1, Math.round(-0.83 * rimWidth * 0.45));

    for (let y = 0; y < h; y++) {
      let rowFade = 1;
      if (fade) {
        const t = clamp01((y / h - fade[0]) / Math.max(1e-6, fade[1] - fade[0]));
        rowFade = 1 - t * t * (3 - 2 * t);
      }
      const aRow = rowFade * alphaScale;
      const top = 0.07 * (0.5 - y / h);
      const rowStart = ((dy + y) * dstW + dx) * 4;
      // Only the touched span (widened by the rim offset) can be non-zero.
      const xs = Math.max(0, (this.rowMin[y] as number) - 1);
      const xe = Math.min(w, (this.rowMax[y] as number) + 2 - lx1);
      if (xe <= xs) {
        dst.fill(0, rowStart, rowStart + w * 4);
        continue;
      }
      if (xs > 0) dst.fill(0, rowStart, rowStart + xs * 4);
      if (xe < w) dst.fill(0, rowStart + xe * 4, rowStart + w * 4);
      const edgeY = edge > 0 ? Math.min(cut !== 'top' ? y + 0.5 : Infinity, cut !== 'bottom' ? h - y - 0.5 : Infinity) : Infinity;
      const edgeYH = Math.min(y + 0.5, h - y - 0.5);
      const r1ok = y + ly1 >= 0;
      const r2ok = y + ly2 >= 0;
      const r1 = (y + ly1) * w;
      const r2 = (y + ly2) * w;
      let o4 = rowStart + xs * 4;
      for (let x = xs; x < xe; x++, o4 += 4) {
        const i = y * w + x;
        const d0 = dist[i] as number;
        const m = mats[i] as number;
        let a = 0;
        if (d0 < FAR) {
          const reach = reachM[m] as number;
          if (d0 < reach) {
            let d = d0;
            const disp = dispM[m] as number;
            // (With strokes, texels whose coverage no displacement can flip skip the noise: same bytes.)
            if (disp > 0 && d0 > -reach && (dry === 0 || (d0 < 0 ? -d0 : d0) < (dryReachM[m] as number))) {
              const f = FREQ[m] as number;
              const n1 = noise.sample(x * f + nox, y * f + noy);
              if (dry > 0) {
                // Dry brush: the fine octave (and some of the coarse one) becomes the stroke itself, so
                // the edge frays along each stroke.
                const n2 = dry < 1 ? noise.sample(x * f * 3.1 + 71 + nox, y * f * 3.1 + 13 + noy) : 0;
                d += (n1 * (0.75 - 0.35 * dry) + n2 * 0.25 * (1 - dry) + (bmv[i] as number) * (DRY_SCALE * 0.6) * dry) * disp;
              } else {
                d += (n1 * 0.75 + noise.sample(x * f * 3.1 + 71 + nox, y * f * 3.1 + 13 + noy) * 0.25) * disp;
              }
            }
            const t = 0.5 - d * invSoft;
            a = (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)) * aRow;
          }
        }
        let haloA = halo[i] as number;
        if (edge > 0 && (a > 0 || haloA > 0)) {
          const ex = Math.min(x + 0.5, w - x - 0.5);
          const e = Math.min(ex, edgeY);
          if (e < edge) {
            const t = e / edge;
            a *= t * t * (3 - 2 * t);
          }
          const eh = Math.min(ex, edgeYH);
          if (eh < edge) {
            const t = eh / edge;
            haloA *= t * t * (3 - 2 * t);
          }
        }
        alpha[i] = a;
        if (a <= 0 && haloA <= 0) {
          dst[o4] = 0;
          dst[o4 + 1] = 0;
          dst[o4 + 2] = 0;
          dst[o4 + 3] = 0;
          continue;
        }
        let lum = 0.5;
        let rim = 0;
        if (a > 0) {
          lum = 0.5 + (this.materialLum(m, x, y) + top + (shadeBuf[i] as number)) * detail;
          if (rimWidth > 0) {
            const x1 = x + lx1;
            const x2 = x + lx2;
            const s1 = r1ok && x1 >= 0 && x1 < w ? (alpha[r1 + x1] as number) : 0;
            const s2 = r2ok && x2 >= 0 && x2 < w ? (alpha[r2 + x2] as number) : 0;
            rim = a * ((1 - s1) * 0.7 + (1 - s2) * 0.5) * (rimM[m] as number);
            if (rim > 1) rim = 1;
          }
        }
        let em = emit[i] as number;
        let outA = a;
        if (haloA > a) {
          // Halo texels are pure light: emissive, no rim, neutral detail.
          const t = (haloA - a) / haloA;
          em += (1 - em) * t;
          rim *= 1 - t;
          lum += (0.5 - lum) * t;
          outA = haloA;
        }
        const a8 = Math.round(clamp01(outA) * 255);
        if (a8 === 0) {
          dst[o4] = 0;
          dst[o4 + 1] = 0;
          dst[o4 + 2] = 0;
          dst[o4 + 3] = 0;
          if (strokeOn && a > 0) bav[i] = 0;
          continue;
        }
        // With a stroke gain, the element's own detail is stored divided by it (the shader multiplies
        // it back): only the strokes added below gain, and they get the extra headroom.
        out[o4] = (invGain === 1 ? lum : 0.5 + (lum - 0.5) * invGain) * 255;
        const g255 = rim * 255;
        out[o4 + 1] = g255;
        out[o4 + 2] = em * 255;
        dst[o4 + 3] = a8;
        if (strokeOn && a > 0) {
          // Stroke amplitude from the stored bytes: kept inside [0, 1] around R, none on pure light
          // (emissive or halo texels).
          const lumB = (dst[o4] as number) * (1 / 255);
          let lim = strokeAmp;
          const lo = (lumB - 0.02) * 0.85;
          const hi = (0.98 - lumB) * 0.85;
          if (lo < lim) lim = lo;
          if (hi < lim) lim = hi;
          lim *= 1 - (dst[o4 + 2] as number) * (1 / 255);
          // (The coverage as stored in `alpha`, float32, as the rim pass reads it.)
          const af = alpha[i] as number;
          const q = a8 * (1 / 255);
          if (q > af + 0.5 / 255) lim *= af / q;
          if (lim > 0) {
            bav[i] = lim;
            strokeList[strokeN++] = i;
            sumAM += af * lim * (bmv[i] as number);
            sumA += af * lim;
          } else {
            bav[i] = 0;
          }
        }
        // (The stored byte is g255 rounded half to even: ≥ RIM_MIN exactly when g255 ≥ RIM_MIN − ½.)
        if (listRim && g255 >= RIM_MIN - 0.5) {
          const m = (((dy + y) >> 1) - by0) * bStride + ((dx + x) >> 1) - bx0;
          if (mark[m] === 0) {
            mark[m] = 1;
            rimBlocks[rimN++] = m;
          }
        }
      }
    }
    if (so) {
      // Second pass: R += amplitude·(brush − mean) on the stroked texels (zero-mean, alpha-weighted
      // over the element), then the rim mask of every 2×2 atlas block holding rim texels.
      if (strokeAmp > 0) paintLum(out, dstW, dx, dy, w, strokeList, bmv, bav, strokeN, sumA > 0 ? sumAM / sumA : 0);
      if (listRim) rimPass(dst, dstW, dx, dy, w, h, rimBlocks, rimN, bStride, mark, so.rim, alpha, st.bm, st.ba);
    }
  }

  /** Luminance detail around 0 (added to the neutral 0.5) for a material at a texel. */
  private materialLum(m: number, x: number, y: number): number {
    switch (m) {
      case Mat.Bark:
        return 0.24 * this.n(x * 1.1, y * 0.09);
      case Mat.Leaf:
        return 0.02 + 0.2 * this.n(x * 0.7 + 90, y * 0.7);
      case Mat.Stone:
        return 0.16 * this.n(x * 0.35 + 20, y * 0.35 + 50);
      case Mat.Soft:
        return -0.06;
      case Mat.Petal:
        return 0.36;
      case Mat.Stem:
        return -0.04;
      case Mat.Moss:
        return 0.14 + 0.16 * this.n(x * 1.3 + 10, y * 1.3);
      case Mat.Paper:
        return 0.3;
      case Mat.Wood:
        return 0.18 * this.n(x * 0.08 + 7, y * 0.9 + 3);
      case Mat.Fungus:
        return 0.12 + 0.1 * this.n(x * 0.8, y * 0.8);
      case Mat.PaleBark: {
        // Pale bark with dark horizontal lenticels and knots.
        const marks = this.n(x * 0.35 + 40, y * 1.9 + 7);
        return 0.46 + 0.1 * this.n(x * 0.5, y * 0.05) - (marks > 0.3 ? Math.min(0.6, (marks - 0.3) * 2.2) : 0);
      }
      case Mat.Needle:
        return 0.02 + 0.16 * this.n(x * 1.4 + 60, y * 1.4);
      default:
        return 0;
    }
  }
}
