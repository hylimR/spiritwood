import type { AreaGradeId, GradeZoneDef } from '../../contracts/level.ts';
import type { GradeParams } from '../../contracts/render.ts';
import { todo } from '../../core/todo.ts';

export function createGradeParams(): GradeParams {
  return {
    exposure: 1, contrast: 1, saturation: 1, temperature: 0,
    lift: [0, 0, 0], gamma: [1, 1, 1], gain: [1, 1, 1], vignette: 0, bloomIntensity: 1,
  };
}

export function copyGrade(out: GradeParams, src: GradeParams): GradeParams {
  out.exposure = src.exposure; out.contrast = src.contrast; out.saturation = src.saturation;
  out.temperature = src.temperature; out.vignette = src.vignette; out.bloomIntensity = src.bloomIntensity;
  for (let i = 0; i < 3; i++) {
    out.lift[i] = src.lift[i] as number;
    out.gamma[i] = src.gamma[i] as number;
    out.gain[i] = src.gain[i] as number;
  }
  return out;
}

/**
 * Blend area grades at world point (x, y): each zone's weight is 1 inside its rect and falls off
 * smoothly to 0 at `blend` units outside; weights are normalised. No zone → `fallback`. Writes `out`
 * without allocating.
 */
export function blendGrades(
  out: GradeParams, zones: readonly GradeZoneDef[], x: number, y: number,
  table: Readonly<Record<AreaGradeId, GradeParams>>, fallback: GradeParams,
): GradeParams {
  void out; void zones; void x; void y; void table; void fallback;
  return todo('PIPE', 'blendGrades');
}
