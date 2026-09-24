import { Rng } from '../../core/rng.ts';

/**
 * A tileable fbm table (periodic gradient noise, 256 × 256) sampled bilinearly with wrap-around.
 * CPU generators use it instead of evaluating fbm per texel: one table lookup costs a few ns, so a
 * whole atlas can be textured inside the kit's time budget. Values are roughly in [-1, 1].
 */
export const NOISE_SIZE = 256;
const MASK = NOISE_SIZE - 1;

export class NoiseTable {
  readonly data: Float32Array;

  constructor(seed: number, octaves = 5, baseCells = 4) {
    const rng = new Rng(seed);
    const grads = new Float32Array(512);
    for (let i = 0; i < 256; i++) {
      const a = rng.next() * Math.PI * 2;
      grads[i * 2] = Math.cos(a);
      grads[i * 2 + 1] = Math.sin(a);
    }
    const perm = new Uint8Array(256);
    for (let i = 0; i < 256; i++) perm[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng.next() * (i + 1));
      const t = perm[i] as number;
      perm[i] = perm[j] as number;
      perm[j] = t;
    }
    const data = new Float32Array(NOISE_SIZE * NOISE_SIZE);
    let norm = 0;
    for (let o = 0, amp = 1; o < octaves; o++, amp *= 0.5) norm += amp;
    for (let y = 0; y < NOISE_SIZE; y++) {
      for (let x = 0; x < NOISE_SIZE; x++) {
        let sum = 0;
        let amp = 1;
        for (let o = 0; o < octaves; o++) {
          const cells = baseCells << o;
          sum += amp * periodicGradient(x * cells / NOISE_SIZE, y * cells / NOISE_SIZE, cells, perm, grads, o * 31);
          amp *= 0.5;
        }
        data[y * NOISE_SIZE + x] = (sum / norm) * 1.6;
      }
    }
    this.data = data;
  }

  /** Bilinear sample at table coordinates (wraps every NOISE_SIZE units). */
  sample(x: number, y: number): number {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const tx = x - fx;
    const ty = y - fy;
    const x0 = fx & MASK;
    const y0 = fy & MASK;
    const x1 = (x0 + 1) & MASK;
    const y1 = (y0 + 1) & MASK;
    const d = this.data;
    const a = d[y0 * NOISE_SIZE + x0] as number;
    const b = d[y0 * NOISE_SIZE + x1] as number;
    const c = d[y1 * NOISE_SIZE + x0] as number;
    const e = d[y1 * NOISE_SIZE + x1] as number;
    const top = a + (b - a) * tx;
    return top + (c + (e - c) * tx - top) * ty;
  }
}

function periodicGradient(
  x: number, y: number, period: number, perm: Uint8Array, grads: Float32Array, salt: number,
): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = x - xi;
  const fy = y - yi;
  const x0 = xi % period;
  const y0 = yi % period;
  const x1 = (x0 + 1) % period;
  const y1 = (y0 + 1) % period;
  const g = (ix: number, iy: number, dx: number, dy: number): number => {
    const h = (perm[((perm[(ix + salt) & 255] as number) + iy) & 255] as number) * 2;
    return (grads[h] as number) * dx + (grads[h + 1] as number) * dy;
  };
  const u = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const v = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const n00 = g(x0, y0, fx, fy);
  const n10 = g(x1, y0, fx - 1, fy);
  const n01 = g(x0, y1, fx, fy - 1);
  const n11 = g(x1, y1, fx - 1, fy - 1);
  const nx0 = n00 + u * (n10 - n00);
  const nx1 = n01 + u * (n11 - n01);
  return nx0 + v * (nx1 - nx0);
}
