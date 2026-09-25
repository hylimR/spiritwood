import { hashString, Rng } from '../../core/rng.ts';
import { computeSplitHullHalf, splitRowsAt, subdivideRows, type HullOptions } from './hull.ts';
import { ELEMENT_MARGIN, ELEMENT_SPECS, KIT_CATEGORIES, type ElementSpec, type KitCategory, type SwayAnchor } from './kitElements.ts';
import { NoiseTable } from './noiseTable.ts';
import { packRects, type PackItem } from './pack.ts';
import { ElementRaster, Scratch, type FinalizeOptions } from './raster.ts';

/** Highest mip level the kit shader samples (it clamps its LOD); gutters and core insets derive from it. */
export const KIT_MAX_MIP = 1;
/** Hull settings for every kit element. */
export const KIT_HULL: HullOptions = {
  cell: 4,
  maxSpans: 6,
  coreInset: 1 + (1 << KIT_MAX_MIP),
  pad: 1 << KIT_MAX_MIP,
  minCore: 6,
  minGap: 4,
  snap: 2,
};
/** Rows of swaying elements are split on this texel grid so the vertex shader can bend them. */
export const SWAY_ROW_STEP = 24;
/** Texels between packed element rects (each rect also has an internal transparent margin). */
export const KIT_GUTTER = 4;
/** Default atlas size (the manifest's atlas entry is authoritative at runtime). */
export const KIT_WIDTH = 2048;
export const KIT_HEIGHT = 2048;

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
  /** Texel x of the trunk column that leaves a top-cut element (its anchorX when there is none). */
  columnX: number;
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
 * Rasterise one element into the atlas and compute its split hull. (Kept out of the generator:
 * V8 optimises loops in plain functions much sooner, which matters for the single cold run at boot.)
 */
function buildElement(
  job: Job, i: number, index: number, seed: number, noise: NoiseTable, scratch: Scratch, pixels: Uint8Array, width: number,
): KitElement {
  const { spec, variant, item } = job;
  const rng = new Rng((hashString(`${spec.key ?? spec.category}:${variant}`) ^ seed) >>> 0);
  const r = new ElementRaster(spec.w, spec.h, noise, i + 1, scratch);
  // Every element's options in one fixed-shape object: finalize reads them monomorphically (spread
  // spec objects of assorted keys would deoptimise it at boot).
  const f = spec.finalize;
  const fo: FinalizeOptions = {
    softness: f.softness, dispScale: f.dispScale, fadeBottom: f.fadeBottom ?? null, rimWidth: f.rimWidth, rimStrength: f.rimStrength,
    detail: f.detail, alphaScale: f.alphaScale, edgeFade: f.edgeFade ?? ELEMENT_MARGIN, cut: f.cut ?? spec.cut, strokes: f.strokes ?? null,
  };
  r.configure(fo);
  spec.draw(r, rng, variant);
  const x = item.x as number;
  const y = item.y as number;
  r.finalize(pixels, width, x, y, fo);
  const alphaBytes = scratch.bytes(spec.w * spec.h);
  copyAlpha(pixels, width, x, y, spec.w, spec.h, alphaBytes);
  const hull = computeSplitHullHalf(alphaBytes, spec.w, spec.h, KIT_HULL);
  const sway = spec.sway !== 'none';
  const stretchFrom = spec.stretchFrom ?? spec.anchorY;
  const split = (rects: number[]): number[] => (spec.cut === 'top' ? splitRowsAt(rects, stretchFrom) : rects);
  return {
    index,
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
    columnX: Number.isNaN(r.columnX) ? spec.anchorX : r.columnX,
    core: split(sway ? subdivideRows(hull.core, SWAY_ROW_STEP) : hull.core),
    soft: split(sway ? subdivideRows(hull.soft, SWAY_ROW_STEP) : hull.soft),
    coreArea: hull.coreArea,
    softArea: hull.softArea,
  };
}

function copyAlpha(pixels: Uint8Array, width: number, x: number, y: number, w: number, h: number, out: Uint8Array): void {
  for (let row = 0; row < h; row++) {
    let src = ((y + row) * width + x) * 4 + 3;
    const o = row * w;
    for (let col = 0; col < w; col++, src += 4) out[o + col] = pixels[src] as number;
  }
}

/**
 * Deterministic kit generation as a step generator: one element per step, so the async variant can
 * yield to the event loop between elements and keep the boot screen responsive.
 */
function* kitSteps(
  seed: number, width: number, height: number, specs: readonly ElementSpec[], order: KitBuildOrder = 'smallest',
): Generator<void, KitAtlasData> {
  const jobs: Job[] = [];
  for (const spec of specs) {
    for (let v = 0; v < spec.variants; v++) jobs.push({ spec, variant: v, item: { w: spec.w, h: spec.h } });
  }
  packRects(jobs.map((j) => j.item), width, height, KIT_GUTTER);
  const pixels = new Uint8Array(width * height * 4);
  const noise = new NoiseTable(seed ^ 0x5eed);
  const elements: KitElement[] = [];
  const byCategory = Object.fromEntries(KIT_CATEGORIES.map((c) => [c, [] as KitElement[]])) as Record<KitCategory, KitElement[]>;
  const scratch = new Scratch();
  // Size the scratch once for the largest element (growing it element by element churns the GC).
  let maxN = 0;
  let maxH = 0;
  for (const j of jobs) {
    maxN = Math.max(maxN, j.spec.w * j.spec.h);
    maxH = Math.max(maxH, j.spec.h);
  }
  scratch.ensure(maxN, maxH);
  yield;
  // Build the smallest elements first (each element is independent: its own rng, noise offset and
  // atlas rect, so the atlas is byte-identical in any order): the rasteriser's loops reach optimised
  // code on cheap elements instead of interpreting the first big one, which matters for the single
  // cold run at boot. Elements are listed in job order.
  const orderList: number[] = [];
  for (let i = 0; i < jobs.length; i++) orderList.push(i);
  const area = (i: number): number => (jobs[i] as Job).spec.w * (jobs[i] as Job).spec.h;
  if (order === 'smallest') orderList.sort((a, b) => area(a) - area(b) || a - b);
  const built: KitElement[] = [];
  for (let n = 0; n < orderList.length; n++) {
    const i = orderList[n] as number;
    built[i] = buildElement(jobs[i] as Job, i, i, seed, noise, scratch, pixels, width);
    yield;
  }
  for (let i = 0; i < built.length; i++) {
    const el = built[i] as KitElement;
    elements.push(el);
    byCategory[el.category].push(el);
  }
  return { width, height, pixels, elements, byCategory, ms: 0 };
}

/** Element build order: smallest first (the default, fastest cold), or as listed (tests: the atlas is the same). */
export type KitBuildOrder = 'smallest' | 'listed';

/** Generate the procedural forest kit synchronously (tests, tools). */
export function generateKit(
  seed: number, width = KIT_WIDTH, height = KIT_HEIGHT, specs: readonly ElementSpec[] = ELEMENT_SPECS, order: KitBuildOrder = 'smallest',
): KitAtlasData {
  const it = kitSteps(seed, width, height, specs, order);
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

/** Seed for a procedural atlas id (e.g. 'forest-kit'). */
export function kitSeed(atlasId: string): number {
  return hashString(atlasId);
}
