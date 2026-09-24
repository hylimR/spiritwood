import { Rng } from '../../core/rng.ts';

/**
 * Seeded 2D gradient noise (Perlin-style, quintic fade) with fbm/ridged helpers.
 * Output of `noise2` is roughly in [-1, 1]. Pure and allocation-free after construction.
 */
export class Noise {
  private readonly perm: Uint8Array;
  private readonly gx: Float32Array;
  private readonly gy: Float32Array;

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = p[i] as number;
      p[i] = p[j] as number;
      p[j] = t;
    }
    this.perm = new Uint8Array(512);
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255] as number;
    this.gx = new Float32Array(256);
    this.gy = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const a = rng.next() * Math.PI * 2;
      this.gx[i] = Math.cos(a);
      this.gy[i] = Math.sin(a);
    }
  }

  noise2(x: number, y: number): number {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = x - x0;
    const fy = y - y0;
    const xi = x0 & 255;
    const yi = y0 & 255;
    const perm = this.perm;
    const h00 = perm[(perm[xi] as number) + yi] as number;
    const h10 = perm[(perm[xi + 1] as number) + yi] as number;
    const h01 = perm[(perm[xi] as number) + yi + 1] as number;
    const h11 = perm[(perm[xi + 1] as number) + yi + 1] as number;
    const gx = this.gx;
    const gy = this.gy;
    const n00 = (gx[h00] as number) * fx + (gy[h00] as number) * fy;
    const n10 = (gx[h10] as number) * (fx - 1) + (gy[h10] as number) * fy;
    const n01 = (gx[h01] as number) * fx + (gy[h01] as number) * (fy - 1);
    const n11 = (gx[h11] as number) * (fx - 1) + (gy[h11] as number) * (fy - 1);
    const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
    const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
    const nx0 = n00 + u * (n10 - n00);
    const nx1 = n01 + u * (n11 - n01);
    return (nx0 + v * (nx1 - nx0)) * 1.4142135;
  }

  /** 1D noise along x (a slice of the 2D field). */
  noise1(x: number): number {
    return this.noise2(x, 0.5);
  }

  /** Fractal sum, normalised to about [-1, 1]. */
  fbm(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 1;
    let norm = 0;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise2(x * f + i * 17.13, y * f - i * 9.71);
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal in [0, 1] — veins, bark, cracks. */
  ridged(x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
    let sum = 0;
    let amp = 0.5;
    let norm = 0;
    let f = 1;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise2(x * f + i * 31.7, y * f + i * 11.3));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }
}
