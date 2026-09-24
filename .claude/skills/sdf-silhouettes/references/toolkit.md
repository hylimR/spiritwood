# SDF silhouette toolkit (engine-agnostic)

A self-contained TypeScript port of the repo's generator core, for reuse in other projects. It is
verified against the repo: `Rng`, `hashString` and `NoiseTable` produce bit-identical output to
`src/core/rng.ts` and `src/render/gen/noiseTable.ts`, and the primitives match `src/render/gen/sdf.ts`
to floating-point rounding. It typechecks under the repo's strict `tsconfig.base.json`
(`erasableSyntaxOnly`, so no parameter properties) and runs directly with `node file.ts` (Node ≥ 22.18).

What is simplified relative to `src/render/gen/raster.ts`: `finalize` writes a flat per-material colour
instead of the packed R detail / G rim / B emissive / A coverage channels (see the channel-packed-atlas
skill for those); there is no `leaf`, `glow`, `haloAt`, volume shading, bottom fade or edge fade; one
`reach` serves every material (raster.ts sizes it per material with `configure`); and `finalize` walks
the whole rect (raster.ts records touched row spans and reuses buffers through `Scratch`). To run the
repo's tree generator (`trees.ts`, see [building-blocks.md](building-blocks.md)) use raster.ts itself.

Contents: seeded RNG, SDF primitives and operators, a tileable fbm table, the bounded splat raster, a
lit-part baker (pillow normal + rim, as in `src/render/hero/heroParts.ts`), a usage demo, and a
GLSL ES 3.0 port for evaluating silhouettes on the GPU.

## Why each piece exists

- **sfc32 + FNV-1a:** a fast, seedable, platform-independent stream. Seed each element from a hash of
  its id so adding or removing elements never reshapes the others; `fork(salt)` gives optional passes
  their own stream.
- **Scaled-circle ellipse:** one sqrt per texel and exact on the contour, which is all AA needs for
  near-round shapes. It underestimates off the long axis by min/max, so keep aspect ≤ ~3.
- **Noise table:** 256×256 periodic fbm built once (≈ 20 ms), then a bilinear lookup (≈ 12–15 ns) per
  sample instead of ≈ 70 ns for 4-octave gradient fbm. Periodicity lets any offset wrap cleanly, so each
  element samples its own region via `noiseOffset`.
- **Splat raster:** each shape visits only its bounding box plus `reach` texels and keeps the minimum
  (or smooth minimum) distance with the nearest shape's material. `reach` must cover the band
  `finalize` reads (`disp·1.2 + soft`; raster.ts's `configure` adds 0.75), or soft or noisy outer
  edges get truncated.
- **finalize:** noise is added to the distance only inside the edge band, then `coverage` turns distance
  into alpha. Interior texels stay solid and far texels stay empty, whatever the noise does.
- **bakeLit:** for part art that should look like a soft volume. The SDF gradient (central differences)
  is the 2D normal; `e` ramps from 1 at the contour to 0 at `thickness` inside, tilting the normal from
  facing sideways to facing the viewer (a "pillow"). Diffuse picks between three palette stops; the rim
  is strongest on edges facing the light.

## toolkit.ts

```ts
// ---- Seeded RNG (sfc32) and string hash -------------------------------------------------------
export class Rng {
  private a = 0x9e3779b9;
  private b = 0x243f6a88;
  private c = 0xb7e15162;
  private d: number;
  constructor(seed: number) {
    this.d = seed >>> 0;
    for (let i = 0; i < 15; i++) this.u32();
  }
  u32(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = ((this.c << 21) | (this.c >>> 11)) + t | 0;
    return t >>> 0;
  }
  next(): number { return this.u32() / 4294967296; }
  range(min: number, max: number): number { return min + (max - min) * this.next(); }
  int(min: number, max: number): number { return min + Math.floor(this.next() * (max - min + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  /** Independent child stream: optional passes drawn from a fork don't reshuffle the parent's sequence. */
  fork(salt = 0): Rng { return new Rng((this.u32() ^ Math.imul(salt + 1, 0x85ebca6b)) >>> 0); }
}

export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

// ---- SDF primitives (negative inside) ----------------------------------------------------------
export function sdCircle(px: number, py: number, cx: number, cy: number, r: number): number {
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy) - r;
}

/** Scaled-circle approximation: exact on the boundary, underestimates by min/max off the long axis. */
export function sdEllipse(px: number, py: number, cx: number, cy: number, rx: number, ry: number): number {
  const dx = (px - cx) / rx;
  const dy = (py - cy) / ry;
  return (Math.sqrt(dx * dx + dy * dy) - 1) * Math.min(rx, ry);
}

export function sdRoundBox(px: number, py: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const dx = Math.abs(px - cx) - (hw - r);
  const dy = Math.abs(py - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(dx, dy), 0) - r;
}

/** Segment a→b, radius ra at a tapering to rb at b. */
export function sdTaperedCapsule(
  px: number, py: number, ax: number, ay: number, bx: number, by: number, ra: number, rb: number,
): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy) - (ra + (rb - ra) * h);
}

/** Polynomial smooth minimum; k = blend radius (same units as d). Max extra bulge is k/4. */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

export const opSubtract = (a: number, b: number): number => Math.max(a, -b);
export const opIntersect = (a: number, b: number): number => Math.max(a, b);
/** Hollow shell of thickness 2t around the zero contour (rings, arches). */
export const opOnion = (d: number, t: number): number => Math.abs(d) - t;

/** Coverage 0..1 from distance; the edge ramps over `soft` units centred on d = 0. */
export function coverage(d: number, soft: number): number {
  const t = 0.5 - d / Math.max(1e-6, soft);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

// ---- Tileable fbm table: one bilinear lookup per sample instead of per-texel fbm ---------------
const NS = 256;
export class NoiseTable {
  readonly data = new Float32Array(NS * NS);
  constructor(seed: number, octaves = 5, baseCells = 4) {
    const rng = new Rng(seed);
    const grads = new Float32Array(512);
    for (let i = 0; i < 256; i++) {
      const a = rng.next() * Math.PI * 2;
      grads[i * 2] = Math.cos(a);
      grads[i * 2 + 1] = Math.sin(a);
    }
    const perm = new Uint8Array(256).map((_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = perm[i] as number;
      perm[i] = perm[j] as number;
      perm[j] = t;
    }
    const g = (ix: number, iy: number, dx: number, dy: number, salt: number): number => {
      const h = (perm[((perm[(ix + salt) & 255] as number) + iy) & 255] as number) * 2;
      return (grads[h] as number) * dx + (grads[h + 1] as number) * dy;
    };
    let norm = 0;
    for (let o = 0, amp = 1; o < octaves; o++, amp *= 0.5) norm += amp;
    for (let y = 0; y < NS; y++) {
      for (let x = 0; x < NS; x++) {
        let sum = 0;
        for (let o = 0, amp = 1; o < octaves; o++, amp *= 0.5) {
          const cells = baseCells << o;
          const fx0 = (x * cells) / NS;
          const fy0 = (y * cells) / NS;
          const xi = Math.floor(fx0);
          const yi = Math.floor(fy0);
          const fx = fx0 - xi;
          const fy = fy0 - yi;
          const x1 = (xi + 1) % cells;
          const y1 = (yi + 1) % cells;
          const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
          const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
          const s = o * 31;
          const n00 = g(xi, yi, fx, fy, s);
          const n01 = g(xi, y1, fx, fy - 1, s);
          const a = n00 + u * (g(x1, yi, fx - 1, fy, s) - n00);
          const b = n01 + u * (g(x1, y1, fx - 1, fy - 1, s) - n01);
          sum += amp * (a + v * (b - a));
        }
        this.data[y * NS + x] = (sum / norm) * 1.6;
      }
    }
  }
  /** Bilinear, wraps every 256 units. Peaks ≈ ±0.6–0.75 depending on the seed, rms ≈ 0.2. */
  sample(x: number, y: number): number {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const tx = x - fx;
    const ty = y - fy;
    const x0 = fx & 255;
    const y0 = fy & 255;
    const x1 = (x0 + 1) & 255;
    const y1 = (y0 + 1) & 255;
    const d = this.data;
    const top = (d[y0 * NS + x0] as number) + ((d[y0 * NS + x1] as number) - (d[y0 * NS + x0] as number)) * tx;
    const bot = (d[y1 * NS + x0] as number) + ((d[y1 * NS + x1] as number) - (d[y1 * NS + x0] as number)) * tx;
    return top + (bot - top) * ty;
  }
}

// ---- Bounded splat raster: shapes write a distance buffer only inside their own box ------------
const FAR = 1e4;
export interface Material { disp: number; freq: number; color: readonly [number, number, number] }

export class SplatRaster {
  readonly w: number;
  readonly h: number;
  /** Texels beyond a shape's edge that still record its distance: ≥ max(disp) · 1.2 + soft (finalize's band). */
  readonly reach: number;
  readonly dist: Float32Array;
  readonly mat: Uint8Array;
  private x0 = 0;
  private y0 = 0;
  private x1 = 0;
  private y1 = 0;
  constructor(w: number, h: number, reach = 8) {
    this.w = w;
    this.h = h;
    this.reach = reach;
    this.dist = new Float32Array(w * h).fill(FAR);
    this.mat = new Uint8Array(w * h);
  }

  private box(ax: number, ay: number, bx: number, by: number, pad: number): boolean {
    this.x0 = Math.max(0, Math.floor(ax - pad));
    this.y0 = Math.max(0, Math.floor(ay - pad));
    this.x1 = Math.min(this.w, Math.ceil(bx + pad));
    this.y1 = Math.min(this.h, Math.ceil(by + pad));
    return this.x1 > this.x0 && this.y1 > this.y0;
  }

  private put(i: number, d: number, m: number, k: number): void {
    const old = this.dist[i] as number;
    if (k > 0 && old < FAR) {
      if (d < old) this.mat[i] = m;
      this.dist[i] = smin(old, d, k);
    } else if (d < old) {
      this.dist[i] = d;
      this.mat[i] = m;
    }
  }

  capsule(ax: number, ay: number, bx: number, by: number, ra: number, rb: number, m: number, k = 0): void {
    const reach = this.reach + k;
    if (!this.box(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by), Math.max(ra, rb) + reach)) return;
    for (let y = this.y0; y < this.y1; y++) {
      for (let x = this.x0; x < this.x1; x++) {
        const d = sdTaperedCapsule(x + 0.5, y + 0.5, ax, ay, bx, by, ra, rb);
        if (d < reach) this.put(y * this.w + x, d, m, k);
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, m: number, k = 0): void {
    const reach = this.reach + k;
    if (!this.box(cx - rx, cy - ry, cx + rx, cy + ry, reach)) return;
    for (let y = this.y0; y < this.y1; y++) {
      for (let x = this.x0; x < this.x1; x++) {
        const d = sdEllipse(x + 0.5, y + 0.5, cx, cy, rx, ry);
        if (d < reach) this.put(y * this.w + x, d, m, k);
      }
    }
  }

  /** Quadratic Bézier a→c→b as tapered capsule segments; joints get a small blend to hide kinks. */
  curve(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, ra: number, rb: number, m: number, k = 0, segs = 8): void {
    let px = ax;
    let py = ay;
    for (let i = 1; i <= segs; i++) {
      const t = i / segs;
      const it = 1 - t;
      const x = it * it * ax + 2 * it * t * cx + t * t * bx;
      const y = it * it * ay + 2 * it * t * cy + t * t * by;
      this.capsule(px, py, x, y, ra + (rb - ra) * ((i - 1) / segs), ra + (rb - ra) * t, m, i === 1 ? k : Math.max(k, 0.6));
      px = x;
      py = y;
    }
  }

  /** Subtract a disc (hollows, mushroom gills). Only affects shapes drawn before it. */
  carve(cx: number, cy: number, r: number): void {
    if (!this.box(cx - r, cy - r, cx + r, cy + r, 4)) return;
    for (let y = this.y0; y < this.y1; y++) {
      for (let x = this.x0; x < this.x1; x++) {
        const i = y * this.w + x;
        const d = -sdCircle(x + 0.5, y + 0.5, cx, cy, r);
        if (d > (this.dist[i] as number)) this.dist[i] = d;
      }
    }
  }

  /**
   * Distance + material → straight-alpha RGBA8. Edge noise is added to the distance only near the
   * edge, per material; `soft` is the AA width in texels (large values bake a blur).
   */
  finalize(noise: NoiseTable, mats: readonly Material[], soft = 1.25, dispScale = 1, noiseOffset = 0): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4);
    const ox = (noiseOffset * 97.13) % 256;
    const oy = (noiseOffset * 57.71) % 256;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = y * this.w + x;
        let d = this.dist[i] as number;
        if (d >= FAR) continue;
        const m = mats[this.mat[i] as number] as Material;
        const disp = m.disp * dispScale;
        if (d > disp * 1.2 + soft) continue;
        if (disp > 0 && d > -(disp * 1.2 + soft)) {
          const f = m.freq;
          d += (noise.sample(x * f + ox, y * f + oy) * 0.75 + noise.sample(x * f * 3.1 + 71 + ox, y * f * 3.1 + 13 + oy) * 0.25) * disp;
        }
        const a = coverage(d, soft);
        if (a <= 0) continue;
        out[i * 4] = Math.round(m.color[0] * 255);
        out[i * 4 + 1] = Math.round(m.color[1] * 255);
        out[i * 4 + 2] = Math.round(m.color[2] * 255);
        out[i * 4 + 3] = Math.round(a * 255);
      }
    }
    return out;
  }
}

// ---- Lit SDF part: pillow normal from the distance, rim toward the light -----------------------
export function bakeLit(
  sdf: (x: number, y: number) => number, x0: number, y0: number, x1: number, y1: number, density: number,
  lightX: number, lightY: number, thickness: number,
  deep: readonly number[], mid: readonly number[], light: readonly number[],
): { w: number; h: number; rgba: Float32Array } {
  const w = Math.ceil((x1 - x0) * density);
  const h = Math.ceil((y1 - y0) * density);
  const rgba = new Float32Array(w * h * 4);
  const l3 = Math.hypot(lightX * 0.8, lightY * 0.8, 0.6);
  const Lx = (lightX * 0.8) / l3;
  const Ly = (lightY * 0.8) / l3;
  const Lz = 0.6 / l3;
  const eps = 0.5 / density;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = x0 + (px + 0.5) / density;
      const y = y0 + (py + 0.5) / density;
      const d = sdf(x, y);
      const cov = coverage(d, 1.15 / density);
      if (cov <= 0) continue;
      let gx = sdf(x + eps, y) - sdf(x - eps, y);
      let gy = sdf(x, y + eps) - sdf(x, y - eps);
      const gl = Math.sqrt(gx * gx + gy * gy) || 1;
      gx /= gl;
      gy /= gl;
      const e = 1 - Math.min(1, Math.max(0, -d / thickness));
      const nz = Math.sqrt(Math.max(0, 1 - e * e));
      const diff = 0.28 + 0.72 * Math.max(0, gx * e * Lx + gy * e * Ly + nz * Lz);
      const facing = Math.max(0, gx * lightX + gy * lightY);
      const t = Math.min(1, Math.max(0, (e - 0.6) / 0.37));
      const rim = t * t * (3 - 2 * t) * (0.06 + 0.94 * Math.pow(facing, 1.3)) * 0.9;
      const o = (py * w + px) * 4;
      for (let c = 0; c < 3; c++) {
        const base = diff < 0.55
          ? (deep[c] as number) + ((mid[c] as number) - (deep[c] as number)) * (diff / 0.55)
          : (mid[c] as number) + ((light[c] as number) - (mid[c] as number)) * ((diff - 0.55) / 0.45);
        rgba[o + c] = base + (1 - base) * rim;
      }
      rgba[o + 3] = cov;
    }
  }
  return { w, h, rgba };
}
```

## Usage

```ts
import { bakeLit, hashString, NoiseTable, Rng, sdCircle, sdEllipse, smin, SplatRaster, type Material } from './toolkit.ts';
import { writePng } from './png.ts'; // tools/preview/png.ts: 55 lines, node:fs + node:zlib only

const MATS: Material[] = [
  { disp: 0, freq: 0, color: [0, 0, 0] },
  { disp: 1.2, freq: 0.9, color: [0.1, 0.13, 0.18] },
  { disp: 4.5, freq: 1.1, color: [0.12, 0.17, 0.2] },
];
const BARK = 1;
const LEAF = 2;
const noise = new NoiseTable(7);
const rng = new Rng(hashString('tree:0'));
const r = new SplatRaster(160, 220);
r.curve(80, 214, 84, 150, 78, 90, 7, 3, BARK, 4, 12);
r.curve(80, 140, 60, 120, 40, 96, 3, 1.2, BARK, 2, 8);
for (let i = 0; i < 30; i++) {
  const a = rng.range(0, Math.PI * 2);
  const d = Math.pow(rng.next(), 0.4) * 0.8;
  r.ellipse(80 + Math.cos(a) * 44 * d, 70 + Math.sin(a) * 50 * d, 12, 10, LEAF, 3);
}
r.carve(96, 80, 5);
const rgba = r.finalize(noise, MATS, 1.25, 1, 3);
const bg = new Uint8Array(rgba.length);
for (let i = 0; i < rgba.length; i += 4) {
  const a = rgba[i + 3]! / 255;
  bg[i] = Math.round(rgba[i]! * a + 70 * (1 - a));
  bg[i + 1] = Math.round(rgba[i + 1]! * a + 95 * (1 - a));
  bg[i + 2] = Math.round(rgba[i + 2]! * a + 120 * (1 - a));
  bg[i + 3] = 255;
}
writePng('tree.png', bg, 160, 220);

const head = (x: number, y: number): number => smin(sdEllipse(x, y, 0.6, -11.4, 12.3, 11.2), sdCircle(x, y, 4.2, -7.2, 7.4), 3.5);
const lit = bakeLit(head, -13.5, -25, 15, 1.5, 4, -0.6, -0.8, 8, [0.47, 0.79, 0.93], [0.61, 0.9, 1], [0.93, 1, 1]);
const px = new Uint8Array(lit.w * lit.h * 4);
for (let i = 0; i < lit.w * lit.h; i++) {
  const a = lit.rgba[i * 4 + 3]!;
  for (let c = 0; c < 3; c++) px[i * 4 + c] = Math.round((lit.rgba[i * 4 + c]! * a + 0.06 * (1 - a)) * 255);
  px[i * 4 + 3] = 255;
}
writePng('head.png', px, lit.w, lit.h);
```

`tree.png` is deliberately naive (one crown of scattered clumps on a stick). For crowns that read as
foliage, use the clump-of-clumps crown on a branching skeleton in
[building-blocks.md](building-blocks.md).

## GLSL ES 3.0 port (GPU evaluation)

Use when a silhouette animates or morphs, or must stay sharp at any zoom. `fwidth(d)` sizes the AA ramp
to one screen pixel whatever the scale, which is the GPU counterpart of `coverage(d, soft)`. The chunk
passes the static checks of `tests/world/glsl.test.ts` (headers, reserved words, balanced delimiters,
every called function defined, counting `fwidth`, a core GLSL ES 3.00 built-in missing from that test's
list); it has not been compiled by a GPU driver.

```glsl
float sdCircle(vec2 p, vec2 c, float r) {
  return length(p - c) - r;
}
float sdEllipseApprox(vec2 p, vec2 c, vec2 r) {
  return (length((p - c) / r) - 1.0) * min(r.x, r.y);
}
float sdTaperedCapsule(vec2 p, vec2 a, vec2 b, float ra, float rb) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h) - mix(ra, rb, h);
}
float smin(float a, float b, float k) {
  float h = max(k - abs(a - b), 0.0) / max(k, 1e-6);
  return min(a, b) - h * h * k * 0.25;
}
float sdfCoverage(float d) {
  float w = max(fwidth(d), 1e-4);
  return 1.0 - smoothstep(-0.5 * w, 0.5 * w, d);
}
```

A fragment shader using it with the repo's `GLSL_FRAGMENT_HEADER` and `GLSL_NOISE` chunks
(`src/render/shaders/common.ts`; `sw_fbm` returns about 0–0.94 with mean ≈ 0.47, hence the offset).
Output is premultiplied.

```glsl
// GLSL_FRAGMENT_HEADER ('#version 300 es' + precision highp), then:
in vec2 vLocal;
out vec4 finalColor;
// GLSL_NOISE chunk, then the SDF chunk above
void main() {
  float d = sdTaperedCapsule(vLocal, vec2(0.0, 0.0), vec2(4.0, -60.0), 5.0, 1.5);
  d = smin(d, sdEllipseApprox(vLocal, vec2(4.0, -72.0), vec2(22.0, 16.0)), 4.0);
  d += (sw_fbm(vLocal * 0.15) - 0.47) * 3.0;
  float a = sdfCoverage(d);
  finalColor = vec4(vec3(0.02, 0.04, 0.07) * a, a);
}
```

Rules for the GPU path: never name a helper `union`, `sample`, `filter`, `common`, `input`, `output` or
`active` (reserved in GLSL ES 3.00); no `discard` in opaque passes (early-Z); in Pixi, put
`precision highp float;` right after `#version 300 es` *and* pass `preferredFragmentPrecision: 'highp'`
to `GlProgram.from` (Pixi strips the version line and prepends `precision mediump float;` by default),
and do not reuse Pixi's uniform names (`uColor`, `uTransformMatrix`, `uProjectionMatrix`,
`uWorldTransformMatrix`, `uWorldColorAlpha`, `uResolution`, `uRound`).
Per-pixel SDF cost scales with the number of primitives, so on the GPU keep to a handful per shape and
bake anything with dozens of clumps.
