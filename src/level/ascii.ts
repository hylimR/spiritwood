import { TILE } from '../config.ts';
import { TileKind, type LevelData } from '../contracts/level.ts';
import { hashString } from '../core/rng.ts';
import { DEFAULT_WORLD_TUNING } from '../sim/tuning.ts';

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
 * Full LevelData from ASCII rows (tests and small fixtures). Entity glyphs (the tile under them is
 * Empty): `P` playerStart at the tile's bottom-centre; `o` orb at the tile centre, value 1; `C`
 * checkpoint 1×2 tiles whose bottom aligns with the glyph tile's bottom; `E` enemy — a horizontal run
 * of `E` is the patrol rect (EnemyDef rules), feet on the run's bottom edge; `G` goal 2×2 tiles whose
 * bottom-left is the first `G` tile's bottom-left. Rows may differ in length (padded with Empty).
 * Without `P`, the player starts at the top-left tile.
 */
export function levelFromAscii(rows: readonly string[], opts: AsciiLevelOptions = {}): LevelData {
  const T = opts.tileSize ?? TILE;
  const id = opts.id ?? 'ascii';
  const heightTiles = rows.length;
  let widthTiles = 0;
  for (const r of rows) widthTiles = Math.max(widthTiles, r.length);
  const tiles = new Uint8Array(widthTiles * heightTiles);
  const level: LevelData = {
    id,
    widthTiles,
    heightTiles,
    tileSize: T,
    pxWidth: widthTiles * T,
    pxHeight: heightTiles * T,
    tiles,
    playerStart: { x: T / 2, y: T },
    orbs: [],
    checkpoints: [],
    enemies: [],
    goal: null,
    lightShafts: [],
    gradeZones: [],
    decorHints: [],
    seed: opts.seed ?? hashString(id),
  };
  const halfEnemy = DEFAULT_WORLD_TUNING.enemyWidth / 2;
  for (let ty = 0; ty < heightTiles; ty++) {
    const row = rows[ty] as string;
    for (let tx = 0; tx < row.length; tx++) {
      const ch = row[tx] as string;
      const kind = ASCII_TILES[ch];
      if (kind !== undefined) {
        tiles[ty * widthTiles + tx] = kind;
        continue;
      }
      const bottom = (ty + 1) * T;
      switch (ch) {
        case 'P':
          level.playerStart = { x: tx * T + T / 2, y: bottom };
          break;
        case 'o':
          level.orbs.push({ id: level.orbs.length, x: tx * T + T / 2, y: ty * T + T / 2, value: 1 });
          break;
        case 'C':
          level.checkpoints.push({ id: level.checkpoints.length, x: tx * T, y: bottom - 2 * T, w: T, h: 2 * T });
          break;
        case 'G':
          if (!level.goal) level.goal = { x: tx * T, y: bottom - 2 * T, w: 2 * T, h: 2 * T };
          break;
        case 'E': {
          if (tx > 0 && row[tx - 1] === 'E') break;
          let end = tx;
          while (row[end + 1] === 'E') end++;
          const x0 = tx * T;
          const w = (end - tx + 1) * T;
          const centre = x0 + w / 2;
          const min = Math.min(x0 + halfEnemy, centre);
          const max = Math.max(x0 + w - halfEnemy, centre);
          level.enemies.push({
            id: level.enemies.length,
            kind: 'gloomcrawler',
            x: centre,
            y: bottom,
            patrolMinX: min,
            patrolMaxX: max,
            speed: DEFAULT_WORLD_TUNING.enemyDefaultSpeed,
          });
          break;
        }
        default:
          break;
      }
    }
  }
  return level;
}
