import type { FogLayerDef } from '../../contracts/assets.ts';
import { hexToRgb, parseHexColor, type RGB } from '../../core/color.ts';

/**
 * Low mist band model, mirrored by the fog shader in `fog.ts`. The band spans y ± height in layer
 * space. Its lower part is dense; toward the top a rising threshold erodes it into rolling wisps,
 * and the wisp crests catch a little moonlight. Two value-noise lookups, no loops (§6).
 */
export const FOG_SHAPE = Object.freeze({
  /** Noise frequencies (per layer unit) and drift. */
  fx: 0.0048,
  fy: 0.016,
  /** Noise threshold at the base and at the top of the band. */
  thrBase: 0.22,
  thrTop: 0.78,
  /** Softness of the threshold. */
  soft: 0.34,
  /** Crest brightening toward the top of the band. */
  crest: 0.35,
});

export interface FogBandParams {
  color: RGB;
  density: number;
  y: number;
  height: number;
  speed: number;
}

export function fogBandParams(def: FogLayerDef): FogBandParams {
  return { color: hexToRgb(parseHexColor(def.fogColor)), density: def.density, y: def.y, height: def.height, speed: def.speed };
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Premultiplied RGBA of the band at layer-space (lx, ly). `noise` mirrors GLSL `sw_vnoise` in [0, 1]. */
export function shadeFog(
  out: Float32Array | number[], lx: number, ly: number, time: number, p: FogBandParams, noise: (x: number, y: number) => number,
): void {
  const v = (ly - p.y) / p.height;
  const s = FOG_SHAPE;
  const px = (lx + time * p.speed) * s.fx;
  const py = ly * s.fy;
  const n = noise(px, py) * 0.6 + noise(px * 2.6 + time * 0.03, py * 2.1 + 5.2) * 0.4;
  const top = 1 - smooth(-0.95, 0.35, v);
  const thr = s.thrBase + (s.thrTop - s.thrBase) * top;
  const a = p.density * smooth(thr - s.soft * 0.5, thr + s.soft * 0.5, n) * smooth(-1, -0.7, v) * (1 - smooth(0.55, 1, v));
  const k = 1 + s.crest * top;
  out[0] = p.color[0] * k * a;
  out[1] = p.color[1] * k * a;
  out[2] = p.color[2] * k * a;
  out[3] = a;
}
