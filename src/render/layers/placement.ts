import { MAX_ASPECT, MAX_INSTANCES_PER_LAYER, MIN_ASPECT, MIN_CAMERA_ZOOM, VIEW_H } from '../../config.ts';
import type { KitLayerDef } from '../../contracts/assets.ts';
import { Rng } from '../../core/rng.ts';
import type { KitElement } from '../gen/kit.ts';
import type { KitCategory } from '../gen/kitElements.ts';
import { layerExtent, type Extent } from '../util/camera.ts';
import type { Recipe, RecipeItem, RecipeStream } from './recipes.ts';

/** One placed kit element in layer space. */
export interface KitInstance {
  el: KitElement;
  /** Anchor position (layer units). */
  x: number;
  y: number;
  /** Scale; sx < 0 mirrors the element. */
  sx: number;
  sy: number;
  /** Sway phase (radians). */
  phase: number;
  /** Brightness variation, 0.5 = neutral. */
  shade: number;
  /** Painter order within the layer (0 = backmost). */
  k: number;
}

export interface LayerPlacement {
  extent: Extent;
  baselineY: number;
  /** Top of the opaque ground body, or null. */
  groundFillTop: number | null;
  instances: KitInstance[];
}

export type KitIndex = Readonly<Record<KitCategory, readonly KitElement[]>>;

/**
 * The layer-space region static geometry must cover: the union of layerExtent at the narrowest and
 * widest aspect (ARCHITECTURE.md §2.3), so placement never depends on the live window aspect.
 */
export function coverageExtent(levelW: number, levelH: number, fx: number, fy: number): Extent {
  const a = layerExtent(levelW, levelH, VIEW_H * MIN_ASPECT, VIEW_H, fx, fy, MIN_CAMERA_ZOOM);
  const b = layerExtent(levelW, levelH, VIEW_H * MAX_ASPECT, VIEW_H, fx, fy, MIN_CAMERA_ZOOM);
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

function pickItem(items: readonly RecipeItem[], rng: Rng): RecipeItem {
  let total = 0;
  for (const it of items) total += it.weight;
  let t = rng.next() * total;
  for (const it of items) {
    t -= it.weight;
    if (t < 0) return it;
  }
  return items[items.length - 1] as RecipeItem;
}

function anchorBase(stream: RecipeStream, extent: Extent, baselineY: number): number {
  return stream.from === 'top' ? extent.y0 : stream.from === 'bottom' ? extent.y1 : baselineY;
}

/** Margin (layer units) by which hard cuts are kept outside the covered extent. */
const CUT_MARGIN = 12;

/**
 * Layer-space y of element texel row `ty`. Rows below `el.stretchFrom` scale with |sx|; rows above
 * it with `sy`, so a trunk can stretch up out of frame while its root flare keeps its proportions.
 */
export function elementRowY(inst: Pick<KitInstance, 'el' | 'y' | 'sx' | 'sy'>, ty: number): number {
  const el = inst.el;
  const u = el.unitsPerTexel;
  const s = Math.abs(inst.sx);
  const sf = el.stretchFrom;
  return ty >= sf ? inst.y + (ty - el.anchorY) * u * s : inst.y + (sf - el.anchorY) * u * s + (ty - sf) * u * inst.sy;
}

/** Half-width (layer units) of the clearing a stream with `clearAtHints` leaves around each hint. */
export const HINT_CLEARING = 320;

/** Is layer-space x inside a clearing? Hint world x maps to layer x·f (where the camera centred on it looks). */
function inClearing(x: number, clearings: readonly number[], f: number): boolean {
  for (let i = 0; i < clearings.length; i++) if (Math.abs(x - (clearings[i] as number) * f) < HINT_CLEARING) return true;
  return false;
}

/** A crown on the stretched column of `trunk` (see RecipeStream.attach), or null when there is no room. */
function attachCrown(
  trunk: KitInstance, a: NonNullable<RecipeStream['attach']>, kit: KitIndex, extent: Extent, rng: Rng,
): KitInstance | null {
  const pool = kit[a.category];
  if (pool.length === 0) throw new Error(`Kit has no '${a.category}' elements`);
  const el = rng.pick(pool);
  const t = trunk.el;
  const s = Math.abs(trunk.sx);
  const columnTop = elementRowY(trunk, t.stretchFrom);
  const halfH = (el.h / 2) * el.unitsPerTexel * s;
  const hi = extent.y0 + halfH * 0.6;
  if (columnTop - hi < halfH) return null;
  const f = rng.range(a.span[0], a.span[1]);
  const y = columnTop - (columnTop - hi) * f + (el.anchorY - el.h / 2) * el.unitsPerTexel * s;
  const colX = trunk.x + (t.columnX - t.anchorX) * t.unitsPerTexel * trunk.sx;
  const flip = rng.chance(0.5) ? -1 : 1;
  return { el, x: colX, y, sx: flip * s, sy: s, phase: rng.range(0, Math.PI * 2), shade: trunk.shade, k: 0 };
}

/** Keep top cuts out of view: stretch the rows above `stretchFrom` until the top clears the extent. */
function stretchForCut(el: KitElement, y: number, sx: number, extent: Extent): number {
  const s = Math.abs(sx);
  if (el.cut !== 'top' || el.stretchFrom <= 0) return s;
  const u = el.unitsPerTexel;
  const need = (y + (el.stretchFrom - el.anchorY) * u * s - (extent.y0 - CUT_MARGIN)) / (el.stretchFrom * u);
  return Math.max(s, need);
}

/**
 * Deterministic instance placement for a kit layer (seeded by `def.seed`). Streams place elements
 * left → right across the coverage extent; painter order is stream order, then scale (smaller =
 * farther) within a stream.
 */
export function placeLayer(
  def: KitLayerDef, recipe: Recipe, kit: KitIndex, levelW: number, levelH: number, clearings: readonly number[] = [],
): LayerPlacement {
  const extent = coverageExtent(levelW, levelH, def.parallax[0], def.parallax[1]);
  const baselineY = extent.y0 + def.baseline * (extent.y1 - extent.y0);
  const rng = new Rng(def.seed);
  const all: KitInstance[] = [];
  for (let s = 0; s < recipe.streams.length; s++) {
    const stream = recipe.streams[s] as RecipeStream;
    const srng = rng.fork(s);
    const placed: KitInstance[] = [];
    const base = anchorBase(stream, extent, baselineY);
    const tiled = stream.tile !== undefined;
    const step = tiled ? 0 : 1000 / Math.max(1e-6, def.density * stream.density);
    if (!tiled && stream.density <= 0) continue;
    let x = extent.x0 - (tiled ? 0 : step * srng.next());
    const crowns = new Map<KitInstance, KitInstance>();
    const gap = stream.gaps ? gapNoise(srng.fork(99), extent.x0 - 2000, extent.x1 + 2000, stream.gaps.scale, stream.gaps.below) : null;
    for (let guard = 0; guard < 4096; guard++) {
      const item = pickItem(stream.items, srng);
      const pool = kit[item.category];
      if (pool.length === 0) throw new Error(`Kit has no '${item.category}' elements`);
      const el = srng.pick(pool);
      const [m0, m1] = item.scale ?? [1, 1];
      const scale = srng.range(def.scale[0], def.scale[1]) * srng.range(m0, m1);
      const widthUnits = el.w * el.unitsPerTexel * scale;
      if (tiled && guard === 0) x -= widthUnits * 0.5;
      if (x - widthUnits * 0.5 > extent.x1) break;
      const flip = stream.flip !== false && srng.chance(0.5);
      const y = base + srng.range(stream.y[0], stream.y[1]);
      const sx = flip ? -scale : scale;
      const phase = srng.range(0, Math.PI * 2);
      const shade = srng.range(0.38, 0.62);
      if ((gap && stream.gaps && gap(x) < stream.gaps.below) || (stream.clearAtHints && inClearing(x, clearings, def.parallax[0]))) {
        x += tiled ? widthUnits * (1 - (stream.tile as number)) : step * srng.range(0.55, 1.45);
        continue;
      }
      const inst: KitInstance = { el, x, y, sx, sy: stretchForCut(el, y, scale, extent), phase, shade, k: 0 };
      placed.push(inst);
      if (stream.attach && el.cut === 'top' && srng.chance(stream.attach.chance)) {
        const crown = attachCrown(inst, stream.attach, kit, extent, srng);
        if (crown) crowns.set(inst, crown);
      }
      x += tiled ? widthUnits * (1 - (stream.tile as number)) : step * srng.range(0.55, 1.45);
    }
    placed.sort((a, b) => Math.abs(a.sx) - Math.abs(b.sx) || a.x - b.x);
    for (const p of placed) {
      all.push(p);
      const c = crowns.get(p);
      if (c) all.push(c);
    }
  }
  if (all.length > MAX_INSTANCES_PER_LAYER) {
    throw new Error(`Layer ${def.id}: ${all.length} instances exceed MAX_INSTANCES_PER_LAYER (${MAX_INSTANCES_PER_LAYER})`);
  }
  for (let i = 0; i < all.length; i++) (all[i] as KitInstance).k = i + 1;
  return {
    extent,
    baselineY,
    groundFillTop: recipe.groundFill === null ? null : baselineY + recipe.groundFill,
    instances: all,
  };
}

/**
 * Smooth 1D value noise in [0, 1] over [x0, x1] with one random value per `scale` units (cosine
 * interpolated). No two neighbouring cells both fall into a clearing, so clearings stay glade-sized.
 */
function gapNoise(rng: Rng, x0: number, x1: number, scale: number, below: number): (x: number) => number {
  const n = Math.ceil((x1 - x0) / scale) + 2;
  const v = new Float32Array(n);
  const safe = Math.min(1, below * 1.4);
  for (let i = 0; i < n; i++) {
    const r = rng.next();
    v[i] = i > 0 && (v[i - 1] as number) < safe && r < safe ? safe + (1 - safe) * rng.next() : r;
  }
  return (x: number): number => {
    const f = Math.min(n - 1.001, Math.max(0, (x - x0) / scale));
    const i = Math.floor(f);
    const t = (1 - Math.cos((f - i) * Math.PI)) * 0.5;
    return (v[i] as number) + ((v[i + 1] as number) - (v[i] as number)) * t;
  };
}

/** Layer-space AABB of an instance (without sway). */
export function instanceBounds(inst: KitInstance, out: Extent): Extent {
  const el = inst.el;
  const u = el.unitsPerTexel;
  const ax = el.anchorX;
  const xa = inst.x + (0 - ax) * u * inst.sx;
  const xb = inst.x + (el.w - ax) * u * inst.sx;
  out.x0 = Math.min(xa, xb);
  out.x1 = Math.max(xa, xb);
  out.y0 = elementRowY(inst, 0);
  out.y1 = elementRowY(inst, el.h);
  return out;
}
