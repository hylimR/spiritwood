/**
 * Brush-stroke texture for the painterly pass (ARCHITECTURE.md §5.5), evaluated in a shape's local
 * stroke coordinates (u along the stroke, v across it, in texels). Pure and allocation-free.
 *
 * Strokes are elongated gradient-noise bands, contrast-shaped into plateaus (even stroke bodies,
 * soft edges), at two scales (broad strokes and strokes of the finest width). The noise comes from two
 * precomputed periodic tables, bilinear like the kit's noise table: a line table, and a polar table
 * with four broad cells around, so a lobe's strokes (u = r̄·φ) wrap with a whole number of table
 * periods and no seam.
 */
export interface StrokeOptions {
  /** Finest stroke width across (texels, ≥ 3). */
  width: number;
  /** Length / width of a stroke (4–6). */
  stretch: number;
  /** Luminance (R) amplitude of a full-strength stroke. */
  amount: number;
  /** How strongly the rim mask concentrates into light strokes and spreads out of dark ones (0 = off). */
  rim: number;
  /** Share of the edge noise that becomes dry-brush breakup along the stroke direction (0..1). */
  dry: number;
  /**
   * Stroke gain of the layers that show the element (their kit shading's `strokeGain`, ≥ 1): the bake
   * stores the element's own luminance detail divided by it, and the shader multiplies R's deviation
   * from 0.5 by it again, so the detail comes back unchanged and only the strokes gain (without
   * clipping R).
   */
  gain: number;
}

/** Painterly-pass constants. */
export const STROKE = {
  /** Stroke length / width. */
  stretch: 5,
  /** R amplitude of a full-strength stroke: ±0.3–0.4 moves final luma by 3–5 codes on L3–L8. */
  amount: 0.4,
  /** Rim-mask concentration exponent scale (γ = e^(rim·stroke) inside each 2×2 block). */
  rim: 1.1,
  /** Dry-brush share of the edge noise: it replaces the fine octave and part of the coarse one. */
  dry: 1,
  /** Strokes are never narrower than this many texels (they survive mip 1 as strokes, not speckle)… */
  minTexels: 3,
  /** …nor narrower than this many pixels at the minimum render scale (kitElements.ts MIN_PX_PER_UNIT). */
  minPixels: 2,
} as const;

/**
 * Finest stroke width in texels for strokes of `units` layer units on an element of `unitsPerTexel`:
 * at least STROKE.minTexels, and at least STROKE.minPixels where the element's smallest instance
 * (`minScale`) is drawn at `pxPerUnit` screen pixels per layer unit (the minimum render scale).
 */
export function strokeWidthTexels(units: number, unitsPerTexel: number, minScale: number, pxPerUnit: number): number {
  const px = STROKE.minPixels / (pxPerUnit * unitsPerTexel * minScale);
  return Math.max(STROKE.minTexels, units / unitsPerTexel, px);
}

/** 32-bit integer hash of (x, y, salt) → [0, 1). */
export function strokeHash(x: number, y: number, salt: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const SIZE = 128;
const MASK = SIZE - 1;
/** Line tables: broad strokes in 16 × 16 gradient-noise cells (8 table units per cell), fine ones in 32 × 32. */
const LINE_CELLS = 16;
/**
 * Polar tables: 4 broad cells across x (32 units each; 8 fine), 16 along y (32 fine). A lobe takes at
 * least 4 broad cells around (dabs that break up the form, not a light half and a dark half).
 */
const POLAR_CELLS_X = 4;
/** Weights of the broad and fine scales, and the contrast before the plateau (the scales have unit rms). */
const BROAD_WEIGHT = 0.64;
const FINE_WEIGHT = 0.36;
const GAIN = 2.2;

/** bodyTable scratch: gradients (up to 32 × 32 cells), per-column cells, offsets and fades, raw octaves. */
const GRAD_BX = new Float32Array(1024);
const GRAD_BY = new Float32Array(1024);
const GRAD_FX = new Float32Array(1024);
const GRAD_FY = new Float32Array(1024);
const COL_B0 = new Int32Array(SIZE);
const COL_B1 = new Int32Array(SIZE);
const COL_BF = new Float64Array(SIZE);
const COL_BV = new Float64Array(SIZE);
const COL_F0 = new Int32Array(SIZE);
const COL_F1 = new Int32Array(SIZE);
const COL_FF = new Float64Array(SIZE);
const COL_FV = new Float64Array(SIZE);
const RAW_B = new Float32Array(SIZE * SIZE);
const RAW_F = new Float32Array(SIZE * SIZE);

/** Unit gradients of a periodic noise with cx × cy cells, and its per-column cells and quintic fades. */
function gradientSetup(
  cx: number, cy: number, salt: number, gx: Float32Array, gy: Float32Array, c0: Int32Array, c1: Int32Array, cf: Float64Array, cv: Float64Array,
): void {
  for (let j = 0; j < cy; j++) {
    for (let i = 0; i < cx; i++) {
      const a = strokeHash(i, j, salt) * Math.PI * 2;
      gx[j * cx + i] = Math.cos(a);
      gy[j * cx + i] = Math.sin(a);
    }
  }
  for (let x = 0; x < SIZE; x++) {
    const fx0 = (x / SIZE) * cx;
    const i0 = Math.floor(fx0);
    const fx = fx0 - i0;
    c0[x] = i0;
    c1[x] = (i0 + 1) % cx;
    cf[x] = fx;
    cv[x] = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  }
}

/**
 * One body brush table into `out` at `base`: periodic gradient noise (quintic fade) with cx × cy broad
 * cells plus a fine octave at twice the frequency on both axes (so the sum stays periodic), each
 * normalised to unit rms, then contrast-shaped into plateaus — stroke bodies of even value with soft
 * edges. One bilinear lookup per texel. (Both octaves in one pass, the shaping in a second: the cold
 * boot runs few, long loops.)
 */
function bodyTable(out: Float32Array, base: number, cx: number, cy: number, saltB: number, saltF: number): void {
  const bx = GRAD_BX;
  const by = GRAD_BY;
  const fxg = GRAD_FX;
  const fyg = GRAD_FY;
  gradientSetup(cx, cy, saltB, bx, by, COL_B0, COL_B1, COL_BF, COL_BV);
  const cx2 = cx * 2;
  const cy2 = cy * 2;
  gradientSetup(cx2, cy2, saltF, fxg, fyg, COL_F0, COL_F1, COL_FF, COL_FV);
  let sqB = 0;
  let sqF = 0;
  for (let y = 0; y < SIZE; y++) {
    const gy0 = (y / SIZE) * cy;
    const j0 = Math.floor(gy0);
    const fy = gy0 - j0;
    const r0 = j0 * cx;
    const r1 = ((j0 + 1) % cy) * cx;
    const vy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const fy1 = fy - 1;
    const hy0 = (y / SIZE) * cy2;
    const k0 = Math.floor(hy0);
    const hy = hy0 - k0;
    const q0 = k0 * cx2;
    const q1 = ((k0 + 1) % cy2) * cx2;
    const wy = hy * hy * hy * (hy * (hy * 6 - 15) + 10);
    const hy1 = hy - 1;
    for (let x = 0; x < SIZE; x++) {
      const i0 = COL_B0[x] as number;
      const i1 = COL_B1[x] as number;
      const fx = COL_BF[x] as number;
      const vx = COL_BV[x] as number;
      const n00 = (bx[r0 + i0] as number) * fx + (by[r0 + i0] as number) * fy;
      const n10 = (bx[r0 + i1] as number) * (fx - 1) + (by[r0 + i1] as number) * fy;
      const n01 = (bx[r1 + i0] as number) * fx + (by[r1 + i0] as number) * fy1;
      const n11 = (bx[r1 + i1] as number) * (fx - 1) + (by[r1 + i1] as number) * fy1;
      const a = n00 + (n10 - n00) * vx;
      const v = a + (n01 + (n11 - n01) * vx - a) * vy;
      RAW_B[y * SIZE + x] = v;
      sqB += v * v;
      const l0 = COL_F0[x] as number;
      const l1 = COL_F1[x] as number;
      const hx = COL_FF[x] as number;
      const wx = COL_FV[x] as number;
      const m00 = (fxg[q0 + l0] as number) * hx + (fyg[q0 + l0] as number) * hy;
      const m10 = (fxg[q0 + l1] as number) * (hx - 1) + (fyg[q0 + l1] as number) * hy;
      const m01 = (fxg[q1 + l0] as number) * hx + (fyg[q1 + l0] as number) * hy1;
      const m11 = (fxg[q1 + l1] as number) * (hx - 1) + (fyg[q1 + l1] as number) * hy1;
      const b = m00 + (m10 - m00) * wx;
      const u = b + (m01 + (m11 - m01) * wx - b) * wy;
      RAW_F[y * SIZE + x] = u;
      sqF += u * u;
    }
  }
  const kB = 1 / Math.sqrt(sqB / (SIZE * SIZE));
  const kF = 1 / Math.sqrt(sqF / (SIZE * SIZE));
  for (let i = 0; i < SIZE * SIZE; i++) {
    // (Each octave normalised to float32, as a stored table would be.)
    const nb = Math.fround((RAW_B[i] as number) * kB);
    const nf = Math.fround((RAW_F[i] as number) * kF);
    const t = (nb * BROAD_WEIGHT + nf * FINE_WEIGHT) * GAIN;
    out[base + i] = t / Math.sqrt(1 + t * t);
  }
}

/**
 * Both body brush tables in one array (BRUSH_SIZE² each, wrap-around): the line table (open frames),
 * then at BRUSH_POLAR_BASE the polar table (four broad cells around, for periodic frames).
 */
export const BRUSH_BODY = new Float32Array(SIZE * SIZE * 2);
bodyTable(BRUSH_BODY, 0, LINE_CELLS, LINE_CELLS, 0x51f1, 0x2d9b);
bodyTable(BRUSH_BODY, SIZE * SIZE, POLAR_CELLS_X, LINE_CELLS, 0x7a3b, 0x6c4f);
export const BRUSH_POLAR_BASE = SIZE * SIZE;
export const LINE_BODY = BRUSH_BODY.subarray(0, SIZE * SIZE);
export const POLAR_BODY = BRUSH_BODY.subarray(SIZE * SIZE);
/** Brush table size (a power of two; lookups wrap with `& (BRUSH_SIZE − 1)`). */
export const BRUSH_SIZE = SIZE;

/** Bilinear sample with wrap-around at table coordinates (X, Y) (raster.ts inlines the same lookup). */
export function sample(t: Float32Array, X: number, Y: number): number {
  const fx = Math.floor(X);
  const fy = Math.floor(Y);
  const tx = X - fx;
  const ty = Y - fy;
  const x0 = fx & MASK;
  const y0 = fy & MASK;
  const x1 = (x0 + 1) & MASK;
  const y1 = (y0 + 1) & MASK;
  const a = t[y0 * SIZE + x0] as number;
  const b = t[y0 * SIZE + x1] as number;
  const c = t[y1 * SIZE + x0] as number;
  const d = t[y1 * SIZE + x1] as number;
  const top = a + (b - a) * tx;
  return top + (c + (d - c) * tx - top) * ty;
}

/** Table units per broad cell of the line tables and the polar tables' y axis, and along the polar x axis. */
const CELL = SIZE / LINE_CELLS;
const POLAR_CELL = SIZE / POLAR_CELLS_X;
/** Gradient-noise bands are about this fraction of a cell wide: strokes `w` wide use cells of w / BAND. */
const BAND = 0.55;
/** Broad strokes are twice the finest width (and twice as long): the fine scale is the table's second octave. */
const BROAD = 2;
/**
 * The dry brush displaces edges by the body brush scaled to the kit edge noise's rms (about 0.19):
 * the same displacement budget, but the edge frays along each stroke (the body brush's rms is ~0.7).
 */
export const DRY_SCALE = 0.19 / 0.7;

/**
 * Broad cells around a periodic frame of `period` texels for strokes `len` long: a multiple of the polar
 * tables' POLAR_CELLS_X (whole table periods: no seam at φ = ±π), at least one table period.
 */
export function cellsAround(period: number, len: number): number {
  const n = POLAR_CELLS_X * Math.round(period / (POLAR_CELLS_X * len));
  return n < POLAR_CELLS_X ? POLAR_CELLS_X : n;
}

/**
 * An element's brush as table units per texel: the across (v) scale is fixed; the along (u) scale
 * depends on the frame — open frames use the stroke length, periodic (polar) frames a whole number of
 * table periods around (cellsAround).
 */
export class BrushKernel {
  /** Across → table units (broad cells). */
  readonly kv: number;
  /** Broad stroke length (texels). */
  readonly len: number;

  constructor(o: StrokeOptions) {
    const wb = (o.width * BROAD) / BAND;
    this.kv = CELL / wb;
    this.len = wb * o.stretch;
  }

  /** Along (u) → table units for a frame of along period `period` (0 = open). */
  along(period: number): number {
    return period > 0 ? (cellsAround(period, this.len) * POLAR_CELL) / period : CELL / this.len;
  }

  /** Body brush in (−1, 1) at stroke coordinates (u, v) with the frame's along scale `ka` (one lookup). */
  body(polar: boolean, u: number, v: number, ka: number): number {
    return sample(polar ? POLAR_BODY : LINE_BODY, u * ka, v * this.kv);
  }
}

/**
 * Body brush in (−1, 1) at stroke coordinates (u, v); `period` > 0 for polar frames (the along period,
 * 2π·r̄). A convenience form of BrushKernel for tests and tools.
 */
export function brushStroke(u: number, v: number, period: number, o: StrokeOptions): number {
  const k = new BrushKernel(o);
  return k.body(period > 0, u, v, k.along(period));
}
