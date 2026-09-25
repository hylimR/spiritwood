import { PALETTE } from '../../config.ts';
import type { KitLayerDef, PlateLayerDef } from '../../contracts/assets.ts';
import type { LevelData } from '../../contracts/level.ts';
import type { QualityLevel } from '../../contracts/quality.ts';
import { hexToRgb, parseHexColor } from '../../core/color.ts';
import type { KitMeta } from '../gen/kit.ts';
import { STROKE_GAIN } from '../gen/kitElements.ts';
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

/**
 * The stroke gain a recipe's elements were baked for (STROKE_GAIN of every category it places, the
 * ground fill's `solid` included): one value per layer, or the bake and the shading disagree.
 */
export function recipeStrokeGain(recipe: Recipe): number {
  let gain = recipe.groundFill !== null ? STROKE_GAIN.solid : Number.NaN;
  for (const s of recipe.streams) {
    const cats = s.attach ? [...s.items.map((it) => it.category), s.attach.category] : s.items.map((it) => it.category);
    for (const c of cats) {
      const g = STROKE_GAIN[c];
      if (Number.isNaN(gain)) gain = g;
      else if (g !== gain) throw new Error(`recipe ${recipe.id}: ${c} is baked for stroke gain ${g}, the layer's other elements for ${gain}`);
    }
  }
  return Number.isNaN(gain) ? 1 : gain;
}

export function kitShadeParams(def: KitLayerDef, recipe: Recipe, placement: LayerPlacement): KitShadeParams {
  const fogColor = hexToRgb(parseHexColor(def.fogColor));
  return {
    tint: hexToRgb(parseHexColor(def.tint)),
    fogColor,
    mistColor: [fogColor[0] + recipe.mistLift[0], fogColor[1] + recipe.mistLift[1], fogColor[2] + recipe.mistLift[2]],
    fog: def.fog,
    desaturate: def.desaturate,
    rim: def.rim,
    rimColor: KIT_RIM_COLOR,
    glow: def.glow,
    mistY: placement.baselineY - recipe.mistDepth * 0.25,
    mistDepth: recipe.mistDepth,
    mist: recipe.mist,
    strokeGain: recipeStrokeGain(recipe),
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

/** World x of the places the forest opens up around: the goal and every lantern. */
export function clearingHints(level: Pick<LevelData, 'goal' | 'decorHints'>): number[] {
  const out: number[] = [];
  if (level.goal) out.push(level.goal.x + level.goal.w / 2);
  for (const h of level.decorHints) if (h.kind === 'lantern') out.push(h.x);
  return out;
}

export function prepareKitLayer(
  def: KitLayerDef, kit: KitMeta, levelW: number, levelH: number, clearings: readonly number[] = [],
): PreparedKitLayer {
  const recipe = RECIPES[def.recipe];
  if (!recipe) throw new Error(`Layer ${def.id}: unknown recipe ${def.recipe}`);
  const placement = placeLayer(def, recipe, kit.byCategory, levelW, levelH, clearings);
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
