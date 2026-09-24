/**
 * Bake-time texture budget for painted plates (ARCHITECTURE.md §5.8, §6). The camera is swept over its
 * clamped range at the smallest zoom (MIN_CAMERA_ZOOM) and the largest screen shake, sampled between
 * every chunk-edge breakpoint of every layer, so every distinct set of visible chunks is seen:
 * - at the widest aspect (MAX_ASPECT), which shows the most of every depth-tested layer (fx ≤ 1): any
 *   narrower view, clamped or not, sees a subset of a widest view;
 * - for foreground layers (fx > 1) also at narrower aspects down to MIN_ASPECT: a narrow view clamped at
 *   a level edge reaches further into them. It samples 4:3, 16:9 and every aspect at which a chunk edge
 *   meets the edge of a view clamped at either end of the level (half-width = edge / (f ± 1) at zoom 1).
 * For each quality level, the plates it draws (minQuality) × 4·w·h bytes (RGBA8, the no-KTX2 worst case)
 * plus every registered atlas must fit textureBudgetMB; with the prefetch margin included it is a
 * warning. No layer may show more than PLATE_MAX_VISIBLE_CHUNKS chunks at once.
 */
import { MAX_ASPECT, MIN_ASPECT, MIN_CAMERA_ZOOM, VIEW_H } from '../../src/config.ts';
import type { PlateLayerDef } from '../../src/contracts/assets.ts';
import type { QualityLevel } from '../../src/contracts/quality.ts';
import {
  PLATE_MAX_VISIBLE_CHUNKS, PLATE_PREFETCH_MARGIN, plateChunkBytes, plateChunkRect, plateTextureSize,
} from '../../src/assets/plateLayout.ts';
import { SHAKE } from '../../src/render/post/shake.ts';
import { zoomForParallax, type Extent } from '../../src/render/util/camera.ts';

export const MB = 2 ** 20;
export const QUALITY_LEVELS: readonly QualityLevel[] = ['high', 'medium', 'low'];
const RANK: Readonly<Record<QualityLevel, number>> = { low: 0, medium: 1, high: 2 };

export function drawsAt(level: QualityLevel, minQuality: QualityLevel): boolean {
  return RANK[level] >= RANK[minQuality];
}

export interface BudgetLayer {
  id: string;
  parallax: [number, number];
  minQuality: QualityLevel;
  /** Layer-space rects of the layer's (non-empty) chunks. */
  chunks: Extent[];
  /** Worst-case GPU bytes of one chunk (RGBA8, no mipmaps). */
  chunkBytes: number;
  /** Chunk texture size, for the report. */
  texture: [number, number];
  area: string | null;
}

export function budgetLayer(def: PlateLayerDef, area: string | null = null): BudgetLayer {
  return {
    id: def.id,
    parallax: [def.parallax[0], def.parallax[1]],
    minQuality: def.minQuality,
    chunks: def.chunks.map((c) => plateChunkRect(def, c.col, c.row)),
    chunkBytes: plateChunkBytes(def),
    texture: plateTextureSize(def),
    area,
  };
}

export interface SweepConfig {
  levelW: number;
  levelH: number;
  /** Widest view (MAX_ASPECT). */
  viewW: number;
  /** Narrowest view (MIN_ASPECT): foreground layers are swept from here to viewW. */
  minViewW: number;
  viewH: number;
  zoom: number;
  /** Largest screen-shake offset (view units, each axis). */
  shake: number;
  /** Prefetch margin (layer units). */
  margin: number;
  maxChunks: number;
}

export function defaultSweep(levelW: number, levelH: number): SweepConfig {
  return {
    levelW, levelH, viewW: VIEW_H * MAX_ASPECT, minViewW: VIEW_H * MIN_ASPECT, viewH: VIEW_H, zoom: MIN_CAMERA_ZOOM, shake: SHAKE.maxOffset,
    margin: PLATE_PREFETCH_MARGIN, maxChunks: PLATE_MAX_VISIBLE_CHUNKS,
  };
}

export interface AtlasMeasure {
  id: string;
  width: number;
  height: number;
  bytes: number;
}

export interface Worst {
  /** Plates + atlases. */
  bytes: number;
  chunks: number;
  cx: number;
  cy: number;
  /** View width of the worst view (its aspect is viewW / viewH). */
  viewW: number;
  perLayer: Record<string, number>;
}

export interface LevelBudget {
  level: QualityLevel;
  budgetBytes: number;
  atlasBytes: number;
  /** Plate layers this level draws. */
  layers: string[];
  visible: Worst;
  prefetch: Worst;
}

export interface LayerPeak {
  id: string;
  chunks: number;
  total: number;
  cx: number;
  cy: number;
  viewW: number;
}

export interface BudgetReport {
  config: SweepConfig;
  atlases: AtlasMeasure[];
  levels: LevelBudget[];
  peaks: LayerPeak[];
  layers: BudgetLayer[];
  errors: string[];
  warnings: string[];
}

interface Half {
  hx: number;
  hy: number;
}

function halfSize(l: BudgetLayer, viewW: number, c: SweepConfig, extra: number): Half {
  const [fx, fy] = l.parallax;
  const zx = zoomForParallax(c.zoom, fx);
  const zy = zoomForParallax(c.zoom, fy);
  // The union of the visible rects over every shake offset in [−shake, shake] (visibleLayerRect).
  return {
    hx: viewW / (2 * zx) + (c.shake * Math.min(fx, 1)) / zx + extra,
    hy: c.viewH / (2 * zy) + (c.shake * Math.min(fy, 1)) / zy + extra,
  };
}

/**
 * View widths to sweep: the widest, and for foreground layers (fx > 1) also the narrowest, 16:9, and every
 * width at which a chunk's x edge meets the edge of a view whose camera is clamped at a level end (or
 * centred, when the level is narrower than the view), with the midpoints between them.
 */
function viewWidths(layers: readonly BudgetLayer[], c: SweepConfig, extra: number): number[] {
  const lo = Math.min(c.minViewW, c.viewW);
  const hi = c.viewW;
  const pts = [hi];
  if (lo < hi && layers.some((l) => l.parallax[0] > 1)) {
    pts.push(lo);
    const wide = VIEW_H * (16 / 9);
    if (wide > lo && wide < hi) pts.push(wide);
    const W = c.levelW;
    // Where the camera stops clamping (the level is exactly one view wide).
    if (W * c.zoom > lo && W * c.zoom < hi) pts.push(W * c.zoom);
    for (const l of layers) {
      const f = l.parallax[0];
      if (f <= 1) continue;
      const zf = zoomForParallax(c.zoom, f);
      // Camera half-width H = w / (2 zoom); layer half-width h = w / (2 zf) + k.
      const k = (c.shake * Math.min(f, 1)) / zf + extra;
      const a = f / (2 * c.zoom);
      const b = 1 / (2 * zf);
      for (const r of l.chunks) {
        for (const e of [r.x0, r.x1]) {
          // Clamped left (C = H): H f ∓ h = e. Clamped right (C = W − H): (W − H) f ∓ h = e.
          // Centred (C = W / 2, level narrower than the view): W f / 2 ∓ h = e.
          for (const w of [
            (e + k) / (a - b), (e - k) / (a + b),
            (W * f - k - e) / (a + b), (W * f + k - e) / (a - b),
            (W * f / 2 - e - k) / b, (e - W * f / 2 - k) / b,
          ]) {
            if (Number.isFinite(w) && w > lo && w < hi) pts.push(w);
          }
        }
      }
    }
  }
  pts.sort((x, y) => x - y);
  const out: number[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last !== undefined && p - last < 1e-6) continue;
    if (last !== undefined) out.push((last + p) / 2);
    out.push(p);
  }
  return out;
}

/** Camera centres at which some layer's visible chunk set can change, plus the ends; sorted with midpoints. */
function samples(layers: readonly BudgetLayer[], halves: readonly Half[], lo: number, hi: number, axis: 0 | 1): number[] {
  const pts = [lo, hi];
  for (let i = 0; i < layers.length; i++) {
    const l = layers[i] as BudgetLayer;
    const f = l.parallax[axis];
    if (f <= 0) continue;
    const h = axis === 0 ? (halves[i] as Half).hx : (halves[i] as Half).hy;
    for (const r of l.chunks) {
      const a = axis === 0 ? r.x0 : r.y0;
      const b = axis === 0 ? r.x1 : r.y1;
      // Chunk [a, b) overlaps [c·f − h, c·f + h] for (a − h)/f < c < (b + h)/f.
      for (const p of [(a - h) / f, (b + h) / f]) if (p > lo && p < hi) pts.push(p);
    }
  }
  pts.sort((x, y) => x - y);
  const out: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i] as number;
    if (i > 0 && p - (pts[i - 1] as number) < 1e-9) continue;
    if (out.length > 0) out.push(((out[out.length - 1] as number) + p) / 2);
    out.push(p);
  }
  return out;
}

function visibleCount(l: BudgetLayer, h: Half, cx: number, cy: number): number {
  const x0 = cx * l.parallax[0] - h.hx;
  const x1 = cx * l.parallax[0] + h.hx;
  const y0 = cy * l.parallax[1] - h.hy;
  const y1 = cy * l.parallax[1] + h.hy;
  let n = 0;
  for (const r of l.chunks) if (r.x1 > x0 && r.x0 < x1 && r.y1 > y0 && r.y0 < y1) n++;
  return n;
}

function sweep(layers: readonly BudgetLayer[], c: SweepConfig, extra: number, visit: (cx: number, cy: number, viewW: number, counts: Int32Array) => void): void {
  const counts = new Int32Array(layers.length);
  const hh = c.viewH / (2 * c.zoom);
  for (const viewW of viewWidths(layers, c, extra)) {
    const halves = layers.map((l) => halfSize(l, viewW, c, extra));
    const hw = viewW / (2 * c.zoom);
    const xs = samples(layers, halves, Math.min(hw, c.levelW / 2), Math.max(c.levelW - hw, c.levelW / 2), 0);
    const ys = samples(layers, halves, Math.min(hh, c.levelH / 2), Math.max(c.levelH - hh, c.levelH / 2), 1);
    for (const cy of ys) {
      for (const cx of xs) {
        for (let i = 0; i < layers.length; i++) counts[i] = visibleCount(layers[i] as BudgetLayer, halves[i] as Half, cx, cy);
        visit(cx, cy, viewW, counts);
      }
    }
  }
}

function worstFor(layers: readonly BudgetLayer[], drawn: readonly boolean[], c: SweepConfig, extra: number, atlasBytes: number): Worst {
  let best: Worst = { bytes: atlasBytes, chunks: 0, cx: c.levelW / 2, cy: c.levelH / 2, viewW: c.viewW, perLayer: {} };
  sweep(layers, c, extra, (cx, cy, viewW, counts) => {
    let bytes = atlasBytes;
    let chunks = 0;
    for (let i = 0; i < layers.length; i++) {
      if (!drawn[i]) continue;
      bytes += (counts[i] as number) * (layers[i] as BudgetLayer).chunkBytes;
      chunks += counts[i] as number;
    }
    if (bytes > best.bytes) {
      const perLayer: Record<string, number> = {};
      for (let i = 0; i < layers.length; i++) if (drawn[i] && (counts[i] as number) > 0) perLayer[(layers[i] as BudgetLayer).id] = counts[i] as number;
      best = { bytes, chunks, cx, cy, viewW, perLayer };
    }
  });
  return best;
}

/** Run the sweep for every quality level and collect errors (over budget, > maxChunks) and warnings. */
export function sweepBudget(
  layers: readonly BudgetLayer[], textureBudgetMB: Readonly<Record<QualityLevel, number>>, atlases: readonly AtlasMeasure[], c: SweepConfig,
): BudgetReport {
  const atlasBytes = atlases.reduce((s, a) => s + a.bytes, 0);
  const errors: string[] = [];
  const warnings: string[] = [];
  const peaks: LayerPeak[] = layers.map((l) => ({ id: l.id, chunks: 0, total: l.chunks.length, cx: 0, cy: 0, viewW: c.viewW }));
  sweep(layers, c, 0, (cx, cy, viewW, counts) => {
    for (let i = 0; i < layers.length; i++) {
      const p = peaks[i] as LayerPeak;
      if ((counts[i] as number) > p.chunks) {
        p.chunks = counts[i] as number;
        p.cx = cx;
        p.cy = cy;
        p.viewW = viewW;
      }
    }
  });
  const at = (cx: number, cy: number, viewW: number): string => `camera (${cx.toFixed(0)}, ${cy.toFixed(0)}) at ${(viewW / c.viewH).toFixed(2)}:1`;
  for (const p of peaks) {
    if (p.chunks > c.maxChunks) {
      errors.push(`${p.id}: ${p.chunks} chunks visible at once (${at(p.cx, p.cy, p.viewW)}); a plate layer may show at most ${c.maxChunks} (2 draws each). Make it smaller, raise texelScale or move content so fewer chunks share a view`);
    }
  }
  const levels: LevelBudget[] = [];
  for (const level of QUALITY_LEVELS) {
    const drawn = layers.map((l) => drawsAt(level, l.minQuality));
    const budgetBytes = textureBudgetMB[level] * MB;
    const visible = worstFor(layers, drawn, c, 0, atlasBytes);
    const prefetch = worstFor(layers, drawn, c, c.margin, atlasBytes);
    levels.push({ level, budgetBytes, atlasBytes, layers: layers.filter((_, i) => drawn[i]).map((l) => l.id), visible, prefetch });
    const where = (w: Worst): string => `${at(w.cx, w.cy, w.viewW)}: ${Object.entries(w.perLayer).map(([id, n]) => `${id} ×${n}`).join(', ')}`;
    if (visible.bytes > budgetBytes) {
      errors.push(`${level}: visible plates need ${(visible.bytes / MB).toFixed(2)} MB with the atlases, over the ${textureBudgetMB[level]} MB budget at ${where(visible)}. Raise minQuality of a plate, raise texelScale or trim empty space`);
    } else if (prefetch.bytes > budgetBytes) {
      warnings.push(`${level}: with the ${c.margin} u prefetch margin plates reach ${(prefetch.bytes / MB).toFixed(2)} MB, over the ${textureBudgetMB[level]} MB budget at ${where(prefetch)}; the streamer will skip prefetching there`);
    }
  }
  return { config: c, atlases: [...atlases], levels, peaks, layers: [...layers], errors, warnings };
}

export function formatBudgetReport(r: BudgetReport): string {
  const mb = (b: number): string => (b / MB).toFixed(2);
  const lines: string[] = [];
  const c = r.config;
  lines.push(`Plate texture budget: worst case RGBA8 (4·w·h per chunk, no KTX2); camera swept at ${(c.viewW / c.viewH).toFixed(2)}:1 (foreground plates from ${(c.minViewW / c.viewH).toFixed(2)}:1), zoom ${c.zoom}, ±${c.shake} u shake, level ${c.levelW}×${c.levelH}`);
  lines.push(`  registered atlases: ${r.atlases.map((a) => `${a.id} ${a.width}×${a.height} ${mb(a.bytes)} MB`).join(', ')} = ${mb(r.atlases.reduce((s, a) => s + a.bytes, 0))} MB`);
  for (const l of r.levels) {
    const v = l.visible;
    const p = l.prefetch;
    const status = v.bytes > l.budgetBytes ? 'OVER BUDGET' : p.bytes > l.budgetBytes ? 'ok (prefetch over)' : 'ok';
    lines.push(`  ${l.level.padEnd(6)} budget ${mb(l.budgetBytes)} MB: atlases ${mb(l.atlasBytes)} + visible plates ${v.chunks} chunk${v.chunks === 1 ? '' : 's'} ${mb(v.bytes - l.atlasBytes)} = ${mb(v.bytes)} MB (${mb(l.budgetBytes - v.bytes)} MB free); with the ${c.margin} u prefetch ${p.chunks} chunk${p.chunks === 1 ? '' : 's'} = ${mb(p.bytes)} MB  ${status}`);
    if (v.chunks > 0) lines.push(`         worst view: camera (${v.cx.toFixed(0)}, ${v.cy.toFixed(0)}) at ${(v.viewW / c.viewH).toFixed(2)}:1 shows ${Object.entries(v.perLayer).map(([id, n]) => `${id} ×${n}`).join(', ')}`);
    if (l.layers.length === 0) lines.push('         (no plate layer draws at this level)');
  }
  for (const p of r.peaks) {
    const l = r.layers.find((x) => x.id === p.id) as BudgetLayer;
    lines.push(`  ${p.id}${l.area ? ` (${l.area})` : ''}: f ${l.parallax[0]}/${l.parallax[1]}, minQuality ${l.minQuality}, ${p.total} chunk${p.total === 1 ? '' : 's'} of ${l.texture[0]}×${l.texture[1]}, at most ${p.chunks} visible (limit ${c.maxChunks})`);
  }
  for (const w of r.warnings) lines.push(`  warning: ${w}`);
  for (const e of r.errors) lines.push(`  ERROR: ${e}`);
  return lines.join('\n');
}
