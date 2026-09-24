import { describe, expect, test } from 'vitest';
import { ChunkStreamer, type StreamChunk } from '../../src/assets/streamer.ts';
import type { Extent } from '../../src/render/util/camera.ts';

/** A row of 10 chunks, 1000 units wide each, 1 MB each. */
function row(n = 10, bytes = 1_000_000): StreamChunk[] {
  const out: StreamChunk[] = [];
  for (let i = 0; i < n; i++) out.push({ key: `L:${i}:0`, x0: i * 1000, y0: 0, x1: (i + 1) * 1000, y1: 1000, bytes });
  return out;
}

const view = (x0: number, x1: number): Extent => ({ x0, y0: 100, x1, y1: 900 });
const keys = (list: StreamChunk[]): string[] => list.map((c) => c.key);

describe('ChunkStreamer', () => {
  test('visibility with margin: visible vs wanted', () => {
    const s = new ChunkStreamer(row(), { margin: 300, maxInFlight: 10, budgetBytes: 1e9 });
    s.update(view(2100, 3900), 1);
    expect(s.isVisible('L:2:0')).toBe(true);
    expect(s.isVisible('L:3:0')).toBe(true);
    expect(s.isVisible('L:1:0')).toBe(false);
    expect(s.isWanted('L:1:0')).toBe(true);
    expect(s.isWanted('L:4:0')).toBe(true);
    expect(s.isWanted('L:0:0')).toBe(false);
    expect(s.isWanted('L:5:0')).toBe(false);
  });

  test('loads nearest-first, capped by maxInFlight, and never re-requests loading chunks', () => {
    const s = new ChunkStreamer(row(), { margin: 1500, maxInFlight: 2, budgetBytes: 1e9 });
    s.update(view(4200, 4800), 1);
    const out: StreamChunk[] = [];
    expect(keys(s.nextLoads(out))).toEqual(['L:4:0', 'L:3:0']);
    for (const c of out.slice()) s.markLoading(c.key);
    expect(s.nextLoads(out)).toEqual([]);
    s.markLoaded('L:4:0');
    expect(keys(s.nextLoads(out))).toEqual(['L:5:0']);
    s.markLoading('L:5:0');
    s.markLoaded('L:3:0');
    s.markLoaded('L:5:0');
    expect(keys(s.nextLoads(out))).toEqual(['L:2:0', 'L:6:0']);
  });

  test('state transitions and byte accounting', () => {
    const s = new ChunkStreamer(row(3, 100), { margin: 0, maxInFlight: 2, budgetBytes: 1e9 });
    expect(s.state('L:0:0')).toBe('unloaded');
    s.markLoading('L:0:0');
    expect(s.state('L:0:0')).toBe('loading');
    expect(s.loadingCount).toBe(1);
    expect(s.loadedBytes).toBe(0);
    s.markLoaded('L:0:0');
    expect(s.state('L:0:0')).toBe('loaded');
    expect(s.loadingCount).toBe(0);
    expect(s.loadedBytes).toBe(100);
    s.markLoaded('L:0:0');
    expect(s.loadedBytes).toBe(100);
    s.markUnloaded('L:0:0');
    expect(s.state('L:0:0')).toBe('unloaded');
    expect(s.loadedBytes).toBe(0);
    // Cancelling an in-flight load frees its slot.
    s.markLoading('L:1:0');
    s.markUnloaded('L:1:0');
    expect(s.loadingCount).toBe(0);
    expect(() => s.state('nope')).toThrow();
  });

  test('evicts least-recently-wanted chunks over budget, never visible ones', () => {
    const s = new ChunkStreamer(row(), { margin: 0, maxInFlight: 10, budgetBytes: 3_000_000 });
    // Load chunks 0..4 while walking right.
    for (let i = 0; i < 5; i++) {
      s.update(view(i * 1000 + 100, i * 1000 + 900), i + 1);
      s.markLoading(`L:${i}:0`);
      s.markLoaded(`L:${i}:0`);
    }
    const out: StreamChunk[] = [];
    // 5 MB loaded, budget 3 MB: evict the two least recently wanted (0, then 1).
    expect(keys(s.evictions(out))).toEqual(['L:0:0', 'L:1:0']);
    // Visible chunks are protected even when over budget.
    s.update(view(100, 4900), 10);
    expect(s.evictions(out)).toEqual([]);
    s.setBudget(0);
    s.update(view(4100, 4900), 11);
    const ev = keys(s.evictions(out));
    expect(ev).not.toContain('L:4:0');
    expect(ev).toHaveLength(4);
  });

  test('prefetch stays within the budget: no load/evict thrash when the budget is smaller than the wanted set', () => {
    const s = new ChunkStreamer(row(5), { margin: 1200, maxInFlight: 2, budgetBytes: 1_500_000 });
    const loads: StreamChunk[] = [];
    const evicts: StreamChunk[] = [];
    let started = 0;
    let evicted = 0;
    // A PlateLayer-style loop with instant loads, camera parked on chunk 2 (chunks 1 and 3 are prefetch).
    for (let frame = 1; frame <= 30; frame++) {
      s.update(view(2100, 2900), frame);
      for (const c of s.nextLoads(loads).slice()) {
        s.markLoading(c.key);
        s.markLoaded(c.key);
        started++;
      }
      for (const c of s.evictions(evicts).slice()) {
        s.markUnloaded(c.key);
        evicted++;
      }
    }
    expect(s.state('L:2:0')).toBe('loaded');
    expect(started).toBe(1);
    expect(evicted).toBe(0);
    expect(s.loadedBytes).toBeLessThanOrEqual(s.budgetBytes);
  });

  test('prefetch counts in-flight bytes; visible chunks load even over budget', () => {
    const s = new ChunkStreamer(row(5), { margin: 1200, maxInFlight: 4, budgetBytes: 2_000_000 });
    s.update(view(2100, 2900), 1);
    const out: StreamChunk[] = [];
    // Visible chunk 2 first, then one prefetch neighbour fits the remaining 1 MB; the other does not.
    expect(keys(s.nextLoads(out))).toHaveLength(2);
    expect(out[0]?.key).toBe('L:2:0');
    for (const c of out.slice()) s.markLoading(c.key);
    expect(s.nextLoads(out)).toEqual([]);
    s.setBudget(0);
    s.update(view(3100, 3900), 2);
    expect(keys(s.nextLoads(out))).toEqual(['L:3:0']);
  });

  test('a failed chunk is never offered again and does not starve the other chunks', () => {
    const s = new ChunkStreamer(row(5), { margin: 1200, maxInFlight: 2, budgetBytes: 1e9 });
    s.update(view(2100, 2900), 1);
    const out: StreamChunk[] = [];
    expect(keys(s.nextLoads(out))).toEqual(['L:2:0', 'L:1:0']);
    s.markLoading('L:2:0');
    s.markLoading('L:1:0');
    s.markFailed('L:2:0');
    s.markFailed('L:1:0');
    expect(s.state('L:2:0')).toBe('unloaded');
    expect(s.loadingCount).toBe(0);
    s.update(view(2100, 2900), 2);
    expect(keys(s.nextLoads(out))).toEqual(['L:3:0', 'L:0:0']);
  });

  test('rejects duplicate keys', () => {
    const c = row(2);
    (c[1] as StreamChunk).key = (c[0] as StreamChunk).key;
    expect(() => new ChunkStreamer(c, { margin: 0, maxInFlight: 1, budgetBytes: 1 })).toThrow();
  });
});
