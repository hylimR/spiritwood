import { Container, type WebGLRenderer } from 'pixi.js';
import type { LayerManifest } from '../../src/contracts/assets.ts';
import type { RenderStats } from '../../src/contracts/debug.ts';
import type { LevelData } from '../../src/contracts/level.ts';
import {
  GLOW_SLOTS, SCENE_SLOTS, type FrameInfo, type GlowSlot, type RenderContext, type SceneSlot,
} from '../../src/contracts/render.ts';
import { computeCameraFrame, createCameraFrame } from '../../src/render/util/camera.ts';
import { SimpleTextureBudget } from '../../src/render/util/texture.ts';
import { QUALITY_PRESETS } from '../../src/settings/quality.ts';
import type { FakeSim } from '../shared/fixtures.ts';

export const TEST_MANIFEST: LayerManifest = {
  version: 1, area: 'test', textureBudgetMB: { high: 96, medium: 64, low: 48 }, atlases: [], layers: [],
};

export function createStats(): RenderStats {
  return {
    drawCalls: 0, fillScreens: 0, rtWidth: 0, rtHeight: 0, renderScale: 1, canvasWidth: 0, canvasHeight: 0,
    particles: 0, textureMB: 0, gpuMs: -1,
  };
}

/** A renderer-free RenderContext: plain slot containers, a real texture budget and stats. */
export function createTestContext(level: LevelData): RenderContext & { textures: SimpleTextureBudget } {
  const scene = {} as Record<SceneSlot, Container>;
  for (const s of SCENE_SLOTS) scene[s] = new Container({ label: s });
  const glow = {} as Record<GlowSlot, Container>;
  for (const s of GLOW_SLOTS) glow[s] = new Container({ label: s });
  return {
    renderer: {} as unknown as WebGLRenderer,
    scene,
    glow,
    level,
    manifest: TEST_MANIFEST,
    manifestUrl: 'http://localhost/layers/test.json',
    quality: { ...QUALITY_PRESETS.high },
    textures: new SimpleTextureBudget(96 * 2 ** 20),
    stats: createStats(),
  };
}

export function createFrame(sim: FakeSim, ctx: RenderContext): FrameInfo {
  return {
    time: 0, dt: 1 / 60, alpha: 1, frame: 0, camera: computeCameraFrame(createCameraFrame(), sim.camera, 1),
    sim, quality: ctx.quality, renderScale: 1, pxPerUnit: 1,
  };
}

/** Advance the frame clock and camera like the pipeline does. */
export function stepFrame(frame: FrameInfo, sim: FakeSim, dt = 1 / 60, alpha = 1): FrameInfo {
  frame.dt = dt;
  frame.time += dt;
  frame.alpha = alpha;
  frame.frame++;
  computeCameraFrame(frame.camera, sim.camera, alpha);
  return frame;
}

/** Depth-first walk of a display tree. */
export function walk(c: Container, fn: (c: Container) => void): void {
  fn(c);
  for (const child of c.children) walk(child, fn);
}
