import type { Container } from 'pixi.js';
import type { RenderContext } from '../../contracts/render.ts';

/**
 * The pipeline's RenderContext also carries the debug overlay container: drawn onto the canvas after
 * the composite (outside SCENE_SLOTS, so grading, bloom and the death fade never touch it), scaled to
 * view units at identity camera. Views apply the camera themselves (applyParallax, f = 1).
 */
export interface PipeRenderContext extends RenderContext {
  readonly overlay: Container;
}

export function hasOverlay(ctx: RenderContext): ctx is PipeRenderContext {
  return 'overlay' in ctx && (ctx as Partial<PipeRenderContext>).overlay !== undefined;
}
