/**
 * Cut a plate into chunk textures (ARCHITECTURE.md §5.8): PLATE_TEXTURE² texels each, PLATE_CONTENT²
 * of content plus a PLATE_BORDER-texel border duplicated from the neighbours, colour dilated into transparent
 * texels, hashed, and split into opaque-core and soft rects (computeSplitHullHalf).
 */
import { createHash } from 'node:crypto';
import { PLATE_BORDER, PLATE_CONTENT, PLATE_TEXTURE } from '../../src/assets/plateLayout.ts';
import { computeSplitHullHalf, type HullOptions } from '../../src/render/gen/hull.ts';
import { KIT_MAX_MIP } from '../../src/render/gen/kit.ts';
import type { RgbaSource } from './source.ts';

/**
 * Split-hull settings for plate chunks. The plate program clamps its LOD to KIT_MAX_MIP like the kit
 * (KTX2 chunks are mipmapped), so the same insets apply: the soft rects reach 2^maxMip texels past
 * every visible texel and the core stays 1 + 2^maxMip texels inside the opaque region.
 */
export const PLATE_HULL: HullOptions = {
  cell: 8,
  maxSpans: 4,
  coreInset: 1 + (1 << KIT_MAX_MIP),
  pad: 1 << KIT_MAX_MIP,
  visibleThreshold: 1,
  opaqueThreshold: 254,
  minCore: 8,
  minGap: 6,
  snap: 2,
};

/** Transparent texels take the colour of a covered texel at most this many texels away. */
export const DILATE_REACH = 8;

export interface ChunkResult {
  col: number;
  row: number;
  /** PLATE_TEXTURE² straight RGBA8, as encoded. */
  rgba: Uint8Array;
  /** Pixel hash (16 hex digits of SHA-256 over `rgba`). */
  hash: string;
  /** Opaque-core and soft rects [x, y, w, h, …] in content texels. */
  core: number[];
  soft: number[];
  /** Content texels with alpha > 1. */
  visible: number;
}

export function chunkGrid(width: number, height: number): { cols: number; rows: number } {
  return { cols: Math.ceil(width / PLATE_CONTENT), rows: Math.ceil(height / PLATE_CONTENT) };
}

export function pixelHash(rgba: Uint8Array): string {
  return createHash('sha256').update(rgba).digest('hex').slice(0, 16);
}

/**
 * Give every texel with alpha 0 the colour of the nearest covered texel along its row, then its column
 * (within `reach`), else the alpha-weighted mean colour of the chunk. KTX2 chunks are filtered with
 * straight alpha, and block compression sees these texels too, so edges keep their colour instead of
 * bleeding toward black. Alpha is untouched.
 */
export function dilateColour(rgba: Uint8Array, w: number, h: number, reach = DILATE_REACH): void {
  const n = w * h;
  const src = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(reach + 1);
  let mr = 0;
  let mg = 0;
  let mb = 0;
  let ma = 0;
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] as number;
    if (a === 0) continue;
    src[i] = i;
    dist[i] = 0;
    mr += (rgba[i * 4] as number) * a;
    mg += (rgba[i * 4 + 1] as number) * a;
    mb += (rgba[i * 4 + 2] as number) * a;
    ma += a;
  }
  if (ma === 0) return;
  for (let y = 0; y < h; y++) {
    for (let pass = 0; pass < 2; pass++) {
      let last = -1;
      for (let j = 0; j < w; j++) {
        const x = pass === 0 ? j : w - 1 - j;
        const i = y * w + x;
        if ((dist[i] as number) === 0) last = x;
        else if (last >= 0 && Math.abs(x - last) < (dist[i] as number)) {
          dist[i] = Math.abs(x - last);
          src[i] = y * w + last;
        }
      }
    }
  }
  // Columns propagate the row results (a texel reached along its row seeds its column).
  const d2 = dist.slice();
  const s2 = src.slice();
  for (let x = 0; x < w; x++) {
    for (let pass = 0; pass < 2; pass++) {
      let last = -1;
      let lastD = 0;
      for (let j = 0; j < h; j++) {
        const y = pass === 0 ? j : h - 1 - j;
        const i = y * w + x;
        const d = dist[i] as number;
        if (d <= reach && (last < 0 || d <= lastD + Math.abs(y - last))) {
          last = y;
          lastD = d;
        } else if (last >= 0) {
          const nd = lastD + Math.abs(y - last);
          if (nd < (d2[i] as number)) {
            d2[i] = nd;
            s2[i] = src[last * w + x] as number;
          }
        }
      }
    }
  }
  const fr = Math.round(mr / ma);
  const fg = Math.round(mg / ma);
  const fb = Math.round(mb / ma);
  for (let i = 0; i < n; i++) {
    if ((rgba[i * 4 + 3] as number) !== 0) continue;
    const s = (d2[i] as number) <= reach ? (s2[i] as number) : -1;
    const o = i * 4;
    if (s >= 0) {
      rgba[o] = rgba[s * 4] as number;
      rgba[o + 1] = rgba[s * 4 + 1] as number;
      rgba[o + 2] = rgba[s * 4 + 2] as number;
    } else {
      rgba[o] = fr;
      rgba[o + 1] = fg;
      rgba[o + 2] = fb;
    }
  }
}

/** Core and soft rects of a chunk texture, converted to content texels [x, y, w, h]. */
export function chunkRects(rgba: Uint8Array, options: HullOptions = PLATE_HULL): { core: number[]; soft: number[] } {
  const T = PLATE_TEXTURE;
  const alpha = new Uint8Array(T * T);
  for (let i = 0; i < T * T; i++) alpha[i] = rgba[i * 4 + 3] as number;
  const hull = computeSplitHullHalf(alpha, T, T, options);
  const convert = (r: readonly number[]): number[] => {
    const out: number[] = [];
    for (let i = 0; i < r.length; i += 4) {
      const x0 = Math.max(0, (r[i] as number) - PLATE_BORDER);
      const y0 = Math.max(0, (r[i + 1] as number) - PLATE_BORDER);
      const x1 = Math.min(PLATE_CONTENT, (r[i + 2] as number) - PLATE_BORDER);
      const y1 = Math.min(PLATE_CONTENT, (r[i + 3] as number) - PLATE_BORDER);
      if (x1 > x0 && y1 > y0) out.push(x0, y0, x1 - x0, y1 - y0);
    }
    return out;
  };
  return { core: convert(hull.core), soft: convert(hull.soft) };
}

/**
 * The texture of chunk (col, row): texel (tx, ty) is source texel (col·C + tx − 1, row·C + ty − 1),
 * transparent outside the image. `strip` holds source rows [stripY0, stripY0 + stripRows).
 */
export function chunkTexture(strip: Uint8Array, stripY0: number, stripRows: number, srcW: number, col: number, row: number): Uint8Array {
  const T = PLATE_TEXTURE;
  const out = new Uint8Array(T * T * 4);
  const sx0 = col * PLATE_CONTENT - PLATE_BORDER;
  const sy0 = row * PLATE_CONTENT - PLATE_BORDER;
  const xa = Math.max(0, -sx0);
  const xb = Math.min(T, srcW - sx0);
  if (xb <= xa) return out;
  for (let ty = 0; ty < T; ty++) {
    const sy = sy0 + ty - stripY0;
    if (sy < 0 || sy >= stripRows) continue;
    const from = (sy * srcW + sx0 + xa) * 4;
    out.set(strip.subarray(from, from + (xb - xa) * 4), (ty * T + xa) * 4);
  }
  return out;
}

/** Number of content texels (the inner PLATE_CONTENT² region) with alpha > 1. */
export function visibleContent(rgba: Uint8Array): number {
  const T = PLATE_TEXTURE;
  let n = 0;
  for (let y = PLATE_BORDER; y < T - PLATE_BORDER; y++) {
    for (let x = PLATE_BORDER; x < T - PLATE_BORDER; x++) if ((rgba[(y * T + x) * 4 + 3] as number) > 1) n++;
  }
  return n;
}

/**
 * Every non-empty chunk of `src`, row by row (one strip read per chunk row). Empty chunks (no content
 * texel with alpha > 1) are skipped: they are neither encoded nor listed.
 */
export async function* chunkSource(src: RgbaSource): AsyncGenerator<ChunkResult> {
  const { cols, rows } = chunkGrid(src.width, src.height);
  for (let row = 0; row < rows; row++) {
    const y0 = Math.max(0, row * PLATE_CONTENT - PLATE_BORDER);
    const y1 = Math.min(src.height, row * PLATE_CONTENT - PLATE_BORDER + PLATE_TEXTURE);
    const strip = await src.readRows(y0, y1 - y0);
    for (let col = 0; col < cols; col++) {
      const rgba = chunkTexture(strip, y0, y1 - y0, src.width, col, row);
      const visible = visibleContent(rgba);
      if (visible === 0) continue;
      dilateColour(rgba, PLATE_TEXTURE, PLATE_TEXTURE);
      const { core, soft } = chunkRects(rgba);
      yield { col, row, rgba, hash: pixelHash(rgba), core, soft, visible };
    }
  }
}
