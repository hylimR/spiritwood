import type { KitLayerDef } from '../../src/contracts/assets.ts';
import { hexToRgb, parseHexColor, type RGB } from '../../src/core/color.ts';
import { smoothstep } from '../../src/core/math.ts';
import { hashString, Rng } from '../../src/core/rng.ts';
import { NoiseTable } from '../../src/render/gen/noiseTable.ts';
import { ElementRaster, Mat, Scratch, type FinalizeOptions } from '../../src/render/gen/raster.ts';
import { broadTree, clump, coniferTree, LEAFY, slenderTree, snagTree, willowTree, type ClumpStyle } from '../../src/render/gen/trees.ts';
import { KIT_RIM_COLOR, KIT_RIM_SCALE } from '../../src/render/layers/kitShading.ts';
import { RECIPES } from '../../src/render/layers/recipes.ts';

/**
 * CPU painter for the demo plate: a painterly, misty treeline in straight-alpha RGBA, grown from the
 * same art-pass tree generator as the far kit layers (`src/render/gen/trees.ts`). Two rows (a lighter,
 * hazier back row and a darker front row standing on a continuous thicket of foliage clumps, the
 * plate's opaque core), moonlit upper-left rims, soft vertical colour drift, brushy tone and a base
 * that dissolves into the replaced layer's height mist.
 *
 * Colours are the kit shading of the replaced layer before its distance fog (`tint·(0.5+R)·(0.8+0.4·shade)
 * + rim`, height mist pre-applied), so the plate manifest applies the same `fog`/`desaturate` and the
 * plate sits on the layer's step of the aerial-perspective ramp.
 */
export interface PlateImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** What the plate takes over from the kit layer it replaces (texel space). */
export interface TreelineLook {
  /** Texel row of the replaced layer's ground line: the front row stands on it. */
  baseline: number;
  /** Layer units per plate texel. */
  unitsPerTexel: number;
  /** Instance scale range of the replaced layer's trees. */
  scale: [number, number];
  tint: RGB;
  fogColor: RGB;
  /** Manifest rim strength (0..1). */
  rim: number;
  /** Height-mist depth of the replaced layer's recipe, in texels. */
  mistDepth: number;
}

/** Layer units per texel of a tree archetype drawn at scale 1 (the far kit design density). */
const ARCHETYPE_UNITS_PER_TEXEL = 2;

/** The look of kit layer `kit` (ground line at layer y `baselineY`) for a plate whose top texel row is at layer y `originY`. */
export function treelineLook(kit: KitLayerDef, baselineY: number, originY: number, unitsPerTexel: number): TreelineLook {
  const recipe = RECIPES[kit.recipe];
  if (!recipe) throw new Error(`${kit.id}: unknown recipe ${kit.recipe}`);
  return {
    baseline: (baselineY - originY) / unitsPerTexel,
    unitsPerTexel,
    scale: kit.scale,
    tint: hexToRgb(parseHexColor(kit.tint)),
    fogColor: hexToRgb(parseHexColor(kit.fogColor)),
    rim: kit.rim,
    mistDepth: recipe.mistDepth / unitsPerTexel,
  };
}

type TreeFn = (r: ElementRaster, rng: Rng, cx: number, ground: number, s: number) => void;

/** Archetype rects at scale 1, as the far kit uses them (`farArchetype`). */
const ARCHETYPES: Readonly<Record<string, { fn: TreeFn; w: number; h: number }>> = {
  broad: { fn: broadTree, w: 300, h: 400 },
  willow: { fn: willowTree, w: 280, h: 400 },
  slender: { fn: slenderTree, w: 150, h: 430 },
  conifer: { fn: coniferTree, w: 160, h: 440 },
  snag: { fn: snagTree, w: 170, h: 380 },
};

/** One population of generator trees along a ground line. */
interface TreeRow {
  key: string;
  /** Ground line (texels) and per-tree jitter of it. */
  base: number;
  baseJitter: number;
  /** Archetype scale range. */
  scale: [number, number];
  /** Trunk spacing range in texels. */
  spacing: [number, number];
  kinds: readonly [string, number][];
  /** Clearings: a 1D noise over x (in table units per texel) drops trees where it falls below `gapBelow`. */
  gapFreq: number;
  gapBelow: number;
  final: FinalizeOptions;
}

/** A painted depth plane: its tree rows, optional thicket, and how it is coloured and dissolved. */
interface Plane {
  rows: readonly TreeRow[];
  /** A continuous thicket along this ground line (the plate's opaque core). */
  thicket: number | null;
  /** Extra blend toward the fog colour (0 = the replaced layer's own depth). */
  haze: number;
  /** Rim strength relative to the layer's rim. */
  rim: number;
  /** Colour drift from the plane's tops (indigo) to its base (teal): multipliers on the tint. */
  top: RGB;
  low: RGB;
  base: number;
  /** Alpha dissolves into the mist between these rows. */
  fade: [number, number];
  /** A mist bank of the plane's own that thickens to full between these rows (null = the layer's mist only). */
  bank: [number, number] | null;
}

/**
 * Teal lift of the plate's mist over the layer's fog colour (before the layer fog halves it). The
 * kit layer's base is translucent over the luminous mists of the planes behind; the plate's opaque
 * thicket hides them, so its own mist bank carries that glow.
 */
const MIST_LIFT: RGB = [0, 0.11, 0.1];
/** How far (texels, about ±) the top of a plane's mist bank wanders along x. */
const BANK_WANDER = 60;

/** Mist amount at texel row y: the replaced layer's height mist (t², as the kit shader) or the plane's bank. */
function mistAt(look: TreelineLook, bank: [number, number] | null, y: number): number {
  const t = Math.min(1, Math.max(0, (y - (look.baseline - 0.25 * look.mistDepth)) / look.mistDepth));
  return Math.max(t * t, bank ? smoothstep(bank[0], bank[1], y) : 0);
}

/** Mist colour for amount m: the fog colour lifted toward teal as the mist thickens. */
function mistColor(look: TreelineLook, m: number, c: number): number {
  return (look.fogColor[c] as number) + (MIST_LIFT[c] as number) * m;
}

/** As the far kit trees: the lower third of each tree dissolves (mist-drowned trunks). */
const TREE_FINAL: FinalizeOptions = { rimWidth: 1.8, rimStrength: 0.75, softness: 1.3, edgeFade: 6, fadeBottom: [0.66, 1] };
/** Young trees stand in the thicket, which hides their bases. */
const YOUNG_FINAL: FinalizeOptions = { ...TREE_FINAL, fadeBottom: null };
const THICKET_FINAL: FinalizeOptions = { rimWidth: 2, rimStrength: 0.7, softness: 1.3 };
const THICKET: ClumpStyle = { ...LEAFY, lobes: 5, tufts: 4, flat: -0.03, holes: 0 };

/** Straight-alpha channel planes: luminance detail, rim mask, per-tree shade, coverage. */
interface Planes {
  lum: Float32Array;
  rim: Float32Array;
  shade: Float32Array;
  alpha: Float32Array;
}

function planes(n: number): Planes {
  return { lum: new Float32Array(n), rim: new Float32Array(n), shade: new Float32Array(n), alpha: new Float32Array(n) };
}

/** Straight "over" of a finalized element (RGBA8 in `px`, float coverage in `r.alpha`) at (x0, y0). */
function composite(p: Planes, W: number, H: number, r: ElementRaster, px: Uint8Array, x0: number, y0: number, shade: number): void {
  const ya = Math.max(0, -y0);
  const yb = Math.min(r.h, H - y0);
  const xa = Math.max(0, -x0);
  const xb = Math.min(r.w, W - x0);
  for (let y = ya; y < yb; y++) {
    for (let x = xa; x < xb; x++) {
      const i = y * r.w + x;
      const a = r.alpha[i] as number;
      if (a <= 0) continue;
      const o = (y0 + y) * W + x0 + x;
      const ba = p.alpha[o] as number;
      const k = ba * (1 - a);
      const oa = a + k;
      p.lum[o] = (((px[i * 4] as number) / 255) * a + (p.lum[o] as number) * k) / oa;
      p.rim[o] = (((px[i * 4 + 1] as number) / 255) * a + (p.rim[o] as number) * k) / oa;
      p.shade[o] = (shade * a + (p.shade[o] as number) * k) / oa;
      p.alpha[o] = oa;
    }
  }
}

function pickKind(rng: Rng, kinds: readonly [string, number][]): string {
  let total = 0;
  for (const [, w] of kinds) total += w;
  let t = rng.next() * total;
  for (const [k, w] of kinds) {
    t -= w;
    if (t <= 0) return k;
  }
  return (kinds[kinds.length - 1] as [string, number])[0];
}

/** 1D clearing noise along x (about [-1, 1]; table fbm has rms ≈ 0.2). */
function gapNoise(noise: NoiseTable, x: number, row: TreeRow): number {
  return noise.sample(x * row.gapFreq + 31.7, row.key.length * 19.3);
}

/** Plant one row of generator trees into `p`, left to right with jittered spacing, sizes and clearings. */
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

/**
 * A continuous thicket along the ground line: a lumpy body of blended masses under a broken top of
 * foliage clumps (the generator's `clump`: lobes and tufted rims), each seated on the body, lower in
 * the clearings of `row`.
 */
function thicket(p: Planes, W: number, H: number, base: number, row: TreeRow, seed: number, noise: NoiseTable, scratch: Scratch): void {
  const rng = new Rng((hashString('plate:thicket') ^ seed) >>> 0);
  const y0 = Math.max(0, Math.floor(base - 170));
  const h = H - y0;
  const r = new ElementRaster(W, h, noise, 211, scratch);
  r.configure(THICKET_FINAL);
  const b = base - y0;
  // Body: one continuous mass whose top runs along the ground line (it reaches below the plate, so
  // only the mist fade ends it), with low swells melted into it.
  r.volume(W / 2, b - 40, W, 0.04, -0.05);
  const R = h;
  r.capsule(-2 * R, b - 4 + R, W + 2 * R, b - 4 + R, R, R, Mat.Leaf, 0);
  for (let x = -60; x < W + 60; x += rng.range(70, 130)) {
    const rx = rng.range(70, 140);
    const ry = rng.range(16, 30);
    r.ellipse(x, b - 4 + ry * rng.range(0.4, 0.9), rx, ry, Mat.Leaf, 12);
  }
  r.noVolume();
  // Crown clumps heaped on the body (overlapping, so the top is one broken, lumpy line), lower and
  // smaller in the clearings; drawn lowest first so higher ones overlap them.
  const list: number[] = [];
  for (let x = rng.range(0, 30); x < W + 40; ) {
    const open = smoothstep(row.gapBelow + 0.12, row.gapBelow - 0.04, gapNoise(noise, x, row));
    const big = rng.chance(0.28 * (1 - 0.7 * open));
    const rx = (big ? rng.range(40, 58) : rng.range(22, 40)) * (1 - 0.25 * open);
    const ry = rx * rng.range(0.58, 0.9);
    const lift = rng.range(0.25, big ? 0.85 : 0.7) * (1 - 0.55 * open);
    const cy = b - ry * lift;
    list.push(x, cy, rx, ry);
    // A smaller clump heaped on a big one, toward the light (upper left).
    if (big && rng.chance(0.6)) list.push(x + rng.range(-0.5, 0.15) * rx, cy - ry * rng.range(0.5, 0.75), rx * rng.range(0.45, 0.6), ry * 0.55);
    x += rx * rng.range(0.7, 1.3);
  }
  const order: number[] = [];
  for (let i = 0; i < list.length; i += 4) order.push(i);
  order.sort((a, c) => (list[c + 1] as number) + (list[c + 3] as number) - (list[a + 1] as number) - (list[a + 3] as number));
  for (const i of order) {
    clump(r, rng, list[i] as number, list[i + 1] as number, list[i + 2] as number, list[i + 3] as number, THICKET);
  }
  const px = scratch.bytes(W * h * 4);
  r.finalize(px, W, 0, 0, THICKET_FINAL);
  composite(p, W, H, r, px, 0, y0, 0.46);
}

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

/**
 * Paint the treeline plate (`width`×`height` texels, deterministic in `seed`) in the look of the kit
 * layer it replaces: a back plane (smaller, hazier trees) and a front plane (trees of the replaced
 * layer's sizes, young trees and the thicket, dissolving into a mist bank below the ground line).
 */
export function paintTreeline(width: number, height: number, seed: number, look: TreelineLook): PlateImage {
  const noise = new NoiseTable(seed ^ 0x9a17, 5, 4);
  const scratch = new Scratch();
  const base = look.baseline;
  // Archetype scale that matches the replaced layer's tree sizes at this texel density.
  const k = ARCHETYPE_UNITS_PER_TEXEL / look.unitsPerTexel;
  const [s0, s1] = look.scale;
  const mist = look.mistDepth;
  const backBase = base - 0.3 * mist;
  const front: TreeRow = {
    key: 'front', base, baseJitter: 14, scale: [s0 * k, s1 * k], spacing: [95, 185],
    kinds: [['conifer', 3], ['broad', 2.2], ['willow', 1.6], ['slender', 0.8], ['snag', 1]],
    gapFreq: 0.14, gapBelow: -0.1, final: TREE_FINAL,
  };
  const planesSpec: Plane[] = [
    {
      rows: [{
        key: 'back', base: backBase, baseJitter: 10, scale: [s0 * k * 0.7, s1 * k * 0.8], spacing: [80, 160],
        kinds: [['conifer', 4], ['broad', 2.5], ['slender', 0.8], ['willow', 1], ['snag', 0.6]],
        gapFreq: 0.18, gapBelow: -0.16, final: TREE_FINAL,
      }],
      thicket: null, haze: 0.3, rim: 0.9, top: [0.94, 0.95, 1.05], low: [1.04, 1.1, 1.06], base: backBase,
      fade: [backBase - 0.3 * mist, backBase + 0.6 * mist], bank: null,
    },
    {
      rows: [front, {
        key: 'young', base: base + 8, baseJitter: 6, scale: [s0 * k * 0.34, s1 * k * 0.46], spacing: [150, 340],
        kinds: [['conifer', 3], ['broad', 1], ['snag', 0.4]], gapFreq: 0.1, gapBelow: -9, final: YOUNG_FINAL,
      }],
      thicket: base, haze: 0, rim: 1.5, top: [0.9, 0.93, 1.04], low: [1.04, 1.12, 1.06], base,
      fade: [base + 30, base + 0.6 * mist], bank: [base - 100, base - 5],
    },
  ];
  const n = width * height;
  const out = new Float32Array(n * 4);
  const p = planes(n);
  for (const pl of planesSpec) {
    p.lum.fill(0);
    p.rim.fill(0);
    p.shade.fill(0);
    p.alpha.fill(0);
    for (const row of pl.rows) plantRow(p, width, height, row, seed, noise, scratch);
    if (pl.thicket !== null) thicket(p, width, height, pl.thicket, front, seed, noise, scratch);
    let top = height;
    for (let i = 0; i < n; i++) {
      if ((p.alpha[i] as number) > 0.5) {
        top = Math.floor(i / width);
        break;
      }
    }
    paintPlane(out, p, width, height, pl, look, noise, top);
  }
  return { width, height, rgba: encode(out, width, height, look, (planesSpec[planesSpec.length - 1] as Plane).bank) };
}

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
