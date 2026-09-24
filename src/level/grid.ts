import type { LevelData, TileKind } from '../contracts/level.ts';
import { todo } from '../core/todo.ts';

/**
 * Tile queries over LevelData.tiles. Out of bounds: tx outside [0, width) → Solid for every ty; else
 * ty < 0 → Solid, ty ≥ height → Empty (ARCHITECTURE.md §2.1). World rect queries use half-open ranges.
 */
export class CollisionGrid {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly tiles: Uint8Array;

  constructor(width: number, height: number, tileSize: number, tiles: Uint8Array) {
    this.width = width;
    this.height = height;
    this.tileSize = tileSize;
    this.tiles = tiles;
    todo('SIM', 'CollisionGrid');
  }

  static fromLevel(level: LevelData): CollisionGrid {
    return new CollisionGrid(level.widthTiles, level.heightTiles, level.tileSize, level.tiles);
  }

  /** Tiles only, using ASCII_TILES from ./ascii.ts (other glyphs → Empty). */
  static fromAscii(rows: readonly string[], tileSize: number): CollisionGrid {
    void rows;
    void tileSize;
    return todo('SIM', 'CollisionGrid.fromAscii');
  }

  get(tx: number, ty: number): TileKind {
    void tx;
    void ty;
    return todo('SIM', 'CollisionGrid.get');
  }

  isSolid(tx: number, ty: number): boolean {
    void tx;
    void ty;
    return todo('SIM', 'CollisionGrid.isSolid');
  }

  /** World coordinate → tile index (floor). */
  toTile(v: number): number {
    return Math.floor(v / this.tileSize);
  }

  /** Does the world rect [minX,maxX)×[minY,maxY) overlap any tile of `kind`? */
  rectHas(minX: number, minY: number, maxX: number, maxY: number, kind: TileKind): boolean {
    void minX; void minY; void maxX; void maxY; void kind;
    return todo('SIM', 'CollisionGrid.rectHas');
  }
}
