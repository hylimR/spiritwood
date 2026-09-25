import { PALETTE, TILE } from '../../src/config.ts';
import { AREA_GRADES, TileKind, type LevelData, type SpitterDef } from '../../src/contracts/level.ts';
import { hashString } from '../../src/core/rng.ts';
import {
  LDTK_ABILITY, LDTK_COLLISION_LAYER, LDTK_DEFAULTS, LDTK_ENTITY, LDTK_SPITTER_AIM, spitterVelocity,
} from '../../src/level/loader.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';

/**
 * LevelData → a complete LDtk 1.5.3 project (one level, an Entities layer and the Collision IntGrid)
 * that the LDtk editor opens without repair. Every structure mirrors what LDtk 1.5.3 itself writes;
 * iids are deterministic UUID-v4-shaped hashes, so the same input always gives the same bytes.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type JsonObject = { [key: string]: Json };

const APP_VERSION = '1.5.3';
const APP_BUILD_ID = 473702;
/** Entities snap to half a collision cell in the editor (orb centres, feet on cell centres). */
const ENTITY_GRID = 24;

const UID = {
  enumAreaGrade: 1,
  layerEntities: 2,
  layerCollision: 3,
  PlayerStart: 10,
  Orb: 11,
  Checkpoint: 12,
  Enemy: 13,
  Goal: 14,
  LightShaft: 15,
  GradeZone: 16,
  Lantern: 17,
  Flora: 18,
  fieldOrbValue: 20,
  fieldEnemySpeed: 21,
  fieldShaftAngle: 22,
  fieldShaftSpread: 23,
  fieldShaftIntensity: 24,
  fieldZoneGrade: 25,
  fieldZoneBlend: 26,
  fieldLevelSeed: 30,
  level: 40,
  enumSpitterAim: 41,
  enumAbility: 42,
  Spitter: 43,
  AbilityShrine: 44,
  fieldSpitterAim: 45,
  fieldSpitterAngle: 46,
  fieldSpitterSpeed: 47,
  fieldSpitterRange: 48,
  fieldSpitterPeriod: 49,
  fieldSpitterPhase: 50,
  fieldSpitterFlight: 51,
  fieldShrineAbility: 52,
} as const;
const NEXT_UID = 53;

const GRADE_COLORS: Readonly<Record<string, number>> = {
  glade: PALETTE.floraGlow,
  gully: PALETTE.thorns,
  rootwell: PALETTE.fogFar,
  canopy: PALETTE.spiritGlow,
  veil: PALETTE.skyHorizon,
  shrine: PALETTE.warmAccent,
};

/** The project's LDtk enums: identifier, uid and value ids (with editor colours). */
interface EnumSpec {
  identifier: string;
  uid: number;
  values: readonly { id: string; color: number }[];
}

const ENUMS = {
  AreaGrade: {
    identifier: 'AreaGrade', uid: UID.enumAreaGrade, values: AREA_GRADES.map((g) => ({ id: g, color: GRADE_COLORS[g] ?? 0 })),
  },
  SpitterAim: {
    identifier: 'SpitterAim', uid: UID.enumSpitterAim,
    values: [{ id: 'Player', color: PALETTE.thorns }, { id: 'Fixed', color: PALETTE.warmAccent }],
  },
  Ability: { identifier: 'Ability', uid: UID.enumAbility, values: [{ id: 'Launch', color: PALETTE.spiritGlow }] },
} as const satisfies Record<string, EnumSpec>;

/** The LDtk enum id of a LevelData enum value (`LDTK_SPITTER_AIM` / `LDTK_ABILITY` inverted). */
function enumId(table: Readonly<Record<string, string>>, value: string): string {
  for (const id of Object.keys(table)) if (table[id] === value) return id;
  throw new Error(`no LDtk enum value for "${value}"`);
}

function hex(color: number): string {
  return `#${color.toString(16).padStart(6, '0').toUpperCase()}`;
}

/** Deterministic UUID-v4-shaped id for `key`. */
export function iidFor(key: string): string {
  let h = '';
  for (let i = 0; i < 4; i++) h += hashString(`spiritwood:${i}:${key}`).toString(16).padStart(8, '0');
  const variant = ((parseInt(h[16] as string, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type FieldKind = 'Int' | 'Float' | 'Enum';

interface FieldSpec {
  identifier: string;
  uid: number;
  kind: FieldKind;
  /** The enum of an Enum field. */
  enum?: EnumSpec;
  doc: string;
  /** null = no default (an Enum field without a default can be null). */
  defaultValue: number | string | null;
  min?: number;
  max?: number;
}

function fieldTypes(f: FieldSpec): { __type: string; type: string } {
  if (f.kind === 'Int') return { __type: 'Int', type: 'F_Int' };
  if (f.kind === 'Float') return { __type: 'Float', type: 'F_Float' };
  const e = f.enum;
  if (!e) throw new Error(`enum field ${f.identifier} names no enum`);
  return { __type: `LocalEnum.${e.identifier}`, type: `F_Enum(${e.uid})` };
}

function editorValue(kind: FieldKind, value: number | string): JsonObject {
  if (kind === 'Enum') return { id: 'V_String', params: [value] };
  return { id: kind === 'Int' ? 'V_Int' : 'V_Float', params: [value] };
}

function fieldDef(f: FieldSpec): JsonObject {
  const t = fieldTypes(f);
  return {
    identifier: f.identifier,
    doc: f.doc,
    __type: t.__type,
    uid: f.uid,
    type: t.type,
    isArray: false,
    canBeNull: f.kind === 'Enum' && f.defaultValue === null,
    arrayMinLength: null,
    arrayMaxLength: null,
    editorDisplayMode: 'NameAndValue',
    editorDisplayScale: 1,
    editorDisplayPos: 'Above',
    editorLinkStyle: 'StraightArrow',
    editorDisplayColor: null,
    editorAlwaysShow: false,
    editorShowInWorld: true,
    editorCutLongValues: true,
    editorTextSuffix: null,
    editorTextPrefix: null,
    useForSmartColor: false,
    exportToToc: false,
    searchable: false,
    min: f.min ?? null,
    max: f.max ?? null,
    regex: null,
    acceptFileTypes: null,
    defaultOverride: f.defaultValue === null ? null : editorValue(f.kind, f.defaultValue),
    textLanguageMode: null,
    symmetricalRef: false,
    autoChainRef: false,
    allowOutOfLevelRef: true,
    allowedRefs: 'OnlySame',
    allowedRefsEntityUid: null,
    allowedRefTags: [],
    tilesetUid: null,
  };
}

function fieldInstance(f: FieldSpec, value: number | string): JsonObject {
  return {
    __identifier: f.identifier,
    __type: fieldTypes(f).__type,
    __value: value,
    __tile: null,
    defUid: f.uid,
    realEditorValues: [editorValue(f.kind, value)],
  };
}

const FIELDS = {
  orbValue: { identifier: 'value', uid: UID.fieldOrbValue, kind: 'Int', doc: 'Orbs this pickup counts for.', defaultValue: LDTK_DEFAULTS.orbValue, min: 1 },
  enemySpeed: {
    identifier: 'speed', uid: UID.fieldEnemySpeed, kind: 'Float', doc: 'Patrol speed (px/s). The entity width is the patrol span.',
    defaultValue: DEFAULT_WORLD_TUNING.enemyDefaultSpeed, min: 0,
  },
  shaftAngle: {
    identifier: 'angleDeg', uid: UID.fieldShaftAngle, kind: 'Float', doc: 'Lean from vertical in degrees; positive leans the bottom right.',
    defaultValue: LDTK_DEFAULTS.shaftAngleDeg, min: -60, max: 60,
  },
  shaftSpread: {
    identifier: 'spread', uid: UID.fieldShaftSpread, kind: 'Float', doc: 'Bottom width as a multiple of the top aperture.',
    defaultValue: LDTK_DEFAULTS.shaftSpread, min: 0.1,
  },
  shaftIntensity: {
    identifier: 'intensity', uid: UID.fieldShaftIntensity, kind: 'Float', doc: 'Brightness 0..1.',
    defaultValue: LDTK_DEFAULTS.shaftIntensity, min: 0, max: 1,
  },
  zoneGrade: {
    identifier: 'grade', uid: UID.fieldZoneGrade, kind: 'Enum', enum: ENUMS.AreaGrade, doc: 'Colour grade of this area.', defaultValue: null,
  },
  zoneBlend: {
    identifier: 'blend', uid: UID.fieldZoneBlend, kind: 'Int', doc: 'Cross-fade distance outside the rect (px).',
    defaultValue: LDTK_DEFAULTS.gradeBlendCells * TILE, min: 0,
  },
  levelSeed: { identifier: 'seed', uid: UID.fieldLevelSeed, kind: 'Int', doc: 'Seed for procedural placement tied to this level.', defaultValue: 0 },
  spitterAim: {
    identifier: 'aim', uid: UID.fieldSpitterAim, kind: 'Enum', enum: ENUMS.SpitterAim,
    doc: 'Player: a ballistic shot onto the player (fires only on screen, with line of sight). Fixed: angleDeg and speed.',
    defaultValue: enumId(LDTK_SPITTER_AIM, LDTK_DEFAULTS.spitterAim),
  },
  spitterAngle: {
    identifier: 'angleDeg', uid: UID.fieldSpitterAngle, kind: 'Float',
    doc: 'Fixed aim: degrees from +x turning toward screen-up (90 = straight up, 135 = up-left).',
    defaultValue: LDTK_DEFAULTS.spitterAngleDeg, min: -180, max: 180,
  },
  spitterSpeed: {
    identifier: 'speed', uid: UID.fieldSpitterSpeed, kind: 'Float', doc: 'Fixed aim: seed launch speed (px/s).',
    defaultValue: DEFAULT_WORLD_TUNING.spitterDefaultSpeed, min: 0, max: DEFAULT_WORLD_TUNING.seedMaxSpeed,
  },
  spitterRange: {
    identifier: 'range', uid: UID.fieldSpitterRange, kind: 'Float', doc: 'Active while the player centre is this close to the muzzle (px).',
    defaultValue: DEFAULT_WORLD_TUNING.spitterDefaultRange, min: 0,
  },
  spitterPeriod: {
    identifier: 'period', uid: UID.fieldSpitterPeriod, kind: 'Int', doc: 'Ticks between shots (60 per second).',
    defaultValue: DEFAULT_WORLD_TUNING.spitterDefaultPeriod, min: 1,
  },
  spitterPhase: {
    identifier: 'phase', uid: UID.fieldSpitterPhase, kind: 'Int', doc: 'Ticks of cooldown before the first windup on activation (mod period).',
    defaultValue: LDTK_DEFAULTS.spitterPhase,
  },
  spitterFlight: {
    identifier: 'flightTicks', uid: UID.fieldSpitterFlight, kind: 'Int', doc: 'Player aim: seed flight time to the aim point (ticks).',
    defaultValue: DEFAULT_WORLD_TUNING.spitterDefaultFlightTicks, min: 1,
  },
  shrineAbility: {
    identifier: 'ability', uid: UID.fieldShrineAbility, kind: 'Enum', enum: ENUMS.Ability, doc: 'The ability touching the shrine unlocks.',
    defaultValue: enumId(LDTK_ABILITY, LDTK_DEFAULTS.ability),
  },
} as const satisfies Record<string, FieldSpec>;

interface EntitySpec {
  identifier: string;
  uid: number;
  width: number;
  height: number;
  resizableX: boolean;
  resizableY: boolean;
  pivotX: number;
  pivotY: number;
  color: number;
  renderMode: 'Rectangle' | 'Ellipse' | 'Cross';
  hollow: boolean;
  maxCount: number;
  doc: string;
  fields: readonly FieldSpec[];
}

const ENTITIES: readonly EntitySpec[] = [
  {
    identifier: LDTK_ENTITY.PlayerStart, uid: UID.PlayerStart, width: DEFAULT_TUNING.width, height: DEFAULT_TUNING.height,
    resizableX: false, resizableY: false, pivotX: 0.5, pivotY: 1, color: PALETTE.spiritGlow, renderMode: 'Rectangle',
    hollow: false, maxCount: 1, doc: 'Player spawn (feet).', fields: [],
  },
  {
    identifier: LDTK_ENTITY.Orb, uid: UID.Orb, width: 24, height: 24, resizableX: false, resizableY: false, pivotX: 0.5,
    pivotY: 0.5, color: PALETTE.spiritGlow, renderMode: 'Ellipse', hollow: false, maxCount: 0, doc: 'Spirit orb (centre).',
    fields: [FIELDS.orbValue],
  },
  {
    identifier: LDTK_ENTITY.Checkpoint, uid: UID.Checkpoint, width: 48, height: 96, resizableX: true, resizableY: true,
    pivotX: 0, pivotY: 0, color: PALETTE.floraGlow, renderMode: 'Rectangle', hollow: true, maxCount: 0,
    doc: 'Touch to activate; respawn at the bottom-centre.', fields: [],
  },
  {
    identifier: LDTK_ENTITY.Enemy, uid: UID.Enemy, width: 480, height: DEFAULT_WORLD_TUNING.enemyHeight, resizableX: true,
    resizableY: false, pivotX: 0.5, pivotY: 1, color: PALETTE.thorns, renderMode: 'Rectangle', hollow: true, maxCount: 0,
    doc: 'Gloomcrawler. Width = patrol span; spawns at the centre, feet on the bottom edge.', fields: [FIELDS.enemySpeed],
  },
  {
    identifier: LDTK_ENTITY.Goal, uid: UID.Goal, width: 144, height: 192, resizableX: true, resizableY: true, pivotX: 0,
    pivotY: 0, color: PALETTE.warmAccent, renderMode: 'Rectangle', hollow: false, maxCount: 1, doc: 'Moonwell shrine.',
    fields: [],
  },
  {
    identifier: LDTK_ENTITY.LightShaft, uid: UID.LightShaft, width: 144, height: 480, resizableX: true, resizableY: true,
    pivotX: 0, pivotY: 0, color: PALETTE.moonlight, renderMode: 'Rectangle', hollow: true, maxCount: 0,
    doc: 'Top aperture (x, y, width) and vertical length (height).',
    fields: [FIELDS.shaftAngle, FIELDS.shaftSpread, FIELDS.shaftIntensity],
  },
  {
    identifier: LDTK_ENTITY.GradeZone, uid: UID.GradeZone, width: 1920, height: 2400, resizableX: true, resizableY: true,
    pivotX: 0, pivotY: 0, color: PALETTE.fogFar, renderMode: 'Rectangle', hollow: true, maxCount: 0,
    doc: 'Area colour grade, cross-faded by `blend` px outside the rect.', fields: [FIELDS.zoneGrade, FIELDS.zoneBlend],
  },
  {
    identifier: LDTK_ENTITY.Lantern, uid: UID.Lantern, width: 32, height: 48, resizableX: false, resizableY: false, pivotX: 0.5,
    pivotY: 1, color: PALETTE.warmAccent, renderMode: 'Ellipse', hollow: false, maxCount: 0, doc: 'Lantern decor hint (anchor).',
    fields: [],
  },
  {
    identifier: LDTK_ENTITY.Flora, uid: UID.Flora, width: 32, height: 48, resizableX: false, resizableY: false, pivotX: 0.5,
    pivotY: 1, color: PALETTE.floraGlow, renderMode: 'Ellipse', hollow: false, maxCount: 0, doc: 'Glowing flora decor hint (feet).',
    fields: [],
  },
  {
    identifier: LDTK_ENTITY.Spitter, uid: UID.Spitter, width: DEFAULT_WORLD_TUNING.spitterWidth,
    height: DEFAULT_WORLD_TUNING.spitterHeight, resizableX: false, resizableY: false, pivotX: 0.5, pivotY: 1, color: PALETTE.thorns,
    renderMode: 'Rectangle', hollow: false, maxCount: 0,
    doc: 'Thorn Spitter rooted on a floor tile (feet at the pivot). Crawler Enemies come first in enemy ids, then Spitters.',
    fields: [
      FIELDS.spitterAim, FIELDS.spitterAngle, FIELDS.spitterSpeed, FIELDS.spitterRange, FIELDS.spitterPeriod, FIELDS.spitterPhase,
      FIELDS.spitterFlight,
    ],
  },
  {
    identifier: LDTK_ENTITY.AbilityShrine, uid: UID.AbilityShrine, width: 48, height: 96, resizableX: true, resizableY: true,
    pivotX: 0, pivotY: 0, color: PALETTE.spiritGlow, renderMode: 'Rectangle', hollow: true, maxCount: 0,
    doc: 'Touching the rect unlocks the ability for the rest of the run.', fields: [FIELDS.shrineAbility],
  },
];

function enumDef(e: EnumSpec): JsonObject {
  return {
    identifier: e.identifier,
    uid: e.uid,
    values: e.values.map((v) => ({ id: v.id, tileRect: null, color: v.color })),
    iconTilesetUid: null,
    externalRelPath: null,
    externalFileChecksum: null,
    tags: [],
  };
}

function entityDef(e: EntitySpec): JsonObject {
  return {
    identifier: e.identifier,
    uid: e.uid,
    tags: [],
    exportToToc: false,
    allowOutOfBounds: false,
    doc: e.doc,
    width: e.width,
    height: e.height,
    resizableX: e.resizableX,
    resizableY: e.resizableY,
    minWidth: null,
    maxWidth: null,
    minHeight: null,
    maxHeight: null,
    keepAspectRatio: false,
    tileOpacity: 1,
    fillOpacity: e.hollow ? 0.08 : 1,
    lineOpacity: 1,
    hollow: e.hollow,
    color: hex(e.color),
    renderMode: e.renderMode,
    showName: true,
    tilesetId: null,
    tileRenderMode: 'FitInside',
    tileRect: null,
    uiTileRect: null,
    nineSliceBorders: [],
    maxCount: e.maxCount,
    limitScope: 'PerLevel',
    limitBehavior: 'MoveLastOne',
    pivotX: e.pivotX,
    pivotY: e.pivotY,
    fieldDefs: e.fields.map(fieldDef),
  };
}

function layerDef(identifier: string, uid: number, type: 'Entities' | 'IntGrid', gridSize: number, doc: string): JsonObject {
  const intGrid = type === 'IntGrid';
  return {
    __type: type,
    identifier,
    type,
    uid,
    doc,
    uiColor: intGrid ? hex(PALETTE.fogFar) : hex(PALETTE.spiritGlow),
    gridSize,
    guideGridWid: 0,
    guideGridHei: 0,
    displayOpacity: 1,
    inactiveOpacity: intGrid ? 0.6 : 1,
    hideInList: false,
    hideFieldsWhenInactive: !intGrid,
    canSelectWhenInactive: true,
    renderInWorldView: true,
    pxOffsetX: 0,
    pxOffsetY: 0,
    parallaxFactorX: 0,
    parallaxFactorY: 0,
    parallaxScaling: true,
    requiredTags: [],
    excludedTags: [],
    autoTilesKilledByOtherLayerUid: null,
    uiFilterTags: [],
    useAsyncRender: false,
    intGridValues: intGrid
      ? [
        { value: TileKind.Solid, identifier: 'Solid', color: '#34495E', tile: null, groupUid: 0 },
        { value: TileKind.OneWay, identifier: 'OneWay', color: hex(PALETTE.floraGlow), tile: null, groupUid: 0 },
        { value: TileKind.Thorns, identifier: 'Thorns', color: hex(PALETTE.thorns), tile: null, groupUid: 0 },
      ]
      : [],
    intGridValuesGroups: [],
    autoRuleGroups: [],
    autoSourceLayerDefUid: null,
    tilesetDefUid: null,
    tilePivotX: 0,
    tilePivotY: 0,
    biomeFieldUid: null,
  };
}

function entityInstance(
  spec: EntitySpec, index: number, left: number, top: number, width: number, height: number, fields: Json[],
): JsonObject {
  const px = [left + spec.pivotX * width, top + spec.pivotY * height];
  for (const v of px) {
    if (!Number.isInteger(v)) throw new Error(`${spec.identifier} ${index}: pivot position ${v} is not a whole pixel`);
  }
  const [x, y] = px as [number, number];
  return {
    __identifier: spec.identifier,
    __grid: [Math.floor(x / ENTITY_GRID), Math.floor(y / ENTITY_GRID)],
    __pivot: [spec.pivotX, spec.pivotY],
    __tags: [],
    __tile: null,
    __smartColor: hex(spec.color),
    iid: iidFor(`entity:${spec.identifier}:${index}`),
    width,
    height,
    defUid: spec.uid,
    px: [x, y],
    fieldInstances: fields,
    __worldX: x,
    __worldY: y,
  };
}

function spec(identifier: string): EntitySpec {
  const s = ENTITIES.find((e) => e.identifier === identifier);
  if (!s) throw new Error(`unknown entity ${identifier}`);
  return s;
}

/**
 * The `angleDeg` / `speed` fields of a spitter: recovered from fixedVx/fixedVy for fixed aim (rounded
 * to 1e-6, so a map written with such values reproduces the exact velocity), the defaults otherwise.
 */
function spitterFields(e: SpitterDef): { angleDeg: number; speed: number } {
  if (e.aim === 'player') return { angleDeg: LDTK_DEFAULTS.spitterAngleDeg, speed: DEFAULT_WORLD_TUNING.spitterDefaultSpeed };
  const round = (v: number): number => Math.round(v * 1e6) / 1e6;
  const speed = round(Math.hypot(e.fixedVx, e.fixedVy));
  const angleDeg = speed === 0 ? LDTK_DEFAULTS.spitterAngleDeg : round((Math.atan2(-e.fixedVy, e.fixedVx) * 180) / Math.PI) + 0;
  const v = spitterVelocity(angleDeg, speed);
  if (v.vx !== e.fixedVx || v.vy !== e.fixedVy) {
    throw new Error(`spitter ${e.id}: velocity (${e.fixedVx}, ${e.fixedVy}) is not angleDeg/speed with 6 decimals`);
  }
  return { angleDeg, speed };
}

function entityInstances(level: LevelData): JsonObject[] {
  const out: JsonObject[] = [];
  const P = spec(LDTK_ENTITY.PlayerStart);
  out.push(entityInstance(P, 0, level.playerStart.x - P.width / 2, level.playerStart.y - P.height, P.width, P.height, []));
  const C = spec(LDTK_ENTITY.Checkpoint);
  for (const c of level.checkpoints) out.push(entityInstance(C, c.id, c.x, c.y, c.w, c.h, []));
  const Z = spec(LDTK_ENTITY.GradeZone);
  for (const z of level.gradeZones) {
    out.push(entityInstance(Z, z.id, z.x, z.y, z.w, z.h, [fieldInstance(FIELDS.zoneGrade, z.grade), fieldInstance(FIELDS.zoneBlend, z.blend)]));
  }
  const S = spec(LDTK_ENTITY.LightShaft);
  for (const s of level.lightShafts) {
    const deg = Math.round(((s.angle * 180) / Math.PI) * 1e6) / 1e6;
    out.push(entityInstance(S, s.id, s.x, s.y, s.w, s.h, [
      fieldInstance(FIELDS.shaftAngle, deg), fieldInstance(FIELDS.shaftSpread, s.spread), fieldInstance(FIELDS.shaftIntensity, s.intensity),
    ]));
  }
  const E = spec(LDTK_ENTITY.Enemy);
  const half = DEFAULT_WORLD_TUNING.enemyWidth / 2;
  for (const e of level.enemies) {
    if (e.kind !== 'gloomcrawler') continue;
    const left = e.patrolMinX - half;
    const width = e.patrolMaxX + half - left;
    if (e.x !== left + width / 2) throw new Error(`enemy ${e.id}: LDtk spawns enemies at the patrol rect centre`);
    out.push(entityInstance(E, e.id, left, e.y - E.height, width, E.height, [fieldInstance(FIELDS.enemySpeed, e.speed)]));
  }
  const SP = spec(LDTK_ENTITY.Spitter);
  const crawlers = level.enemies.filter((x) => x.kind === 'gloomcrawler').length;
  let spitters = 0;
  for (const e of level.enemies) {
    if (e.kind !== 'thornSpitter') continue;
    if (e.id !== crawlers + spitters) throw new Error(`enemy ${e.id}: LevelData lists every crawler before the spitters`);
    const { angleDeg, speed } = spitterFields(e);
    out.push(entityInstance(SP, spitters++, e.x - SP.width / 2, e.y - SP.height, SP.width, SP.height, [
      fieldInstance(FIELDS.spitterAim, enumId(LDTK_SPITTER_AIM, e.aim)), fieldInstance(FIELDS.spitterAngle, angleDeg),
      fieldInstance(FIELDS.spitterSpeed, speed), fieldInstance(FIELDS.spitterRange, e.range),
      fieldInstance(FIELDS.spitterPeriod, e.period), fieldInstance(FIELDS.spitterPhase, e.phase),
      fieldInstance(FIELDS.spitterFlight, e.flightTicks),
    ]));
  }
  const A = spec(LDTK_ENTITY.AbilityShrine);
  for (const s of level.abilityShrines) {
    out.push(entityInstance(A, s.id, s.x, s.y, s.w, s.h, [fieldInstance(FIELDS.shrineAbility, enumId(LDTK_ABILITY, s.ability))]));
  }
  const O = spec(LDTK_ENTITY.Orb);
  for (const o of level.orbs) {
    out.push(entityInstance(O, o.id, o.x - O.width / 2, o.y - O.height / 2, O.width, O.height, [fieldInstance(FIELDS.orbValue, o.value)]));
  }
  for (const d of level.decorHints) {
    const D = spec(d.kind === 'lantern' ? LDTK_ENTITY.Lantern : LDTK_ENTITY.Flora);
    out.push(entityInstance(D, d.id, d.x - D.width / 2, d.y - D.height, D.width, D.height, []));
  }
  if (level.goal) {
    const G = spec(LDTK_ENTITY.Goal);
    const g = level.goal;
    out.push(entityInstance(G, 0, g.x, g.y, g.w, g.h, []));
  }
  return out;
}

function layerInstance(level: LevelData, identifier: string, type: 'Entities' | 'IntGrid', defUid: number, grid: number): JsonObject {
  const intGrid = type === 'IntGrid';
  return {
    __identifier: identifier,
    __type: type,
    __cWid: Math.ceil(level.pxWidth / grid),
    __cHei: Math.ceil(level.pxHeight / grid),
    __gridSize: grid,
    __opacity: 1,
    __pxTotalOffsetX: 0,
    __pxTotalOffsetY: 0,
    __tilesetDefUid: null,
    __tilesetRelPath: null,
    iid: iidFor(`layer:${level.id}:${identifier}`),
    levelId: UID.level,
    layerDefUid: defUid,
    pxOffsetX: 0,
    pxOffsetY: 0,
    visible: true,
    optionalRules: [],
    intGridCsv: intGrid ? Array.from(level.tiles) : [],
    autoLayerTiles: [],
    seed: hashString(`seed:${level.id}:${identifier}`) % 10000000,
    overrideTilesetUid: null,
    gridTiles: [],
    entityInstances: intGrid ? [] : entityInstances(level),
  };
}

/** The whole LDtk 1.5.3 project for one level. */
export function buildLdtkProject(level: LevelData): JsonObject {
  const T = level.tileSize;
  return {
    __header__: {
      fileType: 'LDtk Project JSON',
      app: 'LDtk',
      doc: 'https://ldtk.io/json',
      schema: 'https://ldtk.io/files/JSON_SCHEMA.json',
      appAuthor: "Sebastien 'deepnight' Benard",
      appVersion: APP_VERSION,
      url: 'https://ldtk.io',
    },
    iid: iidFor('project:spiritwood'),
    jsonVersion: APP_VERSION,
    appBuildId: APP_BUILD_ID,
    nextUid: NEXT_UID,
    identifierStyle: 'Free',
    toc: [],
    worldLayout: 'Free',
    worldGridWidth: level.pxWidth,
    worldGridHeight: level.pxHeight,
    defaultLevelWidth: level.pxWidth,
    defaultLevelHeight: level.pxHeight,
    defaultPivotX: 0.5,
    defaultPivotY: 1,
    defaultGridSize: T,
    defaultEntityWidth: T,
    defaultEntityHeight: T,
    bgColor: hex(PALETTE.skyTop),
    defaultLevelBgColor: hex(PALETTE.fogDeep),
    minifyJson: false,
    externalLevels: false,
    exportTiled: false,
    simplifiedExport: false,
    imageExportMode: 'None',
    exportLevelBg: true,
    pngFilePattern: null,
    backupOnSave: false,
    backupLimit: 10,
    backupRelPath: null,
    levelNamePattern: 'Level_%idx',
    tutorialDesc: null,
    customCommands: [],
    flags: [],
    defs: {
      layers: [
        layerDef('Entities', UID.layerEntities, 'Entities', ENTITY_GRID, 'Gameplay and decor entities.'),
        layerDef(LDTK_COLLISION_LAYER, UID.layerCollision, 'IntGrid', T, '1 Solid, 2 OneWay (solid from above), 3 Thorns (hazard).'),
      ],
      entities: ENTITIES.map(entityDef),
      tilesets: [],
      enums: [ENUMS.AreaGrade, ENUMS.SpitterAim, ENUMS.Ability].map(enumDef),
      externalEnums: [],
      levelFields: [fieldDef(FIELDS.levelSeed)],
    },
    levels: [{
      identifier: level.id,
      iid: iidFor(`level:${level.id}`),
      uid: UID.level,
      worldX: 0,
      worldY: 0,
      worldDepth: 0,
      pxWid: level.pxWidth,
      pxHei: level.pxHeight,
      __bgColor: hex(PALETTE.fogDeep),
      bgColor: null,
      useAutoIdentifier: false,
      bgRelPath: null,
      bgPos: null,
      bgPivotX: 0.5,
      bgPivotY: 0.5,
      __smartColor: '#8591A0',
      __bgPos: null,
      externalRelPath: null,
      fieldInstances: [fieldInstance(FIELDS.levelSeed, level.seed)],
      layerInstances: [
        layerInstance(level, 'Entities', 'Entities', UID.layerEntities, ENTITY_GRID),
        layerInstance(level, LDTK_COLLISION_LAYER, 'IntGrid', UID.layerCollision, T),
      ],
      __neighbours: [],
    }],
    worlds: [],
    dummyWorldIid: iidFor('world:dummy'),
  };
}

function isPrimitive(v: Json): v is null | boolean | number | string {
  return v === null || typeof v !== 'object';
}

/**
 * Tab-indented JSON in the spirit of LDtk's own output: arrays of primitives stay on one line, and
 * `intGridCsv` is written one grid row per line so map diffs stay readable.
 */
export function serializeLdtk(project: Json, rowLength: number): string {
  const write = (v: Json, indent: string, key: string): string => {
    if (isPrimitive(v)) return JSON.stringify(v);
    const inner = `${indent}\t`;
    if (Array.isArray(v)) {
      if (v.length === 0) return '[]';
      if (v.every(isPrimitive)) {
        if (key === 'intGridCsv' && v.length > rowLength) {
          const rows: string[] = [];
          for (let i = 0; i < v.length; i += rowLength) rows.push(v.slice(i, i + rowLength).map((x) => JSON.stringify(x)).join(','));
          return `[\n${inner}${rows.join(`,\n${inner}`)}\n${indent}]`;
        }
        return `[${v.map((x) => JSON.stringify(x)).join(',')}]`;
      }
      return `[\n${v.map((x) => inner + write(x, inner, '')).join(',\n')}\n${indent}]`;
    }
    const keys = Object.keys(v);
    if (keys.length === 0) return '{}';
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${write(v[k] as Json, inner, k)}`).join(',\n')}\n${indent}}`;
  };
  return `${write(project, '', '')}\n`;
}
