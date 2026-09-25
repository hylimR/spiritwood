import { describe, expect, test } from 'vitest';
import { MAX_ASPECT, MIN_ASPECT, MIN_CAMERA_ZOOM, VIEW_H } from '../../src/config.ts';
import { PLATE_MAX_VISIBLE_CHUNKS, PLATE_PREFETCH_MARGIN, plateChunkBytes, plateChunkRect } from '../../src/assets/plateLayout.ts';
import type { PlateLayerDef } from '../../src/contracts/assets.ts';
import type { QualityLevel } from '../../src/contracts/quality.ts';
import { SHAKE } from '../../src/render/post/shake.ts';
import { createCameraFrame, visibleLayerRect, type Extent } from '../../src/render/util/camera.ts';
import { levelSize } from '../../tools/art/bake.ts';
import {
  budgetLayer, defaultSweep, formatBudgetReport, MB, sweepBudget, type AtlasMeasure, type BudgetLayer,
} from '../../tools/art/budget.ts';
import { artPaths } from '../../tools/art/paths.ts';
import { plateLayerDef } from '../../tools/art/sidecar.ts';

/** The level size comes from forest.ldtk, as in the bake (never hard-coded). */
const LEVEL = levelSize(artPaths());
const SWEEP = defaultSweep(LEVEL.width, LEVEL.height);
const ATLASES: AtlasMeasure[] = [
  { id: 'forest-kit', width: 2048, height: 2048, bytes: 22_369_621 },
  { id: 'hero-atlas', width: 512, height: 512, bytes: 1_398_101 },
];
const ATLAS_BYTES = ATLASES.reduce((s, a) => s + a.bytes, 0);
const CHUNK_BYTES = 4 * 1024 * 1024;

/** A plate of cols × rows chunks at parallax f (texelScale 1.5: 1524 u per chunk). */
function grid(id: string, f: number, cols: number, rows: number, origin: [number, number], minQuality: QualityLevel = 'low'): PlateLayerDef {
  const def = plateLayerDef(id, {
    parallax: [f, f], replaces: null, origin, texelScale: 1.5, minQuality, fog: 0, fogColor: '#000000', desaturate: 0, tint: '#ffffff', area: null,
  });
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) def.chunks.push({ col, row, source: { webp: `plates/${id}_${col}_${row}.webp` } });
  }
  return def;
}

describe('plate budget sweep', () => {
  test('a chunk costs 4·w·h bytes of its bordered texture (RGBA8, the no-KTX2 worst case)', () => {
    expect(plateChunkBytes(grid('g', 0.5, 1, 1, [0, 0]))).toBe(CHUNK_BYTES);
    expect(SWEEP.viewW / SWEEP.viewH).toBeCloseTo(MAX_ASPECT);
    expect([SWEEP.zoom, SWEEP.shake, SWEEP.margin, SWEEP.maxChunks]).toEqual([MIN_CAMERA_ZOOM, SHAKE.maxOffset, PLATE_PREFETCH_MARGIN, PLATE_MAX_VISIBLE_CHUNKS]);
  });

  test('a plate that fits passes at every level', () => {
    const r = sweepBudget([budgetLayer(grid('small', 0.5, 2, 1, [1000, 200]))], { high: 96, medium: 64, low: 48 }, ATLASES, SWEEP);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    for (const l of r.levels) {
      expect(l.visible.bytes).toBe(ATLAS_BYTES + l.visible.chunks * CHUNK_BYTES);
      expect(l.visible.chunks).toBeGreaterThan(0);
    }
  });

  test('catches a constructed over-budget view at the levels that draw the plate, and only there', () => {
    // Three chunks side by side at f 0.5: a 21:9 view (2520 u + shake) always straddles two or three.
    const layers = [budgetLayer(grid('wide', 0.5, 3, 1, [1000, 0], 'medium'))];
    const budget = { high: 64, medium: 28, low: 24 };
    const r = sweepBudget(layers, budget, ATLASES, SWEEP);
    const byLevel = Object.fromEntries(r.levels.map((l) => [l.level, l]));
    expect(byLevel.medium?.visible.chunks).toBeGreaterThanOrEqual(2);
    expect(byLevel.medium?.visible.bytes).toBeGreaterThan(28 * MB);
    expect(byLevel.high?.visible.bytes).toBeLessThanOrEqual(64 * MB);
    // Low doesn't draw a medium plate: only the atlases count there.
    expect(byLevel.low?.layers).toEqual([]);
    expect(byLevel.low?.visible.bytes).toBe(ATLAS_BYTES);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/^medium: visible plates need \d+\.\d\d MB with the atlases, over the 28 MB budget at camera \(-?\d+, -?\d+\) at 2\.33:1: wide ×[23]/);
    expect(formatBudgetReport(r)).toMatch(/medium budget 28\.00 MB: .* OVER BUDGET/);
  });

  test('catches a plate that shows more than 4 chunks at once', () => {
    // 1524 u chunks at f 0.5: the view (2534 × 1094 u with shake) spans up to 3 columns and 2 rows.
    const r = sweepBudget([budgetLayer(grid('huge', 0.5, 6, 2, [0, -1000]))], { high: 512, medium: 512, low: 512 }, ATLASES, SWEEP);
    const peak = r.peaks[0];
    expect(peak?.chunks).toBe(6);
    expect(r.errors).toEqual([expect.stringMatching(/^huge: 6 chunks visible at once .* at most 4 \(2 draws each\)/)]);
  });

  test('samples every chunk-edge breakpoint: two chunks both in view only inside a 1 u camera window are found', () => {
    const f = 0.5;
    // The swept half-width is the runtime's visible rect widened by the largest shake either way.
    const cam = { ...createCameraFrame(), cx: 5000, cy: LEVEL.height / 2, zoom: SWEEP.zoom, viewW: SWEEP.viewW, viewH: SWEEP.viewH };
    const lo = visibleLayerRect({ ...cam, shakeX: SWEEP.shake }, f, f, { x0: 0, y0: 0, x1: 0, y1: 0 });
    const hi = visibleLayerRect({ ...cam, shakeX: -SWEEP.shake }, f, f, { x0: 0, y0: 0, x1: 0, y1: 0 });
    const h = (hi.x1 - lo.x0) / 2;
    const a: Extent = { x0: 1000, y0: -1e5, x1: 2000, y1: 1e5 };
    // Both are in view for camera x·f in (b.x0 − h, a.x1 + h): 0.5 layer units, 1 u of camera travel.
    const b: Extent = { x0: 2000 + 2 * h - 0.5, y0: -1e5, x1: 3000 + 2 * h, y1: 1e5 };
    const layer: BudgetLayer = {
      id: 'pair', parallax: [f, f], minQuality: 'low', chunks: [a, b], chunkBytes: CHUNK_BYTES, texture: [1024, 1024], area: null,
    };
    const r = sweepBudget([layer], { high: 96, medium: 64, low: 48 }, ATLASES, SWEEP);
    const peak = r.peaks[0];
    expect(peak?.chunks).toBe(2);
    expect((peak?.cx ?? 0) * f).toBeGreaterThan(b.x0 - h);
    expect((peak?.cx ?? 0) * f).toBeLessThan(a.x1 + h);
    expect(r.levels[0]?.visible.chunks).toBe(2);
  });

  test('over budget only with the prefetch margin is a warning, not an error', () => {
    // Two chunks 2 × 480 u apart plus the view: never visible together, together within the margin.
    const f = 0.5;
    const h = SWEEP.viewW / 2 + SWEEP.shake * f;
    const a: Extent = { x0: 1000, y0: -1e5, x1: 2000, y1: 1e5 };
    const b: Extent = { x0: 2000 + 2 * h + PLATE_PREFETCH_MARGIN, y0: -1e5, x1: 3000 + 2 * h + PLATE_PREFETCH_MARGIN, y1: 1e5 };
    const layer: BudgetLayer = {
      id: 'gap', parallax: [f, f], minQuality: 'low', chunks: [a, b], chunkBytes: CHUNK_BYTES, texture: [1024, 1024], area: null,
    };
    const tight = (ATLAS_BYTES + 1.5 * CHUNK_BYTES) / MB;
    const r = sweepBudget([layer], { high: tight, medium: tight, low: tight }, ATLASES, SWEEP);
    expect(r.errors).toEqual([]);
    expect(r.levels.map((l) => [l.visible.chunks, l.prefetch.chunks])).toEqual([[1, 2], [1, 2], [1, 2]]);
    expect(r.warnings).toHaveLength(3);
    expect(r.warnings[0]).toMatch(/^high: with the 480 u prefetch margin plates reach .* the streamer will skip prefetching there/);
  });

  test('the camera stays in the level: chunks it can never reach never count', () => {
    const view = SWEEP.viewW / 2;
    const beyond = LEVEL.width * 0.5 + view + 10;
    const r = sweepBudget([budgetLayer(grid('offstage', 0.5, 2, 1, [beyond, 0]))], { high: 96, medium: 64, low: 48 }, ATLASES, SWEEP);
    expect(r.peaks[0]?.chunks).toBe(0);
    expect(r.levels.every((l) => l.visible.bytes === ATLAS_BYTES)).toBe(true);
  });

  test('foreground plates are swept at narrower aspects too: a 4:3 view clamped at the level edge reaches further', () => {
    const f = 1.5;
    const layer: BudgetLayer = {
      id: 'fg', parallax: [f, 0], minQuality: 'low', chunkBytes: CHUNK_BYTES, texture: [1024, 1024], area: null,
      chunks: [{ x0: -1000, y0: -500, x1: 500, y1: 500 }, { x0: 500, y0: -500, x1: 2000, y1: 500 }],
    };
    // A 4:3 camera clamped at the left edge sees layer x from 720·1.5 − 734 = 346: both chunks.
    const viewW = VIEW_H * MIN_ASPECT;
    const cam = { ...createCameraFrame(), cx: viewW / 2, cy: LEVEL.height / 2, zoom: 1, viewW, viewH: VIEW_H };
    const vis = visibleLayerRect(cam, f, 0, { x0: 0, y0: 0, x1: 0, y1: 0 });
    expect(layer.chunks.filter((c) => c.x1 > vis.x0 && c.x0 < vis.x1).length).toBe(2);
    const budget = (1.5 * CHUNK_BYTES + ATLAS_BYTES) / MB;
    const r = sweepBudget([layer], { high: budget, medium: budget, low: budget }, ATLASES, SWEEP);
    expect(r.peaks[0]?.chunks).toBe(2);
    expect(r.peaks[0]?.viewW).toBeLessThan(SWEEP.viewW);
    expect(r.errors[0]).toMatch(/^high: visible plates need .* at camera \(\d+, \d+\) at 1\.\d\d:1: fg ×2/);
  });

  test('never under-counts: a brute-force sweep of camera, aspect and shake finds no view with more chunks', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (seed + 0x6d2b79f5) >>> 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const W = LEVEL.width;
    const H = LEVEL.height;
    for (let trial = 0; trial < 24; trial++) {
      const fg = trial % 2 === 1;
      const f = Math.round((fg ? 1.05 + rnd() * 1.5 : 0.05 + rnd() * 0.9) * 100) / 100;
      const fy = fg && rnd() < 0.5 ? 0 : f;
      const def = plateLayerDef('p', {
        parallax: [f, fy], replaces: null, origin: [Math.round((rnd() - 0.3) * 3000), Math.round((rnd() - 0.6) * 2000)],
        texelScale: 1.5 + Math.floor(rnd() * 3) * 0.5, minQuality: 'low', fog: 0, fogColor: '#000000', desaturate: 0, tint: '#ffffff', area: null,
      });
      const cols = 1 + Math.floor(rnd() * 5);
      const rows = 1 + Math.floor(rnd() * 3);
      for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) if (rnd() < 0.8) def.chunks.push({ col, row, source: { webp: 'x.webp' } });
      if (def.chunks.length === 0) continue;
      const peak = sweepBudget([budgetLayer(def)], { high: 4096, medium: 4096, low: 4096 }, [], SWEEP).peaks[0]?.chunks ?? 0;
      const rects = def.chunks.map((c) => plateChunkRect(def, c.col, c.row));
      let brute = 0;
      for (let a = 0; a <= 11; a++) {
        const viewW = VIEW_H * (MIN_ASPECT + ((MAX_ASPECT - MIN_ASPECT) * a) / 11);
        const cx0 = Math.min(viewW / 2, W / 2);
        const cx1 = Math.max(W - viewW / 2, W / 2);
        const cy0 = Math.min(VIEW_H / 2, H / 2);
        const cy1 = Math.max(H - VIEW_H / 2, H / 2);
        for (let i = 0; i <= 120; i++) {
          for (let j = 0; j <= 12; j++) {
            for (const [sx, sy] of [[-14, -14], [-14, 14], [14, -14], [14, 14]] as const) {
              const cam = {
                ...createCameraFrame(), cx: cx0 + ((cx1 - cx0) * i) / 120, cy: cy0 + ((cy1 - cy0) * j) / 12, zoom: 1, viewW, viewH: VIEW_H, shakeX: sx, shakeY: sy,
              };
              const v = visibleLayerRect(cam, f, fy, { x0: 0, y0: 0, x1: 0, y1: 0 });
              let n = 0;
              for (const c of rects) if (c.x1 > v.x0 && c.x0 < v.x1 && c.y1 > v.y0 && c.y0 < v.y1) n++;
              brute = Math.max(brute, n);
            }
          }
        }
      }
      expect(brute, `trial ${trial}: f ${f}/${fy}`).toBeLessThanOrEqual(peak);
    }
  }, 60_000);
});
