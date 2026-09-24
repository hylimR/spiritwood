import { describe, expect, test } from 'vitest';
import { MAX_ASPECT, MIN_ASPECT, VIEW_H } from '../../src/config.ts';
import { SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { QUALITY_PRESETS } from '../../src/settings/quality.ts';
import {
  createTargetLayout, fitCanvas, layoutSubRects, layoutTargets, MAX_BLOOM_PASSES, renderScaleCap,
} from '../../src/render/post/viewport.ts';
import { ScreenShake, SHAKE, traumaForEvent } from '../../src/render/post/shake.ts';

function ev(type: SimEvent['type'], b = 0): SimEvent {
  return { type, tick: 0, x: 0, y: 0, a: 0, b, id: -1 };
}

describe('fitCanvas (letterbox maths)', () => {
  test('16:9 fills exactly', () => {
    const f = fitCanvas(1920, 1080, 1, 1);
    expect(f).toMatchObject({ cssWidth: 1920, cssHeight: 1080, pixelWidth: 1920, pixelHeight: 1080, pixelRatio: 1, viewH: VIEW_H });
    expect(f.viewW).toBeCloseTo(1920, 9);
  });

  test('too wide → pillar-box at MAX_ASPECT', () => {
    const f = fitCanvas(3440, 1000, 1, 1);
    expect(f.cssHeight).toBe(1000);
    expect(f.cssWidth).toBe(Math.floor(1000 * MAX_ASPECT));
    expect(f.aspect).toBeCloseTo(MAX_ASPECT, 2);
    expect(f.viewW).toBeCloseTo(VIEW_H * f.aspect, 9);
  });

  test('too tall → letterbox at MIN_ASPECT', () => {
    const f = fitCanvas(800, 1200, 1, 1);
    expect(f.cssWidth).toBe(800);
    expect(f.cssHeight).toBe(600);
    expect(f.aspect).toBeCloseTo(MIN_ASPECT, 9);
    expect(f.viewW).toBeCloseTo(1440, 9);
  });

  test('aspect always clamped and the rect always fits', () => {
    for (const [w, h] of [[300, 1000], [1000, 300], [1366, 768], [2560, 1080], [1024, 768], [1, 1], [5000, 100]] as const) {
      for (const dpr of [1, 1.25, 2, 3]) {
        const f = fitCanvas(w, h, dpr, 1.5);
        expect(f.aspect).toBeGreaterThanOrEqual(MIN_ASPECT - 1e-9);
        expect(f.aspect).toBeLessThanOrEqual(MAX_ASPECT + 1e-9);
        expect(f.cssWidth).toBeLessThanOrEqual(w + 1e-9);
        expect(f.cssHeight).toBeLessThanOrEqual(h + 1e-9);
        expect(f.pixelRatio).toBe(Math.min(dpr, 1.5));
        expect(f.pixelWidth).toBe(Math.round(f.cssWidth * f.pixelRatio));
        expect(Number.isInteger(f.pixelWidth) && Number.isInteger(f.pixelHeight)).toBe(true);
      }
    }
  });

  test('pixel ratio is capped', () => {
    expect(fitCanvas(1280, 720, 2, 1.5).pixelWidth).toBe(1920);
    expect(fitCanvas(1280, 720, 2, 1).pixelWidth).toBe(1280);
    expect(fitCanvas(1280, 720, 1.25, 2).pixelWidth).toBe(1600);
  });

  test('degenerate input is safe', () => {
    const f = fitCanvas(0, -5, Number.NaN, 0);
    expect(f.pixelWidth).toBeGreaterThanOrEqual(1);
    expect(f.pixelHeight).toBeGreaterThanOrEqual(1);
    expect(Number.isFinite(f.viewW)).toBe(true);
  });
});

describe('render target layout', () => {
  test('scale cap keeps the scene within maxRenderPixels', () => {
    expect(renderScaleCap(1920, 1080, 2560 * 1440)).toBe(1);
    const s = renderScaleCap(3840, 2160, 2560 * 1440);
    expect(3840 * s * 2160 * s).toBeCloseTo(2560 * 1440, 3);
  });

  test('1080p layouts per quality level', () => {
    const rows: string[] = [];
    for (const level of ['high', 'medium', 'low'] as const) {
      const q = QUALITY_PRESETS[level];
      const maxScale = Math.min(q.renderScale, renderScaleCap(1920, 1080, q.maxRenderPixels));
      const l = layoutSubRects(layoutTargets(createTargetLayout(), 1920, 1080, maxScale, q.bloomScale, q.bloomPasses), 1920, 1080, maxScale, q.bloomScale);
      expect(l.sceneW * l.sceneH).toBeLessThanOrEqual(q.maxRenderPixels);
      expect(l.sceneW).toBe(l.sceneAllocW);
      const chain: string[] = [];
      for (let k = 0; k <= q.bloomPasses; k++) chain.push(`${l.allocW[k]}×${l.allocH[k]}`);
      rows.push(`${level}: scene ${l.sceneAllocW}×${l.sceneAllocH}, glow/bloom ${chain.join(' → ')}`);
    }
    expect(rows).toEqual([
      'high: scene 1920×1080, glow/bloom 960×540 → 480×270 → 240×135 → 120×68 → 60×34',
      'medium: scene 1600×900, glow/bloom 800×450 → 400×225 → 200×113 → 100×57',
      'low: scene 1280×720, glow/bloom 320×180 → 160×90 → 80×45',
    ]);
  });

  test('sub-rects shrink with the render scale and never exceed the allocation', () => {
    const l = layoutTargets(createTargetLayout(), 1920, 1080, 1, 0.5, 4);
    for (let s = 1; s >= 0.5 - 1e-9; s -= 0.05) {
      layoutSubRects(l, 1920, 1080, s, 0.5);
      expect(l.sceneW).toBe(Math.round(1920 * s));
      expect(l.sceneW).toBeLessThanOrEqual(l.sceneAllocW);
      for (let k = 0; k <= MAX_BLOOM_PASSES; k++) {
        expect(l.subW[k]).toBeLessThanOrEqual(l.allocW[k] as number);
        expect(l.subH[k]).toBeLessThanOrEqual(l.allocH[k] as number);
        expect(l.subW[k]).toBeGreaterThanOrEqual(1);
      }
    }
    layoutSubRects(l, 1920, 1080, 2, 0.5);
    expect(l.sceneW).toBe(l.sceneAllocW);
  });
});

describe('screen shake', () => {
  test('event trauma', () => {
    expect(traumaForEvent(ev(SimEventType.Land, SHAKE.landMinFall - 1))).toBe(0);
    expect(traumaForEvent(ev(SimEventType.Land, SHAKE.landMinFall))).toBeCloseTo(SHAKE.landBase, 9);
    expect(traumaForEvent(ev(SimEventType.Land, 5000))).toBe(SHAKE.landMax);
    expect(traumaForEvent(ev(SimEventType.Died))).toBe(0.45);
    expect(traumaForEvent(ev(SimEventType.EnemyStomped))).toBe(0.25);
    expect(traumaForEvent(ev(SimEventType.Jump))).toBe(0);
  });

  test('bounded, decays, deterministic', () => {
    const a = new ScreenShake(7);
    const b = new ScreenShake(7);
    a.add(0.8);
    a.add(0.8);
    b.add(1);
    expect(a.trauma).toBe(1);
    let t = 0;
    let moved = false;
    for (let i = 0; i < 60; i++) {
      t += 1 / 60;
      a.update(1 / 60, t);
      b.update(1 / 60, t);
      expect(Math.abs(a.x)).toBeLessThanOrEqual(SHAKE.maxOffset);
      expect(Math.abs(a.y)).toBeLessThanOrEqual(SHAKE.maxOffset);
      expect(a.x).toBe(b.x);
      if (Math.abs(a.x) > 0.5) moved = true;
    }
    expect(moved).toBe(true);
    expect(a.trauma).toBe(0);
    expect(a.x).toBe(0);
    expect(a.y).toBe(0);
  });

  test('offsets are smooth frame to frame', () => {
    const s = new ScreenShake(3);
    s.add(1);
    let prevX = 0;
    let t = 0;
    for (let i = 0; i < 20; i++) {
      t += 1 / 120;
      s.update(1 / 120, t);
      if (i > 0) expect(Math.abs(s.x - prevX)).toBeLessThan(SHAKE.maxOffset * 0.6);
      prevX = s.x;
    }
  });
});
