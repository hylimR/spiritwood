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
} as const;
export type Mat = (typeof Mat)[keyof typeof Mat];

const FAR = 1e4;
/** Per material: edge displacement amplitude (texels), noise frequency (table units/texel), rim response. */
const DISP = new Float32Array([0, 1.2, 4.5, 1.6, 6, 0.4, 0.3, 2.2, 0, 0.8, 0.6]);
const FREQ = new Float32Array([0, 0.9, 1.1, 0.6, 0.35, 1.5, 1.5, 1.2, 0, 0.8, 1]);
const RIM = new Float32Array([0, 1, 0.85, 1, 0, 0.6, 0.7, 0.9, 0.3, 1, 0.8]);

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
  /**
   * Alpha fades to 0 over this many texels at the rect edges (a safety net so nothing is hard-cut by
   * the rect), except at an intentionally cut edge.
   */
  edgeFade?: number;
  cut?: 'none' | 'top' | 'bottom';
}

export class ElementRaster {
  readonly w: number;
  readonly h: number;
  readonly dist: Float32Array;
  readonly mat: Uint8Array;
  readonly emit: Float32Array;
  readonly halo: Float32Array;
  readonly alpha: Float32Array;
  private readonly noise: NoiseTable;
  private readonly nox: number;
  private readonly noy: number;
  private bx0 = 0;
  private by0 = 0;
  private bx1 = 0;
  private by1 = 0;

  constructor(w: number, h: number, noise: NoiseTable, noiseOffset: number) {
    this.w = w;
    this.h = h;
    this.dist = new Float32Array(w * h).fill(FAR);
    this.mat = new Uint8Array(w * h);
    this.emit = new Float32Array(w * h);
    this.halo = new Float32Array(w * h);
    this.alpha = new Float32Array(w * h);
    this.noise = noise;
    this.nox = (noiseOffset * 97.13) % 256;
    this.noy = (noiseOffset * 57.71) % 256;
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

  private put(i: number, d: number, mat: Mat, k: number): void {
    const old = this.dist[i] as number;
    if (k > 0 && old < FAR) {
      if (d < old) this.mat[i] = mat;
      this.dist[i] = smin(old, d, k);
    } else if (d < old) {
      this.dist[i] = d;
      this.mat[i] = mat;
    }
  }

  /** Tapered capsule a→b (radius ra at a, rb at b), smooth-unioned with blend radius k. */
  capsule(ax: number, ay: number, bx: number, by: number, ra: number, rb: number, mat: Mat, k = 0): void {
    const reach = 8 + k;
    if (!this.box(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), Math.max(ra, rb) + reach)) return;
    const bax = bx - ax;
    const bay = by - ay;
    const inv = 1 / (bax * bax + bay * bay || 1);
    const w = this.w;
    for (let y = this.by0; y < this.by1; y++) {
      const pay = y + 0.5 - ay;
      for (let x = this.bx0; x < this.bx1; x++) {
        const pax = x + 0.5 - ax;
        let t = (pax * bax + pay * bay) * inv;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = pax - bax * t;
        const dy = pay - bay * t;
        const d = Math.sqrt(dx * dx + dy * dy) - (ra + (rb - ra) * t);
        if (d < reach) this.put(y * w + x, d, mat, k);
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
    const reach = 8 + k;
    if (!this.box(cx - rx, cy - ry, cx + rx, cy + ry, reach)) return;
    const irx = 1 / rx;
    const iry = 1 / ry;
    const m = Math.min(rx, ry);
    const w = this.w;
    for (let y = this.by0; y < this.by1; y++) {
      const dy = (y + 0.5 - cy) * iry;
      for (let x = this.bx0; x < this.bx1; x++) {
        const dx = (x + 0.5 - cx) * irx;
        const d = (Math.sqrt(dx * dx + dy * dy) - 1) * m;
        if (d < reach) this.put(y * w + x, d, mat, k);
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
    if (!this.box(Math.min(bx, ex), Math.min(by, ey), Math.max(bx, ex), Math.max(by, ey), hw + 6)) return;
    const w = this.w;
    const il = 1 / len;
    for (let y = this.by0; y < this.by1; y++) {
      const py = y + 0.5 - by;
      for (let x = this.bx0; x < this.bx1; x++) {
        const px = x + 0.5 - bx;
        const u = (px * dx + py * dy) * il;
        if (u < -0.05 || u > 1.05) continue;
        const v = -px * dy + py * dx;
        const t = u < 0 ? 0 : u > 1 ? 1 : u;
        // ≈ hw·sin(π·t^0.8) (rounded base, pointed tip) without transcendental calls.
        const prof = hw * 3.98 * t * (1 - t) * (1.2 - 0.4 * t) + 0.4;
        const d = (v < 0 ? -v : v) - prof + (u < 0 ? -u * len : u > 1 ? (u - 1) * len : 0);
        if (d < 6) this.put(y * w + x, d, mat, 0);
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
    const alpha = this.alpha;
    const dist = this.dist;
    const mats = this.mat;
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
      const top = 0.07 * (0.5 - y / h);
      let o4 = ((dy + y) * dstW + dx) * 4;
      for (let x = 0; x < w; x++, o4 += 4) {
        const i = y * w + x;
        const d0 = dist[i] as number;
        const m = mats[i] as number;
        let a = 0;
        if (d0 < FAR) {
          const disp = (DISP[m] as number) * dispScale;
          const reach = disp * 1.2 + soft;
          if (d0 < reach) {
            let d = d0;
            if (disp > 0 && d0 > -reach) {
              const f = FREQ[m] as number;
              d += (this.n(x * f, y * f) * 0.75 + this.n(x * f * 3.1 + 71, y * f * 3.1 + 13) * 0.25) * disp;
            }
            a = coverage(d, soft) * rowFade;
          }
        }
        let haloA = this.halo[i] as number;
        if (edge > 0 && (a > 0 || haloA > 0)) {
          const ex = Math.min(x + 0.5, w - x - 0.5);
          let e = ex;
          if (cut !== 'top') e = Math.min(e, y + 0.5);
          if (cut !== 'bottom') e = Math.min(e, h - y - 0.5);
          if (e < edge) {
            const t = e / edge;
            a *= t * t * (3 - 2 * t);
          }
          const eh = Math.min(ex, y + 0.5, h - y - 0.5);
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
          lum = 0.5 + (this.materialLum(m, x, y) + top) * detail;
          if (rimWidth > 0) {
            const s1 = alphaAt(alpha, w, h, x + lx1, y + ly1);
            const s2 = alphaAt(alpha, w, h, x + lx2, y + ly2);
            rim = clamp01(a * ((1 - s1) * 0.7 + (1 - s2) * 0.5) * (RIM[m] as number) * rimStrength);
          }
        }
        let em = this.emit[i] as number;
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
        dst[o4] = a8 === 0 ? 0 : Math.round(clamp01(lum) * 255);
        dst[o4 + 1] = a8 === 0 ? 0 : Math.round(rim * 255);
        dst[o4 + 2] = a8 === 0 ? 0 : Math.round(clamp01(em) * 255);
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
      default:
        return 0;
    }
  }
}

function alphaAt(alpha: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= w || y >= h) return 0;
  return alpha[y * w + x] as number;
}
