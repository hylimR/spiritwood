import { BufferImageSource, Texture, type TextureSourceOptions } from 'pixi.js';
import type { TextureBudget } from '../../contracts/render.ts';

/**
 * Build a Pixi texture from straight-alpha RGBA8 pixels (as produced by CPU generators).
 * Pixels are premultiplied in place before upload, matching Pixi's premultiplied pipeline.
 * Bypasses Texture.from's global cache (keyed by the pixel array, so reused scratch buffers would
 * return a stale texture). Atlases drawn minified should pass `autoGenerateMipmaps: true`, pack with
 * gutters ≥ 2^mipLevels texels, and register `estimateTextureBytes(w, h, 4, true)`.
 */
export function textureFromRgba(
  pixels: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  opts: Partial<TextureSourceOptions> & { premultiply?: boolean; label?: string } = {},
): Texture {
  const { premultiply = true, label, ...sourceOpts } = opts;
  const data = pixels instanceof Uint8Array ? pixels : new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  if (premultiply) premultiplyRgba(data);
  const source = new BufferImageSource({
    resource: data,
    width,
    height,
    format: 'rgba8unorm',
    alphaMode: 'premultiplied-alpha',
    scaleMode: 'linear',
    autoGenerateMipmaps: false,
    ...sourceOpts,
    ...(label ? { label } : {}),
  });
  return new Texture({ source, ...(label ? { label } : {}) });
}

export function premultiplyRgba(data: Uint8Array): void {
  for (let i = 0; i < data.length; i += 4) {
    const a = (data[i + 3] as number) / 255;
    data[i] = Math.round((data[i] as number) * a);
    data[i + 1] = Math.round((data[i + 1] as number) * a);
    data[i + 2] = Math.round((data[i + 2] as number) * a);
  }
}

/** Bytes a texture occupies on the GPU (RGBA8, +1/3 when mipmapped). */
export function estimateTextureBytes(width: number, height: number, bytesPerPixel = 4, mipmaps = false): number {
  const base = width * height * bytesPerPixel;
  return mipmaps ? Math.ceil(base * 4 / 3) : base;
}

export class SimpleTextureBudget implements TextureBudget {
  private readonly entries = new Map<string, number>();
  private total = 0;
  budgetBytes: number;

  constructor(budgetBytes: number) {
    this.budgetBytes = budgetBytes;
  }

  get totalBytes(): number {
    return this.total;
  }

  set(key: string, bytes: number): void {
    this.total += bytes - (this.entries.get(key) ?? 0);
    this.entries.set(key, bytes);
  }

  remove(key: string): void {
    const b = this.entries.get(key);
    if (b === undefined) return;
    this.total -= b;
    this.entries.delete(key);
  }
}
