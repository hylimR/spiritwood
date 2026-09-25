import { describe, expect, test } from 'vitest';
import type { Container, Sprite } from 'pixi.js';
import type { LevelData, SpitterDef } from '../../src/contracts/level.ts';
import { SimEventType, type EnemyMode, type SimEvent } from '../../src/contracts/sim.ts';
import { EntitiesView } from '../../src/render/entities/entitiesView.ts';
import { ANCHOR_ART, ANCHOR_STALK_LENGTH, SPITTER_ART } from '../../src/render/entities/spitterArt.ts';
import {
  ANCHOR, anchorCharge, anchorRingLevel, createSpitterPose, SPITTER, SPITTER_MUZZLE_HEIGHT, spitterPose,
} from '../../src/render/entities/spitters.ts';
import { createFakeSimView, levelFromAscii, SIM_SPITTER_MUZZLE_HEIGHT, type FakeSim } from '../shared/fixtures.ts';
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

  test('the art puts the mouth on the sim muzzle', () => {
    expect(SPITTER_MUZZLE_HEIGHT).toBe(SIM_SPITTER_MUZZLE_HEIGHT);
    expect(SPITTER_ART.stemBaseY - SPITTER_ART.stemLength + SPITTER_ART.mouthY).toBe(-50);
  });
});

describe('anchor (fixed-aim) spitters (pure)', () => {
  test('the pod\'s tip is the sim muzzle, on a stalk taller than the bulb\'s stem', () => {
    expect(-ANCHOR_ART.podTipY).toBe(SIM_SPITTER_MUZZLE_HEIGHT);
    expect(ANCHOR_ART.stalkBaseY - ANCHOR_STALK_LENGTH - ANCHOR_ART.podLength).toBe(ANCHOR_ART.podTipY);
    expect(ANCHOR_STALK_LENGTH).toBeGreaterThan(SPITTER_ART.stemLength);
  });

  test('the charge climbs through the cooldown, then faster through the windup, to 1 at the shot', () => {
    let last = -1;
    const steps = 40;
    for (const mode of ['cooldown', 'windup'] as const) {
      for (let i = 0; i <= steps; i++) {
        const c = anchorCharge(mode, i / steps);
        expect(c).toBeGreaterThanOrEqual(last - 1e-12);
        last = c;
      }
    }
    expect(anchorCharge('cooldown', 0)).toBe(0);
    expect(anchorCharge('windup', 0)).toBeCloseTo(ANCHOR.windupFrom, 12);
    expect(anchorCharge('windup', 1)).toBeCloseTo(1, 12);
    expect(anchorCharge('idle', 0.5)).toBe(ANCHOR.idleCharge);
  });

  test('the rings light in turn, base to tip; the tip ring only in the windup; embers at rest', () => {
    const rings = ANCHOR_ART.rings.length;
    const lightsAt = (k: number): number => {
      for (let c = 0; c <= 1; c += 0.001) if (anchorRingLevel(k, c) > 0.5) return c;
      return Infinity;
    };
    for (let k = 1; k < rings; k++) expect(lightsAt(k)).toBeGreaterThan(lightsAt(k - 1) + 0.1);
    for (const c of [0.2, 0.45, 0.7, 0.9]) {
      for (let k = 1; k < rings; k++) expect(anchorRingLevel(k, c)).toBeLessThanOrEqual(anchorRingLevel(k - 1, c) + 1e-12);
    }
    const tip = rings - 1;
    expect(anchorRingLevel(tip, anchorCharge('cooldown', 1))).toBeLessThan(0.3);
    expect(anchorRingLevel(tip, anchorCharge('windup', 0.95))).toBeGreaterThan(0.8);
    for (let k = 0; k < rings; k++) expect(anchorRingLevel(k, 0)).toBeCloseTo(ANCHOR.ringEmber, 12);
  });
});

describe('SpitterRenderer in the EntitiesView', () => {
  const MAP = [
    '..........................',
    '..........................',
    '..P....E...S.....U........',
    '##########################',
  ];

  function rig(edit?: (level: LevelData) => void) {
    const level = levelFromAscii(MAP);
    edit?.(level);
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

  test('the level\'s aim picks the species: the hunter keeps its bulb, the anchor grows a pod on a stalk', () => {
    const { ctx, sim, view, spitterIds } = rig();
    const [hunter, anchor] = spitterIds as [number, number];
    expect(sim.level.enemies[hunter]).toMatchObject({ kind: 'thornSpitter', aim: 'player' });
    expect(sim.level.enemies[anchor]).toMatchObject({ kind: 'thornSpitter', aim: 'fixed' });
    expect(view.spitters?.isAnchor(hunter)).toBe(false);
    expect(view.spitters?.isAnchor(anchor)).toBe(true);
    const labels = (k: number): string[] => bodyOf(ctx, sim, k).map((s) => s.texture.label ?? '');
    expect(labels(0)).toContain('entity:spitterBulb');
    expect(labels(0)).not.toContain('entity:anchorPod');
    expect(labels(1)).toEqual(expect.arrayContaining(['entity:anchorStalk', 'entity:anchorPod', 'entity:spitterRoots', 'entity:spitterLeaf']));
    expect(labels(1)).not.toContain('entity:spitterBulb');
    // The same seven body parts from the same atlas: the same batches.
    expect(bodyOf(ctx, sim, 1)).toHaveLength(7);
    const source = bodyOf(ctx, sim, 0)[0]?.texture.source;
    for (const s of bodyOf(ctx, sim, 1)) expect(s.texture.source).toBe(source);
  });

  test('an anchor\'s mouth sits on the muzzle and its pod points along the fixed aim, for any aim', () => {
    const density = 3;
    for (const [ax, ay] of [[0, -1], [0.5, -Math.sqrt(0.75)], [-0.6, -0.8], [1, 0]] as const) {
      const { ctx, sim, run, spitterIds } = rig((level) => {
        const def = level.enemies.find((e) => e.kind === 'thornSpitter' && e.aim === 'fixed') as SpitterDef;
        def.fixedVx = ax * 900;
        def.fixedVy = ay * 900;
      });
      const en = sim.enemies[spitterIds[1] as number] as FakeSim['enemies'][number];
      en.facing = ax < 0 ? -1 : 1;
      run(3);
      const parts = bodyOf(ctx, sim, 1);
      const stalk = parts[2] as Sprite;
      const pod = parts[3] as Sprite;
      const tip = pod.toGlobal({ x: 0, y: 0 });
      expect(tip.x).toBeCloseTo(en.x, 6);
      expect(tip.y).toBeCloseTo(en.y - SIM_SPITTER_MUZZLE_HEIGHT, 6);
      expect((pod.parent as Container).scale.x).toBe(1);
      expect(pod.rotation).toBeCloseTo(Math.atan2(ax, -ay), 6);
      // The pod's neck lies behind the tip, against the aim, and the stalk reaches it from the mound.
      const neck = pod.toGlobal({ x: 0, y: ANCHOR_ART.podLength * density });
      expect(neck.x).toBeCloseTo(en.x - ax * ANCHOR_ART.podLength, 4);
      expect(neck.y).toBeCloseTo(en.y - SIM_SPITTER_MUZZLE_HEIGHT - ay * ANCHOR_ART.podLength, 4);
      const top = stalk.toGlobal({ x: 0, y: -ANCHOR_STALK_LENGTH * density });
      expect(Math.hypot(top.x - neck.x, top.y - neck.y)).toBeLessThan(0.5);
      const base = stalk.toGlobal({ x: 0, y: 0 });
      expect(base.x).toBeCloseTo(en.x, 6);
      expect(base.y).toBeCloseTo(en.y + ANCHOR_ART.stalkBaseY, 6);
    }
  });

  test('an anchor keeps its pose through `facing`; its rings light in turn over the cycle and flash on the shot', () => {
    const { ctx, sim, run, pending, spitterIds } = rig();
    const en = sim.enemies[spitterIds[1] as number] as FakeSim['enemies'][number];
    const parts = bodyOf(ctx, sim, 1);
    const pod = parts[3] as Sprite;
    const group = pod.parent as Container;
    const front = (ctx.scene.entities.children[0]!.children[3] as Container).children[group.parent!.getChildIndex(group)] as Container;
    const rings = front.children.filter((c) => (c as Sprite).texture?.label === 'entity:anchorRing') as Sprite[];
    expect(rings).toHaveLength(ANCHOR_ART.rings.length);
    run(3);
    en.facing = -1;
    run(20);
    expect(group.scale.x).toBe(1);
    // One cycle: cooldown then windup; note when each ring first shines past half.
    const W = 36;
    const C = 54;
    const litAt = rings.map(() => Infinity);
    let tick = 0;
    const watch = (): void => {
      tick++;
      rings.forEach((r, k) => {
        if (r.alpha > 0.5 && litAt[k] === Infinity) litAt[k] = tick;
      });
    };
    Object.assign(en, { mode: 'cooldown', modeTicks: 0, modeDuration: C });
    run(C, () => { en.modeTicks++; watch(); });
    Object.assign(en, { mode: 'windup', modeTicks: 0, modeDuration: W });
    run(W, () => { en.modeTicks = Math.min(W, en.modeTicks + 1); watch(); });
    for (let k = 1; k < rings.length; k++) expect(litAt[k]).toBeGreaterThan(litAt[k - 1] as number);
    // The tip ring lights only in the windup: the seed is coming.
    expect(litAt[rings.length - 1]).toBeGreaterThan(C);
    // The shot: the pod squashes toward its tip and every ring flashes, then they drain.
    Object.assign(sim.projectiles[0] as object, { active: true, sourceId: en.id, x: en.x, y: en.y - SIM_SPITTER_MUZZLE_HEIGHT, spawnTick: sim.tick });
    Object.assign(en, { mode: 'cooldown', modeTicks: 0, modeDuration: C });
    pending.push({ type: SimEventType.SeedFired, tick: sim.tick, x: en.x, y: en.y - SIM_SPITTER_MUZZLE_HEIGHT, a: 0, b: -900, id: 0 });
    run(1);
    expect(pod.scale.y).toBeLessThan(pod.scale.x);
    for (const r of rings) expect(r.alpha).toBeGreaterThan(0.6);
    run(30, () => { en.modeTicks++; });
    for (const r of rings.slice(2)) expect(r.alpha).toBeLessThan(0.35);
    expect(pod.scale.y).toBeCloseTo(pod.scale.x / (1 + 0.05 * anchorCharge('cooldown', 31 / C)), 2);
  });
});
