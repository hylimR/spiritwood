import { TileKind } from '../contracts/level.ts';
import type { CollisionGrid } from '../level/grid.ts';

/** Kinematic AABB positioned by its feet (bottom-centre). Matches PlayerView/EnemyView field names. */
export interface Body {
  x: number;
  y: number;
  readonly width: number;
  readonly height: number;
}

export interface SweepResult {
  /** Distance actually moved (signed). */
  moved: number;
  hit: boolean;
  /** Kind of the first blocking tile, or Empty. */
  hitKind: TileKind;
}

export function createSweepResult(): SweepResult {
  return { moved: 0, hit: false, hitKind: 0 };
}

function setResult(out: SweepResult, moved: number, hitKind: TileKind): SweepResult {
  out.moved = moved;
  out.hit = hitKind !== TileKind.Empty;
  out.hitKind = hitKind;
  return out;
}

/** First tile index of the half-open range [min, max) and its last index, along one axis. */
function firstTile(min: number, t: number): number {
  return Math.floor(min / t);
}

function lastTile(max: number, t: number): number {
  return Math.ceil(max / t) - 1;
}

/**
 * Any tile of `kind` in the inclusive tile range? The probes below pass integer tile ranges rather than
 * world-space doubles, which keeps the per-tick queries free of boxed-number allocations in V8.
 */
function tilesHave(grid: CollisionGrid, tx0: number, ty0: number, tx1: number, ty1: number, kind: TileKind): boolean {
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) if (grid.get(tx, ty) === kind) return true;
  }
  return false;
}

/** Solid kind if any tile of column `tx` in rows [ty0, ty1] is Solid, else Empty. */
function columnBlock(grid: CollisionGrid, tx: number, ty0: number, ty1: number): TileKind {
  for (let ty = ty0; ty <= ty1; ty++) if (grid.get(tx, ty) === TileKind.Solid) return TileKind.Solid;
  return TileKind.Empty;
}

/**
 * Move `body` horizontally by `dx`, stopping flush against the first Solid tile the leading edge
 * crosses (every column between start and end is checked — no tunnelling). A blocked sweep places the
 * leading edge exactly on the tile boundary (t·tileSize). One-way and thorn tiles never block.
 * Mutates body.x and fills `out`.
 */
export function sweepX(grid: CollisionGrid, body: Body, dx: number, out: SweepResult): SweepResult {
  if (dx === 0) return setResult(out, 0, TileKind.Empty);
  const t = grid.tileSize;
  const half = body.width / 2;
  const ty0 = firstTile(body.y - body.height, t);
  const ty1 = lastTile(body.y, t);
  const x0 = body.x;
  if (dx > 0) {
    const edge = x0 + half;
    const last = lastTile(edge + dx, t);
    for (let tx = Math.ceil(edge / t); tx <= last; tx++) {
      if (columnBlock(grid, tx, ty0, ty1) !== TileKind.Empty) {
        body.x = tx * t - half;
        return setResult(out, body.x - x0, TileKind.Solid);
      }
    }
  } else {
    const edge = x0 - half;
    const last = firstTile(edge + dx, t);
    for (let tx = Math.floor(edge / t) - 1; tx >= last; tx--) {
      if (columnBlock(grid, tx, ty0, ty1) !== TileKind.Empty) {
        body.x = (tx + 1) * t + half;
        return setResult(out, body.x - x0, TileKind.Solid);
      }
    }
  }
  body.x = x0 + dx;
  return setResult(out, dx, TileKind.Empty);
}

/**
 * Move `body` vertically by `dy`. Solid tiles block both ways. When `landOnOneWay` is true and moving
 * down, one-way tiles block if the feet were at or above the tile top before the move. Blocked sweeps end
 * exactly on the tile boundary.
 */
export function sweepY(grid: CollisionGrid, body: Body, dy: number, landOnOneWay: boolean, out: SweepResult): SweepResult {
  if (dy === 0) return setResult(out, 0, TileKind.Empty);
  const t = grid.tileSize;
  const half = body.width / 2;
  const tx0 = firstTile(body.x - half, t);
  const tx1 = lastTile(body.x + half, t);
  const y0 = body.y;
  if (dy > 0) {
    const last = lastTile(y0 + dy, t);
    // Rows the feet newly enter all have their top at or below the feet: the one-way rule holds there.
    for (let ty = Math.ceil(y0 / t); ty <= last; ty++) {
      let kind: TileKind = TileKind.Empty;
      for (let tx = tx0; tx <= tx1; tx++) {
        const k = grid.get(tx, ty);
        if (k === TileKind.Solid) {
          kind = TileKind.Solid;
          break;
        }
        if (k === TileKind.OneWay && landOnOneWay) kind = TileKind.OneWay;
      }
      if (kind !== TileKind.Empty) {
        body.y = ty * t;
        return setResult(out, body.y - y0, kind);
      }
    }
  } else {
    const head = y0 - body.height;
    const last = firstTile(head + dy, t);
    for (let ty = Math.floor(head / t) - 1; ty >= last; ty--) {
      for (let tx = tx0; tx <= tx1; tx++) {
        if (grid.get(tx, ty) === TileKind.Solid) {
          body.y = (ty + 1) * t + body.height;
          return setResult(out, body.y - y0, TileKind.Solid);
        }
      }
    }
  }
  body.y = y0 + dy;
  return setResult(out, dy, TileKind.Empty);
}

/** Would `body` offset by (ox, oy) overlap a Solid tile? */
export function overlapsSolid(grid: CollisionGrid, body: Body, ox = 0, oy = 0): boolean {
  const t = grid.tileSize;
  const half = body.width / 2;
  const x = body.x + ox;
  const y = body.y + oy;
  return tilesHave(grid, firstTile(x - half, t), firstTile(y - body.height, t), lastTile(x + half, t), lastTile(y, t), TileKind.Solid);
}

/** Standing on Solid (or OneWay when `includeOneWay`) directly below the feet (1 u probe). */
export function isOnGround(grid: CollisionGrid, body: Body, includeOneWay: boolean): boolean {
  return groundKindUnder(grid, body, includeOneWay) !== TileKind.Empty;
}

/**
 * What the feet stand on within the 1 u probe: Solid if any Solid tile, else OneWay if a one-way
 * tile's top lies in [y, y + 1) (and `includeOneWay`), else Empty.
 */
export function groundKindUnder(grid: CollisionGrid, body: Body, includeOneWay: boolean): TileKind {
  const t = grid.tileSize;
  const half = body.width / 2;
  const y = body.y;
  const tx0 = firstTile(body.x - half, t);
  const tx1 = lastTile(body.x + half, t);
  if (tilesHave(grid, tx0, firstTile(y, t), tx1, lastTile(y + 1, t), TileKind.Solid)) return TileKind.Solid;
  if (!includeOneWay) return TileKind.Empty;
  const ty = Math.ceil(y / t);
  if (ty * t >= y + 1) return TileKind.Empty;
  return tilesHave(grid, tx0, ty, tx1, ty, TileKind.OneWay) ? TileKind.OneWay : TileKind.Empty;
}

/** Solid within `probe` u beside the body on side `dir`. */
export function isTouchingWall(grid: CollisionGrid, body: Body, dir: -1 | 1, probe = 1): boolean {
  const t = grid.tileSize;
  const half = body.width / 2;
  const ty0 = firstTile(body.y - body.height, t);
  const ty1 = lastTile(body.y, t);
  const edge = body.x + dir * half;
  return dir > 0
    ? tilesHave(grid, firstTile(edge, t), ty0, lastTile(edge + probe, t), ty1, TileKind.Solid)
    : tilesHave(grid, firstTile(edge - probe, t), ty0, lastTile(edge, t), ty1, TileKind.Solid);
}

/** Overlaps a Thorns tile after shrinking the body by `inset` on every side. */
export function overlapsThorns(grid: CollisionGrid, body: Body, inset: number): boolean {
  const t = grid.tileSize;
  const half = body.width / 2 - inset;
  const top = body.y - body.height + inset;
  const bottom = body.y - inset;
  if (!(half > 0) || !(bottom > top)) return false;
  return tilesHave(grid, firstTile(body.x - half, t), firstTile(top, t), lastTile(body.x + half, t), lastTile(bottom, t), TileKind.Thorns);
}
