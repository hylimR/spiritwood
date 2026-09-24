import type { GradeParams } from '../../contracts/render.ts';
import type { RGB } from '../../core/color.ts';

/**
 * Constants and a CPU reference of the composite grade (composite.glsl.ts interpolates the same
 * constants, so the shader and this function stay in lockstep). Used by previews and tests.
 */
export const GRADE = Object.freeze({
  /** Contrast pivots around a dark mid-grey: the night scene lives mostly below 0.35. */
  contrastPivot: 0.22,
  /** Per-channel gain slope of `temperature` (+ = warm). */
  tempR: 0.14,
  tempG: 0.025,
  tempB: -0.14,
  /** Highlights above this roll off smoothly toward 1 instead of clipping. */
  shoulder: 0.78,
  /** Vignette ramps from this normalised radius (1 = the corners) to 1. */
  vignetteInner: 0.32,
  /** Colour the vignette darkens toward (a deep, cool falloff rather than black). */
  vignetteTint: [0.14, 0.2, 0.32] as const,
});

function shoulder(x: number): number {
  const s = GRADE.shoulder;
  if (x <= s) return x;
  const k = 1 - s;
  return s + k * (1 - Math.exp(-(x - s) / k));
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/**
 * Grade one pixel exactly as the composite does (minus dither): scene + bloom·intensity → exposure →
 * temperature → lift/gamma/gain → contrast → saturation → highlight shoulder → death fade → vignette.
 * `radius` is the normalised distance from the screen centre (1 at the corners).
 */
export function gradePixel(
  out: RGB, scene: Readonly<RGB>, bloom: Readonly<RGB>, p: GradeParams, fade: number, fogDeep: Readonly<RGB>,
  radius: number,
): RGB {
  const temp = [GRADE.tempR, GRADE.tempG, GRADE.tempB];
  const c = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let v = (scene[i] as number) + (bloom[i] as number) * p.bloomIntensity;
    v *= p.exposure;
    v *= Math.max(0, 1 + (temp[i] as number) * p.temperature);
    v = Math.max(0, v * (p.gain[i] as number) + (p.lift[i] as number) * (1 - Math.min(v, 1)));
    v = Math.pow(v, 1 / Math.max(1e-3, p.gamma[i] as number));
    v = Math.max(0, (v - GRADE.contrastPivot) * p.contrast + GRADE.contrastPivot);
    c[i] = v;
  }
  const l = 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
  const v = smooth(GRADE.vignetteInner, 1, radius) * p.vignette;
  for (let i = 0; i < 3; i++) {
    let x = Math.max(0, l + ((c[i] as number) - l) * p.saturation);
    x = shoulder(x);
    x += ((fogDeep[i] as number) - x) * fade;
    x *= 1 + ((GRADE.vignetteTint[i] as number) - 1) * v;
    out[i] = x;
  }
  return out;
}
