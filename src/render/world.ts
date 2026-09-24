import type { RenderView } from '../contracts/render.ts';
import { DecorView } from './fx/decor.ts';
import { ParticlesView } from './fx/particles.ts';
import { ShaftsView } from './fx/shafts.ts';
import { WorldAssets, WorldAssetsView } from './layers/assets.ts';
import { FogView } from './layers/fog.ts';
import { ParallaxStackView } from './layers/parallaxStack.ts';
import { SkyView } from './layers/sky.ts';
import { TerrainView } from './terrain/terrainView.ts';

/**
 * All world-visual views in init order: the shared-atlas owner (kit + particle atlas, destroyed
 * last-registered-first by the owner), sky, parallax stack (opaque/background/foreground slots), fog,
 * light shafts, terrain, decor (terrain/front slots), particles. Owned by WORLD.
 */
export function createWorldViews(): RenderView[] {
  const assets = new WorldAssets();
  return [
    new WorldAssetsView(assets),
    new SkyView(),
    new ParallaxStackView(assets),
    new FogView(),
    new ShaftsView(),
    new TerrainView(),
    new DecorView(assets),
    new ParticlesView(assets),
  ];
}
