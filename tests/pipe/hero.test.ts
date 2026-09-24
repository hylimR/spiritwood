import { describe, expect, test } from 'vitest';
import type { Container, Sprite } from 'pixi.js';
import { SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';
import { buildHeroAssets } from '../../src/render/hero/heroAssets.ts';
import { HERO_CLIP } from '../../src/render/hero/heroClips.ts';
import { HERO_DENSITY, partImageName } from '../../src/render/hero/heroParts.ts';
import { HERO_PARTS } from '../../src/render/hero/heroRig.ts';
import { chooseHeroClip, fadeBetween, fadeInto, HERO_ANIM, type HeroAnimInput } from '../../src/render/hero/heroState.ts';
import { diveTarget, faceTarget, HeroView } from '../../src/render/hero/heroView.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../shared/fixtures.ts';
import { createFrame, createTestContext, stepFrame, walk } from './helpers.ts';

function input(over: Partial<HeroAnimInput> = {}): HeroAnimInput {
  return {
    mode: 'ground', alive: true, grounded: true, vx: 0, vy: 0, inputX: 0,
    sinceLand: 99, sinceWallJump: 99, sinceRespawn: 99, flipping: false, ...over,
  };
}

describe('hero clip selection', () => {
  test('ground', () => {
    expect(chooseHeroClip(input())).toBe(HERO_CLIP.idle);
    expect(chooseHeroClip(input({ vx: 300 }))).toBe(HERO_CLIP.run);
    expect(chooseHeroClip(input({ vx: 0, inputX: 1 }))).toBe(HERO_CLIP.run);
    expect(chooseHeroClip(input({ sinceLand: 0.05 }))).toBe(HERO_CLIP.land);
    expect(chooseHeroClip(input({ sinceLand: 0.05, vx: 440 }))).toBe(HERO_CLIP.run);
    expect(chooseHeroClip(input({ sinceLand: HERO_ANIM.landTime + 0.01 }))).toBe(HERO_CLIP.idle);
  });

  test('air', () => {
    const air = { mode: 'air' as const, grounded: false };
    expect(chooseHeroClip(input({ ...air, vy: -600 }))).toBe(HERO_CLIP.jump);
    expect(chooseHeroClip(input({ ...air, vy: 200 }))).toBe(HERO_CLIP.fall);
    expect(chooseHeroClip(input({ ...air, vy: -600, flipping: true }))).toBe(HERO_CLIP.doubleJump);
    expect(chooseHeroClip(input({ ...air, vy: -600, sinceWallJump: 0.1 }))).toBe(HERO_CLIP.wallJump);
  });

  test('Spirit Launch: launchAim and launched come from the player modes, fading in 60–120 ms', () => {
    expect(chooseHeroClip(input({ mode: 'launchAim' }))).toBe(HERO_CLIP.launchAim);
    expect(chooseHeroClip(input({ mode: 'launchAim', grounded: false, vy: -500, flipping: true }))).toBe(HERO_CLIP.launchAim);
    expect(chooseHeroClip(input({ mode: 'launched', grounded: false, vy: -900 }))).toBe(HERO_CLIP.launched);
    expect(chooseHeroClip(input({ mode: 'launched', sinceRespawn: 0.1 }))).toBe(HERO_CLIP.launched);
    expect(chooseHeroClip(input({ mode: 'dead', alive: false }))).toBe(HERO_CLIP.dead);
    for (const to of [HERO_CLIP.launchAim, HERO_CLIP.launched]) {
      for (const from of Object.values(HERO_CLIP)) {
        expect(fadeBetween(from, to)).toBeGreaterThanOrEqual(0.06);
        expect(fadeBetween(from, to)).toBeLessThanOrEqual(0.12);
      }
    }
    for (const to of Object.values(HERO_CLIP)) {
      for (const from of [HERO_CLIP.launchAim, HERO_CLIP.launched]) {
        expect(fadeBetween(from, to)).toBeGreaterThanOrEqual(0.06);
        expect(fadeBetween(from, to)).toBeLessThanOrEqual(0.12);
      }
    }
    expect(fadeBetween(HERO_CLIP.idle, HERO_CLIP.fall)).toBe(fadeInto(HERO_CLIP.fall));
  });

  test('dive and facing helpers', () => {
    expect(diveTarget(0, -1150, 1)).toBeCloseTo(0, 9);
    expect(diveTarget(1150, 0, 1)).toBeCloseTo(Math.PI / 2, 9);
    expect(diveTarget(-1150, 0, -1)).toBeCloseTo(Math.PI / 2, 9);
    expect(diveTarget(0, 1150, 1)).toBeCloseTo(Math.PI, 9);
    expect(diveTarget(0, 0, 1)).toBe(0);
    const p = { mode: 'launchAim', facing: 1 } as Parameters<typeof faceTarget>[0];
    const L = { targetKind: 'seed', targetX: 100 } as Parameters<typeof faceTarget>[1];
    expect(faceTarget(p, L, 200)).toBe(-1);
    expect(faceTarget(p, L, 20)).toBe(1);
    expect(faceTarget(p, L, 102)).toBe(1);
    expect(faceTarget({ ...p, mode: 'air' }, L, 200)).toBe(1);
  });

  test('modes and life', () => {
    expect(chooseHeroClip(input({ mode: 'dash', grounded: false }))).toBe(HERO_CLIP.dash);
    expect(chooseHeroClip(input({ mode: 'wallSlide', grounded: false, vy: 150 }))).toBe(HERO_CLIP.wallSlide);
    expect(chooseHeroClip(input({ mode: 'dead', alive: false }))).toBe(HERO_CLIP.dead);
    expect(chooseHeroClip(input({ sinceRespawn: 0.1 }))).toBe(HERO_CLIP.respawn);
    expect(chooseHeroClip(input({ sinceRespawn: 0.1, vx: 300 }))).toBe(HERO_CLIP.run);
  });
});

describe('hero atlas', () => {
  const atlas = buildHeroAssets();

  test('every attachment has both lighting variants, all inside the atlas', () => {
    for (const p of HERO_PARTS) {
      for (const left of [false, true]) {
        const f = atlas.frames[partImageName(p.image, p.lit, left)];
        expect(f, p.image).toBeDefined();
        if (!f) continue;
        expect(f.x).toBeGreaterThanOrEqual(0);
        expect(f.y).toBeGreaterThanOrEqual(0);
        expect(f.x + f.w).toBeLessThanOrEqual(atlas.width);
        expect(f.y + f.h).toBeLessThanOrEqual(atlas.height);
        expect(f.density).toBe(HERO_DENSITY);
      }
    }
    for (const name of ['halo', 'scarf', 'ghost', 'eye', 'bud']) expect(atlas.frames[name], name).toBeDefined();
  });

  test('frames do not overlap and keep a transparent gutter', () => {
    const frames = Object.values(atlas.frames);
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        const a = frames[i]!;
        const b = frames[j]!;
        const apart = a.x + a.w + 4 <= b.x || b.x + b.w + 4 <= a.x || a.y + a.h + 4 <= b.y || b.y + b.h + 4 <= a.y;
        expect(apart).toBe(true);
      }
    }
  });

  test('parts have coverage and the lighting variants differ (rim on the moon side)', () => {
    const r = atlas.frames['head@R']!;
    const l = atlas.frames['head@L']!;
    let alpha = 0;
    let leftR = 0;
    let leftL = 0;
    for (let y = 0; y < r.h; y++) {
      for (let x = 0; x < r.w / 2; x++) {
        const o = ((r.y + y) * atlas.width + r.x + x) * 4;
        const q = ((l.y + y) * atlas.width + l.x + x) * 4;
        alpha += atlas.pixels[o + 3]!;
        leftR += atlas.pixels[o]! * atlas.pixels[o + 3]!;
        leftL += atlas.pixels[q]! * atlas.pixels[q + 3]!;
      }
    }
    expect(alpha).toBeGreaterThan(0);
    expect(leftR).toBeGreaterThan(leftL);
  });

  test('deterministic', () => {
    const again = buildHeroAssets().pixels;
    expect(again.length).toBe(atlas.pixels.length);
    expect(Buffer.compare(Buffer.from(again), Buffer.from(atlas.pixels))).toBe(0);
  });
});

function spritesOf(c: Container): Sprite[] {
  const out: Sprite[] = [];
  walk(c, (n) => {
    if ('anchor' in n) out.push(n as Sprite);
  });
  return out;
}

describe('HeroView', () => {
  const level = levelFromAscii(['.'.repeat(40), '.'.repeat(40), '....P'.padEnd(40, '.'), '#'.repeat(40)]);

  function setup(): { view: HeroView; sim: FakeSim; ctx: ReturnType<typeof createTestContext>; run: (n: number, f?: (i: number) => void) => void; emit: (e: Partial<SimEvent> & Pick<SimEvent, 'type'>) => void } {
    const ctx = createTestContext(level);
    const sim = createFakeSimView(level);
    const view = new HeroView();
    view.init(ctx);
    const frame = createFrame(sim, ctx);
    const pending: SimEvent[] = [];
    const emit = (e: Partial<SimEvent> & Pick<SimEvent, 'type'>): void => {
      pending.push({ tick: sim.tick, x: sim.player.x, y: sim.player.y, a: 0, b: 0, id: -1, ...e });
    };
    const run = (n: number, f?: (i: number) => void): void => {
      for (let i = 0; i < n; i++) {
        f?.(i);
        sim.tick++;
        stepFrame(frame, sim, 1 / 60, 0.5);
        ctx.stats.fillScreens = 0;
        for (const e of pending) view.onSimEvent(e, frame);
        pending.length = 0;
        view.update(frame);
      }
    };
    return { view, sim, ctx, run, emit };
  }

  test('init registers the atlas and builds one container per slot', () => {
    const { ctx, view } = setup();
    expect(ctx.scene.hero.children).toHaveLength(1);
    expect(ctx.glow.hero.children).toHaveLength(1);
    expect(ctx.textures.totalBytes).toBeGreaterThan(0);
    view.destroy();
    expect(ctx.textures.totalBytes).toBe(0);
  });

  test('a scripted run through every state keeps transforms finite and near the player', () => {
    const { sim, ctx, run, emit } = setup();
    const p = sim.player;
    const move = (vx: number, vy: number) => {
      p.prevX = p.x;
      p.prevY = p.y;
      p.vx = vx;
      p.vy = vy;
      p.x += vx / 60;
      p.y += vy / 60;
      if (p.grounded) p.runDistance += Math.abs(vx / 60);
    };
    const check = () => {
      for (const s of spritesOf(ctx.scene.hero)) {
        for (const v of [s.x, s.y, s.scale.x, s.scale.y, s.rotation, s.skew.x, s.alpha]) expect(Number.isFinite(v)).toBe(true);
      }
      const body = ctx.scene.hero.children[0]!.children[1]!;
      expect(Math.abs(body.x - p.x)).toBeLessThan(20);
    };
    run(30);
    run(60, () => { p.inputX = 1; move(440, 0); });
    check();
    emit({ type: SimEventType.Jump, a: 1 });
    p.grounded = false;
    p.mode = 'air';
    run(20, (i) => move(440, -700 + i * 50));
    emit({ type: SimEventType.AirJump, a: 1 });
    run(20, (i) => move(440, -500 + i * 60));
    check();
    run(10, () => move(-440, 400));
    p.facing = -1;
    run(10, () => move(-440, 400));
    emit({ type: SimEventType.Land, a: 900, b: 300 });
    p.grounded = true;
    p.mode = 'ground';
    run(20, () => move(0, 0));
    check();
    p.mode = 'wallSlide';
    p.grounded = false;
    p.wallDir = 1;
    run(20, () => move(0, 190));
    emit({ type: SimEventType.WallJump, a: -1 });
    p.mode = 'air';
    run(10, () => move(-520, -600));
    emit({ type: SimEventType.Dash, a: -1, b: 1 });
    p.mode = 'dash';
    run(10, () => move(-1180, 0));
    emit({ type: SimEventType.DashEnd, a: -1 });
    p.mode = 'air';
    run(10, () => move(-440, 100));
    check();
    const ghosts = ctx.scene.hero.children[0]!.children[0]!.children as Sprite[];
    expect(ghosts.some((g) => g.x !== 0)).toBe(true);
    expect(ctx.stats.fillScreens).toBeGreaterThan(0);
  });

  test('death dissolves then hides; respawn resets and fades in', () => {
    const { sim, ctx, run, emit } = setup();
    const p = sim.player;
    run(5);
    emit({ type: SimEventType.Died, a: 1 });
    p.alive = false;
    p.mode = 'dead';
    p.deadTicks = 0;
    run(DEFAULT_WORLD_TUNING.deathHideTicks, () => { p.deadTicks++; });
    const body = ctx.scene.hero.children[0]!.children[1]!;
    expect(body.alpha).toBeLessThan(0.2);
    p.visible = false;
    run(10, () => { p.deadTicks++; });
    expect(body.visible).toBe(false);
    p.alive = true;
    p.visible = true;
    p.mode = 'ground';
    p.deadTicks = -1;
    p.x += 500;
    p.prevX = p.x;
    p.warpTick = sim.tick;
    emit({ type: SimEventType.Respawned });
    run(1);
    expect(body.visible).toBe(true);
    expect(body.alpha).toBeLessThan(0.3);
    expect(Math.abs(body.x - p.x)).toBeLessThan(1e-6);
    run(60);
    expect(body.alpha).toBe(1);
  });

  test('every bloom twin in glow slot hero blends additively', () => {
    const { ctx, run } = setup();
    run(3);
    let leaves = 0;
    walk(ctx.glow.hero, (n) => {
      if (!('texture' in n) || n.children.length > 0) return;
      leaves++;
      let blend = n.blendMode;
      for (let c = n.parent; blend === 'inherit' && c; c = c.parent) blend = c.blendMode;
      expect(blend, n.label).toBe('add');
    });
    expect(leaves).toBeGreaterThan(10);
  });

  test('Spirit Launch: aims facing the target, dives head-first along the flight, streaks, then rights itself', () => {
    const { sim, ctx, run, emit } = setup();
    const p = sim.player;
    run(10);
    const head = spritesOf(ctx.scene.hero).find((s) => s.texture.label?.startsWith('hero:head')) as Sprite;
    const body = ctx.scene.hero.children[0]!.children[1]!;
    // Aim at a seed to the left: the hero turns to face it.
    Object.assign(sim.launch, { unlocked: true, targetKind: 'seed', targetId: 0, targetX: p.x - 80, targetY: p.y - 60, aimX: 0.6, aimY: -0.8 });
    p.mode = 'launchAim';
    emit({ type: SimEventType.LaunchAim, x: p.x - 80, y: p.y - 60, a: 1, id: 0 });
    run(20);
    head.updateLocalTransform();
    expect(head.localTransform.a * head.localTransform.d - head.localTransform.b * head.localTransform.c).toBeLessThan(0);
    // Release to the right: the head leads, level with the body's centre and right of the feet.
    p.mode = 'launched';
    p.grounded = false;
    p.facing = 1;
    p.vx = 1150;
    p.vy = 0;
    emit({ type: SimEventType.Launch, a: 0, b: 1, id: 0 });
    const streak = ctx.scene.hero.children[0]!.children[0]!.children.find((c) => (c as Sprite).texture?.label === 'hero:streak') as Sprite;
    run(6, () => {
      p.prevX = p.x;
      p.x += p.vx / 60;
    });
    expect(streak.alpha).toBeGreaterThan(0.2);
    expect(streak.rotation).toBeCloseTo(0, 3);
    // The head (anchored at its neck) sits right of the core, turned ≈ 90° onto the flight.
    expect(head.x).toBeGreaterThan(5);
    expect(Math.abs(head.y + 26)).toBeLessThan(6);
    head.updateLocalTransform();
    const angle = Math.atan2(head.localTransform.b, head.localTransform.a);
    expect(angle).toBeGreaterThan(1.1);
    expect(angle).toBeLessThan(1.8);
    expect(body.alpha).toBe(1);
    // The flight ends: the body rights itself and the streak is gone.
    p.mode = 'air';
    p.vx = 400;
    p.vy = 200;
    run(40, () => {
      p.prevX = p.x;
      p.x += p.vx / 60;
    });
    expect(head.y).toBeLessThan(-30);
    expect(Math.abs(head.x)).toBeLessThan(12);
    expect(streak.alpha).toBe(0);
  });

  test('a death mid-streak: the streak still plays out and parks while the hero is hidden', () => {
    const { sim, ctx, run, emit } = setup();
    const p = sim.player;
    run(10);
    const streak = ctx.scene.hero.children[0]!.children[0]!.children.find((c) => (c as Sprite).texture?.label === 'hero:streak') as Sprite;
    Object.assign(p, { mode: 'launched', grounded: false, vx: 1150, vy: 0 });
    emit({ type: SimEventType.Launch, a: 0, b: 1, id: 0 });
    run(3, () => {
      p.prevX = p.x;
      p.x += p.vx / 60;
    });
    expect(streak.alpha).toBeGreaterThan(0.2);
    // Flung into thorns three ticks after the release: dies, then hides after deathHideTicks.
    Object.assign(p, { mode: 'dead', alive: false, deadTicks: 0, vx: 0, vy: 0 });
    const hide = DEFAULT_WORLD_TUNING.deathHideTicks;
    let hiddenAlpha = -1;
    run(DEFAULT_WORLD_TUNING.dyingTicks - 1, (i) => {
      p.deadTicks = i + 1;
      if (p.deadTicks >= hide) {
        if (p.visible) hiddenAlpha = streak.alpha;
        (p as { visible: boolean }).visible = false;
      }
    });
    expect(p.visible).toBe(false);
    expect(hiddenAlpha).toBeGreaterThanOrEqual(0);
    // Well past its 0.42 s life: faded and parked (alpha 0, zero area), not frozen on screen.
    expect(streak.alpha).toBe(0);
    expect(streak.width).toBe(0);
  });

  test('facing left swaps to the mirrored lighting variants', () => {
    const { sim, ctx, run } = setup();
    run(5);
    const head = spritesOf(ctx.scene.hero).find((s) => s.texture.label === 'hero:head@R');
    expect(head).toBeDefined();
    sim.player.facing = -1;
    run(20);
    expect(head!.texture.label).toBe('hero:head@L');
    head!.updateLocalTransform();
    const m = head!.localTransform;
    expect(m.a * m.d - m.b * m.c).toBeLessThan(0);
  });
});
