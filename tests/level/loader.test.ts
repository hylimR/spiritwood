import { describe, expect, test } from 'vitest';
import { TileKind, type CrawlerDef, type LevelData, type SpitterDef } from '../../src/contracts/level.ts';
import { hashString } from '../../src/core/rng.ts';
import { levelFromAscii } from '../../src/level/ascii.ts';
import { LDTK_DEFAULTS, LevelParseError, loadLevel, parseLdtk, spitterVelocity } from '../../src/level/loader.ts';
import { DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';
import { buildLdtkProject } from '../../tools/level/ldtk-writer.ts';

type Obj = Record<string, unknown>;

const ROWS = [
  '................',
  '..o.............',
  '.P......=====...',
  '################',
];

function fixture(): LevelData {
  const level = levelFromAscii(ROWS, { id: 'Fixture' });
  level.seed = 1234;
  level.checkpoints.push({ id: 0, x: 96, y: 48, w: 48, h: 96 }, { id: 1, x: 480, y: 48, w: 48, h: 96 });
  level.enemies.push({ id: 0, kind: 'gloomcrawler', x: 384, y: 144, patrolMinX: 272, patrolMaxX: 496, speed: 120 });
  level.goal = { x: 672, y: 48, w: 96, h: 96 };
  level.lightShafts.push({ id: 0, x: 96, y: 0, w: 96, h: 144, angle: (15 * Math.PI) / 180, spread: 1.5, intensity: 0.4 });
  level.gradeZones.push(
    { id: 0, x: 0, y: 0, w: 384, h: 192, grade: 'glade', blend: 96 },
    { id: 1, x: 384, y: 0, w: 384, h: 192, grade: 'gully', blend: 96 },
  );
  level.decorHints.push({ id: 0, kind: 'flora', x: 216, y: 144 }, { id: 0, kind: 'lantern', x: 312, y: 144 }, { id: 1, kind: 'flora', x: 600, y: 144 });
  return level;
}

/** A fresh JSON project for the fixture (plain data, safe to mutate). */
function project(): Obj {
  return JSON.parse(JSON.stringify(buildLdtkProject(fixture()))) as Obj;
}

const level0 = (p: Obj): Obj => (p['levels'] as Obj[])[0] as Obj;
const layers = (p: Obj): Obj[] => level0(p)['layerInstances'] as Obj[];
const entities = (p: Obj): Obj[] => (layers(p)[0] as Obj)['entityInstances'] as Obj[];
const collision = (p: Obj): Obj => layers(p)[1] as Obj;
const field = (e: Obj, name: string): Obj => (e['fieldInstances'] as Obj[]).find((f) => f['__identifier'] === name) as Obj;

describe('parseLdtk', () => {
  test('round-trips LevelData through the LDtk project', () => {
    expect(parseLdtk(project())).toEqual(fixture());
  });

  test('positions from __pivot, px, width and height', () => {
    const p = project();
    const orb = entities(p).find((e) => e['__identifier'] === 'Orb') as Obj;
    orb['__pivot'] = [0, 0];
    orb['px'] = [100, 60];
    const start = entities(p).find((e) => e['__identifier'] === 'PlayerStart') as Obj;
    start['__pivot'] = [0, 0];
    start['px'] = [10, 20];
    start['width'] = 40;
    start['height'] = 50;
    const cp = entities(p).find((e) => e['__identifier'] === 'Checkpoint') as Obj;
    cp['__pivot'] = [0.5, 1];
    cp['px'] = [120, 144];
    const l = parseLdtk(p);
    expect(l.orbs[0]).toMatchObject({ x: 112, y: 72 });
    expect(l.playerStart).toEqual({ x: 30, y: 70 });
    expect(l.checkpoints[0]).toMatchObject({ x: 96, y: 48, w: 48, h: 96 });
  });

  test('layer offsets shift entity positions', () => {
    const p = project();
    const layer = layers(p)[0] as Obj;
    layer['__pxTotalOffsetX'] = 5;
    layer['__pxTotalOffsetY'] = -3;
    const l = parseLdtk(p);
    expect(l.goal).toMatchObject({ x: 677, y: 45 });
  });

  test('enemy: width is the patrol span, spawn clamped into it, speed from the field', () => {
    const l = parseLdtk(project());
    const e = l.enemies[0];
    const half = DEFAULT_WORLD_TUNING.enemyWidth / 2;
    expect(e).toEqual({ id: 0, kind: 'gloomcrawler', x: 384, y: 144, patrolMinX: 272, patrolMaxX: 496, speed: 120 });
    const p = project();
    const raw = entities(p).find((x) => x['__identifier'] === 'Enemy') as Obj;
    raw['fieldInstances'] = [];
    raw['width'] = 40;
    const narrow = parseLdtk(p).enemies[0] as CrawlerDef | undefined;
    expect(narrow?.speed).toBe(DEFAULT_WORLD_TUNING.enemyDefaultSpeed);
    expect(narrow?.patrolMinX).toBe(narrow?.patrolMaxX);
    expect(narrow?.x).toBe(narrow?.patrolMinX);
    expect(half).toBeGreaterThan(20);
  });

  test('light shaft: degrees → radians, defaults', () => {
    const l = parseLdtk(project());
    expect(l.lightShafts[0]?.angle).toBeCloseTo((15 * Math.PI) / 180, 12);
    const p = project();
    (entities(p).find((e) => e['__identifier'] === 'LightShaft') as Obj)['fieldInstances'] = [];
    const d = parseLdtk(p).lightShafts[0];
    expect(d).toMatchObject({ angle: 0, spread: LDTK_DEFAULTS.shaftSpread, intensity: LDTK_DEFAULTS.shaftIntensity });
    (entities(p).find((e) => e['__identifier'] === 'LightShaft') as Obj)['fieldInstances'] = [
      { __identifier: 'angle', __type: 'Float', __value: -30 },
    ];
    expect(parseLdtk(p).lightShafts[0]?.angle).toBeCloseTo(-Math.PI / 6, 12);
  });

  test('grade enum matches case-insensitively; unknown grades are rejected', () => {
    const p = project();
    const zone = entities(p).find((e) => e['__identifier'] === 'GradeZone') as Obj;
    field(zone, 'grade')['__value'] = 'Glade';
    expect(parseLdtk(p).gradeZones[0]?.grade).toBe('glade');
    field(zone, 'grade')['__value'] = 'desert';
    expect(() => parseLdtk(p)).toThrow(/unknown AreaGrade "desert"/);
    field(zone, 'grade')['__value'] = null;
    expect(() => parseLdtk(p)).toThrow(/needs an AreaGrade/);
  });

  test('ids per identifier in layer order; decor ids per kind', () => {
    const l = parseLdtk(project());
    expect(l.checkpoints.map((c) => c.id)).toEqual([0, 1]);
    expect(l.decorHints.map((d) => [d.kind, d.id])).toEqual([['flora', 0], ['lantern', 0], ['flora', 1]]);
  });

  test('orb value field and default', () => {
    const p = project();
    const orb = entities(p).find((e) => e['__identifier'] === 'Orb') as Obj;
    field(orb, 'value')['__value'] = 5;
    expect(parseLdtk(p).orbs[0]?.value).toBe(5);
    orb['fieldInstances'] = [];
    expect(parseLdtk(p).orbs[0]?.value).toBe(LDTK_DEFAULTS.orbValue);
  });

  test('seed: level Int field, else hashString(identifier)', () => {
    expect(parseLdtk(project()).seed).toBe(1234);
    const p = project();
    level0(p)['fieldInstances'] = [];
    expect(parseLdtk(p).seed).toBe(hashString('Fixture'));
  });

  test('tiles come from the Collision IntGrid', () => {
    const l = parseLdtk(project());
    expect(l.tiles[3 * 16]).toBe(TileKind.Solid);
    expect(l.tiles[2 * 16 + 8]).toBe(TileKind.OneWay);
    expect(Array.from(l.tiles)).toEqual(Array.from(fixture().tiles));
  });

  test('picks a level by identifier (exact, then case-insensitive)', () => {
    const p = project();
    const second = JSON.parse(JSON.stringify(level0(p))) as Obj;
    second['identifier'] = 'Second';
    (p['levels'] as Obj[]).push(second);
    expect(parseLdtk(p, 'Second').id).toBe('Second');
    expect(parseLdtk(p, 'second').id).toBe('Second');
    expect(parseLdtk(p).id).toBe('Fixture');
    expect(() => parseLdtk(p, 'Nope')).toThrow(/level "Nope" not found \(the project has "Fixture", "Second"\)/);
  });

  test('unknown entities are ignored', () => {
    const p = project();
    entities(p).push({ __identifier: 'Signpost', __pivot: [0, 0], px: [0, 0], width: 16, height: 16, fieldInstances: [] });
    expect(() => parseLdtk(p)).not.toThrow();
  });
});

describe('parseLdtk errors are precise', () => {
  const cases: [string, (p: Obj) => unknown, RegExp][] = [
    ['not an object', () => 42, /^project: expected an object, got number/],
    ['bad version', (p) => (p['jsonVersion'] = '0.9.3'), /unsupported LDtk JSON version "0\.9\.3"/],
    ['no levels', (p) => (p['levels'] = []), /the project has no levels/],
    ['external level', (p) => (level0(p)['layerInstances'] = null), /levels saved as separate files are not supported/],
    ['no Collision layer', (p) => (collision(p)['__identifier'] = 'Walls'), /no "Collision" layer/],
    ['Collision not IntGrid', (p) => (collision(p)['__type'] = 'Tiles'), /expected an IntGrid layer, got Tiles/],
    ['csv length', (p) => (collision(p)['intGridCsv'] as number[]).pop(), /intGridCsv: expected 64 values \(16×4\), got 63/],
    ['csv value', (p) => ((collision(p)['intGridCsv'] as number[])[5] = 7), /intGridCsv\[5\]: unknown IntGrid value 7 at cell \(5, 0\)/],
    ['level size', (p) => (level0(p)['pxWid'] = 100), /level size 100×192 px does not match the Collision grid 768×192 px/],
    ['no PlayerStart', (p) => {
      const layer = layers(p)[0] as Obj;
      layer['entityInstances'] = (layer['entityInstances'] as Obj[]).filter((e) => e['__identifier'] !== 'PlayerStart');
    }, /expected exactly one PlayerStart, found 0/],
    ['two goals', (p) => {
      const g = entities(p).find((e) => e['__identifier'] === 'Goal');
      entities(p).push(JSON.parse(JSON.stringify(g)) as Obj);
    }, /more than one Goal/],
    ['bad pivot', (p) => ((entities(p)[0] as Obj)['__pivot'] = [0.5]), /__pivot: expected \[x, y\], got 1 values/],
    ['bad field type', (p) => {
      const e = entities(p).find((x) => x['__identifier'] === 'Enemy') as Obj;
      field(e, 'speed')['__value'] = 'fast';
    }, /\(Enemy\)\.speed: expected a finite number, got string/],
    ['unknown layer type', (p) => ((layers(p)[0] as Obj)['__type'] = 'Paint'), /unknown layer type "Paint"/],
  ];
  for (const [name, mutate, message] of cases) {
    test(name, () => {
      const p = project();
      const replaced = mutate(p);
      const input = name === 'not an object' ? replaced : p;
      let error: unknown;
      try {
        parseLdtk(input);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(LevelParseError);
      expect((error as Error).message).toMatch(message);
    });
  }
});

describe('loadLevel', () => {
  test('fetches and parses', async () => {
    const body = project();
    const fake = (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
    const l = await loadLevel('levels/x.ldtk', undefined, fake);
    expect(l.id).toBe('Fixture');
  });

  test('HTTP errors become LevelParseError', async () => {
    const fake = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(loadLevel('levels/missing.ldtk', undefined, fake)).rejects.toThrow(/HTTP 404/);
  });
});

describe('parseLdtk: Spitter and AbilityShrine (M2)', () => {
  /** Crawler, a player-aimed and a fixed-aim spitter, two shrines. */
  function m2Fixture(): LevelData {
    const level = levelFromAscii([
      '..........................',
      '..........................',
      '.P.....A...S.......U..EEE.',
      '##########################',
    ], { id: 'M2' });
    level.seed = 7;
    const fixed = level.enemies[2];
    if (fixed?.kind === 'thornSpitter') {
      const v = spitterVelocity(60, 900);
      Object.assign(fixed, { fixedVx: v.vx, fixedVy: v.vy, period: 90, phase: 30, range: 500 });
    }
    level.abilityShrines.push({ id: 1, x: 480, y: 0, w: 96, h: 144, ability: 'launch' });
    return level;
  }
  const m2Project = (): Obj => JSON.parse(JSON.stringify(buildLdtkProject(m2Fixture()))) as Obj;
  const spitterEntities = (p: Obj): Obj[] => entities(p).filter((e) => e['__identifier'] === 'Spitter');

  test('round-trips spitters (crawlers first, then spitters) and shrines', () => {
    const l = parseLdtk(m2Project());
    expect(l).toEqual(m2Fixture());
    expect(l.enemies.map((e) => [e.id, e.kind])).toEqual([[0, 'gloomcrawler'], [1, 'thornSpitter'], [2, 'thornSpitter']]);
  });

  test('crawlers get ids before spitters whatever the layer order', () => {
    const p = m2Project();
    const layer = layers(p)[0] as Obj;
    const list = layer['entityInstances'] as Obj[];
    // Move the spitters to the front of the layer.
    list.sort((a, b) => Number(b['__identifier'] === 'Spitter') - Number(a['__identifier'] === 'Spitter'));
    expect(parseLdtk(p).enemies.map((e) => e.kind)).toEqual(['gloomcrawler', 'thornSpitter', 'thornSpitter']);
  });

  test('fields: aim enum (case-insensitive), angleDeg + speed → fixed velocity with snapping, defaults', () => {
    const p = m2Project();
    const [player, fixed] = spitterEntities(p) as [Obj, Obj];
    field(fixed, 'angleDeg')['__value'] = 90;
    field(fixed, 'speed')['__value'] = 800;
    field(fixed, 'aim')['__value'] = 'fixed';
    const l = parseLdtk(p);
    expect(l.enemies[2]).toMatchObject({ aim: 'fixed', fixedVx: 0, fixedVy: -800 });
    expect(Object.is((l.enemies[2] as SpitterDef).fixedVx, 0)).toBe(true);
    field(fixed, 'angleDeg')['__value'] = 180;
    expect(parseLdtk(p).enemies[2]).toMatchObject({ fixedVx: -800, fixedVy: 0 });
    field(fixed, 'angleDeg')['__value'] = 135;
    const diag = parseLdtk(p).enemies[2] as SpitterDef;
    expect(diag.fixedVx).toBeCloseTo(-800 * Math.SQRT1_2, 9);
    expect(diag.fixedVy).toBeCloseTo(-800 * Math.SQRT1_2, 9);
    // Player aim ignores angle and speed; defaults fill missing fields.
    player['fieldInstances'] = [];
    const wt = DEFAULT_WORLD_TUNING;
    expect(parseLdtk(p).enemies[1]).toEqual({
      id: 1, kind: 'thornSpitter', x: 11.5 * 48, y: 3 * 48, aim: 'player', fixedVx: 0, fixedVy: 0, range: wt.spitterDefaultRange,
      period: wt.spitterDefaultPeriod, phase: 0, flightTicks: wt.spitterDefaultFlightTicks,
    });
    fixed['fieldInstances'] = [{ __identifier: 'aim', __type: 'LocalEnum.SpitterAim', __value: 'FIXED' }];
    expect(parseLdtk(p).enemies[2]).toMatchObject({ aim: 'fixed', fixedVx: 0, fixedVy: -wt.spitterDefaultSpeed });
  });

  test('shrine: resizable rect, ability enum (default Launch)', () => {
    const p = m2Project();
    const shrines = entities(p).filter((e) => e['__identifier'] === 'AbilityShrine');
    expect(shrines).toHaveLength(2);
    (shrines[1] as Obj)['fieldInstances'] = [];
    expect(parseLdtk(p).abilityShrines[1]).toEqual({ id: 1, x: 480, y: 0, w: 96, h: 144, ability: 'launch' });
  });

  test('bad spitter and shrine fields are precise errors', () => {
    const cases: [(p: Obj) => void, RegExp][] = [
      [(p) => (field(spitterEntities(p)[0] as Obj, 'aim')['__value'] = 'Sideways'), /\(Spitter\)\.aim: unknown SpitterAim "Sideways"/],
      [(p) => (field(spitterEntities(p)[0] as Obj, 'period')['__value'] = 0), /\(Spitter\)\.period: expected at least 1, got 0/],
      [(p) => (field(spitterEntities(p)[0] as Obj, 'period')['__value'] = 1.5), /\(Spitter\)\.period: expected an integer/],
      [(p) => (field(spitterEntities(p)[0] as Obj, 'flightTicks')['__value'] = 0), /flightTicks: expected at least 1/],
      [(p) => (field(spitterEntities(p)[0] as Obj, 'speed')['__value'] = -1), /speed: expected at least 0/],
      [(p) => {
        const s = entities(p).find((e) => e['__identifier'] === 'AbilityShrine') as Obj;
        field(s, 'ability')['__value'] = 'Fly';
      }, /\(AbilityShrine\)\.ability: unknown Ability "Fly"/],
    ];
    for (const [mutate, message] of cases) {
      const p = m2Project();
      mutate(p);
      expect(() => parseLdtk(p)).toThrow(LevelParseError);
      expect(() => parseLdtk(p)).toThrow(message);
    }
  });
});
