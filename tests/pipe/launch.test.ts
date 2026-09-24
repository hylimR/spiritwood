import { describe, expect, test } from 'vitest';
import { Texture } from 'pixi.js';
import type { FrameInfo, RenderContext } from '../../src/contracts/render.ts';
import { SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { EntitiesView } from '../../src/render/entities/entitiesView.ts';
import { LAUNCH_FX, launchTargetMark, type LaunchRenderer } from '../../src/render/entities/launch.ts';
import { RING_LINE } from '../../src/render/entities/launchArt.ts';
import { ParticlesView } from '../../src/render/fx/particles.ts';
import { PARTICLE_FRAMES, type ParticleFrame } from '../../src/render/gen/particleAtlas.ts';
import { WorldAssets } from '../../src/render/layers/assets.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../shared/fixtures.ts';
import { createFrame, createTestContext, stepFrame } from './helpers.ts';

const MAP = [
  '..............................',
  '..............................',
  '....P......E.......S..........',
  '##############################',
];

interface Rig {
  sim: FakeSim;
  ctx: RenderContext;
  view: EntitiesView;
  launch: LaunchRenderer;
  particles: ParticlesView;
  frame: FrameInfo;
  send(...events: Partial<SimEvent>[]): void;
  run(n: number, alpha?: number): void;
}

function rig(): Rig {
  const level = levelFromAscii(MAP);
  const ctx = createTestContext(level);
  const sim = createFakeSimView(level);
  const view = new EntitiesView();
  view.init(ctx);
  const particles = new ParticlesView(new WorldAssets());
  particles.build(ctx, Object.fromEntries(PARTICLE_FRAMES.map((f) => [f, Texture.WHITE])) as Record<ParticleFrame, Texture>);
  const frame = createFrame(sim, ctx);
  const r: Rig = {
    sim, ctx, view, launch: view.launch as LaunchRenderer, particles, frame,
    send: (...events) => {
      stepFrame(frame, sim);
      for (const e of events) {
        const full: SimEvent = { type: SimEventType.Jump, tick: sim.tick, x: 0, y: 0, a: 0, b: 0, id: -1, ...e };
        view.onSimEvent(full, frame);
        particles.onSimEvent(full, frame);
      }
      view.update(frame);
      particles.update(frame);
    },
    run: (n, alpha = 1) => {
      for (let i = 0; i < n; i++) {
        stepFrame(frame, sim, 1 / 60, alpha);
        view.update(frame);
        particles.update(frame);
      }
    },
  };
  return r;
}

function seedAt(r: Rig, id: number, prevX: number, x: number, y: number): FakeSim['projectiles'][number] {
  const p = r.sim.projectiles[id] as FakeSim['projectiles'][number];
  Object.assign(p, { active: true, owner: 'hostile', prevX, x, prevY: y, y, spawnTick: 1, age: 10, lifetime: 300 });
  return p;
}

describe('launch target lookup', () => {
  test('by kind and id in the live pools, interpolated (never candidateX/Y)', () => {
    const r = rig();
    seedAt(r, 5, 100, 140, 60);
    Object.assign(r.sim.launch, { candidateKind: 'seed', candidateId: 5, candidateX: -999, candidateY: -999 });
    const m = launchTargetMark({ sim: r.sim, alpha: 0.25 }, 'seed', 5, { x: 0, y: 0, radius: -1 });
    expect(m.x).toBeCloseTo(110, 9);
    expect(m.y).toBe(60);
    expect(m.radius).toBe(12 + LAUNCH_FX.seedPad);
    const e = r.sim.enemies[0] as FakeSim['enemies'][number];
    Object.assign(e, { prevX: 500, x: 520, prevY: 144, y: 144 });
    const me = launchTargetMark({ sim: r.sim, alpha: 0.5 }, 'enemy', 0, { x: 0, y: 0, radius: -1 });
    expect(me.x).toBeCloseTo(510, 9);
    expect(me.y).toBeCloseTo(144 - e.height / 2, 9);
    expect(launchTargetMark({ sim: r.sim, alpha: 1 }, 'none', -1, m).radius).toBe(-1);
    (r.sim.projectiles[5] as { active: boolean }).active = false;
    expect(launchTargetMark({ sim: r.sim, alpha: 1 }, 'seed', 5, m).radius).toBe(-1);
  });
});

/** The ring line's radius in world units (the ring image's line sits at RING_LINE of its half-width). */
function ringRadius(r: Rig): number {
  return (r.launch.ring.scale.x * r.launch.ring.texture.frame.width * RING_LINE) / 2;
}

describe('LaunchRenderer', () => {
  test('the candidate ring follows the interpolated candidate, only once unlocked', () => {
    const r = rig();
    const p = seedAt(r, 3, 300, 330, 80);
    Object.assign(r.sim.launch, { candidateKind: 'seed', candidateId: 3, candidateX: 0, candidateY: 0 });
    r.run(10, 0.5);
    expect(r.launch.ring.alpha).toBe(0);
    r.sim.launch.unlocked = true;
    r.run(10, 0.5);
    expect(r.launch.ring.alpha).toBeGreaterThan(0.4);
    expect(r.launch.ring.position.x).toBeCloseTo(315, 6);
    expect(r.launch.ring.position.y).toBeCloseTo(80, 6);
    // It tracks the seed every frame.
    for (let i = 0; i < 5; i++) {
      p.prevX = p.x;
      p.x += 12;
      r.run(1, 0.75);
      expect(r.launch.ring.position.x).toBeCloseTo(p.prevX + 9, 6);
    }
    // No candidate: fades out (alpha, never `visible`). candidateX/Y are stale then (SIM) and never read.
    Object.assign(r.sim.launch, { candidateKind: 'none', candidateId: -1, candidateX: Number.NaN, candidateY: Number.NaN });
    r.run(20);
    expect(r.launch.ring.alpha).toBe(0);
    expect(r.launch.ring.visible).toBe(true);
    expect(Number.isFinite(r.launch.ring.x) && Number.isFinite(r.launch.ring.y)).toBe(true);
    expect(r.launch.ring.width).toBe(0);
  });

  test('while aiming the ring locks and tightens on the target, and the arrow leaves the hero along the aim', () => {
    const r = rig();
    r.sim.launch.unlocked = true;
    seedAt(r, 0, 400, 400, 60);
    Object.assign(r.sim.launch, { candidateKind: 'seed', candidateId: 0 });
    r.run(20);
    const candidateR = ringRadius(r);
    expect(candidateR).toBeGreaterThan(20);
    Object.assign(r.sim.launch, {
      candidateKind: 'none', candidateId: -1, targetKind: 'seed', targetId: 0, targetX: 400, targetY: 60, aimX: 0.6, aimY: -0.8,
      aimTicks: 0, aimMaxTicks: 120,
    });
    r.sim.player.mode = 'launchAim';
    r.send({ type: SimEventType.LaunchAim, x: 400, y: 60, a: 1, id: 0 });
    r.run(20);
    const lockedR = ringRadius(r);
    expect(lockedR).toBeLessThan(candidateR * 0.85);
    expect(r.launch.ring.position.x).toBeCloseTo(400, 6);
    expect(r.launch.arrow.alpha).toBeGreaterThan(0.6);
    expect(r.launch.arrow.rotation).toBeCloseTo(Math.atan2(-0.8, 0.6), 3);
    const p = r.sim.player;
    expect(r.launch.arrow.position.x).toBeCloseTo(p.x + 0.6 * LAUNCH_FX.arrowStart, 3);
    expect(r.launch.arrow.position.y).toBeCloseTo(p.y - p.height / 2 - 0.8 * LAUNCH_FX.arrowStart, 3);
    // The aim timer tightens it further.
    r.sim.launch.aimTicks = 110;
    r.run(10);
    expect(ringRadius(r)).toBeLessThan(lockedR);
    // Released: the arrow fades.
    r.sim.player.mode = 'launched';
    r.run(20);
    expect(r.launch.arrow.alpha).toBe(0);
    expect(r.launch.arrow.width).toBe(0);
  });

  test('the release burst is centred on the LaunchAim that preceded the Launch, even after a same-frame regrab', () => {
    const r = rig();
    r.sim.launch.unlocked = true;
    seedAt(r, 0, 400, 400, 60);
    seedAt(r, 1, 700, 700, 90);
    r.sim.player.mode = 'launchAim';
    Object.assign(r.sim.launch, { targetKind: 'seed', targetId: 0, targetX: 400, targetY: 60 });
    r.send({ type: SimEventType.LaunchAim, x: 400, y: 60, a: 1, id: 0 });
    r.run(10);
    // One frame: release, then a chain grab of seed 1 overwrites LaunchView before the render.
    Object.assign(r.sim.launch, { targetKind: 'seed', targetId: 1, targetX: 700, targetY: 90 });
    r.send(
      { type: SimEventType.Launch, x: r.sim.player.x, y: r.sim.player.y, a: -1.2, b: 1, id: 0 },
      { type: SimEventType.LaunchAim, x: 700, y: 90, a: 1, id: 1 },
    );
    expect(r.launch.burstCentre).toEqual({ x: 400, y: 60 });
    expect(r.launch.burst.position.x).toBe(400);
    expect(r.launch.burst.alpha).toBeGreaterThan(0.5);
    expect(r.particles.launchBurst).toEqual({ x: 400, y: 60 });
    r.run(Math.ceil((LAUNCH_FX.burstTime + 0.05) * 60));
    expect(r.launch.burst.alpha).toBe(0);
    expect(r.launch.burst.width).toBe(0);
    // The next release bursts at the regrabbed seed.
    r.send({ type: SimEventType.Launch, x: r.sim.player.x, y: r.sim.player.y, a: -1.2, b: 1, id: 1 });
    expect(r.launch.burstCentre).toEqual({ x: 700, y: 90 });
    expect(r.particles.launchBurst).toEqual({ x: 700, y: 90 });
  });

  test('LaunchFizzle flickers a small ring out at the hero', () => {
    const r = rig();
    r.send({ type: SimEventType.LaunchFizzle, x: 210, y: 115 });
    expect(r.launch.fizzle.position.x).toBe(210);
    let seen = 0;
    for (let i = 0; i < 10; i++) {
      r.run(1);
      if (r.launch.fizzle.alpha > 0) seen++;
    }
    expect(seen).toBeGreaterThan(0);
    r.run(Math.ceil(LAUNCH_FX.fizzleTime * 60));
    expect(r.launch.fizzle.alpha).toBe(0);
  });
});
