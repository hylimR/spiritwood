import type { SkyLayerDef } from '../../contracts/assets.ts';
import { hexToRgb, parseHexColor, type RGB } from '../../core/color.ts';

/**
 * Sky model shared by `sky.glsl.ts` (per fragment) and CPU previews: a 4-stop vertical gradient,
 * slow high mist, a moon with a two-lobe halo and sparse twinkling stars in the upper sky.
 */
export const SKY_STOPS = 4;
/** Star grid cell in view units. */
export const STAR_CELL = 38;

export interface SkyParams {
  /** Stop positions (t, 0..1) and colours, padded to SKY_STOPS by repeating the last stop. */
  stopT: Float32Array;
  stopColor: Float32Array;
  moonX: number;
  moonY: number;
  moonRadius: number;
  moonColor: RGB;
  halo: number;
  starDensity: number;
}

export function skyParams(def: SkyLayerDef): SkyParams {
  const stopT = new Float32Array(SKY_STOPS);
  const stopColor = new Float32Array(SKY_STOPS * 3);
  for (let i = 0; i < SKY_STOPS; i++) {
    const s = def.gradient[Math.min(i, def.gradient.length - 1)] as [number, string];
    stopT[i] = i < def.gradient.length ? s[0] : 1 + i;
    const c = hexToRgb(parseHexColor(s[1]));
    stopColor.set(c, i * 3);
  }
  return {
    stopT,
    stopColor,
    moonX: def.moon.x,
    moonY: def.moon.y,
    moonRadius: def.moon.radius,
    moonColor: hexToRgb(parseHexColor(def.moon.color)),
    halo: def.moon.halo,
    starDensity: def.starDensity,
  };
}

function fract(x: number): number {
  return x - Math.floor(x);
}

/** Same hash as the GLSL `sw_hash21` in shaders/common.ts. */
export function hash21(x: number, y: number): number {
  let px = fract(x * 123.34);
  let py = fract(y * 456.21);
  const d = px * (px + 45.32) + py * (py + 45.32);
  px += d;
  py += d;
  return fract(px * py);
}

/** Sky colour (straight RGB, opaque) at view-space (vx, vy). `mistNoise(x, y)` ≈ fbm in [0, 1]. */
export function shadeSky(
  out: Float32Array | number[], vx: number, vy: number, viewW: number, viewH: number, time: number, p: SkyParams,
  mistNoise: (x: number, y: number) => number,
): void {
  const t = vy / viewH;
  let i = 0;
  while (i < SKY_STOPS - 2 && t > (p.stopT[i + 1] as number)) i++;
  const t0 = p.stopT[i] as number;
  const t1 = p.stopT[i + 1] as number;
  const u = Math.min(1, Math.max(0, (t - t0) / Math.max(1e-5, t1 - t0)));
  let r = (p.stopColor[i * 3] as number) + ((p.stopColor[i * 3 + 3] as number) - (p.stopColor[i * 3] as number)) * u;
  let g = (p.stopColor[i * 3 + 1] as number) + ((p.stopColor[i * 3 + 4] as number) - (p.stopColor[i * 3 + 1] as number)) * u;
  let b = (p.stopColor[i * 3 + 2] as number) + ((p.stopColor[i * 3 + 5] as number) - (p.stopColor[i * 3 + 2] as number)) * u;

  // High mist: drifting fbm band in the middle sky.
  const band = smooth(0.12, 0.42, t) * (1 - smooth(0.55, 0.9, t));
  const m = mistNoise(vx * 0.0016 + time * 0.004, vy * 0.0055) * band;
  r += 0.045 * m;
  g += 0.085 * m;
  b += 0.105 * m;

  // Moon halo and disc.
  const mx = p.moonX * viewW;
  const my = p.moonY * viewH;
  const d = Math.sqrt((vx - mx) * (vx - mx) + (vy - my) * (vy - my));
  const dn = d / p.moonRadius;
  const halo = p.halo * (0.34 * Math.exp(-Math.max(0, dn - 1) * 1.5) + 0.11 * Math.exp(-dn * 0.3));
  r += p.moonColor[0] * halo * 0.32;
  g += p.moonColor[1] * halo * 0.32;
  b += p.moonColor[2] * halo * 0.32;
  const disc = 1 - smooth(-1.2, 1.2, d - p.moonRadius);
  if (disc > 0) {
    const mottled = 0.9 + 0.1 * mistNoise(vx * 0.05 + 3, vy * 0.05 + 7);
    r += (p.moonColor[0] * mottled - r) * disc;
    g += (p.moonColor[1] * mottled - g) * disc;
    b += (p.moonColor[2] * mottled - b) * disc;
  }

  // Stars: at most one per grid cell, fading out into the haze below 45% of the view.
  const fade = (1 - smooth(0.22, 0.46, t)) * smooth(2.2, 6, dn);
  if (fade > 0) {
    const cx = Math.floor(vx / STAR_CELL);
    const cy = Math.floor(vy / STAR_CELL);
    const h = hash21(cx, cy);
    if (h < p.starDensity * 0.42) {
      const sx = (cx + 0.15 + 0.7 * hash21(cx + 7.1, cy + 3.3)) * STAR_CELL;
      const sy = (cy + 0.15 + 0.7 * hash21(cx + 1.9, cy + 9.7)) * STAR_CELL;
      const bright = 0.35 + 0.65 * hash21(cx + 4.4, cy + 5.5);
      const tw = 0.62 + 0.38 * Math.sin(time * (1.3 + 2.4 * hash21(cx + 8.8, cy + 2.2)) + 6.283 * h * 17);
      const dd = (vx - sx) * (vx - sx) + (vy - sy) * (vy - sy);
      const s = Math.exp(-dd * 0.55) * bright * tw * fade;
      r += 0.8 * s;
      g += 0.92 * s;
      b += s;
    }
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
