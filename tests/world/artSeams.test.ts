import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { PLATE_BORDER, PLATE_CONTENT, PLATE_TEXTURE } from '../../src/assets/plateLayout.ts';
import { parseManifest } from '../../src/assets/manifest.ts';
import type { PlateLayerDef } from '../../src/contracts/assets.ts';
import { chunkSource, type ChunkResult } from '../../tools/art/chunks.ts';
import { decodeKtx2Mips, seamStats, type MipLevel } from '../../tools/art/ktx.ts';
import { memorySource } from '../../tools/art/source.ts';

const T = PLATE_TEXTURE;
const LAYERS = new URL('../../public/layers/', import.meta.url);

/**
 * basisu builds KTX2 mip 1 with a Kaiser filter that reads mip-0 texel centres less than 3.5 texels from
 * a mip-1 texel's centre (measured: a 4-texel opaque column reaches mip-1 texel 2 and, wrapping around,
 * texel 511, but not texel 3) and wraps at the texture edge. This model has the same reach and wrap.
 */
const REACH = 3;
const WEIGHTS = [1, 0.45, 0.08];

function mip1(tex: Uint8Array): Float32Array {
  const h = T / 2;
  const tmp = new Float32Array(h * T * 4);
  const out = new Float32Array(h * h * 4);
  const norm = 2 * (WEIGHTS[0] as number) + 2 * (WEIGHTS[1] as number) + 2 * (WEIGHTS[2] as number);
  // Horizontal, then vertical; texel k's centre is mip-0 coordinate 2k + 1, taps at ±0.5, ±1.5, ±2.5.
  for (let y = 0; y < T; y++) {
    for (let k = 0; k < h; k++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let d = -REACH; d < REACH; d++) {
          const x = (((2 * k + 1 + d) % T) + T) % T;
          s += (tex[(y * T + x) * 4 + c] as number) * (WEIGHTS[d < 0 ? -d - 1 : d] as number);
        }
        tmp[(y * h + k) * 4 + c] = s / norm;
      }
    }
  }
  for (let k = 0; k < h; k++) {
    for (let x = 0; x < h; x++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let d = -REACH; d < REACH; d++) {
          const y = (((2 * k + 1 + d) % T) + T) % T;
          s += (tmp[(y * h + x) * 4 + c] as number) * (WEIGHTS[d < 0 ? -d - 1 : d] as number);
        }
        out[(k * h + x) * 4 + c] = s / norm;
      }
    }
  }
  return out;
}

/** Chunk `col` of row 0 with a `border`-texel duplicated border (what chunkSource does with PLATE_BORDER). */
function cut(img: Uint8Array, w: number, h: number, col: number, border: number): Uint8Array {
  const c = T - 2 * border;
  const out = new Uint8Array(T * T * 4);
  for (let ty = 0; ty < T; ty++) {
    const sy = ty - border;
    if (sy < 0 || sy >= h) continue;
    for (let tx = 0; tx < T; tx++) {
      const sx = col * c + tx - border;
      if (sx < 0 || sx >= w) continue;
      out.set(img.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (ty * T + tx) * 4);
    }
  }
  return out;
}

/** Largest difference of what bilinear filtering of mip 1 gives either side of the seam, over the content rows. */
function mip1Seam(a: Float32Array, b: Float32Array, border: number): number {
  const h = T / 2;
  const ea = (T - border) / 2;
  const eb = border / 2;
  const sample = (m: Float32Array, x: number, y: number, c: number): number => {
    const x0 = Math.floor(x - 0.5);
    const f = x - 0.5 - x0;
    return (m[(y * h + x0) * 4 + c] as number) * (1 - f) + (m[(y * h + x0 + 1) * 4 + c] as number) * f;
  };
  let max = 0;
  for (let y = Math.ceil(border / 2); y < h - Math.ceil(border / 2); y++) {
    for (let c = 0; c < 4; c++) max = Math.max(max, Math.abs(sample(a, ea, y, c) - sample(b, eb, y, c)));
  }
  return max;
}

/** Blobs of every alpha crossing the seam between chunks 0 and 1. */
function blobs(w: number, h: number): Uint8Array {
  const img = new Uint8Array(w * h * 4);
  let seed = 11;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) >>> 0;
    return seed / 4294967296;
  };
  const spots = Array.from({ length: 60 }, () => [PLATE_CONTENT - 40 + rnd() * 80, rnd() * h, 2 + rnd() * 14, rnd()] as const);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (const [cx, cy, r, v] of spots) a = Math.max(a, Math.min(1, Math.max(0, (r - Math.hypot(x - cx, y - cy)) / 2)) * (0.3 + 0.7 * v));
      const o = (y * w + x) * 4;
      img[o] = 40 + (x % 97);
      img[o + 1] = 80 + (y % 61);
      img[o + 2] = 140;
      img[o + 3] = Math.round(a * 255);
    }
  }
  return img;
}

describe('KTX2 mip 1 across chunk seams', () => {
  test(`a ${PLATE_BORDER}-texel border gives both chunks the same mip-1 texels at the seam (a 1-texel border does not)`, async () => {
    const W = PLATE_CONTENT * 2;
    const H = 200;
    const img = blobs(W, H);
    // The production cutter makes exactly these textures.
    const chunks: ChunkResult[] = [];
    for await (const c of chunkSource(memorySource(W, H, img))) chunks.push(c);
    const [a, b] = chunks as [ChunkResult, ChunkResult];
    const alphaOf = (t: Uint8Array): number[] => Array.from({ length: t.length / 4 }, (_, i) => t[i * 4 + 3] as number);
    expect(alphaOf(a.rgba)).toEqual(alphaOf(cut(img, W, H, 0, PLATE_BORDER)));
    expect(alphaOf(b.rgba)).toEqual(alphaOf(cut(img, W, H, 1, PLATE_BORDER)));
    // Transparent texels carry dilated colour in the real chunks; compare the model on the cut textures.
    expect(PLATE_BORDER).toBeGreaterThanOrEqual(REACH + 1);
    expect(PLATE_BORDER % 2).toBe(0);
    expect(mip1Seam(mip1(cut(img, W, H, 0, PLATE_BORDER)), mip1(cut(img, W, H, 1, PLATE_BORDER)), PLATE_BORDER)).toBeLessThan(1e-3);
    // With a 1-texel border each chunk's mip 1 at the seam mixes in its own opposite edge (the wrap).
    const c1 = T - 2;
    const w1 = c1 * 2;
    const img1 = blobs(w1, H);
    expect(mip1Seam(mip1(cut(img1, w1, H, 0, 1)), mip1(cut(img1, w1, H, 1, 1)), 1)).toBeGreaterThan(8);
  }, 60_000);

  test('the shipped demo plate: mip-1 seams agree as well as mip 0 does (only ETC1S coding noise is left)', async () => {
    const m = parseManifest(JSON.parse(readFileSync(new URL('forest.plates.manifest.json', LAYERS), 'utf8')));
    const plate = m.layers.find((l): l is PlateLayerDef => l.kind === 'plate') as PlateLayerDef;
    const row = plate.chunks.filter((c) => c.row === 0).sort((x, y) => x.col - y.col);
    expect(row.length).toBeGreaterThanOrEqual(2);
    const mips: MipLevel[][] = [];
    for (const c of row) mips.push(await decodeKtx2Mips(new Uint8Array(readFileSync(new URL((c.source.ktx2 as string).split('?')[0] as string, LAYERS))), 2));
    for (let i = 0; i + 1 < mips.length; i++) {
      const a = mips[i] as MipLevel[];
      const b = mips[i + 1] as MipLevel[];
      const m0 = seamStats(a[0] as MipLevel, b[0] as MipLevel, PLATE_BORDER, 0);
      const m1 = seamStats(a[1] as MipLevel, b[1] as MipLevel, PLATE_BORDER, 1);
      // With the old 1-texel border 5–13 % of the mip-1 seam rows stepped by 16/255 or more (mean 1.1–2.0).
      const rows = (T - 2 * PLATE_BORDER) / 2;
      expect(m1.rows16 / rows, `seam ${i}|${i + 1}`).toBeLessThanOrEqual(0.02);
      expect(m1.mean, `seam ${i}|${i + 1}`).toBeLessThan(0.8);
      expect(m0.rows16 / (T - 2 * PLATE_BORDER), `seam ${i}|${i + 1}`).toBeLessThanOrEqual(0.02);
    }
  }, 60_000);
});
