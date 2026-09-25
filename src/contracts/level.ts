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
export const AREA_GRADES = ['glade', 'gully', 'rootwell', 'canopy', 'veil', 'shrine'] as const;
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
export interface CrawlerDef {
  id: number;
  kind: 'gloomcrawler';
  /** Spawn feet position. */
  x: number;
  y: number;
  patrolMinX: number;
  patrolMaxX: number;
  speed: number;
}

/**
 * LDtk `Spitter` (pivot 0.5,1, rooted on a floor tile; x, y = feet). Fields:
 * `aim` (enum SpitterAim `Player` | `Fixed`, default Player); for Fixed, `angleDeg` (Float, from +x
 * turning toward screen-up: 90 = straight up, 135 = up-left; default 90) and `speed` (Float u/s,
 * default WorldTuning.spitterDefaultSpeed), which the loader converts to fixedVx/fixedVy (+y down);
 * `range` (Float u, default WorldTuning.spitterDefaultRange), `period` (Int ticks between shots,
 * default WorldTuning.spitterDefaultPeriod), `phase` (Int ticks, default 0) and `flightTicks` (Int,
 * Player aim only: seed flight time to the aim point, default WorldTuning.spitterDefaultFlightTicks).
 */
export interface SpitterDef {
  id: number;
  kind: 'thornSpitter';
  x: number;
  y: number;
  aim: 'player' | 'fixed';
  fixedVx: number;
  fixedVy: number;
  range: number;
  period: number;
  phase: number;
  flightTicks: number;
}

/** LevelData.enemies = every `Enemy` (layer order), then every `Spitter` (layer order); id = array index. */
export type EnemyDef = CrawlerDef | SpitterDef;

/**
 * LDtk `AbilityShrine` (resizable rect; field `ability`: enum Ability `Launch`). Touching the rect
 * unlocks the ability for the rest of the run (§5.3).
 */
export interface AbilityShrineDef extends Rect {
  id: number;
  ability: 'launch';
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
  abilityShrines: AbilityShrineDef[];
  goal: GoalDef | null;
  lightShafts: LightShaftDef[];
  gradeZones: GradeZoneDef[];
  decorHints: DecorHintDef[];
  /** Seed for all procedural placement tied to this level. */
  seed: number;
}
