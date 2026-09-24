import { ParticleBuffer, type Buffer, type ParticleContainer } from 'pixi.js';

/**
 * Replays what Pixi 8.21's ParticleContainerPipe does on a container's first render: a ParticleBuffer
 * sized for `particleChildren`, then `update(children, container._childrenDirty)`. Returns how many
 * floats the static vertex buffer holds and how many the draw needs.
 */
export function firstRenderStaticUpload(pc: ParticleContainer): { have: number; need: number } {
  const buf = new ParticleBuffer({ size: pc.particleChildren.length, properties: pc._properties });
  buf.update(pc.particleChildren, (pc as unknown as { _childrenDirty: boolean })._childrenDirty);
  const inner = buf as unknown as { _staticBuffer: Buffer; _staticStride: number };
  const have = inner._staticBuffer.data.length;
  buf.destroy();
  return { have, need: pc.particleChildren.length * 4 * inner._staticStride };
}
