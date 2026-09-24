/**
 * Plate layers for the CPU previews: decode the baked chunk files (WebP/PNG with sharp, KTX2 with the
 * libktx transcoder the game self-hosts, transcoded to RGBA32 so ETC1S block artefacts show), or
 * repaint the demo plate in memory with `tools/plates/paint.ts` (no encoding, for fast iteration).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { pathnameOf, plateTextureBorder } from '../../../src/assets/plateLayout.ts';
import type { LayerManifest, PlateLayerDef } from '../../../src/contracts/assets.ts';
import { CHUNK, planPlate, plateManifest, PLATE_SEED } from '../../plates/plan.ts';
import { chunkHulls, paintTreeline, type PlateImage } from '../../plates/paint.ts';
import { preparePlate, type PlateChunkImage, type PreparedPlate } from './compose.ts';

export type PlateFormat = 'ktx2' | 'webp' | 'png';

const LAYERS = new URL('../../../public/layers/', import.meta.url);

interface KtxTexture {
  baseWidth: number;
  baseHeight: number;
  transcodeBasis(target: unknown, flags: number): { value: number };
  getImageData(level: number, layer: number, face: number): Uint8Array;
  delete(): void;
}
interface LibKtx {
  ktxTexture: new (data: Uint8Array) => KtxTexture;
  TranscodeTarget: { RGBA32: unknown };
}

let ktxPromise: Promise<LibKtx> | null = null;

function libktx(): Promise<LibKtx> {
  if (!ktxPromise) {
    const dir = new URL('../../../node_modules/pixi.js/transcoders/ktx/', import.meta.url);
    const load = createRequire(import.meta.url)(fileURLToPath(new URL('libktx.js', dir))) as (o: object) => Promise<LibKtx>;
    ktxPromise = load({ wasmBinary: readFileSync(new URL('libktx.wasm', dir)) });
  }
  return ktxPromise;
}

/** Level 0 of a KTX2 (Basis) file as straight RGBA8. */
export async function decodeKtx2(bytes: Uint8Array): Promise<{ width: number; height: number; rgba: Uint8Array }> {
  const ktx = await libktx();
  const t = new ktx.ktxTexture(bytes);
  try {
    const r = t.transcodeBasis(ktx.TranscodeTarget.RGBA32, 0);
    if (r.value !== 0) throw new Error(`KTX2 transcode failed (${r.value})`);
    return { width: t.baseWidth, height: t.baseHeight, rgba: new Uint8Array(t.getImageData(0, 0, 0)) };
  } finally {
    t.delete();
  }
}

async function decodeFile(path: string, format: PlateFormat): Promise<{ rgba: Uint8Array; width: number; height: number }> {
  const bytes = new Uint8Array(readFileSync(path));
  if (format === 'ktx2') {
    const k = await decodeKtx2(bytes);
    return { rgba: k.rgba, width: k.width, height: k.height };
  }
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height };
}

/** The chunk's content (chunkSize) without the duplicated border the bake adds for filtering (§5.8). */
function cropBorder(def: PlateLayerDef, img: { rgba: Uint8Array; width: number; height: number }, path: string): Uint8Array {
  const border = plateTextureBorder(def, img.width, img.height);
  if (border === null) throw new Error(`${path}: ${img.width}×${img.height} does not fit chunkSize ${def.chunkSize.join('×')}`);
  if (border === 0) return img.rgba;
  const [w, h] = def.chunkSize;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const from = ((y + border) * img.width + border) * 4;
    out.set(img.rgba.subarray(from, from + w * 4), y * w * 4);
  }
  return out;
}

/** Decode every chunk of the manifest's plate layers in `format` (falling back like the loader). */
export async function loadBakedPlates(manifest: LayerManifest, format: PlateFormat): Promise<Map<string, PreparedPlate>> {
  const out = new Map<string, PreparedPlate>();
  for (const def of manifest.layers) {
    if (def.kind !== 'plate') continue;
    const chunks: PlateChunkImage[] = [];
    for (const c of def.chunks) {
      const f: PlateFormat = c.source[format] ? format : c.source.webp ? 'webp' : 'png';
      const rel = c.source[f];
      if (!rel) continue;
      const path = fileURLToPath(new URL(pathnameOf(rel), LAYERS));
      chunks.push({ col: c.col, row: c.row, rgba: cropBorder(def, await decodeFile(path, f), path), straight: f === 'ktx2' });
    }
    out.set(def.id, preparePlate(def, chunks));
  }
  return out;
}

/** Split a painted plate into chunk images with hulls (what the bake would write, unencoded). */
export function chunkPlate(img: PlateImage, def: PlateLayerDef): { def: PlateLayerDef; chunks: PlateChunkImage[] } {
  const chunks: PlateChunkImage[] = [];
  const defs: PlateLayerDef['chunks'] = [];
  for (let row = 0; row * CHUNK < img.height; row++) {
    for (let col = 0; col * CHUNK < img.width; col++) {
      const x0 = col * CHUNK;
      const y0 = row * CHUNK;
      const w = Math.min(CHUNK, img.width - x0);
      const h = Math.min(CHUNK, img.height - y0);
      const rgba = new Uint8Array(CHUNK * CHUNK * 4);
      for (let y = 0; y < h; y++) rgba.set(img.rgba.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * CHUNK * 4);
      const { hull, opaqueHull } = chunkHulls(img.rgba, img.width, x0, y0, w, h);
      if (!hull) continue;
      chunks.push({ col, row, rgba, straight: false });
      defs.push({ col, row, source: { png: `memory/${col}_${row}.png` }, hull, ...(opaqueHull ? { opaqueHull } : {}) });
    }
  }
  return { def: { ...def, chunks: defs }, chunks };
}

/** The plates manifest built in memory from `manifest`, with the demo plate freshly painted. */
export function paintedPlates(manifest: LayerManifest): { manifest: LayerManifest; plates: Map<string, PreparedPlate>; image: PlateImage; ms: number } {
  const plan = planPlate(manifest);
  const t0 = performance.now();
  const image = paintTreeline(plan.width, plan.height, PLATE_SEED, plan.look);
  const ms = performance.now() - t0;
  const { def, chunks } = chunkPlate(image, plan.layer);
  const out = plateManifest(manifest, plan, def.chunks);
  return { manifest: out, plates: new Map([[def.id, preparePlate(def, chunks)]]), image, ms };
}
