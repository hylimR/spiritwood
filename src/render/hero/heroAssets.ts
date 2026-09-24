import { blurRaster, createRaster, packAtlas, type Atlas, type AtlasImage } from './atlas.ts';
import { composePose } from './heroBake.ts';
import { createHeroClips, HERO_CLIP } from './heroClips.ts';
import { SQUASH } from './heroMotion.ts';
import { buildHeroImages, HERO_ATLAS_WIDTH, HERO_GUTTER } from './heroParts.ts';
import { createHeroSkeleton, HERO_PARTS } from './heroRig.ts';
import { Animator } from './rig.ts';

/** Texels per world unit of the baked dash silhouette (drawn soft, so low resolution is enough). */
export const GHOST_DENSITY = 1.5;
const GHOST_BOUNDS = { x0: -46, y0: -74, x1: 34, y1: 10 } as const;

/**
 * The dash afterimage: the rig in its dash pose (with the dash stretch), composited as a flat soft
 * silhouette. Pivot at the feet, facing right.
 */
export function bakeGhost(base: Atlas): AtlasImage {
  const skeleton = createHeroSkeleton();
  const animator = new Animator(skeleton, createHeroClips(skeleton));
  animator.snap(HERO_CLIP.dash, 0);
  animator.apply(skeleton);
  const sx = Math.exp(-SQUASH.dash);
  const sy = Math.exp(SQUASH.dash);
  skeleton.evaluate([sx, 0, 0, sy, 0, 0]);
  const pad = 3;
  const w = Math.ceil((GHOST_BOUNDS.x1 - GHOST_BOUNDS.x0) * GHOST_DENSITY) + pad * 2;
  const h = Math.ceil((GHOST_BOUNDS.y1 - GHOST_BOUNDS.y0) * GHOST_DENSITY) + pad * 2;
  const raster = createRaster(w, h);
  const originX = pad - GHOST_BOUNDS.x0 * GHOST_DENSITY;
  const originY = pad - GHOST_BOUNDS.y0 * GHOST_DENSITY;
  composePose(raster, base, skeleton, HERO_PARTS, {
    scale: GHOST_DENSITY, originX, originY, facingLeft: false, silhouette: true, skip: new Set(['eyeB', 'eyeF']),
  });
  blurRaster(raster, 1, 2);
  return { name: 'ghost', raster, pivotX: originX, pivotY: originY, density: GHOST_DENSITY };
}

/** The complete hero atlas: lit parts (both facings), eyes, bud, halo, scarf strip and dash ghost. */
export function buildHeroAssets(): Atlas {
  const images = buildHeroImages();
  const base = packAtlas(images, HERO_ATLAS_WIDTH, HERO_GUTTER);
  return packAtlas([...images, bakeGhost(base)], HERO_ATLAS_WIDTH, HERO_GUTTER);
}
