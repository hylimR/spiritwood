/**
 * The painterly pass in numbers: per kit layer (L1–L8, F1, F2), the brush strokes' change of final
 * pre-grade luma and of the layer's mean value (strokeStats.ts), at mip 0 and at mip 1 (where the GPU
 * minifies: far layers, low render scale), and the cold bake time of the plain and the painted atlas.
 *
 *   node tools/preview/world/stroke-report.ts [outDir]   (writes stroke-report.md and .json there)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest } from '../../../src/assets/manifest.ts';
import { generateKit, kitSeed } from '../../../src/render/gen/kit.ts';
import { ELEMENT_SPECS } from '../../../src/render/gen/kitElements.ts';
import { outDir } from './common.ts';
import { layerStrokeStats, mip1Atlas, strokeStatsTable } from './strokeStats.ts';

const dir = outDir();
const manifest = parseManifest(JSON.parse(readFileSync(new URL('../../../public/layers/forest.manifest.json', import.meta.url), 'utf8')));
const plain = ELEMENT_SPECS.map((s) => ({ ...s, finalize: { ...s.finalize, strokes: null } }));
const seed = kitSeed('forest-kit');
let t0 = performance.now();
const after = generateKit(seed);
const msAfter = performance.now() - t0;
t0 = performance.now();
const before = generateKit(seed, undefined, undefined, plain);
const msBefore = performance.now() - t0;
const stats = layerStrokeStats(manifest, before, after);
const mip1 = layerStrokeStats(manifest, mip1Atlas(before), mip1Atlas(after));
const md = `${strokeStatsTable(stats)}\n\nAt mip 1 (the premultiplied 2×2 average the GPU samples when it minifies):\n\n${strokeStatsTable(mip1)}\n\n`
  + `(bake in this process: painted ${msAfter.toFixed(0)} ms cold, plain ${msBefore.toFixed(0)} ms warm; see the brief's cold A/B for the budget)\n`;
console.log(md);
writeFileSync(join(dir, 'stroke-report.md'), md);
writeFileSync(join(dir, 'stroke-report.json'), JSON.stringify({ mip0: stats, mip1 }, null, 2));
console.log(`wrote ${join(dir, 'stroke-report.md')}`);
