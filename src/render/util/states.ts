import { State } from 'pixi.js';

/**
 * GPU states for the depth-ordered scene passes (ARCHITECTURE.md §2.4). Use one of these on every
 * custom-shader Mesh in slots `opaque`, `sky`, `background`, `shafts`. For additive meshes set
 * `mesh.blendMode = 'add'` on the display object — never assign `state.blendMode` (Pixi's MeshPipe
 * overwrites it from the group blend mode every frame, and the setter re-enables blending).
 */

/** Opaque cores: no blending, depth test + write. Shaders must not `discard` or write gl_FragDepth. */
export function createOpaqueState(): State {
  const s = new State();
  s.blend = false;
  s.depthTest = true;
  s.depthMask = true;
  return s;
}

/** Sky: fills only pixels no opaque core wrote. No blending, depth test, no depth write. */
export function createSkyState(): State {
  const s = new State();
  s.blend = false;
  s.depthTest = true;
  s.depthMask = false;
  return s;
}

/** Soft bands / shafts: premultiplied blending (or additive via mesh.blendMode), depth test, no write. */
export function createTransparentState(): State {
  const s = new State();
  s.blend = true;
  s.depthTest = true;
  s.depthMask = false;
  return s;
}
