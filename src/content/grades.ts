import type { AreaGradeId } from '../contracts/level.ts';
import type { GradeParams } from '../contracts/render.ts';
import { createGradeParams } from '../render/post/grade.ts';

/**
 * Per-area grades (ARCHITECTURE.md §5.4). Mood: serene · hushed · bittersweet · hopeful.
 * glade = cool teal calm; gully = colder, desaturated, tense; rootwell = deep blue, darker;
 * canopy = brighter moonlit cyan; shrine = warm amber hope. PIPE tunes the numbers.
 */
export const DEFAULT_GRADE: GradeParams = createGradeParams();

export const AREA_GRADE_TABLE: Record<AreaGradeId, GradeParams> = {
  glade: createGradeParams(),
  gully: createGradeParams(),
  rootwell: createGradeParams(),
  canopy: createGradeParams(),
  shrine: createGradeParams(),
};
