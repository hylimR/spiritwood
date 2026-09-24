import { MIN_ASPECT, MIN_CAMERA_ZOOM, VIEW_H } from '../config.ts';
import type { Rect } from '../contracts/common.ts';
import { TileKind, type LevelData } from '../contracts/level.ts';
import { tileAt } from '../core/tiles.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING, type PlayerTuning } from '../sim/tuning.ts';

export interface LevelIssue {
  severity: 'error' | 'warning';
  message: string;
}

/** Camera centres are sampled on this grid when checking grade-zone coverage (world units). */
const GRADE_SAMPLE_STEP = 48;

function isFloor(kind: TileKind): boolean {
  return kind === TileKind.Solid || kind === TileKind.OneWay;
}

/** Any tile of `kind` in the world rect [x0, x1) × [y0, y1)? Uses tileAt (out-of-bounds rule). */
function rectHas(level: LevelData, x0: number, y0: number, x1: number, y1: number, kind: TileKind): boolean {
  if (!(x1 > x0) || !(y1 > y0)) return false;
  const t = level.tileSize;
  for (let ty = Math.floor(y0 / t); ty <= Math.ceil(y1 / t) - 1; ty++) {
    for (let tx = Math.floor(x0 / t); tx <= Math.ceil(x1 / t) - 1; tx++) {
      if (tileAt(level, tx, ty) === kind) return true;
    }
  }
  return false;
}

/** The feet stand exactly on a tile top with Solid/OneWay under part of the collider, and it fits. */
function standIssue(level: LevelData, x: number, y: number, w: number, h: number): string | null {
  const t = level.tileSize;
  if (y % t !== 0) return `feet y ${y} is not on a tile top`;
  const ty = y / t;
  let floor = false;
  for (let tx = Math.floor((x - w / 2) / t); tx <= Math.ceil((x + w / 2) / t) - 1; tx++) {
    if (isFloor(tileAt(level, tx, ty))) floor = true;
  }
  if (!floor) return 'nothing to stand on';
  if (rectHas(level, x - w / 2, y - h, x + w / 2, y, TileKind.Solid)) return 'the collider overlaps a Solid tile';
  if (rectHas(level, x - w / 2, y - h, x + w / 2, y, TileKind.Thorns)) return 'the collider overlaps Thorns';
  return null;
}

function inside(level: LevelData, r: Rect): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= level.pxWidth && r.y + r.h <= level.pxHeight && r.w >= 0 && r.h >= 0;
}

function fmt(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Distance from (x, y) to the rect (0 inside). */
function rectDistance(r: Rect, x: number, y: number): number {
  const dx = x < r.x ? r.x - x : x > r.x + r.w ? x - (r.x + r.w) : 0;
  const dy = y < r.y ? r.y - y : y > r.y + r.h ? y - (r.y + r.h) : 0;
  return Math.hypot(dx, dy);
}

/**
 * Content checks: player start and checkpoints stand on ground with head-room for the player collider,
 * orbs/entities inside bounds and not inside solids, enemy patrol ranges on a floor, grade zones
 * cover the level width, at least one checkpoint and exactly one goal.
 * Also: every camera centre in the clamped camera range (all supported aspects, sampled on a 48 u
 * grid) has a positive total grade-zone weight, and isolated single-tile solids are flagged.
 */
export function validateLevel(level: LevelData, tuning: PlayerTuning = DEFAULT_TUNING): LevelIssue[] {
  const issues: LevelIssue[] = [];
  const error = (message: string): void => {
    issues.push({ severity: 'error', message });
  };
  const warn = (message: string): void => {
    issues.push({ severity: 'warning', message });
  };
  const t = level.tileSize;
  const pw = tuning.width;
  const ph = tuning.height;

  if (level.tiles.length !== level.widthTiles * level.heightTiles) {
    error(`tiles has ${level.tiles.length} entries for a ${level.widthTiles}×${level.heightTiles} grid`);
    return issues;
  }
  if (level.pxWidth !== level.widthTiles * t || level.pxHeight !== level.heightTiles * t) {
    error(`pixel size ${level.pxWidth}×${level.pxHeight} does not match the grid`);
  }
  for (let i = 0; i < level.tiles.length; i++) {
    const k = level.tiles[i] as number;
    if (k > TileKind.Thorns) error(`tile (${i % level.widthTiles}, ${Math.floor(i / level.widthTiles)}) has unknown kind ${k}`);
  }

  const start = level.playerStart;
  const startIssue = standIssue(level, start.x, start.y, pw, ph);
  if (startIssue) error(`player start (${fmt(start.x)}, ${fmt(start.y)}): ${startIssue}`);

  if (level.checkpoints.length === 0) error('the level has no checkpoint');
  for (const c of level.checkpoints) {
    if (!inside(level, c)) error(`checkpoint ${c.id} is outside the level`);
    const issue = standIssue(level, c.x + c.w / 2, c.y + c.h, pw, ph);
    if (issue) error(`checkpoint ${c.id} respawn point (${fmt(c.x + c.w / 2)}, ${fmt(c.y + c.h)}): ${issue}`);
  }

  if (!level.goal) error('the level has no goal');
  else {
    const g = level.goal;
    if (!inside(level, g)) error('the goal is outside the level');
    if (rectHas(level, g.x, g.y, g.x + g.w, g.y + g.h, TileKind.Solid)) error('the goal overlaps Solid tiles');
  }

  for (const o of level.orbs) {
    if (o.x < 0 || o.y < 0 || o.x >= level.pxWidth || o.y >= level.pxHeight) error(`orb ${o.id} is outside the level`);
    else if (tileAt(level, Math.floor(o.x / t), Math.floor(o.y / t)) === TileKind.Solid) {
      error(`orb ${o.id} (${fmt(o.x)}, ${fmt(o.y)}) is inside a Solid tile`);
    }
  }

  const ew = DEFAULT_WORLD_TUNING.enemyWidth;
  const eh = DEFAULT_WORLD_TUNING.enemyHeight;
  for (const e of level.enemies) {
    if (e.patrolMinX > e.patrolMaxX) error(`enemy ${e.id} has an empty patrol range`);
    if (e.x < e.patrolMinX || e.x > e.patrolMaxX) error(`enemy ${e.id} spawns outside its patrol range`);
    if (e.y % t !== 0) {
      error(`enemy ${e.id} feet y ${fmt(e.y)} is not on a tile top`);
      continue;
    }
    const x0 = e.patrolMinX - ew / 2;
    const x1 = e.patrolMaxX + ew / 2;
    if (x0 < 0 || x1 > level.pxWidth || e.y - eh < 0 || e.y > level.pxHeight) error(`enemy ${e.id} patrols outside the level`);
    for (let tx = Math.floor(x0 / t); tx <= Math.ceil(x1 / t) - 1; tx++) {
      if (!isFloor(tileAt(level, tx, e.y / t))) {
        error(`enemy ${e.id} patrol range has no floor under column ${tx}`);
        break;
      }
    }
    if (rectHas(level, x0, e.y - eh, x1, e.y, TileKind.Solid)) error(`enemy ${e.id} patrol range is blocked by Solid tiles`);
  }

  for (const s of level.lightShafts) {
    if (s.x + s.w < 0 || s.x > level.pxWidth || s.y < 0 || s.y > level.pxHeight) error(`light shaft ${s.id} is outside the level`);
    if (!(s.intensity >= 0 && s.intensity <= 1)) error(`light shaft ${s.id} intensity ${s.intensity} is outside 0..1`);
    if (!(s.spread > 0)) error(`light shaft ${s.id} spread must be positive`);
    if (!(Math.abs(s.angle) < Math.PI / 2)) error(`light shaft ${s.id} angle must be within ±90°`);
  }

  for (const d of level.decorHints) {
    if (d.x < 0 || d.y < 0 || d.x > level.pxWidth || d.y > level.pxHeight) warn(`${d.kind} ${d.id} is outside the level`);
    else if (tileAt(level, Math.floor(d.x / t), Math.ceil(d.y / t) - 1) === TileKind.Solid) {
      warn(`${d.kind} ${d.id} (${fmt(d.x)}, ${fmt(d.y)}) is inside a Solid tile`);
    }
  }

  checkGradeZones(level, error);

  for (let ty = 0; ty < level.heightTiles; ty++) {
    for (let tx = 0; tx < level.widthTiles; tx++) {
      if (tileAt(level, tx, ty) !== TileKind.Solid) continue;
      const lone = tileAt(level, tx - 1, ty) !== TileKind.Solid && tileAt(level, tx + 1, ty) !== TileKind.Solid
        && tileAt(level, tx, ty - 1) !== TileKind.Solid && tileAt(level, tx, ty + 1) !== TileKind.Solid;
      if (lone) warn(`isolated single Solid tile at (${tx}, ${ty})`);
    }
  }
  return issues;
}

function checkGradeZones(level: LevelData, error: (message: string) => void): void {
  const zones = level.gradeZones;
  if (zones.length === 0) {
    error('the level has no grade zones');
    return;
  }
  // 1D: the zone rects' x-ranges cover the level width without gaps.
  const spans = zones.map((z) => [z.x, z.x + z.w] as const).sort((a, b) => a[0] - b[0]);
  let reach = 0;
  for (const [a, b] of spans) {
    if (a > reach) {
      error(`grade zones leave a gap at x ${fmt(reach)}–${fmt(a)}`);
      return;
    }
    reach = Math.max(reach, b);
  }
  if (reach < level.pxWidth) error(`grade zones end at x ${fmt(reach)}, before the level width ${level.pxWidth}`);

  // 2D: every reachable camera centre (narrowest view = widest centre range) has some zone weight.
  const halfW = (VIEW_H * MIN_ASPECT) / (2 * MIN_CAMERA_ZOOM);
  const halfH = VIEW_H / (2 * MIN_CAMERA_ZOOM);
  const range = (size: number, half: number): [number, number] => (size > 2 * half ? [half, size - half] : [size / 2, size / 2]);
  const [x0, x1] = range(level.pxWidth, halfW);
  const [y0, y1] = range(level.pxHeight, halfH);
  const nx = Math.ceil((x1 - x0) / GRADE_SAMPLE_STEP);
  const ny = Math.ceil((y1 - y0) / GRADE_SAMPLE_STEP);
  for (let j = 0; j <= ny; j++) {
    const y = Math.min(y1, y0 + j * GRADE_SAMPLE_STEP);
    for (let i = 0; i <= nx; i++) {
      const x = Math.min(x1, x0 + i * GRADE_SAMPLE_STEP);
      let covered = false;
      for (const z of zones) {
        const d = rectDistance(z, x, y);
        if (d === 0 || d < z.blend) {
          covered = true;
          break;
        }
      }
      if (!covered) {
        error(`camera centre (${fmt(x)}, ${fmt(y)}) is outside every grade zone`);
        return;
      }
    }
  }
}
