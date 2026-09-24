import type { QualityLevel } from './quality.ts';

/**
 * A texture that may exist in several encodings. The loader picks KTX2 when the GPU supports a
 * compressed format, else WebP, else PNG. `procedural` names a runtime generator instead of a file.
 * Paths are relative to the manifest file.
 */
export interface TextureSourceDef {
  ktx2?: string;
  webp?: string;
  png?: string;
  procedural?: string;
}

export interface AtlasDef {
  id: string;
  source: TextureSourceDef;
  width: number;
  height: number;
}

interface LayerDefBase {
  id: string;
  /** Parallax factor [fx, fy]; ARCHITECTURE.md §2.3. */
  parallax: [number, number];
  /** Lowest quality level that draws this layer. */
  minQuality: QualityLevel;
  /** Layer tint (#rrggbb), multiplied into the silhouette colour. */
  tint: string;
  /** 0..1 blend toward the fog colour. */
  fog: number;
  /** Fog colour for this layer (#rrggbb). */
  fogColor: string;
  /** 0..1 desaturation. */
  desaturate: number;
}

export interface SkyLayerDef extends LayerDefBase {
  kind: 'sky';
  /** Gradient stops top→bottom as [t 0..1, #rrggbb]. */
  gradient: [number, string][];
  /** Moon centre in view fractions and radius in view units. */
  moon: { x: number; y: number; radius: number; color: string; halo: number };
  starDensity: number;
}

export interface FogLayerDef extends LayerDefBase {
  kind: 'fog';
  /** Band centre (layer-space y) and half-height, world units. */
  y: number;
  height: number;
  density: number;
  speed: number;
}

export interface KitLayerDef extends LayerDefBase {
  kind: 'kit';
  atlas: string;
  /** Generator recipe id, e.g. 'farTreeline', 'midTrees', 'nearRoots', 'frameTop', 'frameBottom'. */
  recipe: string;
  seed: number;
  /** Instances per 1000 layer units of width. */
  density: number;
  /** Instance scale range. */
  scale: [number, number];
  /** Layer-space y of the ground line, as a fraction of the layer extent height. */
  baseline: number;
  /** Rim light strength 0..1. */
  rim: number;
  /** Emissive strength 0..1 (0 = no glow parts). */
  glow: number;
  /** Wind sway amplitude scale 0..1 (0 = static). */
  sway: number;
  /**
   * Layer-space chunk width for merging/culling: ≥ 2048; layers with fx ≤ 0.3 should be one chunk.
   * Keeps ≤ 2 visible chunks (≤ 4 draws with core + band) per layer.
   */
  chunkWidth: number;
}

export interface PlateChunkDef {
  col: number;
  row: number;
  source: TextureSourceDef;
  /** Optional tight hull polygon (flat x,y pairs, chunk-local texels) for the translucent mesh. */
  hull?: number[];
  /** Optional fully-opaque interior polygon (drawn in the opaque pre-pass). */
  opaqueHull?: number[];
}

export interface PlateLayerDef extends LayerDefBase {
  kind: 'plate';
  /** Layer-space position of chunk (0,0)'s top-left. */
  origin: [number, number];
  /** Chunk size in texels. */
  chunkSize: [number, number];
  /** World units per texel. */
  texelScale: number;
  chunks: PlateChunkDef[];
}

export type LayerDef = SkyLayerDef | FogLayerDef | KitLayerDef | PlateLayerDef;

export interface LayerManifest {
  version: 1;
  area: string;
  /** Texture memory budget per quality level in MB (atlases + streamed plates, excluding RTs). */
  textureBudgetMB: Record<QualityLevel, number>;
  atlases: AtlasDef[];
  /** Ordered far → near. */
  layers: LayerDef[];
}
