/**
 * Where the demo plate goes (ARCHITECTURE.md §5.8): the far kit layer it replaces, the texture size
 * that covers that layer's extent, the look it takes over, and the plate layer definition. Shared by
 * the bake (tools/plates/bake-plates.ts), the CPU previews and the tests; no encoders here.
 */
import type { KitLayerDef, LayerManifest, PlateChunkDef, PlateLayerDef } from '../../src/contracts/assets.ts';
import { coverageExtent } from '../../src/render/layers/placement.ts';
import { treelineLook, type TreelineLook } from './paint.ts';

export const CHUNK = 1024;
export const TEXEL_SCALE = 1.5;
/** Level size the plate must cover (the M1 forest: 200 × 50 tiles of 48 u). */
const LEVEL_W = 9600;
const LEVEL_H = 2400;
/** The far kit layer the demo plate replaces. */
export const REPLACES = 'L3-misty-trunks';
export const PLATE_ID = 'L3-plate-treeline';
export const PLATE_SEED = 4242;

/** Where the plate goes: the replaced layer's slot, texture size, look, and the layer def (no chunks yet). */
export interface PlatePlan {
  index: number;
  width: number;
  height: number;
  look: TreelineLook;
  layer: PlateLayerDef;
}

export function planPlate(manifest: LayerManifest): PlatePlan {
  const index = manifest.layers.findIndex((l) => l.id === REPLACES);
  const replaced = manifest.layers[index];
  if (!replaced || replaced.kind !== 'kit') throw new Error(`manifest has no kit layer ${REPLACES}`);
  const kit: KitLayerDef = replaced;
  const [fx, fy] = kit.parallax;
  const ext = coverageExtent(LEVEL_W, LEVEL_H, fx, fy);
  const width = Math.ceil((ext.x1 - ext.x0 + 64) / TEXEL_SCALE / CHUNK) * CHUNK;
  const height = Math.ceil((ext.y1 - ext.y0) / TEXEL_SCALE / CHUNK) * CHUNK;
  const origin: [number, number] = [Math.floor(ext.x0 - 32), Math.floor(ext.y0)];
  const baselineY = ext.y0 + kit.baseline * (ext.y1 - ext.y0);
  const layer: PlateLayerDef = {
    id: PLATE_ID,
    kind: 'plate',
    parallax: [fx, fy],
    minQuality: kit.minQuality,
    // The texture holds the replaced layer's colour before its distance fog: same fog and desaturation.
    tint: '#ffffff',
    fog: kit.fog,
    fogColor: kit.fogColor,
    desaturate: kit.desaturate,
    origin,
    chunkSize: [CHUNK, CHUNK],
    texelScale: TEXEL_SCALE,
    chunks: [],
  };
  return { index, width, height, look: treelineLook(kit, baselineY, origin[1], TEXEL_SCALE), layer };
}

/** The normal manifest with the replaced kit layer swapped for the plate layer. */
export function plateManifest(manifest: LayerManifest, plan: PlatePlan, chunks: PlateChunkDef[]): LayerManifest {
  const plate: PlateLayerDef = { ...plan.layer, chunks };
  return { ...manifest, layers: manifest.layers.map((l, i) => (i === plan.index ? plate : l)) };
}
