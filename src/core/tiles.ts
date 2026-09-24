import { TileKind, type LevelData } from '../contracts/level.ts';

/**
 * Tile at (tx, ty) with the ARCHITECTURE §2.1 out-of-bounds rule: tx outside [0, width) → Solid for
 * every ty; else ty < 0 → Solid, ty ≥ height → Empty. The single tile lookup shared by sim and render.
 */
export function tileAt(level: Pick<LevelData, 'widthTiles' | 'heightTiles' | 'tiles'>, tx: number, ty: number): TileKind {
  if (tx < 0 || tx >= level.widthTiles) return TileKind.Solid;
  if (ty < 0) return TileKind.Solid;
  if (ty >= level.heightTiles) return TileKind.Empty;
  return level.tiles[ty * level.widthTiles + tx] as TileKind;
}
