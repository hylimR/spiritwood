import { TILE } from '../../src/config.ts';
import { AREA_GRADES, type AreaGradeId, type LevelData, type SpitterDef } from '../../src/contracts/level.ts';
import { hashString } from '../../src/core/rng.ts';
import { ASCII_TILES, levelFromAscii } from '../../src/level/ascii.ts';
import { LDTK_DEFAULTS, spitterVelocity } from '../../src/level/loader.ts';
import { DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';

/**
 * Parser for the ASCII level source (format documented at the top of tools/level/forest.map.txt).
 * Tiles and the `P` / `o` glyphs go through levelFromAscii (the one ASCII legend); `L` / `f` add
 * decor hints; rect entities come from the [entities] section, in tile units.
 */

export class MapFileError extends Error {
  override name = 'MapFileError';
}

/** Glyphs levelFromAscii would also understand but that this format declares in [entities]. */
const RESERVED_GLYPHS = new Set(['C', 'E', 'G', 'S', 'U', 'A']);

/** `key=value` options of a Spitter line and their SpitterDef / LDtk field. */
const SPITTER_KEYS = ['angle', 'speed', 'range', 'period', 'phase', 'flight'] as const;
type SpitterKey = (typeof SPITTER_KEYS)[number];
const INTEGER_KEYS: ReadonlySet<SpitterKey> = new Set(['period', 'phase', 'flight']);
const DECOR_GLYPHS: Readonly<Record<string, 'lantern' | 'flora'>> = { L: 'lantern', f: 'flora' };

interface Line {
  n: number;
  text: string;
}

function fail(line: Line | number, message: string): never {
  const n = typeof line === 'number' ? line : line.n;
  throw new MapFileError(`forest map line ${n}: ${message}`);
}

function numbers(line: Line, parts: readonly string[], count: number): number[] {
  if (parts.length !== count) fail(line, `expected ${count} numbers, got ${parts.length}: "${line.text}"`);
  return parts.map((p) => {
    const v = Number(p);
    if (!Number.isFinite(v)) fail(line, `"${p}" is not a number`);
    return v;
  });
}

/** `Spitter x y aim [key=value …]`: feet at the bottom-centre of cell (x, y); unset keys take the defaults. */
function spitterLine(line: Line, args: readonly string[], T: number): SpitterDef {
  if (args.length < 3) fail(line, `expected x y aim [key=value …], got "${line.text}"`);
  const [x, y] = numbers(line, args.slice(0, 2), 2) as [number, number];
  const aim = (args[2] as string).toLowerCase();
  if (aim !== 'player' && aim !== 'fixed') fail(line, `unknown spitter aim "${args[2]}" (expected player or fixed)`);
  const wt = DEFAULT_WORLD_TUNING;
  const opts: Record<SpitterKey, number> = {
    angle: LDTK_DEFAULTS.spitterAngleDeg,
    speed: wt.spitterDefaultSpeed,
    range: wt.spitterDefaultRange,
    period: wt.spitterDefaultPeriod,
    phase: LDTK_DEFAULTS.spitterPhase,
    flight: wt.spitterDefaultFlightTicks,
  };
  for (const opt of args.slice(3)) {
    const kv = /^(\w+)=(.+)$/.exec(opt);
    const key = kv?.[1] as SpitterKey | undefined;
    if (!kv || !key || !SPITTER_KEYS.includes(key)) fail(line, `expected key=value with a key of ${SPITTER_KEYS.join(', ')}, got "${opt}"`);
    const v = Number(kv[2]);
    if (!Number.isFinite(v) || (INTEGER_KEYS.has(key) && !Number.isInteger(v))) fail(line, `"${opt}" is not a valid ${key}`);
    opts[key] = v;
  }
  if ((aim === 'player') && (opts.angle !== LDTK_DEFAULTS.spitterAngleDeg || opts.speed !== wt.spitterDefaultSpeed)) {
    fail(line, 'angle and speed apply to fixed aim only');
  }
  const v = aim === 'fixed' ? spitterVelocity(opts.angle, opts.speed) : { vx: 0, vy: 0 };
  return {
    id: 0, kind: 'thornSpitter', x: x * T + T / 2, y: (y + 1) * T, aim, fixedVx: v.vx, fixedVy: v.vy,
    range: opts.range, period: opts.period, phase: opts.phase, flightTicks: opts.flight,
  };
}

/** Parse the map source into LevelData (the exact data the LDtk file must round-trip to). */
export function parseMapFile(source: string): LevelData {
  const lines = source.split(/\r?\n/);
  let section = '';
  const meta = new Map<string, string>();
  const rows: string[] = [];
  const entities: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const line: Line = { n: i + 1, text: raw };
    if (section === 'map') {
      if (raw.startsWith('[')) section = '';
      else {
        if (raw.trim() === '') continue;
        rows.push(raw.trimEnd());
        continue;
      }
    }
    const text = raw.trim();
    if (text === '' || text.startsWith(';')) continue;
    const header = /^\[(\w+)\]$/.exec(text);
    if (header) {
      section = (header[1] as string).toLowerCase();
      if (section !== 'level' && section !== 'entities' && section !== 'map') fail(line, `unknown section [${section}]`);
      continue;
    }
    if (section === 'level') {
      const kv = /^(\w+)\s*=\s*(.+)$/.exec(text);
      if (!kv) fail(line, `expected "key = value", got "${text}"`);
      meta.set(kv[1] as string, (kv[2] as string).trim());
    } else if (section === 'entities') {
      entities.push({ n: i + 1, text });
    } else {
      fail(line, `content outside a section: "${text}"`);
    }
  }
  if (rows.length === 0) throw new MapFileError('forest map: the [map] section is empty');

  const width = (rows[0] as string).length;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] as string;
    if (row.length !== width) throw new MapFileError(`forest map row ${y}: ${row.length} columns, expected ${width}`);
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      if (RESERVED_GLYPHS.has(ch)) {
        throw new MapFileError(`forest map row ${y}, column ${x}: declare "${ch}" entities in [entities]`);
      }
      if (ch !== '.' && ch !== 'P' && ch !== 'o' && ASCII_TILES[ch] === undefined && DECOR_GLYPHS[ch] === undefined) {
        throw new MapFileError(`forest map row ${y}, column ${x}: unknown glyph "${ch}"`);
      }
    }
  }

  const id = meta.get('id') ?? 'Forest_Night';
  const seedText = meta.get('seed');
  const seed = seedText === undefined ? hashString(id) : Number(seedText);
  if (!Number.isInteger(seed)) throw new MapFileError(`forest map: seed "${seedText}" is not an integer`);
  const level = levelFromAscii(rows, { id, seed: seed >>> 0, tileSize: TILE });
  const T = level.tileSize;

  let playerStarts = 0;
  const decorIds = { lantern: 0, flora: 0 };
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y] as string;
    for (let x = 0; x < row.length; x++) {
      const ch = row[x] as string;
      if (ch === 'P') playerStarts++;
      const kind = DECOR_GLYPHS[ch];
      if (kind) level.decorHints.push({ id: decorIds[kind]++, kind, x: x * T + T / 2, y: (y + 1) * T });
    }
  }
  if (playerStarts !== 1) throw new MapFileError(`forest map: expected exactly one "P", found ${playerStarts}`);

  const spitters: SpitterDef[] = [];
  for (const line of entities) {
    const [kind, ...args] = line.text.split(/\s+/) as [string, ...string[]];
    switch (kind) {
      case 'Spitter':
        spitters.push(spitterLine(line, args, T));
        break;
      case 'AbilityShrine': {
        if (args.length !== 4 && args.length !== 5) fail(line, `expected x y w h [ability], got "${line.text}"`);
        const [x, y, w, h] = numbers(line, args.slice(0, 4), 4) as [number, number, number, number];
        const ability = (args[4] ?? LDTK_DEFAULTS.ability).toLowerCase();
        if (ability !== 'launch') fail(line, `unknown ability "${args[4]}" (expected launch)`);
        level.abilityShrines.push({ id: level.abilityShrines.length, x: x * T, y: y * T, w: w * T, h: h * T, ability });
        break;
      }
      case 'Checkpoint': {
        const [x, y, w, h] = numbers(line, args, 4) as [number, number, number, number];
        level.checkpoints.push({ id: level.checkpoints.length, x: x * T, y: y * T, w: w * T, h: h * T });
        break;
      }
      case 'Goal': {
        if (level.goal) fail(line, 'a second Goal');
        const [x, y, w, h] = numbers(line, args, 4) as [number, number, number, number];
        level.goal = { x: x * T, y: y * T, w: w * T, h: h * T };
        break;
      }
      case 'Enemy': {
        const [x, y, w, speed] = numbers(line, args, 4) as [number, number, number, number];
        const half = DEFAULT_WORLD_TUNING.enemyWidth / 2;
        const left = x * T;
        const width = w * T;
        const centre = left + width / 2;
        level.enemies.push({
          id: level.enemies.length, kind: 'gloomcrawler', x: centre, y: (y + 1) * T,
          patrolMinX: Math.min(left + half, centre), patrolMaxX: Math.max(left + width - half, centre), speed,
        });
        break;
      }
      case 'LightShaft': {
        const [x, y, w, h, angleDeg, spread, intensity] = numbers(line, args, 7) as [number, number, number, number, number, number, number];
        level.lightShafts.push({
          id: level.lightShafts.length, x: x * T, y: y * T, w: w * T, h: h * T,
          angle: (angleDeg * Math.PI) / 180, spread, intensity,
        });
        break;
      }
      case 'GradeZone': {
        if (args.length !== 6) fail(line, `expected x y w h grade blend, got "${line.text}"`);
        const [x, y, w, h] = numbers(line, args.slice(0, 4), 4) as [number, number, number, number];
        const grade = (args[4] as string).toLowerCase();
        if (!AREA_GRADES.includes(grade as AreaGradeId)) fail(line, `unknown grade "${args[4]}"`);
        const [blend] = numbers(line, args.slice(5), 1) as [number];
        level.gradeZones.push({ id: level.gradeZones.length, x: x * T, y: y * T, w: w * T, h: h * T, grade: grade as AreaGradeId, blend: blend * T });
        break;
      }
      default:
        fail(line, `unknown entity "${kind}"`);
    }
  }
  // LevelData.enemies: every crawler, then every spitter (each in line order); id = index.
  for (const s of spitters) {
    s.id = level.enemies.length;
    level.enemies.push(s);
  }
  return level;
}
