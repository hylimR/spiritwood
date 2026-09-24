import { Container, Mesh, ParticleContainer, Sprite, type TextureSource } from 'pixi.js';

/** A leaf in draw order with what Pixi batches on: its resolved blend mode and texture source. */
export interface DrawLeaf {
  node: Container;
  blend: string;
  source: TextureSource | null;
  batchable: boolean;
}

function resolvedBlend(c: Container): string {
  for (let n: Container | null = c; n; n = n.parent) if (n.blendMode !== 'inherit') return n.blendMode;
  return 'normal';
}

/** Renderable leaves under `root` in draw order (hidden subtrees skipped, alpha-0 leaves kept like Pixi does). */
export function drawLeaves(root: Container, out: DrawLeaf[] = []): DrawLeaf[] {
  if (!root.visible) return out;
  if (root instanceof Sprite) {
    out.push({ node: root, blend: resolvedBlend(root), source: root.texture.source, batchable: true });
  } else if (root instanceof Mesh) {
    out.push({ node: root, blend: resolvedBlend(root), source: root.texture.source, batchable: root.batched });
  } else if (root instanceof ParticleContainer) {
    out.push({ node: root, blend: resolvedBlend(root), source: null, batchable: false });
  }
  for (const child of root.children) drawLeaves(child, out);
  return out;
}

/**
 * Draw calls Pixi's default batcher issues for `root` (same-source atlases): consecutive batchable
 * leaves share a draw while blend mode and texture source stay the same; anything else is its own draw.
 */
export function countDraws(root: Container): number {
  let draws = 0;
  let blend = '';
  let source: TextureSource | null = null;
  let open = false;
  for (const leaf of drawLeaves(root)) {
    if (!leaf.batchable) {
      draws++;
      open = false;
      continue;
    }
    if (!open || leaf.blend !== blend || leaf.source !== source) {
      draws++;
      open = true;
      blend = leaf.blend;
      source = leaf.source;
    }
  }
  return draws;
}
