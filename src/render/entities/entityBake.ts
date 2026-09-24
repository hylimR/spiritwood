import { PALETTE } from '../../config.ts';
import { coverage } from '../gen/sdf.ts';
import { Noise } from '../gen/noise.ts';
import { createRaster, mix3, rgb, smoothstep, type AtlasImage } from '../hero/atlas.ts';

/**
 * Shared CPU bake helpers for the entity atlas (init time only; allocation is fine): SDF shapes shaded
 * per texel into straight-alpha images, premultiplied "light" images whose colour may exceed alpha
 * (emissive texels that add under premultiplied normal blending), radial images, and the moonlit stone
 * shader. Moonlight comes from the upper left.
 */

/** Direction toward the moon (upper left), world space. */
export const LIGHT = Object.freeze({ x: -0.6, y: -0.8 });

export type Sdf = (x: number, y: number) => number;
export type Shade = (x: number, y: number, d: number, nx: number, ny: number, out: number[]) => number;

export interface ImageSpec {
  name: string;
  /** Part-space bounds (u); pivot at the origin. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  density: number;
  sdf: Sdf;
  /** Writes rgb into `out`, returns an alpha multiplier (1 = coverage only). */
  shade: Shade;
  /** AA width in texels. */
  aa?: number;
  /** Normals are only evaluated within this distance (u) of the edge; deeper texels face the viewer. */
  normalBand?: number;
}

/** Straight-alpha SDF image. */
export function bake(spec: ImageSpec): AtlasImage {
  const { x0, y0, x1, y1, density } = spec;
  const w = Math.ceil((x1 - x0) * density);
  const h = Math.ceil((y1 - y0) * density);
  const raster = createRaster(w, h);
  const eps = 0.5 / density;
  const aa = (spec.aa ?? 1.15) / density;
  const band = spec.normalBand ?? Infinity;
  const c = [0, 0, 0];
  const { data } = raster;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = x0 + (px + 0.5) / density;
      const y = y0 + (py + 0.5) / density;
      const d = spec.sdf(x, y);
      const cov = coverage(d, aa);
      if (cov <= 0) continue;
      let gx = 0;
      let gy = 0;
      if (-d < band) {
        gx = spec.sdf(x + eps, y) - spec.sdf(x - eps, y);
        gy = spec.sdf(x, y + eps) - spec.sdf(x, y - eps);
        const gl = Math.hypot(gx, gy) || 1;
        gx /= gl;
        gy /= gl;
      }
      const a = spec.shade(x, y, d, gx, gy, c);
      const o = (py * w + px) * 4;
      data[o] = c[0] as number;
      data[o + 1] = c[1] as number;
      data[o + 2] = c[2] as number;
      data[o + 3] = cov * a;
    }
  }
  return { name: spec.name, raster, pivotX: -x0 * density, pivotY: -y0 * density, density };
}

export interface LightSpec {
  name: string;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  density: number;
  /**
   * Premultiplied texel at part-space (x, y): out = [r, g, b, a] with rgb = colour·a + emission, so rgb may
   * exceed a (a = 0 with rgb > 0 is pure light).
   */
  texel: (x: number, y: number, out: number[]) => void;
  /** Supersamples per axis (default 1). */
  ss?: number;
}

/** Premultiplied image (body colour plus emission); needs a premultiplied atlas. */
export function bakeLight(spec: LightSpec): AtlasImage {
  const { x0, y0, x1, y1, density } = spec;
  const w = Math.ceil((x1 - x0) * density);
  const h = Math.ceil((y1 - y0) * density);
  const raster = createRaster(w, h);
  const ss = Math.max(1, spec.ss ?? 1);
  const t = [0, 0, 0, 0];
  const { data } = raster;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          spec.texel(x0 + (px + (sx + 0.5) / ss) / density, y0 + (py + (sy + 0.5) / ss) / density, t);
          r += t[0] as number;
          g += t[1] as number;
          b += t[2] as number;
          a += t[3] as number;
        }
      }
      const n = ss * ss;
      const o = (py * w + px) * 4;
      data[o] = Math.min(1, r / n);
      data[o + 1] = Math.min(1, g / n);
      data[o + 2] = Math.min(1, b / n);
      data[o + 3] = Math.min(1, a / n);
    }
  }
  return { name: spec.name, raster, pivotX: -x0 * density, pivotY: -y0 * density, density, premultiplied: true };
}

/** Radial image: alpha = f(r) with r = 0 at the centre and 1 at the edge; colour white unless given. */
export function radial(name: string, size: number, fn: (r: number) => number, color: readonly number[] = [1, 1, 1]): AtlasImage {
  const raster = createRaster(size, size);
  const { data } = raster;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 - 1;
      const y = ((py + 0.5) / size) * 2 - 1;
      const r = Math.min(1, Math.hypot(x, y));
      const o = (py * size + px) * 4;
      data[o] = color[0] as number;
      data[o + 1] = color[1] as number;
      data[o + 2] = color[2] as number;
      data[o + 3] = r >= 1 ? 0 : fn(r);
    }
  }
  return { name, raster, pivotX: size / 2, pivotY: size / 2, density: size / 2 };
}

/** Unit SDF gradient at (x, y) into out[0..1] (central differences, step `eps`). */
export function sdfNormal(sdf: Sdf, x: number, y: number, eps: number, out: number[]): void {
  const gx = sdf(x + eps, y) - sdf(x - eps, y);
  const gy = sdf(x, y + eps) - sdf(x, y - eps);
  const gl = Math.hypot(gx, gy) || 1;
  out[0] = gx / gl;
  out[1] = gy / gl;
}

export const entityNoise = new Noise(0x57a1);

/** Dark stone with a pillow normal, moonlight rim, grain and cracks. */
export function stoneShade(thickness: number, moss: (x: number, y: number) => number): Shade {
  const noise = entityNoise;
  const base = [0.055, 0.085, 0.115];
  const lit = [0.17, 0.25, 0.3];
  const rimC = [0.46, 0.64, 0.72];
  const mossDark = [0.07, 0.19, 0.17];
  const mossLit = [0.2, 0.42, 0.36];
  const glow = rgb(PALETTE.floraGlow);
  const L3 = Math.hypot(LIGHT.x * 0.8, LIGHT.y * 0.8, 0.6);
  return (x, y, d, nx, ny, out) => {
    const e = 1 - Math.min(1, Math.max(0, -d / thickness));
    const nz = Math.sqrt(Math.max(0, 1 - e * e));
    const diff = Math.max(0, (nx * e * LIGHT.x * 0.8 + ny * e * LIGHT.y * 0.8 + nz * 0.6) / L3);
    const grain = noise.fbm(x * 0.35, y * 0.35, 4) * 0.5 + 0.5;
    const crack = smoothstep(0.86, 0.97, noise.ridged(x * 0.09 + 3.1, y * 0.09 - 1.7, 3));
    let c = mix3(base, lit, Math.pow(diff, 1.6) * (0.75 + 0.5 * grain));
    const facing = Math.max(0, nx * LIGHT.x + ny * LIGHT.y);
    c = mix3(c, rimC, smoothstep(0.72, 0.98, e) * Math.pow(facing, 1.4) * 0.8);
    c = mix3(c, [0.02, 0.03, 0.045], crack * 0.7);
    const m = moss(x, y);
    if (m > 0) {
      const tuft = noise.fbm(x * 0.45 + 11, y * 0.45 - 7, 3) * 0.5 + 0.5;
      let mc = mix3(mossDark, mossLit, diff * (0.5 + 0.7 * tuft));
      const speck = smoothstep(0.78, 0.84, noise.noise2(x * 0.55 + 31, y * 0.55 - 17) * 0.5 + 0.5);
      mc = mix3(mc, glow, speck * 0.35 * diff);
      c = mix3(c, mc, m);
    }
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
    return 1;
  };
}
