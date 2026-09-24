import type { Texture, WebGLRenderer } from 'pixi.js';
import type { TextureSourceDef } from '../contracts/assets.ts';
import type { TextureBudget } from '../contracts/render.ts';
import { todo } from '../core/todo.ts';

export interface TextureFormatSupport {
  /** GPU can sample a Basis/KTX2 transcode target (BC7/BC3/ETC2/ASTC). */
  ktx2: boolean;
  webp: boolean;
}

/**
 * Pick the URL to load for a source: ktx2 (if supported) → webp (if supported) → png. Paths resolve
 * against `baseUrl` (the manifest URL). Returns null for procedural-only sources. Pure.
 */
export function chooseTextureUrl(src: TextureSourceDef, support: TextureFormatSupport, baseUrl: string): string | null {
  void src; void support; void baseUrl;
  return todo('WORLD', 'chooseTextureUrl');
}

/** Probe compressed-format and WebP support once (cached). */
export async function detectTextureSupport(renderer: WebGLRenderer): Promise<TextureFormatSupport> {
  void renderer;
  return todo('WORLD', 'detectTextureSupport');
}

/**
 * Load a file-backed texture and register its bytes in `budget` under `key`. KTX2 goes through
 * `import 'pixi.js/ktx2'` with the transcoder served/emitted by the vite.config.ts plugin at
 * `transcoders/ktx/` (never copy it into public/). Call `setKTXTranscoderPath` once with ABSOLUTE urls
 * (`new URL('transcoders/ktx/libktx.js', document.baseURI).href`, same for .wasm): Pixi's worker
 * resolves relative paths against location.origin. On a KTX2 failure, fall back to WebP/PNG for that
 * chunk and disable KTX2 for the session. Returns the resolved URL (needed to unload).
 */
export async function loadTextureSource(
  src: TextureSourceDef, baseUrl: string, support: TextureFormatSupport, budget: TextureBudget, key: string,
): Promise<{ texture: Texture; url: string }> {
  void src; void baseUrl; void support; void budget; void key;
  return todo('WORLD', 'loadTextureSource');
}

/** Release via `Assets.unload(url)` (clears Pixi's loader cache too) and remove from the budget. */
export async function unloadTextureSource(url: string, budget: TextureBudget, key: string): Promise<void> {
  void url; void budget; void key;
  todo('WORLD', 'unloadTextureSource');
}
