import type { TileKind } from '../contracts/level.ts';
import { todo } from '../core/todo.ts';
import type { CollisionGrid } from '../level/grid.ts';

/** Kinematic AABB positioned by its feet (bottom-centre). */
export interface Body {
  x: number;
  y: number;
  w: number;
  h: number;
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

/**
 * Move `body` horizontally by `dx`, stopping flush against the first Solid tile the leading edge
 * crosses (every column between start and end is checked — no tunnelling). One-way tiles never block
 * horizontally. Mutates body.x and fills `out`.
 */
export function sweepX(grid: CollisionGrid, body: Body, dx: number, out: SweepResult): SweepResult {
  void grid; void body; void dx; void out;
  return todo('SIM', 'sweepX');
}

/**
 * Move `body` vertically by `dy`. Solid tiles block both ways. When `landOnOneWay` is true and moving
 * down, one-way tiles block if the feet were at or above the tile top before the move.
 */
export function sweepY(grid: CollisionGrid, body: Body, dy: number, landOnOneWay: boolean, out: SweepResult): SweepResult {
  void grid; void body; void dy; void landOnOneWay; void out;
  return todo('SIM', 'sweepY');
}

/** Would `body` offset by (ox, oy) overlap a Solid tile? */
export function overlapsSolid(grid: CollisionGrid, body: Body, ox = 0, oy = 0): boolean {
  void grid; void body; void ox; void oy;
  return todo('SIM', 'overlapsSolid');
}

/** Standing on Solid (or OneWay when `includeOneWay`) directly below the feet (1 u probe). */
export function isOnGround(grid: CollisionGrid, body: Body, includeOneWay: boolean): boolean {
  void grid; void body; void includeOneWay;
  return todo('SIM', 'isOnGround');
}

/** Solid directly beside the body on side `dir` (1 u probe). */
export function isTouchingWall(grid: CollisionGrid, body: Body, dir: -1 | 1): boolean {
  void grid; void body; void dir;
  return todo('SIM', 'isTouchingWall');
}

/** Overlaps a Thorns tile after shrinking the body by `inset` on every side. */
export function overlapsThorns(grid: CollisionGrid, body: Body, inset: number): boolean {
  void grid; void body; void inset;
  return todo('SIM', 'overlapsThorns');
}
