import { clamp01 } from '../../core/math.ts';
import { coverage, smin } from './sdf.ts';
import type { NoiseTable } from './noiseTable.ts';

/**
 * CPU rasteriser for kit elements. Shapes are splatted into a signed-distance buffer (texels,
 * negative inside) only within their bounding boxes, each tagged with a material; `finalize` turns
 * distance + material into the atlas channels (R luminance detail, G rim mask, B emissive, A coverage).
 * Inner loops use sqrt-based distances (Math.hypot is several times slower in V8).
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
    }
    if (this.rowMin.length < rows) {
      this.rowMin = new Int32Array(rows);
      this.rowMax = new Int32Array(rows);
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
  private readonly noise: NoiseTable;
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
    } else {
      this.dist = new Float32Array(n).fill(FAR);
      this.mat = new Uint8Array(n);
      this.emit = new Float32Array(n);
      this.halo = new Float32Array(n);
      this.alpha = new Float32Array(n);
      this.shade = new Float32Array(n);
      this.rowMin = new Int32Array(h).fill(w);
      this.rowMax = new Int32Array(h).fill(-1);
    }
    this.noise = noise;
    this.nox = (noiseOffset * 97.13) % 256;
    this.noy = (noiseOffset * 57.71) % 256;
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
   * instead of a generous default. Call before drawing.
   */
  configure(o: FinalizeOptions): void {
    const soft = o.softness ?? 1.25;
    const dispScale = o.dispScale ?? 1;
    for (let m = 0; m < DISP.length; m++) this.reach[m] = (DISP[m] as number) * dispScale * 1.2 + soft + 0.75;
  }

  /** Element-specific noise in about [-1, 1]. */
  n(x: number, y: number): number {
    return this.noise.sample(x + this.nox, y + this.noy);
  }

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

  private put(i: number, x: number, y: number, d: number, mat: Mat, k: number): void {
    const old = this.dist[i] as number;
    if (k > 0 && old < FAR) {
      if (d < old) {
        this.mat[i] = mat;
        this.shade[i] = this.volOn ? this.volAt(x, y) : 0;
      }
      this.dist[i] = smin(old, d, k);
    } else if (d < old) {
      this.dist[i] = d;
      this.mat[i] = mat;
      this.shade[i] = this.volOn ? this.volAt(x, y) : 0;
    }
  }

  /** Tapered capsule a→b (radius ra at a, rb at b), smooth-unioned with blend radius k. */
  capsule(ax: number, ay: number, bx: number, by: number, ra: number, rb: number, mat: Mat, k = 0): void {
    const reach = (this.reach[mat] as number) + k;
    if (!this.box(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), Math.max(ra, rb) + reach)) return;
    this.touch();
    const bax = bx - ax;
    const bay = by - ay;
    const len2 = bax * bax + bay * bay;
    const inv = 1 / (len2 || 1);
    const w = this.w;
    const dist = this.dist;
    // Rows only need the slab within `rm` of the segment's line (exact for diagonal limbs).
    const rm = Math.max(ra, rb) + reach;
    const ilen = len2 > 1e-6 ? 1 / Math.sqrt(len2) : 0;
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
        if (d < reach && d < (dist[y * w + x] as number) + k) this.put(y * w + x, x, y, d, mat, k);
      }
    }
  }

  /** Quadratic Bézier a→c→b made of tapered capsule segments. */
  curve(
    ax: number, ay: number, cx: number, cy: number, bx: number, by: number,
    ra: number, rb: number, mat: Mat, k = 0, segments = 8,
  ): void {
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
  }

  /** Point on the quadratic Bézier a→c→b at t. */
  static bezier(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, t: number, out: { x: number; y: number }): void {
    const it = 1 - t;
    out.x = it * it * ax + 2 * it * t * cx + t * t * bx;
    out.y = it * it * ay + 2 * it * t * cy + t * t * by;
  }

  /** Ellipse (scaled-circle distance approximation — fine for soft organic masses). */
  ellipse(cx: number, cy: number, rx: number, ry: number, mat: Mat, k = 0): void {
    const reach = (this.reach[mat] as number) + k;
    if (!this.box(cx - rx, cy - ry, cx + rx, cy + ry, reach)) return;
    this.touch();
    const irx = 1 / rx;
    const iry = 1 / ry;
    const m = Math.min(rx, ry);
    const w = this.w;
    const dist = this.dist;
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
        if (d < reach && d < (dist[y * w + x] as number) + k) this.put(y * w + x, x, y, d, mat, k);
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
    const reach = this.reach[mat] as number;
    if (!this.box(Math.min(bx, ex), Math.min(by, ey), Math.max(bx, ex), Math.max(by, ey), hw + reach)) return;
    this.touch();
    const w = this.w;
    const dist = this.dist;
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
        if (d < reach && d < (dist[y * w + x] as number)) this.put(y * w + x, x, y, d, mat, 0);
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
    // Clamped view: stores round and clamp to 0..255 natively.
    const out = new Uint8ClampedArray(dst.buffer, dst.byteOffset, dst.length);
    const nm = DISP.length;
    const dispM = new Float32Array(nm);
    const reachM = new Float32Array(nm);
    const rimM = new Float32Array(nm);
    for (let m = 0; m < nm; m++) {
      dispM[m] = (DISP[m] as number) * dispScale;
      reachM[m] = (dispM[m] as number) * 1.2 + soft;
      rimM[m] = (RIM[m] as number) * rimStrength;
    }
    const invSoft = 1 / Math.max(1e-6, soft);
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
            if (disp > 0 && d0 > -reach) {
              const f = FREQ[m] as number;
              d += (noise.sample(x * f + nox, y * f + noy) * 0.75 + noise.sample(x * f * 3.1 + 71 + nox, y * f * 3.1 + 13 + noy) * 0.25) * disp;
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
          continue;
        }
        out[o4] = lum * 255;
        out[o4 + 1] = rim * 255;
        out[o4 + 2] = em * 255;
        dst[o4 + 3] = a8;
      }
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
