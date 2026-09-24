import { describe, expect, test } from 'vitest';
import { Noise } from '../../src/render/gen/noise.ts';
import { coverage, sdBox, sdCapsule, sdCircle, smin } from '../../src/render/gen/sdf.ts';

describe('noise', () => {
  test('deterministic and bounded', () => {
    const a = new Noise(3);
    const b = new Noise(3);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 2000; i++) {
      const x = i * 0.137;
      const y = i * 0.071;
      const v = a.noise2(x, y);
      expect(v).toBe(b.noise2(x, y));
      min = Math.min(min, v);
      max = Math.max(max, v);
      const f = a.fbm(x, y, 5);
      expect(Math.abs(f)).toBeLessThanOrEqual(1.5);
      const r = a.ridged(x, y);
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
    expect(min).toBeLessThan(-0.3);
    expect(max).toBeGreaterThan(0.3);
    expect(max).toBeLessThanOrEqual(1.5);
  });

  test('zero at integer lattice points (gradient noise)', () => {
    const n = new Noise(9);
    expect(n.noise2(3, 7)).toBeCloseTo(0, 6);
  });
});

describe('sdf', () => {
  test('signs and distances', () => {
    expect(sdCircle(0, 0, 0, 0, 5)).toBe(-5);
    expect(sdCircle(10, 0, 0, 0, 5)).toBe(5);
    expect(sdBox(0, 0, 0, 0, 2, 2)).toBe(-2);
    expect(sdBox(5, 0, 0, 0, 2, 2)).toBe(3);
    expect(sdCapsule(0, 5, -10, 0, 10, 0, 1)).toBeCloseTo(4);
    expect(smin(1, 1, 0.5)).toBeLessThan(1);
    expect(coverage(-10, 1)).toBe(1);
    expect(coverage(10, 1)).toBe(0);
    expect(coverage(0, 1)).toBeCloseTo(0.5);
  });
});
