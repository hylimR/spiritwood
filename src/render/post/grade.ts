import type { AreaGradeId, GradeZoneDef } from '../../contracts/level.ts';
import type { GradeParams } from '../../contracts/render.ts';

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
 * Weight of a zone at (x, y): 1 inside the rect, smoothstep falloff to 0 at `blend` units outside
 * (Euclidean distance to the rect). A zone with blend ≤ 0 has a hard edge.
 */
export function zoneWeight(z: GradeZoneDef, x: number, y: number): number {
  const dx = Math.max(z.x - x, 0, x - (z.x + z.w));
  const dy = Math.max(z.y - y, 0, y - (z.y + z.h));
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= 0) return 1;
  if (z.blend <= 0 || d >= z.blend) return 0;
  const t = 1 - d / z.blend;
  return t * t * (3 - 2 * t);
}

function accumulate(out: GradeParams, g: GradeParams, w: number): void {
  out.exposure += g.exposure * w;
  out.contrast += g.contrast * w;
  out.saturation += g.saturation * w;
  out.temperature += g.temperature * w;
  out.vignette += g.vignette * w;
  out.bloomIntensity += g.bloomIntensity * w;
  for (let i = 0; i < 3; i++) {
    out.lift[i] = (out.lift[i] as number) + (g.lift[i] as number) * w;
    out.gamma[i] = (out.gamma[i] as number) + (g.gamma[i] as number) * w;
    out.gain[i] = (out.gain[i] as number) + (g.gain[i] as number) * w;
  }
}

/**
 * Blend area grades at world point (x, y): each zone's weight is 1 inside its rect and falls off
 * smoothly to 0 at `blend` units outside; weights are normalised. No zone → `fallback`. Writes `out`
 * without allocating.
 *
 * Where the zone weights sum to less than 1 (inside a lone blend band), `fallback` takes the remaining
 * weight, so walking out of a zone fades continuously to the fallback instead of snapping to it.
 */
export function blendGrades(
  out: GradeParams, zones: readonly GradeZoneDef[], x: number, y: number,
  table: Readonly<Record<AreaGradeId, GradeParams>>, fallback: GradeParams,
): GradeParams {
  let total = 0;
  for (let i = 0; i < zones.length; i++) total += zoneWeight(zones[i] as GradeZoneDef, x, y);
  if (total <= 0) return copyGrade(out, fallback);

  out.exposure = 0; out.contrast = 0; out.saturation = 0; out.temperature = 0; out.vignette = 0;
  out.bloomIntensity = 0;
  for (let i = 0; i < 3; i++) {
    out.lift[i] = 0;
    out.gamma[i] = 0;
    out.gain[i] = 0;
  }
  const norm = total > 1 ? total : 1;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i] as GradeZoneDef;
    const w = zoneWeight(z, x, y);
    if (w > 0) accumulate(out, table[z.grade], w / norm);
  }
  if (total < 1) accumulate(out, fallback, 1 - total);
  return out;
}
