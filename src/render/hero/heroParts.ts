import { PALETTE } from '../../config.ts';
import { coverage, sdCircle, sdEllipse, sdTaperedCapsule, smin } from '../gen/sdf.ts';
import { createRaster, mix3, packAtlas, rgb, smoothstep, type Atlas, type AtlasImage, type Raster } from './atlas.ts';
import { HERO_BONES, HERO_PARTS } from './heroRig.ts';

/**
 * CPU-generated part atlas for the spirit child: every body part is an SDF shaded as a soft luminous
 * volume (pillow normal, cool deep tone → spirit-glow → near-white), with a baked rim band that is
 * strongest toward the moonlight (upper left). Lit parts are baked twice: `@R` for facing right and
 * `@L` (light mirrored) for the mirrored rig facing left, so the rim always stays on the moon side.
 */

/** Texels per world unit for body parts (drawn at ~1–1.5 px/u, so mipmaps do the minification). */
export const HERO_DENSITY = 3;
/** Transparent border around every image (≥ 2^mip levels actually sampled). */
export const HERO_GUTTER = 6;
export const HERO_ATLAS_WIDTH = 512;
/** Moonlight direction (toward the light), world space, facing right. */
export const HERO_LIGHT = Object.freeze({ x: -0.6, y: -0.8 });
/** Spirit-light halo radius (world units) and texture size. */
export const HALO_RADIUS = 260;
const HALO_TEXELS = 96;

const BODY_DEEP = [0.47, 0.79, 0.93] as const;
const BODY_MID = rgb(PALETTE.spiritGlow);
const BODY_LIGHT = [0.93, 1, 1] as const;
const RIM = [1, 1, 1] as const;
const SPROUT_DEEP = [0.3, 0.72, 0.62] as const;
const SPROUT_MID = [0.58, 0.95, 0.84] as const;
const SPROUT_LIGHT = [0.88, 1, 0.95] as const;

interface Palette3 {
  deep: readonly number[];
  mid: readonly number[];
  light: readonly number[];
}

const BODY: Palette3 = { deep: BODY_DEEP, mid: BODY_MID, light: BODY_LIGHT };
const SPROUT: Palette3 = { deep: SPROUT_DEEP, mid: SPROUT_MID, light: SPROUT_LIGHT };

interface LitShape {
  name: string;
  /** Part-space bounds (u); the pivot is the origin. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sdf: (x: number, y: number) => number;
  /** Depth (u) over which the pillow normal turns from the edge to face the viewer. */
  thickness: number;
  palette: Palette3;
  /** Optional extra detail (0..1 darkening) such as a leaf's midrib. */
  detail?: (x: number, y: number) => number;
}

function vesica(x: number, y: number, ax: number, ay: number, bx: number, by: number, halfWidth: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  const ux = dx / len;
  const uy = dy / len;
  const cx = (ax + bx) / 2;
  const cy = (ay + by) / 2;
  const h = len / 2;
  const r = (halfWidth * halfWidth + h * h) / (2 * halfWidth);
  const off = r - halfWidth;
  const nx = -uy * off;
  const ny = ux * off;
  return Math.max(Math.hypot(x - (cx + nx), y - (cy + ny)) - r, Math.hypot(x - (cx - nx), y - (cy - ny)) - r);
}

const LEAF_TIP = { x: 3.1, y: -3.4 };

export const HERO_SHAPES: readonly LitShape[] = [
  {
    name: 'head', x0: -13.5, y0: -25, x1: 15, y1: 1.5, thickness: 8, palette: BODY,
    sdf: (x, y) => smin(sdEllipse(x, y, 0.6, -11.4, 12.3, 11.2), sdCircle(x, y, 4.2, -7.2, 7.4), 3.5),
  },
  {
    name: 'torso', x0: -7.5, y0: -8, x1: 18, y1: 8.5, thickness: 4.5, palette: BODY,
    sdf: (x, y) => smin(sdTaperedCapsule(x, y, 0.8, 0, 13.4, 0, 6, 3.3), sdCircle(x, y, 4.4, 0.9, 5.6), 2.4),
  },
  {
    name: 'upperArm', x0: -2.6, y0: -2.6, x1: 9.2, y1: 2.6, thickness: 1.5, palette: BODY,
    sdf: (x, y) => sdTaperedCapsule(x, y, 0, 0, 7, 0, 2.05, 1.65),
  },
  {
    name: 'foreArm', x0: -2.2, y0: -2.2, x1: 7.9, y1: 2.2, thickness: 1.3, palette: BODY,
    sdf: (x, y) => sdTaperedCapsule(x, y, 0, 0, 6, 0, 1.65, 1.4),
  },
  {
    name: 'hand', x0: -1.8, y0: -2.9, x1: 4.3, y1: 2.9, thickness: 1.6, palette: BODY,
    sdf: (x, y) => sdEllipse(x, y, 1.2, 0, 2.3, 2),
  },
  {
    name: 'thigh', x0: -3.4, y0: -3.4, x1: 11.8, y1: 3.4, thickness: 1.8, palette: BODY,
    sdf: (x, y) => sdTaperedCapsule(x, y, 0, 0, 9, 0, 2.75, 2.15),
  },
  {
    name: 'shin', x0: -2.8, y0: -2.8, x1: 10.5, y1: 2.8, thickness: 1.5, palette: BODY,
    sdf: (x, y) => sdTaperedCapsule(x, y, 0, 0, 8.2, 0, 2.15, 1.7),
  },
  {
    name: 'foot', x0: -3, y0: -3.4, x1: 6.2, y1: 2.2, thickness: 1.5, palette: BODY,
    sdf: (x, y) => smin(sdEllipse(x, y, 1.5, -0.55, 3.7, 1.9), sdCircle(x, y, 0, -1.4, 1.6), 1.2),
  },
  {
    name: 'stemA', x0: -1.4, y0: -1.4, x1: 6.2, y1: 1.4, thickness: 0.6, palette: SPROUT,
    sdf: (x, y) => sdTaperedCapsule(x, y, 0, 0, 4.8, 0, 0.9, 0.7),
  },
  {
    name: 'stemB', x0: -1.2, y0: -1.2, x1: 5.8, y1: 1.2, thickness: 0.5, palette: SPROUT,
    sdf: (x, y) => sdTaperedCapsule(x, y, 0, 0, 4.6, 0, 0.7, 0.55),
  },
  {
    name: 'leaf', x0: -1.2, y0: -5, x1: 4.6, y1: 1.2, thickness: 1, palette: SPROUT,
    sdf: (x, y) => vesica(x, y, 0, 0, LEAF_TIP.x, LEAF_TIP.y, 1.15),
    detail: (x, y) => {
      const t = Math.max(0, Math.min(1, (x * LEAF_TIP.x + y * LEAF_TIP.y) / (LEAF_TIP.x ** 2 + LEAF_TIP.y ** 2)));
      const d = Math.hypot(x - LEAF_TIP.x * t, y - LEAF_TIP.y * t);
      return (1 - smoothstep(0.05, 0.3, d)) * 0.28 * (1 - t);
    },
  },
];

/** World rest angle of each lit shape's frame (for lighting), from the rig. */
function restAngle(image: string): number {
  const att = HERO_PARTS.find((p) => p.image === image);
  if (!att) throw new Error(`No attachment uses ${image}`);
  const bone = HERO_BONES.find((b) => b.name === att.bone);
  if (!bone) throw new Error(`Unknown bone ${att.bone}`);
  return bone.angle + att.rotation;
}

function rasterFor(x0: number, y0: number, x1: number, y1: number, density: number): { raster: Raster; pivotX: number; pivotY: number } {
  const w = Math.ceil((x1 - x0) * density);
  const h = Math.ceil((y1 - y0) * density);
  return { raster: createRaster(w, h), pivotX: -x0 * density, pivotY: -y0 * density };
}

/** Bake one lit shape with the light at world direction (lx, ly). */
export function bakeLitShape(shape: LitShape, lightX: number, lightY: number, density = HERO_DENSITY): AtlasImage & { raster: Raster } {
  const { raster, pivotX, pivotY } = rasterFor(shape.x0, shape.y0, shape.x1, shape.y1, density);
  const a = restAngle(shape.name);
  const cos = Math.cos(-a);
  const sin = Math.sin(-a);
  const lx = lightX * cos - lightY * sin;
  const ly = lightX * sin + lightY * cos;
  const l3 = Math.hypot(lx * 0.8, ly * 0.8, 0.6);
  const Lx = (lx * 0.8) / l3;
  const Ly = (ly * 0.8) / l3;
  const Lz = 0.6 / l3;
  const eps = 0.5 / density;
  const aa = 1.15 / density;
  const { w, h, data } = raster;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = shape.x0 + (px + 0.5) / density;
      const y = shape.y0 + (py + 0.5) / density;
      const d = shape.sdf(x, y);
      const cov = coverage(d, aa);
      if (cov <= 0) continue;
      let gx = shape.sdf(x + eps, y) - shape.sdf(x - eps, y);
      let gy = shape.sdf(x, y + eps) - shape.sdf(x, y - eps);
      const gl = Math.hypot(gx, gy) || 1;
      gx /= gl;
      gy /= gl;
      const e = 1 - Math.min(1, Math.max(0, -d / shape.thickness));
      const nz = Math.sqrt(Math.max(0, 1 - e * e));
      const diff = 0.28 + 0.72 * Math.max(0, gx * e * Lx + gy * e * Ly + nz * Lz);
      const p = shape.palette;
      let c = diff < 0.55 ? mix3(p.deep, p.mid, diff / 0.55) : mix3(p.mid, p.light, (diff - 0.55) / 0.45);
      const facing = Math.max(0, gx * lx + gy * ly);
      const rim = smoothstep(0.6, 0.97, e) * (0.06 + 0.94 * Math.pow(facing, 1.3));
      c = mix3(c, RIM, rim * 0.9);
      if (shape.detail) {
        const k = 1 - shape.detail(x, y);
        c = [c[0] * k, c[1] * k, c[2] * k];
      }
      const o = (py * w + px) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = cov;
    }
  }
  return { name: shape.name, raster, pivotX, pivotY, density };
}

/** Dark teal eye with a bright glint (upright, pivot at the eye centre). */
function bakeEye(density: number): AtlasImage {
  const rx = 1.7;
  const ry = 2.3;
  const { raster, pivotX, pivotY } = rasterFor(-2.5, -3, 2.5, 3, density);
  const top = [0.02, 0.12, 0.16];
  const bottom = [0.07, 0.3, 0.34];
  const { w, h, data } = raster;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = -2.5 + (px + 0.5) / density;
      const y = -3 + (py + 0.5) / density;
      const d = sdEllipse(x, y, 0, 0, rx, ry);
      const cov = coverage(d, 1 / density);
      if (cov <= 0) continue;
      let c = mix3(top, bottom, smoothstep(-ry, ry * 0.9, y));
      const g1 = coverage(sdCircle(x, y, -0.45, -0.8, 0.55), 0.9 / density);
      const g2 = coverage(sdCircle(x, y, 0.55, 0.85, 0.24), 0.9 / density) * 0.65;
      c = mix3(c, [1, 1, 1], Math.max(g1, g2));
      const o = (py * w + px) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = cov;
    }
  }
  return { name: 'eye', raster, pivotX, pivotY, density };
}

/** Glowing seed-bud: warm-white core fading to flora glow (pivot at the bud centre, x = up the stem). */
function bakeBud(density: number): AtlasImage {
  const { raster, pivotX, pivotY } = rasterFor(-3, -3.2, 3.8, 3.2, density);
  const edge = rgb(PALETTE.floraGlow);
  const mid = [0.7, 1, 0.9];
  const core = [1, 1, 0.94];
  const { w, h, data } = raster;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = -3 + (px + 0.5) / density;
      const y = -3.2 + (py + 0.5) / density;
      const d = smin(sdCircle(x, y, 0.7, 0, 2.3), sdTaperedCapsule(x, y, -2.2, 0, 0.7, 0, 0.5, 1.6), 1);
      const cov = coverage(d, 1 / density);
      if (cov <= 0) continue;
      const k = Math.min(1, Math.max(0, -d / 2.2));
      let c = mix3(edge, mid, smoothstep(0, 0.45, k));
      c = mix3(c, core, smoothstep(0.35, 0.95, k));
      const o = (py * w + px) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = cov;
    }
  }
  return { name: 'bud', raster, pivotX, pivotY, density };
}

/** Soft radial spirit-light (white; tinted at draw time). Pivot at the centre. */
function bakeHalo(): AtlasImage {
  const n = HALO_TEXELS;
  const raster = createRaster(n, n);
  const { data } = raster;
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const x = ((px + 0.5) / n) * 2 - 1;
      const y = ((py + 0.5) / n) * 2 - 1;
      const r = Math.min(1, Math.hypot(x, y));
      const a = Math.pow(1 - r, 2.2) * (1 - smoothstep(0.9, 1, r));
      const o = (py * n + px) * 4;
      data[o] = 1;
      data[o + 1] = 1;
      data[o + 2] = 1;
      data[o + 3] = a;
    }
  }
  return { name: 'halo', raster, pivotX: n / 2, pivotY: n / 2, density: n / (2 * HALO_RADIUS) };
}

/** Scarf ribbon strip: u along the scarf (spirit glow → flora glow, fading out), v across. */
function bakeScarf(): AtlasImage {
  const w = 64;
  const h = 16;
  const raster = createRaster(w, h);
  const a0 = rgb(PALETTE.spiritGlow);
  const a1 = rgb(PALETTE.floraGlow);
  const { data } = raster;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5) / w;
      const v = (py + 0.5) / h;
      const across = smoothstep(0, 0.42, v) * smoothstep(1, 0.58, v);
      const core = smoothstep(0.25, 0.5, v) * smoothstep(0.75, 0.5, v);
      let c = mix3(a0, a1, Math.pow(u, 0.85));
      c = mix3(c, [1, 1, 1], core * 0.35 * (1 - u));
      const o = (py * w + px) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = across * (0.95 - 0.35 * u) * (1 - smoothstep(0.82, 1, u));
    }
  }
  return { name: 'scarf', raster, pivotX: 0, pivotY: h / 2, density: 1 };
}

/** All part images (lit shapes in both lighting variants plus the unlit extras). */
export function buildHeroImages(density = HERO_DENSITY): AtlasImage[] {
  const out: AtlasImage[] = [];
  for (const s of HERO_SHAPES) {
    const r = bakeLitShape(s, HERO_LIGHT.x, HERO_LIGHT.y, density);
    const l = bakeLitShape(s, -HERO_LIGHT.x, HERO_LIGHT.y, density);
    out.push({ ...r, name: `${s.name}@R` }, { ...l, name: `${s.name}@L` });
  }
  out.push(bakeEye(density), bakeBud(density), bakeHalo(), bakeScarf());
  return out;
}

export function buildHeroAtlas(extra: readonly AtlasImage[] = []): Atlas {
  return packAtlas([...buildHeroImages(), ...extra], HERO_ATLAS_WIDTH, HERO_GUTTER);
}

/** Atlas image name for an attachment in the given facing. */
export function partImageName(image: string, lit: boolean, facingLeft: boolean): string {
  return lit ? `${image}${facingLeft ? '@L' : '@R'}` : image;
}
