import type { Renderer } from 'pixi.js';
import type { LayerManifest } from '../contracts/assets.ts';
import type { RenderStats } from '../contracts/debug.ts';
import type { LevelData } from '../contracts/level.ts';
import type { GpuInfo, QualitySettings, UserSettings } from '../contracts/quality.ts';
import type { RenderContext, RenderView } from '../contracts/render.ts';
import type { SimEvent, SimView } from '../contracts/sim.ts';
import { todo } from '../core/todo.ts';

export interface PipelineOptions {
  /** Canvas to render into; the pipeline sizes its backbuffer, CSS size is the caller's. */
  canvas: HTMLCanvasElement;
  level: LevelData;
  manifest: LayerManifest;
  manifestUrl: string;
  settings: UserSettings;
}

/**
 * Owns the Pixi WebGL2 renderer, the scene/glow slot containers, render targets and the pass sequence
 * (ARCHITECTURE.md §3): scene RT (+depth) → glow RT → bloom → composite (grade, fade, vignette, dither)
 * to the canvas. Also owns quality resolution, dynamic resolution, screen shake, GPU timing, stats.
 */
export class RenderPipeline {
  static async create(options: PipelineOptions): Promise<RenderPipeline> {
    void options;
    return todo('PIPE', 'RenderPipeline.create');
  }

  get renderer(): Renderer {
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

  /** Resize to the canvas CSS size. Aspect beyond MIN/MAX_ASPECT is letter/pillar-boxed. */
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
   * Forward a sim event to every view's onSimEvent (called while draining the queue). The pipeline
   * also adds its own screen shake here (hard Land, Died, EnemyStomped).
   */
  dispatch(e: SimEvent): void {
    void e;
    todo('PIPE', 'RenderPipeline.dispatch');
  }

  /**
   * Update all views and draw the frame. `time` = render clock (s), `dt` = frame dt (s, unclamped),
   * `alpha` = sim interpolation factor, `lateFrames` from the loop (feeds dynamic resolution).
   */
  render(sim: SimView, alpha: number, time: number, dt: number, lateFrames: number): void {
    void sim; void alpha; void time; void dt; void lateFrames;
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
