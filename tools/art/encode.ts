/**
 * Chunk encoders (ARCHITECTURE.md §5.8): WebP (the default path), a palette PNG (fallback) and KTX2
 * ETC1S with mipmaps (≈ 4 s per 1024² chunk). Settings are the M1 demo plate's, measured there.
 */
import { encodeToKTX2 } from 'ktx2-encoder';
import sharp, { type Sharp } from 'sharp';

export type ChunkFormat = 'ktx2' | 'webp' | 'png';
export const CHUNK_FORMATS: readonly ChunkFormat[] = ['ktx2', 'webp', 'png'];

/** Encoders by format; injectable so tests can count calls (a `--check` must never encode). */
export type Encoders = Record<ChunkFormat, (rgba: Uint8Array, w: number, h: number) => Promise<Uint8Array>>;

function raw(rgba: Uint8Array, w: number, h: number): Sharp {
  return sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: w, height: h, channels: 4 } });
}

export async function encodeWebp(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  return new Uint8Array(await raw(rgba, w, h).webp({ quality: 84, alphaQuality: 90, effort: 6 }).toBuffer());
}

export async function encodePalettePng(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  return new Uint8Array(await raw(rgba, w, h).png({ palette: true, quality: 90, effort: 10, dither: 0.6, compressionLevel: 9 }).toBuffer());
}

async function imageDecoder(buffer: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

/**
 * The Basis encoder (Emscripten) prints its per-slice log through a `console.log` it binds when the
 * module starts. Binding it to this pass-through first lets the bake keep that log out of the report.
 */
let quiet = false;
let hooked = false;
function hookEncoderLog(): void {
  if (hooked) return;
  hooked = true;
  const log = console.log.bind(console);
  console.log = (...args: unknown[]): void => {
    if (!quiet) log(...args);
  };
}

export async function encodeKtx2(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const lossless = await raw(rgba, w, h).png({ compressionLevel: 6 }).toBuffer();
  hookEncoderLog();
  quiet = true;
  try {
    return await encodeToKTX2(new Uint8Array(lossless), {
      imageDecoder, isUASTC: false, generateMipmap: true, qualityLevel: 160, isKTX2File: true,
      isPerceptual: true, isSetKTX2SRGBTransferFunc: true,
    });
  } finally {
    quiet = false;
  }
}

export const ENCODERS: Encoders = { ktx2: encodeKtx2, webp: encodeWebp, png: encodePalettePng };
