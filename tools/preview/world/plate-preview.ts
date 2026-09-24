/**
 * The demo plate on its own, without a browser: the plate shaded with its manifest parameters over the
 * sky (full size and box-downsampled ×4, the "does it still say tree" check), its coverage, a hull
 * overlay (band outline red, opaque core green), per-chunk hull numbers, and a value-ramp check against
 * the kit layer it replaces (luma percentiles of opaque texels above the height mist, next to the kit's
 * far-tree texels shaded as that layer, and the neighbouring layers' neutral bodies).
 *
 *   node tools/preview/world/plate-preview.ts [outDir] [--baked ktx2|webp|png] [--crop x,y,w,h]
 *
 * Default: repaint in memory with tools/plates/paint.ts. `--baked` decodes the shipped chunk files and
 * also reports their encoding error against a fresh repaint (premultiplied RGB and alpha RMSE, 8-bit).
 */
import { readFileSync } from 'node:fs';
import { parseManifest } from '../../../src/assets/manifest.ts';
import type { KitLayerDef, PlateLayerDef } from '../../../src/contracts/assets.ts';
import { generateKit, kitSeed } from '../../../src/render/gen/kit.ts';
import { polygonArea, triangulate } from '../../../src/render/gen/polygon.ts';
import { kitShadeParams, plateShadeParams } from '../../../src/render/layers/layerModel.ts';
import { KIT_MODE, shadeKit } from '../../../src/render/layers/kitShading.ts';
import type { LayerPlacement } from '../../../src/render/layers/placement.ts';
import { RECIPES } from '../../../src/render/layers/recipes.ts';
import { planPlate, REPLACES } from '../../plates/plan.ts';
import { canvas, downsample, outDir, save } from './common.ts';
import { shadePlate, type PlateChunkImage } from './compose.ts';
import { loadBakedPlates, paintedPlates, type PlateFormat } from './plates.ts';

const dir = outDir();
const args = process.argv.slice(3);
const bi = args.indexOf('--baked');
const baked = bi >= 0 ? ((args[bi + 1] ?? 'webp') as PlateFormat) : null;
const ci = args.indexOf('--crop');
const crop = ci >= 0 ? (args[ci + 1] ?? '').split(',').map(Number) : null;

const layersUrl = new URL('../../../public/layers/', import.meta.url);
const base = parseManifest(JSON.parse(readFileSync(new URL('forest.manifest.json', layersUrl), 'utf8')));
const plan = planPlate(base);
let def: PlateLayerDef;
let chunks: PlateChunkImage[];
if (baked) {
  const m = parseManifest(JSON.parse(readFileSync(new URL('forest.plates.manifest.json', layersUrl), 'utf8')));
  const plates = await loadBakedPlates(m, baked);
  const P = plates.get(plan.layer.id);
  if (!P) throw new Error(`no plate layer ${plan.layer.id} in forest.plates.manifest.json`);
  def = P.def;
  chunks = P.chunks;
  const ref = paintedPlates(base).plates.get(plan.layer.id);
  if (ref) {
    let se = 0;
    let sa = 0;
    let n = 0;
    for (let k = 0; k < Math.min(chunks.length, ref.chunks.length); k++) {
      const A = (ref.chunks[k] as PlateChunkImage).rgba;
      const B = (chunks[k] as PlateChunkImage).rgba;
      for (let i = 0; i < A.length; i += 4) {
        const aa = (A[i + 3] as number) / 255;
        const ab = (B[i + 3] as number) / 255;
        if (aa <= 0 && ab <= 0) continue;
        for (let c = 0; c < 3; c++) se += ((A[i + c] as number) * aa - (B[i + c] as number) * ab) ** 2;
        sa += ((A[i + 3] as number) - (B[i + 3] as number)) ** 2;
        n++;
      }
    }
    console.log(`${baked} vs repaint: premultiplied RGB rmse ${Math.sqrt(se / (3 * Math.max(1, n))).toFixed(2)}, alpha rmse ${Math.sqrt(sa / Math.max(1, n)).toFixed(2)} (8-bit, ${n} texels)`);
  }
} else {
  const painted = paintedPlates(base);
  console.log(`painted ${painted.image.width}×${painted.image.height} in ${painted.ms.toFixed(0)} ms`);
  const P = painted.plates.get(plan.layer.id);
  if (!P) throw new Error('paint produced no plate');
  def = P.def;
  chunks = P.chunks;
}

// Reassemble the chunks into one image (straight RGBA8).
const [cw, ch] = def.chunkSize;
let cols = 0;
let rows = 0;
for (const c of chunks) {
  cols = Math.max(cols, c.col + 1);
  rows = Math.max(rows, c.row + 1);
}
const W = cols * cw;
const H = rows * ch;
const img = new Uint8Array(W * H * 4);
for (const c of chunks) {
  for (let y = 0; y < ch; y++) img.set(c.rgba.subarray(y * cw * 4, (y + 1) * cw * 4), ((c.row * ch + y) * W + c.col * cw) * 4);
}

// Shaded over a mid sky colour, as the plate program draws it (no mist on plates).
const params = plateShadeParams(def);
const SKY = 0x0d2140;
const shaded = canvas(W, H, SKY);
const alphaImg = canvas(W, H, 0);
const tex = new Float32Array(4);
const rgb = new Float32Array(3);
for (let i = 0; i < W * H; i++) {
  const a = (img[i * 4 + 3] as number) / 255;
  for (let c = 0; c < 3; c++) {
    tex[c] = (img[i * 4 + c] as number) / 255;
    alphaImg[i * 4 + c] = img[i * 4 + 3] as number;
  }
  if (a <= 0) continue;
  shadePlate(rgb, tex, params, 0);
  for (let c = 0; c < 3; c++) shaded[i * 4 + c] = (shaded[i * 4 + c] as number) * (1 - a) + Math.min(1, rgb[c] as number) * 255 * a;
}
save(dir, 'plate-shaded.png', shaded, W, H);
if (crop) {
  const [cx, cy, cwid, chei] = crop as [number, number, number, number];
  const part = new Uint8Array(cwid * chei * 4);
  for (let y = 0; y < chei; y++) part.set(shaded.subarray(((cy + y) * W + cx) * 4, ((cy + y) * W + cx + cwid) * 4), y * cwid * 4);
  save(dir, 'plate-crop.png', part, cwid, chei);
}
const s4 = downsample(shaded, W, H, 4);
save(dir, 'plate-shaded-x4.png', s4.data, s4.w, s4.h);
const a2 = downsample(alphaImg, W, H, 2);
save(dir, 'plate-alpha.png', a2.data, a2.w, a2.h);

// Hull overlay and the numbers the channel-packed-atlas skill quotes.
const hullImg = shaded.slice();
const line = (x0: number, y0: number, x1: number, y1: number, col: readonly number[]): void => {
  const n = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
  for (let k = 0; k <= n; k++) {
    const x = Math.round(x0 + ((x1 - x0) * k) / Math.max(1, n));
    const y = Math.round(y0 + ((y1 - y0) * k) / Math.max(1, n));
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const o = (yy * W + xx) * 4;
        for (let c = 0; c < 3; c++) hullImg[o + c] = col[c] as number;
      }
    }
  }
};
for (const c of def.chunks) {
  const ox = c.col * cw;
  const oy = c.row * ch;
  const polys: [number[] | undefined, number[], string][] = [[c.hull, [255, 70, 70], 'hull'], [c.opaqueHull, [80, 255, 110], 'core']];
  const stats: string[] = [];
  for (const [poly, col, name] of polys) {
    if (!poly) {
      stats.push(`${name} none`);
      continue;
    }
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      line(ox + (poly[i * 2] as number), oy + (poly[i * 2 + 1] as number), ox + (poly[j * 2] as number), oy + (poly[j * 2 + 1] as number), col);
    }
    const area = Math.abs(polygonArea(poly)) / (cw * ch);
    stats.push(`${name} ${n} pts / ${triangulate(poly).length / 3} tris / ${(area * 100).toFixed(1)}%`);
  }
  console.log(`chunk ${c.col},${c.row}: ${stats.join(', ')}`);
}
const h2 = downsample(hullImg, W, H, 2);
save(dir, 'plate-hulls.png', h2.data, h2.w, h2.h);

// Value ramp: plate texels vs the replaced kit layer's far-tree texels, both above the height mist.
const luma = (c: ArrayLike<number>): number => 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
const pct = (v: number[], p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))] as number;
const fmt = (v: number[]): string => {
  v.sort((a, b) => a - b);
  return `p10 ${pct(v, 0.1).toFixed(3)}  p50 ${pct(v, 0.5).toFixed(3)}  p90 ${pct(v, 0.9).toFixed(3)}  (${v.length} texels)`;
};
const mistRow = Math.floor(plan.look.baseline - 0.25 * plan.look.mistDepth);
const plateL: number[] = [];
const bandL: number[] = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x += 2) {
    const i = y * W + x;
    if ((img[i * 4 + 3] as number) < 250) continue;
    for (let c = 0; c < 3; c++) tex[c] = (img[i * 4 + c] as number) / 255;
    shadePlate(rgb, tex, params, 0);
    (y < mistRow ? plateL : bandL).push(luma(rgb));
  }
}
const kit = generateKit(kitSeed('forest-kit'));
const placement = { extent: { x0: 0, y0: 0, x1: 0, y1: 0 }, baselineY: 0, groundFillTop: null, instances: [] } as LayerPlacement;
const body = (id: string): number => {
  const l = base.layers.find((d) => d.id === id);
  if (!l || l.kind !== 'kit') return Number.NaN;
  const out = new Float32Array(4);
  shadeKit(out, [0.5, 0, 0, 1], 0.5, [0, 0, 0], -1e9, { ...kitShadeParams(l, RECIPES[l.recipe] as (typeof RECIPES)[string], placement), glow: 0 }, KIT_MODE.Core);
  return luma(out);
};
const replaced = base.layers[plan.index] as KitLayerDef;
const kp = { ...kitShadeParams(replaced, RECIPES[replaced.recipe] as (typeof RECIPES)[string], placement), glow: 0 };
const kitL: number[] = [];
const out = new Float32Array(4);
for (const el of kit.byCategory.farTree) {
  for (let y = 0; y < el.h; y++) {
    for (let x = 0; x < el.w; x += 2) {
      const o = ((el.y + y) * kit.width + el.x + x) * 4;
      if ((kit.pixels[o + 3] as number) < 250) continue;
      for (let c = 0; c < 4; c++) tex[c] = (kit.pixels[o + c] as number) / 255;
      shadeKit(out, tex, 0.5, [0, 0, 0], -1e9, kp, KIT_MODE.Core);
      kitL.push(luma(out));
    }
  }
}
const ids = base.layers.map((l) => l.id);
const prev = ids[plan.index - 1] as string;
const next = ids[plan.index + 1] as string;
console.log(`value ramp (shaded luma, opaque texels):`);
console.log(`  ${prev} neutral body ${body(prev).toFixed(3)}`);
console.log(`  ${REPLACES} far trees: ${fmt(kitL)}  (neutral body ${body(REPLACES).toFixed(3)})`);
console.log(`  ${def.id} above the mist: ${fmt(plateL)}`);
console.log(`  ${def.id} thicket / mist band: ${fmt(bandL)}`);
console.log(`  ${next} neutral body ${body(next).toFixed(3)}`);
