import { describe, expect, test } from 'vitest';
import { approach, clamp, damp, mod, smoothDamp, smoothstep, stepSpring } from '../../src/core/math.ts';
import { Rng, hashString } from '../../src/core/rng.ts';
import { hexToRgb, mixHex, parseHexColor } from '../../src/core/color.ts';

describe('math', () => {
  test('clamp/approach/mod/smoothstep', () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(approach(0, 10, 3)).toBe(3);
    expect(approach(9, 10, 3)).toBe(10);
    expect(approach(0, -10, 4)).toBe(-4);
    expect(mod(-1, 5)).toBe(4);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
  });

  test('smoothDamp converges without overshoot', () => {
    const s = { value: 0, velocity: 0 };
    let max = 0;
    for (let i = 0; i < 120; i++) {
      smoothDamp(s, 100, 0.2, 1 / 60);
      max = Math.max(max, s.value);
    }
    expect(s.value).toBeCloseTo(100, 1);
    expect(max).toBeLessThanOrEqual(100);
  });

  test('damp is framerate independent', () => {
    let a = 0;
    let b = 0;
    for (let i = 0; i < 60; i++) a = damp(a, 1, 5, 1 / 60);
    for (let i = 0; i < 120; i++) b = damp(b, 1, 5, 1 / 120);
    expect(a).toBeCloseTo(b, 6);
  });

  test('spring settles', () => {
    const s = { value: 0, velocity: 0 };
    for (let i = 0; i < 600; i++) stepSpring(s, 1, 200, 20, 1 / 60);
    expect(s.value).toBeCloseTo(1, 3);
  });
});

describe('rng', () => {
  test('deterministic per seed and in range', () => {
    const a = new Rng(42);
    const b = new Rng(42);
    for (let i = 0; i < 1000; i++) {
      const x = a.next();
      expect(x).toBe(b.next());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
    const r = new Rng(7);
    for (let i = 0; i < 1000; i++) {
      const n = r.int(2, 5);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
    }
    expect(new Rng(1).next()).not.toBe(new Rng(2).next());
  });

  test('hashString is stable', () => {
    expect(hashString('forest')).toBe(hashString('forest'));
    expect(hashString('forest')).not.toBe(hashString('forets'));
  });
});

describe('color', () => {
  test('hex conversions', () => {
    expect(parseHexColor('#0B1A2E')).toBe(0x0b1a2e);
    expect(() => parseHexColor('#12345')).toThrow();
    const [r, g, b] = hexToRgb(0xff8000);
    expect(r).toBe(1);
    expect(g).toBeCloseTo(128 / 255);
    expect(b).toBe(0);
    expect(mixHex(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  });
});
