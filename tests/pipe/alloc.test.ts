import { describe, expect, test } from 'vitest';
import { Container, ParticleContainer, Texture } from 'pixi.js';
import { MAX_PROJECTILES, SIM_DT } from '../../src/config.ts';
import type { RenderContext } from '../../src/contracts/render.ts';
import { EnemyHitCause, LaunchTargetCode, SeedBurstCause, SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { EntitiesView } from '../../src/render/entities/entitiesView.ts';
import { SPITTER_MUZZLE_HEIGHT } from '../../src/render/entities/spitters.ts';
import { ParticlesView } from '../../src/render/fx/particles.ts';
import { PARTICLE_FRAMES, type ParticleFrame } from '../../src/render/gen/particleAtlas.ts';
import { HeroView } from '../../src/render/hero/heroView.ts';
import { WorldAssets } from '../../src/render/layers/assets.ts';
import { WorldClock } from '../../src/render/post/worldClock.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../shared/fixtures.ts';
import { createFrame, createTestContext, stepFrame, walk } from './helpers.ts';

const MAP = [
  '..............................',
  '..............................',
  '....P.....S.....U.....A.......',
  '##############################',
];

type Projectile = FakeSim['projectiles'][number];
type Enemy = FakeSim['enemies'][number];

/** The M2 views on render-group slots, like the pipeline's, so any structure change is observable. */
function rig() {
  const level = levelFromAscii(MAP);
  const base = createTestContext(level);
  const group = (label: string): Container => new Container({ isRenderGroup: true, label });
  const ctx: RenderContext = {
    ...base,
    scene: { ...base.scene, entities: group('entities'), hero: group('hero'), particles: group('particles') },
    glow: { ...base.glow, entities: group('glow-entities'), hero: group('glow-hero'), particles: group('glow-particles') },
  };
  const slots = [ctx.scene.entities, ctx.scene.hero, ctx.scene.particles, ctx.glow.entities, ctx.glow.hero, ctx.glow.particles];
  const sim = createFakeSimView(level);
  for (const e of sim.enemies) if (e.kind === 'thornSpitter') Object.assign(e, { width: 44, height: 60 });
  const entities = new EntitiesView();
  entities.init(ctx);
  const hero = new HeroView();
  hero.init(ctx);
  const particles = new ParticlesView(new WorldAssets());
  particles.build(ctx, Object.fromEntries(PARTICLE_FRAMES.map((f) => [f, Texture.WHITE])) as Record<ParticleFrame, Texture>);
  return { sim, slots, entities, hero, particles, frame: createFrame(sim, ctx) };
}

describe('allocation: M2 updates never create, remove or toggle display objects', () => {
  test('a full spitter / seed / launch / shrine run keeps every slot structure and pool fixed', () => {
    const { sim, slots, entities, hero, particles, frame } = rig();
    const clock = new WorldClock();
    const pending: SimEvent[] = [];
    const emit = (type: SimEventType, x: number, y: number, a = 0, b = 0, id = -1): void => {
      pending.push({ type, tick: sim.tick, x, y, a, b, id });
    };
    const spitter = sim.enemies.find((e) => e.kind === 'thornSpitter') as Enemy;
    const p = sim.player;
    const home = { x: p.x, y: p.y };
    const run = (n: number, each?: () => void): void => {
      for (let i = 0; i < n; i++) {
        each?.();
        sim.tick++;
        for (let k = 0; k < MAX_PROJECTILES; k++) {
          const s = sim.projectiles[k] as Projectile;
          if (!s.active) continue;
          s.prevX = s.x;
          s.prevY = s.y;
          s.x += s.vx * SIM_DT;
          s.y += s.vy * SIM_DT;
          s.age++;
        }
        stepFrame(frame, sim, 1 / 60, 0.5);
        clock.advance(1 / 60, sim.frozen);
        frame.timeScale = clock.scale;
        frame.worldDt = clock.dt;
        frame.worldTime = clock.time;
        for (const e of pending) {
          entities.onSimEvent(e, frame);
          hero.onSimEvent(e, frame);
          particles.onSimEvent(e, frame);
        }
        pending.length = 0;
        entities.update(frame);
        hero.update(frame);
        particles.update(frame);
      }
    };
    const fire = (slot: number): Projectile => {
      Object.assign(spitter, { mode: 'windup', modeTicks: 0, modeDuration: 36 });
      emit(SimEventType.SpitterWindup, spitter.x, spitter.y - SPITTER_MUZZLE_HEIGHT, 36, 0, spitter.id);
      run(36, () => { spitter.modeTicks++; });
      Object.assign(spitter, { mode: 'cooldown', modeTicks: 0, modeDuration: 60 });
      const s = sim.projectiles[slot] as Projectile;
      const x = spitter.x;
      const y = spitter.y - SPITTER_MUZZLE_HEIGHT;
      Object.assign(s, {
        active: true, owner: 'hostile', sourceId: spitter.id, x, y, prevX: x, prevY: y, vx: -240, vy: -60,
        spawnTick: sim.tick + 1, age: 0, lifetime: 300,
      });
      emit(SimEventType.SeedFired, x, y, s.vx, s.vy, slot);
      return s;
    };

    const script = (): void => {
      const seed = fire(0);
      run(40, () => { spitter.modeTicks++; });
      emit(SimEventType.AbilityUnlocked, 1100, 150, 0, 0, 0);
      sim.launch.unlocked = true;
      Object.assign(sim.launch, { candidateKind: 'seed', candidateId: 0, range: 170 });
      run(20);
      // Latch on: the world eases toward the crawl while the hero aims.
      Object.assign(sim.launch, {
        candidateKind: 'none', candidateId: -1, targetKind: 'seed', targetId: 0, targetX: seed.x, targetY: seed.y,
        aimX: 0.6, aimY: -0.8, aimTicks: 0, aimMaxTicks: 120,
      });
      p.mode = 'launchAim';
      sim.frozen = true;
      emit(SimEventType.LaunchAim, seed.x, seed.y, LaunchTargetCode.Seed, 0, 0);
      run(60, () => { sim.launch.aimTicks++; });
      // Release: the hero flies, the seed is kicked back as a reflected one (a new flight).
      p.mode = 'launched';
      sim.frozen = false;
      Object.assign(p, { vx: 690, vy: -920 });
      emit(SimEventType.Launch, p.x, p.y, Math.atan2(-0.8, 0.6), LaunchTargetCode.Seed, 0);
      Object.assign(seed, { owner: 'reflected', spawnTick: sim.tick + 1, age: 0, lifetime: 150, vx: 420, vy: 20 });
      run(12, () => { p.prevX = p.x; p.x += 11.5; p.prevY = p.y; p.y -= 15; });
      Object.assign(p, { mode: 'air', vx: 0, vy: 0 });
      emit(SimEventType.LaunchFizzle, p.x, p.y - 30);
      run(20);
      // The reflected seed stuns the spitter; a hostile one expires; the spitter re-forms.
      seed.active = false;
      emit(SimEventType.SeedBurst, seed.x, seed.y, SeedBurstCause.Enemy, 1, 0);
      emit(SimEventType.EnemyHit, spitter.x, spitter.y - 30, EnemyHitCause.Seed, 0, spitter.id);
      Object.assign(spitter, { mode: 'stunned', modeTicks: 0, modeDuration: 90 });
      run(90, () => { spitter.modeTicks++; });
      Object.assign(spitter, { mode: 'cooldown', modeTicks: 0, modeDuration: 60 });
      emit(SimEventType.EnemyReformed, spitter.x, spitter.y, 0, 0, spitter.id);
      const late = fire(1);
      run(30, () => { spitter.modeTicks++; });
      late.active = false;
      emit(SimEventType.SeedBurst, late.x, late.y, SeedBurstCause.Expired, 0, 1);
      run(30);
      Object.assign(p, { x: home.x, prevX: home.x, y: home.y, prevY: home.y, mode: 'ground' });
      Object.assign(sim.launch, { targetKind: 'none', targetId: -1 });
      emit(SimEventType.Reset, p.x, p.y);
      run(10);
    };

    const snapshot = (): { visible: boolean[]; pools: number[] } => {
      const visible: boolean[] = [];
      const pools: number[] = [];
      for (const slot of slots) {
        walk(slot, (c) => {
          visible.push(c.visible);
          if (c instanceof ParticleContainer) pools.push(c.particleChildren.length);
        });
      }
      return { visible, pools };
    };
    // Once through every state (a lazily shown part would show here), then again under observation.
    script();
    const before = snapshot();
    for (const slot of slots) if (slot.renderGroup) slot.renderGroup.structureDidChange = false;
    script();
    for (const slot of slots) expect(slot.renderGroup?.structureDidChange, slot.label).toBe(false);
    expect(snapshot()).toEqual(before);
    expect(Number.isFinite(frame.worldTime)).toBe(true);
    hero.destroy();
    entities.destroy();
    particles.destroy();
  });
});
