import { describe, expect, test } from 'vitest';
import { AREA_GRADES, type AreaGradeId, type GradeZoneDef } from '../../src/contracts/level.ts';
import type { GradeParams } from '../../src/contracts/render.ts';
import { AREA_GRADE_TABLE, DEFAULT_GRADE } from '../../src/content/grades.ts';
import { blendGrades, copyGrade, createGradeParams, zoneWeight } from '../../src/render/post/grade.ts';
import { GRADE, gradePixel } from '../../src/render/post/gradeMath.ts';
import {
  BLOOM_DOWN_FRAGMENT, BLOOM_UP_FRAGMENT, COMPOSITE_FRAGMENT, FULLSCREEN_VERTEX,
} from '../../src/render/post/post.glsl.ts';
import type { RGB } from '../../src/core/color.ts';

function grade(exposure: number, lift = 0): GradeParams {
  const g = createGradeParams();
  g.exposure = exposure;
  g.contrast = exposure * 2;
  g.saturation = exposure * 3;
  g.temperature = exposure - 1;
  g.vignette = exposure / 10;
  g.bloomIntensity = exposure + 0.5;
  g.lift = [lift, lift * 2, lift * 3];
  g.gamma = [exposure, exposure, exposure];
  g.gain = [exposure, 1, 2 - exposure];
  return g;
}

const TABLE: Record<AreaGradeId, GradeParams> = {
  glade: grade(1), gully: grade(0.5, 0.1), rootwell: grade(0.8), canopy: grade(1.2), veil: grade(0.9, 0.05),
  shrine: grade(1.4, 0.2),
};
const FALLBACK = grade(2);

function zone(id: number, g: AreaGradeId, x: number, y: number, w: number, h: number, blend: number): GradeZoneDef {
  return { id, grade: g, x, y, w, h, blend };
}

function expectGrade(actual: GradeParams, expected: GradeParams): void {
  for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'vignette', 'bloomIntensity'] as const) {
    expect(actual[k], k).toBeCloseTo(expected[k], 9);
  }
  for (let i = 0; i < 3; i++) {
    expect(actual.lift[i]).toBeCloseTo(expected.lift[i] as number, 9);
    expect(actual.gamma[i]).toBeCloseTo(expected.gamma[i] as number, 9);
    expect(actual.gain[i]).toBeCloseTo(expected.gain[i] as number, 9);
  }
}

function mix(a: GradeParams, b: GradeParams, t: number): GradeParams {
  const out = createGradeParams();
  for (const k of ['exposure', 'contrast', 'saturation', 'temperature', 'vignette', 'bloomIntensity'] as const) {
    out[k] = a[k] + (b[k] - a[k]) * t;
  }
  for (let i = 0; i < 3; i++) {
    out.lift[i] = (a.lift[i] as number) + ((b.lift[i] as number) - (a.lift[i] as number)) * t;
    out.gamma[i] = (a.gamma[i] as number) + ((b.gamma[i] as number) - (a.gamma[i] as number)) * t;
    out.gain[i] = (a.gain[i] as number) + ((b.gain[i] as number) - (a.gain[i] as number)) * t;
  }
  return out;
}

describe('blendGrades', () => {
  const zones = [zone(0, 'glade', 0, 0, 1000, 1000, 200), zone(1, 'gully', 1000, 0, 1000, 1000, 200)];

  test('inside a zone → that grade', () => {
    const out = createGradeParams();
    expectGrade(blendGrades(out, zones, 500, 500, TABLE, FALLBACK), TABLE.glade);
    expectGrade(blendGrades(out, zones, 1500, 900, TABLE, FALLBACK), TABLE.gully);
  });

  test('no zone → fallback', () => {
    const out = createGradeParams();
    expectGrade(blendGrades(out, [], 0, 0, TABLE, FALLBACK), FALLBACK);
    expectGrade(blendGrades(out, zones, 5000, 5000, TABLE, FALLBACK), FALLBACK);
    expectGrade(blendGrades(out, zones, 500, 1200, TABLE, FALLBACK), FALLBACK);
  });

  test('blend band falls off smoothly toward the fallback', () => {
    const out = createGradeParams();
    const z = zone(0, 'canopy', 0, 0, 100, 100, 200);
    expect(zoneWeight(z, 50, 50)).toBe(1);
    expect(zoneWeight(z, 100, 50)).toBe(1);
    expect(zoneWeight(z, 200, 50)).toBeCloseTo(0.5, 9);
    expect(zoneWeight(z, 150, 50)).toBeGreaterThan(0.5);
    expect(zoneWeight(z, 300, 50)).toBe(0);
    expect(zoneWeight(z, 100 + 200 * Math.SQRT1_2, 100 + 200 * Math.SQRT1_2)).toBe(0);
    expectGrade(blendGrades(out, [z], 200, 50, TABLE, FALLBACK), mix(FALLBACK, TABLE.canopy, 0.5));
    let prev = 1;
    for (let x = 100; x <= 300; x += 5) {
      const w = zoneWeight(z, x, 50);
      expect(w).toBeLessThanOrEqual(prev + 1e-12);
      prev = w;
    }
    expect(zoneWeight(zone(0, 'canopy', 0, 0, 100, 100, 0), 100.01, 50)).toBe(0);
  });

  test('overlapping zones are normalised', () => {
    const out = createGradeParams();
    const a = zone(0, 'glade', 0, 0, 1000, 1000, 100);
    const b = zone(1, 'shrine', 500, 0, 1000, 1000, 100);
    expectGrade(blendGrades(out, [a, b], 700, 500, TABLE, FALLBACK), mix(TABLE.glade, TABLE.shrine, 0.5));
    const c = zone(2, 'rootwell', 600, 0, 1000, 1000, 100);
    const three = blendGrades(out, [a, b, c], 700, 500, TABLE, FALLBACK);
    expect(three.exposure).toBeCloseTo((TABLE.glade.exposure + TABLE.shrine.exposure + TABLE.rootwell.exposure) / 3, 9);
  });

  test('cross-fade between adjacent zones is continuous and symmetric', () => {
    const out = createGradeParams();
    const mid = blendGrades(out, zones, 1000, 500, TABLE, FALLBACK);
    expectGrade(mid, mix(TABLE.glade, TABLE.gully, 0.5));
    let prev = blendGrades(createGradeParams(), zones, 700, 500, TABLE, FALLBACK).exposure;
    for (let x = 705; x <= 1300; x += 5) {
      const e = blendGrades(out, zones, x, 500, TABLE, FALLBACK).exposure;
      expect(Math.abs(e - prev)).toBeLessThan(0.02);
      prev = e;
    }
  });

  test('does not mutate the table and reuses out', () => {
    const before = structuredClone(TABLE);
    const out = createGradeParams();
    const lift = out.lift;
    blendGrades(out, zones, 1000, 500, TABLE, FALLBACK);
    expect(TABLE).toEqual(before);
    expect(out.lift).toBe(lift);
    expect(copyGrade(createGradeParams(), TABLE.shrine)).toEqual(TABLE.shrine);
  });
});

describe('grade content', () => {
  test('every area has a grade, all subtle', () => {
    for (const id of AREA_GRADES) {
      const g = AREA_GRADE_TABLE[id];
      expect(g.exposure).toBeGreaterThan(0.8);
      expect(g.exposure).toBeLessThan(1.2);
      expect(Math.abs(g.contrast - 1)).toBeLessThan(0.15);
      expect(Math.abs(g.saturation - 1)).toBeLessThan(0.2);
      expect(Math.abs(g.temperature)).toBeLessThan(0.4);
      expect(g.vignette).toBeLessThan(0.6);
      for (let i = 0; i < 3; i++) {
        expect(Math.abs(g.lift[i] as number)).toBeLessThan(0.05);
        expect(Math.abs((g.gamma[i] as number) - 1)).toBeLessThan(0.1);
        expect(Math.abs((g.gain[i] as number) - 1)).toBeLessThan(0.12);
      }
    }
    expect(AREA_GRADE_TABLE.shrine.temperature).toBeGreaterThan(0);
    expect(AREA_GRADE_TABLE.gully.temperature).toBeLessThan(AREA_GRADE_TABLE.glade.temperature);
    expect(AREA_GRADE_TABLE.rootwell.exposure).toBeLessThan(AREA_GRADE_TABLE.glade.exposure);
    expect(AREA_GRADE_TABLE.rootwell.vignette).toBeGreaterThan(AREA_GRADE_TABLE.gully.vignette);
    expect(AREA_GRADE_TABLE.canopy.bloomIntensity).toBeGreaterThan(AREA_GRADE_TABLE.glade.bloomIntensity);
    expect(DEFAULT_GRADE.exposure).toBe(1);
  });
});

describe('post shaders', () => {
  test('GLSL ES 3.0 headers and the composite constants match the CPU reference', () => {
    for (const src of [FULLSCREEN_VERTEX, BLOOM_DOWN_FRAGMENT, BLOOM_UP_FRAGMENT, COMPOSITE_FRAGMENT]) {
      expect(src.startsWith('#version 300 es')).toBe(true);
    }
    for (const src of [BLOOM_DOWN_FRAGMENT, BLOOM_UP_FRAGMENT, COMPOSITE_FRAGMENT]) expect(src).toContain('precision highp float;');
    expect(COMPOSITE_FRAGMENT).toContain(`const float PIVOT = ${GRADE.contrastPivot};`);
    expect(COMPOSITE_FRAGMENT).toContain(`const float SHOULDER = ${GRADE.shoulder};`);
    expect(COMPOSITE_FRAGMENT).toContain(`const float VIGNETTE_INNER = ${GRADE.vignetteInner};`);
    expect(COMPOSITE_FRAGMENT).toContain('sw_dither(gl_FragCoord.xy)');
  });
});

describe('gradePixel (CPU reference of the composite)', () => {
  const black: RGB = [0, 0, 0];
  const fog: RGB = [0.04, 0.1, 0.18];

  test('identity grade is a no-op below the shoulder', () => {
    const out: RGB = [0, 0, 0];
    const id = createGradeParams();
    for (const v of [0, 0.05, 0.2, 0.5, GRADE.shoulder]) {
      gradePixel(out, [v, v * 0.5, v * 0.25], black, id, 0, fog, 0);
      expect(out[0]).toBeCloseTo(v, 6);
      expect(out[1]).toBeCloseTo(v * 0.5, 6);
      expect(out[2]).toBeCloseTo(v * 0.25, 6);
    }
  });

  test('highlights roll off below 1 and stay monotonic', () => {
    const out: RGB = [0, 0, 0];
    const id = createGradeParams();
    let prev = 0;
    for (let v = 0; v <= 4; v += 0.05) {
      gradePixel(out, [v, v, v], black, id, 0, fog, 0);
      expect(out[0]).toBeLessThan(1);
      expect(out[0]).toBeGreaterThanOrEqual(prev);
      prev = out[0];
    }
  });

  test('bloom adds before exposure; fade reaches fogDeep; vignette darkens corners only', () => {
    const out: RGB = [0, 0, 0];
    const g = createGradeParams();
    g.bloomIntensity = 0.5;
    g.exposure = 2;
    gradePixel(out, [0.1, 0.1, 0.1], [0.1, 0, 0], g, 0, fog, 0);
    expect(out[0]).toBeCloseTo(0.3, 6);
    expect(out[1]).toBeCloseTo(0.2, 6);
    gradePixel(out, [0.5, 0.2, 0.1], black, createGradeParams(), 1, fog, 0);
    expect(out).toEqual(fog.map((v) => expect.closeTo(v, 9)));
    const v = createGradeParams();
    v.vignette = 1;
    gradePixel(out, [0.4, 0.4, 0.4], black, v, 0, fog, GRADE.vignetteInner);
    expect(out[0]).toBeCloseTo(0.4, 9);
    gradePixel(out, [0.4, 0.4, 0.4], black, v, 0, fog, 1);
    expect(out[0]).toBeCloseTo(0.4 * (GRADE.vignetteTint[0] as number), 9);
    expect(out[2]).toBeGreaterThan(out[0]);
  });

  test('temperature warms or cools', () => {
    const warm: RGB = [0, 0, 0];
    const cool: RGB = [0, 0, 0];
    const g = createGradeParams();
    g.temperature = 0.5;
    gradePixel(warm, [0.3, 0.3, 0.3], black, g, 0, fog, 0);
    g.temperature = -0.5;
    gradePixel(cool, [0.3, 0.3, 0.3], black, g, 0, fog, 0);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });
});
