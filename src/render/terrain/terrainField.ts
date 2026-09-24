import { TileKind, type LevelData } from '../../contracts/level.ts';
import { tileAt } from '../../core/tiles.ts';
import { NoiseTable } from '../gen/noiseTable.ts';

/**
 * Signed distance field of the level's Solid tiles (world units, negative inside): convex corners
 * rounded with `cornerRadius`, concave corners kept sharp, plus fbm edge displacement that is damped
 * on up-facing surfaces so floors stay flat enough for feet. Lookups beyond the level repeat the
 * edge tiles (clamped `tileAt`), so the level border never shows an artificial edge.
 */
export interface TerrainFieldOptions {
  cornerRadius: number;
  /** Max displacement on walls/ceilings and on floors (u). */
  dispAmp: number;
  flatAmp: number;
  /** Noise-table units per world unit. */
  dispFreq: number;
  /** |distance| is clamped to this (u). */
  maxDist: number;
  seed: number;
}

export const DEFAULT_FIELD: TerrainFieldOptions = {
  cornerRadius: 10,
  dispAmp: 4,
  flatAmp: 1.4,
  dispFreq: 0.75,
  maxDist: 96,
  seed: 1,
};

const TL = 1;
const TR = 2;
const BL = 4;
const BR = 8;

export class TerrainField {
  readonly level: Pick<LevelData, 'widthTiles' | 'heightTiles' | 'tiles' | 'tileSize'>;
  readonly opts: TerrainFieldOptions;
  private readonly T: number;
  private readonly w: number;
  private readonly h: number;
  /** Solid flags with a 3-tile clamped border: index (ty + B) * (w + 2B) + tx + B. */
  private readonly solid: Uint8Array;
  private readonly convex: Uint8Array;
  private readonly noise: NoiseTable;
  private readonly R = 2;
  private readonly B = 4;

  constructor(level: Pick<LevelData, 'widthTiles' | 'heightTiles' | 'tiles' | 'tileSize'>, opts: Partial<TerrainFieldOptions> = {}) {
    this.level = level;
    this.opts = { ...DEFAULT_FIELD, ...opts };
    this.T = level.tileSize;
    this.w = level.widthTiles;
    this.h = level.heightTiles;
    const B = this.B;
    const sw = this.w + 2 * B;
    const sh = this.h + 2 * B;
    this.solid = new Uint8Array(sw * sh);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const tx = Math.min(this.w - 1, Math.max(0, x - B));
        const ty = Math.min(this.h - 1, Math.max(0, y - B));
        this.solid[y * sw + x] = tileAt(level, tx, ty) === TileKind.Solid ? 1 : 0;
      }
    }
    this.convex = new Uint8Array(sw * sh);
    for (let y = 1; y < sh - 1; y++) {
      for (let x = 1; x < sw - 1; x++) {
        if (!this.solid[y * sw + x]) continue;
        const l = this.solid[y * sw + x - 1] === 0;
        const r = this.solid[y * sw + x + 1] === 0;
        const u = this.solid[(y - 1) * sw + x] === 0;
        const d = this.solid[(y + 1) * sw + x] === 0;
        this.convex[y * sw + x] = (l && u ? TL : 0) | (r && u ? TR : 0) | (l && d ? BL : 0) | (r && d ? BR : 0);
      }
    }
    this.noise = new NoiseTable(this.opts.seed ^ 0x7e11a1, 4, 4);
  }

  /** Solid flag with clamped lookups (tile coords may be outside the level). */
  isSolid(tx: number, ty: number): boolean {
    return this.solid[this.idx(tx, ty)] === 1;
  }

  private idx(tx: number, ty: number): number {
    const B = this.B;
    const x = Math.min(this.w - 1 + B, Math.max(-B, tx)) + B;
    const y = Math.min(this.h - 1 + B, Math.max(-B, ty)) + B;
    return y * (this.w + 2 * B) + x;
  }

  /** Rounded-corner SDF without displacement. */
  base(x: number, y: number): number {
    const T = this.T;
    const r = this.opts.cornerRadius;
    const maxD = this.opts.maxDist;
    const tx = Math.floor(x / T);
    const ty = Math.floor(y / T);
    const R = this.R;
    const inSolid = this.isSolid(tx, ty);
    let best = maxD;
    let uniform = true;
    for (let j = -R; j <= R; j++) {
      for (let i = -R; i <= R; i++) {
        const s = this.isSolid(tx + i, ty + j);
        if (s === inSolid) continue;
        uniform = false;
        const bx0 = (tx + i) * T;
        const by0 = (ty + j) * T;
        let d: number;
        if (s) {
          // Distance to a (possibly corner-rounded) solid tile from outside.
          const m = this.convex[this.idx(tx + i, ty + j)] as number;
          const cx = bx0 + T / 2;
          const cy = by0 + T / 2;
          const left = x < cx;
          const top = y < cy;
          const rr = m & (top ? (left ? TL : TR) : (left ? BL : BR)) ? r : 0;
          const qx = Math.abs(x - cx) - (T / 2 - rr);
          const qy = Math.abs(y - cy) - (T / 2 - rr);
          const ox = qx > 0 ? qx : 0;
          const oy = qy > 0 ? qy : 0;
          d = Math.sqrt(ox * ox + oy * oy) + Math.min(Math.max(qx, qy), 0) - rr;
        } else {
          // Distance to an empty tile from inside the solid.
          const dx = Math.max(bx0 - x, 0, x - (bx0 + T));
          const dy = Math.max(by0 - y, 0, y - (by0 + T));
          d = Math.sqrt(dx * dx + dy * dy);
        }
        if (d < best) best = d;
      }
    }
    if (uniform) return inSolid ? -maxD : maxD;
    if (!inSolid) return best;
    let v = -best;
    // Convex corners of the containing tile carve a rounded sliver out of it.
    const m = this.convex[this.idx(tx, ty)] as number;
    if (m) {
      const x0 = tx * T;
      const y0 = ty * T;
      v = Math.max(v, corner(m & TL, x - x0, y - y0, r));
      v = Math.max(v, corner(m & TR, x0 + T - x, y - y0, r));
      v = Math.max(v, corner(m & BL, x - x0, y0 + T - y, r));
      v = Math.max(v, corner(m & BR, x0 + T - x, y0 + T - y, r));
    }
    return v;
  }

  /** Final field: rounded SDF + displacement (damped on floors). */
  sample(x: number, y: number): number {
    const d = this.base(x, y);
    const band = this.opts.dispAmp * 3;
    if (d > band || d < -band) return d;
    // Up-facing factor from the vertical gradient: floors have ∂d/∂y ≈ −1.
    const g = (this.base(x, y + 2) - this.base(x, y - 2)) * 0.25;
    const up = Math.min(1, Math.max(0, (-g - 0.5) / 0.4));
    const amp = this.opts.dispAmp + (this.opts.flatAmp - this.opts.dispAmp) * up * up * (3 - 2 * up);
    const f = this.opts.dispFreq;
    const n = this.noise.sample(x * f, y * f) * 0.8 + this.noise.sample(x * f * 2.7 + 50, y * f * 2.7 + 20) * 0.2;
    return d + n * amp;
  }
}

/** Rounded quadrant corner: a, b = depth into the tile from the two exposed edges (active only near the corner). */
function corner(active: number, a: number, b: number, r: number): number {
  if (!active || a >= r || b >= r || a < 0 || b < 0) return -Infinity;
  const qx = r - a;
  const qy = r - b;
  return Math.sqrt(qx * qx + qy * qy) - r;
}
