import type { RenderView } from '../contracts/render.ts';
import { todo } from '../core/todo.ts';

/** Hero, entities (orbs, checkpoints, enemy, goal) and the debug-draw view. Owned by PIPE. */
export function createPipeViews(): RenderView[] {
  return todo('PIPE', 'createPipeViews');
}
