import type { Rect, Vec2 } from './common.ts';

/** IntGrid values of the LDtk `Collision` layer. */
export const TileKind = {
  Empty: 0,
  Solid: 1,
  OneWay: 2,
  Thorns: 3,
} as const;
export type TileKind = (typeof TileKind)[keyof typeof TileKind];

/** Per-area colour grade ids (LDtk enum `AreaGrade`). Grade values live in src/content/grades.ts. */
export const AREA_GRADES = ['glade', 'gully', 'rootwell', 'canopy', 'shrine'] as const;
export type AreaGradeId = (typeof AREA_GRADES)[number];

export interface OrbDef {
  id: number;
  /** Centre. */
  x: number;
  y: number;
  value: number;
}

export interface CheckpointDef extends Rect {
  id: number;
}

/**
 * LDtk `Enemy` (pivot 0.5,1; resizable width = patrol rect): patrolMinX = rect.x + enemyWidth/2,
 * patrolMaxX = rect.x + rect.w − enemyWidth/2, x = pivot x clamped into that range, y = rect bottom,
 * speed = Float field `speed` (default WorldTuning.enemyDefaultSpeed).
 */
export interface EnemyDef {
  id: number;
  kind: 'gloomcrawler';
  /** Spawn feet position. */
  x: number;
  y: number;
  patrolMinX: number;
  patrolMaxX: number;
  speed: number;
}

export interface GoalDef extends Rect {}

/**
 * x, y, w = top aperture; h = vertical length. The bottom edge is centred at x + w/2 + h·tan(angle) and
 * is w·spread wide. LDtk fields: `angleDeg` (Float, loader converts), `spread` (Float, default 1.6),
 * `intensity` (Float 0..1, default 0.6).
 */
export interface LightShaftDef extends Rect {
  id: number;
  /** Radians from vertical; positive leans the bottom to the right. */
  angle: number;
  spread: number;
  intensity: number;
}

export interface GradeZoneDef extends Rect {
  id: number;
  grade: AreaGradeId;
  /** Cross-fade distance in world units outside the rect. */
  blend: number;
}

export interface DecorHintDef {
  id: number;
  kind: 'flora' | 'lantern';
  /** Feet/anchor position. */
  x: number;
  y: number;
}

/**
 * Runtime level: pure data, produced by src/level/loader.ts from LDtk JSON (or levelFromAscii).
 * Entity ids are the 0-based index among instances of that identifier, in layer order.
 * `seed` = LDtk level Int field `seed`, else hashString(level identifier).
 * The LDtk project uses identifierStyle "Free"; enum values match case-insensitively.
 */
export interface LevelData {
  id: string;
  widthTiles: number;
  heightTiles: number;
  tileSize: number;
  pxWidth: number;
  pxHeight: number;
  /** Row-major TileKind values, length widthTiles * heightTiles. */
  tiles: Uint8Array;
  /** Feet position. */
  playerStart: Vec2;
  orbs: OrbDef[];
  checkpoints: CheckpointDef[];
  enemies: EnemyDef[];
  goal: GoalDef | null;
  lightShafts: LightShaftDef[];
  gradeZones: GradeZoneDef[];
  decorHints: DecorHintDef[];
  /** Seed for all procedural placement tied to this level. */
  seed: number;
}
