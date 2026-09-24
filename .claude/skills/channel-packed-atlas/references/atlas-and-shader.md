# Atlas and shader listings (channel-packed-atlas)

These excerpts are verbatim from the Spiritwood repo at commit `49a1da2`, with only the line ranges trimmed. The
`as number` casts are the repo's house style; you can drop them unless your tsconfig enables `noUncheckedIndexedAccess`. Read them in this order: the raster finalize
(channel packing and the rim), the packer, the upload, the element pipeline, then the program that decodes the channels.

## 1. Coverage and smooth union (SDF helpers used by finalize)

`src/render/gen/sdf.ts` lines 90–100:

```ts
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
```

## 2. Material tables and finalize options

`DISP` is the edge displacement in texels, `FREQ` is the noise frequency, and `RIM` is the rim response. Each table is indexed by material id
(None, Bark, Leaf, Stone, Soft, Petal, Stem, Moss, Paper, Wood, Fungus).

`src/render/gen/raster.ts` lines 26–50:

```ts
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
```

## 3. Finalize: distance + material → straight RGBA8 (R detail, G rim, B emissive, A coverage)

Notes on this listing:
- `edgeFade` protects the rect edges.
- Halo texels become "pure light".
- Texels with zero alpha write all-zero RGBA.
- The rim taps point to earlier rows, so a single row-major pass sees their final alpha.

`src/render/gen/raster.ts` lines 249–385:

```ts
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
```

## 4. Skyline bottom-left packer (the gutter applies between items and at the border)

`src/render/gen/pack.ts` lines 1–80:

```ts
export interface PackItem {
  w: number;
  h: number;
  /** Filled by packRects. */
  x?: number;
  y?: number;
}

interface Segment {
  x: number;
  y: number;
  w: number;
}

/**
 * Skyline bottom-left packer: items (tallest first, then widest, stable) go where their top edge
 * ends lowest, then leftmost. `gutter` texels separate items from each other and from the atlas
 * border. Returns the used height; throws if the items do not fit in `width × maxHeight`.
 */
export function packRects(items: PackItem[], width: number, maxHeight: number, gutter: number): number {
  const order = items.map((_, i) => i).sort((a, b) => {
    const A = items[a] as PackItem;
    const B = items[b] as PackItem;
    return B.h - A.h || B.w - A.w || a - b;
  });
  const sky: Segment[] = [{ x: gutter, y: gutter, w: width - gutter }];
  let used = gutter;
  for (const idx of order) {
    const it = items[idx] as PackItem;
    const w = it.w + gutter;
    const h = it.h + gutter;
    if (it.w + 2 * gutter > width) throw new Error(`Atlas item ${it.w}×${it.h} is wider than the atlas (${width})`);
    let bestI = -1;
    let bestY = Infinity;
    let bestTop = Infinity;
    for (let i = 0; i < sky.length; i++) {
      const x = (sky[i] as Segment).x;
      if (x + w > width) break;
      // Highest skyline under [x, x + w).
      let y = 0;
      let covered = 0;
      for (let j = i; j < sky.length && covered < w; j++) {
        const s = sky[j] as Segment;
        y = Math.max(y, s.y);
        covered = s.x + s.w - x;
      }
      if (covered < w) continue;
      if (y + h < bestTop || (y + h === bestTop && x < ((sky[bestI] as Segment | undefined)?.x ?? Infinity))) {
        bestTop = y + h;
        bestY = y;
        bestI = i;
      }
    }
    if (bestI < 0 || bestTop > maxHeight) throw new Error(`Atlas overflow: ${it.w}×${it.h} does not fit in ${width}×${maxHeight}`);
    const x = (sky[bestI] as Segment).x;
    it.x = x;
    it.y = bestY;
    used = Math.max(used, bestTop);
    // Replace the covered skyline span with the new top segment.
    const end = x + w;
    const next: Segment[] = [];
    for (const s of sky) {
      if (s.x + s.w <= x || s.x >= end) {
        next.push(s);
        continue;
      }
      if (s.x < x) next.push({ x: s.x, y: s.y, w: x - s.x });
      if (s.x + s.w > end) next.push({ x: end, y: s.y, w: s.x + s.w - end });
    }
    next.push({ x, y: bestTop, w });
    next.sort((a, b) => a.x - b.x);
    sky.length = 0;
    for (const s of next) {
      const last = sky[sky.length - 1];
      if (last && last.y === s.y && last.x + last.w === s.x) last.w += s.w;
      else sky.push(s);
    }
  }
  return used;
}
```

## 5. Upload: premultiply in place, bypass the Texture.from cache, and account for the bytes

`src/render/util/texture.ts` lines 1–47:

```ts
import { BufferImageSource, Texture, type TextureSourceOptions } from 'pixi.js';
import type { TextureBudget } from '../../contracts/render.ts';

/**
 * Build a Pixi texture from straight-alpha RGBA8 pixels (as produced by CPU generators).
 * Pixels are premultiplied in place before upload, matching Pixi's premultiplied pipeline.
 * Bypasses Texture.from's global cache (keyed by the pixel array, so reused scratch buffers would
 * return a stale texture). Atlases drawn minified should pass `autoGenerateMipmaps: true`, pack with
 * gutters ≥ 2^mipLevels texels, and register `estimateTextureBytes(w, h, 4, true)`.
 */
export function textureFromRgba(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts: Partial<TextureSourceOptions> & { premultiply?: boolean; label?: string } = {},
): Texture {
  const { premultiply = true, label, ...sourceOpts } = opts;
  const data = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  if (premultiply) premultiplyRgba(data);
  const source = new BufferImageSource({
    resource: data,
    width,
    height,
    format: 'rgba8unorm',
    alphaMode: 'premultiplied-alpha',
    scaleMode: 'linear',
    autoGenerateMipmaps: false,
    ...sourceOpts,
    ...(label ? { label } : {}),
  });
  return new Texture({ source, ...(label ? { label } : {}) });
}

export function premultiplyRgba(data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = (data[i + 3] as number) / 255;
    data[i] = Math.round((data[i] as number) * a);
    data[i + 1] = Math.round((data[i + 1] as number) * a);
    data[i + 2] = Math.round((data[i + 2] as number) * a);
  }
}

/** Bytes a texture occupies on the GPU (RGBA8, +1/3 when mipmapped). */
export function estimateTextureBytes(width: number, height: number, bytesPerPixel = 4, mipmaps = false): number {
  const base = width * height * bytesPerPixel;
  return mipmaps ? Math.ceil(base * 4 / 3) : base;
}
```

The call sites in `src/render/layers/assets.ts` pass `{ autoGenerateMipmaps: true, label }` and register
`estimateTextureBytes(width, height, 4, true)`. Sub-frames share one source through
`new Texture({ source: tex.source, frame: new Rectangle(x, y, w, h) })`.

## 6. The element pipeline: mip constants, hull settings, raster → pack → alpha copy → split hull

`src/render/gen/kit.ts` lines 8–149:

```ts
/** Highest mip level the kit shader samples (it clamps its LOD); gutters and core insets derive from it. */
export const KIT_MAX_MIP = 1;
/** Hull settings for every kit element. */
export const KIT_HULL: HullOptions = {
  cell: 6,
  maxSpans: 4,
  coreInset: 1 + (1 << KIT_MAX_MIP),
  pad: 1 << KIT_MAX_MIP,
  minCore: 8,
  minGap: 4,
  snap: 2,
};
/** Rows of swaying elements are split on this texel grid so the vertex shader can bend them. */
export const SWAY_ROW_STEP = 24;
/** Texels between packed element rects (each rect also has an internal transparent margin). */
export const KIT_GUTTER = 4;
/** Default atlas size (the manifest's atlas entry is authoritative at runtime). */
export const KIT_WIDTH = 2048;
export const KIT_HEIGHT = 1792;

export interface KitElement {
  index: number;
  category: KitCategory;
  variant: number;
  /** Rect in atlas texels. */
  x: number;
  y: number;
  w: number;
  h: number;
  unitsPerTexel: number;
  anchorX: number;
  anchorY: number;
  sway: SwayAnchor;
  swayScale: number;
  emissive: boolean;
  cut: 'none' | 'top' | 'bottom';
  /** Texel row above which a top-cut element stretches (rows below keep the horizontal scale). */
  stretchFrom: number;
  /** Element-local texel rects [x0, y0, x1, y1, …]: opaque core and soft band (disjoint). */
  core: number[];
  soft: number[];
  coreArea: number;
  softArea: number;
}

export interface KitAtlasData {
  width: number;
  height: number;
  /** Straight-alpha RGBA8: R luminance detail, G rim mask, B emissive mask, A coverage. */
  pixels: Uint8Array;
  elements: KitElement[];
  byCategory: Readonly<Record<KitCategory, readonly KitElement[]>>;
  /** Generation wall time in ms (when measured by the caller's clock). */
  ms: number;
}

/** Kit metadata without the pixel buffer (all that meshing needs once the atlas is uploaded). */
export type KitMeta = Omit<KitAtlasData, 'pixels'>;

interface Job {
  spec: ElementSpec;
  variant: number;
  item: PackItem;
}

/**
 * Deterministic kit generation as a step generator: one element per step, so the async variant can
 * yield to the event loop between elements and keep the boot screen responsive.
 */
function* kitSteps(seed: number, width: number, height: number, specs: readonly ElementSpec[]): Generator<void, KitAtlasData> {
  const jobs: Job[] = [];
  for (const spec of specs) {
    for (let v = 0; v < spec.variants; v++) jobs.push({ spec, variant: v, item: { w: spec.w, h: spec.h } });
  }
  packRects(jobs.map((j) => j.item), width, height, KIT_GUTTER);
  const pixels = new Uint8Array(width * height * 4);
  const noise = new NoiseTable(seed ^ 0x5eed);
  const elements: KitElement[] = [];
  const byCategory = Object.fromEntries(KIT_CATEGORIES.map((c) => [c, [] as KitElement[]])) as Record<KitCategory, KitElement[]>;
  yield;
  for (let i = 0; i < jobs.length; i++) {
    const { spec, variant, item } = jobs[i] as Job;
    const rng = new Rng((hashString(`${spec.category}:${variant}`) ^ seed) >>> 0);
    const r = new ElementRaster(spec.w, spec.h, noise, i + 1);
    spec.draw(r, rng, variant);
    const x = item.x as number;
    const y = item.y as number;
    r.finalize(pixels, width, x, y, { edgeFade: ELEMENT_MARGIN, cut: spec.cut, ...spec.finalize });
    const alphaBytes = new Uint8Array(spec.w * spec.h);
    for (let row = 0; row < spec.h; row++) {
      let src = ((y + row) * width + x) * 4 + 3;
      for (let col = 0; col < spec.w; col++, src += 4) alphaBytes[row * spec.w + col] = pixels[src] as number;
    }
    const hull = computeSplitHullHalf(alphaBytes, spec.w, spec.h, KIT_HULL);
    const sway = spec.sway !== 'none';
    const stretchFrom = spec.stretchFrom ?? spec.anchorY;
    const split = (rects: number[]): number[] => (spec.cut === 'top' ? splitRowsAt(rects, stretchFrom) : rects);
    const el: KitElement = {
      index: elements.length,
      category: spec.category,
      variant,
      x, y, w: spec.w, h: spec.h,
      unitsPerTexel: spec.unitsPerTexel,
      anchorX: spec.anchorX,
      anchorY: spec.anchorY,
      sway: spec.sway,
      swayScale: spec.swayScale,
      emissive: spec.emissive,
      cut: spec.cut,
      stretchFrom,
      core: split(sway ? subdivideRows(hull.core, SWAY_ROW_STEP) : hull.core),
      soft: split(sway ? subdivideRows(hull.soft, SWAY_ROW_STEP) : hull.soft),
      coreArea: hull.coreArea,
      softArea: hull.softArea,
    };
    elements.push(el);
    byCategory[spec.category].push(el);
    yield;
  }
  return { width, height, pixels, elements, byCategory, ms: 0 };
}

/** Generate the procedural forest kit synchronously (tests, tools). */
export function generateKit(seed: number, width = KIT_WIDTH, height = KIT_HEIGHT, specs: readonly ElementSpec[] = ELEMENT_SPECS): KitAtlasData {
  const it = kitSteps(seed, width, height, specs);
  for (;;) {
    const s = it.next();
    if (s.done) return s.value;
  }
}

/** Generate the kit, awaiting `pause()` between elements (e.g. a macrotask yield in the browser). */
export async function generateKitAsync(
  seed: number, pause: () => Promise<void>, width = KIT_WIDTH, height = KIT_HEIGHT, specs: readonly ElementSpec[] = ELEMENT_SPECS,
): Promise<KitAtlasData> {
  const it = kitSteps(seed, width, height, specs);
  for (;;) {
    const s = it.next();
    if (s.done) return s.value;
    await pause();
  }
}
```

## 7. Shading model: modes and the TS reference implementation

The TS version is kept in sync with the GLSL and serves CPU previews and tests.

`src/render/layers/kitShading.ts` lines 1–101:

```ts
import { PALETTE } from '../../config.ts';
import { hexToRgb, type RGB } from '../../core/color.ts';

/**
 * The kit layer shading model. `kit.glsl.ts` implements exactly this per fragment; the TS version
 * is the reference for CPU previews and tests.
 *
 * Atlas channels (straight): R luminance detail (0.5 neutral), G rim mask, B emissive, A coverage.
 */
export interface KitShadeParams {
  tint: RGB;
  fogColor: RGB;
  fog: number;
  desaturate: number;
  rim: number;
  rimColor: RGB;
  glow: number;
  /** Height mist: fog rises by `mist` between mistY and mistY + mistDepth (layer-space y). */
  mistY: number;
  mistDepth: number;
  mist: number;
}

export const KIT_MODE = {
  /** Opaque core (pre-pass): colour un-premultiplied, alpha forced to 1. */
  Core: 0,
  /** Soft band / blended decor: premultiplied output. */
  Band: 1,
  /** Plate texture colour (translucent). */
  PlateBand: 2,
  /** Plate texture colour (opaque hull). */
  PlateCore: 3,
  /** Glow twin: emissive light only, alpha 0 (pure additive). */
  Glow: 4,
} as const;
export type KitMode = (typeof KIT_MODE)[keyof typeof KIT_MODE];

/** Moonlight rim colour (cool, slightly cyan). */
export const KIT_RIM_COLOR: RGB = (() => {
  const m = hexToRgb(PALETTE.moonlight);
  const s = hexToRgb(PALETTE.spiritGlow);
  return [m[0] * 0.7 + s[0] * 0.3, m[1] * 0.7 + s[1] * 0.3, m[2] * 0.7 + s[2] * 0.3];
})();

/** Rim light scale (the manifest `rim` is a 0..1 artistic strength). */
export const KIT_RIM_SCALE = 0.5;

/** Emissive parts get this much extra additive light on top of their (fog-cut) colour. */
export const KIT_GLOW_ADD = 0.6;

/**
 * Shade one texel. `tex` = straight RGBA 0..1; `shade` 0..1 per instance (0.5 neutral); `glowRgb`
 * per vertex. Writes premultiplied RGBA into `out`.
 */
export function shadeKit(
  out: Float32Array | number[], tex: ArrayLike<number>, shade: number, glowRgb: RGB, layerY: number, p: KitShadeParams, mode: KitMode,
): void {
  const a = tex[3] as number;
  const lum = tex[0] as number;
  const rimMask = tex[1] as number;
  const em = tex[2] as number;
  const k = (0.5 + lum) * (0.8 + 0.4 * shade);
  const rim = rimMask * p.rim * KIT_RIM_SCALE;
  let r = p.tint[0] * k + p.rimColor[0] * rim;
  let g = p.tint[1] * k + p.rimColor[1] * rim;
  let b = p.tint[2] * k + p.rimColor[2] * rim;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r += (l - r) * p.desaturate;
  g += (l - g) * p.desaturate;
  b += (l - b) * p.desaturate;
  const mistT = Math.min(1, Math.max(0, (layerY - p.mistY) / Math.max(1e-3, p.mistDepth)));
  const f = Math.min(1, p.fog + (1 - p.fog) * mistT * mistT * p.mist);
  r += (p.fogColor[0] - r) * f;
  g += (p.fogColor[1] - g) * f;
  b += (p.fogColor[2] - b) * f;
  const e = em * (1 - f * 0.6) * (p.glow > 0 ? 1 : 0);
  const gr = glowRgb[0] * p.glow;
  const gg = glowRgb[1] * p.glow;
  const gb = glowRgb[2] * p.glow;
  r += (gr * 1.25 - r) * e;
  g += (gg * 1.25 - g) * e;
  b += (gb * 1.25 - b) * e;
  if (mode === KIT_MODE.Core) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    out[3] = 1;
    return;
  }
  if (mode === KIT_MODE.Glow) {
    out[0] = gr * e * a;
    out[1] = gg * e * a;
    out[2] = gb * e * a;
    out[3] = 0;
    return;
  }
  out[0] = r * a + gr * e * a * KIT_GLOW_ADD;
  out[1] = g * a + gg * e * a * KIT_GLOW_ADD;
  out[2] = b * a + gb * e * a * KIT_GLOW_ADD;
  out[3] = a;
}
```

## 8. Shared GLSL chunks (header, Pixi transform, dither)

`src/render/shaders/common.ts` lines 14–48:

```ts
export const GLSL_VERSION = '#version 300 es';

export const GLSL_FRAGMENT_HEADER = '#version 300 es\nprecision highp float;\nprecision highp int;\n';

/** Vertex header: Pixi transform uniforms + helpers for clip position (explicit depth) and tint. */
export const GLSL_VERTEX_TRANSFORM = /* glsl */ `
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

vec4 pixiClipPosition(vec2 pos, float depth01) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  return vec4((mvp * vec3(pos, 1.0)).xy, depth01 * 2.0 - 1.0, 1.0);
}

// Premultiplied display-object tint × render-group colour/alpha (what Pixi's own shaders apply).
vec4 pixiTint() {
  return uColor * uWorldColorAlpha;
}
`;

/** Triangular-PDF dither of ±1 LSB (8-bit), keyed on gl_FragCoord. Add to the final rgb. */
export const GLSL_DITHER = /* glsl */ `
float sw_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 sw_dither(vec2 fragCoord) {
  float r = sw_hash12(fragCoord) + sw_hash12(fragCoord + 17.31) - 1.0;
  return vec3(r / 255.0);
}
`;
```

## 9. The kit program: one program for cores, bands, plates and glow twins

The mode is selected by `uMode`. The LOD is clamped to `KIT_MAX_MIP`. Plates branch on `uStraight` (KTX2 is straight; PNG/WebP are premultiplied).

`src/render/layers/kit.glsl.ts` lines 1–104:

```ts
import { GLSL_COLOR, GLSL_DITHER, GLSL_FRAGMENT_HEADER, GLSL_VERSION, GLSL_VERTEX_TRANSFORM } from '../shaders/common.ts';
import { KIT_MAX_MIP } from '../gen/kit.ts';
import { KIT_GLOW_ADD, KIT_RIM_SCALE } from './kitShading.ts';

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/**
 * Kit layer program (ARCHITECTURE.md §5.5): one program for opaque cores, soft bands, plate chunks,
 * blended decor and emissive glow twins, selected by `uMode` (see KIT_MODE). Implements
 * `shadeKit` from kitShading.ts. Wind sway displaces x by the baked per-vertex amplitude
 * (aSway.x = weight² × element amplitude) — identical for core and band, so they stay aligned.
 */
export const KIT_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
in vec2 aUV;
in vec2 aSway;
in float aDepth;
in vec4 aTint;
${GLSL_VERTEX_TRANSFORM}
uniform float uTime;
uniform float uSway;
out vec2 vUV;
out float vLayerY;
out vec4 vTint;

void main() {
  vec2 p = aPosition;
  if (uSway > 0.0) {
    float wave = sin(uTime * 1.35 + aSway.y + p.x * 0.0045) * 0.75
      + sin(uTime * 0.52 + aSway.y * 1.7 + p.x * 0.0013) * 0.5;
    p.x += wave * aSway.x * uSway;
  }
  gl_Position = pixiClipPosition(p, aDepth);
  vUV = aUV;
  vLayerY = aPosition.y;
  vTint = aTint;
}
`;

export const KIT_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vUV;
in float vLayerY;
in vec4 vTint;
uniform sampler2D uTexture;
uniform vec3 uTint;
uniform vec3 uFogColor;
uniform vec3 uRimColor;
uniform float uFog;
uniform float uDesat;
uniform float uRim;
uniform float uGlow;
uniform float uMistY;
uniform float uMistDepth;
uniform float uMist;
uniform float uMode;
uniform float uStraight;
out vec4 finalColor;
${GLSL_COLOR}
${GLSL_DITHER}

// Explicit LOD clamp: gutters and core insets only cover mip levels up to KIT_MAX_MIP.
vec4 sampleClamped(vec2 uv) {
  vec2 size = vec2(textureSize(uTexture, 0));
  vec2 d = max(abs(dFdx(uv * size)), abs(dFdy(uv * size)));
  float lod = clamp(log2(max(max(d.x, d.y), 1e-6)), 0.0, ${f(KIT_MAX_MIP)});
  return textureLod(uTexture, uv, lod);
}

float fogAmount() {
  float t = clamp((vLayerY - uMistY) / max(uMistDepth, 1e-3), 0.0, 1.0);
  return min(1.0, uFog + (1.0 - uFog) * t * t * uMist);
}

void main() {
  vec4 t = sampleClamped(vUV);
  float a = t.a;
  vec3 dither = sw_dither(gl_FragCoord.xy);
  if (uMode > 1.5 && uMode < 3.5) {
    // Painted plate: texture colour × tint, desaturated and fogged.
    vec3 c = uStraight > 0.5 ? t.rgb : t.rgb / max(a, 1e-4);
    c *= uTint;
    c = mix(c, vec3(sw_luma(c)), uDesat);
    c = mix(c, uFogColor, fogAmount()) + dither;
    finalColor = uMode > 2.5 ? vec4(c, 1.0) : vec4(c * a, a);
    return;
  }
  vec3 ch = t.rgb / max(a, 1e-4);
  float k = (0.5 + ch.r) * (0.8 + 0.4 * vTint.a);
  vec3 c = uTint * k + uRimColor * (ch.g * uRim * ${f(KIT_RIM_SCALE)});
  c = mix(c, vec3(sw_luma(c)), uDesat);
  float fog = fogAmount();
  c = mix(c, uFogColor, fog);
  vec3 g = vTint.rgb * uGlow;
  float e = ch.b * (1.0 - fog * 0.6) * step(1e-4, uGlow);
  c = mix(c, g * 1.25, e);
  if (uMode < 0.5) {
    finalColor = vec4(c + dither, 1.0);
  } else if (uMode > 3.5) {
    finalColor = vec4(g * e * a, 0.0);
  } else {
    finalColor = vec4((c + dither) * a + g * (e * a * ${f(KIT_GLOW_ADD)}), a);
  }
}
`;
```

## 10. Program and shader construction (PixiJS v8.21)

Every shader declares the same resources in the same order. In `parallaxStack.ts` one layer `UniformGroup` is shared by
that layer's core and band shaders. The glow twins in `decor.ts` use a second group, because their `glow` differs (0.9 vs 1).
The code comment below says "core, band and twin"; read it as "every shader that needs the same values".

`src/render/layers/kitShader.ts` lines 1–52:

```ts
import { GlProgram, Shader, UniformGroup, type TextureSource } from 'pixi.js';
import { KIT_FRAGMENT, KIT_VERTEX } from './kit.glsl.ts';
import type { KitMode, KitShadeParams } from './kitShading.ts';

let program: GlProgram | null = null;

/** The shared kit program (Pixi caches GlPrograms by source; every kit shader uses this one). */
export function kitProgram(): GlProgram {
  program ??= GlProgram.from({ vertex: KIT_VERTEX, fragment: KIT_FRAGMENT, name: 'sw-kit', preferredFragmentPrecision: 'highp' });
  return program;
}

function vec3(v: readonly number[]): Float32Array {
  return new Float32Array([v[0] as number, v[1] as number, v[2] as number]);
}

export function createKitLayerUniforms(p: KitShadeParams) {
  return new UniformGroup({
    uTime: { value: 0, type: 'f32' },
    uSway: { value: 0, type: 'f32' },
    uTint: { value: vec3(p.tint), type: 'vec3<f32>' },
    uFogColor: { value: vec3(p.fogColor), type: 'vec3<f32>' },
    uRimColor: { value: vec3(p.rimColor), type: 'vec3<f32>' },
    uFog: { value: p.fog, type: 'f32' },
    uDesat: { value: p.desaturate, type: 'f32' },
    uRim: { value: p.rim, type: 'f32' },
    uGlow: { value: p.glow, type: 'f32' },
    uMistY: { value: p.mistY, type: 'f32' },
    uMistDepth: { value: p.mistDepth, type: 'f32' },
    uMist: { value: p.mist, type: 'f32' },
  });
}
export type KitLayerUniforms = ReturnType<typeof createKitLayerUniforms>;

/**
 * A kit shader: shared program, the texture, the layer's uniform group (shared between its core,
 * band and twin shaders) and a per-pass group. Every kit shader declares the same resources in the
 * same order, as Pixi caches the resource sync per program.
 */
export function createKitShader(texture: TextureSource, layer: KitLayerUniforms, mode: KitMode, straightAlpha = false): Shader {
  return new Shader({
    glProgram: kitProgram(),
    resources: {
      uTexture: texture,
      kitLayer: layer,
      kitPass: new UniformGroup({
        uMode: { value: mode, type: 'f32' },
        uStraight: { value: straightAlpha ? 1 : 0, type: 'f32' },
      }),
    },
  });
}
```

