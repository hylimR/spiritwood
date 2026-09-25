/** Working title — the only place the game's name is defined. */
export const GAME_TITLE = 'Spiritwood';

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
export const MAX_STEPS_PER_FRAME = 5;
/** Frame deltas within this many seconds of a multiple of SIM_DT are snapped to it. */
export const VSYNC_SNAP_EPSILON = 0.001;
/** Render-clock dt clamp (seconds). */
export const MAX_RENDER_DT = 1 / 20;

/** World units per collision tile. */
export const TILE = 48;
/** World units visible vertically at zoom 1. */
export const VIEW_H = 1080;
export const MIN_ASPECT = 4 / 3;
export const MAX_ASPECT = 21 / 9;
/** The sim camera never zooms out past this; static layer geometry is built for it. */
export const MIN_CAMERA_ZOOM = 1;
/** Falling this far below the level bottom kills the player. */
export const KILL_MARGIN = 240;
/** Hazard tiles hurt only when the player overlaps them by more than this inset. */
export const HAZARD_INSET = 10;

/** Depths (0 near … 1 far) for the scene pre-pass; see ARCHITECTURE.md §2.4. */
export const DEPTH_SKY = 0.99;
export const DEPTH_TERRAIN = 0.05;
export const DEPTH_SHAFTS = 0.055;
/** Per-instance depth step inside one layer (nearer instances get smaller depth). */
export const DEPTH_INSTANCE_EPS = 1 / 65536;
/** Max instances per depth-tested layer so instance depths never cross into the next layer. */
export const MAX_INSTANCES_PER_LAYER = 1024;
/** Depth-tested kit/plate layers need parallax ≤ this (stay behind shafts and terrain). */
export const MAX_LAYER_PARALLAX = 0.95;
/** Minimum parallax gap between consecutive depth-tested layers. */
export const MIN_LAYER_PARALLAX_GAP = 0.02;

/** "Moonlit Hush" reference palette (0xRRGGBB). */
export const PALETTE = {
  fogDeep: 0x0b1a2e,
  fogFar: 0x1f4a63,
  silhouette: 0x050b14,
  spiritGlow: 0xbff6ff,
  floraGlow: 0x3fe0c5,
  warmAccent: 0xffb45a,
  thorns: 0xff4d6d,
  moonlight: 0xd8f3ff,
  skyTop: 0x040a16,
  skyHorizon: 0x163a52,
} as const;

export type PaletteKey = keyof typeof PALETTE;

export const STORAGE_KEY = 'spiritwood.settings.v1';

/** Size of the SimView.projectiles pool (Thorn Spitter seeds). */
export const MAX_PROJECTILES = 32;
/**
 * Render world-clock scale while the sim is frozen for a Spirit Launch aim, the ease time constant into
 * the freeze and the (fast) one back out (s). See FrameInfo.worldTime.
 */
export const TIME_SCALE_FROZEN = 0.08;
export const TIME_SCALE_EASE = 0.12;
export const TIME_SCALE_RELEASE = 0.03;
