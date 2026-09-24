import { TileKind, type LevelData } from '../contracts/level.ts';
import { tileAt } from '../core/tiles.ts';
import { levelFromAscii } from './ascii.ts';

/**
 * Tile queries over LevelData.tiles. Out of bounds: tx outside [0, width) → Solid for every ty; else
 * ty < 0 → Solid, ty ≥ height → Empty (ARCHITECTURE.md §2.1). World rect queries use half-open ranges.
 */
export class CollisionGrid {
  readonly width: number;
  readonly height: number;
  readonly tileSize: number;
  readonly tiles: Uint8Array;
  /** tileAt's view of this grid (LevelData field names). */
  private readonly lookup: Pick<LevelData, 'widthTiles' | 'heightTiles' | 'tiles'>;

  constructor(width: number, height: number, tileSize: number, tiles: Uint8Array) {
    if (tiles.length !== width * height) {
      throw new RangeError(`CollisionGrid: ${tiles.length} tiles for a ${width}×${height} grid`);
    }
    this.width = width;
    this.height = height;
    this.tileSize = tileSize;
    this.tiles = tiles;
    this.lookup = { widthTiles: width, heightTiles: height, tiles };
  }

  static fromLevel(level: LevelData): CollisionGrid {
    return new CollisionGrid(level.widthTiles, level.heightTiles, level.tileSize, level.tiles);
  }

  /** Tiles only, via levelFromAscii from ./ascii.ts (entity glyphs → Empty). */
  static fromAscii(rows: readonly string[], tileSize: number): CollisionGrid {
    return CollisionGrid.fromLevel(levelFromAscii(rows, { tileSize }));
  }

  get(tx: number, ty: number): TileKind {
    return tileAt(this.lookup, tx, ty);
  }

  isSolid(tx: number, ty: number): boolean {
    return tileAt(this.lookup, tx, ty) === TileKind.Solid;
  }

  /** World coordinate → tile index (floor). */
  toTile(v: number): number {
    return Math.floor(v / this.tileSize);
  }

  /** Does the world rect [minX,maxX)×[minY,maxY) overlap any tile of `kind`? */
  rectHas(minX: number, minY: number, maxX: number, maxY: number, kind: TileKind): boolean {
    if (!(maxX > minX) || !(maxY > minY)) return false;
    const t = this.tileSize;
    const tx1 = Math.ceil(maxX / t) - 1;
    const ty1 = Math.ceil(maxY / t) - 1;
    for (let ty = Math.floor(minY / t); ty <= ty1; ty++) {
      for (let tx = Math.floor(minX / t); tx <= tx1; tx++) {
        if (tileAt(this.lookup, tx, ty) === kind) return true;
      }
    }
    return false;
  }
}
