import { PALETTE } from '../../config.ts';
import { hexToRgb, type RGB } from '../../core/color.ts';

/**
 * The kit layer shading model. `kit.glsl.ts` implements exactly this per fragment; the TS version
 * is the reference for CPU previews and tests.
 *
 * Atlas channels (straight): R luminance detail (0.5 neutral), G rim mask, B emissive, A coverage.
 */
export interface KitShadeParams {
  tint: RGB;
  fogColor: RGB;
  fog: number;
  desaturate: number;
  rim: number;
  rimColor: RGB;
  glow: number;
  /** Height mist: fog rises by `mist` between mistY and mistY + mistDepth (layer-space y). */
  mistY: number;
  mistDepth: number;
  mist: number;
}

export const KIT_MODE = {
  /** Opaque core (pre-pass): colour un-premultiplied, alpha forced to 1. */
  Core: 0,
  /** Soft band / blended decor: premultiplied output. */
  Band: 1,
  /** Plate texture colour (translucent). */
  PlateBand: 2,
  /** Plate texture colour (opaque hull). */
  PlateCore: 3,
  /** Glow twin: emissive light only, alpha 0 (pure additive). */
  Glow: 4,
} as const;
export type KitMode = (typeof KIT_MODE)[keyof typeof KIT_MODE];

/** Moonlight rim colour (cool, slightly cyan). */
export const KIT_RIM_COLOR: RGB = (() => {
  const m = hexToRgb(PALETTE.moonlight);
  const s = hexToRgb(PALETTE.spiritGlow);
  return [m[0] * 0.7 + s[0] * 0.3, m[1] * 0.7 + s[1] * 0.3, m[2] * 0.7 + s[2] * 0.3];
})();

/** Rim light scale (the manifest `rim` is a 0..1 artistic strength). */
export const KIT_RIM_SCALE = 0.5;

/** Emissive parts get this much extra additive light on top of their (fog-cut) colour. */
export const KIT_GLOW_ADD = 0.6;

/**
 * Shade one texel. `tex` = straight RGBA 0..1; `shade` 0..1 per instance (0.5 neutral); `glowRgb`
 * per vertex. Writes premultiplied RGBA into `out`.
 */
export function shadeKit(
  out: Float32Array | number[], tex: ArrayLike<number>, shade: number, glowRgb: RGB, layerY: number, p: KitShadeParams, mode: KitMode,
): void {
  const a = tex[3] as number;
  const lum = tex[0] as number;
  const rimMask = tex[1] as number;
  const em = tex[2] as number;
  const k = (0.5 + lum) * (0.8 + 0.4 * shade);
  const rim = rimMask * p.rim * KIT_RIM_SCALE;
  let r = p.tint[0] * k + p.rimColor[0] * rim;
  let g = p.tint[1] * k + p.rimColor[1] * rim;
  let b = p.tint[2] * k + p.rimColor[2] * rim;
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r += (l - r) * p.desaturate;
  g += (l - g) * p.desaturate;
  b += (l - b) * p.desaturate;
  const mistT = Math.min(1, Math.max(0, (layerY - p.mistY) / Math.max(1e-3, p.mistDepth)));
  const f = Math.min(1, p.fog + (1 - p.fog) * mistT * mistT * p.mist);
  r += (p.fogColor[0] - r) * f;
  g += (p.fogColor[1] - g) * f;
  b += (p.fogColor[2] - b) * f;
  const e = em * (1 - f * 0.6) * (p.glow > 0 ? 1 : 0);
  const gr = glowRgb[0] * p.glow;
  const gg = glowRgb[1] * p.glow;
  const gb = glowRgb[2] * p.glow;
  r += (gr * 1.25 - r) * e;
  g += (gg * 1.25 - g) * e;
  b += (gb * 1.25 - b) * e;
  if (mode === KIT_MODE.Core) {
    out[0] = r;
    out[1] = g;
    out[2] = b;
    out[3] = 1;
    return;
  }
  if (mode === KIT_MODE.Glow) {
    out[0] = gr * e * a;
    out[1] = gg * e * a;
    out[2] = gb * e * a;
    out[3] = 0;
    return;
  }
  out[0] = r * a + gr * e * a * KIT_GLOW_ADD;
  out[1] = g * a + gg * e * a * KIT_GLOW_ADD;
  out[2] = b * a + gb * e * a * KIT_GLOW_ADD;
  out[3] = a;
}
