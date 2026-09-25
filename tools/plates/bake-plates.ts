/**
 * Bake the demo painted plate (ARCHITECTURE.md §5.8): CPU-paint a misty treeline over the replaced far
 * layer's extent (the level size comes from public/levels/forest.ldtk), cut it into bordered 1024² chunks
 * with split-hull rects and pixel hashes (tools/art/chunks.ts, the same path painted plates take),
 * encode WebP + PNG + KTX2 for chunks whose pixels changed, and write
 * public/layers/forest.plates.manifest.json: the hand-edited base manifest with L3 replaced by the plate
 * (open with `?manifest=plates`).
 *
 * Usage: node tools/plates/bake-plates.ts   (npm run plates)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseManifest } from '../../src/assets/manifest.ts';
import { hash8, PLATE_TEXTURE } from '../../src/assets/plateLayout.ts';
import type { PlateChunkDef } from '../../src/contracts/assets.ts';
import { measureAtlases } from '../art/atlases.ts';
import { ART_TOOL_VERSION, fileHash } from '../art/bake.ts';
import { budgetLayer, defaultSweep, formatBudgetReport, sweepBudget } from '../art/budget.ts';
import { chunkSource } from '../art/chunks.ts';
import { CHUNK_FORMATS, ENCODERS, type ChunkFormat } from '../art/encode.ts';
import { formatJson } from '../art/json.ts';
import { artPaths, chunkFile, parseChunkFile } from '../art/paths.ts';
import { memorySource } from '../art/source.ts';
import { paintTreeline } from './paint.ts';
import { forestLevelSize, planPlate, PLATE_ID, PLATE_SEED, plateManifest, REPLACES, TEXEL_SCALE } from './plan.ts';

/** What the last demo bake wrote: reused only by the same tool version, with files unchanged. */
interface DemoLock {
  tool: string;
  chunks: { col: number; row: number; hash: string; files: Partial<Record<ChunkFormat, string>> }[];
}

function readDemoLock(path: string): DemoLock | null {
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8')) as DemoLock;
    return lock.tool === ART_TOOL_VERSION && Array.isArray(lock.chunks) ? lock : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const tStart = performance.now();
  const paths = artPaths();
  const out = paths.demo;
  const lockPath = join(paths.root, 'art/demo-plate.lock.json');
  mkdirSync(paths.chunks, { recursive: true });
  const base = parseManifest(JSON.parse(readFileSync(paths.base, 'utf8')));
  const level = forestLevelSize(paths.ldtk);
  const plan = planPlate(base, level);
  const [fx] = plan.layer.parallax;
  console.log(`painting ${plan.width}×${plan.height} texels (texelScale ${TEXEL_SCALE}) for ${REPLACES} (f ${fx}), level ${level.width}×${level.height}`);
  const t0 = performance.now();
  const img = paintTreeline(plan.width, plan.height, PLATE_SEED, plan.look);
  console.log(`painted in ${(performance.now() - t0).toFixed(0)} ms`);

  // Chunks whose pixels and files match the last bake by this tool version keep their files.
  const previous = readDemoLock(lockPath);
  const lock: DemoLock = { tool: ART_TOOL_VERSION, chunks: [] };
  const chunks: PlateChunkDef[] = [];
  let encoded = 0;
  for await (const c of chunkSource(memorySource(img.width, img.height, img.rgba))) {
    const prev = previous?.chunks.find((p) => p.col === c.col && p.row === c.row && p.hash === c.hash);
    const fresh = prev !== undefined && CHUNK_FORMATS.every((f) => {
      const file = join(paths.layers, chunkFile(PLATE_ID, c.col, c.row, f));
      return existsSync(file) && fileHash(readFileSync(file)) === prev.files[f];
    });
    const files: Partial<Record<ChunkFormat, string>> = fresh && prev ? { ...prev.files } : {};
    if (!fresh) {
      const t = performance.now();
      const sizes: string[] = [];
      for (const f of CHUNK_FORMATS) {
        const bytes = await ENCODERS[f](c.rgba, PLATE_TEXTURE, PLATE_TEXTURE);
        writeFileSync(join(paths.layers, chunkFile(PLATE_ID, c.col, c.row, f)), bytes);
        files[f] = fileHash(bytes);
        sizes.push(`${f} ${(bytes.length / 1024).toFixed(0)} KB`);
      }
      encoded++;
      console.log(`${PLATE_ID} chunk ${c.col},${c.row}: ${sizes.join(', ')}, ${c.core.length / 4} core + ${c.soft.length / 4} soft rects, encoded in ${((performance.now() - t) / 1000).toFixed(1)} s`);
    }
    const v = `?v=${hash8(c.hash)}`;
    chunks.push({
      col: c.col, row: c.row,
      source: {
        ktx2: `${chunkFile(PLATE_ID, c.col, c.row, 'ktx2')}${v}`, webp: `${chunkFile(PLATE_ID, c.col, c.row, 'webp')}${v}`,
        png: `${chunkFile(PLATE_ID, c.col, c.row, 'png')}${v}`,
      },
      core: c.core, soft: c.soft, hash: c.hash,
    });
    lock.chunks.push({ col: c.col, row: c.row, hash: c.hash, files });
  }
  for (const name of readdirSync(paths.chunks)) {
    const f = parseChunkFile(name);
    if (f?.id === PLATE_ID && !chunks.some((c) => c.col === f.col && c.row === f.row)) {
      rmSync(join(paths.chunks, name));
      console.log(`removed stale ${name}`);
    }
  }
  const manifest = plateManifest(base, plan, chunks);
  parseManifest(JSON.parse(JSON.stringify(manifest)));
  const plate = manifest.layers.find((l) => l.id === PLATE_ID);
  if (plate?.kind !== 'plate') throw new Error('the splice lost the plate layer');
  const report = sweepBudget([budgetLayer(plate)], base.textureBudgetMB, measureAtlases(base), defaultSweep(level.width, level.height));
  console.log(formatBudgetReport(report));
  if (report.errors.length) throw new Error('the demo plate does not fit the texture budget');
  writeFileSync(out, formatJson(manifest));
  writeFileSync(lockPath, formatJson(lock));
  let total = 0;
  for (const c of chunks) for (const p of Object.values(c.source)) total += statSync(join(paths.layers, p.split('?')[0] as string)).size;
  console.log(`wrote ${out}; ${chunks.length} chunks (${encoded} encoded), plate assets ${(total / 1024 / 1024).toFixed(2)} MB; baked in ${((performance.now() - tStart) / 1000).toFixed(1)} s`);
  if (total > 4 * 1024 * 1024) throw new Error('demo plate assets exceed 4 MB');
}

await main();
