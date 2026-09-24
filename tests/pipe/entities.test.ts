import { describe, expect, test } from 'vitest';
import { Container, Sprite } from 'pixi.js';
import type { AbilityShrineDef } from '../../src/contracts/level.ts';
import { SimEventType, type EnemyView, type SimEvent } from '../../src/contracts/sim.ts';
import { SIM_DT, TILE } from '../../src/config.ts';
import { SHRINE_ART } from '../../src/render/entities/abilityShrineArt.ts';
import { ABILITY_SHRINE } from '../../src/render/entities/abilityShrines.ts';
import { buildEntityAtlas } from '../../src/render/entities/entityAtlas.ts';
import { EntitiesView } from '../../src/render/entities/entitiesView.ts';
import { gaitFoot, solveTwoBone } from '../../src/render/entities/legIk.ts';
import { ORB } from '../../src/render/entities/orbs.ts';
import { DebugDrawView } from '../../src/debug/debugDraw.ts';
import { hasOverlay } from '../../src/render/post/context.ts';
import { formatTime } from '../../src/ui/styles.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../shared/fixtures.ts';
import { createFrame, createTestContext, stepFrame, walk } from './helpers.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

const MAP = [
  '..............................',
  '..o...o.......................',
  '.C..P....C....EEEEE.......GG..',
  '##############################',
];

describe('leg IK and gait', () => {
  test('two-bone IK keeps segment lengths and bends to the requested side', () => {
    const k = { x: 0, y: 0 };
    for (const [fx, fy] of [[8, 10], [-6, 10], [0, 12], [15, 3]] as const) {
      for (const bend of [1, -1]) {
        solveTwoBone(0, 0, fx, fy, 11, 12, bend, k);
        expect(Math.hypot(k.x, k.y)).toBeCloseTo(11, 6);
        expect(Math.hypot(fx - k.x, fy - k.y)).toBeCloseTo(12, 5);
        const cross = fx * k.y - fy * k.x;
        expect(Math.sign(cross)).toBe(bend);
      }
    }
    solveTwoBone(0, 0, 100, 0, 11, 12, 1, k);
    expect(k.x).toBeCloseTo(11, 3);
  });

  test('stance feet stay put in the world (no sliding), swing feet lift and return', () => {
    const stride = 30;
    const reach = stride / 4;
    const a = { x: 0, y: 0 };
    const b = { x: 0, y: 0 };
    for (let d = 0.25; d < 2 * stride; d += 0.5) {
      const ph0 = (d / stride) * Math.PI * 2;
      const ph1 = ((d + 0.01) / stride) * Math.PI * 2;
      gaitFoot(ph0, d, 0, reach, 4, a);
      gaitFoot(ph1, d + 0.01, 0, reach, 4, b);
      const t = (d / stride) % 1;
      if (t < 0.49) {
        expect(a.y).toBe(0);
        expect(Math.abs(b.x - a.x)).toBeLessThan(1e-9);
      } else if (t > 0.51 && t < 0.99) {
        expect(a.y).toBeLessThan(0);
      }
    }
    gaitFoot(Math.PI * 2 - 1e-9, 0, 0, reach, 4, a);
    gaitFoot(0, 0, 0, reach, 4, b);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.y).toBeCloseTo(b.y, 6);
  });
});

/** Byte-exact equality without vitest's per-element deep compare (the atlas is > 1 MB). */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
}

describe('entity atlas', () => {
  const atlas = buildEntityAtlas();

  test('all images present, inside the atlas, deterministic', () => {
    const names = [
      'lumenStone', 'rune', 'crawlerBody', 'crawlerEye', 'leg', 'orbCore', 'sparkle', 'beam', 'moonArch', 'lantern', 'pool', 'glow',
      'wisp', 'ring', 'spitterRoots', 'spitterStem', 'spitterBulb', 'spitterBulbGlow', 'spitterLeaf', 'seedHostile', 'seedWisp',
      'seedTrail', 'seedEmber', 'glowLight', 'launchRing', 'aimArrow', 'shrinePedestal', 'shrineGlyph', 'lanternSeed',
      'lanternSeedLight', 'anchorStalk', 'anchorPod', 'anchorRing',
    ];
    for (const name of names) {
      const f = atlas.frames[name];
      expect(f, name).toBeDefined();
      if (!f) continue;
      expect(f.x + f.w).toBeLessThanOrEqual(atlas.width);
      expect(f.y + f.h).toBeLessThanOrEqual(atlas.height);
    }
    expect(sameBytes(buildEntityAtlas().pixels, atlas.pixels)).toBe(true);
  });

  test('premultiplied: colour never exceeds alpha except in emissive (light) images, whose light sits at alpha 0', () => {
    expect(atlas.premultiplied).toBe(true);
    const texel = (name: string, fn: (r: number, g: number, b: number, a: number) => void): void => {
      const f = atlas.frames[name]!;
      for (let y = 0; y < f.h; y++) {
        for (let x = 0; x < f.w; x++) {
          const o = ((f.y + y) * atlas.width + f.x + x) * 4;
          fn(atlas.pixels[o]!, atlas.pixels[o + 1]!, atlas.pixels[o + 2]!, atlas.pixels[o + 3]!);
        }
      }
    };
    // A straight image, premultiplied at pack time.
    texel('crawlerBody', (r, g, b, a) => expect(Math.max(r, g, b)).toBeLessThanOrEqual(a + 1));
    // Pure light: colour with alpha 0 (adds under normal blending).
    let lit = 0;
    texel('launchRing', (r, _g, _b, a) => {
      expect(a).toBe(0);
      if (r > 0) lit++;
    });
    expect(lit).toBeGreaterThan(100);
    // The hostile seed mixes a dark husk (alpha) with emissive light beyond it.
    let husk = 0;
    let glow = 0;
    texel('seedHostile', (r, _g, _b, a) => {
      if (a > 200 && r < a) husk++;
      if (a === 0 && r > 2) glow++;
    });
    expect(husk).toBeGreaterThan(20);
    expect(glow).toBeGreaterThan(100);
  });

  test('no image is cut by its frame: every border texel ≤ 2/255 (light and colour), bar the edges parts join on', () => {
    // Edges that meet another part by design (the ribbons' head ends sit under their seed; the stone
    // hides the beam's foot; opaque parts butt into the part drawn over them).
    const joined: Record<string, readonly ('left' | 'right' | 'top' | 'bottom')[]> = {
      seedTrail: ['left'], seedEmber: ['left'], beam: ['bottom'], spitterStem: ['top', 'bottom'], spitterBulb: ['bottom'],
      anchorStalk: ['bottom'], anchorPod: ['bottom'], lantern: ['top'],
    };
    const worst: string[] = [];
    for (const [name, f] of Object.entries(atlas.frames)) {
      const skip = joined[name] ?? [];
      const at = (x: number, y: number): number => {
        const o = ((f.y + y) * atlas.width + f.x + x) * 4;
        return Math.max(atlas.pixels[o]!, atlas.pixels[o + 1]!, atlas.pixels[o + 2]!, atlas.pixels[o + 3]!);
      };
      const side = { left: 0, right: 0, top: 0, bottom: 0 };
      for (let y = 0; y < f.h; y++) {
        side.left = Math.max(side.left, at(0, y));
        side.right = Math.max(side.right, at(f.w - 1, y));
      }
      for (let x = 0; x < f.w; x++) {
        side.top = Math.max(side.top, at(x, 0));
        side.bottom = Math.max(side.bottom, at(x, f.h - 1));
      }
      for (const k of ['left', 'right', 'top', 'bottom'] as const) if (!skip.includes(k) && side[k] > 2) worst.push(`${name} ${k} ${side[k]}`);
    }
    expect(worst).toEqual([]);
  });
});

describe('ability shrine', () => {
  test('the lantern-seed hovers a fixed tile above the pedestal rim, whatever the shrine rect\'s height', () => {
    expect(SHRINE_ART.seedY).toBe(-(SHRINE_ART.pedestalHeight + TILE));
    const level = levelFromAscii(['............', '............', '..A.....A...', '############']);
    const [short, tall] = level.abilityShrines as [AbilityShrineDef, AbilityShrineDef];
    const floor = short.y + short.h;
    // §5.4: a shrine rect spans its corridor floor to ceiling, often 3–5 tiles.
    tall.y = floor - 5 * TILE;
    tall.h = 5 * TILE;
    const ctx = createTestContext(level);
    const sim = createFakeSimView(level);
    const view = new EntitiesView();
    view.init(ctx);
    const frame = createFrame(sim, ctx);
    for (let i = 0; i < 5; i++) {
      stepFrame(frame, sim);
      view.update(frame);
    }
    const seeds: Sprite[] = [];
    walk(ctx.scene.entities, (c) => {
      if (c instanceof Sprite && c.texture.label === 'entity:lanternSeed') seeds.push(c);
    });
    expect(seeds).toHaveLength(2);
    for (const s of seeds) {
      const worldY = (s.parent as Container).y + s.y;
      expect(Math.abs(worldY - (floor + SHRINE_ART.seedY))).toBeLessThanOrEqual(ABILITY_SHRINE.bob + 1e-9);
    }
    view.destroy();
  });
});

describe('EntitiesView', () => {
  function setup(): { sim: FakeSim; ctx: ReturnType<typeof createTestContext>; view: EntitiesView; run: (n: number, f?: (i: number) => void, events?: SimEvent[]) => void } {
    const level = levelFromAscii(MAP);
    const ctx = createTestContext(level);
    const sim = createFakeSimView(level);
    const view = new EntitiesView();
    view.init(ctx);
    const frame = createFrame(sim, ctx);
    const run = (n: number, f?: (i: number) => void, events: SimEvent[] = []): void => {
      for (let i = 0; i < n; i++) {
        f?.(i);
        sim.tick++;
        stepFrame(frame, sim);
        if (i === 0) for (const e of events) view.onSimEvent(e, frame);
        ctx.stats.fillScreens = 0;
        view.update(frame);
      }
    };
    return { sim, ctx, view, run };
  }

  const groupsOf = (ctx: ReturnType<typeof createTestContext>): Container[] => {
    const body = ctx.scene.entities.children[0]!.children[1]!;
    return body.children as Container[];
  };

  test('builds its draw layers (seeds between bodies and emissives) and glow layers, and registers its atlas', () => {
    const { ctx, view } = setup();
    const root = ctx.scene.entities.children[0]!;
    expect(root.children.map((c) => c.label)).toEqual(['entities-back', 'entities-body', 'entities-seeds', 'entities-front']);
    expect(root.children.map((c) => c.blendMode)).toEqual(['add', 'inherit', 'inherit', 'add']);
    const glow = ctx.glow.entities.children[0]!;
    expect(glow.children.map((c) => c.label)).toEqual(['entities-occluders', 'entities-twins', 'entities-seed-twins']);
    expect(glow.children.map((c) => c.blendMode)).toEqual(['inherit', 'add', 'add']);
    expect(ctx.textures.totalBytes).toBeGreaterThan(0);
    view.destroy();
    expect(ctx.textures.totalBytes).toBe(0);
  });

  test('every entity state animates with finite transforms', () => {
    const { sim, ctx, run } = setup();
    const cp = sim.checkpoints[0] as Mutable<(typeof sim.checkpoints)[number]>;
    const enemy = sim.enemies[0] as Mutable<EnemyView>;
    const orb = sim.orbs[0] as Mutable<(typeof sim.orbs)[number]>;
    run(10, (i) => {
      enemy.prevX = enemy.x;
      enemy.x += 1.5;
      if (i === 5) enemy.facing = -1;
    });
    Object.assign(cp, { active: true, activatedTick: sim.tick });
    Object.assign(enemy, { mode: 'stunned', modeDuration: 180, modeTicks: 0 });
    run(40, () => { enemy.modeTicks++; }, [{ type: SimEventType.EnemyStomped, tick: 0, x: 0, y: 0, a: 0, b: 0, id: 0 }]);
    Object.assign(enemy, { mode: 'patrol', modeTicks: 0, modeDuration: 0 });
    if (sim.goal) (sim.goal as { reached: boolean }).reached = true;
    orb.prevX = orb.x;
    orb.x += 20;
    run(20, undefined, [
      { type: SimEventType.EnemyReformed, tick: 0, x: 0, y: 0, a: 0, b: 0, id: 0 },
      { type: SimEventType.GoalReached, tick: 0, x: 0, y: 0, a: 12, b: 0, id: -1 },
    ]);
    walk(ctx.scene.entities, (c) => {
      for (const v of [c.x, c.y, c.scale.x, c.scale.y, c.rotation, c.alpha]) expect(Number.isFinite(v)).toBe(true);
    });
    expect(ctx.stats.fillScreens).toBeGreaterThan(0);
  });

  test('collected orbs scale up, fade, then hide', () => {
    const { sim, ctx, run } = setup();
    const orb = sim.orbs[0] as Mutable<(typeof sim.orbs)[number]>;
    run(2);
    const groups = groupsOf(ctx);
    const orbGroup = groups[groups.length - 2]!;
    expect(orbGroup.visible).toBe(true);
    Object.assign(orb, { collected: true, collectedTick: sim.tick });
    run(Math.floor((ORB.collectTime / SIM_DT) / 2));
    const core = orbGroup.children[0] as Sprite;
    expect(core.alpha).toBeLessThan(1);
    expect(core.alpha).toBeGreaterThan(0);
    run(Math.ceil(ORB.collectTime / SIM_DT));
    expect(orbGroup.visible).toBe(false);
    Object.assign(orb, { collected: false, collectedTick: -1 });
    run(1);
    expect(orbGroup.visible).toBe(true);
  });

  test('crawler knees stay above the ground and never swap sides, walking and collapsing', () => {
    const { sim, ctx, run } = setup();
    const enemy = sim.enemies[0] as Mutable<EnemyView>;
    const crawler = groupsOf(ctx)[sim.checkpoints.length + 1] as Container;
    // Body layer: 6 far leg sprites, the body, 6 near leg sprites; each leg is thigh (at the hip) + shin (at the knee).
    const legs = [...crawler.children.slice(0, 6), ...crawler.children.slice(7, 13)] as Sprite[];
    const kneeSide = new Map<number, number>();
    const check = (): void => {
      for (let l = 0; l < legs.length; l += 2) {
        const hip = (legs[l] as Sprite).position;
        const knee = (legs[l + 1] as Sprite).position;
        expect(knee.y).toBeLessThan(0);
        const side = Math.sign(knee.x - hip.x);
        if (kneeSide.has(l)) expect(side).toBe(kneeSide.get(l));
        kneeSide.set(l, side);
      }
    };
    run(80, (i) => {
      enemy.prevX = enemy.x;
      enemy.x += 1.5;
      if (i > 0) check();
    });
    kneeSide.clear();
    Object.assign(enemy, { mode: 'stunned', modeDuration: 100, modeTicks: 0 });
    run(100, (i) => {
      enemy.modeTicks = i;
      if (i > 0) check();
    });
  });

  test('instances far from the camera are culled', () => {
    const { sim, ctx, run } = setup();
    run(1);
    const visibleBefore = groupsOf(ctx).filter((g) => g.visible).length;
    Object.assign(sim.camera, { x: 50_000, prevX: 50_000 });
    run(1);
    expect(groupsOf(ctx).filter((g) => g.visible).length).toBe(0);
    expect(visibleBefore).toBeGreaterThan(0);
  });
});

describe('DebugDrawView', () => {
  test('falls back to slot front without an overlay; tiles build once on enable', () => {
    const level = levelFromAscii(MAP);
    const ctx = createTestContext(level);
    expect(hasOverlay(ctx)).toBe(false);
    const view = new DebugDrawView();
    view.init(ctx);
    const root = ctx.scene.front.children[0]!;
    expect(root.visible).toBe(false);
    const sim = createFakeSimView(level);
    const frame = createFrame(sim, ctx);
    view.update(frame);
    view.onDebugDraw(true);
    expect(root.visible).toBe(true);
    stepFrame(frame, sim);
    expect(() => view.update(frame)).not.toThrow();
    view.onDebugDraw(false);
    expect(root.visible).toBe(false);
    view.destroy();
  });

  test('uses the pipeline overlay when present', () => {
    const level = levelFromAscii(MAP);
    const overlay = new Container();
    const ctx = { ...createTestContext(level), overlay };
    expect(hasOverlay(ctx)).toBe(true);
    const view = new DebugDrawView();
    view.init(ctx);
    expect(overlay.children).toHaveLength(1);
  });
});

describe('ui helpers', () => {
  test('formatTime', () => {
    expect(formatTime(0)).toBe('0:00.00');
    expect(formatTime(83.456)).toBe('1:23.45');
    expect(formatTime(-3)).toBe('0:00.00');
    expect(formatTime(600)).toBe('10:00.00');
  });
});
