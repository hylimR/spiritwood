/**
 * The atlases the runtime registers in the texture budget besides plates (kit, particles, entity,
 * hero), measured by building them exactly as their owners do at load, never guessed.
 */
import type { LayerManifest } from '../../src/contracts/assets.ts';
import { buildEntityAtlas } from '../../src/render/entities/entityAtlas.ts';
import { generateParticleAtlas } from '../../src/render/gen/particleAtlas.ts';
import { buildHeroAssets } from '../../src/render/hero/heroAssets.ts';
import { estimateTextureBytes } from '../../src/render/util/texture.ts';
import type { AtlasMeasure } from './budget.ts';

/** Every runtime-registered atlas, sized as registered (RGBA8 with mipmaps). */
export function measureAtlases(manifest: LayerManifest): AtlasMeasure[] {
  const out: AtlasMeasure[] = [];
  const add = (id: string, width: number, height: number): void => {
    out.push({ id, width, height, bytes: estimateTextureBytes(width, height, 4, true) });
  };
  // WorldAssetsView registers each procedural manifest atlas at its manifest size.
  for (const a of manifest.atlases) if (a.source.procedural) add(a.id, a.width, a.height);
  const particles = generateParticleAtlas();
  add('world-particles', particles.width, particles.height);
  const entity = buildEntityAtlas();
  add('entity-atlas', entity.width, entity.height);
  const hero = buildHeroAssets();
  add('hero-atlas', hero.width, hero.height);
  return out;
}
