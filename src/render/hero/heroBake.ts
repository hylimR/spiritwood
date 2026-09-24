import type { Atlas, AtlasFrame, Raster } from './atlas.ts';
import { partImageName } from './heroParts.ts';
import type { PartAttachment } from './heroRig.ts';
import type { Skeleton } from './rig.ts';

/**
 * CPU compositor for a posed rig (init-time ghost bake and browser-free previews). Mirrors what the
 * view does with sprites: part matrix = bone world × attachment × (1 / density) × (−pivot).
 */

/**
 * Affine [a, b, c, d, tx, ty] mapping part-texture pixels (relative to (pivotX, pivotY)) to rig space
 * for one attachment. Sprites pass pivot 0 and put the pivot in their anchor instead.
 */
export function partMatrix(
  skeleton: Skeleton, att: PartAttachment, density: number, pivotX: number, pivotY: number, out: Float64Array | Float32Array,
  extraSx = 1, extraSy = 1,
): Float64Array | Float32Array {
  const bi = skeleton.indexOf(att.bone) * 6;
  const w = skeleton.world;
  const ba = w[bi] as number;
  const bb = w[bi + 1] as number;
  const bc = w[bi + 2] as number;
  const bd = w[bi + 3] as number;
  const bx = w[bi + 4] as number;
  const by = w[bi + 5] as number;
  const cos = Math.cos(att.rotation);
  const sin = Math.sin(att.rotation);
  const sx = ((att.sx ?? 1) * extraSx) / density;
  const sy = ((att.sy ?? 1) * extraSy) / density;
  const la = cos * sx;
  const lb = sin * sx;
  const lc = -sin * sy;
  const ld = cos * sy;
  const lx = att.x - (la * pivotX + lc * pivotY);
  const ly = att.y - (lb * pivotX + ld * pivotY);
  out[0] = ba * la + bc * lb;
  out[1] = bb * la + bd * lb;
  out[2] = ba * lc + bc * ld;
  out[3] = bb * lc + bd * ld;
  out[4] = ba * lx + bc * ly + bx;
  out[5] = bb * lx + bd * ly + by;
  return out;
}

export interface ComposeOptions {
  /** Output pixels per world unit. */
  scale: number;
  /** Output pixel position of the rig origin (feet). */
  originX: number;
  originY: number;
  facingLeft: boolean;
  /** Parts to skip (by attachment id). */
  skip?: ReadonlySet<string>;
  /** Replace colour with white, keeping alpha (silhouettes). */
  silhouette?: boolean;
  /** Nearest instead of bilinear sampling. */
  nearest?: boolean;
}

function sample(atlas: Atlas, f: AtlasFrame, u: number, v: number, nearest: boolean, out: Float64Array): void {
  const px = atlas.pixels;
  const W = atlas.width;
  if (nearest) {
    const x = Math.floor(u);
    const y = Math.floor(v);
    if (x < 0 || y < 0 || x >= f.w || y >= f.h) {
      out[0] = out[1] = out[2] = out[3] = 0;
      return;
    }
    const o = ((f.y + y) * W + f.x + x) * 4;
    const a = (px[o + 3] as number) / 255;
    out[0] = ((px[o] as number) / 255) * a;
    out[1] = ((px[o + 1] as number) / 255) * a;
    out[2] = ((px[o + 2] as number) / 255) * a;
    out[3] = a;
    return;
  }
  const x = u - 0.5;
  const y = v - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i;
      const yy = y0 + j;
      if (xx < 0 || yy < 0 || xx >= f.w || yy >= f.h) continue;
      const wgt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const o = ((f.y + yy) * W + f.x + xx) * 4;
      const a = (px[o + 3] as number) / 255;
      out[0] += ((px[o] as number) / 255) * a * wgt;
      out[1] += ((px[o + 1] as number) / 255) * a * wgt;
      out[2] += ((px[o + 2] as number) / 255) * a * wgt;
      out[3] += a * wgt;
    }
  }
}

/**
 * Composite the evaluated skeleton's parts over `dst` (straight-alpha float raster), back to front.
 * `tints` optionally overrides per-attachment tint (0xRRGGBB).
 */
export function composePose(
  dst: Raster, atlas: Atlas, skeleton: Skeleton, parts: readonly PartAttachment[], opts: ComposeOptions,
): void {
  const m = new Float64Array(6);
  const s = new Float64Array(4);
  const { data, w: W, h: H } = dst;
  for (const att of parts) {
    if (opts.skip?.has(att.id)) continue;
    const frame = atlas.frames[partImageName(att.image, att.lit, opts.facingLeft)];
    if (!frame) throw new Error(`Missing atlas frame for ${att.image}`);
    partMatrix(skeleton, att, frame.density, frame.pivotX, frame.pivotY, m);
    const a = m[0] as number;
    const b = m[1] as number;
    const c = m[2] as number;
    const d = m[3] as number;
    const tx = m[4] as number;
    const ty = m[5] as number;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) continue;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [u, v] of [[0, 0], [frame.w, 0], [0, frame.h], [frame.w, frame.h]] as const) {
      const X = opts.originX + (a * u + c * v + tx) * opts.scale;
      const Y = opts.originY + (b * u + d * v + ty) * opts.scale;
      minX = Math.min(minX, X);
      minY = Math.min(minY, Y);
      maxX = Math.max(maxX, X);
      maxY = Math.max(maxY, Y);
    }
    const tr = ((att.tint >> 16) & 255) / 255;
    const tg = ((att.tint >> 8) & 255) / 255;
    const tb = (att.tint & 255) / 255;
    for (let py = Math.max(0, Math.floor(minY)); py < Math.min(H, Math.ceil(maxY)); py++) {
      for (let px = Math.max(0, Math.floor(minX)); px < Math.min(W, Math.ceil(maxX)); px++) {
        const rx = (px + 0.5 - opts.originX) / opts.scale - tx;
        const ry = (py + 0.5 - opts.originY) / opts.scale - ty;
        const u = (d * rx - c * ry) / det;
        const v = (-b * rx + a * ry) / det;
        if (u < -1 || v < -1 || u > frame.w + 1 || v > frame.h + 1) continue;
        sample(atlas, frame, u, v, opts.nearest ?? false, s);
        const sa = s[3] as number;
        if (sa <= 0) continue;
        const o = (py * W + px) * 4;
        const da = data[o + 3] as number;
        const outA = sa + da * (1 - sa);
        for (let k = 0; k < 3; k++) {
          const tint = k === 0 ? tr : k === 1 ? tg : tb;
          const src = opts.silhouette ? sa : (s[k] as number) * tint;
          const dstP = (data[o + k] as number) * da;
          data[o + k] = outA > 0 ? (src + dstP * (1 - sa)) / outA : 0;
        }
        data[o + 3] = outA;
      }
    }
  }
}
