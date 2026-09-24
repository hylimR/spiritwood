import { hashString, Rng } from '../../core/rng.ts';
import { computeSplitHullHalf, splitRowsAt, subdivideRows, type HullOptions } from './hull.ts';
import { ELEMENT_MARGIN, ELEMENT_SPECS, KIT_CATEGORIES, type ElementSpec, type KitCategory, type SwayAnchor } from './kitElements.ts';
import { NoiseTable } from './noiseTable.ts';
import { packRects, type PackItem } from './pack.ts';
import { ElementRaster } from './raster.ts';

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

/** Seed for a procedural atlas id (e.g. 'forest-kit'). */
export function kitSeed(atlasId: string): number {
  return hashString(atlasId);
}
