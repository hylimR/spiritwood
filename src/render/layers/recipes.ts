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
}

const TREELINE: Recipe = {
  id: 'farTreeline',
  streams: [
    { items: [{ category: 'farCanopy', weight: 1, scale: [1.1, 1.5] }], density: 0.2, from: 'baseline', y: [0, 40] },
    { items: [{ category: 'farTree', weight: 1 }], density: 1, from: 'baseline', y: [-30, 40] },
    { items: [{ category: 'farCanopy', weight: 1, scale: [0.8, 1.1] }], density: 0.18, from: 'baseline', y: [20, 70] },
  ],
  groundFill: null,
  mist: 1,
  mistDepth: 220,
  swayAmp: 0,
};

const MID: Recipe = {
  id: 'midForest',
  streams: [
    { items: [{ category: 'midTrunk', weight: 1 }], density: 1, from: 'baseline', y: [-10, 24] },
    { items: [{ category: 'groundEdge', weight: 1, scale: [0.9, 1.2] }], density: 0, tile: 0.72, from: 'baseline', y: [-6, 10] },
    {
      items: [
        { category: 'midBush', weight: 3, scale: [0.8, 1.2] },
        { category: 'fern', weight: 2, scale: [0.9, 1.3] },
        { category: 'rock', weight: 1, scale: [0.8, 1.2] },
        { category: 'glowFlower', weight: 0.8, scale: [0.9, 1.2] },
      ],
      density: 2.4, from: 'baseline', y: [4, 26],
    },
    { items: [{ category: 'canopyTop', weight: 1, scale: [0.9, 1.3] }], density: 0.35, from: 'top', y: [-44, -16] },
    { items: [{ category: 'vine', weight: 1, scale: [0.8, 1.3] }], density: 0.7, from: 'top', y: [60, 320] },
  ],
  groundFill: 40,
  mist: 0.85,
  mistDepth: 320,
  swayAmp: 4,
};

const NEAR: Recipe = {
  id: 'nearForest',
  streams: [
    { items: [{ category: 'nearTrunk', weight: 1 }], density: 1, from: 'baseline', y: [-10, 24] },
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
      density: 2.2, from: 'baseline', y: [4, 24],
    },
    { items: [{ category: 'canopyTop', weight: 1, scale: [1, 1.4] }], density: 0.45, from: 'top', y: [-44, -16] },
    { items: [{ category: 'vine', weight: 1, scale: [1, 1.5] }], density: 0.6, from: 'top', y: [40, 300] },
  ],
  groundFill: 44,
  mist: 0.7,
  mistDepth: 380,
  swayAmp: 4,
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
};

export const RECIPES: Readonly<Record<string, Recipe>> = Object.freeze({
  [TREELINE.id]: TREELINE,
  [MID.id]: MID,
  [NEAR.id]: NEAR,
  [FRAME.id]: FRAME,
});

export const RECIPE_IDS: readonly string[] = Object.keys(RECIPES);
