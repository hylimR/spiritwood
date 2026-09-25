/**
 * Where the demo plate goes (ARCHITECTURE.md §5.8): the far kit layer it replaces, the texture size
 * that covers that layer's extent, the look it takes over, and the plate layer definition. Shared by
 * the bake (tools/plates/bake-plates.ts), the CPU previews and the tests; no encoders here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PLATE_CONTENT } from '../../src/assets/plateLayout.ts';
import { spliceManifest } from '../../src/assets/splice.ts';
import type { KitLayerDef, LayerManifest, PlateChunkDef, PlateLayerDef } from '../../src/contracts/assets.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { coverageExtent } from '../../src/render/layers/placement.ts';
import { treelineLook, type TreelineLook } from './paint.ts';

/** Content texels per chunk (the 1024² chunk textures add the PLATE_BORDER-texel duplicated border). */
export const CHUNK = PLATE_CONTENT;
export const TEXEL_SCALE = 1.5;
/** The far kit layer the demo plate replaces. */
export const REPLACES = 'L3-misty-trunks';
export const PLATE_ID = 'L3-plate-treeline';
export const PLATE_SEED = 4242;

const LDTK = fileURLToPath(new URL('../../public/levels/forest.ldtk', import.meta.url));

export interface LevelSize {
  width: number;
  height: number;
}

/** The size of the level the plate must cover, read from public/levels/forest.ldtk (never hard-coded). */
export function forestLevelSize(path: string = LDTK): LevelSize {
  const level = parseLdtk(JSON.parse(readFileSync(path, 'utf8')));
  return { width: level.pxWidth, height: level.pxHeight };
}

/** Where the plate goes: the replaced layer's slot, texture size, look, and the layer def (no chunks yet). */
export interface PlatePlan {
  index: number;
  width: number;
  height: number;
  look: TreelineLook;
  layer: PlateLayerDef;
}

export function planPlate(manifest: LayerManifest, level: LevelSize = forestLevelSize()): PlatePlan {
  const index = manifest.layers.findIndex((l) => l.id === REPLACES);
  const replaced = manifest.layers[index];
  if (!replaced || replaced.kind !== 'kit') throw new Error(`manifest has no kit layer ${REPLACES}`);
  const kit: KitLayerDef = replaced;
  const [fx, fy] = kit.parallax;
  const ext = coverageExtent(level.width, level.height, fx, fy);
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

/** The base manifest with the plate spliced in place of the kit layer it replaces (§5.8 splice). */
export function plateManifest(manifest: LayerManifest, plan: PlatePlan, chunks: PlateChunkDef[]): LayerManifest {
  const plate: PlateLayerDef = { ...plan.layer, chunks };
  return spliceManifest(manifest, [{ layer: plate, replaces: REPLACES }]);
}
