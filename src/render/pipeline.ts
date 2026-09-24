import { autoDetectRenderer, CLEAR, Container, Matrix, WebGLRenderer } from 'pixi.js';
import type { LayerManifest } from '../contracts/assets.ts';
import type { RenderStats } from '../contracts/debug.ts';
import type { LevelData } from '../contracts/level.ts';
import type { GpuInfo, QualitySettings, UserSettings } from '../contracts/quality.ts';
import {
  GLOW_SLOTS, SCENE_SLOTS, WORLD_SPACE_SLOTS, type CameraFrame, type FrameInfo, type GlowSlot, type GlowSlots, type GradeParams,
  type RenderContext, type RenderView, type SceneSlot, type SceneSlots,
} from '../contracts/render.ts';
import type { SimView } from '../contracts/sim.ts';
import { MAX_RENDER_DT, PALETTE } from '../config.ts';
import { AREA_GRADE_TABLE, DEFAULT_GRADE } from '../content/grades.ts';
import { hexToRgb, type RGB } from '../core/color.ts';
import { DynamicResolution } from '../settings/dynres.ts';
import { resolveQuality } from '../settings/quality.ts';
import type { PipeRenderContext } from './post/context.ts';
import { DrawCounter, GpuTimer, probeGpu } from './post/gpu.ts';
import { blendGrades, createGradeParams } from './post/grade.ts';
import { PostChain, type PassOptions } from './post/postChain.ts';
import { ScreenShake, traumaForEvent } from './post/shake.ts';
import { createCanvasFit, fitCanvas, renderScaleCap, type CanvasFit } from './post/viewport.ts';
import { applyParallax, computeCameraFrame, createCameraFrame } from './util/camera.ts';
import { SimpleTextureBudget } from './util/texture.ts';

export interface PipelineOptions {
  /**
   * Canvas to render into. The pipeline owns its backbuffer AND its CSS size (the letterboxed rect);
   * the caller only inserts it into a centring container.
   */
  canvas: HTMLCanvasElement;
  level: LevelData;
  manifest: LayerManifest;
  manifestUrl: string;
  settings: UserSettings;
}

const MB = 2 ** 20;
/** Draw the dark foreground framing over the glow twins so it blocks bloom behind it. */
const OCCLUDE_GLOW_WITH_FOREGROUND = true;

function createStats(): RenderStats {
  return {
    drawCalls: 0, fillScreens: 0, rtWidth: 0, rtHeight: 0, renderScale: 1, canvasWidth: 0, canvasHeight: 0,
    particles: 0, textureMB: 0, gpuMs: -1,
  };
}

function slotContainers<K extends string>(names: readonly K[], parent: Container, prefix: string): Record<K, Container> {
  const out = {} as Record<K, Container>;
  for (const name of names) {
    const c = new Container({ isRenderGroup: true, label: `${prefix}:${name}` });
    parent.addChild(c);
    out[name] = c;
  }
  return out;
}

/**
 * Owns the Pixi WebGL2 renderer, the scene/glow slot containers, render targets and the pass sequence
 * (ARCHITECTURE.md §3): scene RT (+depth) → glow RT → bloom → composite (grade, fade, vignette, dither)
 * to the canvas. Also owns quality resolution, dynamic resolution, screen shake, GPU timing, stats,
 * the render clock, and dispatching sim events to views. Refuses to start without WebGL2.
 */
export class RenderPipeline {
  static async create(options: PipelineOptions): Promise<RenderPipeline> {
    const { canvas } = options;
    const gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    if (!gl) {
      throw new Error('This game needs WebGL2, which is not available in this browser or on this GPU (it may be disabled or blocklisted).');
    }
    const gpu = probeGpu(gl);
    const renderer = await autoDetectRenderer({
      preference: 'webgl', canvas, context: gl, width: canvas.width || 1, height: canvas.height || 1,
      resolution: 1, autoDensity: false, antialias: false, backgroundAlpha: 1, backgroundColor: PALETTE.fogDeep,
      clearBeforeRender: false, premultipliedAlpha: true, powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false, hello: false,
    });
    if (!(renderer instanceof WebGLRenderer) || renderer.context.webGLVersion !== 2) {
      renderer.destroy();
      throw new Error('This game needs a WebGL2 renderer.');
    }
    return new RenderPipeline(options, renderer, gl, gpu);
  }

  private readonly _renderer: WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly _ctx: PipeRenderContext;
  private readonly _stats: RenderStats = createStats();
  private readonly _gpu: GpuInfo;
  private readonly _quality: QualitySettings;
  private readonly textures: SimpleTextureBudget;
  private readonly manifest: LayerManifest;
  private readonly level: LevelData;
  private readonly views: RenderView[] = [];

  private readonly sceneRoot = new Container({ label: 'scene-root' });
  private readonly sceneScale = new Container({ label: 'scene-scale' });
  private readonly glowRoot = new Container({ label: 'glow-root' });
  private readonly glowScale = new Container({ label: 'glow-scale' });
  private readonly overlayRoot = new Container({ label: 'overlay-root' });
  private readonly overlayScale = new Container({ label: 'overlay-scale' });
  private readonly overlay = new Container({ label: 'overlay' });
  private readonly scene: SceneSlots;
  private readonly glow: GlowSlots;

  private readonly post: PostChain;
  private readonly glowForeground: PassOptions;
  private readonly glowForegroundMatrix = new Matrix();
  private readonly overlayOptions: PassOptions;
  private readonly timer: GpuTimer;
  private readonly draws: DrawCounter;
  private readonly dynres = new DynamicResolution();
  private readonly shake = new ScreenShake();
  private readonly fit: CanvasFit = createCanvasFit();
  private readonly frame: FrameInfo;
  private readonly grade: GradeParams = createGradeParams();
  private readonly fog: RGB = hexToRgb(PALETTE.fogDeep);
  private readonly clearColor: number[];

  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private maxScale = 1;
  private minScale = 1;
  private scale = 1;
  private dynresResetPending = true;
  private time = 0;
  private frameIndex = 0;
  private debugDraw = false;
  private contextLost = false;
  private destroyed = false;

  private constructor(options: PipelineOptions, renderer: WebGLRenderer, gl: WebGL2RenderingContext, gpu: GpuInfo) {
    this._renderer = renderer;
    this.canvas = options.canvas;
    this._gpu = gpu;
    this.level = options.level;
    this.manifest = options.manifest;
    this._quality = resolveQuality(options.settings, gpu);
    this.textures = new SimpleTextureBudget(this.budgetBytes());

    this.sceneRoot.addChild(this.sceneScale);
    this.glowRoot.addChild(this.glowScale);
    this.overlayRoot.addChild(this.overlayScale);
    this.overlayScale.addChild(this.overlay);
    const scene = slotContainers<SceneSlot>(SCENE_SLOTS, this.sceneScale, 'scene');
    scene.opaque.sortableChildren = true;
    scene.background.sortableChildren = true;
    this.scene = scene;
    this.glow = slotContainers<GlowSlot>(GLOW_SLOTS, this.glowScale, 'glow');

    const [r, g, b] = this.fog;
    this.clearColor = [r, g, b, 1];
    this.post = new PostChain(renderer, this.sceneRoot, this.glowRoot, this.clearColor);
    this.glowForeground = this.post.glowOverlayOptions(scene.foreground, this.glowForegroundMatrix);
    this.overlayOptions = { container: this.overlayRoot, clear: CLEAR.NONE };
    this.timer = new GpuTimer(gl);
    this.draws = new DrawCounter(gl);

    this.frame = {
      time: 0, dt: 0, alpha: 1, frame: 0, camera: createCameraFrame(), sim: null as unknown as SimView,
      quality: this._quality, renderScale: 1, pxPerUnit: 1,
    };
    this._ctx = {
      renderer, scene: this.scene, glow: this.glow, level: options.level, manifest: options.manifest,
      manifestUrl: options.manifestUrl, quality: this._quality, textures: this.textures, stats: this._stats,
      overlay: this.overlay,
    };

    this.canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
    this.resize(this.canvas.clientWidth || this.canvas.width || 1, this.canvas.clientHeight || this.canvas.height || 1, 1);
  }

  get renderer(): WebGLRenderer {
    return this._renderer;
  }

  get ctx(): RenderContext {
    return this._ctx;
  }

  get stats(): RenderStats {
    return this._stats;
  }

  get gpu(): GpuInfo {
    return this._gpu;
  }

  get quality(): QualitySettings {
    return this._quality;
  }

  /** View size in view units for the sim camera: (VIEW_H × clamped aspect, VIEW_H). */
  get viewW(): number {
    return this.fit.viewW;
  }

  get viewH(): number {
    return this.fit.viewH;
  }

  /** Current render scale (scene RT px per canvas px). */
  get renderScale(): number {
    return this.scale;
  }

  /** Initialise and register a view (views draw in slot order; within a slot, in add order). */
  async addView(view: RenderView): Promise<void> {
    await view.init(this._ctx);
    this.views.push(view);
    view.onResize?.(this.fit.viewW, this.fit.viewH, this.frame.pxPerUnit);
    if (this.debugDraw) view.onDebugDraw?.(true);
  }

  /**
   * Fit the canvas into the available CSS size: aspect clamped to [MIN_ASPECT, MAX_ASPECT] (letter/
   * pillar-box), sets canvas.style width/height, backbuffer = CSS × min(dpr, pixelRatioCap), then calls
   * views' onResize.
   */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    if (this.destroyed) return;
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = devicePixelRatio;
    const f = fitCanvas(cssWidth, cssHeight, devicePixelRatio, this._quality.pixelRatioCap, this.fit);
    this.canvas.style.width = `${f.cssWidth}px`;
    this.canvas.style.height = `${f.cssHeight}px`;
    if (this._renderer.width !== f.pixelWidth || this._renderer.height !== f.pixelHeight) {
      this._renderer.resize(f.pixelWidth, f.pixelHeight, 1);
    }
    this.frame.camera.viewW = f.viewW;
    this.frame.camera.viewH = f.viewH;
    this.reallocate();
  }

  /** Re-resolve quality from user settings (preset, dpr cap, fps cap, dynres) and notify views. */
  applySettings(settings: UserSettings): void {
    if (this.destroyed) return;
    const q = this._quality;
    const next = resolveQuality(settings, this._gpu);
    const resize = next.pixelRatioCap !== q.pixelRatioCap;
    const realloc = resize || next.renderScale !== q.renderScale || next.minRenderScale !== q.minRenderScale
      || next.maxRenderPixels !== q.maxRenderPixels || next.bloomScale !== q.bloomScale
      || next.bloomPasses !== q.bloomPasses || next.dynamicResolution !== q.dynamicResolution;
    Object.assign(q, next);
    this.textures.budgetBytes = this.budgetBytes();
    if (resize) this.resize(this.cssWidth, this.cssHeight, this.dpr);
    else if (realloc) this.reallocate();
    for (let i = 0; i < this.views.length; i++) this.views[i]?.onQualityChanged?.(q);
  }

  /** Add screen-shake trauma (0..1, decays over ~0.4 s). */
  addTrauma(amount: number): void {
    this.shake.add(amount);
  }

  /**
   * One frame: (a) advance the render clock by min(dt, MAX_RENDER_DT) and fill FrameInfo (camera with
   * shake, quality, sim); (b) for each queued sim event: add shake (Land with fall height ≥ 240, Died,
   * EnemyStomped) and call every view's onSimEvent; (c) views update; (d) passes. Does not clear the
   * queue (the orchestrator does, after audio/HUD). `nowSec` = wall time (dynres cooldown, GPU timing),
   * `dt` = unclamped frame dt, `lateFrames` from the loop.
   */
  render(sim: SimView, alpha: number, nowSec: number, dt: number, lateFrames: number): void {
    if (this.destroyed || this.contextLost) return;
    const q = this._quality;
    const stats = this._stats;
    const rdt = dt > 0 ? Math.min(dt, MAX_RENDER_DT) : 0;
    this.time += rdt;
    this.frameIndex++;
    stats.fillScreens = 0;
    stats.particles = 0;
    this.draws.reset();

    if (this.dynresResetPending) {
      this.dynresResetPending = false;
      this.dynres.reset(this.maxScale, this.minScale, nowSec);
    }
    if (q.dynamicResolution) {
      const s = this.dynres.update(lateFrames, this.timer.ms, nowSec);
      if (s !== this.scale) {
        this.scale = s;
        this.applyScale();
      }
    }

    const events = sim.events;
    for (let i = 0; i < events.count; i++) this.shake.add(traumaForEvent(events.get(i)));
    this.shake.update(rdt, this.time);

    const f = this.frame;
    f.time = this.time;
    f.dt = rdt;
    f.alpha = alpha;
    f.frame = this.frameIndex;
    f.sim = sim;
    f.renderScale = this.scale;
    const cam = computeCameraFrame(f.camera, sim.camera, alpha, this.shake.x, this.shake.y);
    this.fitCameraView(cam);
    const views = this.views;
    for (let i = 0; i < events.count; i++) {
      const e = events.get(i);
      for (let v = 0; v < views.length; v++) views[v]?.onSimEvent?.(e, f);
    }

    for (let i = 0; i < WORLD_SPACE_SLOTS.length; i++) applyParallax(this.scene[WORLD_SPACE_SLOTS[i] as SceneSlot], cam, 1, 1);
    for (let i = 0; i < GLOW_SLOTS.length; i++) applyParallax(this.glow[GLOW_SLOTS[i] as GlowSlot], cam, 1, 1);
    for (let v = 0; v < views.length; v++) (views[v] as RenderView).update(f);

    blendGrades(this.grade, this.level.gradeZones, cam.cx, cam.cy, AREA_GRADE_TABLE, DEFAULT_GRADE);
    const fade = sim.prevFade + (sim.fade - sim.prevFade) * alpha;
    this.post.setGrade(this.grade, fade, this.fog, this.fit.aspect, q.bloom);

    const r = this._renderer;
    this.timer.begin();
    r.render(this.post.sceneOptions);
    if (q.bloom) {
      r.render(this.post.glowOptions);
      if (OCCLUDE_GLOW_WITH_FOREGROUND && this.scene.foreground.children.length > 0) r.render(this.glowForeground);
      this.post.renderBloom(r);
    }
    r.render(this.post.compositeOptions);
    if (this.debugDraw) r.render(this.overlayOptions);
    this.timer.end();

    stats.drawCalls = this.draws.count;
    stats.gpuMs = this.timer.ms;
    stats.renderScale = this.scale;
    stats.textureMB = this.textures.totalBytes / MB;
  }

  /** Forward the F4 debug-draw toggle to views (RenderView.onDebugDraw). */
  setDebugDraw(enabled: boolean): void {
    this.debugDraw = enabled;
    for (let i = 0; i < this.views.length; i++) this.views[i]?.onDebugDraw?.(enabled);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.canvas.removeEventListener('webglcontextlost', this.onContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    for (let i = this.views.length - 1; i >= 0; i--) this.views[i]?.destroy();
    this.views.length = 0;
    this.post.destroy();
    this.timer.destroy();
    this.draws.destroy();
    this.sceneRoot.destroy({ children: true });
    this.glowRoot.destroy({ children: true });
    this.overlayRoot.destroy({ children: true });
    this._renderer.destroy();
  }

  /**
   * The rendered view is the pipeline's letterboxed canvas. The sim camera's viewW/viewH can lag a
   * resize (the orchestrator pushes the new size after `resize`, and a paused or title-screen world
   * doesn't step), so the frame always uses the canvas view size, or the image would be off-centre.
   */
  private fitCameraView(cam: CameraFrame): void {
    const vw = this.fit.viewW;
    const vh = this.fit.viewH;
    if (cam.viewW === vw && cam.viewH === vh) return;
    cam.viewW = vw;
    cam.viewH = vh;
    cam.width = vw / cam.zoom;
    cam.height = vh / cam.zoom;
    cam.left = cam.cx - cam.width / 2;
    cam.top = cam.cy - cam.height / 2;
  }

  private budgetBytes(): number {
    return (this.manifest.textureBudgetMB[this._quality.level] ?? 96) * MB;
  }

  /** Target sizes for the current canvas and quality; resets dynamic resolution to the maximum. */
  private reallocate(): void {
    const q = this._quality;
    const f = this.fit;
    const cap = renderScaleCap(f.pixelWidth, f.pixelHeight, q.maxRenderPixels);
    this.maxScale = Math.min(q.renderScale, cap);
    this.minScale = Math.min(this.maxScale, this.maxScale * (q.minRenderScale / q.renderScale));
    this.post.allocate(f.pixelWidth, f.pixelHeight, this.maxScale, q.bloomScale, q.bloomPasses);
    // Reset on the next frame, on the loop's clock (starts a cooldown so start-up hitches can't drop).
    this.dynresResetPending = true;
    this.scale = this.maxScale;
    const stats = this._stats;
    stats.canvasWidth = f.pixelWidth;
    stats.canvasHeight = f.pixelHeight;
    this.applyScale();
  }

  /** Move the sub-rects for the current scale and rescale the slot roots; notify views. */
  private applyScale(): void {
    const f = this.fit;
    const q = this._quality;
    this.post.setScale(f.pixelWidth, f.pixelHeight, this.scale, q.bloomScale);
    const l = this.post.layout;
    const sx = l.sceneW / f.viewW;
    const sy = l.sceneH / f.viewH;
    this.sceneScale.scale.set(sx, sy);
    const gx = (l.subW[0] as number) / f.viewW;
    const gy = (l.subH[0] as number) / f.viewH;
    this.glowScale.scale.set(gx, gy);
    this.glowForegroundMatrix.set(gx, 0, 0, gy, 0, 0);
    this.overlayScale.scale.set(f.pixelWidth / f.viewW, f.pixelHeight / f.viewH);
    this.frame.pxPerUnit = sy;
    this.frame.renderScale = this.scale;
    const stats = this._stats;
    stats.rtWidth = l.sceneW;
    stats.rtHeight = l.sceneH;
    stats.renderScale = this.scale;
    for (let i = 0; i < this.views.length; i++) this.views[i]?.onResize?.(f.viewW, f.viewH, sy);
  }

  private readonly onContextLost = (): void => {
    this.contextLost = true;
    console.warn('[spiritwood] WebGL context lost — rendering paused until it is restored.');
  };

  private readonly onContextRestored = (): void => {
    this.contextLost = false;
    this.timer.restore();
    console.info('[spiritwood] WebGL context restored.');
  };
}
