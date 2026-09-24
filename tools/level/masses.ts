/**
 * Dead-mass report (browser-free): how much of a gameplay camera view is solid interior deeper than
 * `deep` tiles from open air, i.e. the part the terrain shader draws as deep interior. A view framed
 * mostly by such a mass reads as a hole, however it is shaded, so the level carves them.
 *
 *   node tools/level/masses.ts [--deep 3] [--top 8] [--ldtk file]
 *
 * Cameras are framed like the settled sim camera (feet + targetOffsetY, clamped to the level) with a
 * 16:9 view, from every tile the player can stand on. Outside the level counts as open air here (the
 * camera never shows it), so a floor band along the bottom edge is measured by its visible thickness.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { VIEW_H } from '../../src/config.ts';
import { TileKind, type LevelData } from '../../src/contracts/level.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { DEFAULT_CAMERA_TUNING } from '../../src/sim/tuning.ts';
import { LDTK_PATH } from './build-level.ts';

export interface MassView {
  /** Feet tile (column, row of the tile top the player stands on). */
  fx: number;
  fy: number;
  /** Share of the view covered by deep interior / by any Solid tile. */
  deep: number;
  solid: number;
}

type Grid = Pick<LevelData, 'widthTiles' | 'heightTiles' | 'tiles' | 'tileSize'>;

function kind(level: Grid, tx: number, ty: number): number {
  if (tx < 0 || ty < 0 || tx >= level.widthTiles || ty >= level.heightTiles) return TileKind.Empty;
  return level.tiles[ty * level.widthTiles + tx] as number;
}

/** Distance (tiles, centre to centre) from each Solid tile to the nearest non-Solid tile, capped at `cap`. */
export function tileDepths(level: Grid, cap = 8): Float32Array {
  const W = level.widthTiles;
  const H = level.heightTiles;
  const out = new Float32Array(W * H);
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      if (kind(level, tx, ty) !== TileKind.Solid) continue;
      let best = cap;
      for (let j = -cap; j <= cap; j++) {
        for (let i = -cap; i <= cap; i++) {
          if (kind(level, tx + i, ty + j) === TileKind.Solid) continue;
          const d = Math.hypot(i, j);
          if (d < best) best = d;
        }
      }
      out[ty * W + tx] = best;
    }
  }
  return out;
}

/** Every standable feet tile's view, worst (most deep interior) first. */
export function massViews(level: Grid, deep = 3, aspect = 16 / 9): MassView[] {
  const W = level.widthTiles;
  const H = level.heightTiles;
  const T = level.tileSize;
  const depths = tileDepths(level, Math.ceil(deep) + 2);
  // Prefix sums over (deep, solid) so each view costs O(1).
  const pd = new Float64Array((W + 1) * (H + 1));
  const ps = new Float64Array((W + 1) * (H + 1));
  for (let ty = 0; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      const s = kind(level, tx, ty) === TileKind.Solid ? 1 : 0;
      const d = s && (depths[ty * W + tx] as number) > deep ? 1 : 0;
      const o = (ty + 1) * (W + 1) + tx + 1;
      pd[o] = d + (pd[o - 1] as number) + (pd[o - W - 1] as number) - (pd[o - W - 2] as number);
      ps[o] = s + (ps[o - 1] as number) + (ps[o - W - 1] as number) - (ps[o - W - 2] as number);
    }
  }
  const sum = (p: Float64Array, x0: number, y0: number, x1: number, y1: number): number =>
    (p[y1 * (W + 1) + x1] as number) - (p[y0 * (W + 1) + x1] as number) - (p[y1 * (W + 1) + x0] as number) + (p[y0 * (W + 1) + x0] as number);
  const viewW = (VIEW_H * aspect) / T;
  const viewH = VIEW_H / T;
  const clamp = (v: number, half: number, size: number): number => (size <= 2 * half ? size / 2 : Math.min(size - half, Math.max(half, v)));
  const views: MassView[] = [];
  const isFloor = (k: number): boolean => k === TileKind.Solid || k === TileKind.OneWay;
  for (let ty = 1; ty < H; ty++) {
    for (let tx = 0; tx < W; tx++) {
      // Feet on the top of tile row `ty`: that tile is a floor, the two above are free of Solid/Thorns.
      if (!isFloor(kind(level, tx, ty))) continue;
      const a = kind(level, tx, ty - 1);
      const b = kind(level, tx, ty - 2);
      if (a === TileKind.Solid || a === TileKind.Thorns || b === TileKind.Solid || b === TileKind.Thorns || ty < 2) continue;
      const cx = clamp(tx + 0.5, viewW / 2, W);
      const cy = clamp(ty + DEFAULT_CAMERA_TUNING.targetOffsetY / T, viewH / 2, H);
      const x0 = Math.max(0, Math.round(cx - viewW / 2));
      const x1 = Math.min(W, Math.round(cx + viewW / 2));
      const y0 = Math.max(0, Math.round(cy - viewH / 2));
      const y1 = Math.min(H, Math.round(cy + viewH / 2));
      const n = (x1 - x0) * (y1 - y0);
      views.push({ fx: tx, fy: ty, deep: sum(pd, x0, y0, x1, y1) / n, solid: sum(ps, x0, y0, x1, y1) / n });
    }
  }
  return views.sort((p, q) => q.deep - p.deep || q.solid - p.solid);
}

function main(argv: readonly string[]): void {
  const opt = (name: string, def: number): number => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? Number(argv[i + 1]) : def;
  };
  const deep = opt('deep', 3);
  const top = opt('top', 8);
  const li = argv.indexOf('--ldtk');
  const level = parseLdtk(JSON.parse(readFileSync(li >= 0 ? (argv[li + 1] as string) : LDTK_PATH, 'utf8')));
  const views = massViews(level, deep);
  console.log(`worst views (deep interior = Solid more than ${deep} tiles from open air):`);
  const shown: MassView[] = [];
  for (const v of views) {
    if (shown.some((s) => Math.abs(s.fx - v.fx) < 12 && Math.abs(s.fy - v.fy) < 8)) continue;
    shown.push(v);
    console.log(`  feet (${v.fx}, ${v.fy}): deep ${(v.deep * 100).toFixed(1)}%, solid ${(v.solid * 100).toFixed(1)}%`);
    if (shown.length >= top) break;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
