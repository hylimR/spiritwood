import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePng } from '../png.ts';

/** Output directory: first CLI argument, else <tmp>/spiritwood-preview/pipe. */
export function outDir(): string {
  const dir = process.argv[2] ?? join(tmpdir(), 'spiritwood-preview', 'pipe');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Straight-alpha RGBA image with float channels 0..1. */
export interface Image {
  w: number;
  h: number;
  data: Float32Array;
}

export function createImage(w: number, h: number, bg: readonly number[] = [0, 0, 0, 0]): Image {
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = bg[0] as number;
    data[i * 4 + 1] = bg[1] as number;
    data[i * 4 + 2] = bg[2] as number;
    data[i * 4 + 3] = bg[3] as number;
  }
  return { w, h, data };
}

/** Vertical gradient background (opaque). */
export function gradientImage(w: number, h: number, top: readonly number[], bottom: readonly number[]): Image {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++) {
    const t = y / Math.max(1, h - 1);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) img.data[o + c] = (top[c] as number) + ((bottom[c] as number) - (top[c] as number)) * t;
      img.data[o + 3] = 1;
    }
  }
  return img;
}

/** Composite straight-alpha RGBA8 pixels over `dst` at (ox, oy), optionally scaled up (nearest). */
export function drawRgba8(dst: Image, src: Uint8Array, sw: number, sh: number, ox: number, oy: number, scale = 1): void {
  for (let y = 0; y < sh * scale; y++) {
    for (let x = 0; x < sw * scale; x++) {
      const dx = ox + x;
      const dy = oy + y;
      if (dx < 0 || dy < 0 || dx >= dst.w || dy >= dst.h) continue;
      const s = (Math.floor(y / scale) * sw + Math.floor(x / scale)) * 4;
      const a = (src[s + 3] as number) / 255;
      if (a <= 0) continue;
      const o = (dy * dst.w + dx) * 4;
      for (let c = 0; c < 3; c++) dst.data[o + c] = (dst.data[o + c] as number) * (1 - a) + ((src[s + c] as number) / 255) * a;
      dst.data[o + 3] = Math.min(1, (dst.data[o + 3] as number) + a * (1 - (dst.data[o + 3] as number)));
    }
  }
}

export function savePng(img: Image, path: string): void {
  const out = new Uint8Array(img.w * img.h * 4);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round((img.data[i] as number) * 255)));
  writePng(path, out, img.w, img.h);
}

export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Previews script fake sim state; the contracts expose it read-only. */
export function mutable<T>(v: T): Mutable<T> {
  return v as Mutable<T>;
}

export function hexToRgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}
