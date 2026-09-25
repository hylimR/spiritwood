import { describe, expect, test } from 'vitest';
import { HAZARD_INSET } from '../../src/config.ts';
import type { LevelData, SpitterDef } from '../../src/contracts/level.ts';
import { levelFromAscii } from '../../src/level/ascii.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING, deriveTuning } from '../../src/sim/tuning.ts';
import {
  chokepointClosure, closureBounds, NO_LAUNCH_PLANS, noLaunchClosure, noLaunchLead, standableFloors, streamFairness, touches,
  type Cell,
} from '../../tools/level/analysis.ts';
import { MapBuilder } from '../sim/helpers.ts';

/**
 * tools/level/analysis.ts: the §5.4 closure must stay an over-approximation of no-launch movement, and
 * its checks must not be vacuous. Positive controls on synthetic maps next to the negative ones.
 */

const T = 48;
const tun = DEFAULT_TUNING;
const cells = (x0: number, x1: number, ty: number): Cell[] => {
  const out: Cell[] = [];
  for (let tx = x0; tx <= x1; tx++) out.push({ tx, ty });
  return out;
};
const reached = (floors: Set<string>, cs: readonly Cell[]): number => cs.filter((c) => floors.has(`${c.tx},${c.ty}`)).length;

describe('closure bounds (derived from the tunings)', () => {
  test('rise, touch and run bounds cover the measured reach', () => {
    const b = closureBounds(tun, DEFAULT_WORLD_TUNING, T);
    const der = deriveTuning(tun);
    const doublePeak = der.jumpVelocity ** 2 / (2 * der.gravity) + der.airJumpVelocity ** 2 / (2 * der.gravity) + 2 * der.apexHangExtra;
    // A rise of maxRise tiles is within jump + double jump + ledge assist (+ a stomp); the next is not.
    expect(b.maxRise * T).toBeLessThanOrEqual(doublePeak + tun.ledgeAssist + DEFAULT_WORLD_TUNING.enemyHeight);
    expect(b.maxRise).toBeLessThan(7);
    expect(b.reachRows * T).toBeGreaterThanOrEqual(doublePeak + tun.ledgeAssist + tun.height);
    // The run bound is at least a tile past the longest no-launch dash-jump.
    const lead = noLaunchLead(NO_LAUNCH_PLANS.dashJump);
    expect(b.maxRun * T).toBeGreaterThanOrEqual(lead + T);
    expect(b.bodyRows * T).toBeGreaterThanOrEqual(tun.height);
    expect(b.hazardRows * T).toBeGreaterThanOrEqual(tun.height - HAZARD_INSET);
  });
});

describe('no-launch closure (positive and negative controls)', () => {
  /**
   * A thorn box (w × 40): Thorns down both side columns and along the bottom row, so neither the level's
   * side edges (Solid beyond §2.1) nor a bottom floor give the body anything to climb or stand on; a
   * floor block (top row 30) on the left with the player on it.
   */
  function box(w = 60): MapBuilder {
    return new MapBuilder(w, 40, false).fill(0, 0, 0, 39, '^').fill(w - 1, 0, w - 1, 39, '^').fill(1, 39, w - 2, 39, '^')
      .fill(1, 30, 12, 38, '#').put(3, 29, 'P');
  }
  const from = [{ tx: 5, ty: 30 }];

  test('a OneWay ledge 6 tiles up is reached; one 7 tiles up is not', () => {
    const six = noLaunchClosure(levelFromAscii(box().fill(16, 24, 19, 24, '=').rows()), from);
    expect(reached(six.floors, cells(16, 19, 24))).toBe(4);
    const seven = noLaunchClosure(levelFromAscii(box().fill(16, 23, 19, 23, '=').rows()), from);
    expect(reached(seven.floors, cells(16, 19, 23))).toBe(0);
  });

  test('a climbable 7-tile face is climbed to its top; lined with thorns it is not', () => {
    const climb = box().fill(20, 23, 24, 38, '#');
    expect(reached(noLaunchClosure(levelFromAscii(climb.rows()), from).floors, cells(20, 24, 23))).toBeGreaterThan(0);
    const lined = box().fill(20, 23, 24, 38, '#').fill(19, 23, 19, 38, '^').fill(25, 23, 25, 38, '^');
    expect(reached(noLaunchClosure(levelFromAscii(lined.rows()), from).floors, cells(20, 24, 23))).toBe(0);
  });

  test('the run is bounded by the measured dash-jump: a same-height ledge within it is reached, past it not', () => {
    const b = closureBounds(tun, DEFAULT_WORLD_TUNING, T);
    const edge = { tx: 12, ty: 30 };
    const near = box(12 + b.maxRun + 10).fill(12 + b.maxRun - 1, 30, 12 + b.maxRun, 30, '=');
    expect(reached(noLaunchClosure(levelFromAscii(near.rows()), [edge]).floors, cells(12 + b.maxRun - 1, 12 + b.maxRun, 30))).toBeGreaterThan(0);
    const far = box(12 + b.maxRun + 10).fill(12 + b.maxRun + 2, 30, 12 + b.maxRun + 3, 30, '=');
    expect(reached(noLaunchClosure(levelFromAscii(far.rows()), [edge]).floors, cells(12 + b.maxRun + 2, 12 + b.maxRun + 3, 30))).toBe(0);
  });

  test('HAZARD_INSET: a floor with thorns two rows up is standable, one with thorns right above is not', () => {
    const m = box().fill(13, 30, 30, 38, '#').fill(14, 28, 18, 28, '^').fill(22, 29, 26, 29, '^');
    const level = levelFromAscii(m.rows());
    const floors = new Set(standableFloors(level).map((c) => `${c.tx},${c.ty}`));
    expect(reached(floors, cells(14, 18, 30))).toBe(5);
    expect(reached(floors, cells(22, 26, 30))).toBe(0);
    expect(reached(noLaunchClosure(level, from).floors, cells(14, 18, 30))).toBe(5);
  });

  test('HAZARD_INSET: a head grazing a thorn cell can slide on the Solid face beside it', () => {
    // A thorn-lined pillar whose lowest tile's face is exposed only through the thorn cell beside it.
    // Sliding there (5 up) restores the air jump: a ledge 9 up becomes reachable. Without the pillar it is not.
    const make = (pillar: boolean): LevelData => {
      const m = box().fill(13, 30, 38, 38, '#').fill(20, 12, 20, 24, '^').fill(22, 12, 22, 24, '^').fill(12, 21, 14, 21, '=');
      if (pillar) m.fill(21, 12, 21, 24, '#');
      return levelFromAscii(m.rows());
    };
    const ledge = cells(12, 14, 21);
    expect(reached(noLaunchClosure(make(true), [{ tx: 20, ty: 30 }]).floors, ledge)).toBeGreaterThan(0);
    expect(reached(noLaunchClosure(make(false), [{ tx: 20, ty: 30 }]).floors, ledge)).toBe(0);
  });

  test('blockers seal like Solid: the chokepoint closure with and without the shrine', () => {
    // A wall to the top edge with a 2-tall corridor (rows 16–17) holding a shrine; the goal beyond.
    const m = new MapBuilder(40, 20).fill(19, 0, 20, 18, '#').fill(19, 16, 20, 17, '.').put(3, 18, 'P').put(19, 17, 'A');
    const level = levelFromAscii(m.rows());
    level.goal = { x: 30 * T, y: 16 * T, w: T, h: 3 * T };
    expect(level.abilityShrines).toHaveLength(1);
    const beyond = cells(21, 38, 19);
    const sealed = chokepointClosure(level);
    const open = chokepointClosure(level, false);
    expect(reached(sealed.floors, beyond)).toBe(0);
    expect(touches(sealed, level.goal, T)).toBe(false);
    expect(reached(open.floors, beyond)).toBeGreaterThan(0);
    expect(touches(open, level.goal, T)).toBe(true);
  });
});

describe('stream fairness (positive control)', () => {
  test('a fixed stream lobbed across a standable floor is reported; one straight up in a pit is not', () => {
    const lob = levelFromAscii(new MapBuilder(60, 30).put(5, 28, 'P').put(20, 28, 'U').rows());
    const sp = lob.enemies[0] as SpitterDef;
    sp.fixedVx = 500;
    sp.fixedVy = -400;
    expect(streamFairness(lob).length).toBeGreaterThan(0);
    // Straight up from a 1-tile slot below the floor: the seeds never come near a standing player.
    const slot = levelFromAscii(new MapBuilder(60, 30).fill(1, 27, 58, 28, '#').fill(20, 27, 20, 27, '.').put(5, 26, 'P').put(20, 27, 'U').rows());
    expect(streamFairness(slot)).toEqual([]);
  });
});
