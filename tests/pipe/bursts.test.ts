import { describe, expect, test } from 'vitest';
import { Container, Graphics, ParticleContainer, Texture } from 'pixi.js';
import { EnemyHitCause, SeedBurstCause, SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { PALETTE } from '../../src/config.ts';
import { DebugDrawView } from '../../src/debug/debugDraw.ts';
import { SHRINE_ART } from '../../src/render/entities/abilityShrineArt.ts';
import { PARTICLE_CLOCK, toBgr, type Mote } from '../../src/render/fx/particlePool.ts';
import { ParticlesView } from '../../src/render/fx/particles.ts';
import { PARTICLE_FRAMES, type ParticleFrame } from '../../src/render/gen/particleAtlas.ts';
import { WorldAssets } from '../../src/render/layers/assets.ts';
import { createFakeSimView, levelFromAscii } from '../shared/fixtures.ts';
import { createFrame, createTestContext, stepFrame } from './helpers.ts';

function rig() {
  const level = levelFromAscii(['.'.repeat(60), ...Array.from({ length: 12 }, () => '.'.repeat(60)), '#'.repeat(60)]);
  const ctx = createTestContext(level);
  const view = new ParticlesView(new WorldAssets());
  view.build(ctx, Object.fromEntries(PARTICLE_FRAMES.map((f) => [f, Texture.WHITE])) as Record<ParticleFrame, Texture>);
  const sim = createFakeSimView(level);
  const frame = createFrame(sim, ctx);
  const containers = (): ParticleContainer[] => {
    const out: ParticleContainer[] = [];
    for (const root of [ctx.scene.particles, ctx.glow.particles]) {
      for (const c of root.children) for (const pc of c.children) if (pc instanceof ParticleContainer) out.push(pc);
    }
    return out;
  };
  const live = (): Mote[] => {
    const out: Mote[] = [];
    for (const pc of containers().slice(0, 4)) for (const m of pc.particleChildren as Mote[]) if (m.life > 0 && m.kind >= 10) out.push(m);
    return out;
  };
  return { view, ctx, sim, frame, containers, live };
}

const ev = (type: SimEventType, a = 0, b = 0, x = 600, y = 400): SimEvent => ({ type, tick: 0, x, y, a, b, id: 0 });

describe('M2 bursts (§5.5)', () => {
  const cases: [string, SimEvent, number][] = [
    ['SeedFired puff', ev(SimEventType.SeedFired, 300, -600), PARTICLE_CLOCK.world],
    ['SeedBurst shards (hostile)', ev(SimEventType.SeedBurst, SeedBurstCause.Terrain, 0), PARTICLE_CLOCK.world],
    ['SeedBurst wisps (reflected)', ev(SimEventType.SeedBurst, SeedBurstCause.Enemy, 1), PARTICLE_CLOCK.world],
    ['SpitterWindup thorn glints', ev(SimEventType.SpitterWindup, 36), PARTICLE_CLOCK.world],
    ['EnemyHit (seed)', ev(SimEventType.EnemyHit, EnemyHitCause.Seed), PARTICLE_CLOCK.world],
    ['EnemyHit (launch)', ev(SimEventType.EnemyHit, EnemyHitCause.Launch), PARTICLE_CLOCK.world],
    ['LaunchAim gather', ev(SimEventType.LaunchAim, 1), PARTICLE_CLOCK.real],
    ['Launch burst', ev(SimEventType.Launch, -1, 1), PARTICLE_CLOCK.real],
    ['LaunchFizzle', ev(SimEventType.LaunchFizzle), PARTICLE_CLOCK.real],
    ['AbilityUnlocked bloom', ev(SimEventType.AbilityUnlocked, 1), PARTICLE_CLOCK.real],
  ];

  test.each(cases)('%s emits from the fixed pools on its clock', (_name, e, clock) => {
    const { view, frame, live } = rig();
    view.update(frame);
    const before = live().length;
    view.onSimEvent(e, frame);
    const motes = live();
    expect(motes.length).toBeGreaterThan(before);
    for (const m of motes) expect(m.clock).toBe(clock);
  });

  test('hostile shards are rose, reflected wisps spirit blue', () => {
    const rose = toBgr(PALETTE.thorns);
    const spirit = toBgr(PALETTE.spiritGlow);
    const a = rig();
    a.view.onSimEvent(ev(SimEventType.SeedBurst, SeedBurstCause.Expired, 0), a.frame);
    expect(a.live().some((m) => m.bgr === rose)).toBe(true);
    expect(a.live().some((m) => m.bgr === spirit)).toBe(false);
    const b = rig();
    b.view.onSimEvent(ev(SimEventType.SeedBurst, SeedBurstCause.Terrain, 1), b.frame);
    expect(b.live().some((m) => m.bgr === spirit)).toBe(true);
    expect(b.live().some((m) => m.bgr === rose)).toBe(false);
  });

  test('the AbilityUnlocked bloom is centred on the lantern-seed (from the shrine\'s bottom centre)', () => {
    const { view, frame, live } = rig();
    view.update(frame);
    view.onSimEvent(ev(SimEventType.AbilityUnlocked, 1, 0, 600, 400), frame);
    const motes = live();
    expect(motes.length).toBeGreaterThan(20);
    let sx = 0;
    let sy = 0;
    for (const m of motes) {
      sx += m.x;
      sy += m.y;
    }
    expect(sx / motes.length).toBeCloseTo(600, -1);
    expect(Math.abs(sy / motes.length - (400 + SHRINE_ART.seedY))).toBeLessThan(8);
  });

  test('spamming every M2 event never grows a pool', () => {
    const { view, frame, containers, sim } = rig();
    const sizes = containers().map((c) => c.particleChildren.length);
    for (let i = 0; i < 400; i++) {
      view.onSimEvent((cases[i % cases.length] as [string, SimEvent, number])[1], frame);
      stepFrame(frame, sim);
      view.update(frame);
    }
    expect(containers().map((c) => c.particleChildren.length)).toEqual(sizes);
    expect(view.liveBursts).toBeGreaterThan(0);
  });
});

describe('F4 debug draw (M2)', () => {
  test('spitter boxes and muzzles, seed circles, the launch range and the line of sight to the candidate', () => {
    const level = levelFromAscii(['....................', '....................', '..P...E....S....U...', '####################']);
    const ctx = createTestContext(level);
    const view = new DebugDrawView();
    view.init(ctx);
    const sim = createFakeSimView(level);
    const frame = createFrame(sim, ctx);
    view.onDebugDraw(true);
    const boxes = ((ctx.scene.front.children[0] as Container).children[1]) as Graphics;
    view.update(frame);
    const base = boxes.context.instructions.length;
    Object.assign(sim.projectiles[0] as object, { active: true, x: 300, y: 50, prevX: 290, prevY: 55 });
    Object.assign(sim.projectiles[1] as object, { active: true, owner: 'reflected', x: 400, y: 70, prevX: 400, prevY: 70 });
    sim.launch.unlocked = true;
    Object.assign(sim.launch, { candidateKind: 'seed', candidateId: 0, range: 170 });
    stepFrame(frame, sim);
    view.update(frame);
    // Two seed circles, the range circle, the LOS line and its end dot.
    expect(boxes.context.instructions.length).toBeGreaterThanOrEqual(base + 5);
    sim.player.mode = 'launchAim';
    Object.assign(sim.launch, { candidateKind: 'none', targetKind: 'enemy', targetId: 0 });
    stepFrame(frame, sim);
    expect(() => view.update(frame)).not.toThrow();
    view.destroy();
  });
});
