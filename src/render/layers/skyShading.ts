import type { SkyLayerDef } from '../../contracts/assets.ts';
import { hexToRgb, parseHexColor, type RGB } from '../../core/color.ts';

/**
 * Sky model shared by `sky.glsl.ts` (per fragment) and CPU previews: a 4-stop vertical gradient, a
 * luminous horizon mist band behind the far treelines (it drifts slightly with the camera, like a
 * very distant layer), faint high cloud streaks, a moon with a corona that lifts the sky around it,
 * and sparse twinkling stars in the upper sky.
 */
export const SKY_STOPS = 4;
/** Star grid cell in view units. */
export const STAR_CELL = 38;

/** Horizon mist band: centre (view fraction at the level's mid height), parallax with camera y, widths, colour. */
export const SKY_HORIZON = Object.freeze({
  t: 0.6,
  parallax: 0.06,
  /** Gaussian half-widths above / below the centre (view fractions). */
  up: 0.13,
  down: 0.3,
  color: [0.05, 0.115, 0.15] as RGB,
  /** Noise modulation of the band: colour × (base + amp·noise). */
  base: 0.72,
  amp: 0.56,
});

/** Faint high cloud streaks (view-fraction band, colour). */
export const SKY_CLOUDS = Object.freeze({ t0: 0.06, t1: 0.26, t2: 0.4, t3: 0.62, color: [0.03, 0.05, 0.075] as RGB });

/** Moon corona lobes (× halo × moon colour): tight corona, mid glow and the broad sky lift. */
export const MOON_GLOW = Object.freeze({
  corona: 0.3, coronaFall: 2.4,
  mid: 0.085, midFall: 0.55,
  broad: 0.05, broadFall: 0.13,
});

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

/** View-space y of the horizon band centre for camera centre y `camY` in a level `levelH` tall. */
export function skyHorizonY(viewH: number, camY: number, levelH: number): number {
  return viewH * SKY_HORIZON.t - (camY - levelH / 2) * SKY_HORIZON.parallax;
}

const f32 = Math.fround;
const K1 = f32(123.34);
const K2 = f32(456.21);
const K3 = f32(45.32);

/**
 * Same hash as the GLSL `sw_hash21` in shaders/common.ts, in float32 like the GPU (highp): with large
 * lattice coordinates the float64 result would be a different random number, so CPU previews of the
 * noise would not match the screen.
 */
export function hash21(x: number, y: number): number {
  let px = f32(x);
  let py = f32(y);
  px = f32(px * K1);
  py = f32(py * K2);
  px = f32(px - Math.floor(px));
  py = f32(py - Math.floor(py));
  const d = f32(f32(px * f32(px + K3)) + f32(py * f32(py + K3)));
  px = f32(px + d);
  py = f32(py + d);
  const q = f32(px * py);
  return f32(q - Math.floor(q));
}

/**
 * Sky colour (straight RGB, opaque) at view-space (vx, vy). `noise(x, y)` mirrors GLSL `sw_vnoise`
 * (value noise in [0, 1]); tests may pass a constant.
 */
export function shadeSky(
  out: Float32Array | number[], vx: number, vy: number, viewW: number, viewH: number, horizonY: number, time: number, p: SkyParams,
  noise: (x: number, y: number) => number,
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

  // Horizon mist: an asymmetric glowing band, broken up by slow drifting noise.
  const qx = vx * 0.0021 + time * 0.006;
  const qy = vy * 0.0068;
  const m = noise(qx, qy) * 0.62 + noise(qx * 2.7 + 5.1, qy * 2.3 + 1.7) * 0.38;
  const dh = (vy - horizonY) / viewH;
  const w = dh < 0 ? SKY_HORIZON.up : SKY_HORIZON.down;
  const hb = Math.exp(-(dh * dh) / (w * w)) * (SKY_HORIZON.base + SKY_HORIZON.amp * m);
  r += SKY_HORIZON.color[0] * hb;
  g += SKY_HORIZON.color[1] * hb;
  b += SKY_HORIZON.color[2] * hb;

  // High cloud streaks: the same noise, sharpened and stretched.
  const cb = smooth(SKY_CLOUDS.t0, SKY_CLOUDS.t1, t) * (1 - smooth(SKY_CLOUDS.t2, SKY_CLOUDS.t3, t));
  const streak = smooth(0.52, 0.85, m) * cb;
  r += SKY_CLOUDS.color[0] * streak;
  g += SKY_CLOUDS.color[1] * streak;
  b += SKY_CLOUDS.color[2] * streak;

  // Moon: corona, mid glow and a broad lift of the sky around it; then the mottled disc.
  const mx = p.moonX * viewW;
  const my = p.moonY * viewH;
  const d = Math.sqrt((vx - mx) * (vx - mx) + (vy - my) * (vy - my));
  const dn = d / p.moonRadius;
  const e = Math.max(0, dn - 1);
  const halo = p.halo * (MOON_GLOW.corona * Math.exp(-e * MOON_GLOW.coronaFall) + MOON_GLOW.mid * Math.exp(-e * MOON_GLOW.midFall)
    + MOON_GLOW.broad * Math.exp(-dn * MOON_GLOW.broadFall));
  r += p.moonColor[0] * halo;
  g += p.moonColor[1] * halo;
  b += p.moonColor[2] * halo;
  const disc = 1 - smooth(-1.1, 1.1, d - p.moonRadius);
  if (disc > 0) {
    const rr = Math.min(1, dn);
    const limb = 1 - 0.16 * rr * rr * rr;
    const lx = (vx - mx) / p.moonRadius;
    const ly = (vy - my) / p.moonRadius;
    const maria = smooth(0.5, 0.78, noise(lx * 1.7 + 3.1, ly * 1.7 + 8.3)) * 0.13 + smooth(0.55, 0.8, noise(lx * 4.1 + 11.0, ly * 4.1 + 2.0)) * 0.06;
    const k = limb * (1 - maria);
    r += (p.moonColor[0] * k - r) * disc;
    g += (p.moonColor[1] * k - g) * disc;
    b += (p.moonColor[2] * k - b) * disc;
  }

  // Stars: at most one per grid cell, fading out into the haze and around the moon.
  const fade = (1 - smooth(0.2, 0.44, t)) * smooth(2.4, 7, dn);
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
