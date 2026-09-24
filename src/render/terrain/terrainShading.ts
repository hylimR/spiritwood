import { PALETTE } from '../../config.ts';
import { hexToRgb, type RGB } from '../../core/color.ts';
import { hash21 } from '../layers/skyShading.ts';
import { MOON_DIR } from './terrainLight.ts';

/**
 * Terrain shading model, mirrored by `terrain.glsl.ts`. The core is earth, not a void: it ramps from a
 * lifted edge colour over the rim zone (`shadeDepth`) into a deep indigo/teal-black, and masses thicker
 * than that keep a slow drift toward a slightly more indigo core over TERRAIN_DEEP_REACH instead of
 * sinking to black. Structure that reads at gameplay zoom: broad warped strata bands with thin bedding
 * seams, a root network, sparse embedded stones pillow-shaded by the moon, pebbles, fine strata, mottling,
 * rootlets and faint moss/mineral glints. Surfaces that face the moon get a cold rim zone just inside,
 * and baked spill from lanterns (warm), big flora (teal) and thorns (rose). The moss rim is a tufted lip
 * on up-facing edges that overhangs the edge slightly, with brighter glowing specks (twinned into the
 * glow pass).
 */
export const TERRAIN_EDGE_COLOR: RGB = [0x0b / 255, 0x19 / 255, 0x28 / 255];
/** Earth at the end of the rim zone: a deep indigo/teal-black, lifted off black so big masses read as volume. */
export const TERRAIN_DEEP_COLOR: RGB = [0.029, 0.054, 0.097];
/** The heart of thick masses (TERRAIN_DEEP_REACH beyond the rim zone): a touch more indigo, not darker. */
export const TERRAIN_CORE_COLOR: RGB = [0.031, 0.052, 0.108];
/** Length of the deep-interior drift beyond the rim zone (u). The mesh depth attribute stops there. */
export const TERRAIN_DEEP_REACH = 336;
/** Alternate strata band tint (× the base): teal-shifted against the indigo band. */
export const TERRAIN_BAND_TINT: RGB = [0.8, 1.14, 1.06];
/** Bedding seams between strata bands (darkening) and the bands' brightness swing. */
export const TERRAIN_SEAM_DARK = 0.34;
export const TERRAIN_BAND_SWING = 0.3;
/** Lighter earth tone (× the base colour) of pebbles, rootlets, roots and embedded stones. */
export const TERRAIN_PEBBLE_GAIN = 0.4;
export const TERRAIN_VEIN_GAIN = 0.7;
export const TERRAIN_ROOT_GAIN = 0.45;
export const TERRAIN_STONE_GAIN = 0.2;
/** Pillow shading across a stone toward its rim (± by how squarely the rim faces the moon). */
export const TERRAIN_STONE_BEVEL = 0.42;
/** Darkening of the crevice just outside each stone (full on the side away from the moon). */
export const TERRAIN_CREVICE_DARK = 0.35;
/** Embedded stones: grid cell (u, on a 30°-rotated lattice) and the share of cells holding one. */
export const TERRAIN_STONE_CELL = 72;
export const TERRAIN_STONE_SHARE = 0.3;
/** Glints: grid cell (u), share of cells holding one, and the moss / mineral colours at full strength. */
export const TERRAIN_GLINT_CELL = 26;
export const TERRAIN_GLINT_DENSITY = 0.035;
export const TERRAIN_GLINT_MOSS: RGB = (() => {
  const c = hexToRgb(PALETTE.floraGlow);
  return [c[0] * 0.2, c[1] * 0.26, c[2] * 0.24];
})();
export const TERRAIN_GLINT_MINERAL: RGB = (() => {
  const c = hexToRgb(PALETTE.spiritGlow);
  return [c[0] * 0.13, c[1] * 0.16, c[2] * 0.2];
})();
export const TERRAIN_RIM_COLOR: RGB = [0.1, 0.25, 0.31];
/** Rim zone reach inside the surface (u) and spill reach (u). */
export const TERRAIN_RIM_REACH = 16;
export const TERRAIN_SPILL_REACH = 46;
export const SPILL_WARM: RGB = (() => {
  const c = hexToRgb(PALETTE.warmAccent);
  return [c[0] * 0.36, c[1] * 0.26, c[2] * 0.16];
})();
export const SPILL_FLORA: RGB = (() => {
  const c = hexToRgb(PALETTE.floraGlow);
  return [c[0] * 0.14, c[1] * 0.24, c[2] * 0.24];
})();
export const SPILL_THORN: RGB = (() => {
  const c = hexToRgb(PALETTE.thorns);
  return [c[0] * 0.3, c[1] * 0.1, c[2] * 0.14];
})();
export const MOSS_BASE_COLOR: RGB = [0.035, 0.13, 0.14];
export const MOSS_GLOW_COLOR: RGB = hexToRgb(PALETTE.floraGlow);

type Noise = (x: number, y: number) => number;

function fract(x: number): number {
  return x - Math.floor(x);
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export interface StoneSample {
  body: number;
  /** Pillow shading: + toward the moon-facing rim, − toward the far rim. */
  pillow: number;
  crevice: number;
  /** Distance from the stone centre in radii (lumped), and how squarely that direction faces the moon. */
  d: number;
  facing: number;
}

const STONE: StoneSample = { body: 0, pillow: 0, crevice: 0, d: Infinity, facing: 0 };

/**
 * Embedded stone at rotated-lattice coords (rx, ry): at most one per TERRAIN_STONE_CELL cell, an ellipse
 * inside its cell whose outline is scaled by (1 + lump) so stones never read as perfect ellipses. The
 * crevice is a contact shadow on the far side (a full dark ring reads as a bubble).
 */
export function stoneAt(out: StoneSample, rx: number, ry: number, lump: number): void {
  const S = TERRAIN_STONE_CELL;
  const qx = rx / S;
  const qy = ry / S;
  const ix = Math.floor(qx);
  const iy = Math.floor(qy);
  const hs = hash21(ix + 41.7, iy + 12.9);
  out.body = 0;
  out.pillow = 0;
  out.crevice = 0;
  out.d = Infinity;
  out.facing = 0;
  if (hs >= TERRAIN_STONE_SHARE) return;
  const u = fract(hs * 7.3);
  const r = (0.11 + 0.23 * u * u) * S;
  const dx = (qx - ix) * S - (r + (S - 2 * r) * fract(hs * 31.1));
  const dy = (qy - iy) * S - (r + (S - 2 * r) * fract(hs * 57.7));
  const asp = 0.62 + 0.38 * fract(hs * 91.3);
  const ey = dy / asp;
  const d = (Math.sqrt(dx * dx + ey * ey) / r) * (1 + lump);
  // Ellipse normal in the rotated frame, back to world axes, against the moon direction.
  const nrx = dx;
  const nry = ey / asp;
  const facing = ((0.866 * nrx + 0.5 * nry) * MOON_DIR[0] + (-0.5 * nrx + 0.866 * nry) * MOON_DIR[1]) / (Math.hypot(nrx, nry) + 1e-6);
  out.body = 1 - smooth(0.9, 1, d);
  out.pillow = out.body * Math.min(1, d) * facing;
  out.crevice = smooth(0.98, 1.05, d) * (1 - smooth(1.05, 1.2, d)) * (0.2 + 0.8 * smooth(-0.2, 0.7, -facing));
  out.d = d;
  out.facing = facing;
}

/**
 * Core colour at `depth` (u inside the surface) and world (wx, wy). `lit` = moon-facing factor of the
 * nearest surface (0..1), `spill` = [warm, flora, thorn]. `noise` mirrors GLSL `sw_vnoise` in [0, 1].
 */
export function shadeTerrainCore(
  out: Float32Array | number[], depth: number, shadeDepth: number, wx: number, wy: number, lit: number, spill: readonly number[],
  noise: Noise,
): void {
  const t = Math.pow(Math.min(1, Math.max(0, depth / shadeDepth)), 0.7);
  const k = Math.min(1, Math.max(0, (depth - shadeDepth) / TERRAIN_DEEP_REACH));
  const warp = noise(wx * 0.0045, wy * 0.0045) * 70;
  const strata = noise(wx * 0.0022, (wy + warp) * 0.026);
  const mottle = noise(wx * 0.019 + 13.1, wy * 0.019 + 13.1);
  // Broad strata: a slow noise over warped rows (~140 u apart); its 0.5 iso-line is a bedding seam.
  const band = noise(wx * 0.0011 + 3.1, (wy + warp * 1.5) * 0.0072 + 7.3);
  const seam = 1 - smooth(0, 0.016, Math.abs(band - 0.5));
  // Pebbles: the peaks of a mid-frequency noise; rootlets: a thin iso-line of a stretched noise.
  // Rotated lattices keep thresholded value noise from reading as axis-aligned blocks.
  const rx = wx * 0.866 - wy * 0.5;
  const ry = wx * 0.5 + wy * 0.866;
  const sn = 0.6 * noise(rx * 0.06 + 5.3, ry * 0.07 + 1.9) + 0.4 * noise(ry * 0.11 + 2.1, rx * 0.12 + 8.4);
  const pebble = smooth(0.64, 0.72, sn);
  const vein = 1 - smooth(0, 0.03, Math.abs(noise(ry * 0.011 + 7.7, rx * 0.017 + 3.1) - 0.5));
  // Roots: the iso-line of a noise stretched along the steep lattice axis (so they run down and to the
  // right), shown only where the strata band is high, which breaks them into strands.
  const root = (1 - smooth(0, 0.022, Math.abs(noise(rx * 0.0095 + 1.3, ry * 0.0032 + 4.9) - 0.5))) * smooth(0.3, 0.62, band);
  // Embedded stones (stoneAt), their outlines lumped by two noises already sampled above.
  stoneAt(STONE, rx, ry, 0.5 * (sn - 0.5) + 0.4 * (mottle - 0.5));
  const { body, pillow, crevice } = STONE;
  const lum = (1 + 0.55 * (1 - 0.45 * k) * (strata - 0.5) + 0.3 * (mottle - 0.5))
    * (1 - TERRAIN_BAND_SWING / 2 + TERRAIN_BAND_SWING * band) * (1 - TERRAIN_SEAM_DARK * seam) * (1 - TERRAIN_CREVICE_DARK * crevice);
  const detail = 1 + TERRAIN_PEBBLE_GAIN * pebble + TERRAIN_VEIN_GAIN * vein * (1 - 0.6 * t) + TERRAIN_ROOT_GAIN * root
    + TERRAIN_STONE_GAIN * body + TERRAIN_STONE_BEVEL * pillow;
  const bandMix = smooth(0.35, 0.65, band);
  // Glints: at most one faint speck per grid cell, in a hashed share of the cells.
  const G = TERRAIN_GLINT_CELL;
  const cx = Math.floor(wx / G);
  const cy = Math.floor(wy / G);
  const h = hash21(cx + 17.3, cy + 5.1);
  let glint = 0;
  let mineral = 0;
  if (h >= 1 - TERRAIN_GLINT_DENSITY) {
    const px = (cx + 0.2 + 0.6 * fract(h * 13.7)) * G;
    const py = (cy + 0.2 + 0.6 * fract(h * 71.3)) * G;
    glint = 1 - smooth(0.6, 2.8, Math.hypot(wx - px, wy - py));
    mineral = fract(h * 431.7) >= 0.5 ? 1 : 0;
  }
  const rim = lit * Math.exp(-depth / TERRAIN_RIM_REACH);
  const sp = Math.exp(-depth / TERRAIN_SPILL_REACH);
  for (let c = 0; c < 3; c++) {
    const edge = TERRAIN_EDGE_COLOR[c] as number;
    const deep = (TERRAIN_DEEP_COLOR[c] as number) + ((TERRAIN_CORE_COLOR[c] as number) - (TERRAIN_DEEP_COLOR[c] as number)) * k;
    const tint = 1 + ((TERRAIN_BAND_TINT[c] as number) - 1) * bandMix;
    const base = (edge + (deep - edge) * t) * tint * lum * detail;
    const glintC = (mineral ? TERRAIN_GLINT_MINERAL[c] : TERRAIN_GLINT_MOSS[c]) as number;
    out[c] = base + glintC * glint + (TERRAIN_RIM_COLOR[c] as number) * rim
      + ((SPILL_WARM[c] as number) * (spill[0] as number) + (SPILL_FLORA[c] as number) * (spill[1] as number)
        + (SPILL_THORN[c] as number) * (spill[2] as number)) * sp;
  }
}

/** Moon-facing factor of an outward normal (nx, ny). */
export function litFromNormal(nx: number, ny: number): number {
  const l = Math.hypot(nx, ny);
  return l < 1e-6 ? 0 : Math.max(0, (-0.55 * nx - 0.83 * ny) / l);
}

/**
 * Moss alpha across the strip: v ∈ [−1 (inside), 1 (outside)], up-facing factor, world (wx, wy).
 * The outer half is a tufted lip (blades of alpha along the edge) that overhangs the silhouette.
 */
export function mossAlpha(v: number, up: number, wx: number, wy: number, noise: Noise): number {
  const patch = noise(wx * 0.07, wy * 0.07);
  const tuft = noise(wx * 0.42 + 3.7, wy * 0.12);
  const outer = smooth(0.1, 1, v);
  const prof = smooth(-1, -0.2, v) * (1 - smooth(0.2 + 0.75 * tuft, 1.02, v) * outer);
  return prof * smooth(0.12, 0.55, up) * (0.35 + 0.65 * smooth(0.3, 0.62, patch));
}

/** Speck factor (0..1) of the moss at world (wx, wy): glowing flecks. */
export function mossSpeck(wx: number, wy: number, noise: Noise): number {
  return smooth(0.6, 0.88, noise(wx * 0.62 + 30, wy * 0.62));
}

/** Premultiplied moss colour for alpha `a` and speck factor `s`, with warm spill. */
export function shadeMoss(out: Float32Array | number[], a: number, s: number, spill: readonly number[]): void {
  const k = 0.22 + 0.78 * s;
  for (let c = 0; c < 3; c++) {
    const base = (MOSS_BASE_COLOR[c] as number) + ((MOSS_GLOW_COLOR[c] as number) - (MOSS_BASE_COLOR[c] as number)) * k;
    out[c] = (base + (SPILL_WARM[c] as number) * (spill[0] as number) * 0.6) * a;
  }
  out[3] = a * 0.94;
}

/** Glow-twin strength of the moss (× MOSS_GLOW_COLOR × the view's glow uniform) for alpha `a` and speck `s`. */
export function mossGlow(a: number, s: number): number {
  return a * (0.2 + 0.8 * s);
}
