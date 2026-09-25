import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseManifest } from '../../src/assets/manifest.ts';
import { hash8, PLATE_BORDER, PLATE_CONTENT, PLATE_TEXTURE, pathnameOf } from '../../src/assets/plateLayout.ts';
import type { KitLayerDef, PlateLayerDef } from '../../src/contracts/assets.ts';
import { KIT_MODE, shadeKit } from '../../src/render/layers/kitShading.ts';
import { kitShadeParams, plateShadeParams } from '../../src/render/layers/layerModel.ts';
import { coverageExtent, type LayerPlacement } from '../../src/render/layers/placement.ts';
import { RECIPES } from '../../src/render/layers/recipes.ts';
import { chunkSource, type ChunkResult } from '../../tools/art/chunks.ts';
import { memorySource } from '../../tools/art/source.ts';
import { chunkHulls, paintTreeline, type PlateImage } from '../../tools/plates/paint.ts';
import { CHUNK, forestLevelSize, planPlate, PLATE_ID, PLATE_SEED, plateManifest, REPLACES, TEXEL_SCALE } from '../../tools/plates/plan.ts';
import { shadePlate } from '../../tools/preview/world/compose.ts';

const LAYERS = new URL('../../public/layers/', import.meta.url);
/** The hand-edited base manifest: the demo plate derives from it (§5.8). */
const forest = parseManifest(JSON.parse(readFileSync(new URL('forest.base.manifest.json', LAYERS), 'utf8')));
const plan = planPlate(forest);
const SLOW = 60_000;

/** Even-odd point-in-polygon (flat x,y pairs). */
function inside(poly: readonly number[], x: number, y: number): boolean {
  let hit = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2] as number;
    const yi = poly[i * 2 + 1] as number;
    const xj = poly[j * 2] as number;
    const yj = poly[j * 2 + 1] as number;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

const alphaAt = (img: PlateImage, x: number, y: number): number => img.rgba[(y * img.width + x) * 4 + 3] as number;
const luma = (c: ArrayLike<number>): number => 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);

/** A synthetic chunk: an opaque band with bumps on top, a soft top edge and a fading base. */
function synthetic(w: number, h: number): PlateImage {
  const rgba = new Uint8Array(w * h * 4);
  for (let x = 0; x < w; x++) {
    const top = 50 + Math.round(12 * Math.sin(x * 0.07) + 6 * Math.sin(x * 0.31));
    for (let y = 0; y < h; y++) {
      const edge = Math.min(1, Math.max(0, (y - top) / 3));
      const base = Math.min(1, Math.max(0, (h - 12 - y) / 10));
      const o = (y * w + x) * 4;
      rgba[o] = 40;
      rgba[o + 1] = 60;
      rgba[o + 2] = 90;
      rgba[o + 3] = Math.round(edge * base * 255);
    }
  }
  return { width: w, height: h, rgba };
}

describe('chunkHulls', () => {
  test('the hull encloses every visible texel; the opaque hull covers only opaque texels', () => {
    const img = synthetic(256, 160);
    const { hull, opaqueHull } = chunkHulls(img.rgba, img.width, 0, 0, img.width, img.height);
    expect(hull).not.toBeNull();
    expect(opaqueHull).not.toBeNull();
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const a = alphaAt(img, x, y);
        // Texel corners of every visible texel lie inside or on the hull (sample just inside them).
        if (a > 1) for (const [dx, dy] of [[0.01, 0.01], [0.99, 0.01], [0.01, 0.99], [0.99, 0.99]] as const) expect(inside(hull as number[], x + dx, y + dy)).toBe(true);
        if (inside(opaqueHull as number[], x + 0.5, y + 0.5)) expect(a).toBeGreaterThanOrEqual(254);
      }
    }
  });

  test('strip polygons: 2 × (width / 16 + 1) points, and no opaque hull without an opaque row', () => {
    const img = synthetic(1024, 128);
    const { hull, opaqueHull } = chunkHulls(img.rgba, img.width, 0, 0, img.width, img.height);
    expect((hull as number[]).length / 2).toBe(2 * (1024 / 16 + 1));
    expect((opaqueHull as number[]).length / 2).toBe(2 * (1024 / 16 + 1));
    for (let i = 3; i < img.rgba.length; i += 4) img.rgba[i] = Math.min(img.rgba[i] as number, 200);
    expect(chunkHulls(img.rgba, img.width, 0, 0, img.width, img.height).opaqueHull).toBeNull();
  });
});

describe('paintTreeline (demo plate)', () => {
  const W = 1024;
  const H = plan.height;
  const look = plan.look;
  const img = paintTreeline(W, H, PLATE_SEED, look);

  test('is deterministic', () => {
    const again = paintTreeline(W, H, PLATE_SEED, look);
    expect(Buffer.from(again.rgba).equals(Buffer.from(img.rgba))).toBe(true);
  }, SLOW);

  test('stands on the replaced layer\'s ground line and dissolves into mist below it', () => {
    let first = -1;
    let last = -1;
    for (let y = 0; y < H; y++) {
      let any = false;
      for (let x = 0; x < W && !any; x++) any = alphaAt(img, x, y) > 0;
      if (any && first < 0) first = y;
      if (any) last = y;
    }
    // Trees rise well above the ground line but leave open sky at the top of the plate.
    expect(first).toBeGreaterThan(H * 0.15);
    expect(first).toBeLessThan(look.baseline - 150);
    // Nothing below the replaced layer's full height mist (the base dissolves, no hard bottom edge).
    expect(last).toBeLessThan(look.baseline + look.mistDepth);
    // The last visible rows are faint.
    let maxA = 0;
    for (let x = 0; x < W; x++) maxA = Math.max(maxA, alphaAt(img, x, last));
    expect(maxA).toBeLessThan(32);
  });

  test('has a continuous opaque thicket along the ground line (the opaque core)', () => {
    let band = 0;
    for (let y = Math.floor(look.baseline - look.mistDepth / 2); y < look.baseline + look.mistDepth / 2; y++) {
      let all = true;
      for (let x = 0; x < W && all; x++) all = alphaAt(img, x, y) >= 254;
      if (all) band++;
    }
    expect(band).toBeGreaterThanOrEqual(24);
    const { opaqueHull } = chunkHulls(img.rgba, W, 0, 0, W, CHUNK);
    expect(opaqueHull).not.toBeNull();
  });

  test('transparent texels carry the surrounding colour, not black (clean straight-alpha filtering)', () => {
    let black = 0;
    for (let i = 0; i < img.rgba.length; i += 4) {
      if ((img.rgba[i + 3] as number) === 0 && (img.rgba[i] as number) + (img.rgba[i + 1] as number) + (img.rgba[i + 2] as number) === 0) black++;
    }
    expect(black).toBe(0);
  });

  test('sits on the aerial-perspective ramp between its neighbours, at the replaced layer\'s value', () => {
    const placement = { extent: { x0: 0, y0: 0, x1: 0, y1: 0 }, baselineY: 0, groundFillTop: null, instances: [] } as LayerPlacement;
    const body = (id: string): number => {
      const l = forest.layers.find((d) => d.id === id) as KitLayerDef;
      const out = new Float32Array(4);
      shadeKit(out, [0.5, 0, 0, 1], 0.5, [0, 0, 0], -1e9, { ...kitShadeParams(l, RECIPES[l.recipe] as (typeof RECIPES)[string], placement), glow: 0 }, KIT_MODE.Core);
      return luma(out);
    };
    const ids = forest.layers.map((l) => l.id);
    const behind = body(ids[plan.index - 1] as string);
    const replaced = body(REPLACES);
    const front = body(ids[plan.index + 1] as string);
    // Median shaded luma of the opaque silhouettes above the height mist.
    const params = plateShadeParams(plan.layer);
    const mistRow = look.baseline - 0.25 * look.mistDepth;
    const tex = new Float32Array(3);
    const rgb = new Float32Array(3);
    const lumas: number[] = [];
    for (let y = 0; y < mistRow; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        if ((img.rgba[o + 3] as number) < 250) continue;
        for (let c = 0; c < 3; c++) tex[c] = (img.rgba[o + c] as number) / 255;
        shadePlate(rgb, tex, params, 0);
        lumas.push(luma(rgb));
      }
    }
    lumas.sort((a, b) => a - b);
    const median = lumas[lumas.length >> 1] as number;
    expect(lumas.length).toBeGreaterThan(10_000);
    expect(median).toBeGreaterThan(front);
    expect(median).toBeLessThan(behind);
    expect(Math.abs(median - replaced)).toBeLessThan(0.025);
  });
});

describe('demo plate plan', () => {
  test('covers the replaced layer\'s extent of the level read from forest.ldtk, in whole chunks', () => {
    const level = forestLevelSize();
    const [fx, fy] = plan.layer.parallax;
    const ext = coverageExtent(level.width, level.height, fx, fy);
    expect(plan.layer.chunkSize).toEqual([CHUNK, CHUNK]);
    expect(CHUNK).toBe(PLATE_CONTENT);
    expect(plan.width % CHUNK).toBe(0);
    expect(plan.height % CHUNK).toBe(0);
    expect(plan.layer.origin[0]).toBeLessThanOrEqual(ext.x0);
    expect(plan.layer.origin[0] + plan.width * TEXEL_SCALE).toBeGreaterThanOrEqual(ext.x1);
    expect(plan.layer.origin[1]).toBeLessThanOrEqual(ext.y0);
    expect(plan.layer.origin[1] + plan.height * TEXEL_SCALE).toBeGreaterThanOrEqual(ext.y1 - TEXEL_SCALE);
  });
});

describe('shipped plates manifest', () => {
  const path = new URL('forest.plates.manifest.json', LAYERS);
  const json: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const baked = json ? parseManifest(json) : null;
  const plateOf = (): PlateLayerDef => (baked as NonNullable<typeof baked>).layers[plan.index] as PlateLayerDef;

  test('is the splice of the base manifest: the plate in L3\'s slot with its fog and desaturation, L3 recorded as replaced', () => {
    if (!baked) return;
    const plate = plateOf();
    expect(plate.kind).toBe('plate');
    expect(plate.id).toBe(PLATE_ID);
    const replaced = forest.layers[plan.index] as KitLayerDef;
    expect([plate.fog, plate.fogColor, plate.desaturate]).toEqual([replaced.fog, replaced.fogColor, replaced.desaturate]);
    const expected = parseManifest(JSON.parse(JSON.stringify(plateManifest(forest, plan, plate.chunks))));
    expect(baked).toEqual(expected);
    // A failed demo plate restores the kit layer it replaced.
    expect(baked.replaced?.[PLATE_ID]).toEqual(replaced);
  });

  test('every chunk has its three encodings (1024² with a 1-texel border, cache-busted URLs), split-hull rects and a hash', () => {
    if (!baked) return;
    const plate = plateOf();
    expect(plate.chunks).toHaveLength((plan.width / CHUNK) * (plan.height / CHUNK));
    let bytes = 0;
    for (const c of plate.chunks) {
      expect(c.hash).toMatch(/^[0-9a-f]{16}$/);
      for (const f of ['ktx2', 'webp', 'png'] as const) {
        const rel = c.source[f] as string;
        expect(rel.endsWith(`?v=${hash8(c.hash as string)}`)).toBe(true);
        bytes += statSync(new URL(pathnameOf(rel), LAYERS)).size;
      }
      expect((c.core ?? []).length % 4).toBe(0);
      expect((c.soft as number[]).length).toBeGreaterThan(0);
      expect(c.hull).toBeUndefined();
    }
    expect(bytes).toBeLessThan(4 * 1024 * 1024);
  });

  test('is not stale: repainting gives exactly the shipped chunk hashes and rects (rebake with `npm run plates`)', async () => {
    if (!baked) return;
    const plate = plateOf();
    const img = paintTreeline(plan.width, plan.height, PLATE_SEED, plan.look);
    const chunks: ChunkResult[] = [];
    for await (const c of chunkSource(memorySource(img.width, img.height, img.rgba))) chunks.push(c);
    expect(chunks.map((c) => [c.col, c.row, c.hash])).toEqual(plate.chunks.map((c) => [c.col, c.row, c.hash]));
    for (const c of chunks) {
      const shipped = plate.chunks.find((d) => d.col === c.col && d.row === c.row);
      expect(shipped?.core).toEqual(c.core);
      expect(shipped?.soft).toEqual(c.soft);
      expect(c.rgba.length).toBe(PLATE_TEXTURE * PLATE_TEXTURE * 4);
    }
    // The duplicated border: texture column 0 of chunk 1 is content column C − 1 of chunk 0.
    const a = chunks.find((c) => c.col === 0 && c.row === 0) as ChunkResult;
    const b = chunks.find((c) => c.col === 1 && c.row === 0) as ChunkResult;
    for (let y = PLATE_BORDER; y < PLATE_TEXTURE - PLATE_BORDER; y += 37) {
      const left = ((y * PLATE_TEXTURE) + PLATE_CONTENT) * 4;
      const right = (y * PLATE_TEXTURE) * 4;
      if ((a.rgba[left + 3] as number) === 0) continue;
      expect([...b.rgba.subarray(right, right + 4)]).toEqual([...a.rgba.subarray(left, left + 4)]);
    }
  }, SLOW);
});
