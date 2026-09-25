/**
 * CPU atlas helpers shared by the hero and entity generators (init-time only; allocation is fine).
 * Images are straight-alpha RGBA float rasters until they are packed into one RGBA8 atlas, except
 * `premultiplied` images, whose colour is already premultiplied and may exceed alpha: emissive light
 * that adds under premultiplied normal blending (a texel with alpha 0 and colour > 0 is pure light).
 */

export interface Raster {
  w: number;
  h: number;
  /** Straight-alpha RGBA, 0..1. */
  data: Float32Array;
}

export function createRaster(w: number, h: number): Raster {
  return { w, h, data: new Float32Array(w * h * 4) };
}

/** A packed image: pixel rect in the atlas plus its pivot (in pixels, relative to the rect). */
export interface AtlasFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pivot inside the frame, pixels (the part's attachment point). */
  pivotX: number;
  pivotY: number;
  /** Texels per world unit this image was drawn at. */
  density: number;
}

export interface AtlasImage {
  name: string;
  raster: Raster;
  pivotX: number;
  pivotY: number;
  density: number;
  /** The raster's colour is premultiplied (and may exceed alpha: emission). Needs a premultiplied atlas. */
  premultiplied?: boolean;
}

export interface Atlas {
  width: number;
  height: number;
  /** RGBA8 pixels: straight alpha, or premultiplied (with emissive texels) when `premultiplied`. */
  pixels: Uint8Array;
  frames: Record<string, AtlasFrame>;
  /** Pixels are premultiplied: upload them as they are (textureFromRgba `premultiply: false`). */
  premultiplied: boolean;
}

/**
 * Shelf-pack images (tallest first, deterministic) into a `width`-wide atlas with `gutter` transparent
 * texels around every image (≥ 2^mipLevels for mipmapped sampling). Height rounds up to a multiple of 4.
 * A `premultiplied` atlas stores premultiplied colour (straight images are multiplied by their alpha,
 * premultiplied images are copied, emission included); otherwise it is straight alpha and may not hold
 * premultiplied images.
 */
export function packAtlas(images: readonly AtlasImage[], width: number, gutter: number, premultiplied = false): Atlas {
  const order = images.map((img, i) => ({ img, i })).sort((a, b) => b.img.raster.h - a.img.raster.h || a.i - b.i);
  const frames: Record<string, AtlasFrame> = {};
  let x = gutter;
  let y = gutter;
  let rowH = 0;
  for (const { img } of order) {
    const { w, h } = img.raster;
    if (w + 2 * gutter > width) throw new Error(`Atlas image ${img.name} (${w}px) wider than the atlas`);
    if (x + w + gutter > width) {
      x = gutter;
      y += rowH + gutter;
      rowH = 0;
    }
    if (frames[img.name]) throw new Error(`Duplicate atlas image ${img.name}`);
    frames[img.name] = { x, y, w, h, pivotX: img.pivotX, pivotY: img.pivotY, density: img.density };
    x += w + gutter;
    rowH = Math.max(rowH, h);
  }
  const height = Math.ceil((y + rowH + gutter) / 4) * 4;
  const pixels = new Uint8Array(width * height * 4);
  for (const img of images) {
    if (img.premultiplied && !premultiplied) throw new Error(`Atlas image ${img.name} is premultiplied; pack a premultiplied atlas`);
    const f = frames[img.name] as AtlasFrame;
    const src = img.raster.data;
    const k = premultiplied && !img.premultiplied;
    for (let py = 0; py < f.h; py++) {
      for (let px = 0; px < f.w; px++) {
        const s = (py * f.w + px) * 4;
        const d = ((f.y + py) * width + f.x + px) * 4;
        const a = src[s + 3] as number;
        const r = src[s] as number;
        const g = src[s + 1] as number;
        const b = src[s + 2] as number;
        if (a <= 0 && !(img.premultiplied && (r > 0 || g > 0 || b > 0))) continue;
        const m = k ? Math.max(0, a) : 1;
        pixels[d] = toByte(r * m);
        pixels[d + 1] = toByte(g * m);
        pixels[d + 2] = toByte(b * m);
        pixels[d + 3] = toByte(a);
      }
    }
  }
  return { width, height, pixels, frames, premultiplied };
}

export function toByte(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 255 : Math.round(v * 255);
}

/** RGB colour from 0xRRGGBB, 0..1. */
export function rgb(hex: number): [number, number, number] {
  return [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
}

export function mix3(a: readonly number[], b: readonly number[], t: number): [number, number, number] {
  return [
    (a[0] as number) + ((b[0] as number) - (a[0] as number)) * t,
    (a[1] as number) + ((b[1] as number) - (a[1] as number)) * t,
    (a[2] as number) + ((b[2] as number) - (a[2] as number)) * t,
  ];
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Separable box blur of the alpha-premultiplied raster (radius in texels), for soft glows. */
export function blurRaster(r: Raster, radius: number, passes = 2): void {
  if (radius <= 0) return;
  const { w, h, data } = r;
  const tmp = new Float32Array(data.length);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] as number;
    data[i * 4] = (data[i * 4] as number) * a;
    data[i * 4 + 1] = (data[i * 4 + 1] as number) * a;
    data[i * 4 + 2] = (data[i * 4 + 2] as number) * a;
  }
  const norm = 1 / (2 * radius + 1);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let s = 0;
          for (let k = -radius; k <= radius; k++) {
            const xx = Math.min(w - 1, Math.max(0, x + k));
            s += data[(y * w + xx) * 4 + c] as number;
          }
          tmp[(y * w + x) * 4 + c] = s * norm;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 4; c++) {
          let s = 0;
          for (let k = -radius; k <= radius; k++) {
            const yy = Math.min(h - 1, Math.max(0, y + k));
            s += tmp[(yy * w + x) * 4 + c] as number;
          }
          data[(y * w + x) * 4 + c] = s * norm;
        }
      }
    }
  }
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] as number;
    if (a > 1e-6) {
      data[i * 4] = (data[i * 4] as number) / a;
      data[i * 4 + 1] = (data[i * 4 + 1] as number) / a;
      data[i * 4 + 2] = (data[i * 4 + 2] as number) / a;
    }
  }
}
