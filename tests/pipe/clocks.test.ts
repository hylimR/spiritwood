import { beforeAll, describe, expect, test } from 'vitest';
import { DOMAdapter, ParticleContainer, Texture } from 'pixi.js';
import { SIM_DT, TIME_SCALE_FROZEN } from '../../src/config.ts';
import type { FrameInfo, RenderContext } from '../../src/contracts/render.ts';
import { SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { EntitiesView } from '../../src/render/entities/entitiesView.ts';
import { PARTICLE_CLOCK, type Mote } from '../../src/render/fx/particlePool.ts';
import { burstClock, ParticlesView } from '../../src/render/fx/particles.ts';
import { ShaftsView } from '../../src/render/fx/shafts.ts';
import { PARTICLE_FRAMES, type ParticleFrame } from '../../src/render/gen/particleAtlas.ts';
import { Ribbon } from '../../src/render/hero/heroMotion.ts';
import { WorldAssets } from '../../src/render/layers/assets.ts';
import { WorldClock } from '../../src/render/post/worldClock.ts';
import { createFakeSimView, levelFromAscii } from '../shared/fixtures.ts';
import { createFrame, createTestContext, stepFrame } from './helpers.ts';

const REAL: readonly SimEventType[] = [
  SimEventType.Jump, SimEventType.AirJump, SimEventType.WallJump, SimEventType.Dash, SimEventType.DashEnd, SimEventType.Land,
  SimEventType.DropThrough, SimEventType.Died, SimEventType.Respawned, SimEventType.Reset, SimEventType.Teleported,
  SimEventType.LaunchAim, SimEventType.Launch, SimEventType.LaunchFizzle, SimEventType.AbilityUnlocked,
];

describe('particle clocks (§5.5)', () => {
  test('hero, launch and UI bursts use the real clock; world bursts use the world clock', () => {
    for (const t of Object.values(SimEventType)) {
      expect(burstClock(t), `event ${t}`).toBe(REAL.includes(t) ? PARTICLE_CLOCK.real : PARTICLE_CLOCK.world);
    }
  });

  function particles(): { view: ParticlesView; ctx: RenderContext; frame: FrameInfo } {
    const level = levelFromAscii(['.'.repeat(60), ...Array.from({ length: 12 }, () => '.'.repeat(60)), '#'.repeat(60)]);
    const ctx = createTestContext(level);
    const view = new ParticlesView(new WorldAssets());
    view.build(ctx, Object.fromEntries(PARTICLE_FRAMES.map((f) => [f, Texture.WHITE])) as Record<ParticleFrame, Texture>);
    const sim = createFakeSimView(level);
    return { view, ctx, frame: createFrame(sim, ctx) };
  }

  const ev = (type: SimEventType, x = 600, y = 400): SimEvent => ({ type, tick: 0, x, y, a: 0, b: 0, id: 0 });

  function burstMotes(ctx: RenderContext): Mote[] {
    const out: Mote[] = [];
    for (const c of ctx.scene.particles.children[0]!.children) {
      if (c instanceof ParticleContainer) for (const m of c.particleChildren as Mote[]) if (m.life > 0 && m.ttl > 0 && m.kind >= 10) out.push(m);
    }
    return out;
  }

  test('while the world crawls, real-clock bursts play out and world-clock bursts hang in the air', () => {
    const { view, ctx, frame } = particles();
    view.update(frame);
    view.onSimEvent(ev(SimEventType.Jump), frame);
    view.onSimEvent(ev(SimEventType.SeedBurst), frame);
    const motes = burstMotes(ctx);
    const real = motes.filter((m) => m.clock === PARTICLE_CLOCK.real);
    const world = motes.filter((m) => m.clock === PARTICLE_CLOCK.world);
    expect(real.length).toBeGreaterThan(0);
    expect(world.length).toBeGreaterThan(0);
    const worldLife = world.map((m) => m.life);
    // One second at the frozen crawl: 60 real frames, each advancing the world by TIME_SCALE_FROZEN · dt.
    frame.timeScale = TIME_SCALE_FROZEN;
    for (let i = 0; i < 60; i++) {
      stepFrame(frame, frame.sim as never);
      view.update(frame);
    }
    for (const m of real) expect(m.life).toBeLessThanOrEqual(0);
    world.forEach((m, i) => expect(m.life).toBeCloseTo((worldLife[i] as number) - TIME_SCALE_FROZEN, 6));
  });

  test('ambient motes drift on the world clock (still when it stops)', () => {
    const { view, ctx, frame } = particles();
    view.update(frame);
    const amb = ctx.scene.particles.children[0]!.children[0] as ParticleContainer;
    const before = amb.particleChildren.map((p) => p.x);
    frame.timeScale = 0;
    for (let i = 0; i < 30; i++) {
      stepFrame(frame, frame.sim as never);
      view.update(frame);
    }
    expect(amb.particleChildren.map((p) => p.x)).toEqual(before);
    frame.timeScale = 1;
    stepFrame(frame, frame.sim as never);
    view.update(frame);
    expect(amb.particleChildren.map((p) => p.x)).not.toEqual(before);
  });
});

describe('world clock users', () => {
  beforeAll(() => {
    // Shader programs probe the fragment precision through a canvas; there is no DOM here.
    DOMAdapter.set({ ...DOMAdapter.get(), createCanvas: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement });
  });

  test('light shafts shimmer on worldTime', () => {
    const level = levelFromAscii(['.'.repeat(30), '.'.repeat(30), '#'.repeat(30)]);
    level.lightShafts.push({ id: 0, x: 200, y: 0, w: 100, h: 90, angle: 0.1, spread: 1.6, intensity: 0.6 });
    const ctx = createTestContext(level);
    const view = new ShaftsView();
    view.init(ctx);
    const frame = createFrame(createFakeSimView(level), ctx);
    frame.time = 50;
    frame.worldTime = 12.25;
    view.update(frame);
    const u = (view as unknown as { uniforms: { uniforms: { uTime: number } } }).uniforms.uniforms;
    expect(u.uTime).toBe(12.25);
    view.destroy();
  });

  test('entity idles freeze with the world clock; the orb collect animation is anchored to worldTime', () => {
    const level = levelFromAscii(['..........', '.o....o...', '....P.....', '##########']);
    const ctx = createTestContext(level);
    const sim = createFakeSimView(level);
    const view = new EntitiesView();
    view.init(ctx);
    const frame = createFrame(sim, ctx);
    const step = (n: number): void => {
      for (let i = 0; i < n; i++) {
        sim.tick++;
        stepFrame(frame, sim);
        view.update(frame);
      }
    };
    step(5);
    const body = ctx.scene.entities.children[0]!.children[1]!;
    const orb = body.children[body.children.length - 2]!;
    frame.timeScale = 0;
    step(1);
    const y0 = orb.y;
    step(30);
    expect(orb.y).toBe(y0);
    // Collected while the world clock is stopped: the pop doesn't advance (ticks keep counting).
    const o = sim.orbs[0] as { collected: boolean; collectedTick: number };
    o.collected = true;
    o.collectedTick = sim.tick;
    view.onSimEvent({ type: SimEventType.OrbCollected, tick: sim.tick, x: 0, y: 0, a: 1, b: 0, id: 0 }, frame);
    step(60);
    expect(orb.visible).toBe(true);
    frame.timeScale = 1;
    step(Math.ceil(0.3 / SIM_DT));
    expect(orb.visible).toBe(false);
  });
});

describe('scarf across a Spirit Launch release (§5.5)', () => {
  /**
   * Aim for 0.8 s with the scarf's forces scaled by the eased time scale, then release and fly along
   * the launch at 1150 u/s for 12 ticks while the scale snaps back. Returns the peak point speed.
   */
  function launchScarf(fps: number, stepOnWorldDt: boolean): number {
    const ribbon = new Ribbon();
    const clock = new WorldClock();
    const dt = 1 / fps;
    let x = 0;
    let y = 0;
    let t = 0;
    ribbon.reset(x, y, -1, -0.15);
    for (let i = 0; i < 0.5 * fps; i++) {
      clock.advance(dt, false);
      t += dt;
      ribbon.update(dt, x, y, -1, -0.18, t);
    }
    for (let i = 0; i < 0.8 * fps; i++) {
      clock.advance(dt, true);
      t += dt;
      ribbon.update(stepOnWorldDt ? clock.dt : dt, x, y, -1, -0.18, t, stepOnWorldDt ? 1 : clock.scale);
    }
    let peak = 0;
    const speed = 1150;
    for (let i = 0; i < 0.4 * fps; i++) {
      clock.advance(dt, false);
      t += dt;
      if (t < 1.3 + 12 * SIM_DT) {
        x += 0.6 * speed * dt;
        y -= 0.8 * speed * dt;
      }
      ribbon.update(stepOnWorldDt ? clock.dt : dt, x, y, -1, -0.18, t);
      for (let k = 1; k < ribbon.count; k++) peak = Math.max(peak, ribbon.speed(k));
    }
    return peak;
  }

  /** A scarf point never needs to move faster than twice the anchor's launch speed. */
  const BOUND = 1150 * 2;

  test('forces scaled by timeScale (never the step): the velocity estimate stays bounded at any frame rate', () => {
    for (const fps of [30, 60, 144]) {
      const peak = launchScarf(fps, false);
      expect(peak, `${fps} fps`).toBeLessThan(BOUND);
      expect(Number.isFinite(peak)).toBe(true);
    }
  });

  test('stepping the verlet on worldDt instead breaks the bound as the scale ramps back (why the rig stays on real time)', () => {
    for (const fps of [60, 144]) expect(launchScarf(fps, true), `${fps} fps`).toBeGreaterThan(BOUND);
  });
});
