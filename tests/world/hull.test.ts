import { describe, expect, test } from 'vitest';
import { computeSplitHull, splitRowsAt, subdivideRows, type HullOptions } from '../../src/render/gen/hull.ts';
import { Rng } from '../../src/core/rng.ts';

/** Coverage count per texel (how many rects cover it) and which kind covers it. */
function rasterize(w: number, h: number, core: number[], soft: number[]): { count: Uint8Array; kind: Int8Array } {
  const count = new Uint8Array(w * h);
  const kind = new Int8Array(w * h).fill(-1);
  const paint = (rects: number[], k: number): void => {
    for (let i = 0; i < rects.length; i += 4) {
      const [x0, y0, x1, y1] = rects.slice(i, i + 4) as [number, number, number, number];
      expect(x0).toBeGreaterThanOrEqual(0);
      expect(y0).toBeGreaterThanOrEqual(0);
      expect(x1).toBeLessThanOrEqual(w);
      expect(y1).toBeLessThanOrEqual(h);
      expect(x1).toBeGreaterThan(x0);
      expect(y1).toBeGreaterThan(y0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          count[y * w + x] = (count[y * w + x] as number) + 1;
          kind[y * w + x] = k;
        }
      }
    }
  };
  paint(core, 1);
  paint(soft, 0);
  return { count, kind };
}

function disc(w: number, h: number, cx: number, cy: number, r: number, soft: number): Uint8Array {
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r;
      a[y * w + x] = Math.round(Math.min(1, Math.max(0, 0.5 - d / soft)) * 255);
    }
  }
  return a;
}

function erodedOpaque(alpha: Uint8Array, w: number, h: number, r: number, x: number, y: number): boolean {
  for (let j = y - r; j <= y + r; j++) {
    for (let i = x - r; i <= x + r; i++) {
      if (i < 0 || j < 0 || i >= w || j >= h) return false;
      if ((alpha[j * w + i] as number) < 254) return false;
    }
  }
  return true;
}

function checkInvariants(alpha: Uint8Array, w: number, h: number, opts: HullOptions): ReturnType<typeof computeSplitHull> {
  const hull = computeSplitHull(alpha, w, h, opts);
  const { count, kind } = rasterize(w, h, hull.core, hull.soft);
  const inset = opts.coreInset ?? 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Never overlapping.
      expect(count[i]).toBeLessThanOrEqual(1);
      // Every visible texel covered.
      if ((alpha[i] as number) > 1) expect(count[i]).toBe(1);
      // Core only on eroded-opaque texels.
      if (kind[i] === 1) expect(erodedOpaque(alpha, w, h, inset, x, y)).toBe(true);
    }
  }
  return hull;
}

describe('computeSplitHull', () => {
  test('empty map → no rects', () => {
    const hull = computeSplitHull(new Uint8Array(32 * 32), 32, 32);
    expect(hull.core).toEqual([]);
    expect(hull.soft).toEqual([]);
  });

  test('fully opaque map → one core rect bounded by the inset and a soft frame', () => {
    const w = 48;
    const h = 40;
    const hull = checkInvariants(new Uint8Array(w * h).fill(255), w, h, { cell: 8, coreInset: 3, snap: 1 });
    expect(hull.core.length).toBeGreaterThan(0);
    expect(hull.coreArea).toBeGreaterThan(0.4 * w * h);
    expect(hull.coreArea + hull.softArea).toBe(w * h);
  });

  test('soft disc: invariants hold, a real core exists and soft is a band around it', () => {
    const w = 96;
    const h = 96;
    const alpha = disc(w, h, 48, 48, 36, 6);
    const hull = checkInvariants(alpha, w, h, { cell: 6, coreInset: 3, pad: 2 });
    expect(hull.coreArea).toBeGreaterThan(Math.PI * 25 * 25);
    expect(hull.softArea).toBeGreaterThan(0);
  });

  test('random blobs with holes, several option sets', () => {
    const rng = new Rng(42);
    for (let trial = 0; trial < 6; trial++) {
      const w = 40 + rng.int(0, 60);
      const h = 40 + rng.int(0, 60);
      const alpha = new Uint8Array(w * h);
      for (let b = 0; b < 5; b++) {
        const d = disc(w, h, rng.range(0, w), rng.range(0, h), rng.range(4, 24), rng.range(0.5, 8));
        for (let i = 0; i < d.length; i++) alpha[i] = Math.max(alpha[i] as number, d[i] as number);
      }
      const hole = disc(w, h, w / 2, h / 2, 6, 1);
      for (let i = 0; i < hole.length; i++) alpha[i] = Math.round((alpha[i] as number) * (1 - (hole[i] as number) / 255));
      checkInvariants(alpha, w, h, { cell: 1 + rng.int(3, 9), coreInset: rng.int(1, 5), pad: rng.int(0, 4), maxSpans: rng.int(1, 4) });
    }
  });

  test('respects maxSpans per column', () => {
    const w = 8;
    const h = 64;
    const alpha = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) if (Math.floor(y / 6) % 2 === 0) for (let x = 0; x < w; x++) alpha[y * w + x] = 255;
    const hull = computeSplitHull(alpha, w, h, { cell: 8, maxSpans: 2, minGap: 1, snap: 1, minCore: 64 });
    expect(hull.core.length).toBe(0);
    expect(hull.soft.length / 4).toBe(2);
    checkInvariants(alpha, w, h, { cell: 8, maxSpans: 2, minGap: 1, snap: 1 });
  });

  test('merges equal adjacent columns into wide rects', () => {
    const w = 64;
    const h = 32;
    const alpha = new Uint8Array(w * h);
    for (let y = 8; y < 24; y++) for (let x = 0; x < w; x++) alpha[y * w + x] = 128;
    const hull = computeSplitHull(alpha, w, h, { cell: 8 });
    expect(hull.soft).toEqual([0, 8, 64, 24]);
  });

  test('is deterministic', () => {
    const alpha = disc(80, 60, 30, 30, 20, 4);
    expect(computeSplitHull(alpha, 80, 60, { cell: 6, coreInset: 3 })).toEqual(computeSplitHull(alpha, 80, 60, { cell: 6, coreInset: 3 }));
  });
});

describe('row splitting', () => {
  test('subdivideRows splits on the global grid and preserves area', () => {
    const out = subdivideRows([0, 5, 10, 70], 24);
    expect(out).toEqual([0, 5, 10, 24, 0, 24, 10, 48, 0, 48, 10, 70]);
  });

  test('splitRowsAt splits only straddling rects', () => {
    expect(splitRowsAt([0, 0, 4, 10, 0, 10, 4, 20], 6)).toEqual([0, 0, 4, 6, 0, 6, 4, 10, 0, 10, 4, 20]);
  });
});
