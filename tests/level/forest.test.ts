import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { MAX_PROJECTILES, SIM_DT, TILE } from '../../src/config.ts';
import { AREA_GRADES, TileKind, type CrawlerDef, type LevelData, type SpitterDef } from '../../src/contracts/level.ts';
import { tileAt } from '../../src/core/tiles.ts';
import { LDTK_ABILITY, LDTK_SPITTER_AIM, parseLdtk } from '../../src/level/loader.ts';
import { seedPoolDemand, validateLevel } from '../../src/level/validate.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';
import { chokepointClosure, spitterBox, streamFairness, touches } from '../../tools/level/analysis.ts';
import { buildLevel, LDTK_PATH, MAP_PATH } from '../../tools/level/build-level.ts';
import { massViews } from '../../tools/level/masses.ts';
import { LDTK_153_KEYS } from './ldtk-keys.ts';

const fileText = readFileSync(LDTK_PATH, 'utf8');
const project = JSON.parse(fileText) as Record<string, unknown>;
const level = parseLdtk(project);
const mapSource = readFileSync(MAP_PATH, 'utf8');

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v as Obj;
const arr = (v: unknown): Obj[] => v as Obj[];

function zoneOf(l: LevelData, x: number): string | undefined {
  return l.gradeZones.find((z) => x >= z.x && x < z.x + z.w)?.grade;
}

describe('public/levels/forest.ldtk', () => {
  test('parses into the 260 × 50 Forest_Night level', () => {
    expect(level.id).toBe('Forest_Night');
    expect(level.widthTiles).toBe(260);
    expect(level.heightTiles).toBe(50);
    expect(level.tileSize).toBe(TILE);
    expect(level.pxWidth).toBe(260 * TILE);
    expect(level.pxHeight).toBe(50 * TILE);
    const seedField = arr(obj(arr(project['levels'])[0])['fieldInstances']).find((f) => f['__identifier'] === 'seed');
    expect(level.seed).toBe(seedField?.['__value']);
  });

  test('validateLevel reports no errors', () => {
    const errors = validateLevel(level).filter((i) => i.severity === 'error');
    expect(errors).toEqual([]);
  });

  test('is exactly what the builder produces from the map (not stale, byte-stable)', () => {
    const a = buildLevel(mapSource);
    const b = buildLevel(mapSource);
    expect(a.text).toBe(b.text);
    expect(a.text).toBe(fileText);
    expect(level).toEqual(a.level);
  });

  test('has every key LDtk 1.5.3 writes, at every level of the structure', () => {
    const missing: string[] = [];
    const check = (name: string, o: unknown): void => {
      const keys = Object.keys(obj(o));
      for (const k of LDTK_153_KEYS[name] ?? []) if (!keys.includes(k)) missing.push(`${name}.${k}`);
    };
    check('project', project);
    check('header', project['__header__']);
    const defs = obj(project['defs']);
    check('defs', defs);
    for (const l of arr(defs['layers'])) {
      check('layerDef', l);
      for (const v of arr(l['intGridValues'])) check('intGridValue', v);
    }
    for (const e of arr(defs['entities'])) {
      check('entityDef', e);
      for (const f of arr(e['fieldDefs'])) check('fieldDef', f);
    }
    for (const f of arr(defs['levelFields'])) check('fieldDef', f);
    for (const en of arr(defs['enums'])) {
      check('enumDef', en);
      for (const v of arr(en['values'])) check('enumValue', v);
    }
    for (const lv of arr(project['levels'])) {
      check('level', lv);
      for (const f of arr(lv['fieldInstances'])) check('fieldInstance', f);
      for (const li of arr(lv['layerInstances'])) {
        check('layerInstance', li);
        for (const e of arr(li['entityInstances'])) {
          check('entityInstance', e);
          for (const f of arr(e['fieldInstances'])) check('fieldInstance', f);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('project invariants the editor relies on', () => {
    expect(project['jsonVersion']).toBe('1.5.3');
    expect(project['identifierStyle']).toBe('Free');
    const defs = obj(project['defs']);
    const layerDefs = arr(defs['layers']);
    expect(layerDefs.map((l) => l['identifier'])).toEqual(['Entities', 'Collision']);
    const collision = layerDefs[1] as Obj;
    expect(arr(collision['intGridValues']).map((v) => [v['value'], v['identifier']])).toEqual([
      [TileKind.Solid, 'Solid'], [TileKind.OneWay, 'OneWay'], [TileKind.Thorns, 'Thorns'],
    ]);
    const enums = arr(defs['enums']);
    expect(enums.map((e) => e['identifier'])).toEqual(['AreaGrade', 'SpitterAim', 'Ability']);
    expect(arr(enums[0]?.['values']).map((v) => v['id'])).toEqual([...AREA_GRADES]);
    expect(arr(enums[1]?.['values']).map((v) => v['id'])).toEqual(Object.keys(LDTK_SPITTER_AIM));
    expect(arr(enums[2]?.['values']).map((v) => v['id'])).toEqual(Object.keys(LDTK_ABILITY));

    const uids: number[] = [];
    const iids: string[] = [];
    const collect = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(collect);
      else if (v && typeof v === 'object') {
        const o = v as Obj;
        if (typeof o['iid'] === 'string') iids.push(o['iid']);
        for (const [k, x] of Object.entries(o)) {
          if (k === 'uid' && typeof x === 'number') uids.push(x);
          collect(x);
        }
      }
    };
    collect(project);
    expect(new Set(uids).size).toBe(uids.length);
    expect(Math.max(...uids)).toBeLessThan(project['nextUid'] as number);
    expect(new Set(iids).size).toBe(iids.length);
    for (const iid of iids) expect(iid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    const lv = arr(project['levels'])[0] as Obj;
    const layers = arr(lv['layerInstances']);
    expect(layers.map((l) => l['__identifier'])).toEqual(['Entities', 'Collision']);
    expect(layers.map((l) => l['layerDefUid'])).toEqual(layerDefs.map((l) => l['uid']));
    const entityDefs = new Map(arr(defs['entities']).map((e) => [e['identifier'], e]));
    for (const e of arr(layers[0]?.['entityInstances'])) {
      const def = entityDefs.get(e['__identifier']);
      expect(def, String(e['__identifier'])).toBeDefined();
      expect(e['defUid']).toBe(def?.['uid']);
      expect(e['__pivot']).toEqual([def?.['pivotX'], def?.['pivotY']]);
      const px = e['px'] as number[];
      expect(px.every(Number.isInteger)).toBe(true);
      const fieldDefs = new Map(arr(def?.['fieldDefs']).map((f) => [f['identifier'], f]));
      for (const f of arr(e['fieldInstances'])) {
        const fd = fieldDefs.get(f['__identifier']);
        expect(f['defUid']).toBe(fd?.['uid']);
        expect(f['__type']).toBe(fd?.['__type']);
      }
      expect(arr(e['fieldInstances']).length).toBe(fieldDefs.size);
    }
    expect(arr(layers[1]?.['intGridCsv']).length).toBe(level.widthTiles * level.heightTiles);
  });

  test('six areas left → right, each graded, tiling the width with no uncovered remainder; the rest of §5.4', () => {
    expect(level.gradeZones.map((z) => z.grade)).toEqual(['glade', 'gully', 'rootwell', 'canopy', 'veil', 'shrine']);
    const ordered = [...level.gradeZones].sort((a, b) => a.x - b.x);
    expect(ordered[0]?.x).toBe(0);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1] as LevelData['gradeZones'][number];
      expect(ordered[i]?.x).toBe(prev.x + prev.w);
    }
    const last = ordered[ordered.length - 1];
    expect((last?.x ?? 0) + (last?.w ?? 0)).toBe(level.pxWidth);
    for (const z of level.gradeZones) {
      expect(z.y).toBe(0);
      expect(z.h).toBe(level.pxHeight);
      expect(z.blend).toBe(6 * TILE);
    }
    // Every tile lies in exactly one zone (the audio mood never falls back to its default).
    const uncovered: string[] = [];
    for (let ty = 0; ty < level.heightTiles; ty++) {
      for (let tx = 0; tx < level.widthTiles; tx++) {
        const cx = (tx + 0.5) * TILE;
        const cy = (ty + 0.5) * TILE;
        const n = level.gradeZones.filter((z) => cx >= z.x && cx < z.x + z.w && cy >= z.y && cy < z.y + z.h).length;
        if (n !== 1) uncovered.push(`${tx},${ty}×${n}`);
      }
    }
    expect(uncovered).toEqual([]);

    expect(level.orbs.length).toBeGreaterThanOrEqual(40);
    expect(level.orbs.length).toBeLessThanOrEqual(70);
    expect(level.checkpoints.length).toBeGreaterThanOrEqual(6);
    expect(zoneOf(level, level.playerStart.x)).toBe('glade');
    expect(level.lightShafts.filter((s) => zoneOf(level, s.x) === 'glade')).toHaveLength(1);
    expect(level.lightShafts.filter((s) => zoneOf(level, s.x) === 'canopy')).toHaveLength(2);

    // Crawlers first, then spitters; id = index.
    expect(level.enemies.map((e) => e.id)).toEqual(level.enemies.map((_, i) => i));
    const crawlers = level.enemies.filter((e): e is CrawlerDef => e.kind === 'gloomcrawler');
    const spitters = level.enemies.filter((e): e is SpitterDef => e.kind === 'thornSpitter');
    expect(level.enemies.slice(0, crawlers.length)).toEqual(crawlers);
    expect(crawlers).toHaveLength(1);
    const e = crawlers[0];
    const span = (e?.patrolMaxX ?? 0) - (e?.patrolMinX ?? 0) + DEFAULT_WORLD_TUNING.enemyWidth;
    expect(span / TILE).toBeGreaterThanOrEqual(9);
    expect(span / TILE).toBeLessThanOrEqual(12);
    expect(zoneOf(level, e?.x ?? 0)).toBe('canopy');
    expect(spitters.length).toBeGreaterThanOrEqual(3);
    for (const sp of spitters) expect(zoneOf(level, sp.x)).toBe('veil');

    const g = level.goal;
    expect(g).not.toBeNull();
    if (!g) return;
    expect(zoneOf(level, g.x)).toBe('shrine');
    expect(g.w / TILE).toBe(3);
    expect(g.h / TILE).toBe(4);
    for (let tx = g.x / TILE - 2; tx < (g.x + g.w) / TILE + 2; tx++) expect(tileAt(level, tx, (g.y + g.h) / TILE)).toBe(TileKind.Solid);
    const lanterns = level.decorHints.filter((d) => d.kind === 'lantern');
    expect(lanterns.length).toBeGreaterThanOrEqual(4);
    expect(lanterns.length).toBeLessThanOrEqual(6);
    for (const l of lanterns) expect(zoneOf(level, l.x)).toBe('shrine');
    expect(level.decorHints.filter((d) => d.kind === 'flora').length).toBeGreaterThanOrEqual(2);
  });

  test('no gameplay view is dominated by a dead mass (solid interior deeper than 3 tiles)', () => {
    // From every standable tile, the settled camera view: at most a sliver of it may be deep interior.
    const views = massViews(level, 3);
    expect(views.length).toBeGreaterThan(150);
    const worst = views[0];
    expect(worst?.deep ?? 1, `worst view at feet (${worst?.fx}, ${worst?.fy})`).toBeLessThan(0.08);
  });

  test('the Moonwell descends in open air: lantern ledge, the wall branch, the middle branch, the clearing', () => {
    const T = TILE;
    const tile = (tx: number, ty: number): TileKind => tileAt(level, tx, ty);
    // The branch by the east wall is anchored to it; the middle branch floats west of it.
    expect(tile(254, 28)).toBe(TileKind.OneWay);
    expect(tile(255, 28)).toBe(TileKind.Solid);
    expect(tile(239, 34)).toBe(TileKind.OneWay);
    expect(tile(245, 34)).toBe(TileKind.OneWay);
    // Open air between the ledge and the clearing floor, west of the well (the old solid cliff).
    let open = 0;
    for (let ty = 26; ty < 44; ty++) for (let tx = 226; tx < 244; tx++) if (tile(tx, ty) !== TileKind.Solid) open++;
    expect(open / (18 * 18)).toBeGreaterThan(0.85);
    // The clearing floor is one walkable run from the knoll to the east wall, with no drop to the kill plane.
    for (let tx = 225; tx < 259; tx++) expect(tile(tx, 44)).toBe(TileKind.Solid);
    expect(level.goal && level.goal.y + level.goal.h).toBe(44 * T);
  });

  test('the level frame: solid left/right borders, open sky on top', () => {
    for (let ty = 0; ty < level.heightTiles; ty++) {
      expect(tileAt(level, 0, ty)).toBe(TileKind.Solid);
      expect(tileAt(level, level.widthTiles - 1, ty)).toBe(TileKind.Solid);
    }
    let open = 0;
    for (let tx = 2; tx < level.widthTiles - 2; tx++) if (tileAt(level, tx, 0) === TileKind.Empty) open++;
    expect(open / (level.widthTiles - 4)).toBeGreaterThan(0.9);
  });

  test('the Thornveil shrine is a chokepoint: without the ability no spitter and not the goal is reachable', () => {
    const T = TILE;
    expect(level.abilityShrines).toHaveLength(1);
    const sh = level.abilityShrines[0];
    if (!sh) return;
    expect(sh.ability).toBe('launch');
    expect(zoneOf(level, sh.x)).toBe('veil');
    // The rect spans its corridor from floor to ceiling.
    for (let tx = sh.x / T; tx < (sh.x + sh.w) / T; tx++) {
      expect(tileAt(level, tx, (sh.y + sh.h) / T)).toBe(TileKind.Solid);
      expect(tileAt(level, tx, sh.y / T - 1)).toBe(TileKind.Solid);
      for (let ty = sh.y / T; ty < (sh.y + sh.h) / T; ty++) expect(tileAt(level, tx, ty)).not.toBe(TileKind.Solid);
    }
    // §5.4: the no-launch closure from the spawn, with the shrine rect as a blocker, reaches no spitter and
    // not the goal (the course is sealed by walls that reach the top edge; open sky is not a path).
    const sealed = chokepointClosure(level);
    for (const sp of level.enemies) if (sp.kind === 'thornSpitter') expect(touches(sealed, spitterBox(sp), T), `spitter ${sp.id}`).toBe(false);
    expect(level.goal && touches(sealed, level.goal, T)).toBe(false);
    // Control: without the blocker the same closure reaches the floor just past the shrine (and the goal).
    const past = `${(sh.x + sh.w) / T},${(sh.y + sh.h) / T}`;
    expect(sealed.floors.has(past)).toBe(false);
    const open = chokepointClosure(level, false);
    expect(open.floors.has(past)).toBe(true);
    // A checkpoint right after it: the first one east of the shrine, within a few tiles of its corridor.
    const next = level.checkpoints.filter((c) => c.x >= sh.x + sh.w).sort((a, b) => a.x - b.x)[0];
    expect(next).toBeDefined();
    expect(((next?.x ?? 0) - (sh.x + sh.w)) / T).toBeLessThanOrEqual(2);
  });

  test('the Moonwell is open to the sky and the Thornveil has no crawlers (the gate proofs model no stomps)', () => {
    const T = TILE;
    const shrine = level.gradeZones.find((z) => z.grade === 'shrine');
    const veil = level.gradeZones.find((z) => z.grade === 'veil');
    if (!shrine || !veil) throw new Error('zones');
    for (let tx = shrine.x / T; tx < (shrine.x + shrine.w) / T - 1; tx++) expect(tileAt(level, tx, 0), `column ${tx}`).toBe(TileKind.Empty);
    expect(level.enemies.filter((e) => e.kind === 'gloomcrawler' && e.x >= veil.x && e.x < veil.x + veil.w)).toEqual([]);
  });

  test('Thornveil spitters: anchor rhythms, the stun passage, the seed pool', () => {
    const T = TILE;
    const wt = DEFAULT_WORLD_TUNING;
    const spitters = level.enemies.filter((e): e is SpitterDef => e.kind === 'thornSpitter');
    const fixed = spitters.filter((sp) => sp.aim === 'fixed');
    const aimed = spitters.filter((sp) => sp.aim === 'player');
    expect(fixed.length).toBeGreaterThanOrEqual(2);
    for (const sp of fixed) expect(sp.period, `anchor ${sp.id}`).toBeLessThanOrEqual(120);
    expect(aimed.length).toBeGreaterThanOrEqual(1);
    for (const sp of aimed) {
      // A stun gate: its passage is ≤ 2 tiles tall, so its box plus the player's can't pass under the ceiling.
      const tx = Math.floor(sp.x / T);
      const floor = sp.y / T;
      let clear = 0;
      while (clear < 4 && tileAt(level, tx, floor - 1 - clear) !== TileKind.Solid) clear++;
      expect(clear, `spitter ${sp.id} passage height`).toBeLessThanOrEqual(2);
      expect(wt.spitterHeight + DEFAULT_TUNING.height).toBeGreaterThan(clear * T);
      // Its shots stay under that ceiling: the apex of a shot at the player's centre at its own height.
      const flight = sp.flightTicks * SIM_DT;
      expect((wt.seedGravity * flight * flight) / 8).toBeLessThan(clear * T - wt.spitterMuzzleHeight);
    }
    expect(seedPoolDemand(level, wt)).toBeLessThanOrEqual(MAX_PROJECTILES);
  });

  test('fairness: streams never touch a standing player or a respawn point; no respawn within an aimed range', () => {
    // Every fixed-aim seed flight (seedLifetimeTicks, the sim's SeedPool) against every standable spot
    // and every checkpoint's respawn stand box.
    expect(streamFairness(level)).toEqual([]);
    const wt = DEFAULT_WORLD_TUNING;
    for (const sp of level.enemies) {
      if (sp.kind !== 'thornSpitter' || sp.aim !== 'player') continue;
      for (const c of level.checkpoints) {
        const d = Math.hypot(c.x + c.w / 2 - sp.x, c.y + c.h - DEFAULT_TUNING.height / 2 - (sp.y - wt.spitterMuzzleHeight));
        expect(d, `checkpoint ${c.id} vs spitter ${sp.id}`).toBeGreaterThan(sp.range);
      }
    }
  });
});
