import { beforeAll, describe, expect, test, vi } from 'vitest';
import {
  CLEAR, Container as ContainerCtor, DOMAdapter, RenderTarget, WebGLRenderer, type Container, type Rectangle, type RenderOptions,
} from 'pixi.js';
import {
  GLOW_SLOTS, SCENE_SLOTS, WORLD_SPACE_SLOTS, type FrameInfo, type RenderContext, type RenderView,
} from '../../src/contracts/render.ts';
import { AREA_GRADE_TABLE, DEFAULT_GRADE } from '../../src/content/grades.ts';
import type { PostChain } from '../../src/render/post/postChain.ts';
import { SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { MAX_RENDER_DT, VIEW_H } from '../../src/config.ts';
import { DEFAULT_SETTINGS } from '../../src/settings/store.ts';
import { QUALITY_PRESETS } from '../../src/settings/quality.ts';
import { hasOverlay } from '../../src/render/post/context.ts';
import { createFakeSimView, levelFromAscii } from '../shared/fixtures.ts';
import { TEST_MANIFEST } from './helpers.ts';

const renderCalls: (RenderOptions & { frame?: Rectangle })[] = [];

const fakeRenderer = Object.create(WebGLRenderer.prototype) as WebGLRenderer & { width: number; height: number };
Object.defineProperties(fakeRenderer, {
  width: { value: 1, writable: true },
  height: { value: 1, writable: true },
  context: { value: { webGLVersion: 2, extensions: { colorBufferFloat: {} } } },
  render: { value: (o: RenderOptions) => { renderCalls.push({ ...o }); } },
  resize: { value: (w: number, h: number) => { fakeRenderer.width = w; fakeRenderer.height = h; } },
  destroy: { value: vi.fn() },
});

vi.mock('pixi.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('pixi.js')>();
  return { ...mod, autoDetectRenderer: vi.fn(async () => fakeRenderer) };
});

class FakeGl {
  readonly RENDERER = 0x1f01;
  readonly VENDOR = 0x1f00;
  readonly MAX_TEXTURE_SIZE = 0x0d33;
  getExtension(name: string): unknown {
    return name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 1, UNMASKED_VENDOR_WEBGL: 2 } : null;
  }
  getParameter(p: number): unknown {
    if (p === 1) return 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)';
    if (p === 2) return 'Google Inc. (Intel)';
    if (p === this.MAX_TEXTURE_SIZE) return 16384;
    return '';
  }
  drawElements(): void {}
  drawArrays(): void {}
  drawElementsInstanced(): void {}
  drawArraysInstanced(): void {}
  drawRangeElements(): void {}
}

class FakeCanvas {
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  readonly gl = new FakeGl();
  width = 0;
  height = 0;
  clientWidth = 0;
  clientHeight = 0;
  getContext(kind: string): unknown {
    return kind === 'webgl2' ? this.gl : null;
  }
  addEventListener(type: string, fn: () => void): void {
    this.listeners.set(type, fn);
  }
  removeEventListener(type: string): void {
    this.listeners.delete(type);
  }
}

class RecordingView implements RenderView {
  readonly name = 'recording';
  readonly log: string[] = [];
  ctx: RenderContext | null = null;
  lastFrame: FrameInfo | null = null;
  resizes: [number, number, number][] = [];
  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.log.push('init');
  }
  onResize(w: number, h: number, px: number): void {
    this.resizes.push([w, h, px]);
  }
  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    this.log.push(`event:${e.type}:${frame.frame}`);
  }
  update(frame: FrameInfo): void {
    this.log.push(`update:${frame.frame}`);
    this.lastFrame = frame;
  }
  onQualityChanged(): void {
    this.log.push('quality');
  }
  onDebugDraw(enabled: boolean): void {
    this.log.push(`debug:${enabled}`);
  }
  destroy(): void {
    this.log.push('destroy');
  }
}

beforeAll(() => {
  DOMAdapter.set({ ...DOMAdapter.get(), createCanvas: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement });
});

async function setup(settings = { ...DEFAULT_SETTINGS }, level = levelFromAscii(['..........', '....P.....', '##########'])) {
  const { RenderPipeline } = await import('../../src/render/pipeline.ts');
  const canvas = new FakeCanvas();
  const pipeline = await RenderPipeline.create({
    canvas: canvas as unknown as HTMLCanvasElement, level, manifest: TEST_MANIFEST, manifestUrl: 'x', settings,
  });
  pipeline.resize(1920, 1080, 1);
  const sim = createFakeSimView(level, pipeline.viewW, pipeline.viewH);
  const view = new RecordingView();
  await pipeline.addView(view);
  renderCalls.length = 0;
  return { pipeline, canvas, sim, view };
}

describe('RenderPipeline orchestration (fake WebGL2)', () => {
  test('auto quality from the probed GPU; letterboxed canvas and view size', async () => {
    const { pipeline, canvas } = await setup();
    expect(pipeline.gpu.tier).toBe('integrated');
    expect(pipeline.quality).toMatchObject({ level: 'high', pixelRatioCap: 1, dynamicResolution: true });
    expect(canvas.style.width).toBe('1920px');
    expect(fakeRenderer.width).toBe(1920);
    expect(pipeline.viewH).toBe(VIEW_H);
    expect(pipeline.viewW).toBeCloseTo(1920, 6);
    pipeline.resize(3000, 1000, 2);
    expect(canvas.style.height).toBe('1000px');
    expect(pipeline.viewW / pipeline.viewH).toBeCloseTo(21 / 9, 2);
    expect(pipeline.stats.canvasWidth).toBe(fakeRenderer.width);
  });

  test('context carries slots, overlay, one shared quality object; views get onResize after init', async () => {
    const { pipeline, view } = await setup();
    const ctx = view.ctx as RenderContext;
    expect(ctx).toBe(pipeline.ctx);
    expect(ctx.quality).toBe(pipeline.quality);
    expect(hasOverlay(ctx)).toBe(true);
    expect(ctx.scene.opaque.sortableChildren).toBe(true);
    expect(ctx.scene.background.sortableChildren).toBe(true);
    for (const c of Object.values(ctx.scene) as Container[]) expect(c.isRenderGroup).toBe(true);
    for (const c of Object.values(ctx.glow) as Container[]) expect(c.isRenderGroup).toBe(true);
    expect(view.resizes.at(-1)?.[2]).toBeCloseTo(1, 6);
  });

  test('frame order: events (with a filled frame) → update → scene, glow, bloom chain, composite', async () => {
    const { pipeline, sim, view } = await setup();
    sim.events.push({ type: SimEventType.Jump });
    sim.events.push({ type: SimEventType.Land, a: 900, b: 600 });
    pipeline.render(sim, 0.5, 1, 1 / 60, 0);
    expect(view.log.slice(-3)).toEqual([`event:${SimEventType.Jump}:1`, `event:${SimEventType.Land}:1`, 'update:1']);
    const passes = QUALITY_PRESETS.high.bloomPasses;
    expect(renderCalls).toHaveLength(1 + 1 + 2 * passes + 1);
    const [scene, glow] = renderCalls;
    expect(scene?.target).toBeInstanceOf(RenderTarget);
    expect(scene?.clear).toBe(CLEAR.ALL);
    expect((scene?.target as RenderTarget).depth).toBe(true);
    expect(scene?.frame?.width).toBe(1920);
    expect(glow?.frame?.width).toBe(960);
    expect(renderCalls.at(-1)?.target).toBeUndefined();
    expect(renderCalls.at(-1)?.clear).toBe(CLEAR.NONE);
    expect(sim.events.count).toBe(2);
  });

  test('render clock clamps dt; shake from events offsets the camera', async () => {
    const { pipeline, sim, view } = await setup();
    pipeline.render(sim, 1, 1, 0.5, 0);
    expect(view.lastFrame?.dt).toBe(MAX_RENDER_DT);
    expect(view.lastFrame?.time).toBe(MAX_RENDER_DT);
    sim.events.push({ type: SimEventType.Died, a: 1 });
    pipeline.render(sim, 1, 1.02, 1 / 60, 0);
    sim.events.clear();
    let moved = false;
    for (let i = 0; i < 10; i++) {
      pipeline.render(sim, 1, 1.03 + i / 60, 1 / 60, 0);
      const cam = view.lastFrame?.camera;
      if (cam && (cam.shakeX !== 0 || cam.shakeY !== 0)) moved = true;
    }
    expect(moved).toBe(true);
  });

  test('the frame camera uses the canvas view size even when the sim camera lags a resize', async () => {
    const { pipeline, sim, view } = await setup();
    pipeline.resize(2400, 900, 1);
    expect(pipeline.viewW).not.toBeCloseTo(sim.camera.viewW, 1);
    sim.camera.zoom = sim.camera.prevZoom = 1.25;
    pipeline.render(sim, 1, 1, 1 / 60, 0);
    const cam = view.lastFrame?.camera;
    expect(cam?.viewW).toBe(pipeline.viewW);
    expect(cam?.viewH).toBe(pipeline.viewH);
    expect(cam?.width).toBeCloseTo(pipeline.viewW / 1.25, 6);
    expect(cam?.left).toBeCloseTo(sim.camera.x - pipeline.viewW / 2.5, 6);
    expect(cam?.top).toBeCloseTo(sim.camera.y - pipeline.viewH / 2.5, 6);
    // World-space slots are centred on the camera in the canvas view.
    const terrain = pipeline.ctx.scene.terrain;
    expect(terrain.position.x + sim.camera.x * terrain.scale.x).toBeCloseTo(pipeline.viewW / 2, 3);
  });

  test('world-space and glow slots follow the camera (with shake); parallax slots stay at identity', async () => {
    const { pipeline, sim, view } = await setup();
    Object.assign(sim.camera, { x: 1500, prevX: 1400, y: 300, prevY: 300 });
    pipeline.addTrauma(1);
    pipeline.render(sim, 0.5, 1, 1 / 60, 0);
    const ctx = pipeline.ctx;
    const shakeX = view.lastFrame?.camera.shakeX ?? 0;
    expect(shakeX).not.toBe(0);
    for (const slot of WORLD_SPACE_SLOTS) {
      const c = ctx.scene[slot];
      expect(c.position.x, slot).toBeCloseTo(pipeline.viewW / 2 - 1450 + shakeX, 6);
    }
    for (const slot of GLOW_SLOTS) expect(ctx.glow[slot].position.x).toBe(ctx.scene.terrain.position.x);
    for (const slot of SCENE_SLOTS) {
      if (WORLD_SPACE_SLOTS.includes(slot)) continue;
      const c = ctx.scene[slot];
      expect([c.position.x, c.position.y, c.scale.x, c.scale.y], slot).toEqual([0, 0, 1, 1]);
    }
  });

  test('composite: grade blended at the camera centre, death fade interpolated by alpha', async () => {
    const level = levelFromAscii(['..........', '....P.....', '##########']);
    level.gradeZones.push({ id: 0, grade: 'rootwell', x: 0, y: -5000, w: 100_000, h: 10_000, blend: 0 });
    const { pipeline, sim } = await setup(undefined, level);
    sim.prevFade = 0.2;
    sim.fade = 0.6;
    pipeline.render(sim, 0.25, 1, 1 / 60, 0);
    const u = (pipeline as unknown as { post: PostChain }).post.compositeUniforms.uniforms;
    expect(u.uFade).toBeCloseTo(0.3, 6);
    expect(u.uExposure).toBeCloseTo(AREA_GRADE_TABLE.rootwell.exposure, 6);
    expect(u.uVignette).toBeCloseTo(AREA_GRADE_TABLE.rootwell.vignette, 6);
    expect(u.uBloomIntensity).toBeCloseTo(AREA_GRADE_TABLE.rootwell.bloomIntensity / (QUALITY_PRESETS.high.bloomPasses + 1), 6);
    level.gradeZones.length = 0;
    pipeline.render(sim, 1, 1.1, 1 / 60, 0);
    expect(u.uFade).toBeCloseTo(0.6, 6);
    expect(u.uExposure).toBeCloseTo(DEFAULT_GRADE.exposure, 6);
  });

  test('foreground content is drawn over the glow twins (bloom occlusion) before the bloom chain', async () => {
    const { pipeline, sim } = await setup();
    pipeline.ctx.scene.foreground.addChild(new ContainerCtor());
    pipeline.render(sim, 1, 1, 1 / 60, 0);
    const passes = QUALITY_PRESETS.high.bloomPasses;
    expect(renderCalls).toHaveLength(1 + 1 + 1 + 2 * passes + 1);
    const occlusion = renderCalls[2];
    expect(occlusion?.container).toBe(pipeline.ctx.scene.foreground);
    expect(occlusion?.target).toBe(renderCalls[1]?.target);
    expect(occlusion?.clear).toBe(CLEAR.NONE);
    expect(occlusion?.frame?.width).toBe(renderCalls[1]?.frame?.width);
    // Scaled from view units straight to glow-target pixels (the scene's scale container is bypassed).
    expect(occlusion?.transform?.a).toBeCloseTo((renderCalls[1]?.frame?.width ?? 0) / pipeline.viewW, 6);
  });

  test('dynamic resolution off: late frames never shrink the target', async () => {
    const { pipeline, sim } = await setup({ ...DEFAULT_SETTINGS, dynamicResolution: false });
    for (let i = 0; i < 200; i++) pipeline.render(sim, 1, 5 + i / 60, 1 / 60, 3);
    expect(pipeline.renderScale).toBe(1);
    expect(pipeline.stats.rtWidth).toBe(1920);
  });

  test('dynamic resolution shrinks the sub-rect without reallocating and notifies views', async () => {
    const { pipeline, sim, view } = await setup();
    let t = 5;
    const before = view.resizes.length;
    for (let i = 0; i < 200; i++) {
      t += 1 / 60;
      pipeline.render(sim, 1, t, 1 / 60, 1);
    }
    expect(pipeline.renderScale).toBeLessThan(1);
    expect(pipeline.stats.rtWidth).toBe(Math.round(1920 * pipeline.renderScale));
    expect(view.resizes.length).toBeGreaterThan(before);
    const scene = renderCalls.at(-11);
    expect(scene?.frame?.width).toBe(pipeline.stats.rtWidth);
  });

  test('settings: in-place quality update, texture budget, view notification', async () => {
    const { pipeline, view } = await setup();
    const q = pipeline.quality;
    pipeline.applySettings({ ...DEFAULT_SETTINGS, preset: 'low', fpsCap: 0 });
    expect(pipeline.quality).toBe(q);
    expect(q).toMatchObject({ level: 'low', fpsCap: 0, bloomPasses: 2 });
    expect(pipeline.ctx.textures.budgetBytes).toBe(TEST_MANIFEST.textureBudgetMB.low * 2 ** 20);
    expect(view.log).toContain('quality');
  });

  test('debug draw adds the overlay pass; context loss pauses rendering', async () => {
    const { pipeline, sim, canvas, view } = await setup();
    pipeline.setDebugDraw(true);
    expect(view.log).toContain('debug:true');
    pipeline.render(sim, 1, 1, 1 / 60, 0);
    expect(renderCalls.at(-1)?.container.label).toBe('overlay-root');
    renderCalls.length = 0;
    canvas.listeners.get('webglcontextlost')?.();
    pipeline.render(sim, 1, 1.1, 1 / 60, 0);
    expect(renderCalls).toHaveLength(0);
    canvas.listeners.get('webglcontextrestored')?.();
    pipeline.render(sim, 1, 1.2, 1 / 60, 0);
    expect(renderCalls.length).toBeGreaterThan(0);
  });

  test('destroy tears down views and the renderer once', async () => {
    const { pipeline, view } = await setup();
    pipeline.destroy();
    pipeline.destroy();
    expect(view.log.filter((l) => l === 'destroy')).toHaveLength(1);
    expect(fakeRenderer.destroy).toHaveBeenCalled();
  });

  test('refuses to start without WebGL2', async () => {
    const { RenderPipeline } = await import('../../src/render/pipeline.ts');
    const canvas = new FakeCanvas();
    canvas.getContext = () => null;
    await expect(RenderPipeline.create({
      canvas: canvas as unknown as HTMLCanvasElement, level: levelFromAscii(['#']), manifest: TEST_MANIFEST, manifestUrl: '', settings: DEFAULT_SETTINGS,
    })).rejects.toThrow(/WebGL2/);
  });
});
