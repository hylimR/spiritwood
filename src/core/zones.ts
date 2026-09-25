import { AREA_GRADES, type AreaGradeId, type GradeZoneDef } from '../contracts/level.ts';

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

export type AreaWeights = Record<AreaGradeId, number>;

export function createAreaWeights(): AreaWeights {
  const w = {} as AreaWeights;
  for (let i = 0; i < AREA_GRADES.length; i++) w[AREA_GRADES[i] as AreaGradeId] = 0;
  return w;
}

/**
 * Per-area weights at (x, y), normalised like the grade blend: zone weights are summed per area and
 * divided by max(1, total). Returns the uncovered remainder (1 − total when total < 1, else 0), which
 * the caller gives to its fallback. Writes `out` without allocating.
 */
export function areaWeights(out: AreaWeights, zones: readonly GradeZoneDef[], x: number, y: number): number {
  for (let i = 0; i < AREA_GRADES.length; i++) out[AREA_GRADES[i] as AreaGradeId] = 0;
  let total = 0;
  for (let i = 0; i < zones.length; i++) {
    const z = zones[i] as GradeZoneDef;
    const w = zoneWeight(z, x, y);
    if (w <= 0) continue;
    out[z.grade] += w;
    total += w;
  }
  if (total > 1) {
    for (let i = 0; i < AREA_GRADES.length; i++) out[AREA_GRADES[i] as AreaGradeId] /= total;
    return 0;
  }
  return 1 - total;
}
