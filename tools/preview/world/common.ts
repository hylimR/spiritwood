import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { writePng } from '../png.ts';

/** Output directory: first CLI argument, else ./world-preview in the current directory. */
export function outDir(): string {
  const dir = process.argv[2] ?? 'world-preview';
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function save(dir: string, name: string, rgba: Uint8Array, w: number, h: number): void {
  writePng(join(dir, name), rgba, w, h);
  console.log(`wrote ${join(dir, name)} (${w}×${h})`);
}

/** Box-downsample straight RGBA by an integer factor (alpha-weighted colour). */
export function downsample(src: Uint8Array, w: number, h: number, f: number): { data: Uint8Array; w: number; h: number } {
  const ow = Math.floor(w / f);
  const oh = Math.floor(h / f);
  const out = new Uint8Array(ow * oh * 4);
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < f; j++) {
        for (let i = 0; i < f; i++) {
          const o = ((y * f + j) * w + x * f + i) * 4;
          const al = src[o + 3] as number;
          r += (src[o] as number) * al;
          g += (src[o + 1] as number) * al;
          b += (src[o + 2] as number) * al;
          a += al;
        }
      }
      const o = (y * ow + x) * 4;
      out[o] = a ? r / a : 0;
      out[o + 1] = a ? g / a : 0;
      out[o + 2] = a ? b / a : 0;
      out[o + 3] = a / (f * f);
    }
  }
  return { data: out, w: ow, h: oh };
}

/** Straight RGBA image with a solid background colour. */
export function canvas(w: number, h: number, bg: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    out[i * 4] = (bg >> 16) & 255;
    out[i * 4 + 1] = (bg >> 8) & 255;
    out[i * 4 + 2] = bg & 255;
    out[i * 4 + 3] = 255;
  }
  return out;
}
