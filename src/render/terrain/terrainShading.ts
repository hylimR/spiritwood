import { PALETTE } from '../../config.ts';
import { hexToRgb, type RGB } from '../../core/color.ts';

/**
 * Terrain shading model, mirrored by `terrain.glsl.ts`: the core blends from a lifted edge colour to
 * the silhouette colour with depth inside, with faint world-space mottling; the moss rim is a patchy
 * teal crust on up-facing edges with brighter specks (its light is twinned into the glow pass).
 */
export const TERRAIN_EDGE_COLOR: RGB = [0x0c / 255, 0x1a / 255, 0x28 / 255];
export const TERRAIN_DEEP_COLOR: RGB = hexToRgb(PALETTE.silhouette);
export const MOSS_BASE_COLOR: RGB = [0.05, 0.2, 0.22];
export const MOSS_GLOW_COLOR: RGB = hexToRgb(PALETTE.floraGlow);

/** Core colour at `depth` (u inside the surface), `mottle` ≈ noise in [-1, 1]. */
export function shadeTerrainCore(out: Float32Array | number[], depth: number, shadeDepth: number, mottle: number): void {
  const t = Math.pow(Math.min(1, Math.max(0, depth / shadeDepth)), 0.65);
  const m = 1 + 0.22 * mottle;
  for (let c = 0; c < 3; c++) out[c] = ((TERRAIN_EDGE_COLOR[c] as number) + ((TERRAIN_DEEP_COLOR[c] as number) - (TERRAIN_EDGE_COLOR[c] as number)) * t) * m;
}

/** Moss alpha across the strip: v ∈ [−1 (inside), 1 (outside)], up-facing factor, patch noise [0,1]. */
export function mossAlpha(v: number, up: number, patch: number): number {
  const prof = smooth(-1, -0.15, v) * (1 - smooth(0.25, 1, v));
  return prof * smooth(0.3, 0.75, up) * (0.3 + 0.7 * smooth(0.35, 0.65, patch));
}

/** Premultiplied moss colour for alpha `a` and speck noise [0, 1]. */
export function shadeMoss(out: Float32Array | number[], a: number, speck: number): void {
  const s = smooth(0.62, 0.9, speck);
  const k = 0.3 + 0.7 * s;
  for (let c = 0; c < 3; c++) out[c] = ((MOSS_BASE_COLOR[c] as number) + ((MOSS_GLOW_COLOR[c] as number) - (MOSS_BASE_COLOR[c] as number)) * k) * a;
  out[3] = a * 0.92;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
