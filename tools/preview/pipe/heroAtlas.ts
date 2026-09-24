/**
 * Dump the hero part atlas (over a dark and a checker background, scaled up) for visual review.
 * Usage: node tools/preview/pipe/heroAtlas.ts [outDir]
 */
import { join } from 'node:path';
import { PALETTE } from '../../../src/config.ts';
import { buildHeroAssets } from '../../../src/render/hero/heroAssets.ts';
import { createImage, drawRgba8, hexToRgb, outDir, savePng } from './common.ts';

const dir = outDir();
const t0 = performance.now();
const atlas = buildHeroAssets();
const ms = performance.now() - t0;
const scale = 2;
const bg = createImage(atlas.width * scale, atlas.height * scale, [...hexToRgb(PALETTE.fogDeep), 1]);
drawRgba8(bg, atlas.pixels, atlas.width, atlas.height, 0, 0, scale);
savePng(bg, join(dir, 'hero-atlas.png'));
console.log(`hero atlas ${atlas.width}×${atlas.height} in ${ms.toFixed(1)} ms, ${Object.keys(atlas.frames).length} frames → ${dir}`);
