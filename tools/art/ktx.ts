/**
 * Decode KTX2 (Basis ETC1S) chunks on the CPU with the libktx transcoder the game self-hosts, mip level
 * by mip level, and measure how well two neighbouring chunks agree at their seam: what the GPU samples
 * on either side of it at mip 0 and mip 1 (ARCHITECTURE.md §5.8, KIT_MAX_MIP = 1).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

interface KtxTexture {
  baseWidth: number;
  baseHeight: number;
  numLevels: number;
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
    const dir = new URL('../../node_modules/pixi.js/transcoders/ktx/', import.meta.url);
    const load = createRequire(import.meta.url)(fileURLToPath(new URL('libktx.js', dir))) as (o: object) => Promise<LibKtx>;
    ktxPromise = load({ wasmBinary: readFileSync(new URL('libktx.wasm', dir)) });
  }
  return ktxPromise;
}

export interface MipLevel {
  width: number;
  height: number;
  /** Straight RGBA8, as transcoded. */
  rgba: Uint8Array;
}

/** The first `levels` mip levels of a KTX2 file as straight RGBA8. */
export async function decodeKtx2Mips(bytes: Uint8Array, levels: number): Promise<MipLevel[]> {
  const ktx = await libktx();
  const t = new ktx.ktxTexture(bytes);
  try {
    const r = t.transcodeBasis(ktx.TranscodeTarget.RGBA32, 0);
    if (r.value !== 0) throw new Error(`KTX2 transcode failed (${r.value})`);
    const out: MipLevel[] = [];
    for (let l = 0; l < Math.min(levels, t.numLevels); l++) {
      out.push({ width: Math.max(1, t.baseWidth >> l), height: Math.max(1, t.baseHeight >> l), rgba: new Uint8Array(t.getImageData(l, 0, 0)) });
    }
    return out;
  } finally {
    t.delete();
  }
}

export interface SeamStats {
  /** Largest and mean absolute difference (0–255) of premultiplied RGBA across the seam, per channel max. */
  max: number;
  mean: number;
  /** Rows (of that mip level) where the difference is 16 or more. */
  rows16: number;
}

/**
 * What a bilinear sample at the seam gives on each side, for chunks `a` (left) and `b` (right) of one
 * row, at one mip level: `a` sampled at its content's right edge, `b` at its content's left edge
 * (`border` texels in from the texture edge at mip 0). Differences are of premultiplied colour and alpha,
 * so the colour under transparent texels does not count.
 */
export function seamStats(a: MipLevel, b: MipLevel, border: number, mip: number): SeamStats {
  const w = a.width;
  // Content edges in this level's texel coordinates; the sample sits between two texels (or on one).
  const ea = (a.width * (1 << mip) - border) / (1 << mip);
  const eb = border / (1 << mip);
  const sample = (m: MipLevel, x: number, y: number, c: number): number => {
    const x0 = Math.floor(x - 0.5);
    const f = x - 0.5 - x0;
    const at = (xx: number): number => {
      const cx = Math.min(m.width - 1, Math.max(0, xx));
      const o = (y * m.width + cx) * 4;
      const alpha = (m.rgba[o + 3] as number) / 255;
      return c === 3 ? (m.rgba[o + 3] as number) : (m.rgba[o + c] as number) * alpha;
    };
    return at(x0) * (1 - f) + at(x0 + 1) * f;
  };
  let max = 0;
  let sum = 0;
  let n = 0;
  let rows16 = 0;
  const y0 = Math.ceil(border / (1 << mip));
  const y1 = a.height - y0;
  for (let y = y0; y < y1; y++) {
    let rowMax = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(sample(a, ea, y, c) - sample(b, eb, y, c));
      rowMax = Math.max(rowMax, d);
      sum += d;
      n++;
    }
    max = Math.max(max, rowMax);
    if (rowMax >= 16) rows16++;
  }
  void w;
  return { max, mean: n > 0 ? sum / n : 0, rows16 };
}
