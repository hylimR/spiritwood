import { describe, expect, test } from 'vitest';
import { Container, ParticleContainer, Texture, type WebGLRenderer } from 'pixi.js';
import { VIEW_H } from '../../src/config.ts';
import type { RenderStats } from '../../src/contracts/debug.ts';
import type { QualitySettings } from '../../src/contracts/quality.ts';
import { GLOW_SLOTS, SCENE_SLOTS, type FrameInfo, type GlowSlots, type RenderContext, type SceneSlots } from '../../src/contracts/render.ts';
import { SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { PARTICLE_CAPACITY, ParticlesView } from '../../src/render/fx/particles.ts';
import { PARTICLE_FRAMES, type ParticleFrame } from '../../src/render/gen/particleAtlas.ts';
import { WorldAssets } from '../../src/render/layers/assets.ts';
import { computeCameraFrame, createCameraFrame } from '../../src/render/util/camera.ts';
import { SimpleTextureBudget } from '../../src/render/util/texture.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../shared/fixtures.ts';
import { firstRenderStaticUpload } from './particleUpload.ts';

const quality = (density: number): QualitySettings => ({
  level: 'high', pixelRatioCap: 1, renderScale: 1, minRenderScale: 0.7, maxRenderPixels: 2560 * 1440, dynamicResolution: true,
  bloom: true, bloomScale: 0.5, bloomPasses: 4, layerBudget: 10, particleDensity: density, lightShafts: true, foliageSway: true,
  fogBands: 2, fpsCap: 60,
});

function setup(density = 1): { view: ParticlesView; ctx: RenderContext; sim: FakeSim; frame: FrameInfo } {
  const rows = ['.'.repeat(80), ...Array.from({ length: 18 }, () => '.'.repeat(80)), '#'.repeat(80)];
  const level = levelFromAscii(rows, { seed: 5 });
  level.lightShafts.push({ id: 0, x: 900, y: 0, w: 240, h: 800, angle: 0.2, spread: 1.6, intensity: 0.7 });
  level.decorHints.push({ id: 0, kind: 'lantern', x: 1100, y: 19 * 48 });
  const scene = Object.fromEntries(SCENE_SLOTS.map((s) => [s, new Container()])) as SceneSlots;
  const glow = Object.fromEntries(GLOW_SLOTS.map((s) => [s, new Container()])) as GlowSlots;
  const stats: RenderStats = {
    drawCalls: 0, fillScreens: 0, rtWidth: 0, rtHeight: 0, renderScale: 1, canvasWidth: 1920, canvasHeight: 1080, particles: 0, textureMB: 0, gpuMs: -1,
  };
  const ctx: RenderContext = {
    renderer: null as unknown as WebGLRenderer, scene, glow, level, manifest: { version: 1, area: 't', textureBudgetMB: { high: 96, medium: 64, low: 48 }, atlases: [], layers: [] },
    manifestUrl: 'https://example.com/m.json', quality: quality(density), textures: new SimpleTextureBudget(1e9), stats,
  };
  const frames = Object.fromEntries(PARTICLE_FRAMES.map((f) => [f, Texture.WHITE])) as Record<ParticleFrame, Texture>;
  const view = new ParticlesView(new WorldAssets());
  view.build(ctx, frames);
  const sim = createFakeSimView(level);
  sim.camera.x = sim.camera.prevX = 1000;
  sim.camera.y = sim.camera.prevY = 500;
  const frame: FrameInfo = {
    time: 0, dt: 1 / 60, alpha: 1, frame: 0, camera: computeCameraFrame(createCameraFrame(), sim.camera, 1), sim, quality: ctx.quality,
    renderScale: 1, pxPerUnit: 1,
  };
  return { view, ctx, sim, frame };
}

function step(view: ParticlesView, frame: FrameInfo, n: number): void {
  for (let i = 0; i < n; i++) {
    frame.time += frame.dt;
    frame.frame++;
    view.update(frame);
  }
}

function containers(ctx: RenderContext): ParticleContainer[] {
  const out: ParticleContainer[] = [];
  for (const root of [ctx.scene.particles, ctx.glow.particles]) {
    for (const c of root.children) for (const pc of c.children) if (pc instanceof ParticleContainer) out.push(pc);
  }
  return out;
}

const ev = (type: SimEventType, x = 1000, y = 900, a = 0, b = 0): SimEvent => ({ type, tick: 0, x, y, a, b, id: 0 });

describe('ParticlesView', () => {
  test('pools are fixed-capacity: no growth after warm-up and bursts', () => {
    const { view, ctx, frame } = setup();
    const sizes = containers(ctx).map((c) => c.particleChildren.length);
    expect(sizes.length).toBe(6);
    step(view, frame, 60);
    const types = [SimEventType.Land, SimEventType.Jump, SimEventType.AirJump, SimEventType.WallJump, SimEventType.Dash,
      SimEventType.OrbCollected, SimEventType.Died, SimEventType.EnemyStomped, SimEventType.CheckpointActivated, SimEventType.GoalReached];
    for (let i = 0; i < 300; i++) {
      view.onSimEvent(ev(types[i % types.length] as SimEventType, 1000, 900, 900, 300), frame);
      step(view, frame, 1);
    }
    expect(containers(ctx).map((c) => c.particleChildren.length)).toEqual(sizes);
  });

  test('static attributes (uvs, …) reach the GPU buffer on the first render', () => {
    const { ctx } = setup();
    for (const pc of containers(ctx)) {
      const { have, need } = firstRenderStaticUpload(pc);
      expect(need).toBeGreaterThan(0);
      expect(have).toBeGreaterThanOrEqual(need);
    }
  });

  test('burst caps: event spam never exceeds the burst pool capacity', () => {
    const { view, frame } = setup();
    for (let i = 0; i < 200; i++) view.onSimEvent(ev(SimEventType.Died), frame);
    step(view, frame, 1);
    const C = PARTICLE_CAPACITY;
    expect(view.liveBursts).toBeLessThanOrEqual(C.sparks + C.dots + C.stars + C.puffs + C.wisps);
    expect(view.liveBursts).toBeGreaterThan(0);
    // Bursts expire.
    step(view, frame, 60 * 4);
    expect(view.liveBursts).toBe(0);
  });

  test('Respawned clears bursts, then gathers motes toward the respawn point', () => {
    const { view, frame } = setup();
    for (let i = 0; i < 5; i++) view.onSimEvent(ev(SimEventType.Died), frame);
    step(view, frame, 2);
    const before = view.liveBursts;
    view.onSimEvent(ev(SimEventType.Respawned, 1200, 900), frame);
    step(view, frame, 1);
    expect(view.liveBursts).toBeLessThan(before);
    expect(view.liveBursts).toBeGreaterThanOrEqual(20);
  });

  test('ambient counts scale with particle density and are reported in stats', () => {
    for (const d of [1, 0.35]) {
      const { view, ctx, frame } = setup(d);
      step(view, frame, 2);
      ctx.stats.particles = 0;
      view.update(frame);
      const C = PARTICLE_CAPACITY;
      const ambient = Math.round(C.motes * d) + Math.round(C.fireflies * d) + Math.round(C.leaves * d);
      expect(ctx.stats.particles).toBeGreaterThanOrEqual(ambient);
      expect(ctx.stats.particles).toBeLessThanOrEqual(ambient + Math.round(C.dust * d));
      // Hidden particles have zero scale.
      const amb = containers(ctx)[0] as ParticleContainer;
      const visible = amb.particleChildren.filter((p) => p.scaleX !== 0).length;
      expect(visible).toBeLessThanOrEqual(Math.round(C.motes * d) + Math.round(C.fireflies * d) + Math.round(C.dust * d));
    }
  });

  test('ambient particles stay in the camera window and re-seed on a camera snap', () => {
    const { view, ctx, sim, frame } = setup();
    step(view, frame, 120);
    const amb = containers(ctx)[0] as ParticleContainer;
    const inWindow = (cx: number, cy: number): boolean => amb.particleChildren.every((p) =>
      p.scaleX === 0 || (Math.abs(p.x - cx) < VIEW_H * (16 / 9) / 2 + 400 && Math.abs(p.y - cy) < VIEW_H / 2 + 400));
    expect(inWindow(1000, 500)).toBe(true);
    // Teleport the camera far away with a snap.
    sim.camera.x = sim.camera.prevX = 3200;
    sim.camera.snapTick = 42;
    computeCameraFrame(frame.camera, sim.camera, 1);
    step(view, frame, 1);
    expect(inWindow(3200, 500)).toBe(true);
  });

  test('dash trail emits while dashing only', () => {
    const { view, sim, frame } = setup();
    step(view, frame, 10);
    const idle = view.liveBursts;
    sim.player.mode = 'dash';
    sim.player.dashDir = 1;
    step(view, frame, 6);
    expect(view.liveBursts).toBeGreaterThan(idle);
  });
});
