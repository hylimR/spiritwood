import { PALETTE } from '../../config.ts';
import { hexToRgb, type RGB } from '../../core/color.ts';

/**
 * Light-shaft shading, mirrored by SHAFT_FRAGMENT in shafts.ts. (u across 0..1, v down 0..1.)
 * A soft cross-section with distinct streaks that run along the shaft, brightest near the source and
 * trailing off toward the floor, with a slow downward shimmer. Two value-noise lookups, no loops.
 */
export const SHAFT_LOOK = Object.freeze({
  /** Brightness relative to def.intensity. */
  strength: 0.26,
  /** Streak frequency across the shaft and their contrast (0 = uniform). */
  streakFreq: 7.5,
  streakDrift: 0.035,
  streakMin: 0.28,
  /** Shimmer (slow travelling brightness) frequency along v, speed and depth. */
  shimmerFreq: 2.2,
  shimmerSpeed: 0.09,
  shimmerDepth: 0.42,
  /** Length profile: fade-in at the source and the falloff exponent toward the bottom. */
  fadeIn: 0.07,
  fall: 0.7,
});

/** Shaft light colour: spirit glow leaning toward moonlight. */
export const SHAFT_COLOR: RGB = (() => {
  const s = hexToRgb(PALETTE.spiritGlow);
  const m = hexToRgb(PALETTE.moonlight);
  return [s[0] * 0.6 + m[0] * 0.4, s[1] * 0.6 + m[1] * 0.4, s[2] * 0.6 + m[2] * 0.4];
})();

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Cross-section × length envelope (0..1), shared by the shader, the dust and tests. */
export function shaftProfile(u: number, v: number): number {
  const across = smooth(0, 0.24, u) * (1 - smooth(0.76, 1, u));
  const along = smooth(0, SHAFT_LOOK.fadeIn, v) * Math.pow(Math.max(0, 1 - v), SHAFT_LOOK.fall);
  return across * along;
}

/** Additive light amount at shaft coords (u, v). `noise` mirrors GLSL `sw_vnoise` in [0, 1]. */
export function shadeShaft(
  u: number, v: number, seed: number, intensity: number, time: number, noise: (x: number, y: number) => number,
): number {
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const L = SHAFT_LOOK;
  const n = noise(u * L.streakFreq + seed, time * L.streakDrift + seed * 0.37);
  const streak = L.streakMin + (1 - L.streakMin) * smooth(0.2, 0.8, n);
  const sh = noise(u * 2.3 + seed * 1.7, v * L.shimmerFreq - time * L.shimmerSpeed);
  const shimmer = 1 - L.shimmerDepth + L.shimmerDepth * sh * 2 * 0.8;
  return shaftProfile(u, v) * streak * shimmer * intensity * L.strength;
}
