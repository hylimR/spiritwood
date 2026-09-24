import { describe, expect, test } from 'vitest';
import type { Container, Sprite } from 'pixi.js';
import { SimEventType, type EnemyMode, type SimEvent } from '../../src/contracts/sim.ts';
import { EntitiesView } from '../../src/render/entities/entitiesView.ts';
import { SPITTER_ART } from '../../src/render/entities/spitterArt.ts';
import { createSpitterPose, SPITTER, SPITTER_MUZZLE_HEIGHT, spitterPose } from '../../src/render/entities/spitters.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../shared/fixtures.ts';
import { createFrame, createTestContext, stepFrame, walk } from './helpers.ts';

describe('spitterPose (pure)', () => {
  const pose = createSpitterPose();
  const at = (mode: EnemyMode, progress: number, sinceShot = -1, sinceReform = -1) => ({ ...spitterPose(mode, progress, sinceShot, sinceReform, pose) });

  test('idle and cooldown rest with a faint light', () => {
    for (const mode of ['idle', 'cooldown', 'patrol'] as const) {
      const p = at(mode, 0.5);
      expect(p.swell).toBe(0);
      expect(p.droop).toBe(0);
      expect(p.glow).toBeCloseTo(SPITTER.idleGlow, 9);
    }
  });

  test('the windup swells and lights the bulb with modeTicks / modeDuration, shivering at the end', () => {
    let swell = -1;
    let glow = -1;
    for (let t = 0; t <= 36; t++) {
      const p = at('windup', t / 36);
      expect(p.swell).toBeGreaterThanOrEqual(swell);
      expect(p.glow).toBeGreaterThan(glow);
      swell = p.swell;
      glow = p.glow;
    }
    expect(at('windup', 0).swell).toBe(0);
    expect(at('windup', 0).glow).toBeCloseTo(SPITTER.idleGlow, 9);
    expect(at('windup', 1).swell).toBe(1);
    expect(at('windup', 1).glow).toBeCloseTo(1, 9);
    expect(at('windup', 0.5).shiver).toBe(0);
    expect(at('windup', 0.95).shiver).toBeGreaterThan(0.5);
  });

  test('a shot flashes the bulb, then it dims back', () => {
    expect(at('cooldown', 0, 0).glow).toBeCloseTo(SPITTER.idleGlow + SPITTER.flashGlow, 9);
    expect(at('cooldown', 0, 0.1).glow).toBeLessThan(at('cooldown', 0, 0.02).glow);
    expect(at('cooldown', 0, 2).glow).toBeCloseTo(SPITTER.idleGlow, 3);
  });

  test('stunned droops and goes dark, stirring as the stun runs out', () => {
    const early = at('stunned', 0.02);
    const mid = at('stunned', 0.5);
    expect(early.droop).toBeGreaterThan(0);
    expect(early.droop).toBeLessThan(1);
    expect(mid.droop).toBe(1);
    expect(mid.glow).toBe(SPITTER.stunGlow);
    expect(mid.glow).toBeLessThan(SPITTER.idleGlow);
    expect(at('stunned', 0.5, 0).glow).toBe(SPITTER.stunGlow);
    expect(mid.shiver).toBe(0);
    expect(at('stunned', 0.97).shiver).toBeGreaterThan(0);
  });

  test('re-forming blooms briefly', () => {
    expect(at('cooldown', 0, -1, 0.1).bloom).toBeGreaterThan(0.3);
    expect(at('cooldown', 0, -1, 0.1).glow).toBeGreaterThan(SPITTER.idleGlow);
    expect(at('cooldown', 0, -1, SPITTER.bloomTime + 0.01).bloom).toBe(0);
    expect(at('idle', 0, -1, -1).bloom).toBe(0);
  });

  test('the art puts the mouth on the sim muzzle (50 u above the feet)', () => {
    expect(SPITTER_MUZZLE_HEIGHT).toBe(50);
    expect(SPITTER_ART.stemBaseY - SPITTER_ART.stemLength + SPITTER_ART.mouthY).toBe(-50);
  });
});

describe('SpitterRenderer in the EntitiesView', () => {
  const MAP = [
    '..........................',
    '..........................',
    '..P....E...S.....U........',
    '##########################',
  ];

  function rig() {
    const level = levelFromAscii(MAP);
    const ctx = createTestContext(level);
    const sim = createFakeSimView(level);
    for (const e of sim.enemies) if (e.kind === 'thornSpitter') Object.assign(e, { width: 44, height: 60 });
    const view = new EntitiesView();
    view.init(ctx);
    const frame = createFrame(sim, ctx);
    const pending: SimEvent[] = [];
    const run = (n: number, each?: (i: number) => void): void => {
      for (let i = 0; i < n; i++) {
        each?.(i);
        sim.tick++;
        stepFrame(frame, sim);
        for (const e of pending) view.onSimEvent(e, frame);
        pending.length = 0;
        view.update(frame);
      }
    };
    const spitterIds = sim.enemies.filter((e) => e.kind === 'thornSpitter').map((e) => e.id);
    return { ctx, sim, view, frame, run, pending, spitterIds };
  }

  /** Body sprites of spitter item k: [back leaf, back leaf, stem, bulb, roots, front leaf, front leaf]. */
  function bodyOf(ctx: ReturnType<typeof createTestContext>, sim: FakeSim, k: number): Sprite[] {
    const body = ctx.scene.entities.children[0]!.children[1] as Container;
    const crawlers = sim.enemies.filter((e) => e.kind === 'gloomcrawler').length;
    const before = sim.checkpoints.length + 1 + sim.level.abilityShrines.length + crawlers;
    return (body.children[before + k] as Container).children as Sprite[];
  }

  test('one plant per spitter (crawlers keep theirs), each with an occluder in the glow slot', () => {
    const { ctx, sim } = rig();
    const glow = ctx.glow.entities.children[0] as Container;
    const occluders = glow.children[0] as Container;
    expect(occluders.label).toBe('entities-occluders');
    expect(occluders.children).toHaveLength(2);
    for (const occ of occluders.children) for (const s of occ.children as Sprite[]) expect(s.tint).toBe(0x000000);
    expect(bodyOf(ctx, sim, 0)).toHaveLength(7);
  });

  test('pose follows mode and modeTicks: swell and light over the windup, recoil on SeedFired, droop while stunned', () => {
    const { ctx, sim, run, pending, spitterIds, frame } = rig();
    const en = sim.enemies[spitterIds[0] as number] as FakeSim['enemies'][number];
    const parts = bodyOf(ctx, sim, 0);
    const bulb = parts[3] as Sprite;
    const stem = parts[2] as Sprite;
    const glow = (ctx.scene.entities.children[0]!.children[3] as Container).children
      .flatMap((g) => g.children as Sprite[]).find((s) => s.texture.label === 'entity:spitterBulbGlow') as Sprite;
    run(5);
    const rest = { sx: bulb.scale.x, alpha: glow.alpha, rot: stem.rotation };
    Object.assign(en, { mode: 'windup', modeTicks: 0, modeDuration: 36, facing: 1 });
    run(1);
    const early = { sx: bulb.scale.x, alpha: glow.alpha };
    run(30, () => { en.modeTicks++; });
    expect(bulb.scale.x).toBeGreaterThan(early.sx);
    expect(glow.alpha).toBeGreaterThan(early.alpha);
    expect(glow.alpha).toBeGreaterThan(rest.alpha);
    // Fire: SeedFired names the seed; its sourceId is this spitter.
    Object.assign(sim.projectiles[0] as object, { active: true, sourceId: en.id, x: en.x, y: en.y - SPITTER_MUZZLE_HEIGHT, spawnTick: sim.tick });
    Object.assign(en, { mode: 'cooldown', modeTicks: 0, modeDuration: 114 });
    pending.push({ type: SimEventType.SeedFired, tick: sim.tick, x: en.x, y: en.y - SPITTER_MUZZLE_HEIGHT, a: 0, b: -900, id: 0 });
    run(1);
    // The recoil squashes the bulb (shorter), the flash keeps it lit.
    expect(bulb.scale.y).toBeLessThan(bulb.scale.x);
    expect(glow.alpha).toBeGreaterThan(0.7);
    run(60, () => { en.modeTicks++; });
    expect(glow.alpha).toBeCloseTo(SPITTER.idleGlow, 2);
    Object.assign(en, { mode: 'stunned', modeTicks: 0, modeDuration: 300 });
    run(60, () => { en.modeTicks++; });
    expect(stem.rotation - rest.rot).toBeGreaterThan(SPITTER.droopStem * 0.8);
    expect(glow.alpha).toBeLessThan(0.1);
    expect(bulb.tint).not.toBe(0xffffff);
    Object.assign(en, { mode: 'cooldown', modeTicks: 0, modeDuration: 150 });
    pending.push({ type: SimEventType.EnemyReformed, tick: sim.tick, x: en.x, y: en.y, a: 0, b: 0, id: en.id });
    run(4);
    expect(glow.alpha).toBeGreaterThan(SPITTER.idleGlow);
    run(90);
    // Upright again, leaning toward the player (who is to its left) while it cycles.
    expect(stem.rotation - rest.rot).toBeLessThan(0);
    expect(stem.rotation - rest.rot).toBeGreaterThan(-SPITTER.maxLean - 0.05);
    Object.assign(en, { mode: 'idle', modeTicks: 0, modeDuration: 0 });
    run(90);
    expect(Math.abs(stem.rotation - rest.rot)).toBeLessThan(0.05);
    walk(ctx.scene.entities, (c) => {
      for (const v of [c.x, c.y, c.scale.x, c.scale.y, c.rotation, c.alpha]) expect(Number.isFinite(v)).toBe(true);
    });
    void frame;
  });

  test('the body faces `facing` and the world clock drives it (frozen time: no idle motion)', () => {
    const { ctx, sim, run, spitterIds, frame } = rig();
    const en = sim.enemies[spitterIds[0] as number] as FakeSim['enemies'][number];
    const group = bodyOf(ctx, sim, 0);
    run(3);
    const parent = (group[0] as Sprite).parent as Container;
    expect(parent.scale.x).toBeGreaterThan(0);
    en.facing = -1;
    run(30);
    expect(parent.scale.x).toBeCloseTo(-1, 6);
    const leaf = group[0] as Sprite;
    frame.timeScale = 0;
    run(1);
    const r0 = leaf.rotation;
    run(20);
    expect(leaf.rotation).toBeCloseTo(r0, 9);
    frame.timeScale = 1;
    run(20);
    expect(leaf.rotation).not.toBeCloseTo(r0, 4);
  });
});
