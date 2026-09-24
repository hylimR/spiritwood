import type { WebGLRenderer } from 'pixi.js';
import type { LayerManifest } from '../contracts/assets.ts';
import type { RenderStats } from '../contracts/debug.ts';
import type { LevelData } from '../contracts/level.ts';
import type { GpuInfo, QualitySettings, UserSettings } from '../contracts/quality.ts';
import type { RenderContext, RenderView } from '../contracts/render.ts';
import type { SimView } from '../contracts/sim.ts';
import { todo } from '../core/todo.ts';

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

/**
 * Owns the Pixi WebGL2 renderer, the scene/glow slot containers, render targets and the pass sequence
 * (ARCHITECTURE.md §3): scene RT (+depth) → glow RT → bloom → composite (grade, fade, vignette, dither)
 * to the canvas. Also owns quality resolution, dynamic resolution, screen shake, GPU timing, stats,
 * the render clock, and dispatching sim events to views. Refuses to start without WebGL2.
 */
export class RenderPipeline {
  static async create(options: PipelineOptions): Promise<RenderPipeline> {
    void options;
    return todo('PIPE', 'RenderPipeline.create');
  }

  get renderer(): WebGLRenderer {
    return todo('PIPE', 'RenderPipeline.renderer');
  }

  get ctx(): RenderContext {
    return todo('PIPE', 'RenderPipeline.ctx');
  }

  get stats(): RenderStats {
    return todo('PIPE', 'RenderPipeline.stats');
  }

  get gpu(): GpuInfo {
    return todo('PIPE', 'RenderPipeline.gpu');
  }

  get quality(): QualitySettings {
    return todo('PIPE', 'RenderPipeline.quality');
  }

  /** View size in view units for the sim camera: (VIEW_H × clamped aspect, VIEW_H). */
  get viewW(): number {
    return todo('PIPE', 'RenderPipeline.viewW');
  }

  get viewH(): number {
    return todo('PIPE', 'RenderPipeline.viewH');
  }

  /** Initialise and register a view (views draw in slot order; within a slot, in add order). */
  async addView(view: RenderView): Promise<void> {
    void view;
    todo('PIPE', 'RenderPipeline.addView');
  }

  /**
   * Fit the canvas into the available CSS size: aspect clamped to [MIN_ASPECT, MAX_ASPECT] (letter/
   * pillar-box), sets canvas.style width/height, backbuffer = CSS × min(dpr, pixelRatioCap), then calls
   * views' onResize.
   */
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number): void {
    void cssWidth; void cssHeight; void devicePixelRatio;
    todo('PIPE', 'RenderPipeline.resize');
  }

  /** Re-resolve quality from user settings (preset, dpr cap, fps cap, dynres) and notify views. */
  applySettings(settings: UserSettings): void {
    void settings;
    todo('PIPE', 'RenderPipeline.applySettings');
  }

  /** Add screen-shake trauma (0..1, decays over ~0.4 s). */
  addTrauma(amount: number): void {
    void amount;
    todo('PIPE', 'RenderPipeline.addTrauma');
  }

  /**
   * One frame: (a) advance the render clock by min(dt, MAX_RENDER_DT) and fill FrameInfo (camera with
   * shake, quality, sim); (b) for each queued sim event: add shake (Land with fall height ≥ 240, Died,
   * EnemyStomped) and call every view's onSimEvent; (c) views update; (d) passes. Does not clear the
   * queue (the orchestrator does, after audio/HUD). `nowSec` = wall time (dynres cooldown, GPU timing),
   * `dt` = unclamped frame dt, `lateFrames` from the loop.
   */
  render(sim: SimView, alpha: number, nowSec: number, dt: number, lateFrames: number): void {
    void sim; void alpha; void nowSec; void dt; void lateFrames;
    todo('PIPE', 'RenderPipeline.render');
  }

  /** Forward the F4 debug-draw toggle to views (RenderView.onDebugDraw). */
  setDebugDraw(enabled: boolean): void {
    void enabled;
    todo('PIPE', 'RenderPipeline.setDebugDraw');
  }

  destroy(): void {
    todo('PIPE', 'RenderPipeline.destroy');
  }
}
