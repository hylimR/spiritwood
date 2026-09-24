import { PALETTE } from '../../config.ts';
import { hexToRgb, type RGB } from '../../core/color.ts';

/**
 * Terrain shading model, mirrored by `terrain.glsl.ts`. The core is earth, not a flat void: it ramps
 * from a lifted edge colour to deep silhouette with depth, carries faint warped strata and mottling,
 * gets a cold moonlit rim zone just inside surfaces that face the moon, and picks up baked spill from
 * lanterns (warm), big flora (teal) and thorns (rose). The moss rim is a tufted lip on up-facing edges
 * that overhangs the edge slightly, with brighter glowing specks (twinned into the glow pass).
 */
export const TERRAIN_EDGE_COLOR: RGB = [0x0b / 255, 0x19 / 255, 0x28 / 255];
export const TERRAIN_DEEP_COLOR: RGB = [0x05 / 255, 0x0b / 255, 0x14 / 255];
/** Lighter earth tone of embedded stones and root veins (× the base colour). */
export const TERRAIN_STONE_GAIN = 0.4;
export const TERRAIN_VEIN_GAIN = 0.7;
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

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
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
  const warp = noise(wx * 0.0045, wy * 0.0045) * 70;
  const strata = noise(wx * 0.0022, (wy + warp) * 0.026);
  const mottle = noise(wx * 0.019 + 13.1, wy * 0.019 + 13.1);
  // Stones: the peaks of a mid-frequency noise; veins: a thin iso-line of a stretched noise (roots, cracks).
  // Rotated lattices keep thresholded value noise from reading as axis-aligned blocks.
  const rx = wx * 0.866 - wy * 0.5;
  const ry = wx * 0.5 + wy * 0.866;
  const sn = 0.6 * noise(rx * 0.06 + 5.3, ry * 0.07 + 1.9) + 0.4 * noise(ry * 0.11 + 2.1, rx * 0.12 + 8.4);
  const stone = smooth(0.64, 0.72, sn);
  const vein = 1 - smooth(0, 0.03, Math.abs(noise(ry * 0.011 + 7.7, rx * 0.017 + 3.1) - 0.5));
  const k = (1 + 0.55 * (strata - 0.5) + 0.3 * (mottle - 0.5)) * (1 + TERRAIN_STONE_GAIN * stone + TERRAIN_VEIN_GAIN * vein * (1 - t));
  const rim = lit * Math.exp(-depth / TERRAIN_RIM_REACH);
  const sp = Math.exp(-depth / TERRAIN_SPILL_REACH);
  for (let c = 0; c < 3; c++) {
    const base = ((TERRAIN_EDGE_COLOR[c] as number) + ((TERRAIN_DEEP_COLOR[c] as number) - (TERRAIN_EDGE_COLOR[c] as number)) * t) * k;
    out[c] = base + (TERRAIN_RIM_COLOR[c] as number) * rim
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
