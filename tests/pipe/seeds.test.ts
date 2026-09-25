import { beforeAll, describe, expect, test } from 'vitest';
import { Container, Mesh, Sprite, type MeshGeometry } from 'pixi.js';
import type { FrameInfo, RenderContext } from '../../src/contracts/render.ts';
import { MAX_PROJECTILES, SIM_DT } from '../../src/config.ts';
import { EntitiesView } from '../../src/render/entities/entitiesView.ts';
import { SEED, seedFade, type SeedRenderer } from '../../src/render/entities/seeds.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../shared/fixtures.ts';
import { countDraws, drawLeaves } from './drawOrder.ts';
import { createFrame, createTestContext, stepFrame } from './helpers.ts';

const MAP = [
  '..............................',
  '..............................',
  '....P.....S.....U.....C.....A.',
  '##############################',
];

interface Rig {
  sim: FakeSim;
  ctx: RenderContext;
  view: EntitiesView;
  seeds: SeedRenderer;
  frame: FrameInfo;
  /** The slot container, a render group like the pipeline's (structure changes are observable). */
  slot: Container;
  glowSlot: Container;
}

function rig(): Rig {
  const level = levelFromAscii(MAP);
  const base = createTestContext(level);
  const slot = new Container({ isRenderGroup: true, label: 'entities' });
  const glowSlot = new Container({ isRenderGroup: true, label: 'glow-entities' });
  const ctx: RenderContext = { ...base, scene: { ...base.scene, entities: slot }, glow: { ...base.glow, entities: glowSlot } };
  const sim = createFakeSimView(level);
  const view = new EntitiesView();
  view.init(ctx);
  const frame = createFrame(sim, ctx);
  return { sim, ctx, view, seeds: view.seeds as SeedRenderer, frame, slot, glowSlot };
}

function frameOnce(r: Rig, alpha = 1): void {
  stepFrame(r.frame, r.sim, 1 / 60, alpha);
  r.view.update(r.frame);
}

/** Put slot i in flight at (x, y) with velocity (vx, vy); fired on `tick`. */
function fire(r: Rig, i: number, x: number, y: number, vx: number, vy: number, tick: number, owner: 'hostile' | 'reflected' = 'hostile'): FakeSim['projectiles'][number] {
  const p = r.sim.projectiles[i] as FakeSim['projectiles'][number];
  Object.assign(p, { active: true, owner, x, y, prevX: x, prevY: y, vx, vy, spawnTick: tick, age: 0, lifetime: owner === 'hostile' ? 300 : 150 });
  return p;
}

/** Advance seed p by `ticks` sim ticks (straight line), as the sim would between two render frames. */
function move(p: FakeSim['projectiles'][number], ticks: number): void {
  for (let k = 0; k < ticks; k++) {
    p.prevX = p.x;
    p.prevY = p.y;
    p.x += p.vx / 60;
    p.y += p.vy / 60;
    p.age++;
  }
}

function positions(m: Mesh): Float32Array {
  return (m.geometry as MeshGeometry).positions;
}

describe('seeds: batching invariants (§5.5)', () => {
  let r: Rig;
  beforeAll(() => {
    r = rig();
  });

  test('seeds, halos, trails and launch marks are one draw with the entity bodies; their twins one more', () => {
    const root = r.slot.children[0] as Container;
    const seeds = root.children.find((c) => c.label === 'entities-seeds') as Container;
    expect(seeds.blendMode).toBe('inherit');
    const leaves = drawLeaves(seeds);
    expect(leaves.length).toBeGreaterThanOrEqual(MAX_PROJECTILES * 3);
    const source = leaves[0]?.source;
    for (const leaf of leaves) {
      expect(leaf.node instanceof Sprite || leaf.node instanceof Mesh).toBe(true);
      expect(leaf.blend).toBe('normal');
      expect(leaf.source).toBe(source);
      expect(leaf.batchable).toBe(true);
      if (leaf.node instanceof Mesh) {
        // A default-shader mesh of ≤ 100 vertices with the default state: Pixi batches it with sprites.
        expect(positions(leaf.node).length / 2).toBeLessThanOrEqual(100);
        expect(leaf.node.batched).toBe(true);
      }
    }
    expect(countDraws(seeds)).toBe(1);
    // The whole entity scene: additive halos, bodies + seeds (one normal-blend batch), additive emissives.
    frameOnce(r);
    expect(countDraws(root)).toBe(3);
    // Glow slot: the spitters' occluders (normal), then every additive twin including the seeds'.
    const glowRoot = r.glowSlot.children[0] as Container;
    const twins = glowRoot.children.find((c) => c.label === 'entities-seed-twins') as Container;
    expect(countDraws(twins)).toBe(1);
    expect(countDraws(glowRoot)).toBe(2);
  });

  test('pool slots are never added, removed or toggled visible; inactive slots are alpha 0 and zero area', () => {
    const rr = rig();
    frameOnce(rr);
    frameOnce(rr);
    const groups = [rr.slot.renderGroup, rr.glowSlot.renderGroup];
    for (const g of groups) if (g) g.structureDidChange = false;
    const seedsLayer = (rr.slot.children[0] as Container).children.find((c) => c.label === 'entities-seeds') as Container;
    const count = seedsLayer.children.length;
    for (let i = 0; i < 40; i++) {
      // Seeds fire, fly, burst and get reused.
      const slot = i % 5;
      const p = rr.sim.projectiles[slot] as FakeSim['projectiles'][number];
      if (p.active && i % 3 === 0) p.active = false;
      else if (!p.active) fire(rr, slot, 400 + slot * 30, 60, 300, -200, i);
      for (let k = 0; k < 5; k++) if (rr.sim.projectiles[k]?.active) move(rr.sim.projectiles[k] as FakeSim['projectiles'][number], 1);
      rr.sim.tick++;
      frameOnce(rr);
    }
    for (const g of groups) expect(g?.structureDidChange).toBe(false);
    expect(seedsLayer.children).toHaveLength(count);
    for (const c of seedsLayer.children) expect(c.visible).toBe(true);
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      if (rr.sim.projectiles[i]?.active) continue;
      expect(rr.seeds.bodies[i]?.alpha).toBe(0);
      expect(rr.seeds.trails[i]?.alpha).toBe(0);
      expect(rr.seeds.twins[i]?.alpha).toBe(0);
      // An alpha-0 quad still rasterises: parked slots have no area either.
      for (const s of [rr.seeds.bodies[i], rr.seeds.halos[i], rr.seeds.twins[i]]) expect(s?.width).toBe(0);
      for (const m of [rr.seeds.trails[i], rr.seeds.twinTrails[i]]) expect(positions(m as Mesh).every((v) => v === 0)).toBe(true);
    }
  });
});

describe('seed trails', () => {
  test('one sample per tick the seed moved; point 0 is the interpolated head', () => {
    const r = rig();
    const p = fire(r, 3, 300, 50, 600, 0, 10);
    frameOnce(r);
    expect(r.seeds.sampleCount[3]).toBe(0);
    move(p, 1);
    frameOnce(r);
    expect(r.seeds.sampleCount[3]).toBe(1);
    // Two ticks in one frame: two samples (the older extrapolated along the last step).
    move(p, 2);
    frameOnce(r, 0.5);
    expect(r.seeds.sampleCount[3]).toBe(3);
    const base = 3 * (SEED.trailPoints - 1) * 2;
    expect(r.seeds.samples[base]).toBeCloseTo(p.prevX, 4);
    expect(r.seeds.samples[base + 2]).toBeCloseTo(p.prevX - (p.x - p.prevX), 4);
    const pos = positions(r.seeds.trails[3] as Mesh);
    const hx = p.prevX + (p.x - p.prevX) * 0.5;
    expect((pos[0]! + pos[2]!) / 2).toBeCloseTo(hx, 4);
    expect((pos[1]! + pos[3]!) / 2).toBeCloseTo(p.y, 4);
    // A frozen world: no ticks stepped for the seed, prev = cur: the trail keeps its samples.
    p.prevX = p.x;
    p.prevY = p.y;
    frameOnce(r);
    frameOnce(r);
    expect(r.seeds.sampleCount[3]).toBe(3);
    // At most trailPoints − 1 samples.
    move(p, 1);
    frameOnce(r);
    move(p, 12);
    frameOnce(r);
    expect(r.seeds.sampleCount[3]).toBe(SEED.trailPoints - 1);
    expect(SEED.trailPoints).toBeLessThanOrEqual(8);
  });

  test('a trail resets when spawnTick changes (a reflection or a reused slot)', () => {
    const r = rig();
    const p = fire(r, 0, 300, 50, 600, -300, 4);
    for (let i = 0; i < 5; i++) {
      move(p, 1);
      frameOnce(r);
    }
    expect(r.seeds.sampleCount[0]).toBe(5);
    // Reflected on tick 40: same slot, new flight.
    Object.assign(p, { owner: 'reflected', spawnTick: 40, age: 0, vx: -1000, vy: 0, prevX: p.x, prevY: p.y, lifetime: 150 });
    frameOnce(r);
    expect(r.seeds.sampleCount[0]).toBe(0);
    const pos = positions(r.seeds.trails[0] as Mesh);
    // Every point collapses onto the head: no stale ribbon toward the old flight.
    for (let k = 1; k < SEED.trailPoints; k++) {
      expect(pos[k * 4]).toBeCloseTo(p.x, 4);
      expect(pos[k * 4 + 2]).toBeCloseTo(p.x, 4);
    }
    expect(r.seeds.bodies[0]?.texture).not.toBe(undefined);
    move(p, 1);
    frameOnce(r);
    expect(r.seeds.sampleCount[0]).toBe(1);
    // Inactive, then refired from the same slot and first seen a tick into the new flight: the trail
    // restarts with that one tick.
    p.active = false;
    frameOnce(r);
    fire(r, 0, 100, 100, 200, 0, 60);
    move(p, 1);
    frameOnce(r);
    expect(r.seeds.sampleCount[0]).toBe(1);
    expect(r.seeds.samples[0]).toBeCloseTo(100, 4);
  });

  test('a frame with a stepped tick then a frozen one samples the tick start from the velocity', () => {
    const r = rig();
    const p = fire(r, 0, 300, 60, 600, 0, 1, 'reflected');
    const step = (): void => {
      p.prevX = p.x;
      p.x += 10;
      p.age++;
    };
    const frozenTick = (): void => {
      p.prevX = p.x;
      p.prevY = p.y;
    };
    for (let i = 0; i < 4; i++) {
      step();
      frameOnce(r);
    }
    // One 30 fps frame: tick N moves the seed 10 u, tick N + 1 is a grab that freezes the world.
    step();
    frozenTick();
    frameOnce(r);
    expect(r.seeds.sampleCount[0]).toBe(5);
    // The newest sample is where tick N started (p.x − vx·SIM_DT), not the head.
    expect(r.seeds.samples[0]).toBeCloseTo(p.x - p.vx * SIM_DT, 4);
    expect(r.seeds.samples[2]).toBeCloseTo(p.x - 20, 4);
    // Still frozen: no new samples; the release frame's tick adds one at its start.
    frozenTick();
    frameOnce(r);
    expect(r.seeds.sampleCount[0]).toBe(5);
    step();
    frameOnce(r);
    expect(r.seeds.sampleCount[0]).toBe(6);
    expect(r.seeds.samples[0]).toBeCloseTo(p.prevX, 4);
  });

  test('a reflected wisp is anchored at its pivot (the seed centre), and the ember again after', () => {
    const r = rig();
    const pivot = (name: string): [number, number] => {
      const f = (r.view.images as NonNullable<EntitiesView['images']>).get(name).frame;
      return [f.pivotX / f.w, f.pivotY / f.h];
    };
    const p = fire(r, 6, 300, 60, 600, 0, 1);
    frameOnce(r);
    const body = r.seeds.bodies[6] as Sprite;
    expect([body.anchor.x, body.anchor.y]).toEqual(pivot('seedHostile'));
    Object.assign(p, { owner: 'reflected', spawnTick: 9 });
    frameOnce(r);
    expect(body.texture.label).toBe('entity:seedWisp');
    expect([body.anchor.x, body.anchor.y]).toEqual(pivot('seedWisp'));
    expect(body.anchor.x).not.toBeCloseTo(0.5, 2);
    // Its centre is on the seed: the anchor point maps to the interpolated head.
    expect(body.x).toBeCloseTo(p.prevX + (p.x - p.prevX), 6);
    p.active = false;
    frameOnce(r);
    fire(r, 6, 200, 60, 600, 0, 20);
    frameOnce(r);
    expect(body.texture.label).toBe('entity:seedHostile');
    expect([body.anchor.x, body.anchor.y]).toEqual(pivot('seedHostile'));
  });

  test('the hostile wake is an ember ribbon: wide at the head (≈ 60 % of the body), tapering to nothing', () => {
    const r = rig();
    const p = fire(r, 7, 300, 60, 900, 0, 1);
    for (let i = 0; i < 10; i++) {
      move(p, 1);
      frameOnce(r);
    }
    const trail = r.seeds.trails[7] as Mesh;
    expect(trail.texture.label).toBe('entity:seedEmber');
    expect(trail.tint).toBe(0xffffff);
    const pos = positions(trail);
    const widthAt = (k: number): number => Math.hypot(pos[k * 4]! - pos[k * 4 + 2]!, pos[k * 4 + 1]! - pos[k * 4 + 3]!);
    const body = r.seeds.bodies[7] as Sprite;
    expect(widthAt(0)).toBeCloseTo(SEED.hostileTrailWidth, 6);
    // The ember's thorn tips span ≈ 21 u; the wake leaves the body at ≈ 60 % of that and narrows.
    expect(widthAt(0)).toBeGreaterThan(0.6 * 21);
    expect(widthAt(0)).toBeLessThan(21);
    expect(widthAt(SEED.trailPoints - 1)).toBeCloseTo(0, 6);
    for (let k = 1; k < SEED.trailPoints; k++) expect(widthAt(k)).toBeLessThan(widthAt(k - 1));
    // The reflected trail keeps the white strip, tinted spirit blue.
    Object.assign(p, { owner: 'reflected', spawnTick: 30 });
    frameOnce(r);
    expect(trail.texture.label).toBe('entity:seedTrail');
    expect(trail.tint).toBe(SEED.reflectedTrailTint);
    expect(trail.texture.source).toBe(body.texture.source);
  });

  test('a seed fades over its last 30 ticks of age / lifetime', () => {
    expect(SEED.fadeTicks).toBe(30);
    expect(seedFade(0, 300)).toBe(1);
    expect(seedFade(270, 300)).toBe(1);
    expect(seedFade(285, 300)).toBeCloseTo(0.5, 9);
    expect(seedFade(299, 300)).toBeCloseTo(1 / 30, 9);
    expect(seedFade(300, 300)).toBe(0);
    const r = rig();
    const p = fire(r, 1, 300, 50, 0, 0, 1);
    frameOnce(r);
    expect(r.seeds.bodies[1]?.alpha).toBe(1);
    p.age = p.lifetime - 15;
    frameOnce(r);
    expect(r.seeds.bodies[1]?.alpha).toBeCloseTo(0.5, 6);
    expect(r.seeds.trails[1]?.alpha).toBeLessThan(0.5);
    p.age = p.lifetime - 1;
    frameOnce(r);
    expect(r.seeds.bodies[1]?.alpha).toBeCloseTo(1 / 30, 6);
  });

  test('trail twins are at least 2 glow-buffer pixels wide', () => {
    const r = rig();
    // Worst case: low bloom scale and a low render scale.
    r.frame.quality = { ...r.frame.quality, bloomScale: 0.25 };
    r.frame.pxPerUnit = 0.5;
    const p = fire(r, 2, 300, 50, 900, 0, 1);
    for (let i = 0; i < 8; i++) {
      move(p, 1);
      frameOnce(r);
    }
    const glowPx = r.frame.pxPerUnit * r.frame.camera.zoom * r.frame.quality.bloomScale;
    const twin = positions(r.seeds.twinTrails[2] as Mesh);
    const scene = positions(r.seeds.trails[2] as Mesh);
    for (let k = 0; k < SEED.trailPoints; k++) {
      const w = Math.hypot(twin[k * 4]! - twin[k * 4 + 2]!, twin[k * 4 + 1]! - twin[k * 4 + 3]!);
      expect(w * glowPx).toBeGreaterThanOrEqual(2);
    }
    // The scene trail itself tapers thin at the tail.
    const tail = SEED.trailPoints - 1;
    expect(Math.hypot(scene[tail * 4]! - scene[tail * 4 + 2]!, scene[tail * 4 + 1]! - scene[tail * 4 + 3]!)).toBeLessThan(4);
  });

  test('hostile embers spin; reflected wisps turn onto their velocity', () => {
    const r = rig();
    fire(r, 4, 300, 50, 0, 0, 1);
    fire(r, 5, 300, 90, 0, -800, 1, 'reflected');
    frameOnce(r);
    const a0 = r.seeds.bodies[4]!.rotation;
    frameOnce(r);
    expect(r.seeds.bodies[4]!.rotation).not.toBeCloseTo(a0, 3);
    expect(r.seeds.bodies[5]!.rotation).toBeCloseTo(-Math.PI / 2, 6);
    expect(r.seeds.bodies[5]!.texture).not.toBe(r.seeds.bodies[4]!.texture);
    expect(r.seeds.bodies[5]!.texture.source).toBe(r.seeds.bodies[4]!.texture.source);
  });
});
