/**
 * Paint-over templates of an area's procedural layers (ARCHITECTURE.md §5.8):
 *
 *   npm run art:export -- glade                 every kit layer of the Hollow Glade → art/templates/glade/
 *   npm run art:export -- 0,2016                a world x range → art/templates/x0-2016/
 *   npm run art:export -- glade --f 0.2 --f 0.6 also empty slots at those parallax factors
 *   … [--scale 1.5] [--layers L3-misty-trunks,L4-mid-forest] [--out dir]
 *
 * Per layer: NN-<id>.png (the layer as the game draws it, plus guides), NN-<id>.layer.png,
 * NN-<id>.guides.png and NN-<id>.json, a sidecar stub that registers a painting made on that canvas.
 * Areas are the level's grade zones (glade, gully, rootwell, canopy, veil, shrine).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest } from '../../src/assets/manifest.ts';
import { PLATE_MIN_TEXEL_SCALE } from '../../src/assets/plateLayout.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { generateKit, kitSeed } from '../../src/render/gen/kit.ts';
import { scanPlates } from './bake.ts';
import { artPaths } from './paths.ts';
import { renderTemplates, resolveArea } from './templates.ts';

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const take = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = args.indexOf(flag); i >= 0; i = args.indexOf(flag)) {
      const v = args[i + 1];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      out.push(v);
      args.splice(i, 2);
    }
    return out;
  };
  const slots = take('--f').map(Number);
  const scaleArg = take('--scale')[0];
  const layers = take('--layers')[0]?.split(',');
  const outArg = take('--out')[0];
  if (args.length !== 1) {
    console.error('usage: npm run art:export -- <area | x0,x1> [--f <parallax> …] [--scale <u per px>] [--layers id,id] [--out dir]');
    return 2;
  }
  const scale = scaleArg === undefined ? PLATE_MIN_TEXEL_SCALE : Number(scaleArg);
  if (!(scale >= PLATE_MIN_TEXEL_SCALE)) throw new Error(`--scale must be ≥ ${PLATE_MIN_TEXEL_SCALE} (the smallest plate texelScale)`);
  for (const f of slots) if (!(f > 0 && f <= 4)) throw new Error(`--f ${f}: expected a parallax factor in (0, 4]`);
  const paths = artPaths();
  const level = parseLdtk(JSON.parse(readFileSync(paths.ldtk, 'utf8')));
  const manifest = parseManifest(JSON.parse(readFileSync(paths.base, 'utf8')));
  const area = resolveArea(level, args[0] as string);
  const t0 = performance.now();
  const kit = generateKit(kitSeed('forest-kit'));
  // Stubs keep clear of the depths the plates already in art/plates/ take.
  const { plates, errors } = await scanPlates(paths);
  for (const e of errors) console.warn(`warning: ${e}`);
  const taken = plates.map((p) => ({ id: p.id, parallax: p.sidecar.parallax }));
  const files = renderTemplates({ level, manifest, kit, area, scale, ...(layers ? { layers } : {}), slots, plates: taken });
  const dir = outArg ?? join(paths.templates, area.id);
  mkdirSync(dir, { recursive: true });
  for (const f of files) writeFileSync(join(dir, f.name), f.data);
  console.log(`${files.length} files for area ${area.id} (world x ${area.x0}…${area.x1}) in ${dir} (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
  for (const f of files) if (f.name.endsWith('.json')) console.log(`  ${f.name.replace(/\.json$/, '.png')} + ${f.name}`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`npm run art:export: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
