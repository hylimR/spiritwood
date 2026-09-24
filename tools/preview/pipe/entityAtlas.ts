/**
 * Dump the entity atlas (scaled up over the fog colour) for visual review.
 * Usage: node tools/preview/pipe/entityAtlas.ts [outDir]
 */
import { join } from 'node:path';
import { PALETTE } from '../../../src/config.ts';
import { buildEntityAtlas } from '../../../src/render/entities/entityAtlas.ts';
import { createImage, drawRgba8, hexToRgb, outDir, savePng } from './common.ts';

const dir = outDir();
const t0 = performance.now();
const atlas = buildEntityAtlas();
const ms = performance.now() - t0;
const scale = 2;
const bg = createImage(atlas.width * scale, atlas.height * scale, [...hexToRgb(PALETTE.fogFar), 1]);
drawRgba8(bg, atlas.pixels, atlas.width, atlas.height, 0, 0, scale);
savePng(bg, join(dir, 'entity-atlas.png'));
console.log(`entity atlas ${atlas.width}×${atlas.height} in ${ms.toFixed(1)} ms, ${Object.keys(atlas.frames).length} frames → ${dir}`);
