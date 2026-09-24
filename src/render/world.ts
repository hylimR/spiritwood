import type { RenderView } from '../contracts/render.ts';
import { todo } from '../core/todo.ts';

/**
 * All world-visual views in init order: sky, parallax stack (opaque/background/foreground slots),
 * fog, light shafts, terrain, decor (terrain/front slots), particles. Owned by WORLD.
 */
export function createWorldViews(): RenderView[] {
  return todo('WORLD', 'createWorldViews');
}
