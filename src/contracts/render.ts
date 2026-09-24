import type { Container, Renderer } from 'pixi.js';
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
  /** Render clock, seconds since start. */
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
  readonly renderer: Renderer;
  readonly scene: SceneSlots;
  readonly glow: GlowSlots;
  readonly level: LevelData;
  readonly manifest: LayerManifest;
  /** Base URL the manifest was loaded from (for resolving chunk/atlas paths). */
  readonly manifestUrl: string;
  readonly quality: QualitySettings;
  readonly textures: TextureBudget;
  /** Views add their estimated on-screen fill here each update (fillScreens is reset per frame). */
  readonly stats: RenderStats;
}

/**
 * A render view owns display objects inside the slots it was given and updates them per frame.
 * `update` runs every render frame and must not allocate.
 */
export interface RenderView {
  readonly name: string;
  init(ctx: RenderContext): Promise<void> | void;
  update(frame: FrameInfo): void;
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
