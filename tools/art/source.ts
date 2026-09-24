/**
 * Plate sources: validate an artist's PNG without decoding it (sharp metadata), and read it in
 * horizontal strips with `extract()` so nothing ever holds the whole decoded image (ARCHITECTURE.md
 * §5.8: up to 16384 px a side, `limitInputPixels: false`).
 */
import sharp, { type Metadata } from 'sharp';
import { PLATE_MAX_SOURCE } from '../../src/assets/plateLayout.ts';

/** Straight RGBA8 pixels, read a band of rows at a time. */
export interface RgbaSource {
  readonly width: number;
  readonly height: number;
  /** Rows [y0, y0 + rows) as tightly packed straight RGBA8 (width · rows · 4 bytes). */
  readRows(y0: number, rows: number): Promise<Uint8Array>;
}

export class SourceError extends Error {
  override name = 'SourceError';
}

/** An in-memory image (CPU-painted plates, tests). */
export function memorySource(width: number, height: number, rgba: Uint8Array): RgbaSource {
  if (rgba.length !== width * height * 4) throw new SourceError(`memory source: expected ${width * height * 4} bytes, got ${rgba.length}`);
  return {
    width,
    height,
    readRows: (y0, rows) => Promise.resolve(rgba.subarray(y0 * width * 4, (y0 + rows) * width * 4)),
  };
}

/** Description of an embedded ICC profile ('desc' tag, v2 text or v4 mluc), or null. */
export function iccDescription(icc: Uint8Array): string | null {
  if (icc.length < 132) return null;
  const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength);
  const n = view.getUint32(128);
  for (let i = 0; i < n && 132 + i * 12 + 12 <= icc.length; i++) {
    const o = 132 + i * 12;
    const sig = String.fromCharCode(icc[o] as number, icc[o + 1] as number, icc[o + 2] as number, icc[o + 3] as number);
    if (sig !== 'desc') continue;
    const off = view.getUint32(o + 4);
    const size = view.getUint32(o + 8);
    if (off + size > icc.length || size < 12) return null;
    const type = String.fromCharCode(icc[off] as number, icc[off + 1] as number, icc[off + 2] as number, icc[off + 3] as number);
    if (type === 'desc') {
      const len = view.getUint32(off + 8);
      let s = '';
      for (let k = 0; k < len && off + 12 + k < off + size; k++) {
        const c = icc[off + 12 + k] as number;
        if (c === 0) break;
        s += String.fromCharCode(c);
      }
      return s;
    }
    if (type === 'mluc') {
      const records = view.getUint32(off + 8);
      if (records < 1) return null;
      const len = view.getUint32(off + 20);
      const start = off + view.getUint32(off + 24);
      let s = '';
      for (let k = 0; k + 1 < len && start + k + 1 < icc.length; k += 2) s += String.fromCharCode(view.getUint16(start + k));
      return s;
    }
    return null;
  }
  return null;
}

export interface SourceInfo {
  width: number;
  height: number;
}

/**
 * Check that `path` is what the pipeline expects: a PNG, 8 bits per channel, RGB(A) with an alpha
 * channel (straight alpha), sRGB (no profile, or an sRGB one), at most PLATE_MAX_SOURCE a side.
 * Reads only the header.
 */
export async function inspectPng(path: string, file: string): Promise<SourceInfo> {
  const fail = (msg: string): never => {
    throw new SourceError(`${file}: ${msg}`);
  };
  let m: Metadata;
  try {
    m = await sharp(path, { limitInputPixels: false }).metadata();
  } catch (e) {
    return fail(`cannot read the image (${e instanceof Error ? e.message : String(e)})`);
  }
  if (m.format !== 'png') fail(`is a ${m.format ?? 'unknown'} file; export PNG (sRGB, 8-bit RGBA, straight alpha)`);
  const w = m.width ?? 0;
  const h = m.height ?? 0;
  if (w < 1 || h < 1) fail('has no pixels');
  if (w > PLATE_MAX_SOURCE || h > PLATE_MAX_SOURCE) fail(`is ${w}×${h}; plates are at most ${PLATE_MAX_SOURCE} px a side. Split it into two plates or raise texelScale`);
  if (m.depth !== 'uchar') fail(`has ${m.bitsPerSample ?? '?'}-bit channels; export 8 bits per channel`);
  if (m.space === 'b-w' || m.channels === 1 || m.channels === 2) fail('is greyscale; export RGBA');
  if (m.space !== 'srgb') fail(`is in colour space "${m.space}"; export sRGB`);
  if (!m.hasAlpha || m.channels !== 4) fail('has no alpha channel; export RGBA with straight (unpremultiplied) alpha, transparent where the layers behind should show');
  if (m.hasProfile && m.icc) {
    const desc = iccDescription(m.icc);
    if (!desc || !/srgb/i.test(desc)) fail(`embeds the colour profile "${desc ?? 'unknown'}", not sRGB; convert to sRGB when exporting`);
  }
  return { width: w, height: h };
}

/** A PNG read in strips: each readRows is one `extract()` of a full-width band. */
export function pngSource(path: string, info: SourceInfo): RgbaSource {
  return {
    width: info.width,
    height: info.height,
    async readRows(y0, rows) {
      const { data, info: out } = await sharp(path, { limitInputPixels: false })
        .extract({ left: 0, top: y0, width: info.width, height: rows })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      if (out.channels !== 4 || out.width !== info.width || out.height !== rows) {
        throw new SourceError(`${path}: unexpected decode ${out.width}×${out.height}×${out.channels}`);
      }
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    },
  };
}
