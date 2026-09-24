import { describe, expect, test } from 'vitest';
import { AREA_GRADES, type GradeZoneDef, type LevelData } from '../../src/contracts/level.ts';
import { SIM_DT } from '../../src/config.ts';
import { BenchRunner, benchWaypoints, type BenchWaypoint } from '../../src/debug/bench.ts';
import { FrameTimer, sortedPercentile, sortedWorstPercentMean } from '../../src/debug/frameTimer.ts';
import { levelFromAscii } from '../shared/fixtures.ts';

function forestLike(): LevelData {
  const rows: string[] = [];
  for (let y = 0; y < 50; y++) rows.push(y >= 46 ? '#'.repeat(200) : '.'.repeat(200));
  const level = levelFromAscii(rows);
  const T = level.tileSize;
  const zones: [number, number, number, number][] = [
    [0, 20, 40, 30], [40, 18, 36, 32], [76, 4, 24, 46], [100, 2, 60, 30], [160, 16, 40, 34],
  ];
  level.gradeZones = zones.map(([x, y, w, h], i): GradeZoneDef => ({
    id: i, grade: AREA_GRADES[i] as GradeZoneDef['grade'], x: x * T, y: y * T, w: w * T, h: h * T, blend: 240,
  }));
  return level;
}

describe('FrameTimer', () => {
  test('averages, fps and the 1% low', () => {
    const ft = new FrameTimer(100);
    for (let i = 0; i < 99; i++) ft.frame(10, 0, 1, 0.2, 2);
    ft.frame(50, 2, 3, 0.6, 4);
    const s = ft.refresh();
    expect(s.frameMsAvg).toBeCloseTo((99 * 10 + 50) / 100, 9);
    expect(s.fps).toBeCloseTo(1000 / s.frameMsAvg, 9);
    expect(s.frameMs1pLow).toBe(50);
    expect(s.simMs).toBeCloseTo((99 * 0.2 + 0.6) / 100, 9);
    expect(s.renderCpuMs).toBeCloseTo((99 * 2 + 4) / 100, 9);
    expect(s.simStepsLastFrame).toBe(3);
    expect(s.lateFramePct).toBeCloseTo(1, 9);
  });

  test('ring buffer keeps only the last window', () => {
    const ft = new FrameTimer(10);
    for (let i = 0; i < 10; i++) ft.frame(40, 1, 1, 0, 0);
    for (let i = 0; i < 10; i++) ft.frame(16, 0, 1, 0, 0);
    const s = ft.refresh();
    expect(s.frameMsAvg).toBe(16);
    expect(s.lateFramePct).toBe(0);
    expect(s.frameMs1pLow).toBe(16);
  });

  test('percentiles interpolate between ranks', () => {
    const ft = new FrameTimer(240);
    for (let i = 1; i <= 101; i++) ft.frame(i, 0, 1, 0, 0);
    expect(ft.percentile(0)).toBe(1);
    expect(ft.percentile(50)).toBe(51);
    expect(ft.percentile(95)).toBe(96);
    expect(ft.percentile(100)).toBe(101);
    expect(ft.percentile(99.5)).toBeCloseTo(100.5, 9);
  });

  test('late-frame % counts frames with any missed deadline', () => {
    const ft = new FrameTimer(200);
    for (let i = 0; i < 200; i++) ft.frame(16.7, i % 50 === 0 ? 3 : 0, 1, 0, 0);
    expect(ft.refresh().lateFramePct).toBeCloseTo(2, 9);
  });

  test('empty and reset', () => {
    const ft = new FrameTimer(8);
    expect(ft.refresh().fps).toBe(0);
    expect(Number.isNaN(ft.percentile(50))).toBe(true);
    ft.frame(20, 1, 2, 1, 1);
    ft.reset();
    expect(ft.refresh().frameMsAvg).toBe(0);
    expect(ft.stats.lateFramePct).toBe(0);
  });

  test('sorted helpers', () => {
    const a = new Float64Array([1, 2, 3, 4]);
    expect(sortedPercentile(a, 4, 50)).toBe(2.5);
    expect(sortedWorstPercentMean(a, 4)).toBe(4);
    expect(sortedWorstPercentMean(Float64Array.from({ length: 300 }, (_, i) => i), 300)).toBeCloseTo(298, 9);
  });
});

describe('BenchRunner path', () => {
  const level = forestLike();
  const bench = new BenchRunner(level, 30);
  const samples: BenchWaypoint[] = [];
  for (let t = 0; t <= 30 + 1e-9; t += SIM_DT) samples.push(bench.positionAt(t, { x: 0, y: 0 }));

  test('stays inside the level at a comfortable height', () => {
    for (const p of samples) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(level.pxWidth);
      expect(p.y).toBeGreaterThanOrEqual(540 - 1e-6);
      expect(p.y).toBeLessThanOrEqual(level.pxHeight - 540 + 1e-6);
    }
  });

  test('covers the level from edge to edge', () => {
    const first = samples[0] as BenchWaypoint;
    const last = samples[samples.length - 1] as BenchWaypoint;
    expect(first.x).toBeCloseTo(960, 6);
    expect(last.x).toBeCloseTo(level.pxWidth - 960, 6);
  });

  test('visits every grade zone', () => {
    for (const z of level.gradeZones) {
      const inside = samples.some((p) => p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h);
      expect(inside, `zone ${z.grade}`).toBe(true);
    }
    const wps = benchWaypoints(level);
    for (const z of level.gradeZones) {
      const cx = z.x + z.w / 2;
      expect(wps.some((w) => Math.abs(w.x - cx) < 1e-6), `waypoint for ${z.grade}`).toBe(true);
    }
  });

  test('monotonic progress, continuous and eased', () => {
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1] as BenchWaypoint;
      const b = samples[i] as BenchWaypoint;
      expect(b.x).toBeGreaterThanOrEqual(a.x - 1e-9);
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(40);
    }
    const start = Math.hypot((samples[1] as BenchWaypoint).x - (samples[0] as BenchWaypoint).x, (samples[1] as BenchWaypoint).y - (samples[0] as BenchWaypoint).y);
    const mid = samples.length >> 1;
    const middle = Math.hypot((samples[mid + 1] as BenchWaypoint).x - (samples[mid] as BenchWaypoint).x, (samples[mid + 1] as BenchWaypoint).y - (samples[mid] as BenchWaypoint).y);
    expect(start).toBeLessThan(middle * 0.05);
  });

  test('done after the duration, deterministic', () => {
    const b = new BenchRunner(level, 2);
    const p = { x: 0, y: 0 };
    for (let tick = 0; tick < 119; tick++) b.positionAt(tick * SIM_DT, p);
    expect(b.done).toBe(false);
    b.positionAt(2, p);
    expect(b.done).toBe(true);
    const q = new BenchRunner(level, 2).positionAt(1.234, { x: 0, y: 0 });
    expect(new BenchRunner(level, 2).positionAt(1.234, { x: 0, y: 0 })).toEqual(q);
  });

  test('falls back without grade zones', () => {
    const plain = levelFromAscii(['.'.repeat(80), '.C......G.'.padEnd(80, '.'), '#'.repeat(80)]);
    const b = new BenchRunner(plain, 5);
    const p = b.positionAt(2.5, { x: 0, y: 0 });
    expect(p.x).toBeGreaterThan(0);
    expect(p.x).toBeLessThan(plain.pxWidth);
    expect(Number.isFinite(p.y)).toBe(true);
  });
});

describe('BenchRunner results', () => {
  test('summary statistics', () => {
    const b = new BenchRunner(forestLike(), 1);
    for (let i = 0; i < 98; i++) b.record(16, 0, 1, 8);
    b.record(40, 1, 0.9, -1);
    b.record(50, 2, 0.8, 12);
    const r = b.result('auto', 'Iris Xe', 'test');
    expect(r.frames).toBe(100);
    expect(r.seconds).toBeCloseTo((98 * 16 + 90) / 1000, 9);
    expect(r.fpsAvg).toBeCloseTo(100 / r.seconds, 9);
    expect(r.fps1pLow).toBeCloseTo(1000 / 50, 9);
    expect(r.frameMsP50).toBe(16);
    expect(r.frameMsP99).toBeCloseTo(40.1, 9);
    expect(r.lateFramePct).toBe(2);
    expect(r.renderScaleAvg).toBeCloseTo((98 + 0.9 + 0.8) / 100, 9);
    expect(r.gpuMsAvg).toBeCloseTo((98 * 8 + 12) / 99, 9);
    expect(r).toMatchObject({ preset: 'auto', gpu: 'Iris Xe', userAgent: 'test' });
  });

  test('grows past its initial capacity', () => {
    const b = new BenchRunner(forestLike(), 0.1);
    for (let i = 0; i < 1000; i++) b.record(1 + (i % 3), 0, 1, -1);
    const r = b.result('high', '', '');
    expect(r.frames).toBe(1000);
    expect(r.gpuMsAvg).toBe(-1);
    expect(r.frameMsP50).toBe(2);
  });

  test('empty result is finite', () => {
    const r = new BenchRunner(forestLike(), 1).result('low', '', '');
    expect(r.frames).toBe(0);
    expect(r.fpsAvg).toBe(0);
    expect(r.lateFramePct).toBe(0);
  });
});
