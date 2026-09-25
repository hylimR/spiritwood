/**
 * Painterly-pass measurements shared by `stroke-report.ts` and tests/world/strokes.test.ts: per kit
 * layer, how much the brush strokes move the final (pre-grade) luma of the layer's elements, and
 * whether the layer's mean value stays where it was (the aerial-perspective ramp).
 *
 * A layer's elements are every variant of the categories its recipe places. Each texel is shaded with
 * the kit shading model and the layer's parameters (no height mist, neutral instance shade, no glow
 * light), before (the plain atlas, at stroke gain 1: the pre-M2 look) and after (the painted one, at
 * the layer's stroke gain), at the same atlas rects.
 */
import type { KitLayerDef, LayerManifest } from '../../../src/contracts/assets.ts';
import type { KitAtlasData, KitElement } from '../../../src/render/gen/kit.ts';
import type { KitCategory } from '../../../src/render/gen/kitElements.ts';
import { KIT_MODE, shadeKit } from '../../../src/render/layers/kitShading.ts';
import { kitShadeParams } from '../../../src/render/layers/layerModel.ts';
import type { LayerPlacement } from '../../../src/render/layers/placement.ts';
import { RECIPES } from '../../../src/render/layers/recipes.ts';
import { premultiplyRgba } from '../../../src/render/util/texture.ts';

export interface LayerStrokeStats {
  id: string;
  /** Alpha-weighted mean luma of the layer's elements (8-bit codes), before and after. */
  meanBefore: number;
  meanAfter: number;
  /** Relative change of the total coverage Σ A (dry-brush edges). */
  coverage: number;
  /** |Δ luma| over texels opaque in both atlases (8-bit codes): mean and percentiles. */
  meanAbs: number;
  p50: number;
  p75: number;
  p90: number;
  /** Luma codes per unit of R on this layer (the shading's gain for the luminance channel). */
  gain: number;
  texels: number;
}

const luma = (c: ArrayLike<number>): number => 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);

/** The categories a kit layer's recipe places (including attached crowns). */
export function layerCategories(def: KitLayerDef): KitCategory[] {
  const recipe = RECIPES[def.recipe];
  if (!recipe) throw new Error(`unknown recipe ${def.recipe}`);
  const out = new Set<KitCategory>();
  for (const s of recipe.streams) {
    for (const it of s.items) out.add(it.category);
    if (s.attach) out.add(s.attach.category);
  }
  return [...out];
}

function percentile(sorted: Float32Array, q: number): number {
  return sorted.length ? (sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number) : 0;
}

/** Stroke statistics of every kit layer in `manifest` (atlases generated from the same seed and size). */
export function layerStrokeStats(manifest: LayerManifest, before: KitAtlasData, after: KitAtlasData): LayerStrokeStats[] {
  const placement = { extent: { x0: 0, y0: 0, x1: 0, y1: 0 }, baselineY: 0, groundFillTop: null, instances: [] } as unknown as LayerPlacement;
  const out: LayerStrokeStats[] = [];
  const tex = new Float32Array(4);
  const px = new Float32Array(4);
  const shade = (pix: Uint8Array, o: number, p: ReturnType<typeof kitShadeParams>, r?: number): number => {
    tex[0] = r ?? (pix[o] as number) / 255;
    tex[1] = (pix[o + 1] as number) / 255;
    tex[2] = (pix[o + 2] as number) / 255;
    tex[3] = 1;
    shadeKit(px, tex, 0.5, [0, 0, 0], -1e9, p, KIT_MODE.Core);
    return luma(px) * 255;
  };
  for (const def of manifest.layers) {
    if (def.kind !== 'kit') continue;
    const recipe = RECIPES[def.recipe];
    if (!recipe) continue;
    const p = { ...kitShadeParams(def, recipe, placement), glow: 0 };
    // The plain atlas stores its detail undivided: it shades at gain 1.
    const p0 = { ...p, strokeGain: 1 };
    let sa0 = 0;
    let sl0 = 0;
    let sa1 = 0;
    let sl1 = 0;
    const deltas: number[] = [];
    for (const cat of layerCategories(def)) {
      const els = before.byCategory[cat];
      const els1 = after.byCategory[cat];
      for (let e = 0; e < els.length; e++) {
        const el = els[e];
        const el1 = els1[e];
        if (!el || !el1 || el.x !== el1.x || el.y !== el1.y) throw new Error('atlases differ in layout');
        for (let y = 0; y < el.h; y++) {
          for (let x = 0; x < el.w; x++) {
            const o = ((el.y + y) * before.width + el.x + x) * 4;
            const a0 = (before.pixels[o + 3] as number) / 255;
            const a1 = (after.pixels[o + 3] as number) / 255;
            if (a0 === 0 && a1 === 0) continue;
            const l0 = a0 > 0 ? shade(before.pixels, o, p0) : 0;
            const l1 = a1 > 0 ? shade(after.pixels, o, p) : 0;
            sa0 += a0;
            sl0 += a0 * l0;
            sa1 += a1;
            sl1 += a1 * l1;
            if (a0 === 1 && a1 === 1) deltas.push(Math.abs(l1 - l0));
          }
        }
      }
    }
    const d = Float32Array.from(deltas).sort();
    let sum = 0;
    for (let i = 0; i < d.length; i++) sum += d[i] as number;
    const gain = shade(new Uint8Array([0, 0, 0, 255]), 0, p, 1) - shade(new Uint8Array([0, 0, 0, 255]), 0, p, 0);
    out.push({
      id: def.id,
      meanBefore: sa0 > 0 ? sl0 / sa0 : 0,
      meanAfter: sa1 > 0 ? sl1 / sa1 : 0,
      coverage: sa0 > 0 ? sa1 / sa0 - 1 : 0,
      meanAbs: d.length ? sum / d.length : 0,
      p50: percentile(d, 0.5),
      p75: percentile(d, 0.75),
      p90: percentile(d, 0.9),
      gain,
      texels: d.length,
    });
  }
  return out;
}

/**
 * The atlas's mip 1 as the kit shader samples it where the GPU minifies (far layers, low render
 * scale): premultiplied on upload (premultiplyRgba), a rounded 2×2 box average, then un-premultiplied
 * (the shader's rgb / a), as straight RGBA8, with every element rect halved (outward).
 */
export function mip1Atlas(atlas: KitAtlasData): KitAtlasData {
  const W = atlas.width;
  const w = W >> 1;
  const h = atlas.height >> 1;
  const pre = atlas.pixels.slice();
  premultiplyRgba(pre);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const i0 = (2 * y * W + 2 * x) * 4;
      const i1 = i0 + W * 4;
      const avg = (c: number): number =>
        Math.round(((pre[i0 + c] as number) + (pre[i0 + 4 + c] as number) + (pre[i1 + c] as number) + (pre[i1 + 4 + c] as number)) / 4);
      const a = avg(3);
      px[o + 3] = a;
      for (let c = 0; c < 3; c++) px[o + c] = a > 0 ? Math.min(255, Math.round((avg(c) * 255) / a)) : 0;
    }
  }
  const half = (e: KitElement): KitElement => {
    const x0 = e.x >> 1;
    const y0 = e.y >> 1;
    return { ...e, x: x0, y: y0, w: ((e.x + e.w + 1) >> 1) - x0, h: ((e.y + e.h + 1) >> 1) - y0 };
  };
  const byCategory = {} as Record<KitCategory, KitElement[]>;
  for (const c of Object.keys(atlas.byCategory) as KitCategory[]) byCategory[c] = atlas.byCategory[c].map(half);
  return { ...atlas, width: w, height: h, pixels: px, elements: atlas.elements.map(half), byCategory };
}

/** The statistics as a Markdown table (L1–L8, F1, F2 = the brief's L1–L10). */
export function strokeStatsTable(stats: readonly LayerStrokeStats[]): string {
  const rows = [
    '| layer | mean luma before → after (Δ) | coverage Δ | abs Δ luma mean / p50 / p75 / p90 | codes per unit R |',
    '|---|---|---|---|---|',
  ];
  for (const s of stats) {
    rows.push(
      `| ${s.id} | ${s.meanBefore.toFixed(2)} → ${s.meanAfter.toFixed(2)} (${(s.meanAfter - s.meanBefore >= 0 ? '+' : '')}${(s.meanAfter - s.meanBefore).toFixed(2)}) `
      + `| ${(s.coverage * 100).toFixed(2)} % | ${s.meanAbs.toFixed(2)} / ${s.p50.toFixed(2)} / ${s.p75.toFixed(2)} / ${s.p90.toFixed(2)} | ${s.gain.toFixed(1)} |`,
    );
  }
  return rows.join('\n');
}
