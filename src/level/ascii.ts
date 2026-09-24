import { TILE } from '../config.ts';
import { TileKind, type LevelData } from '../contracts/level.ts';
import { todo } from '../core/todo.ts';

/** Tile glyphs shared by tests, CollisionGrid.fromAscii and tools/level. */
export const ASCII_TILES: Readonly<Record<string, TileKind>> = Object.freeze({
  '#': TileKind.Solid,
  '=': TileKind.OneWay,
  '^': TileKind.Thorns,
});

export interface AsciiLevelOptions {
  id?: string;
  seed?: number;
  tileSize?: number;
}

/**
 * Full LevelData from ASCII rows (for tests and small fixtures). Entity glyphs (tile under them is
 * Empty): `P` playerStart at the tile's bottom-centre; `o` orb at the tile centre, value 1; `C`
 * checkpoint 1×2 tiles whose bottom aligns with the glyph tile's bottom; `E` enemy — a horizontal run
 * of `E` sets the patrol span, feet on the run's bottom edge, speed = default; `G` goal 2×2 tiles whose
 * bottom-left is the glyph tile's bottom-left. Rows may differ in length (padded with Empty).
 */
export function levelFromAscii(rows: readonly string[], opts: AsciiLevelOptions = {}): LevelData {
  void rows;
  void opts;
  void TILE;
  return todo('SIM', 'levelFromAscii');
}
