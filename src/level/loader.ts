import {
  AREA_GRADES, TileKind, type AbilityShrineDef, type AreaGradeId, type CheckpointDef, type DecorHintDef, type EnemyDef,
  type GoalDef, type GradeZoneDef, type LevelData, type LightShaftDef, type OrbDef, type SpitterDef,
} from '../contracts/level.ts';
import { hashString } from '../core/rng.ts';
import { DEFAULT_WORLD_TUNING } from '../sim/tuning.ts';
import type { LdtkEntityInstance, LdtkFieldInstance, LdtkLayerInstance, LdtkLayerType, LdtkLevel, LdtkProject } from './ldtk-types.ts';

export class LevelParseError extends Error {
  override name = 'LevelParseError';
}

/** Layer and entity identifiers of the Spiritwood LDtk project (ARCHITECTURE.md §5.4). */
export const LDTK_COLLISION_LAYER = 'Collision';
export const LDTK_ENTITY = {
  PlayerStart: 'PlayerStart',
  Orb: 'Orb',
  Checkpoint: 'Checkpoint',
  Enemy: 'Enemy',
  Goal: 'Goal',
  LightShaft: 'LightShaft',
  GradeZone: 'GradeZone',
  Lantern: 'Lantern',
  Flora: 'Flora',
  Spitter: 'Spitter',
  AbilityShrine: 'AbilityShrine',
} as const;

/** LDtk enums besides AreaGrade: their value ids, and the LevelData value each maps to. */
export const LDTK_SPITTER_AIM = { Player: 'player', Fixed: 'fixed' } as const;
export const LDTK_ABILITY = { Launch: 'launch' } as const;

/** Field defaults when an instance lacks the field (the LDtk defs carry the same defaults). */
export const LDTK_DEFAULTS = {
  orbValue: 1,
  shaftAngleDeg: 0,
  shaftSpread: 1.6,
  shaftIntensity: 0.6,
  /** Grade-zone cross-fade, in grid cells. */
  gradeBlendCells: 6,
  spitterAim: 'player',
  /** Fixed-aim spitter angle from +x toward screen-up (90 = straight up). */
  spitterAngleDeg: 90,
  spitterPhase: 0,
  ability: 'launch',
} as const;

/** Velocity components smaller than this snap to 0, so 90° is exactly vertical. */
const SNAP_EPSILON = 1e-9;

/**
 * A fixed-aim spitter's seed velocity from the LDtk fields: `angleDeg` from +x turning toward screen-up
 * (+y is down), `speed` in u/s; components with |c| < 1e-9 snap to 0.
 */
export function spitterVelocity(angleDeg: number, speed: number): { vx: number; vy: number } {
  const a = (angleDeg * Math.PI) / 180;
  const vx = speed * Math.cos(a);
  const vy = -speed * Math.sin(a);
  return { vx: Math.abs(vx) < SNAP_EPSILON ? 0 : vx, vy: Math.abs(vy) < SNAP_EPSILON ? 0 : vy };
}

const LAYER_TYPES: readonly LdtkLayerType[] = ['IntGrid', 'Entities', 'Tiles', 'AutoLayer'];

type Json = Record<string, unknown>;

function kindOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

function fail(path: string, message: string): never {
  throw new LevelParseError(`${path}: ${message}`);
}

function asObject(v: unknown, path: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, `expected an object, got ${kindOf(v)}`);
  return v as Json;
}

function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, `expected an array, got ${kindOf(v)}`);
  return v;
}

function asString(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, `expected a string, got ${kindOf(v)}`);
  return v;
}

function asNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, `expected a finite number, got ${kindOf(v)}`);
  return v;
}

function asInt(v: unknown, path: string): number {
  const n = asNumber(v, path);
  if (!Number.isInteger(n)) fail(path, `expected an integer, got ${n}`);
  return n;
}

function asPair(v: unknown, path: string): [number, number] {
  const a = asArray(v, path);
  if (a.length !== 2) fail(path, `expected [x, y], got ${a.length} values`);
  return [asNumber(a[0], `${path}[0]`), asNumber(a[1], `${path}[1]`)];
}

function readFields(v: unknown, path: string): LdtkFieldInstance[] {
  if (v === undefined) return [];
  return asArray(v, path).map((f, i) => {
    const p = `${path}[${i}]`;
    const o = asObject(f, p);
    return {
      __identifier: asString(o['__identifier'], `${p}.__identifier`),
      __type: asString(o['__type'], `${p}.__type`),
      __value: o['__value'],
    };
  });
}

function readEntity(v: unknown, path: string): LdtkEntityInstance {
  const o = asObject(v, path);
  const pivot = asPair(o['__pivot'], `${path}.__pivot`);
  const width = asNumber(o['width'], `${path}.width`);
  const height = asNumber(o['height'], `${path}.height`);
  if (width < 0 || height < 0) fail(path, `negative size ${width}×${height}`);
  return {
    __identifier: asString(o['__identifier'], `${path}.__identifier`),
    __pivot: pivot,
    px: asPair(o['px'], `${path}.px`),
    width,
    height,
    iid: typeof o['iid'] === 'string' ? o['iid'] : '',
    fieldInstances: readFields(o['fieldInstances'], `${path}.fieldInstances`),
  };
}

function readLayer(v: unknown, path: string): LdtkLayerInstance {
  const o = asObject(v, path);
  const type = asString(o['__type'], `${path}.__type`);
  if (!LAYER_TYPES.includes(type as LdtkLayerType)) fail(`${path}.__type`, `unknown layer type "${type}"`);
  const layer: LdtkLayerInstance = {
    __identifier: asString(o['__identifier'], `${path}.__identifier`),
    __type: type as LdtkLayerType,
    __cWid: asInt(o['__cWid'], `${path}.__cWid`),
    __cHei: asInt(o['__cHei'], `${path}.__cHei`),
    __gridSize: asInt(o['__gridSize'], `${path}.__gridSize`),
    __pxTotalOffsetX: o['__pxTotalOffsetX'] === undefined ? 0 : asNumber(o['__pxTotalOffsetX'], `${path}.__pxTotalOffsetX`),
    __pxTotalOffsetY: o['__pxTotalOffsetY'] === undefined ? 0 : asNumber(o['__pxTotalOffsetY'], `${path}.__pxTotalOffsetY`),
    intGridCsv: [],
    entityInstances: [],
  };
  if (layer.__type === 'IntGrid') {
    const csv = asArray(o['intGridCsv'], `${path}.intGridCsv`);
    layer.intGridCsv = csv as number[];
  }
  if (layer.__type === 'Entities') {
    layer.entityInstances = asArray(o['entityInstances'], `${path}.entityInstances`)
      .map((e, i) => readEntity(e, `${path}.entityInstances[${i}]`));
  }
  return layer;
}

function readLevel(v: unknown, path: string): LdtkLevel {
  const o = asObject(v, path);
  const identifier = asString(o['identifier'], `${path}.identifier`);
  const lp = `${path} "${identifier}"`;
  const raw = o['layerInstances'];
  if (raw === null || raw === undefined) {
    fail(lp, 'layerInstances is missing (levels saved as separate files are not supported)');
  }
  return {
    identifier,
    pxWid: asInt(o['pxWid'], `${lp}.pxWid`),
    pxHei: asInt(o['pxHei'], `${lp}.pxHei`),
    fieldInstances: readFields(o['fieldInstances'], `${lp}.fieldInstances`),
    layerInstances: asArray(raw, `${lp}.layerInstances`).map((l, i) => readLayer(l, `${lp}.layerInstances[${i}]`)),
  };
}

/** Validates and narrows the parts of an LDtk project the loader reads. */
export function readLdtkProject(project: unknown): LdtkProject {
  const o = asObject(project, 'project');
  const version = asString(o['jsonVersion'], 'project.jsonVersion');
  if (!/^1\.\d+/.test(version)) fail('project.jsonVersion', `unsupported LDtk JSON version "${version}" (expected 1.x)`);
  const levels = asArray(o['levels'], 'project.levels');
  if (levels.length === 0) fail('project.levels', 'the project has no levels');
  return {
    jsonVersion: version,
    identifierStyle: typeof o['identifierStyle'] === 'string' ? o['identifierStyle'] : undefined,
    levels: levels.map((l, i) => readLevel(l, `levels[${i}]`)),
  };
}

function field(e: { fieldInstances: LdtkFieldInstance[] }, name: string): LdtkFieldInstance | undefined {
  for (const f of e.fieldInstances) if (f.__identifier === name) return f;
  return undefined;
}

function numberField(e: { fieldInstances: LdtkFieldInstance[] }, name: string, fallback: number, path: string, int = false): number {
  const f = field(e, name);
  if (!f || f.__value === null || f.__value === undefined) return fallback;
  return int ? asInt(f.__value, `${path}.${name}`) : asNumber(f.__value, `${path}.${name}`);
}

function gradeField(e: LdtkEntityInstance, path: string): AreaGradeId {
  const f = field(e, 'grade');
  if (!f || f.__value === null || f.__value === undefined) fail(`${path}.grade`, 'a GradeZone needs an AreaGrade value');
  const value = asString(f.__value, `${path}.grade`).toLowerCase();
  const grade = AREA_GRADES.find((g) => g === value);
  if (!grade) fail(`${path}.grade`, `unknown AreaGrade "${String(f.__value)}" (expected one of ${AREA_GRADES.join(', ')})`);
  return grade;
}

/** An enum field matched case-insensitively against `values` (LDtk id → LevelData value); `fallback` when unset. */
function enumField<V extends string>(
  e: LdtkEntityInstance, name: string, enumName: string, values: Readonly<Record<string, V>>, fallback: V, path: string,
): V {
  const f = field(e, name);
  if (!f || f.__value === null || f.__value === undefined) return fallback;
  const raw = asString(f.__value, `${path}.${name}`);
  for (const id of Object.keys(values)) if (id.toLowerCase() === raw.toLowerCase()) return values[id] as V;
  return fail(`${path}.${name}`, `unknown ${enumName} "${raw}" (expected one of ${Object.keys(values).join(', ')})`);
}

/** A numeric field that must be at least `min`. */
function boundedField(e: LdtkEntityInstance, name: string, fallback: number, min: number, path: string, int = false): number {
  const v = numberField(e, name, fallback, path, int);
  if (v < min) fail(`${path}.${name}`, `expected at least ${min}, got ${v}`);
  return v;
}

function spitterDef(e: LdtkEntityInstance, x: number, y: number, path: string): SpitterDef {
  const wt = DEFAULT_WORLD_TUNING;
  const aim = enumField(e, 'aim', 'SpitterAim', LDTK_SPITTER_AIM, LDTK_DEFAULTS.spitterAim, path);
  const angleDeg = numberField(e, 'angleDeg', LDTK_DEFAULTS.spitterAngleDeg, path);
  const speed = boundedField(e, 'speed', wt.spitterDefaultSpeed, 0, path);
  const v = aim === 'fixed' ? spitterVelocity(angleDeg, speed) : { vx: 0, vy: 0 };
  return {
    id: 0,
    kind: 'thornSpitter',
    x,
    y,
    aim,
    fixedVx: v.vx,
    fixedVy: v.vy,
    range: boundedField(e, 'range', wt.spitterDefaultRange, 0, path),
    period: boundedField(e, 'period', wt.spitterDefaultPeriod, 1, path, true),
    phase: numberField(e, 'phase', LDTK_DEFAULTS.spitterPhase, path, true),
    flightTicks: boundedField(e, 'flightTicks', wt.spitterDefaultFlightTicks, 1, path, true),
  };
}

/**
 * Convert an LDtk 1.5.x project (parsed JSON) into LevelData. Reads only the exported "__" fields
 * (__identifier, __type, __cWid, __cHei, __gridSize, intGridCsv, entityInstances with px/__pivot/
 * width/height/fieldInstances). Validates structure and throws LevelParseError with a precise message.
 * `levelIdentifier` defaults to the first level.
 */
export function parseLdtk(project: unknown, levelIdentifier?: string): LevelData {
  const p = readLdtkProject(project);
  let index = 0;
  if (levelIdentifier !== undefined) {
    index = p.levels.findIndex((l) => l.identifier === levelIdentifier);
    if (index < 0) index = p.levels.findIndex((l) => l.identifier.toLowerCase() === levelIdentifier.toLowerCase());
    if (index < 0) {
      throw new LevelParseError(
        `level "${levelIdentifier}" not found (the project has ${p.levels.map((l) => `"${l.identifier}"`).join(', ')})`,
      );
    }
  }
  const level = p.levels[index] as LdtkLevel;
  const path = `levels[${index}] "${level.identifier}"`;
  const layers = level.layerInstances ?? [];

  const collisionIndex = layers.findIndex((l) => l.__identifier === LDTK_COLLISION_LAYER);
  if (collisionIndex < 0) fail(path, `no "${LDTK_COLLISION_LAYER}" layer`);
  const collision = layers[collisionIndex] as LdtkLayerInstance;
  const cp = `${path}.layer "${LDTK_COLLISION_LAYER}"`;
  if (collision.__type !== 'IntGrid') fail(cp, `expected an IntGrid layer, got ${collision.__type}`);
  const w = collision.__cWid;
  const h = collision.__cHei;
  const size = collision.__gridSize;
  if (w <= 0 || h <= 0 || size <= 0) fail(cp, `invalid grid ${w}×${h} cells of ${size} px`);
  const csv = collision.intGridCsv;
  if (csv.length !== w * h) fail(`${cp}.intGridCsv`, `expected ${w * h} values (${w}×${h}), got ${csv.length}`);
  const tiles = new Uint8Array(w * h);
  for (let i = 0; i < csv.length; i++) {
    const v = csv[i];
    if (v !== TileKind.Empty && v !== TileKind.Solid && v !== TileKind.OneWay && v !== TileKind.Thorns) {
      fail(`${cp}.intGridCsv[${i}]`, `unknown IntGrid value ${JSON.stringify(v)} at cell (${i % w}, ${Math.floor(i / w)}) (expected 0–3)`);
    }
    tiles[i] = v;
  }
  if (level.pxWid !== w * size || level.pxHei !== h * size) {
    fail(path, `level size ${level.pxWid}×${level.pxHei} px does not match the Collision grid ${w * size}×${h * size} px`);
  }

  const out: LevelData = {
    id: level.identifier,
    widthTiles: w,
    heightTiles: h,
    tileSize: size,
    pxWidth: w * size,
    pxHeight: h * size,
    tiles,
    playerStart: { x: 0, y: 0 },
    orbs: [],
    checkpoints: [],
    enemies: [],
    abilityShrines: [],
    goal: null,
    lightShafts: [],
    gradeZones: [],
    decorHints: [],
    seed: 0,
  };

  const seed = field(level, 'seed');
  out.seed = seed && seed.__value !== null && seed.__value !== undefined
    ? asInt(seed.__value, `${path}.fieldInstances.seed`) >>> 0
    : hashString(level.identifier);

  let starts = 0;
  let goals = 0;
  let lanterns = 0;
  let flora = 0;
  const spitters: SpitterDef[] = [];
  const enemyHalf = DEFAULT_WORLD_TUNING.enemyWidth / 2;
  for (let li = 0; li < layers.length; li++) {
    const layer = layers[li] as LdtkLayerInstance;
    if (layer.__type !== 'Entities') continue;
    for (let ei = 0; ei < layer.entityInstances.length; ei++) {
      const e = layer.entityInstances[ei] as LdtkEntityInstance;
      const ep = `${path}.layer "${layer.__identifier}".entityInstances[${ei}] (${e.__identifier})`;
      const left = e.px[0] + layer.__pxTotalOffsetX - e.__pivot[0] * e.width;
      const top = e.px[1] + layer.__pxTotalOffsetY - e.__pivot[1] * e.height;
      const rect = { x: left, y: top, w: e.width, h: e.height };
      const feetX = left + e.width / 2;
      const feetY = top + e.height;
      switch (e.__identifier) {
        case LDTK_ENTITY.PlayerStart:
          starts++;
          out.playerStart = { x: feetX, y: feetY };
          break;
        case LDTK_ENTITY.Orb: {
          const orb: OrbDef = {
            id: out.orbs.length, x: feetX, y: top + e.height / 2,
            value: numberField(e, 'value', LDTK_DEFAULTS.orbValue, ep, true),
          };
          out.orbs.push(orb);
          break;
        }
        case LDTK_ENTITY.Checkpoint: {
          const c: CheckpointDef = { id: out.checkpoints.length, ...rect };
          out.checkpoints.push(c);
          break;
        }
        case LDTK_ENTITY.Enemy: {
          const pivotX = e.px[0] + layer.__pxTotalOffsetX;
          const centre = left + e.width / 2;
          const min = Math.min(left + enemyHalf, centre);
          const max = Math.max(left + e.width - enemyHalf, centre);
          const enemy: EnemyDef = {
            id: out.enemies.length,
            kind: 'gloomcrawler',
            x: Math.min(max, Math.max(min, pivotX)),
            y: feetY,
            patrolMinX: min,
            patrolMaxX: max,
            speed: numberField(e, 'speed', DEFAULT_WORLD_TUNING.enemyDefaultSpeed, ep),
          };
          out.enemies.push(enemy);
          break;
        }
        case LDTK_ENTITY.Goal: {
          goals++;
          if (goals > 1) fail(ep, 'the level has more than one Goal');
          const goal: GoalDef = { ...rect };
          out.goal = goal;
          break;
        }
        case LDTK_ENTITY.LightShaft: {
          const shaft: LightShaftDef = {
            id: out.lightShafts.length,
            ...rect,
            // `angleDeg` per the LevelData contract; `angle` (also degrees) is accepted as an alias.
            angle: (numberField(e, 'angleDeg', numberField(e, 'angle', LDTK_DEFAULTS.shaftAngleDeg, ep), ep) * Math.PI) / 180,
            spread: numberField(e, 'spread', LDTK_DEFAULTS.shaftSpread, ep),
            intensity: numberField(e, 'intensity', LDTK_DEFAULTS.shaftIntensity, ep),
          };
          out.lightShafts.push(shaft);
          break;
        }
        case LDTK_ENTITY.GradeZone: {
          const zone: GradeZoneDef = {
            id: out.gradeZones.length,
            ...rect,
            grade: gradeField(e, ep),
            blend: numberField(e, 'blend', LDTK_DEFAULTS.gradeBlendCells * size, ep, true),
          };
          out.gradeZones.push(zone);
          break;
        }
        case LDTK_ENTITY.Lantern:
        case LDTK_ENTITY.Flora: {
          const lantern = e.__identifier === LDTK_ENTITY.Lantern;
          const hint: DecorHintDef = {
            id: lantern ? lanterns++ : flora++, kind: lantern ? 'lantern' : 'flora', x: feetX, y: feetY,
          };
          out.decorHints.push(hint);
          break;
        }
        case LDTK_ENTITY.Spitter:
          spitters.push(spitterDef(e, feetX, feetY, ep));
          break;
        case LDTK_ENTITY.AbilityShrine: {
          const shrine: AbilityShrineDef = {
            id: out.abilityShrines.length,
            ...rect,
            ability: enumField(e, 'ability', 'Ability', LDTK_ABILITY, LDTK_DEFAULTS.ability, ep),
          };
          out.abilityShrines.push(shrine);
          break;
        }
        default:
          break;
      }
    }
  }
  if (starts !== 1) fail(path, `expected exactly one PlayerStart, found ${starts}`);
  // Every Enemy (crawlers) first, then every Spitter, each in layer order; id = index.
  for (const s of spitters) {
    s.id = out.enemies.length;
    out.enemies.push(s);
  }
  return out;
}

export async function loadLevel(url: string, levelIdentifier?: string, fetchFn: typeof fetch = fetch): Promise<LevelData> {
  const res = await fetchFn(url);
  if (!res.ok) throw new LevelParseError(`Failed to load level ${url}: HTTP ${res.status}`);
  return parseLdtk(await res.json(), levelIdentifier);
}
