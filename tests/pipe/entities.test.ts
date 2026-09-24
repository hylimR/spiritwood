import { describe, expect, test } from 'vitest';
import { Container, Sprite } from 'pixi.js';
import { SimEventType, type EnemyView, type SimEvent } from '../../src/contracts/sim.ts';
import { SIM_DT } from '../../src/config.ts';
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

describe('entity atlas', () => {
  test('all images present, inside the atlas, deterministic', () => {
    const atlas = buildEntityAtlas();
    for (const name of ['lumenStone', 'rune', 'crawlerBody', 'crawlerEye', 'leg', 'orbCore', 'sparkle', 'beam', 'moonArch', 'lantern', 'pool', 'glow', 'wisp', 'ring']) {
      const f = atlas.frames[name];
      expect(f, name).toBeDefined();
      if (!f) continue;
      expect(f.x + f.w).toBeLessThanOrEqual(atlas.width);
      expect(f.y + f.h).toBeLessThanOrEqual(atlas.height);
    }
    expect(buildEntityAtlas().pixels).toEqual(atlas.pixels);
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

  test('builds three draw layers plus a glow layer and registers its atlas', () => {
    const { ctx, view } = setup();
    const root = ctx.scene.entities.children[0]!;
    expect(root.children.map((c) => c.blendMode)).toEqual(['add', 'inherit', 'add']);
    expect(ctx.glow.entities.children[0]!.children[0]!.blendMode).toBe('add');
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
