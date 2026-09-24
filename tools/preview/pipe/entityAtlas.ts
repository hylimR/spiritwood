/**
 * Dump the entity atlas (scaled up over the fog colour) for visual review, plus a sheet of the M2 parts
 * (spitter, seeds, launch marks, ability shrine) at 1× and 3× over the night backdrop.
 * Usage: node tools/preview/pipe/entityAtlas.ts [outDir]
 */
import { join } from 'node:path';
import { PALETTE } from '../../../src/config.ts';
import { buildEntityAtlas } from '../../../src/render/entities/entityAtlas.ts';
import { createImage, drawPremultiplied8, drawRgba8, gradientImage, hexToRgb, outDir, savePng } from './common.ts';

const dir = outDir();
const t0 = performance.now();
const atlas = buildEntityAtlas();
const ms = performance.now() - t0;
const scale = 2;
const bg = createImage(atlas.width * scale, atlas.height * scale, [...hexToRgb(PALETTE.fogFar), 1]);
if (atlas.premultiplied) drawPremultiplied8(bg, atlas.pixels, atlas.width, 0, 0, atlas.width, atlas.height, 0, 0, scale);
else drawRgba8(bg, atlas.pixels, atlas.width, atlas.height, 0, 0, scale);
savePng(bg, join(dir, 'entity-atlas.png'));

const parts = [
  'spitterRoots', 'spitterStem', 'spitterBulb', 'spitterBulbGlow', 'spitterLeaf', 'seedHostile', 'seedWisp', 'seedTrail',
  'seedEmber', 'anchorStalk', 'anchorPod', 'anchorRing', 'glowLight', 'launchRing', 'aimArrow', 'shrinePedestal', 'shrineGlyph', 'lanternSeed', 'lanternSeedLight',
];
const pad = 12;
let w = pad;
let h = 0;
for (const name of parts) {
  const f = atlas.frames[name];
  if (!f) throw new Error(`missing ${name}`);
  w += f.w * 3 + pad;
  h = Math.max(h, f.h * 3);
}
const sheet = gradientImage(w, h + 2 * pad + 160, hexToRgb(PALETTE.fogFar).map((v) => v * 0.6), hexToRgb(PALETTE.fogDeep));
let x = pad;
for (const name of parts) {
  const f = atlas.frames[name];
  if (!f) continue;
  drawPremultiplied8(sheet, atlas.pixels, atlas.width, f.x, f.y, f.w, f.h, x, pad, 3);
  drawPremultiplied8(sheet, atlas.pixels, atlas.width, f.x, f.y, f.w, f.h, x, h + 2 * pad, 1);
  x += f.w * 3 + pad;
}
savePng(sheet, join(dir, 'entity-parts-m2.png'));
console.log(`entity atlas ${atlas.width}×${atlas.height} in ${ms.toFixed(1)} ms, ${Object.keys(atlas.frames).length} frames → ${dir}`);
