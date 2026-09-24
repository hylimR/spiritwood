import { NoiseTable } from './noiseTable.ts';
import { packRects, type PackItem } from './pack.ts';

/** Particle sprite frames: white (tintable) shapes with straight alpha. */
export const PARTICLE_FRAMES = ['dot', 'core', 'spark', 'star', 'puff', 'wisp', 'leaf0', 'leaf1', 'leaf2'] as const;
export type ParticleFrame = (typeof PARTICLE_FRAMES)[number];

export interface FrameRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ParticleAtlasData {
  width: number;
  height: number;
  pixels: Uint8Array;
  frames: Readonly<Record<ParticleFrame, FrameRect>>;
}

const SIZES: Readonly<Record<ParticleFrame, [number, number]>> = {
  dot: [32, 32],
  core: [32, 32],
  spark: [64, 16],
  star: [40, 40],
  puff: [64, 64],
  wisp: [56, 56],
  leaf0: [28, 18],
  leaf1: [28, 16],
  leaf2: [24, 20],
};

const GUTTER = 4;

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** (lum, alpha) of a frame at normalised coords u, v ∈ [-1, 1]. */
function frameTexel(frame: ParticleFrame, u: number, v: number, noise: NoiseTable, px: number, py: number): [number, number] {
  const r = Math.sqrt(u * u + v * v);
  switch (frame) {
    case 'dot':
      return [1, Math.exp(-r * r * 4.5) * (1 - smooth(0.9, 1, r))];
    case 'core':
      return [1, Math.min(1, Math.exp(-r * r * 22) * 1.2 + Math.exp(-r * r * 3.2) * 0.45) * (1 - smooth(0.9, 1, r))];
    case 'spark': {
      const along = 1 - smooth(0.1, 1, Math.abs(u) * (u > 0 ? 1 : 1.6));
      return [1, Math.exp(-v * v * 9) * along];
    }
    case 'star': {
      const rays = Math.exp(-Math.abs(u) * 14) * Math.exp(-v * v * 2.5) + Math.exp(-Math.abs(v) * 14) * Math.exp(-u * u * 2.5);
      return [1, Math.min(1, rays * 0.9 + Math.exp(-r * r * 16)) * (1 - smooth(0.85, 1, r))];
    }
    case 'puff': {
      const n = noise.sample(px * 0.9, py * 0.9);
      return [1, smooth(1, 0.15, r + n * 0.25) * 0.85];
    }
    case 'wisp': {
      const n = noise.sample(px * 0.6 + 40, py * 0.6);
      const n2 = noise.sample(px * 1.7 + 11, py * 1.7 + 3);
      return [1, smooth(1, 0.1, r + n * 0.45 + n2 * 0.12) * 0.9];
    }
    default: {
      // Leaves: pointed ellipse with a darker core and a lit upper edge.
      const bend = frame === 'leaf2' ? 0.25 * u * u : 0;
      const vv = v + bend;
      const width = (frame === 'leaf1' ? 0.72 : 0.84) * Math.max(0, 1 - u * u) * (1 - 0.25 * u);
      const d = Math.abs(vv) - width;
      const a = smooth(0.12, -0.12, d);
      const lum = 0.5 + 0.5 * smooth(0.1, -0.5, vv + width * 0.6) - 0.15 * smooth(0.05, 0, Math.abs(vv));
      return [lum, a];
    }
  }
}

/** Generate the shared particle atlas (deterministic). */
export function generateParticleAtlas(seed = 7): ParticleAtlasData {
  const items: (PackItem & { frame: ParticleFrame })[] = PARTICLE_FRAMES.map((frame) => ({ frame, w: SIZES[frame][0], h: SIZES[frame][1] }));
  const width = 256;
  const height = packRects(items, width, 256, GUTTER);
  const h2 = 1 << Math.ceil(Math.log2(height));
  const pixels = new Uint8Array(width * h2 * 4);
  const noise = new NoiseTable(seed, 4, 4);
  const frames = {} as Record<ParticleFrame, FrameRect>;
  for (const it of items) {
    const x0 = it.x as number;
    const y0 = it.y as number;
    frames[it.frame] = { x: x0, y: y0, w: it.w, h: it.h };
    for (let y = 0; y < it.h; y++) {
      for (let x = 0; x < it.w; x++) {
        const u = ((x + 0.5) / it.w) * 2 - 1;
        const v = ((y + 0.5) / it.h) * 2 - 1;
        const [lum, a] = frameTexel(it.frame, u, v, noise, x, y);
        const o = ((y0 + y) * width + x0 + x) * 4;
        const l = Math.round(Math.min(1, Math.max(0, lum)) * 255);
        pixels[o] = l;
        pixels[o + 1] = l;
        pixels[o + 2] = l;
        pixels[o + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
      }
    }
  }
  return { width, height: h2, pixels, frames };
}
