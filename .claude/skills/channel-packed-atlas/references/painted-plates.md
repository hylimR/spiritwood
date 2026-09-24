# Painted plate listings (channel-packed-atlas)

The painted-plate path takes a colour image (painted, AI-generated or CPU-painted), bakes it into chunked WebP and KTX2 files with tight hull
polygons, and streams it at runtime. It uses the same vertex format and program as the procedural kit (modes
`PlateCore` and `PlateBand`). The listings are verbatim from commit `49a1da2`.

Pipeline: `paintTreeline` → `bakeImage` (1024² chunks → PNG palette, WebP, KTX2 ETC1S mipmapped + `chunkHulls`)
→ manifest `PlateLayerDef` → `PlateLayer` (ChunkStreamer → `loadTextureSource` → `plateMeshData` → core and band meshes).

Measured on the demo plate (3 chunks, file sizes in decimal KB): each 1024² chunk takes 68–81 KB as KTX2, 49–65 KB as WebP and
74–92 KB as PNG. The hull covers about 63% of a chunk and the opaque hull 10–11%. Each hull and opaque hull has 130 points
(2 × (1024/16 + 1)), which triangulate to 128 triangles.

## 1. Bake: chunk, encode three ways, trace hulls

This is from `tools/plates/bake-plates.ts`, which you run with `npm run plates`.

`tools/plates/bake-plates.ts` lines 10–82:

```ts
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';
import { parseManifest } from '../../src/assets/manifest.ts';
import type { KitLayerDef, LayerManifest, PlateChunkDef, PlateLayerDef } from '../../src/contracts/assets.ts';
import { coverageExtent } from '../../src/render/layers/placement.ts';
import { chunkHulls, paintTreeline, type PlateImage } from './paint.ts';

const ROOT = new URL('../../', import.meta.url);
const LAYERS_DIR = fileURLToPath(new URL('public/layers/', ROOT));
const PLATES_DIR = fileURLToPath(new URL('public/layers/plates/', ROOT));
const CHUNK = 1024;
const TEXEL_SCALE = 1.5;
/** Level size the plate must cover (the M1 forest: 200 × 50 tiles of 48 u). */
const LEVEL_W = 9600;
const LEVEL_H = 2400;
/** The far kit layer the demo plate replaces. */
const REPLACES = 'L3-misty-trunks';
const PLATE_ID = 'L3-plate-treeline';

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
      console.log(`${base}: png ${(png.length / 1024).toFixed(0)} KB, webp ${(webp.length / 1024).toFixed(0)} KB, ktx2 ${(ktx2.length / 1024).toFixed(0)} KB, hull ${(hull?.length ?? 0) / 2} pts, core ${(opaqueHull?.length ?? 0) / 2} pts`);
    }
  }
  return chunks;
}
```

## 2. Colour dilation before encoding (no dark fringes from straight-alpha files)

This is from `tools/plates/paint.ts`. Transparent texels take the mist colour instead of black.

`tools/plates/paint.ts` lines 126–142:

```ts
  // Low mist glow across the base, and colour dilation for transparent texels (clean mip edges).
  const mist = hex(0x2a5872);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const glow = smooth(height * 0.5, height * 0.66, y) * (1 - smooth(height * 0.66, height * 0.86, y)) * 0.12;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const a = out[o + 3] as number;
      const lift = glow * (0.6 + 0.4 * noise.sample(x * 0.05, y * 0.2));
      for (let c = 0; c < 3; c++) {
        const col = a > 0 ? (out[o + c] as number) : (mist[c] as number);
        rgba[o + c] = Math.round(Math.min(1, col + lift * 0.5) * 255);
      }
      rgba[o + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  return { width, height, rgba };
```

## 3. Conservative hull polygons per chunk

The `hull` encloses everything visible. The `opaqueHull` lies inside α ≥ 254 texels, inset by `inset`, and all its strips share one row.

`tools/plates/paint.ts` lines 145–245:

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

## 4. Manifest schema and validation

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

## 5. Texture resolution: KTX2 → WebP → PNG, absolute transcoder URLs, deadline and session fallback

This is from `src/assets/textures.ts`.

`src/assets/textures.ts` lines 1–133:

```ts
import { Assets, detectWebp, setKTXTranscoderPath, type Texture, type WebGLRenderer } from 'pixi.js';
import 'pixi.js/ktx2';
import type { TextureSourceDef } from '../contracts/assets.ts';
import type { TextureBudget } from '../contracts/render.ts';

export interface TextureFormatSupport {
  /** GPU can sample a Basis/KTX2 transcode target (BC7/BC3/ETC2/ASTC). */
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

let supportPromise: Promise<TextureFormatSupport> | null = null;

/** Probe compressed-format and WebP support once (cached). */
export async function detectTextureSupport(renderer: WebGLRenderer): Promise<TextureFormatSupport> {
  supportPromise ??= (async () => {
    const ext = renderer.context.extensions;
    // Targets Pixi's KTX2 transcoder can produce: BC7 (bptc), BC3 (s3tc), ETC2 (etc), ASTC 4×4.
    const ktx2 = !!(ext.bptc || ext.s3tc || ext.etc || ext.astc);
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

## 6. Streaming policy (pure, allocation-free per frame)

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

## 7. Runtime layer: polygon → kit mesh, load, build, evict

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

## 8. Ear clipping that tolerates traced-hull quirks

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

