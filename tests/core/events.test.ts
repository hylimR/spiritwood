import { describe, expect, test } from 'vitest';
import { SimEventType } from '../../src/contracts/sim.ts';
import { SimEventQueue } from '../../src/core/events.ts';

describe('SimEventQueue', () => {
  test('push fills records in order with payload defaults', () => {
    const q = new SimEventQueue(4);
    q.push(SimEventType.Jump, 3, 10, 20, 1);
    q.push(SimEventType.OrbCollected, 4, 1, 2, 5, 0, 7);
    expect(q.count).toBe(2);
    expect(q.get(0)).toEqual({ type: SimEventType.Jump, tick: 3, x: 10, y: 20, a: 1, b: 0, id: -1 });
    expect(q.get(1)).toEqual({ type: SimEventType.OrbCollected, tick: 4, x: 1, y: 2, a: 5, b: 0, id: 7 });
  });

  test('records are preallocated and reused after clear', () => {
    const q = new SimEventQueue(2);
    q.push(SimEventType.Land, 1, 0, 0, 900, 50);
    const first = q.get(0);
    q.clear();
    expect(q.count).toBe(0);
    q.push(SimEventType.Dash, 2, 5, 6, -1, 1);
    expect(q.get(0)).toBe(first);
    expect(first.type).toBe(SimEventType.Dash);
    expect(first.id).toBe(-1);
  });

  test('pushes past capacity are dropped and counted until clear', () => {
    const q = new SimEventQueue(3);
    for (let i = 0; i < 5; i++) q.push(SimEventType.Jump, i, i, 0);
    expect(q.count).toBe(3);
    expect(q.dropped).toBe(2);
    expect(q.get(2).tick).toBe(2);
    q.clear();
    expect(q.dropped).toBe(0);
  });

  test('get outside the filled range throws', () => {
    const q = new SimEventQueue(2);
    q.push(SimEventType.Jump, 0, 0, 0);
    expect(() => q.get(1)).toThrow(RangeError);
    expect(() => q.get(-1)).toThrow(RangeError);
  });

  test('default capacity is 64', () => {
    expect(new SimEventQueue().capacity).toBe(64);
  });
});
