import { describe, expect, test } from 'vitest';
import { MAX_PROJECTILES, MIN_ASPECT, VIEW_H } from '../../src/config.ts';
import { TileKind, type CrawlerDef, type LevelData, type SpitterDef } from '../../src/contracts/level.ts';
import { levelFromAscii } from '../../src/level/ascii.ts';
import { seedPoolDemand, validateLevel } from '../../src/level/validate.ts';
import { DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';

const T = 48;

/** 40 × 30 room with a start, a checkpoint, a goal and full-height grade zones. */
function good(): LevelData {
  const rows: string[] = [];
  for (let y = 0; y < 29; y++) rows.push(`#${'.'.repeat(38)}#`);
  rows.push('#'.repeat(40));
  const r4 = rows[28] as string;
  rows[28] = `${r4.slice(0, 3)}P${r4.slice(4)}`;
  const l = levelFromAscii(rows);
  l.checkpoints.push({ id: 0, x: 5 * T, y: 27 * T, w: T, h: 2 * T });
  l.goal = { x: 30 * T, y: 26 * T, w: 3 * T, h: 3 * T };
  l.gradeZones.push({ id: 0, x: 0, y: 0, w: 20 * T, h: 30 * T, grade: 'glade', blend: 4 * T });
  l.gradeZones.push({ id: 1, x: 20 * T, y: 0, w: 20 * T, h: 30 * T, grade: 'gully', blend: 4 * T });
  return l;
}

const errors = (l: LevelData): string[] => validateLevel(l).filter((i) => i.severity === 'error').map((i) => i.message);
const warnings = (l: LevelData): string[] => validateLevel(l).filter((i) => i.severity === 'warning').map((i) => i.message);

describe('validateLevel', () => {
  test('a well-formed level has no issues', () => {
    expect(validateLevel(good())).toEqual([]);
  });

  test('player start must stand on ground with head-room', () => {
    const air = good();
    air.playerStart = { x: 10 * T + 24, y: 20 * T };
    expect(errors(air).join()).toMatch(/player start .*nothing to stand on/);
    const off = good();
    off.playerStart = { x: 10 * T + 24, y: 29 * T - 5 };
    expect(errors(off).join()).toMatch(/not on a tile top/);
    const buried = good();
    buried.tiles[27 * 40 + 3] = 1;
    expect(errors(buried).join()).toMatch(/overlaps a Solid tile/);
  });

  test('checkpoints: at least one, on ground, inside the level', () => {
    const none = good();
    none.checkpoints = [];
    expect(errors(none)).toContain('the level has no checkpoint');
    const floating = good();
    floating.checkpoints[0] = { id: 0, x: 5 * T, y: 10 * T, w: T, h: 2 * T };
    expect(errors(floating).join()).toMatch(/checkpoint 0 respawn point .*nothing to stand on/);
    const outside = good();
    outside.checkpoints[0] = { id: 0, x: -T, y: 27 * T, w: T, h: 2 * T };
    expect(errors(outside).join()).toMatch(/checkpoint 0 is outside the level/);
  });

  test('exactly one goal, not inside solids', () => {
    const none = good();
    none.goal = null;
    expect(errors(none)).toContain('the level has no goal');
    const buried = good();
    buried.goal = { x: 30 * T, y: 28 * T, w: 3 * T, h: 3 * T };
    expect(errors(buried).join()).toMatch(/goal overlaps Solid/);
  });

  test('orbs inside bounds and not inside solids', () => {
    const l = good();
    l.orbs.push({ id: 0, x: 10 * T, y: 29 * T + 5, value: 1 }, { id: 1, x: -5, y: 100, value: 1 });
    const e = errors(l).join('\n');
    expect(e).toMatch(/orb 0 .* is inside a Solid tile/);
    expect(e).toMatch(/orb 1 is outside the level/);
  });

  test('enemy patrols need a floor and room', () => {
    const l = good();
    l.enemies.push({ id: 0, kind: 'gloomcrawler', x: 10 * T, y: 29 * T, patrolMinX: 8 * T, patrolMaxX: 12 * T, speed: 90 });
    expect(errors(l)).toEqual([]);
    l.enemies.push({ id: 1, kind: 'gloomcrawler', x: 10 * T, y: 20 * T, patrolMinX: 8 * T, patrolMaxX: 12 * T, speed: 90 });
    expect(errors(l).join()).toMatch(/enemy 1 patrol range has no floor/);
    const walled = good();
    walled.tiles[28 * 40 + 11] = 1;
    walled.enemies.push({ id: 0, kind: 'gloomcrawler', x: 10 * T, y: 29 * T, patrolMinX: 8 * T, patrolMaxX: 12 * T, speed: 90 });
    expect(errors(walled).join()).toMatch(/enemy 0 patrol range is blocked/);
    const spawn = good();
    spawn.enemies.push({ id: 0, kind: 'gloomcrawler', x: 20 * T, y: 29 * T, patrolMinX: 8 * T, patrolMaxX: 12 * T, speed: 90 });
    expect(errors(spawn).join()).toMatch(/enemy 0 spawns outside its patrol range/);
  });

  test('grade zones must cover the width without gaps', () => {
    const gap = good();
    (gap.gradeZones[1] as LevelData['gradeZones'][number]).x = 22 * T;
    expect(errors(gap).join()).toMatch(/grade zones leave a gap at x 960–1056/);
    const short = good();
    (short.gradeZones[1] as LevelData['gradeZones'][number]).w = 10 * T;
    expect(errors(short).join()).toMatch(/grade zones end at x 1440/);
    const none = good();
    none.gradeZones = [];
    expect(errors(none)).toContain('the level has no grade zones');
  });

  test('every reachable camera centre has some grade-zone weight (2D coverage)', () => {
    const l = good();
    // Zones only cover the top 10 rows; blend 1 tile: camera centres low in the level have no zone.
    for (const z of l.gradeZones) {
      z.h = 10 * T;
      z.blend = T;
    }
    const e = errors(l).join();
    expect(e).toMatch(/camera centre \(\d+, \d+\) is outside every grade zone/);
    // A blend reaching the lowest camera centre fixes it.
    const lowest = l.pxHeight - VIEW_H / 2;
    for (const z of l.gradeZones) z.blend = lowest - 10 * T + 1;
    expect(errors(l)).toEqual([]);
    expect(VIEW_H * MIN_ASPECT).toBeLessThan(l.pxWidth);
  });

  test('enemy patrol failures: no floor, blocked, off the grid, empty or missed range', () => {
    const enemy = (patch: Partial<CrawlerDef>): CrawlerDef => ({
      id: 0, kind: 'gloomcrawler', x: 10 * T, y: 29 * T, patrolMinX: 8 * T, patrolMaxX: 12 * T, speed: 90, ...patch,
    });
    const gap = good();
    gap.tiles[29 * 40 + 11] = 0;
    gap.enemies.push(enemy({}));
    expect(errors(gap).join()).toMatch(/enemy 0 patrol range has no floor under column 11/);
    const wall = good();
    wall.tiles[28 * 40 + 12] = 1;
    wall.tiles[27 * 40 + 12] = 1;
    wall.enemies.push(enemy({}));
    expect(errors(wall).join()).toMatch(/enemy 0 patrol range is blocked by Solid tiles/);
    const floating = good();
    floating.enemies.push(enemy({ y: 29 * T - 7 }));
    expect(errors(floating).join()).toMatch(/enemy 0 feet y .* is not on a tile top/);
    const empty = good();
    empty.enemies.push(enemy({ patrolMinX: 12 * T, patrolMaxX: 8 * T }));
    expect(errors(empty).join()).toMatch(/enemy 0 has an empty patrol range/);
    const outside = good();
    outside.enemies.push(enemy({ x: 14 * T }));
    expect(errors(outside).join()).toMatch(/enemy 0 spawns outside its patrol range/);
  });

  test('decor hints inside solid tiles are flagged', () => {
    const l = good();
    l.decorHints.push({ id: 0, kind: 'lantern', x: 10 * T + 24, y: 29 * T }, { id: 0, kind: 'flora', x: 12 * T + 24, y: 30 * T });
    expect(errors(l)).toEqual([]);
    expect(warnings(l)).toEqual([`flora 0 (${12 * T + 24}, ${30 * T}) is inside a Solid tile`]);
  });

  test('isolated single solid tiles are a warning, not an error', () => {
    const l = good();
    l.tiles[15 * 40 + 15] = 1;
    expect(errors(l)).toEqual([]);
    expect(warnings(l)).toEqual(['isolated single Solid tile at (15, 15)']);
  });

  test('light shafts: sane parameters', () => {
    const l = good();
    l.lightShafts.push({ id: 0, x: 5 * T, y: 0, w: 2 * T, h: 20 * T, angle: 0.2, spread: 1.6, intensity: 0.6 });
    expect(errors(l)).toEqual([]);
    l.lightShafts.push({ id: 1, x: 5 * T, y: 0, w: 2 * T, h: 20 * T, angle: 2, spread: 0, intensity: 1.5 });
    const e = errors(l).join('\n');
    expect(e).toMatch(/light shaft 1 intensity/);
    expect(e).toMatch(/light shaft 1 spread/);
    expect(e).toMatch(/light shaft 1 angle/);
  });

  test('tile data must match the grid', () => {
    const l = good();
    l.tiles = new Uint8Array(10);
    expect(errors(l).join()).toMatch(/tiles has 10 entries for a 40×30 grid/);
    const bad = good();
    bad.tiles[5] = 9;
    expect(errors(bad).join()).toMatch(/tile \(5, 0\) has unknown kind 9/);
  });
});

describe('validateLevel: Thorn Spitters, ability shrines and the seed pool (M2)', () => {
  const wt = DEFAULT_WORLD_TUNING;
  const spitter = (patch: Partial<SpitterDef> = {}): SpitterDef => ({
    id: 0, kind: 'thornSpitter', x: 10 * T + T / 2, y: 29 * T, aim: 'player', fixedVx: 0, fixedVy: 0,
    range: wt.spitterDefaultRange, period: wt.spitterDefaultPeriod, phase: 0, flightTicks: wt.spitterDefaultFlightTicks, ...patch,
  });

  test('a spitter stands on a Solid or OneWay floor tile with its box clear of Solid', () => {
    const ok = good();
    ok.enemies.push(spitter());
    expect(errors(ok)).toEqual([]);
    const oneWay = good();
    oneWay.tiles[20 * 40 + 10] = TileKind.OneWay;
    oneWay.enemies.push(spitter({ y: 20 * T }));
    expect(errors(oneWay)).toEqual([]);
    const floating = good();
    floating.enemies.push(spitter({ y: 20 * T }));
    expect(errors(floating).join()).toMatch(/spitter 0 has no Solid or OneWay floor tile under its feet/);
    const offGrid = good();
    offGrid.enemies.push(spitter({ y: 29 * T - 5 }));
    expect(errors(offGrid).join()).toMatch(/spitter 0 feet y .* is not on a tile top/);
    const buried = good();
    buried.tiles[27 * 40 + 10] = TileKind.Solid;
    buried.enemies.push(spitter());
    expect(errors(buried).join()).toMatch(/spitter 0 overlaps Solid tiles/);
    const outside = good();
    outside.enemies.push(spitter({ x: 10 }));
    expect(errors(outside).join()).toMatch(/spitter 0 is outside the level/);
  });

  test('spitter fields: range, period, phase, flightTicks, fixed speed', () => {
    const bad = good();
    bad.enemies.push(spitter({ range: 0, period: 0, phase: 0.5, flightTicks: 0 }));
    const e = errors(bad).join('\n');
    expect(e).toMatch(/spitter 0 range must be positive/);
    expect(e).toMatch(/spitter 0 period must be/);
    expect(e).toMatch(/spitter 0 phase must be/);
    expect(e).toMatch(/spitter 0 flightTicks must be/);
    const fast = good();
    fast.enemies.push(spitter({ aim: 'fixed', fixedVx: 1000, fixedVy: -1000 }));
    expect(errors(fast).join()).toMatch(/spitter 0 fixed seed speed exceeds seedMaxSpeed/);
    const short = good();
    short.enemies.push(spitter({ period: wt.spitterWindupTicks }));
    expect(errors(short)).toEqual([]);
    expect(warnings(short).join()).toMatch(/spitter 0 period .* is not longer than the windup/);
  });

  test('the seed pool cap: Σ ceil((seedLifetimeTicks + reflectedLifetimeTicks) / period) ≤ MAX_PROJECTILES', () => {
    const period = 90;
    const each = Math.ceil((wt.seedLifetimeTicks + wt.reflectedLifetimeTicks) / period);
    const fits = Math.floor(MAX_PROJECTILES / each);
    const l = good();
    for (let i = 0; i < fits; i++) l.enemies.push(spitter({ id: i, x: (3 + i) * T + T / 2, period }));
    expect(seedPoolDemand(l)).toBe(fits * each);
    expect(errors(l)).toEqual([]);
    l.enemies.push(spitter({ id: fits, x: (3 + fits) * T + T / 2, period: 1 }));
    expect(errors(l).join()).toMatch(/the spitters can keep \d+ seeds alive, more than the 32-slot pool/);
  });

  test('an ability shrine rect is inside the level and clear of Solid', () => {
    const ok = good();
    ok.abilityShrines.push({ id: 0, x: 12 * T, y: 27 * T, w: T, h: 2 * T, ability: 'launch' });
    expect(errors(ok)).toEqual([]);
    const buried = good();
    buried.abilityShrines.push({ id: 0, x: 12 * T, y: 28 * T, w: T, h: 2 * T, ability: 'launch' });
    expect(errors(buried).join()).toMatch(/ability shrine 0 overlaps Solid tiles/);
    const outside = good();
    outside.abilityShrines.push({ id: 0, x: -T, y: 27 * T, w: T, h: 2 * T, ability: 'launch' });
    expect(errors(outside).join()).toMatch(/ability shrine 0 is outside the level/);
  });
});
