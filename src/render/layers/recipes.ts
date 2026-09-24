import type { KitCategory } from '../gen/kitElements.ts';

/** Where a stream's anchor y is measured from. */
export type RecipeAnchor = 'baseline' | 'top' | 'bottom';

export interface RecipeItem {
  category: KitCategory;
  weight: number;
  /** Multiplier on the layer's scale range. */
  scale?: [number, number];
}

export interface RecipeStream {
  items: readonly RecipeItem[];
  /** Instances per 1000 layer units = layer.density × this. Ignored for tiled streams. */
  density: number;
  /** Tiled streams place elements edge to edge with this overlap (0..1) instead of by density. */
  tile?: number;
  from: RecipeAnchor;
  /** Anchor y offset range (layer units) from `from`; negative is up. */
  y: [number, number];
  /** Horizontal flip allowed (default true). */
  flip?: boolean;
  /**
   * Clearings: a smooth 1D noise over x (one value per `scale` layer units) skips instances where it
   * falls below `below` (0..1), so the stream opens into glades instead of an even wall.
   */
  gaps?: { scale: number; below: number };
  /**
   * Crowns hung on the stretched column of each top-cut element this stream places (probability
   * `chance`), centred at a fraction in `span` of the way from the element's stretch row up to the
   * layer top, drawn right after their trunk.
   */
  attach?: { category: KitCategory; chance: number; span: [number, number] };
  /** Keep this stream out of the clearings around gameplay hints (the goal, lanterns). */
  clearAtHints?: boolean;
}

export interface Recipe {
  id: string;
  /** Painter order: earlier streams draw behind later ones. */
  streams: readonly RecipeStream[];
  /** Opaque ground body from baseline + groundFill down to the layer bottom (null = none). */
  groundFill: number | null;
  /** Height mist in the kit shader: fog rises to `mist` extra strength over `mistDepth` units below the baseline. */
  mist: number;
  mistDepth: number;
  /** Sway amplitude in layer units at full layer sway (per 100 u of element height). */
  swayAmp: number;
  /** Added to the layer's fog colour to give the colour of the mist rising from its base. */
  mistLift: readonly [number, number, number];
}

const TREELINE: Recipe = {
  id: 'farTreeline',
  streams: [
    { items: [{ category: 'farCanopy', weight: 1, scale: [1.0, 1.4] }], density: 0.15, from: 'baseline', y: [10, 50] },
    { items: [{ category: 'farTree', weight: 1 }], density: 1, from: 'baseline', y: [-20, 30], gaps: { scale: 650, below: 0.32 } },
    { items: [{ category: 'farCanopy', weight: 1, scale: [0.7, 1.0] }], density: 0.06, from: 'baseline', y: [40, 80] },
  ],
  groundFill: null,
  mist: 1,
  mistDepth: 260,
  swayAmp: 0,
  mistLift: [0, 0, 0],
};

const MID: Recipe = {
  id: 'midForest',
  streams: [
    {
      items: [{ category: 'midTrunk', weight: 1 }], density: 1.7, from: 'baseline', y: [-10, 24], gaps: { scale: 1150, below: 0.3 },
      attach: { category: 'midCrown', chance: 0.55, span: [0.18, 0.62] }, clearAtHints: true,
    },
    { items: [{ category: 'groundEdge', weight: 1, scale: [0.9, 1.2] }], density: 0, tile: 0.72, from: 'baseline', y: [-6, 10] },
    {
      items: [
        { category: 'midBush', weight: 3, scale: [0.8, 1.2] },
        { category: 'fern', weight: 2, scale: [0.9, 1.3] },
        { category: 'rock', weight: 1, scale: [0.8, 1.2] },
        { category: 'glowFlower', weight: 0.8, scale: [0.9, 1.2] },
      ],
      density: 3, from: 'baseline', y: [4, 26], gaps: { scale: 500, below: 0.25 },
    },
    { items: [{ category: 'canopyTop', weight: 1, scale: [0.9, 1.3] }], density: 0.55, from: 'top', y: [-44, -16], gaps: { scale: 800, below: 0.25 } },
    { items: [{ category: 'vine', weight: 1, scale: [0.8, 1.3] }], density: 0.6, from: 'top', y: [60, 320] },
  ],
  groundFill: 40,
  mist: 0.9,
  mistDepth: 360,
  swayAmp: 4,
  mistLift: [0.0, 0.035, 0.03],
};

const NEAR: Recipe = {
  id: 'nearForest',
  streams: [
    {
      items: [{ category: 'nearTrunk', weight: 1 }], density: 1, from: 'baseline', y: [-10, 24], gaps: { scale: 1000, below: 0.3 },
      clearAtHints: true,
    },
    { items: [{ category: 'groundEdge', weight: 1, scale: [1, 1.3] }], density: 0, tile: 0.72, from: 'baseline', y: [-6, 12] },
    {
      items: [
        { category: 'rootArch', weight: 1.4, scale: [0.9, 1.2] },
        { category: 'mushrooms', weight: 1.4, scale: [1, 1.4] },
        { category: 'fern', weight: 1.6, scale: [1.1, 1.5] },
        { category: 'rock', weight: 1, scale: [1, 1.4] },
        { category: 'midBush', weight: 0.8, scale: [0.7, 0.9] },
        { category: 'glowFlower', weight: 0.8, scale: [1.1, 1.4] },
      ],
      density: 2.6, from: 'baseline', y: [4, 24], gaps: { scale: 600, below: 0.25 },
    },
    { items: [{ category: 'canopyTop', weight: 1, scale: [1, 1.4] }], density: 0.45, from: 'top', y: [-44, -16], gaps: { scale: 900, below: 0.3 } },
    { items: [{ category: 'vine', weight: 1, scale: [1, 1.5] }], density: 0.6, from: 'top', y: [40, 300] },
  ],
  groundFill: 44,
  mist: 0.75,
  mistDepth: 400,
  swayAmp: 4,
  mistLift: [0.0, 0.025, 0.025],
};

const FRAME: Recipe = {
  id: 'frame',
  streams: [
    { items: [{ category: 'fgBottom', weight: 1 }], density: 1, from: 'bottom', y: [6, 30] },
    { items: [{ category: 'fgTop', weight: 1 }], density: 0.8, from: 'top', y: [-44, -16] },
    { items: [{ category: 'fgVine', weight: 1, scale: [0.8, 1.2] }], density: 0.25, from: 'top', y: [-30, -16] },
  ],
  groundFill: null,
  mist: 0,
  mistDepth: 1,
  swayAmp: 3,
  mistLift: [0, 0, 0],
};

export const RECIPES: Readonly<Record<string, Recipe>> = Object.freeze({
  [TREELINE.id]: TREELINE,
  [MID.id]: MID,
  [NEAR.id]: NEAR,
  [FRAME.id]: FRAME,
});

export const RECIPE_IDS: readonly string[] = Object.keys(RECIPES);
