import { PALETTE } from '../../config.ts';
import type { KitLayerDef, PlateLayerDef } from '../../contracts/assets.ts';
import type { QualityLevel } from '../../contracts/quality.ts';
import { hexToRgb, parseHexColor } from '../../core/color.ts';
import type { KitMeta } from '../gen/kit.ts';
import { depthForParallax } from '../util/camera.ts';
import { buildChunks, type ChunkMeshes } from './kitMesh.ts';
import { KIT_RIM_COLOR, type KitShadeParams } from './kitShading.ts';
import { placeLayer, type LayerPlacement } from './placement.ts';
import { RECIPES, type Recipe } from './recipes.ts';

export const QUALITY_RANK: Readonly<Record<QualityLevel, number>> = { low: 0, medium: 1, high: 2 };

/** Does quality `level` draw a layer whose manifest `minQuality` is `min`? */
export function meetsQuality(level: QualityLevel, min: QualityLevel): boolean {
  return QUALITY_RANK[level] >= QUALITY_RANK[min];
}

/** Kit layers at or below this parallax are merged into a single chunk (they barely scroll). */
export const SINGLE_CHUNK_PARALLAX = 0.3;

/** Everything static about one kit layer: placement, shading parameters and merged chunk meshes. */
export interface PreparedKitLayer {
  def: KitLayerDef;
  recipe: Recipe;
  placement: LayerPlacement;
  /** fx ≤ 1: depth-tested core + band in slots opaque/background; else blended in slot foreground. */
  depthTested: boolean;
  depth: number;
  params: KitShadeParams;
  /** Sway amplitude in layer units per 100 u of element height at weight 1 (before quality gating). */
  swayAmp: number;
  chunks: ChunkMeshes[];
}

export function kitShadeParams(def: KitLayerDef, recipe: Recipe, placement: LayerPlacement): KitShadeParams {
  return {
    tint: hexToRgb(parseHexColor(def.tint)),
    fogColor: hexToRgb(parseHexColor(def.fogColor)),
    fog: def.fog,
    desaturate: def.desaturate,
    rim: def.rim,
    rimColor: KIT_RIM_COLOR,
    glow: def.glow,
    mistY: placement.baselineY - recipe.mistDepth * 0.25,
    mistDepth: recipe.mistDepth,
    mist: recipe.mist,
  };
}

/** Plates carry their own colour: tint, desaturation and flat layer fog only. */
export function plateShadeParams(def: PlateLayerDef): KitShadeParams {
  return {
    tint: hexToRgb(parseHexColor(def.tint)),
    fogColor: hexToRgb(parseHexColor(def.fogColor)),
    fog: def.fog,
    desaturate: def.desaturate,
    rim: 0,
    rimColor: KIT_RIM_COLOR,
    glow: 0,
    mistY: 0,
    mistDepth: 1,
    mist: 0,
  };
}

export function prepareKitLayer(def: KitLayerDef, kit: KitMeta, levelW: number, levelH: number): PreparedKitLayer {
  const recipe = RECIPES[def.recipe];
  if (!recipe) throw new Error(`Layer ${def.id}: unknown recipe ${def.recipe}`);
  const placement = placeLayer(def, recipe, kit.byCategory, levelW, levelH);
  const fx = def.parallax[0];
  const depthTested = fx <= 1;
  const swayAmp = recipe.swayAmp * def.sway;
  const solid = kit.byCategory.solid[0];
  const ext = placement.extent;
  const chunks = buildChunks(placement.instances, {
    split: depthTested,
    depthF: depthTested ? fx : null,
    glow: PALETTE.floraGlow,
    chunkWidth: fx <= SINGLE_CHUNK_PARALLAX ? Infinity : def.chunkWidth,
    originX: ext.x0,
    swayAmp,
    atlasW: kit.width,
    atlasH: kit.height,
    fill: placement.groundFillTop !== null && solid
      ? { x0: ext.x0 - 200, y0: placement.groundFillTop, x1: ext.x1 + 200, y1: ext.y1 + 60, el: solid }
      : null,
  });
  return {
    def,
    recipe,
    placement,
    depthTested,
    depth: depthForParallax(fx),
    params: kitShadeParams(def, recipe, placement),
    swayAmp,
    chunks,
  };
}
