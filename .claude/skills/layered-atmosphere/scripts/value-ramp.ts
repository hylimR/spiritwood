/**
 * Print the aerial-perspective value ramp of a layer manifest with the real shading code
 * (`kitShadeParams` + `shadeKit`): for each kit layer, the shaded body colour (neutral texel, no rim),
 * the fully rim-lit colour, the colour once the height mist has fully risen (recipe mist colour), and
 * the body luma step between consecutive depth-tested layers (fx ≤ 1). Steps below `minStep` are
 * flagged. The default 0.015 (≈ 4 8-bit levels) is a heuristic, not a measured threshold: overlapping
 * planes can merge at larger steps too, so check the rendered scene.
 * Usage: node .claude/skills/layered-atmosphere/scripts/value-ramp.ts [manifest.json] [minStep]
 * (default manifest: public/layers/forest.manifest.json)
 */
import { readFileSync } from 'node:fs';
import { parseManifest } from '../../../../src/assets/manifest.ts';
import type { KitLayerDef } from '../../../../src/contracts/assets.ts';
import { kitShadeParams } from '../../../../src/render/layers/layerModel.ts';
import { KIT_MODE, shadeKit } from '../../../../src/render/layers/kitShading.ts';
import type { LayerPlacement } from '../../../../src/render/layers/placement.ts';
import { RECIPES } from '../../../../src/render/layers/recipes.ts';
import { depthForParallax } from '../../../../src/render/util/camera.ts';

const path = process.argv[2] ?? new URL('../../../../public/layers/forest.manifest.json', import.meta.url);
const minStep = Number(process.argv[3] ?? 0.015);
const manifest = parseManifest(JSON.parse(readFileSync(path, 'utf8')));

const luma = (c: ArrayLike<number>): number => 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
const hex = (c: ArrayLike<number>): string =>
  '#' + [0, 1, 2].map((i) => Math.round(Math.min(1, Math.max(0, c[i] as number)) * 255).toString(16).padStart(2, '0')).join('');

// Only baselineY is read by kitShadeParams; with baseline 0 the mist is off at y = −1e9 and full at y = 1e9.
const placement = { extent: { x0: 0, y0: 0, x1: 0, y1: 0 }, baselineY: 0, groundFillTop: null, instances: [] } as LayerPlacement;
const out = new Float32Array(4);
const rows: { id: string; f: number; body: number }[] = [];
for (const l of manifest.layers) {
  if (l.kind !== 'kit') continue;
  const def = l as KitLayerDef;
  const recipe = RECIPES[def.recipe];
  if (!recipe) throw new Error(`${def.id}: unknown recipe ${def.recipe}`);
  const p = { ...kitShadeParams(def, recipe, placement), glow: 0 };
  const f = def.parallax[0];
  shadeKit(out, [0.5, 0, 0, 1], 0.5, [0, 0, 0], -1e9, p, KIT_MODE.Core);
  const body = luma(out);
  const bodyHex = hex(out);
  shadeKit(out, [0.5, 1, 0, 1], 0.5, [0, 0, 0], -1e9, p, KIT_MODE.Core);
  const rimHex = hex(out);
  const rim = luma(out);
  shadeKit(out, [0.5, 0, 0, 1], 0.5, [0, 0, 0], 1e9, p, KIT_MODE.Core);
  const mistHex = hex(out);
  rows.push({ id: def.id, f, body });
  const depth = f <= 1 ? `depth ${depthForParallax(f).toFixed(3)}` : 'no depth   ';
  console.log(
    `${def.id.padEnd(22)} f ${f.toFixed(2)}  ${depth}  body ${bodyHex} (L ${body.toFixed(3)})` +
      `  rim ${rimHex} (L ${rim.toFixed(3)})  mist ${mistHex} (L ${luma(out).toFixed(3)})`,
  );
}
const depthTested = rows.filter((r) => r.f <= 1);
for (let i = 1; i < depthTested.length; i++) {
  const a = depthTested[i - 1] as (typeof rows)[number];
  const b = depthTested[i] as (typeof rows)[number];
  const step = a.body - b.body;
  const flag = step < minStep ? '  <-- below minStep: check these planes where they overlap' : '';
  console.log(`${a.id} -> ${b.id}: body luma step ${step.toFixed(3)}${flag}`);
}
