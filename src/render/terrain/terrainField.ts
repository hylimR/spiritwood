import { TileKind, type LevelData } from '../../contracts/level.ts';
import { tileAt } from '../../core/tiles.ts';
import { NoiseTable } from '../gen/noiseTable.ts';

/**
 * Signed distance field of the level's Solid tiles (world units, negative inside). Convex corners are
 * rounded with a per-corner radius (modest on top corners so walkable tops stay flat almost to the
 * edge, generous and irregular underneath); concave corners stay sharp. Displacement depends on the
 * facing: floors barely move (feet), walls stay within a few units (hands), and undersides — which
 * the player only bonks — get slow lumps and pendant drips. Lookups beyond the level repeat the edge
 * tiles (clamped `tileAt`), so the level border never shows an artificial edge.
 */
export interface TerrainFieldOptions {
  /** Top convex corner radius range (u) and bottom convex corner radius range (u, ≤ tile/2). */
  cornerRadius: number;
  cornerJitter: number;
  underRadius: number;
  underJitter: number;
  /** Max displacement on walls and on floors (u). */
  dispAmp: number;
  flatAmp: number;
  /** Undersides: lump amplitude and the length of pendant drips (u). */
  underAmp: number;
  dripLen: number;
  /** Noise-table units per world unit. */
  dispFreq: number;
  /** |distance| is clamped to this (u). */
  maxDist: number;
  seed: number;
}

export const DEFAULT_FIELD: TerrainFieldOptions = {
  cornerRadius: 10,
  cornerJitter: 3,
  underRadius: 16,
  underJitter: 8,
  dispAmp: 3.5,
  flatAmp: 1.2,
  underAmp: 9,
  dripLen: 30,
  dispFreq: 0.75,
  maxDist: 96,
  seed: 1,
};

/** Walkable tops stay within this many units of the collision surface away from convex corners (tested). */
export const FLOOR_TOLERANCE = 2;
/** Walls stay within this many units of the collision surface (tested). */
export const WALL_TOLERANCE = 4;

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

  /** Any solid tile in the columns around x, between `reach` above y and y itself. */
  private solidAbove(x: number, y: number, reach: number): boolean {
    const T = this.T;
    const tx = Math.floor(x / T);
    const ty1 = Math.floor(y / T);
    for (let ty = Math.floor((y - reach) / T); ty <= ty1; ty++) {
      if (this.isSolid(tx - 1, ty) || this.isSolid(tx, ty) || this.isSolid(tx + 1, ty)) return true;
    }
    return false;
  }

  /** Pendant drips under ceilings: sparse pointed bumps on a hashed cell grid (u below the collision). */
  drip(x: number): number {
    const W = DRIP_CELL;
    const c = Math.floor(x / W);
    let best = 0;
    for (let i = c - 1; i <= c + 1; i++) {
      const h1 = hash01(i, 11, this.opts.seed);
      if (h1 < 0.3) continue;
      const cx = (i + 0.2 + 0.6 * hash01(i, 23, this.opts.seed)) * W;
      const half = 13 + 12 * hash01(i, 37, this.opts.seed);
      const t = 1 - Math.abs(x - cx) / half;
      if (t <= 0) continue;
      const len = this.opts.dripLen * (0.35 + 0.65 * hash01(i, 51, this.opts.seed));
      const v = len * Math.pow(t, 1.6);
      if (v > best) best = v;
    }
    return best;
  }

  /** Radius of convex corner `bit` (TL 1, TR 2, BL 4, BR 8) of tile (tx, ty): hash-varied per corner. */
  cornerRadiusAt(tx: number, ty: number, bit: number): number {
    let h = Math.imul(tx * 73856093 ^ ty * 19349663 ^ bit * 83492791 ^ this.opts.seed, 0x5bd1e995);
    h ^= h >>> 15;
    h = Math.imul(h, 0x27d4eb2d);
    h ^= h >>> 13;
    const u = (h >>> 0) / 4294967296;
    const o = this.opts;
    return bit === TL || bit === TR ? o.cornerRadius + o.cornerJitter * u : Math.min(this.T / 2, o.underRadius + o.underJitter * u);
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
          const bit = top ? (left ? TL : TR) : (left ? BL : BR);
          const rr = m & bit ? this.cornerRadiusAt(tx + i, ty + j, bit) : 0;
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
      if (m & TL) v = Math.max(v, corner(1, x - x0, y - y0, this.cornerRadiusAt(tx, ty, TL)));
      if (m & TR) v = Math.max(v, corner(1, x0 + T - x, y - y0, this.cornerRadiusAt(tx, ty, TR)));
      if (m & BL) v = Math.max(v, corner(1, x - x0, y0 + T - y, this.cornerRadiusAt(tx, ty, BL)));
      if (m & BR) v = Math.max(v, corner(1, x0 + T - x, y0 + T - y, this.cornerRadiusAt(tx, ty, BR)));
    }
    return v;
  }

  /** Final field: rounded SDF + facing-dependent displacement (see the class comment). */
  sample(x: number, y: number): number {
    const d = this.base(x, y);
    const o = this.opts;
    const band = o.dripLen + o.underAmp + 4;
    if (d > band || d < -band) return d;
    // Beyond the wall/floor displacement only undersides can pull the surface out this far, and they
    // need a surface above: with no solid tile above-ish within the band the result stays positive.
    if (d > o.dispAmp + 2 && !this.solidAbove(x, y, band)) return d;
    // Facing from the vertical gradient: floors have ∂d/∂y ≈ −1, undersides ≈ +1.
    const g = (this.base(x, y + 2) - this.base(x, y - 2)) * 0.25;
    const up = smooth01((-g - 0.5) / 0.4);
    const down = smooth01((g - 0.35) / 0.45);
    const f = o.dispFreq;
    // The table's fbm has an RMS of ~0.2: NORM brings typical values to ±1 (then clamped, keeping bounds).
    const nz = (this.noise.sample(x * f, y * f) * 0.8 + this.noise.sample(x * f * 2.7 + 50, y * f * 2.7 + 20) * 0.2) * NORM;
    const n = nz < -1 ? -1 : nz > 1 ? 1 : nz;
    let v = d + n * (o.dispAmp + (o.flatAmp - o.dispAmp) * up);
    if (down > 0) {
      // Undersides: lumps both ways, plus pendant drips that hang below the collision.
      const l = this.noise.sample(x * 0.6 + 90, y * 0.6 + 40) * NORM;
      const lump = l < -1 ? -1 : l > 1 ? 1 : l;
      v += down * (lump * o.underAmp - this.drip(x));
    }
    return v;
  }
}

/** Scales the noise table (RMS ≈ 0.2) to about ±1. */
const NORM = 2.2;
/** Drip cell width (u): at most one drip per cell. */
const DRIP_CELL = 76;

function hash01(i: number, salt: number, seed: number): number {
  let h = Math.imul(i * 374761393 ^ salt * 668265263 ^ seed, 0x5bd1e995);
  h ^= h >>> 15;
  h = Math.imul(h, 0x27d4eb2d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function smooth01(t: number): number {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
}

/** Rounded quadrant corner: a, b = depth into the tile from the two exposed edges (active only near the corner). */
function corner(active: number, a: number, b: number, r: number): number {
  if (!active || a >= r || b >= r || a < 0 || b < 0) return -Infinity;
  const qx = r - a;
  const qy = r - b;
  return Math.sqrt(qx * qx + qy * qy) - r;
}
