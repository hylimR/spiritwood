import { describe, expect, test } from 'vitest';
import { SIM_DT } from '../../src/config.ts';
import { TileKind } from '../../src/contracts/level.ts';
import { CollisionGrid } from '../../src/level/grid.ts';
import {
  createSweepResult, isOnGround, isTouchingWall, overlapsSolid, overlapsThorns, sweepX, sweepY, type Body,
} from '../../src/sim/physics.ts';
import { DEFAULT_TUNING } from '../../src/sim/tuning.ts';
import { T } from './helpers.ts';

const W = DEFAULT_TUNING.width;
const H = DEFAULT_TUNING.height;

function body(x: number, y: number): Body {
  return { x, y, width: W, height: H };
}

const ROOM = [
  '..........',
  '..........',
  '.....#....',
  '..........',
  '..=...^...',
  '##########',
];

describe('CollisionGrid', () => {
  const g = CollisionGrid.fromAscii(ROOM, T);

  test('fromAscii and the out-of-bounds rule', () => {
    expect(g.width).toBe(10);
    expect(g.height).toBe(6);
    expect(g.get(5, 2)).toBe(TileKind.Solid);
    expect(g.get(2, 4)).toBe(TileKind.OneWay);
    expect(g.get(6, 4)).toBe(TileKind.Thorns);
    expect(g.isSolid(-1, 3)).toBe(true);
    expect(g.isSolid(10, 3)).toBe(true);
    expect(g.isSolid(3, -1)).toBe(true);
    expect(g.get(3, 6)).toBe(TileKind.Empty);
    expect(g.isSolid(-1, 99)).toBe(true);
  });

  test('rectHas uses half-open ranges', () => {
    expect(g.rectHas(5 * T, 2 * T, 6 * T, 3 * T, TileKind.Solid)).toBe(true);
    expect(g.rectHas(4 * T, 2 * T, 5 * T, 3 * T, TileKind.Solid)).toBe(false);
    expect(g.rectHas(6 * T, 2 * T, 7 * T, 3 * T, TileKind.Solid)).toBe(false);
    expect(g.rectHas(5 * T, T, 6 * T, 2 * T, TileKind.Solid)).toBe(false);
    expect(g.rectHas(4 * T, 2 * T, 5 * T + 0.001, 3 * T, TileKind.Solid)).toBe(true);
    expect(g.rectHas(0, 0, 0, T, TileKind.Empty)).toBe(false);
    expect(g.toTile(47.9)).toBe(0);
    expect(g.toTile(48)).toBe(1);
    expect(g.toTile(-0.1)).toBe(-1);
  });

  test('rejects mismatched tile arrays', () => {
    expect(() => new CollisionGrid(3, 3, T, new Uint8Array(8))).toThrow(RangeError);
  });
});

describe('sweeps', () => {
  const g = CollisionGrid.fromAscii(ROOM, T);
  const r = createSweepResult();

  test('sweepX stops flush on the tile boundary', () => {
    const b = body(3 * T, 3 * T);
    sweepX(g, b, 200, r);
    expect(r.hit).toBe(true);
    expect(r.hitKind).toBe(TileKind.Solid);
    expect(b.x + W / 2).toBe(5 * T);
    expect(r.moved).toBe(5 * T - W / 2 - 3 * T);
    sweepX(g, b, 1, r);
    expect(r.hit).toBe(true);
    expect(r.moved).toBe(0);
    sweepX(g, b, -10, r);
    expect(r.hit).toBe(false);
    expect(b.x).toBe(5 * T - W / 2 - 10);
  });

  test('sweepX leftward stops flush and the level edge is a wall', () => {
    const b = body(7 * T, 3 * T);
    sweepX(g, b, -200, r);
    expect(b.x - W / 2).toBe(6 * T);
    const edge = body(2 * T, 5 * T);
    sweepX(g, edge, -500, r);
    expect(edge.x - W / 2).toBe(0);
    expect(r.hit).toBe(true);
  });

  test('no tunnelling at 5× dash speed into a 1-tile wall', () => {
    const rows = ['..........', '.....#....', '##########'];
    const grid = CollisionGrid.fromAscii(rows, T);
    const dx = 5 * DEFAULT_TUNING.dashSpeed * SIM_DT;
    expect(dx).toBeGreaterThan(2 * T);
    const b = body(4 * T, 2 * T);
    sweepX(grid, b, dx, r);
    expect(r.hit).toBe(true);
    expect(b.x + W / 2).toBe(5 * T);
    const c = body(7 * T, 2 * T);
    sweepX(grid, c, -dx, r);
    expect(c.x - W / 2).toBe(6 * T);
  });

  test('one-way and thorn tiles never block horizontally', () => {
    const rows = ['......', '..=^..', '######'];
    const grid = CollisionGrid.fromAscii(rows, T);
    const b = body(T / 2, 2 * T);
    sweepX(grid, b, 3 * T, r);
    expect(r.hit).toBe(false);
    expect(b.x).toBe(T / 2 + 3 * T);
  });

  test('sweepY lands exactly on the floor and bonks exactly under a ceiling', () => {
    const b = body(3 * T + T / 2, 2 * T);
    sweepY(g, b, 1000, true, r);
    expect(r.hit).toBe(true);
    expect(b.y).toBe(5 * T);
    const h = body(5 * T + T / 2, 5 * T);
    sweepY(g, h, -1000, true, r);
    expect(h.y - H).toBe(3 * T);
    expect(r.hitKind).toBe(TileKind.Solid);
    const top = body(8 * T, 2 * T);
    sweepY(g, top, -1000, true, r);
    expect(top.y - H).toBe(0);
  });

  test('one-way platforms: land from above only, pass from below, ignore when not landable', () => {
    const b = body(2 * T + T / 2, 3 * T);
    sweepY(g, b, 100, true, r);
    expect(r.hitKind).toBe(TileKind.OneWay);
    expect(b.y).toBe(4 * T);
    const inside = body(2 * T + T / 2, 4 * T + 5);
    sweepY(g, inside, 30, true, r);
    expect(r.hit).toBe(false);
    const drop = body(2 * T + T / 2, 4 * T);
    sweepY(g, drop, 20, false, r);
    expect(r.hit).toBe(false);
    const up = body(2 * T + T / 2, 5 * T);
    sweepY(g, up, -100, true, r);
    expect(r.hit).toBe(false);
    expect(up.y).toBe(5 * T - 100);
  });

  test('falling past the level bottom is open', () => {
    const grid = CollisionGrid.fromAscii(['....', '....'], T);
    const b = body(T, T);
    sweepY(grid, b, 500, true, r);
    expect(r.hit).toBe(false);
    expect(b.y).toBe(T + 500);
  });
});

describe('contact probes', () => {
  const g = CollisionGrid.fromAscii(ROOM, T);

  test('isOnGround: 1 u probe, one-way only at its top', () => {
    expect(isOnGround(g, body(3 * T, 5 * T), false)).toBe(true);
    expect(isOnGround(g, body(3 * T, 5 * T - 0.5), false)).toBe(true);
    expect(isOnGround(g, body(3 * T, 5 * T - 1), false)).toBe(false);
    const oneWay = body(2 * T + T / 2, 4 * T);
    expect(isOnGround(g, oneWay, true)).toBe(true);
    expect(isOnGround(g, oneWay, false)).toBe(false);
    expect(isOnGround(g, body(2 * T + T / 2, 4 * T + 1), true)).toBe(false);
  });

  test('isTouchingWall within the probe', () => {
    const b = body(5 * T - W / 2, 3 * T);
    expect(isTouchingWall(g, b, 1)).toBe(true);
    expect(isTouchingWall(g, b, -1)).toBe(false);
    const near = body(5 * T - W / 2 - 4, 3 * T);
    expect(isTouchingWall(g, near, 1)).toBe(false);
    expect(isTouchingWall(g, near, 1, DEFAULT_TUNING.wallJumpProbe)).toBe(true);
    expect(isTouchingWall(g, body(W / 2, 2 * T), -1)).toBe(true);
  });

  test('overlapsSolid with offsets', () => {
    const beside = body(5 * T - W / 2, 3 * T);
    expect(overlapsSolid(g, beside)).toBe(false);
    expect(overlapsSolid(g, beside, 1, 0)).toBe(true);
    const below = body(5 * T + T / 2, 3 * T + H);
    expect(overlapsSolid(g, below)).toBe(false);
    expect(overlapsSolid(g, below, 0, -1)).toBe(true);
    expect(overlapsSolid(g, below, T, -1)).toBe(false);
  });

  test('overlapsThorns honours the inset', () => {
    const inset = 10;
    const x = 6 * T + T / 2;
    expect(overlapsThorns(g, body(x, 5 * T), inset)).toBe(true);
    expect(overlapsThorns(g, body(x, 4 * T + inset), inset)).toBe(false);
    expect(overlapsThorns(g, body(x, 4 * T + inset + 0.5), inset)).toBe(true);
    expect(overlapsThorns(g, body(6 * T - W / 2 + inset, 5 * T), inset)).toBe(false);
  });
});
