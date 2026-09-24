/** Working title — the only place the game's name is defined. */
export const GAME_TITLE = 'Spiritwood';

export const SIM_HZ = 60;
export const SIM_DT = 1 / SIM_HZ;
export const MAX_STEPS_PER_FRAME = 5;
/** Frame deltas within this many seconds of a multiple of SIM_DT are snapped to it. */
export const VSYNC_SNAP_EPSILON = 0.00025;
/** Render-clock dt clamp (seconds). */
export const MAX_RENDER_DT = 1 / 20;

/** World units per collision tile. */
export const TILE = 48;
/** World units visible vertically at zoom 1. */
export const VIEW_H = 1080;
export const MIN_ASPECT = 4 / 3;
export const MAX_ASPECT = 21 / 9;
/** Falling this far below the level bottom kills the player. */
export const KILL_MARGIN = 240;
/** Hazard tiles hurt only when the player overlaps them by more than this inset. */
export const HAZARD_INSET = 10;

/** Depth written by the sky; see ARCHITECTURE.md §2.4. */
export const DEPTH_SKY = 0.99;

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
