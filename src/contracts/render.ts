import type { Container, WebGLRenderer } from 'pixi.js';
import type { LayerManifest } from './assets.ts';
import type { RenderStats } from './debug.ts';
import type { LevelData } from './level.ts';
import type { QualitySettings } from './quality.ts';
import type { SimEvent, SimView } from './sim.ts';

/** Scene slots in draw order (ARCHITECTURE.md §3). */
export const SCENE_SLOTS = [
  'opaque',
  'sky',
  'background',
  'shafts',
  'terrain',
  'entities',
  'hero',
  'front',
  'particles',
  'fog',
  'foreground',
] as const;
export type SceneSlot = (typeof SCENE_SLOTS)[number];

/** Slots the pipeline gives the camera transform (parallax 1). All others get identity view space. */
export const WORLD_SPACE_SLOTS: readonly SceneSlot[] = ['shafts', 'terrain', 'entities', 'hero', 'front', 'particles'];

/** Emissive twin slots, rendered additively into the half/quarter-res glow RT. All are world space. */
export const GLOW_SLOTS = ['world', 'entities', 'hero', 'particles'] as const;
export type GlowSlot = (typeof GLOW_SLOTS)[number];

/** Interpolated camera for this render frame, world units. */
export interface CameraFrame {
  /** Centre. */
  cx: number;
  cy: number;
  zoom: number;
  /** View size in view units (VIEW_H * aspect, VIEW_H). */
  viewW: number;
  viewH: number;
  /** Visible world rect at this zoom. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** Render-only screen-shake offset in view units (already applied by the pipeline to world slots). */
  shakeX: number;
  shakeY: number;
}

export interface FrameInfo {
  /**
   * Render clock: Σ min(dt, MAX_RENDER_DT) accumulated by the pipeline (no jumps after hitches or tab
   * switches). Upload `time % 3600` to shaders to keep float precision.
   */
  time: number;
  /** Render dt, seconds, clamped to MAX_RENDER_DT. */
  dt: number;
  /** Sim interpolation factor 0..1. */
  alpha: number;
  frame: number;
  camera: CameraFrame;
  sim: SimView;
  quality: QualitySettings;
  /** Current dynamic render scale (scene RT px per canvas px). */
  renderScale: number;
  /** Scene RT pixels per view unit — handy for pixel-sized AA widths. */
  pxPerUnit: number;
}

/** Tracks GPU texture bytes against the per-area budget. */
export interface TextureBudget {
  /** Register (or update) a texture's byte size under a stable key. */
  set(key: string, bytes: number): void;
  remove(key: string): void;
  readonly totalBytes: number;
  readonly budgetBytes: number;
}

/**
 * Every slot container is a render group (`isRenderGroup: true`) so visibility changes rebuild only that
 * slot. `opaque` and `background` have `sortableChildren = true`: views set `zIndex =
 * Math.round(depth * 1e6)` in `opaque` (near first) and `-Math.round(depth * 1e6)` in `background` (far
 * first), so draw order is right regardless of view init order.
 */
export type SceneSlots = Readonly<Record<SceneSlot, Container>>;
export type GlowSlots = Readonly<Record<GlowSlot, Container>>;

export interface RenderContext {
  /** Always a WebGL2 renderer (the pipeline refuses to start otherwise). */
  readonly renderer: WebGLRenderer;
  readonly scene: SceneSlots;
  readonly glow: GlowSlots;
  readonly level: LevelData;
  readonly manifest: LayerManifest;
  /** Base URL the manifest was loaded from (for resolving chunk/atlas paths). */
  readonly manifestUrl: string;
  /** One object for the whole session: the pipeline updates it in place, so ctx.quality === frame.quality. */
  readonly quality: QualitySettings;
  readonly textures: TextureBudget;
  /**
   * The pipeline zeroes `fillScreens` and `particles` before views update; views add their estimated
   * on-screen fill and live particle counts. The pipeline fills everything else.
   */
  readonly stats: RenderStats;
}

/**
 * A render view owns display objects inside the slots it was given and updates them per frame.
 * In `init`, before any `await`, create one child Container per slot you draw into and add it to
 * ctx.scene[slot] / ctx.glow[slot]; all later content (streamed chunks, lazily created objects) goes
 * inside those containers so draw order never depends on timing.
 * `update` runs every render frame and must not allocate.
 */
export interface RenderView {
  readonly name: string;
  init(ctx: RenderContext): Promise<void> | void;
  /** Called after init and after every resize / render-scale change. */
  onResize?(viewW: number, viewH: number, pxPerUnit: number): void;
  update(frame: FrameInfo): void;
  /**
   * Called inside RenderPipeline.render after this frame's FrameInfo is filled and before update(),
   * once per queued sim event. Views never read frame.sim.events themselves.
   */
  onSimEvent?(e: SimEvent, frame: FrameInfo): void;
  onQualityChanged?(q: QualitySettings): void;
  /** F4 collision/hitbox debug draw toggled. */
  onDebugDraw?(enabled: boolean): void;
  destroy(): void;
}

/** Colour grade parameters (per area, blended by camera position). */
export interface GradeParams {
  exposure: number;
  contrast: number;
  saturation: number;
  /** Warm (+) / cool (−) white balance shift, about −1..1. */
  temperature: number;
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  vignette: number;
  bloomIntensity: number;
}
