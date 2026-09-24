/**
 * Bake the demo painted plate (ARCHITECTURE.md §5.8): CPU-paint a misty treeline, split it into
 * 1024² chunks, write PNG (palette), WebP and KTX2 (ETC1S, mipmapped) per chunk with tight hull /
 * opaque-hull polygons into public/layers/plates/, and write public/layers/forest.plates.manifest.json
 * (the normal manifest with the far kit layer L3 replaced by the plate layer).
 *
 * Usage: node tools/plates/bake-plates.ts
 * Painted or AI-generated plates go through the same chunking/encoding path (see `bakeImage`).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { encodeToKTX2 } from 'ktx2-encoder';
import { parseManifest } from '../../src/assets/manifest.ts';
import type { KitLayerDef, LayerManifest, PlateChunkDef, PlateLayerDef } from '../../src/contracts/assets.ts';
import { coverageExtent } from '../../src/render/layers/placement.ts';
import { chunkHulls, paintTreeline, type PlateImage } from './paint.ts';

const ROOT = new URL('../../', import.meta.url);
const LAYERS_DIR = fileURLToPath(new URL('public/layers/', ROOT));
const PLATES_DIR = fileURLToPath(new URL('public/layers/plates/', ROOT));
const CHUNK = 1024;
const TEXEL_SCALE = 1.5;
/** Level size the plate must cover (the M1 forest: 200 × 50 tiles of 48 u). */
const LEVEL_W = 9600;
const LEVEL_H = 2400;
/** The far kit layer the demo plate replaces. */
const REPLACES = 'L3-misty-trunks';
const PLATE_ID = 'L3-plate-treeline';

async function imageDecoder(buffer: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/** Chunk an RGBA image and write every encoding; returns the manifest chunk entries. */
async function bakeImage(img: PlateImage, name: string): Promise<PlateChunkDef[]> {
  const cols = Math.ceil(img.width / CHUNK);
  const rows = Math.ceil(img.height / CHUNK);
  const chunks: PlateChunkDef[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = col * CHUNK;
      const y0 = row * CHUNK;
      const w = Math.min(CHUNK, img.width - x0);
      const h = Math.min(CHUNK, img.height - y0);
      const raw = Buffer.alloc(CHUNK * CHUNK * 4);
      let any = false;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const s = ((y0 + y) * img.width + x0 + x) * 4;
          const d = (y * CHUNK + x) * 4;
          for (let c = 0; c < 4; c++) raw[d + c] = img.rgba[s + c] as number;
          if ((img.rgba[s + 3] as number) > 1) any = true;
        }
      }
      if (!any) continue;
      const base = `${name}_${col}_${row}`;
      const input = sharp(raw, { raw: { width: CHUNK, height: CHUNK, channels: 4 } });
      const png = await input.clone().png({ palette: true, quality: 90, effort: 10, dither: 0.6, compressionLevel: 9 }).toBuffer();
      const webp = await input.clone().webp({ quality: 84, alphaQuality: 90, effort: 6 }).toBuffer();
      const lossless = await input.clone().png({ compressionLevel: 6 }).toBuffer();
      const ktx2 = await encodeToKTX2(new Uint8Array(lossless), {
        imageDecoder, isUASTC: false, generateMipmap: true, qualityLevel: 160, isKTX2File: true,
        isPerceptual: true, isSetKTX2SRGBTransferFunc: true,
      });
      writeFileSync(`${PLATES_DIR}${base}.png`, png);
      writeFileSync(`${PLATES_DIR}${base}.webp`, webp);
      writeFileSync(`${PLATES_DIR}${base}.ktx2`, ktx2);
      const { hull, opaqueHull } = chunkHulls(img.rgba, img.width, x0, y0, w, h);
      const entry: PlateChunkDef = {
        col, row,
        source: { ktx2: `plates/${base}.ktx2`, webp: `plates/${base}.webp`, png: `plates/${base}.png` },
      };
      if (hull) entry.hull = hull;
      if (opaqueHull) entry.opaqueHull = opaqueHull;
      chunks.push(entry);
      console.log(`${base}: png ${(png.length / 1024).toFixed(0)} KB, webp ${(webp.length / 1024).toFixed(0)} KB, ktx2 ${(ktx2.length / 1024).toFixed(0)} KB, hull ${(hull?.length ?? 0) / 2} pts, core ${(opaqueHull?.length ?? 0) / 2} pts`);
    }
  }
  return chunks;
}

async function main(): Promise<void> {
  mkdirSync(PLATES_DIR, { recursive: true });
  const manifestPath = `${LAYERS_DIR}forest.manifest.json`;
  const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
  const idx = manifest.layers.findIndex((l) => l.id === REPLACES);
  const replaced = manifest.layers[idx];
  if (!replaced || replaced.kind !== 'kit') throw new Error(`manifest has no kit layer ${REPLACES}`);
  const kit: KitLayerDef = replaced;
  const [fx, fy] = kit.parallax;
  const ext = coverageExtent(LEVEL_W, LEVEL_H, fx, fy);
  const texW = Math.ceil((ext.x1 - ext.x0 + 64) / TEXEL_SCALE / CHUNK) * CHUNK;
  const texH = Math.ceil((ext.y1 - ext.y0) / TEXEL_SCALE / CHUNK) * CHUNK;
  console.log(`painting ${texW}×${texH} texels (texelScale ${TEXEL_SCALE}) for ${REPLACES} (f ${fx})`);
  const t0 = performance.now();
  const img = paintTreeline(texW, texH, 4242);
  console.log(`painted in ${(performance.now() - t0).toFixed(0)} ms`);
  const chunks = await bakeImage(img, PLATE_ID);

  const plate: PlateLayerDef = {
    id: PLATE_ID,
    kind: 'plate',
    parallax: [fx, fy],
    minQuality: kit.minQuality,
    tint: '#ffffff',
    fog: 0.22,
    fogColor: kit.fogColor,
    desaturate: 0.1,
    origin: [Math.floor(ext.x0 - 32), Math.floor(ext.y0)],
    chunkSize: [CHUNK, CHUNK],
    texelScale: TEXEL_SCALE,
    chunks,
  };
  const out: LayerManifest = { ...manifest, layers: manifest.layers.map((l, i) => (i === idx ? plate : l)) };
  parseManifest(out);
  const outPath = `${LAYERS_DIR}forest.plates.manifest.json`;
  writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  let total = 0;
  for (const c of chunks) for (const p of Object.values(c.source)) total += statSync(`${LAYERS_DIR}${p}`).size;
  console.log(`wrote ${outPath}; plate assets ${(total / 1024 / 1024).toFixed(2)} MB`);
  if (total > 3 * 1024 * 1024) throw new Error('demo plate assets exceed 3 MB');
}

await main();
