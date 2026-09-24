import type { AreaGradeId } from '../contracts/level.ts';
import type { GradeParams } from '../contracts/render.ts';

/**
 * Per-area grades (ARCHITECTURE.md §5.4). Mood: serene · hushed · bittersweet · hopeful.
 * The five areas should read as one world breathing, not five filters: every grade stays within a
 * few percent of the glade baseline, and the zones' `blend` distance cross-fades them.
 *
 * glade    calm cool teal: the baseline, gentle contrast, soft vignette.
 * gully    colder and a little desaturated, a touch more contrast and vignette (tension).
 * rootwell deeper blue and darker, the strongest vignette (enclosed).
 * canopy   brighter moonlit cyan, open and airy, more bloom.
 * shrine   warm amber lift/gain, hopeful, bloom up.
 */
export const DEFAULT_GRADE: GradeParams = {
  exposure: 1, contrast: 1.03, saturation: 1, temperature: -0.06,
  lift: [0.004, 0.01, 0.018], gamma: [1, 1, 1], gain: [0.99, 1.01, 1.02], vignette: 0.3, bloomIntensity: 1,
};

export const AREA_GRADE_TABLE: Record<AreaGradeId, GradeParams> = {
  glade: {
    exposure: 1, contrast: 1.04, saturation: 1.02, temperature: -0.08,
    lift: [0.004, 0.012, 0.02], gamma: [1, 1, 1], gain: [0.98, 1.02, 1.03], vignette: 0.3, bloomIntensity: 1,
  },
  gully: {
    exposure: 0.96, contrast: 1.1, saturation: 0.86, temperature: -0.22,
    lift: [0, 0.008, 0.022], gamma: [0.98, 1, 1.02], gain: [0.95, 1, 1.05], vignette: 0.4, bloomIntensity: 0.9,
  },
  rootwell: {
    exposure: 0.88, contrast: 1.07, saturation: 0.92, temperature: -0.3,
    lift: [0, 0.006, 0.03], gamma: [0.96, 0.98, 1.04], gain: [0.9, 0.97, 1.08], vignette: 0.52, bloomIntensity: 1.05,
  },
  canopy: {
    exposure: 1.08, contrast: 1.02, saturation: 1.05, temperature: -0.12,
    lift: [0.006, 0.016, 0.024], gamma: [1.02, 1.02, 1.02], gain: [0.98, 1.04, 1.06], vignette: 0.22, bloomIntensity: 1.25,
  },
  shrine: {
    exposure: 1.05, contrast: 1.03, saturation: 1.04, temperature: 0.14,
    lift: [0.026, 0.01, 0.009], gamma: [1.04, 0.99, 0.98], gain: [1.08, 0.985, 0.94], vignette: 0.26, bloomIntensity: 1.3,
  },
};
