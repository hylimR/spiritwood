import type { RenderView } from '../contracts/render.ts';
import { DebugDrawView } from '../debug/debugDraw.ts';
import { EntitiesView } from './entities/entitiesView.ts';
import { HeroView } from './hero/heroView.ts';

/** Hero, entities (orbs, checkpoints, enemy, goal) and the debug-draw view. Owned by PIPE. */
export function createPipeViews(): RenderView[] {
  return [new EntitiesView(), new HeroView(), new DebugDrawView()];
}
