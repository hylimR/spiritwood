import { describe, expect, test } from 'vitest';
import { TileKind, type CrawlerDef } from '../../src/contracts/level.ts';
import { tileAt } from '../../src/core/tiles.ts';
import { DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';
import { createFakeSimView, levelFromAscii } from './fixtures.ts';

const MAP = [
  '..........',
  '.o......G.',
  '.C.P.EEEE.',
  '###=^#####',
];

describe('levelFromAscii', () => {
  const lv = levelFromAscii(MAP, { tileSize: 48 });

  test('tiles and size', () => {
    expect(lv.widthTiles).toBe(10);
    expect(lv.heightTiles).toBe(4);
    expect(lv.pxWidth).toBe(480);
    expect(tileAt(lv, 0, 3)).toBe(TileKind.Solid);
    expect(tileAt(lv, 3, 3)).toBe(TileKind.OneWay);
    expect(tileAt(lv, 4, 3)).toBe(TileKind.Thorns);
    expect(tileAt(lv, 3, 2)).toBe(TileKind.Empty);
  });

  test('out-of-bounds rule', () => {
    expect(tileAt(lv, -1, 2)).toBe(TileKind.Solid);
    expect(tileAt(lv, 10, 2)).toBe(TileKind.Solid);
    expect(tileAt(lv, -1, 99)).toBe(TileKind.Solid);
    expect(tileAt(lv, 2, -1)).toBe(TileKind.Solid);
    expect(tileAt(lv, 2, 4)).toBe(TileKind.Empty);
  });

  test('entities', () => {
    expect(lv.playerStart).toEqual({ x: 3 * 48 + 24, y: 3 * 48 });
    expect(lv.orbs).toEqual([{ id: 0, x: 72, y: 72, value: 1 }]);
    expect(lv.checkpoints).toEqual([{ id: 0, x: 48, y: 48, w: 48, h: 96 }]);
    expect(lv.goal).toEqual({ x: 8 * 48, y: 0, w: 96, h: 96 });
    const e = lv.enemies[0] as CrawlerDef | undefined;
    expect(lv.enemies).toHaveLength(1);
    expect(e?.y).toBe(144);
    expect(e?.patrolMinX).toBe(5 * 48 + DEFAULT_WORLD_TUNING.enemyWidth / 2);
    expect(e?.patrolMaxX).toBe(9 * 48 - DEFAULT_WORLD_TUNING.enemyWidth / 2);
    expect(tileAt(lv, 5, 2)).toBe(TileKind.Empty);
  });

  test('fake sim view mirrors the level', () => {
    const sim = createFakeSimView(lv);
    expect(sim.orbs[0]?.id).toBe(lv.orbs[0]?.id);
    expect(sim.player.x).toBe(lv.playerStart.x);
    expect(sim.enemies).toHaveLength(1);
    sim.events.push({ type: 6, a: 900 });
    expect(sim.events.get(0).a).toBe(900);
  });
});
