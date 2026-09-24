import { PALETTE } from '../../config.ts';
import { clamp01 } from '../../core/math.ts';
import { Rng } from '../../core/rng.ts';
import { coverage, sdCircle, sdCurve } from '../gen/sdf.ts';
import { createRaster, mix3, rgb, smoothstep, type AtlasImage } from '../hero/atlas.ts';
import { bakeLight, entityNoise } from './entityBake.ts';

/**
 * Thorn Spitter seeds for the entity atlas (§5.5), all premultiplied so every seed and trail draws in one
 * normal-blend batch: emissive texels (colour at alpha 0) add, dark husk texels occlude.
 * - `seedHostile`: a rose ember in a cracked dark husk with six small hooked thorns (radius ≈ 12 u).
 * - `seedWisp`: a reflected seed, a spirit-blue wisp with a hot core, its tail toward −x.
 * - `seedTrail`: a white ribbon strip (u along from the head, v across), tinted per seed (reflected).
 * - `seedEmber`: the hostile seed's wake, a coloured ember ribbon (same u, v) with a few faint sparks.
 * - `glowLight`: a soft emissive disc (radius 1 at scale 1 of its frame) for halos inside normal batches.
 */

const DENSITY = 3;
const noise = entityNoise;
const ROSE = rgb(PALETTE.thorns);
const ROSE_HOT = [1, 0.78, 0.82];

const THORNS = 6;
const THORN_SEGS = (() => {
  const out = new Float64Array(THORNS * 6);
  for (let k = 0; k < THORNS; k++) {
    const a = (k / THORNS) * Math.PI * 2 + 0.3;
    const hook = 0.38;
    const ax = Math.cos(a) * 4.4;
    const ay = Math.sin(a) * 4.4;
    const tx = Math.cos(a + hook) * 10.6;
    const ty = Math.sin(a + hook) * 10.6;
    const cx = Math.cos(a + hook * 0.2) * 7.8;
    const cy = Math.sin(a + hook * 0.2) * 7.8;
    out.set([ax, ay, cx, cy, tx, ty], k * 6);
  }
  return out;
})();

function thornDist(x: number, y: number): number {
  const r = Math.hypot(x, y);
  if (r > 15) return r - 13;
  let d = Infinity;
  for (let k = 0; k < THORNS; k++) {
    const o = k * 6;
    const e = sdCurve(x, y, THORN_SEGS[o] as number, THORN_SEGS[o + 1] as number, THORN_SEGS[o + 2] as number,
      THORN_SEGS[o + 3] as number, THORN_SEGS[o + 4] as number, THORN_SEGS[o + 5] as number, 2.1, 0.22, 4);
    if (e < d) d = e;
  }
  return d;
}

function hostile(): AtlasImage {
  const aa = 1 / DENSITY;
  return bakeLight({
    name: 'seedHostile', x0: -15, y0: -15, x1: 15, y1: 15, density: DENSITY,
    texel: (x, y, out) => {
      const r = Math.hypot(x, y);
      const core = sdCircle(x, y, 0, 0, 7) + noise.fbm(x * 0.5, y * 0.5, 2) * 0.35;
      const thorn = thornDist(x, y);
      const covCore = coverage(core, aa);
      const covThorn = coverage(thorn, aa);
      const cov = Math.max(covCore, covThorn);
      // Husk plates over the ember; the light shows through the cracks between them.
      const crack = smoothstep(0.62, 0.9, noise.ridged(x * 0.42 + 5.3, y * 0.42 - 2.1, 2));
      const husk = covCore * (1 - crack) * smoothstep(1.4, 3.6, r);
      const moon = Math.max(0, (-0.6 * x - 0.8 * y) / Math.max(1e-3, r));
      let body = mix3([0.05, 0.02, 0.035], [0.25, 0.14, 0.2], smoothstep(4, 7, r) * moon * 0.9);
      const tipK = smoothstep(7, 10.2, r);
      if (covThorn > covCore) body = mix3([0.07, 0.03, 0.05], [0.5, 0.1, 0.18], tipK);
      // Emission: a hot centre, rose light through the cracks, glowing thorn tips and a soft halo.
      const centre = Math.exp(-r * r * 0.09);
      let e = centre * 0.9 + covCore * crack * 0.95 + covThorn * tipK * tipK * 0.55;
      e += Math.exp(-r * 0.3) * 0.28 * (1 - smoothstep(12, 15, r));
      const hot = centre * (1 - husk);
      const alpha = Math.max(husk * 0.92, covThorn * 0.95);
      out[0] = body[0] * alpha + (ROSE[0] * e + (ROSE_HOT[0] - ROSE[0]) * hot) * (1 - husk * 0.75);
      out[1] = body[1] * alpha + (ROSE[1] * e + (ROSE_HOT[1] - ROSE[1]) * hot) * (1 - husk * 0.75);
      out[2] = body[2] * alpha + (ROSE[2] * e + (ROSE_HOT[2] - ROSE[2]) * hot) * (1 - husk * 0.75);
      out[3] = alpha * cov;
    },
  });
}

function wisp(): AtlasImage {
  const spirit = rgb(PALETTE.spiritGlow);
  const deep = [0.35, 0.72, 1];
  return bakeLight({
    name: 'seedWisp', x0: -27, y0: -13, x1: 15, y1: 13, density: DENSITY,
    texel: (x, y, out) => {
      // A comet teardrop: round at the head (+x), stretching into a flickering tail toward −x.
      const hx = x - 3;
      const tail = hx < 0 ? 1 + (-hx / 14) * 1.8 : 1;
      const wob = noise.fbm(x * 0.25 + 3, y * 0.5, 2) * (hx < 0 ? 1.8 : 0.4);
      const q = Math.hypot(hx / tail, (y + wob * 0.6) * (hx < 0 ? 1 + (-hx / 14) * 0.4 : 1));
      const coreK = Math.exp(-q * q * 0.14);
      const glow = Math.exp(-q * 0.42);
      // The tail thins out before the frame ends (no cut edge).
      const e = (glow * 0.85 + coreK * 0.6) * (1 - smoothstep(9, 10.8, Math.hypot(Math.max(0, hx), y))) * (1 - smoothstep(-15, -25, x));
      const c = mix3(deep, spirit, smoothstep(0.1, 0.7, glow));
      const white = coreK * 0.9;
      out[0] = c[0] * e + white * (1 - c[0]) * 0.8;
      out[1] = c[1] * e + white * (1 - c[1]) * 0.8;
      out[2] = c[2] * e + white * (1 - c[2]) * 0.8;
      out[3] = coreK * 0.22;
    },
  });
}

/** Ribbon strip: u along the trail (0 = head … 1 = tail), v across; white emissive, tinted per seed. */
function trail(): AtlasImage {
  const w = 64;
  const h = 16;
  const raster = createRaster(w, h);
  const { data } = raster;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5) / w;
      const v = ((py + 0.5) / h) * 2 - 1;
      const streak = 0.8 + 0.2 * noise.noise2(u * 9, v * 2.2 + 7);
      const across = Math.exp(-v * v * 3.2) * (1 - smoothstep(0.6, 1, Math.abs(v)));
      const core = Math.exp(-v * v * 18) * 0.5;
      const along = Math.pow(1 - u, 1.35) * smoothstep(0, 0.04, u + 0.02);
      const e = (across * 0.8 + core) * along * streak;
      const o = (py * w + px) * 4;
      data[o] = Math.min(1, e);
      data[o + 1] = Math.min(1, e);
      data[o + 2] = Math.min(1, e);
      data[o + 3] = 0;
    }
  }
  return { name: 'seedTrail', raster, pivotX: 0, pivotY: h / 2, density: 1, premultiplied: true };
}

const EMBER_CRIMSON = [0.5, 0.03, 0.11];
const EMBER_SPARK = [1, 0.66, 0.6];

/**
 * The hostile seed's wake (premultiplied light, alpha 0): a soft-edged ember band, hot rose at the head
 * cooling to deep crimson toward the tail, with a few faint sparks. The mesh tapers it to nothing.
 */
function ember(): AtlasImage {
  const w = 96;
  const h = 24;
  const raster = createRaster(w, h);
  const { data } = raster;
  const rng = new Rng(0x5eed7a11);
  const SPARKS = 6;
  const sparks = new Float64Array(SPARKS * 4);
  for (let k = 0; k < SPARKS; k++) {
    sparks[k * 4] = rng.range(0.12, 0.9);
    sparks[k * 4 + 1] = rng.range(-0.6, 0.6);
    sparks[k * 4 + 2] = rng.range(0.55, 1);
    sparks[k * 4 + 3] = rng.range(0.25, 0.55);
  }
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const u = (px + 0.5) / w;
      const v = ((py + 0.5) / h) * 2 - 1;
      const edge = 1 - smoothstep(0.5, 1, Math.abs(v));
      const band = Math.exp(-v * v * 1.8) * edge;
      const core = Math.exp(-v * v * 9) * edge;
      const flicker = 0.8 + 0.2 * noise.noise2(u * 7 + 11, v * 1.7 + 3);
      const along = Math.pow(1 - u, 0.75) * smoothstep(0, 0.05, u + 0.02);
      const heat = clamp01(Math.pow(1 - u, 1.8) * (0.55 + 0.45 * core));
      let c = mix3(EMBER_CRIMSON, ROSE, smoothstep(0, 0.45, heat));
      c = mix3(c, ROSE_HOT, smoothstep(0.45, 1, heat) * 0.7);
      const e = (band * 0.95 + core * 0.55 * heat) * along * flicker;
      let spark = 0;
      for (let k = 0; k < SPARKS; k++) {
        const du = (u - (sparks[k * 4] as number)) * w;
        const dv = ((v - (sparks[k * 4 + 1] as number)) * h) / 2;
        const r = sparks[k * 4 + 2] as number;
        spark += (sparks[k * 4 + 3] as number) * Math.exp(-(du * du + dv * dv) / (2 * r * r)) * (1 - 0.6 * u) * edge;
      }
      const o = (py * w + px) * 4;
      data[o] = Math.min(1, c[0] * e + EMBER_SPARK[0] * spark);
      data[o + 1] = Math.min(1, c[1] * e + EMBER_SPARK[1] * spark);
      data[o + 2] = Math.min(1, c[2] * e + EMBER_SPARK[2] * spark);
      data[o + 3] = 0;
    }
  }
  return { name: 'seedEmber', raster, pivotX: 0, pivotY: h / 2, density: 1, premultiplied: true };
}

/** Soft emissive disc (alpha 0): a halo that adds inside normal-blend batches. */
function glowLight(): AtlasImage {
  const n = 64;
  const raster = createRaster(n, n);
  const { data } = raster;
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      const x = ((px + 0.5) / n) * 2 - 1;
      const y = ((py + 0.5) / n) * 2 - 1;
      const r = Math.min(1, Math.hypot(x, y));
      const e = Math.pow(1 - r, 2.2) * (1 - smoothstep(0.85, 1, r));
      const o = (py * n + px) * 4;
      data[o] = e;
      data[o + 1] = e;
      data[o + 2] = e;
      data[o + 3] = 0;
    }
  }
  return { name: 'glowLight', raster, pivotX: n / 2, pivotY: n / 2, density: n / 2, premultiplied: true };
}

export function buildSeedImages(): AtlasImage[] {
  return [hostile(), wisp(), trail(), ember(), glowLight()];
}
