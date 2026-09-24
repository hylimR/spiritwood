import type { Renderer, Texture } from 'pixi.js';
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
export async function detectTextureSupport(renderer: Renderer): Promise<TextureFormatSupport> {
  void renderer;
  return todo('WORLD', 'detectTextureSupport');
}

/**
 * Load a file-backed texture (KTX2 via pixi.js/ktx2 with the self-hosted transcoder in
 * public/transcoders/ktx/, else WebP/PNG) and register its bytes in `budget` under `key`.
 */
export async function loadTextureSource(
  src: TextureSourceDef, baseUrl: string, support: TextureFormatSupport, budget: TextureBudget, key: string,
): Promise<Texture> {
  void src; void baseUrl; void support; void budget; void key;
  return todo('WORLD', 'loadTextureSource');
}

/** Release a texture loaded by loadTextureSource and remove it from the budget. */
export function unloadTextureSource(texture: Texture, budget: TextureBudget, key: string): void {
  void texture; void budget; void key;
  todo('WORLD', 'unloadTextureSource');
}
