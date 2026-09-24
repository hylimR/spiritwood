import { describe, expect, test } from 'vitest';
import { TILE } from '../../src/config.ts';
import { TileKind } from '../../src/contracts/level.ts';
import { hashString } from '../../src/core/rng.ts';
import { DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';
import { buildLevel } from '../../tools/level/build-level.ts';
import { iidFor } from '../../tools/level/ldtk-writer.ts';
import { MapFileError, parseMapFile } from '../../tools/level/mapfile.ts';

const MAP = `; a tiny map
[level]
id = Tiny
seed = 77

[entities]
Checkpoint 2 1 1 2
Goal 8 1 2 2
Enemy 3 2 4 120
LightShaft 1 0 2 3 -10 1.5 0.5
GradeZone 0 0 5 4 glade 2
GradeZone 5 0 5 4 shrine 2

[map]
..........
.o......L.
.P.f.=....
####^#####
`;

describe('map file', () => {
  test('tiles, glyph entities and [entities] lines in tile units', () => {
    const l = parseMapFile(MAP);
    expect(l.id).toBe('Tiny');
    expect(l.seed).toBe(77);
    expect(l.widthTiles).toBe(10);
    expect(l.heightTiles).toBe(4);
    expect(l.tiles[3 * 10 + 4]).toBe(TileKind.Thorns);
    expect(l.tiles[2 * 10 + 5]).toBe(TileKind.OneWay);
    expect(l.tiles[2 * 10 + 3]).toBe(TileKind.Empty);
    expect(l.playerStart).toEqual({ x: TILE * 1.5, y: 3 * TILE });
    expect(l.orbs).toEqual([{ id: 0, x: TILE * 1.5, y: TILE * 1.5, value: 1 }]);
    expect(l.decorHints).toEqual([
      { id: 0, kind: 'lantern', x: TILE * 8.5, y: 2 * TILE },
      { id: 0, kind: 'flora', x: TILE * 3.5, y: 3 * TILE },
    ]);
    expect(l.checkpoints).toEqual([{ id: 0, x: 2 * TILE, y: TILE, w: TILE, h: 2 * TILE }]);
    expect(l.goal).toEqual({ x: 8 * TILE, y: TILE, w: 2 * TILE, h: 2 * TILE });
    const half = DEFAULT_WORLD_TUNING.enemyWidth / 2;
    expect(l.enemies).toEqual([{
      id: 0, kind: 'gloomcrawler', x: 5 * TILE, y: 3 * TILE, patrolMinX: 3 * TILE + half, patrolMaxX: 7 * TILE - half, speed: 120,
    }]);
    expect(l.lightShafts[0]).toMatchObject({ x: TILE, y: 0, w: 2 * TILE, h: 3 * TILE, spread: 1.5, intensity: 0.5 });
    expect(l.lightShafts[0]?.angle).toBeCloseTo((-10 * Math.PI) / 180, 12);
    expect(l.gradeZones.map((z) => [z.grade, z.x, z.w, z.blend])).toEqual([
      ['glade', 0, 5 * TILE, 2 * TILE], ['shrine', 5 * TILE, 5 * TILE, 2 * TILE],
    ]);
  });

  test('seed defaults to hashString(id)', () => {
    expect(parseMapFile(MAP.replace('seed = 77\n', '')).seed).toBe(hashString('Tiny'));
  });

  const bad: [string, string, RegExp][] = [
    ['reserved glyph', MAP.replace('.o......L.', '.o..C...L.'), /declare "C" entities in \[entities\]/],
    ['unknown glyph', MAP.replace('.o......L.', '.o..?...L.'), /unknown glyph "\?"/],
    ['ragged rows', MAP.replace('.o......L.', '.o......L'), /row 1: 9 columns, expected 10/],
    ['no player', MAP.replace('.P.f', '...f'), /expected exactly one "P", found 0/],
    ['unknown entity', MAP.replace('Goal 8 1 2 2', 'Door 8 1 2 2'), /unknown entity "Door"/],
    ['bad number', MAP.replace('Goal 8 1 2 2', 'Goal 8 one 2 2'), /"one" is not a number/],
    ['arity', MAP.replace('Goal 8 1 2 2', 'Goal 8 1 2'), /expected 4 numbers, got 3/],
    ['unknown grade', MAP.replace('shrine 2', 'desert 2'), /unknown grade "desert"/],
    ['second goal', MAP.replace('Goal 8 1 2 2', 'Goal 8 1 2 2\nGoal 1 1 1 1'), /a second Goal/],
    ['unknown section', MAP.replace('[entities]', '[stuff]'), /unknown section \[stuff\]/],
  ];
  for (const [name, source, message] of bad) {
    test(`rejects: ${name}`, () => {
      expect(() => parseMapFile(source)).toThrow(MapFileError);
      expect(() => parseMapFile(source)).toThrow(message);
    });
  }
});

describe('build-level', () => {
  test('pure and byte-stable: the same map gives the same file', () => {
    const a = buildLevel(MAP);
    const b = buildLevel(MAP);
    expect(a.text).toBe(b.text);
    expect(a.text.endsWith('\n')).toBe(true);
    expect(JSON.parse(a.text)).toBeTruthy();
  });

  test('intGridCsv is written one grid row per line', () => {
    const text = buildLevel(MAP).text;
    const csv = /"intGridCsv": \[\n([\s\S]*?)\n\t*\]/.exec(text)?.[1] ?? '';
    const lines = csv.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[3]?.trim()).toBe('1,1,1,1,3,1,1,1,1,1');
  });

  test('iids are deterministic UUID-v4-shaped strings', () => {
    expect(iidFor('a')).toBe(iidFor('a'));
    expect(iidFor('a')).not.toBe(iidFor('b'));
    expect(iidFor('level:x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
