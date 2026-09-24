export type QualityPreset = 'auto' | 'high' | 'medium' | 'low';
export type QualityLevel = 'high' | 'medium' | 'low';

/** Resolved quality (auto already mapped to a level). Values per ARCHITECTURE.md §5.7. */
export interface QualitySettings {
  level: QualityLevel;
  /** Max devicePixelRatio used for the canvas backbuffer. */
  pixelRatioCap: number;
  /** Initial (and maximum) internal render scale for scene/glow RTs, 0.5..1. */
  renderScale: number;
  /** Floor for dynamic resolution. */
  minRenderScale: number;
  /** Hard cap on internal scene RT pixel count (w*h). */
  maxRenderPixels: number;
  dynamicResolution: boolean;
  bloom: boolean;
  /** Glow RT scale relative to the scene RT. */
  bloomScale: 0.5 | 0.25;
  bloomPasses: number;
  /** Max number of kit layers drawn (manifest layers above the level are dropped far-first). */
  layerBudget: number;
  /** Multiplier on ambient particle counts. */
  particleDensity: number;
  lightShafts: boolean;
  foliageSway: boolean;
  fogBands: number;
  /** 60 = cap to 60 fps, 0 = uncapped (vsync). */
  fpsCap: number;
}

/** Persisted user choices (localStorage). null = use the preset default. */
export interface UserSettings {
  preset: QualityPreset;
  pixelRatioCap: number | null;
  fpsCap: 60 | 0;
  dynamicResolution: boolean;
  debugOverlay: boolean;
}

/** GPU facts used by auto quality. */
export interface GpuInfo {
  renderer: string;
  vendor: string;
  /** Classification from the renderer string. */
  tier: 'discrete' | 'integrated' | 'software' | 'unknown';
  maxTextureSize: number;
  timerQuery: boolean;
}
