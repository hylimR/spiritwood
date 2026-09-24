# Painted plate listings (channel-packed-atlas)

The painted-plate path takes a colour image (painted, AI-generated or CPU-painted), bakes it into chunked WebP and KTX2 files with tight hull
polygons, and streams it at runtime. It uses the same vertex format and program as the procedural kit (modes
`PlateCore` and `PlateBand`). The listings are verbatim from commit `95b27fb` (the demo plate repainted with the art-pass tree generator).

Pipeline: `planPlate` (slot, texture size and look of the kit layer it replaces) → `paintTreeline` (generator trees and a clump thicket,
coloured as that layer before its fog) → `bakeImage` (1024² chunks → PNG palette, WebP, KTX2 ETC1S mipmapped + `chunkHulls`)
→ manifest `PlateLayerDef` → `PlateLayer` (ChunkStreamer → `loadTextureSource` → `plateMeshData` → core and band meshes).

Measured on the demo plate (3 chunks, file sizes in decimal KB): each 1024² chunk takes 67–75 KB as KTX2, 53–66 KB as WebP and
53–66 KB as PNG (561 KB for all nine files). The hull covers 33–37% of a chunk and the opaque hull 4–5% (polygon area over
1024²). Each hull and opaque hull has 130 points (2 × (1024/16 + 1)), which triangulate to 128 triangles. `npm run plates` takes
about 10 s (painting ≈ 0.9 s, then ≈ 3 s of encoding per chunk) and is byte-deterministic. In the CPU scene preview the plate
costs at most 0.05 screens of opaque core and 0.31 of soft band (hull minus core) at the worst camera; the kit layer it replaces costs
0.01 + 0.19 and the previous cloud-crown plate cost 0.11 + 0.53.

Look at it without a browser:

- `node tools/preview/world/plate-preview.ts <dir> [--baked ktx2|webp|png] [--crop x,y,w,h]`: the plate shaded with its
  manifest parameters, ×4 downsampled, alpha, hull overlay, per-chunk hull numbers, the value-ramp check against the replaced
  layer, and (with `--baked`) each encoding's error against a fresh repaint (KTX2 ≈ 2.4 premultiplied-RGB and 6.7 alpha RMSE in 8-bit
  units, WebP 1.7 / 0.3, PNG 1.8 / 2.3).
- `node tools/preview/world/scene-preview.ts <dir> --level forest --plates baked|paint [--plate-format ktx2] [--upto L4] [cameras…]`:
  the real level composited with the plates manifest (KTX2 transcoded to RGBA32 with the self-hosted libktx, sampled straight as the GPU
  path does); run it without `--plates` for the same cameras with the kit layer.

## 1. Bake: chunk, encode three ways, trace hulls

This is from `tools/plates/bake-plates.ts`, which you run with `npm run plates`.

`tools/plates/bake-plates.ts` lines 10–75:

```ts
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';
import { parseManifest } from '../../src/assets/manifest.ts';
import type { PlateChunkDef } from '../../src/contracts/assets.ts';
import { chunkHulls, paintTreeline, type PlateImage } from './paint.ts';
import { CHUNK, planPlate, PLATE_SEED, plateManifest, REPLACES, TEXEL_SCALE } from './plan.ts';

const ROOT = new URL('../../', import.meta.url);
const LAYERS_DIR = fileURLToPath(new URL('public/layers/', ROOT));
const PLATES_DIR = fileURLToPath(new URL('public/layers/plates/', ROOT));

async function imageDecoder(buffer: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Chunk an RGBA image and write every encoding; returns the manifest chunk entries. */
async function bakeImage(img: PlateImage, name: string): Promise<PlateChunkDef[]> {
  const cols = Math.ceil(img.width / CHUNK);
  const rows = Math.ceil(img.height / CHUNK);
  const chunks: PlateChunkDef[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * CHUNK;
      const y0 = row * CHUNK;
      const w = Math.min(CHUNK, img.width - x0);
      const h = Math.min(CHUNK, img.height - y0);
      const raw = Buffer.alloc(CHUNK * CHUNK * 4);
      let any = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = ((y0 + y) * img.width + x0 + x) * 4;
          const d = (y * CHUNK + x) * 4;
          for (let c = 0; c < 4; c++) raw[d + c] = img.rgba[s + c] as number;
          if ((img.rgba[s + 3] as number) > 1) any = true;
        }
      }
      if (!any) continue;
      const base = `${name}_${col}_${row}`;
      const t0 = performance.now();
      const input = sharp(raw, { raw: { width: CHUNK, height: CHUNK, channels: 4 } });
      const png = await input.clone().png({ palette: true, quality: 90, effort: 10, dither: 0.6, compressionLevel: 9 }).toBuffer();
      const webp = await input.clone().webp({ quality: 84, alphaQuality: 90, effort: 6 }).toBuffer();
      const lossless = await input.clone().png({ compressionLevel: 6 }).toBuffer();
      const ktx2 = await encodeToKTX2(new Uint8Array(lossless), {
        imageDecoder, isUASTC: false, generateMipmap: true, qualityLevel: 160, isKTX2File: true,
        isPerceptual: true, isSetKTX2SRGBTransferFunc: true,
      });
      writeFileSync(`${PLATES_DIR}${base}.png`, png);
      writeFileSync(`${PLATES_DIR}${base}.webp`, webp);
      writeFileSync(`${PLATES_DIR}${base}.ktx2`, ktx2);
      const { hull, opaqueHull } = chunkHulls(img.rgba, img.width, x0, y0, w, h);
      const entry: PlateChunkDef = {
        col, row,
        source: { ktx2: `plates/${base}.ktx2`, webp: `plates/${base}.webp`, png: `plates/${base}.png` },
      };
      if (hull) entry.hull = hull;
      if (opaqueHull) entry.opaqueHull = opaqueHull;
      chunks.push(entry);
      console.log(`${base}: png ${(png.length / 1024).toFixed(0)} KB, webp ${(webp.length / 1024).toFixed(0)} KB, ktx2 ${(ktx2.length / 1024).toFixed(0)} KB, hull ${(hull?.length ?? 0) / 2} pts, core ${(opaqueHull?.length ?? 0) / 2} pts, encoded in ${(performance.now() - t0).toFixed(0)} ms`);
    }
  }
  return chunks;
}
```

The plate layer takes the replaced kit layer's slot, parallax, fog colour, fog and desaturation (`tools/plates/plan.ts`), because the
texture holds that layer's colour *before* its distance fog. Storing pre-fog colour also halves the on-screen size of codec errors.

`tools/plates/plan.ts` lines 29–56:

```ts
export function planPlate(manifest: LayerManifest): PlatePlan {
  const index = manifest.layers.findIndex((l) => l.id === REPLACES);
  const replaced = manifest.layers[index];
  if (!replaced || replaced.kind !== 'kit') throw new Error(`manifest has no kit layer ${REPLACES}`);
  const kit: KitLayerDef = replaced;
  const [fx, fy] = kit.parallax;
  const ext = coverageExtent(LEVEL_W, LEVEL_H, fx, fy);
  const width = Math.ceil((ext.x1 - ext.x0 + 64) / TEXEL_SCALE / CHUNK) * CHUNK;
  const height = Math.ceil((ext.y1 - ext.y0) / TEXEL_SCALE / CHUNK) * CHUNK;
  const origin: [number, number] = [Math.floor(ext.x0 - 32), Math.floor(ext.y0)];
  const baselineY = ext.y0 + kit.baseline * (ext.y1 - ext.y0);
  const layer: PlateLayerDef = {
    id: PLATE_ID,
    kind: 'plate',
    parallax: [fx, fy],
    minQuality: kit.minQuality,
    // The texture holds the replaced layer's colour before its distance fog: same fog and desaturation.
    tint: '#ffffff',
    fog: kit.fog,
    fogColor: kit.fogColor,
    desaturate: kit.desaturate,
    origin,
    chunkSize: [CHUNK, CHUNK],
    texelScale: TEXEL_SCALE,
    chunks: [],
  };
  return { index, width, height, look: treelineLook(kit, baselineY, origin[1], TEXEL_SCALE), layer };
}
```

## 2. Paint in the look of the layer the plate replaces

A plate that stands in for a kit layer has to read like its neighbours: same silhouettes, same step on the value ramp. The demo painter
(`tools/plates/paint.ts`) therefore grows each tree with the kit's own archetypes (`broadTree`, `coniferTree`, `willowTree`,
`slenderTree`, `snagTree` from `src/render/gen/trees.ts`), each in its own `ElementRaster`: the archetype's design rect (as
`farArchetype` passes it) times the scale that reproduces the replaced layer's tree sizes at the plate's texel density
(`scale × 2 u/texel ÷ 1.5 u/texel`, since the archetypes are designed at 2 u/texel), finalized like the
far kit trees (bottom third dissolving, upper-left rim mask) and composited "over" into straight channel planes (R detail, G rim,
per-tree shade, coverage). Two planes: a back row (0.7–0.8× the size, 0.3 extra haze) and a front row with young trees and a
continuous thicket of generator `clump`s seated on one body, the plate's opaque core.

`tools/plates/paint.ts` lines 188–215:

```ts
function plantRow(p: Planes, W: number, H: number, row: TreeRow, seed: number, noise: NoiseTable, scratch: Scratch): number {
  const final = row.final;
  const rng = new Rng((hashString(`plate:${row.key}`) ^ seed) >>> 0);
  let x = -rng.range(0, row.spacing[1]);
  let n = 0;
  while (x < W + row.spacing[1]) {
    const kind = pickKind(rng, row.kinds);
    const s = rng.range(row.scale[0], row.scale[1]);
    const ground = row.base + rng.range(-row.baseJitter, row.baseJitter);
    const shade = rng.range(0.38, 0.62);
    const treeSeed = rng.nextU32();
    if (gapNoise(noise, x, row) >= row.gapBelow) {
      const a = ARCHETYPES[kind] as { fn: TreeFn; w: number; h: number };
      const w = Math.round(a.w * s);
      const h = Math.round(a.h * s);
      const r = new ElementRaster(w, h, noise, 1 + (treeSeed % 97), scratch);
      r.configure(final);
      const trng = new Rng((hashString(`${row.key}:${kind}:${n}`) ^ treeSeed) >>> 0);
      a.fn(r, trng, w / 2 + trng.range(-3, 3), h - 8, s);
      const px = scratch.bytes(w * h * 4);
      r.finalize(px, w, 0, 0, final);
      composite(p, W, H, r, px, Math.round(x - w / 2), Math.round(ground - (h - 8)), shade);
      n++;
    }
    x += rng.range(row.spacing[0], row.spacing[1]);
  }
  return n;
}
```

Each plane is then coloured with the kit formula of the replaced layer before its fog: `tint·(0.5+R)·(0.8+0.4·shade) + rimColor·G·rim·0.5`,
with the tint drifting from indigo tops to a teal base, diagonal brush-stroke noise, and the layer's height mist (`t²`, full
0.75·mistDepth below the ground line). An opaque base hides the luminous mists of the planes behind it (the kit layer's base is
translucent), so the front plane also rises into its own mist bank, lifted toward teal (`MIST_LIFT`) and wandering along x, and the
alpha fades out below it. Check the result with `plate-preview.ts`: the median shaded luma of the opaque silhouettes above the mist
is 0.182 (the kit layer's far trees 0.173, the layers behind and in front 0.208 and 0.141; the old cloud-crown painter measured 0.239).

`tools/plates/paint.ts` lines 266–311:

```ts
/**
 * Colour one plane into `out` (straight RGBA floats) with "over": the replaced layer's kit shading
 * (tint drifting from indigo tops to a teal base, luminance detail, per-tree shade, moonlit rim),
 * brushy diagonal tone strokes, the layer's height mist plus the plane's haze, then the base fade.
 */
function paintPlane(out: Float32Array, p: Planes, W: number, H: number, pl: Plane, look: TreelineLook, noise: NoiseTable, top: number): void {
  const rimK = look.rim * KIT_RIM_SCALE * pl.rim;
  // The bank's top wanders along x (soft wisps rather than a ruled line).
  const wander = new Float32Array(W);
  for (let x = 0; x < W; x++) wander[x] = (noise.sample(x * 0.03 + 91, 57.3) * 0.7 + noise.sample(x * 0.11 + 13, 91.1) * 0.3) * BANK_WANDER;
  for (let y = 0; y < H; y++) {
    const fade = 1 - smoothstep(pl.fade[0], pl.fade[1], y);
    if (fade <= 0) break;
    const v = smoothstep(top, pl.base + 30, y);
    const tr = look.tint[0] * (pl.top[0] + (pl.low[0] - pl.top[0]) * v);
    const tg = look.tint[1] * (pl.top[1] + (pl.low[1] - pl.top[1]) * v);
    const tb = look.tint[2] * (pl.top[2] + (pl.low[2] - pl.top[2]) * v);
    const layerMist = mistAt(look, null, y);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const a = (p.alpha[i] as number) * fade;
      if (a <= 0) continue;
      let mm = layerMist;
      if (pl.bank) {
        const w = wander[x] as number;
        const b = smoothstep(pl.bank[0] + w, pl.bank[1] + w, y);
        if (b > mm) mm = b;
      }
      const m = pl.haze + (1 - pl.haze) * mm;
      const stroke = noise.sample((x + y * 0.6) * 0.35, (y - x * 0.3) * 0.08) * 0.07 + noise.sample(x * 0.12 + 50, y * 0.12) * 0.05;
      const k = (0.5 + (p.lum[i] as number)) * (0.8 + 0.4 * (p.shade[i] as number)) * (1 + stroke);
      const rim = (p.rim[i] as number) * rimK;
      const cr = tr * k + KIT_RIM_COLOR[0] * rim;
      const cg = tg * k + KIT_RIM_COLOR[1] * rim;
      const cb = tb * k + KIT_RIM_COLOR[2] * rim;
      const o = i * 4;
      const ba = out[o + 3] as number;
      const kb = ba * (1 - a);
      const oa = a + kb;
      out[o] = ((cr + (mistColor(look, mm, 0) - cr) * m) * a + (out[o] as number) * kb) / oa;
      out[o + 1] = ((cg + (mistColor(look, mm, 1) - cg) * m) * a + (out[o + 1] as number) * kb) / oa;
      out[o + 2] = ((cb + (mistColor(look, mm, 2) - cb) * m) * a + (out[o + 2] as number) * kb) / oa;
      out[o + 3] = oa;
    }
  }
}
```

## 3. Colour dilation before encoding (no dark fringes from straight-alpha files)

This is from `tools/plates/paint.ts`. A transparent texel takes the colour of the nearest covered texel in its row or column (within 6
texels), else its row's misted body colour, instead of black. KTX2 is uploaded straight, so filtering reads these colours directly.

`tools/plates/paint.ts` lines 373–428:

```ts
/**
 * Quantise to RGBA8 with colour dilation: a transparent texel takes the colour of the nearest
 * covered texel in its row or column (within `reach`), else the misted body colour of its row, so
 * straight-alpha filtering (KTX2) and block compression see the edge colour, not black.
 */
function encode(out: Float32Array, W: number, H: number, look: TreelineLook, bank: [number, number] | null, reach = 6): Uint8Array {
  const rgba = new Uint8Array(W * H * 4);
  const src = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < W * H; i++) if ((out[i * 4 + 3] as number) * 255 >= 0.5) src[i] = i;
  // Nearest covered texel along the row (both directions), then along the column for the rest.
  const dist = new Int32Array(W * H).fill(reach + 1);
  for (let i = 0; i < W * H; i++) if ((src[i] as number) >= 0) dist[i] = 0;
  for (let y = 0; y < H; y++) {
    for (let pass = 0; pass < 2; pass++) {
      let last = -1;
      for (let j = 0; j < W; j++) {
        const x = pass === 0 ? j : W - 1 - j;
        const i = y * W + x;
        if ((dist[i] as number) === 0) last = x;
        else if (last >= 0 && Math.abs(x - last) < (dist[i] as number)) {
          dist[i] = Math.abs(x - last);
          src[i] = y * W + last;
        }
      }
    }
  }
  for (let x = 0; x < W; x++) {
    for (let pass = 0; pass < 2; pass++) {
      let last = -1;
      for (let j = 0; j < H; j++) {
        const y = pass === 0 ? j : H - 1 - j;
        const i = y * W + x;
        if ((dist[i] as number) === 0) last = y;
        else if (last >= 0 && Math.abs(y - last) < (dist[i] as number)) {
          dist[i] = Math.abs(y - last);
          src[i] = last * W + x;
        }
      }
    }
  }
  for (let y = 0; y < H; y++) {
    const m = mistAt(look, bank, y);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 4;
      const s = src[i] as number;
      for (let c = 0; c < 3; c++) {
        const fill = (look.tint[c] as number) + (mistColor(look, m, c) - (look.tint[c] as number)) * m;
        const col = s >= 0 ? (out[s * 4 + c] as number) : fill;
        rgba[o + c] = Math.round(Math.min(1, Math.max(0, col)) * 255);
      }
      rgba[o + 3] = Math.round(Math.min(1, out[o + 3] as number) * 255);
    }
  }
  return rgba;
}
```

## 4. Conservative hull polygons per chunk

The `hull` encloses everything visible. The `opaqueHull` lies inside α ≥ 254 texels, inset by `inset`, and all its strips share one row.

`tools/plates/paint.ts` lines 430–530:

```ts
/**
 * Conservative hull polygons of a chunk (chunk-local texels): `hull` encloses every texel with
 * alpha > 1/255; `opaqueHull` lies inside texels with alpha ≥ 254 inset by `inset`, or is null.
 * Columns are sampled in `band`-texel strips (min top / max bottom per strip; for the opaque hull,
 * the opaque run of each strip around a row that is opaque in every strip).
 */
export function chunkHulls(
  rgba: Uint8Array, stride: number, x0: number, y0: number, w: number, h: number, band = 16, inset = 5,
): { hull: number[] | null; opaqueHull: number[] | null } {
  const bands = Math.ceil(w / band);
  const vTop: number[] = [];
  const vBot: number[] = [];
  const oTop: number[] = [];
  const oBot: number[] = [];
  const alphaAt = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (rgba[((y0 + y) * stride + x0 + x) * 4 + 3] as number));
  for (let b = 0; b < bands; b++) {
    const bx0 = b * band;
    const bx1 = Math.min(w, bx0 + band);
    let top = h;
    let bot = -1;
    for (let x = bx0; x < bx1; x++) {
      for (let y = 0; y < h; y++) if (alphaAt(x, y) > 1) { top = Math.min(top, y); break; }
      for (let y = h - 1; y >= 0; y--) if (alphaAt(x, y) > 1) { bot = Math.max(bot, y + 1); break; }
    }
    vTop.push(top);
    vBot.push(bot);
  }
  const any = vBot.some((b) => b >= 0);
  let hull: number[] | null = null;
  if (any) {
    hull = [];
    for (let b = 0; b <= bands; b++) {
      const l = vTop[b - 1] ?? h;
      const r = vTop[b] ?? h;
      hull.push(Math.min(w, b * band), Math.min(l, r, h));
    }
    for (let b = bands; b >= 0; b--) {
      const l = vBot[b - 1] ?? -1;
      const r = vBot[b] ?? -1;
      hull.push(Math.min(w, b * band), Math.max(l, r, 0));
    }
    // A band with no visible texels would pinch the polygon; fall back to the bounding box then.
    if (vBot.some((v) => v < 0)) {
      const t = Math.min(...vTop);
      const bt = Math.max(...vBot);
      hull = [0, t, w, t, w, bt, 0, bt];
    }
  }
  let opaqueHull: number[] | null = null;
  // Every strip's opaque run must contain one shared row, so adjacent runs overlap and the
  // polygon cannot fold over itself.
  const rowOk = new Uint8Array(bands * h);
  for (let b = 0; b < bands; b++) {
    const bx0 = b * band - inset;
    const bx1 = Math.min(w, (b + 1) * band) + inset;
    for (let y = 0; y < h; y++) {
      let ok = 1;
      for (let x = bx0; x < bx1; x++) {
        // Chunks are sampled clamp-to-edge.
        if (alphaAt(Math.min(w - 1, Math.max(0, x)), y) < 254) {
          ok = 0;
          break;
        }
      }
      rowOk[b * h + y] = ok;
    }
  }
  const okAt = (b: number, y: number): boolean => {
    if (y < inset || y >= h - inset) return false;
    for (let yy = y - inset; yy <= y + inset; yy++) if (!rowOk[b * h + yy]) return false;
    return true;
  };
  let yRef = -1;
  for (let y = 0; y < h && yRef < 0; y++) {
    let all = true;
    for (let b = 0; all && b < bands; b++) all = okAt(b, y) && okAt(b, y + 2);
    if (all) yRef = y + 1;
  }
  if (yRef >= 0) {
    for (let b = 0; b < bands; b++) {
      let t = yRef;
      while (t > 0 && okAt(b, t - 1)) t--;
      let e = yRef;
      while (e < h - 1 && okAt(b, e + 1)) e++;
      oTop.push(t);
      oBot.push(e + 1);
    }
    opaqueHull = [];
    for (let b = 0; b <= bands; b++) {
      const l = oTop[b - 1] ?? 0;
      const r = oTop[b] ?? 0;
      opaqueHull.push(Math.min(w, b * band), Math.max(l, r));
    }
    for (let b = bands; b >= 0; b--) {
      const l = oBot[b - 1] ?? h;
      const r = oBot[b] ?? h;
      opaqueHull.push(Math.min(w, b * band), Math.min(l, r));
    }
  }
  return { hull, opaqueHull };
}
```

## 5. Manifest schema and validation

These are from `src/contracts/assets.ts` and `src/assets/manifest.ts`.

`src/contracts/assets.ts` lines 3–13:

```ts
/**
 * A texture that may exist in several encodings. The loader picks KTX2 when the GPU supports a
 * compressed format, else WebP, else PNG. `procedural` names a runtime generator instead of a file.
 * Paths are relative to the manifest file.
 */
export interface TextureSourceDef {
  ktx2?: string;
  webp?: string;
  png?: string;
  procedural?: string;
}
```

`src/contracts/assets.ts` lines 81–100:

```ts
export interface PlateChunkDef {
  col: number;
  row: number;
  source: TextureSourceDef;
  /** Optional tight hull polygon (flat x,y pairs, chunk-local texels) for the translucent mesh. */
  hull?: number[];
  /** Optional fully-opaque interior polygon (drawn in the opaque pre-pass). */
  opaqueHull?: number[];
}

export interface PlateLayerDef extends LayerDefBase {
  kind: 'plate';
  /** Layer-space position of chunk (0,0)'s top-left. */
  origin: [number, number];
  /** Chunk size in texels. */
  chunkSize: [number, number];
  /** World units per texel. */
  texelScale: number;
  chunks: PlateChunkDef[];
}
```

`src/assets/manifest.ts` lines 79–83:

```ts
function polygon(v: unknown, path: string, w: number, h: number): number[] {
  const a = arr(v, path);
  if (a.length < 6 || a.length % 2 !== 0) fail(path, 'expected at least 3 points as flat x,y pairs');
  return a.map((p, i) => num(p, `${path}[${i}]`, 0, i % 2 === 0 ? w : h));
}
```

`src/assets/manifest.ts` lines 175–202:

```ts
function plate(o: Obj, path: string): PlateLayerDef {
  const chunkSize = pair(o.chunkSize, `${path}.chunkSize`, 1, 16384);
  const [cw, ch] = chunkSize;
  if (!Number.isInteger(cw) || !Number.isInteger(ch)) fail(`${path}.chunkSize`, 'expected integer texel sizes');
  const seen = new Set<string>();
  const chunks = arr(o.chunks, `${path}.chunks`).map((c, i): PlateChunkDef => {
    const cp = `${path}.chunks[${i}]`;
    const co = obj(c, cp);
    const col = int(co.col, `${cp}.col`, 0, 4096);
    const row = int(co.row, `${cp}.row`, 0, 4096);
    const key = `${col},${row}`;
    if (seen.has(key)) fail(cp, `duplicate chunk at col ${col}, row ${row}`);
    seen.add(key);
    const out: PlateChunkDef = { col, row, source: source(co.source, `${cp}.source`, false) };
    if (co.hull !== undefined) out.hull = polygon(co.hull, `${cp}.hull`, cw, ch);
    if (co.opaqueHull !== undefined) out.opaqueHull = polygon(co.opaqueHull, `${cp}.opaqueHull`, cw, ch);
    return out;
  });
  if (chunks.length === 0) fail(`${path}.chunks`, 'expected at least one chunk');
  return {
    ...base(o, path),
    kind: 'plate',
    origin: pair(o.origin, `${path}.origin`, -1e7, 1e7),
    chunkSize,
    texelScale: num(o.texelScale, `${path}.texelScale`, 0.01, 100),
    chunks,
  };
}
```

## 6. Texture resolution: KTX2 → WebP → PNG, no-eval CSP skip, absolute transcoder URLs, deadline and session fallback

This is from `src/assets/textures.ts`.

`src/assets/textures.ts` lines 1–141:

```ts
import { Assets, detectWebp, setKTXTranscoderPath, type Texture, type WebGLRenderer } from 'pixi.js';
import 'pixi.js/ktx2';
import type { TextureSourceDef } from '../contracts/assets.ts';
import { evalAllowed } from '../core/csp.ts';
import type { TextureBudget } from '../contracts/render.ts';

export interface TextureFormatSupport {
  /** GPU can sample a Basis/KTX2 transcode target (BC7/BC3/ETC2/ASTC) and the CSP lets the transcoder run. */
  ktx2: boolean;
  webp: boolean;
}

/**
 * Pick the URL to load for a source: ktx2 (if supported) → webp (if supported) → png. Paths resolve
 * against `baseUrl` (the manifest URL). Returns null for procedural-only sources. Pure.
 */
export function chooseTextureUrl(src: TextureSourceDef, support: TextureFormatSupport, baseUrl: string): string | null {
  const path = (support.ktx2 && src.ktx2) || (support.webp && src.webp) || src.png || null;
  return path ? new URL(path, baseUrl).href : null;
}

/**
 * KTX2 needs a transcode target the GPU samples (BC7 bptc, BC3 s3tc, ETC2, ASTC 4×4) and eval: Pixi's
 * libktx transcoder is Emscripten code that calls `new Function`, so under a no-eval CSP its worker
 * fails during init (and Pixi's worker handler then throws on the URL-less error). Pure.
 */
export function ktx2Usable(ext: Readonly<Partial<Record<'bptc' | 's3tc' | 'etc' | 'astc', unknown>>>, canEval: boolean): boolean {
  return canEval && !!(ext.bptc || ext.s3tc || ext.etc || ext.astc);
}

let supportPromise: Promise<TextureFormatSupport> | null = null;

/** Probe compressed-format and WebP support once (cached). */
export async function detectTextureSupport(renderer: WebGLRenderer): Promise<TextureFormatSupport> {
  supportPromise ??= (async () => {
    const ktx2 = ktx2Usable(renderer.context.extensions, evalAllowed());
    let webp = false;
    try {
      webp = await detectWebp.test();
    } catch {
      webp = false;
    }
    return { ktx2, webp };
  })();
  return supportPromise;
}

let ktx2Configured = false;
let ktx2Disabled = false;

/** Point Pixi's KTX2 worker at the self-hosted transcoder (absolute URLs) before the first KTX2 load. */
function configureKtx2(): void {
  if (ktx2Configured) return;
  ktx2Configured = true;
  // Pixi's worker resolves relative paths against location.origin, so pass absolute URLs.
  setKTXTranscoderPath({
    jsUrl: new URL('transcoders/ktx/libktx.js', document.baseURI).href,
    wasmUrl: new URL('transcoders/ktx/libktx.wasm', document.baseURI).href,
  });
}

/**
 * A KTX2 load still pending after this long counts as a failure. When a host blocks blob workers or
 * WASM (ARCHITECTURE.md §5.8), Pixi's transcoder worker never answers, so without a deadline the
 * chunk would stay 'loading' forever and the WebP/PNG fallback would never run.
 */
export const KTX2_TIMEOUT_MS = 12000;

/** Assets.load with a deadline; a result that arrives after the deadline is unloaded again. */
function loadWithTimeout(url: string, ms: number): Promise<Texture> {
  return new Promise<Texture>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    Assets.load<Texture>(url).then(
      (texture) => {
        if (settled) {
          void Assets.unload(url);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(texture);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** GPU bytes of a loaded texture: 1 B/texel for block-compressed formats, 4 B for RGBA8 (+⅓ for mips). */
export function textureBytes(texture: Texture): number {
  const s = texture.source;
  const compressed = /^(bc\d|etc|eac|astc)/.test(s.format);
  const base = s.pixelWidth * s.pixelHeight * (compressed ? 1 : 4);
  return s.mipLevelCount > 1 ? Math.ceil((base * 4) / 3) : base;
}

/**
 * Load a file-backed texture and register its bytes in `budget` under `key`. KTX2 goes through
 * `import 'pixi.js/ktx2'` with the transcoder served/emitted by the vite.config.ts plugin at
 * `transcoders/ktx/` (never copy it into public/). Call `setKTXTranscoderPath` once with ABSOLUTE urls
 * (`new URL('transcoders/ktx/libktx.js', document.baseURI).href`, same for .wasm): Pixi's worker
 * resolves relative paths against location.origin. On a KTX2 failure, fall back to WebP/PNG for that
 * chunk and disable KTX2 for the session. Returns the resolved URL (needed to unload).
 */
export async function loadTextureSource(
  src: TextureSourceDef, baseUrl: string, support: TextureFormatSupport, budget: TextureBudget, key: string,
): Promise<{ texture: Texture; url: string }> {
  const effective = ktx2Disabled && support.ktx2 ? { ...support, ktx2: false } : support;
  const url = chooseTextureUrl(src, effective, baseUrl);
  if (!url) throw new Error(`No loadable texture for ${key}`);
  if (effective.ktx2 && src.ktx2) {
    try {
      configureKtx2();
      const texture = await loadWithTimeout(url, KTX2_TIMEOUT_MS);
      budget.set(key, textureBytes(texture));
      return { texture, url };
    } catch (err) {
      console.warn(`[assets] KTX2 failed for ${key}; using WebP/PNG for the rest of the session`, err);
      ktx2Disabled = true;
      return loadTextureSource(src, baseUrl, { ...support, ktx2: false }, budget, key);
    }
  }
  const texture = await Assets.load<Texture>(url);
  budget.set(key, textureBytes(texture));
  return { texture, url };
}

/** Release via `Assets.unload(url)` (clears Pixi's loader cache too) and remove from the budget. */
export async function unloadTextureSource(url: string, budget: TextureBudget, key: string): Promise<void> {
  budget.remove(key);
  await Assets.unload(url);
}
```

The Vite plugin that self-hosts the transcoder (`vite.config.ts`):

`vite.config.ts` lines 6–26:

```ts
/** Self-host PixiJS's KTX2 (libktx) transcoder at transcoders/ktx/ for dev and build. */
function ktxTranscoder(): Plugin {
  const dir = fileURLToPath(new URL('./node_modules/pixi.js/transcoders/ktx', import.meta.url));
  const files = ['libktx.js', 'libktx.wasm'];
  return {
    name: 'spiritwood-ktx-transcoder',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = files.find((f) => req.url?.endsWith(`/transcoders/ktx/${f}`));
        if (!name) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(resolve(dir, name)));
      });
    },
    generateBundle() {
      for (const f of files) {
        this.emitFile({ type: 'asset', fileName: `transcoders/ktx/${f}`, source: readFileSync(resolve(dir, f)) });
      }
    },
  };
}
```

## 7. Streaming policy (pure, allocation-free per frame)

This is from `src/assets/streamer.ts`.

`src/assets/streamer.ts` lines 28–148:

```ts
/**
 * Pure chunk-streaming policy (no Pixi, no fetch). Each frame: `update(visible)` marks chunks
 * intersecting visible+margin as wanted. `nextLoads()` yields wanted & unloaded chunks nearest the
 * visible centre first, respecting maxInFlight. When loaded bytes exceed the budget, `evictions()`
 * yields least-recently-wanted loaded chunks that are not currently visible. The caller reports
 * progress with markLoading/markLoaded/markUnloaded. Per-frame calls allocate nothing.
 *
 * Prefetch never overruns the budget: a chunk that is wanted but not visible starts loading only if
 * the loaded + in-flight bytes stay within the budget. Otherwise a budget smaller than the wanted
 * set would evict a prefetched chunk right after it arrives and request it again the next frame,
 * forever. Visible chunks always load (evicting others as needed).
 */
export class ChunkStreamer {
  private readonly chunks: readonly StreamChunk[];
  private readonly index = new Map<string, number>();
  private readonly states: Uint8Array;
  private readonly wanted: Uint8Array;
  private readonly visible: Uint8Array;
  /** Chunks that failed to load for good: never offered by nextLoads again. */
  private readonly failed: Uint8Array;
  private readonly lastWanted: Float64Array;
  private readonly dist: Float64Array;
  private readonly sel: Int32Array;
  private readonly options: StreamerOptions;
  private loaded = 0;
  private inFlight = 0;
  private inFlightBytes = 0;

  constructor(chunks: readonly StreamChunk[], options: StreamerOptions) {
    this.chunks = chunks;
    this.options = { ...options };
    const n = chunks.length;
    this.states = new Uint8Array(n);
    this.wanted = new Uint8Array(n);
    this.visible = new Uint8Array(n);
    this.failed = new Uint8Array(n);
    this.lastWanted = new Float64Array(n).fill(-Infinity);
    this.dist = new Float64Array(n);
    this.sel = new Int32Array(Math.max(1, options.maxInFlight, n));
    for (let i = 0; i < n; i++) {
      const key = (chunks[i] as StreamChunk).key;
      if (this.index.has(key)) throw new Error(`ChunkStreamer: duplicate chunk key ${key}`);
      this.index.set(key, i);
    }
  }

  get budgetBytes(): number {
    return this.options.budgetBytes;
  }

  /** Change the byte budget (quality changes); evictions() applies it. */
  setBudget(bytes: number): void {
    this.options.budgetBytes = bytes;
  }

  update(visible: Extent, frame: number): void {
    const m = this.options.margin;
    const cx = (visible.x0 + visible.x1) * 0.5;
    const cy = (visible.y0 + visible.y1) * 0.5;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] as StreamChunk;
      const vis = c.x1 > visible.x0 && c.x0 < visible.x1 && c.y1 > visible.y0 && c.y0 < visible.y1;
      const want = c.x1 > visible.x0 - m && c.x0 < visible.x1 + m && c.y1 > visible.y0 - m && c.y0 < visible.y1 + m;
      this.visible[i] = vis ? 1 : 0;
      this.wanted[i] = want ? 1 : 0;
      if (want) this.lastWanted[i] = frame;
      const dx = (c.x0 + c.x1) * 0.5 - cx;
      const dy = (c.y0 + c.y1) * 0.5 - cy;
      this.dist[i] = dx * dx + dy * dy;
    }
  }

  /** Fills `out` (cleared first) with chunks to start loading now; returns `out`. */
  nextLoads(out: StreamChunk[]): StreamChunk[] {
    out.length = 0;
    let slots = this.options.maxInFlight - this.inFlight;
    if (slots <= 0) return out;
    // Insertion-sort every wanted & unloaded chunk by distance (indices in `sel`).
    const sel = this.sel;
    let n = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.wanted[i] !== 1 || this.states[i] !== UNLOADED || this.failed[i] === 1) continue;
      const d = this.dist[i] as number;
      let at = n;
      while (at > 0 && d < (this.dist[sel[at - 1] as number] as number)) at--;
      for (let k = n; k > at; k--) sel[k] = sel[k - 1] as number;
      sel[at] = i;
      n++;
    }
    // Nearest first; prefetch-only chunks must fit in the budget left after loaded + in-flight bytes.
    let room = this.options.budgetBytes - this.loaded - this.inFlightBytes;
    for (let k = 0; k < n && slots > 0; k++) {
      const i = sel[k] as number;
      const c = this.chunks[i] as StreamChunk;
      if (this.visible[i] !== 1 && c.bytes > room) continue;
      out.push(c);
      room -= c.bytes;
      slots--;
    }
    return out;
  }

  /** Fills `out` (cleared first) with loaded chunks to evict now; returns `out`. */
  evictions(out: StreamChunk[]): StreamChunk[] {
    out.length = 0;
    let excess = this.loaded - this.options.budgetBytes;
    while (excess > 0) {
      let best = -1;
      for (let i = 0; i < this.chunks.length; i++) {
        if (this.states[i] !== LOADED || this.visible[i] === 1) continue;
        const c = this.chunks[i] as StreamChunk;
        if (out.includes(c)) continue;
        if (best < 0 || (this.lastWanted[i] as number) < (this.lastWanted[best] as number)) best = i;
      }
      if (best < 0) break;
      const c = this.chunks[best] as StreamChunk;
      out.push(c);
      excess -= c.bytes;
    }
    return out;
  }
```

## 8. Runtime layer: polygon → kit mesh, load, build, evict

This is from `src/render/layers/plates.ts`. The band mesh is the whole `hull`. Both meshes get `this.depth`, and the vertex shader
writes z from `aDepth` alone (it never goes through the transform), so where the band overlaps the `opaqueHull` core its fragments
have bit-identical depth and fail LESS. Early-Z discards them, with no polygon subtraction. If you ever vary depth per vertex, subtract
the polygons or bias the band depth instead.

`src/render/layers/plates.ts` lines 1–48:

```ts
import { Mesh, type Container, type State, type Texture } from 'pixi.js';
import type { PlateChunkDef, PlateLayerDef } from '../../contracts/assets.ts';
import type { TextureBudget } from '../../contracts/render.ts';
import { ChunkStreamer, type StreamChunk } from '../../assets/streamer.ts';
import { loadTextureSource, unloadTextureSource, type TextureFormatSupport } from '../../assets/textures.ts';
import { triangulate } from '../gen/polygon.ts';
import { depthForInstance, type Extent } from '../util/camera.ts';
import { createKitGeometry, type WorldMesh } from './geometry.ts';
import { KIT_STRIDE_FLOATS, packTint, type MeshData } from './kitMesh.ts';
import { createKitShader, type KitLayerUniforms } from './kitShader.ts';
import { KIT_MODE } from './kitShading.ts';

/** Chunk-local polygon (texels) → kit-format mesh data in layer space. */
export function plateMeshData(poly: readonly number[], rect: Extent, cw: number, ch: number, depth: number): MeshData {
  const idx = triangulate(poly);
  const n = poly.length / 2;
  const vertices = new Float32Array(n * KIT_STRIDE_FLOATS);
  const u32 = new Uint32Array(vertices.buffer);
  const sx = (rect.x1 - rect.x0) / cw;
  const sy = (rect.y1 - rect.y0) / ch;
  const b: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let area = 0;
  for (let i = 0; i < n; i++) {
    const px = poly[i * 2] as number;
    const py = poly[i * 2 + 1] as number;
    const x = rect.x0 + px * sx;
    const y = rect.y0 + py * sy;
    const o = i * KIT_STRIDE_FLOATS;
    vertices[o] = x;
    vertices[o + 1] = y;
    vertices[o + 2] = px / cw;
    vertices[o + 3] = py / ch;
    vertices[o + 6] = depth;
    u32[o + 7] = packTint(0, 0.5);
    b.x0 = Math.min(b.x0, x);
    b.x1 = Math.max(b.x1, x);
    b.y0 = Math.min(b.y0, y);
    b.y1 = Math.max(b.y1, y);
  }
  for (let t = 0; t < idx.length; t += 3) {
    const a = (idx[t] as number) * 2;
    const c = (idx[t + 1] as number) * 2;
    const d = (idx[t + 2] as number) * 2;
    area += Math.abs(((poly[c] as number) - (poly[a] as number)) * ((poly[d + 1] as number) - (poly[a + 1] as number))
      - ((poly[d] as number) - (poly[a] as number)) * ((poly[c + 1] as number) - (poly[a + 1] as number))) / 2 * sx * sy;
  }
  return { vertices, indices: Uint16Array.from(idx), vertexCount: n, bounds: b, area };
}
```

`src/render/layers/plates.ts` lines 117–192:

```ts
  /** Per frame: stream, evict and show/hide loaded chunks. Allocates only when a load starts. */
  update(visible: Extent, frame: number): void {
    const s = this.streamer;
    s.update(visible, frame);
    s.nextLoads(this.loads);
    for (let i = 0; i < this.loads.length; i++) this.startLoad(this.byKey.get((this.loads[i] as StreamChunk).key) as PlateChunk);
    s.evictions(this.evicts);
    for (let i = 0; i < this.evicts.length; i++) this.evict(this.byKey.get((this.evicts[i] as StreamChunk).key) as PlateChunk);
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] as PlateChunk;
      const show = c.meshes.length > 0 && s.isVisible(c.stream.key);
      if (show !== c.shown) {
        c.shown = show;
        for (let m = 0; m < c.meshes.length; m++) (c.meshes[m] as WorldMesh).visible = show;
      }
    }
  }

  private startLoad(c: PlateChunk): void {
    if (c.failed) return;
    const key = c.stream.key;
    this.streamer.markLoading(key);
    loadTextureSource(c.def.source, this.env.baseUrl, this.env.support, this.env.budget, key).then(
      ({ texture, url }) => {
        if (this.destroyed || this.streamer.state(key) !== 'loading') {
          void unloadTextureSource(url, this.env.budget, key);
          return;
        }
        c.texture = texture;
        c.url = url;
        this.buildMeshes(c, texture);
        this.streamer.markLoaded(key);
      },
      (err: unknown) => {
        console.warn(`[plates] failed to load ${key}`, err);
        c.failed = true;
        if (!this.destroyed) this.streamer.markFailed(key);
      },
    );
  }

  private buildMeshes(c: PlateChunk, texture: Texture): void {
    const [cw, ch] = this.def.chunkSize;
    const rect: Extent = { x0: c.stream.x0, y0: c.stream.y0, x1: c.stream.x1, y1: c.stream.y1 };
    const straight = texture.source.alphaMode === 'no-premultiply-alpha';
    const band = c.def.hull ?? [0, 0, cw, 0, cw, ch, 0, ch];
    const add = (poly: readonly number[], mode: typeof KIT_MODE.PlateCore | typeof KIT_MODE.PlateBand): void => {
      const data = plateMeshData(poly, rect, cw, ch, this.depth);
      const mesh = new Mesh({
        geometry: createKitGeometry(data, c.stream.key),
        shader: createKitShader(texture.source, this.env.uniforms, mode, straight),
        state: mode === KIT_MODE.PlateCore ? this.env.coreState : this.env.bandState,
      });
      mesh.visible = false;
      (mode === KIT_MODE.PlateCore ? this.env.coreParent : this.env.bandParent).addChild(mesh);
      c.meshes.push(mesh);
    };
    if (c.def.opaqueHull) add(c.def.opaqueHull, KIT_MODE.PlateCore);
    add(band, KIT_MODE.PlateBand);
    c.shown = false;
  }

  private evict(c: PlateChunk): void {
    for (const m of c.meshes) {
      m.geometry.destroy(true);
      m.shader?.destroy();
      m.destroy();
    }
    c.meshes.length = 0;
    c.shown = false;
    const url = c.url;
    c.texture = null;
    c.url = null;
    this.streamer.markUnloaded(c.stream.key);
    if (url) void unloadTextureSource(url, this.env.budget, c.stream.key);
  }
```

## 9. Ear clipping that tolerates traced-hull quirks

This is from `src/render/gen/polygon.ts`.

`src/render/gen/polygon.ts` lines 1–99:

```ts
/** Signed area of a polygon given as flat x,y pairs (positive = counter-clockwise in y-up axes). */
export function polygonArea(p: readonly number[]): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (p[j * 2] as number) * (p[i * 2 + 1] as number) - (p[i * 2] as number) * (p[j * 2 + 1] as number);
  }
  return a / 2;
}

function pointInTri(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Ear-clipping triangulation of a simple polygon (flat x,y pairs, either winding). Returns vertex
 * indices, three per triangle. Repeated points and collinear runs (common in traced hulls) are
 * tolerated: duplicates are skipped, points coincident with an ear's corners do not block it, and a
 * stalled pass drops a degenerate (zero-area) corner, so the triangles always cover the polygon.
 * O(n²), fine for hull polygons of a few hundred points.
 */
export function triangulate(p: readonly number[]): number[] {
  const n = p.length / 2;
  if (n < 3) return [];
  const ccw = polygonArea(p) > 0;
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = ccw ? k : n - 1 - k;
    const last = idx[idx.length - 1];
    if (last !== undefined && p[last * 2] === p[i * 2] && p[last * 2 + 1] === p[i * 2 + 1]) continue;
    idx.push(i);
  }
  while (idx.length > 1) {
    const a = idx[0] as number;
    const z = idx[idx.length - 1] as number;
    if (p[a * 2] !== p[z * 2] || p[a * 2 + 1] !== p[z * 2 + 1]) break;
    idx.pop();
  }
  const out: number[] = [];
  const cross = (ia: number, ib: number, ic: number): number => {
    const ax = p[ia * 2] as number;
    const ay = p[ia * 2 + 1] as number;
    return ((p[ib * 2] as number) - ax) * ((p[ic * 2 + 1] as number) - ay) - ((p[ib * 2 + 1] as number) - ay) * ((p[ic * 2] as number) - ax);
  };
  const same = (i: number, j: number): boolean => p[i * 2] === p[j * 2] && p[i * 2 + 1] === p[j * 2 + 1];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length] as number;
      const ib = idx[i] as number;
      const ic = idx[(i + 1) % idx.length] as number;
      if (cross(ia, ib, ic) <= 0) continue;
      const ax = p[ia * 2] as number;
      const ay = p[ia * 2 + 1] as number;
      const bx = p[ib * 2] as number;
      const by = p[ib * 2 + 1] as number;
      const cx = p[ic * 2] as number;
      const cy = p[ic * 2 + 1] as number;
      let inside = false;
      for (let k = 0; k < idx.length; k++) {
        const ik = idx[k] as number;
        if (ik === ia || ik === ib || ik === ic || same(ik, ia) || same(ik, ib) || same(ik, ic)) continue;
        if (pointInTri(p[ik * 2] as number, p[ik * 2 + 1] as number, ax, ay, bx, by, cx, cy)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (clipped) continue;
    // Stalled: remove a degenerate corner (collinear or a zero-length spike) that no ear can take.
    let dropped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length] as number;
      const ib = idx[i] as number;
      const ic = idx[(i + 1) % idx.length] as number;
      if (cross(ia, ib, ic) === 0) {
        idx.splice(i, 1);
        dropped = true;
        break;
      }
    }
    if (!dropped) break;
  }
  if (idx.length === 3 && cross(idx[0] as number, idx[1] as number, idx[2] as number) !== 0) {
    out.push(idx[0] as number, idx[1] as number, idx[2] as number);
  }
  return out;
}
```

