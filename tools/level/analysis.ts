/**
 * Level analysis for the §5.4 launch-course rules, shared by tests/level/forest.test.ts,
 * tests/sim/reach.test.ts and `node tools/level/analysis.ts` (a design report):
 *
 * - a conservative no-launch reachability closure (the gate proofs and the shrine chokepoint);
 * - the no-launch reach it is bounded by, measured with the real controller;
 * - fixed-aim stream fairness against standable surfaces and checkpoint respawn boxes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { HAZARD_INSET, SIM_DT } from '../../src/config.ts';
import type { Rect } from '../../src/contracts/common.ts';
import { createInputFrame } from '../../src/contracts/input.ts';
import { TileKind, type LevelData, type SpitterDef } from '../../src/contracts/level.ts';
import { SimEventQueue } from '../../src/core/events.ts';
import { tileAt } from '../../src/core/tiles.ts';
import { levelFromAscii } from '../../src/level/ascii.ts';
import { CollisionGrid } from '../../src/level/grid.ts';
import { PlayerController } from '../../src/sim/player.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING, deriveTuning, type PlayerTuning, type WorldTuning } from '../../src/sim/tuning.ts';
import { MAP_PATH } from './build-level.ts';
import { parseMapFile } from './mapfile.ts';
import { fixedStreams, type SeedPoint } from './streams.ts';

export interface Cell {
  tx: number;
  ty: number;
}

const key = (tx: number, ty: number): string => `${tx},${ty}`;

/** Tile cells a world rect overlaps (half-open). */
export function rectCells(r: Rect, tileSize: number): Cell[] {
  const out: Cell[] = [];
  for (let ty = Math.floor(r.y / tileSize); ty <= Math.ceil((r.y + r.h) / tileSize) - 1; ty++) {
    for (let tx = Math.floor(r.x / tileSize); tx <= Math.ceil((r.x + r.w) / tileSize) - 1; tx++) out.push({ tx, ty });
  }
  return out;
}

/** A spitter's contact box as a rect. */
export function spitterBox(s: SpitterDef): Rect {
  const wt = DEFAULT_WORLD_TUNING;
  return { x: s.x - wt.spitterWidth / 2, y: s.y - wt.spitterHeight, w: wt.spitterWidth, h: wt.spitterHeight };
}

/**
 * A §5.4 no-launch dash-jump: presses in ticks from reference tick 0, which is `pre` ticks before the
 * last tick that starts with the body over the runway (−1 = never).
 */
export interface RunPlan {
  pre: number;
  dash: number;
  jump: number;
  /** The air jump. */
  air: number;
  airDash: number;
}

/** The searched optima of §5.4 for DEFAULT_TUNING (the reach table's two dash-jump rows). */
export const NO_LAUNCH_PLANS = {
  /** Jump + air dash, cancelled by the air jump (keeps the dash speed): ≈ 1064 u. */
  airDashJump: { pre: 0, dash: -1, jump: 6, air: 60, airDash: 51 },
  /** Ground dash → coyote jump (cancels) + air dash + air jump (cancels): ≈ 1346 u, the longest. */
  dashJump: { pre: 14, dash: 12, jump: 19, air: 72, airDash: 63 },
} as const satisfies Record<string, RunPlan>;

/**
 * The real controller runs off a 16-tile runway at full speed with `plan`; returns the leading edge
 * (x + w/2 − edge) where the feet come back down through the runway top + ledgeAssist (the lowest point
 * a ledge-assisted landing at runway height still catches).
 */
export function noLaunchLead(plan: RunPlan, tun: PlayerTuning = DEFAULT_TUNING): number {
  const RW = 16;
  const FL = 10;
  const rows: string[] = [];
  for (let y = 0; y < 40; y++) rows.push((y >= FL ? '#'.repeat(RW) : y === FL - 1 ? `..P${'.'.repeat(RW - 3)}` : '.'.repeat(RW)) + '.'.repeat(60));
  const level = levelFromAscii(rows);
  const T = level.tileSize;
  const p = new PlayerController(CollisionGrid.fromLevel(level), tun);
  p.reset(level.playerStart.x, level.playerStart.y, 0);
  const events = new SimEventQueue(64);
  const f = createInputFrame();
  const edge = RW * T;
  let tick = 0;
  const step = (k: number): void => {
    f.moveX = 1;
    f.jumpHeld = k >= 0 && k >= plan.jump;
    f.jumpPressed = k >= 0 && (k === plan.jump || k === plan.air);
    f.dashPressed = k >= 0 && (k === plan.dash || k === plan.airDash);
    f.dashHeld = f.dashPressed;
    p.step(f, ++tick, events);
    events.clear();
  };
  while (p.x - tun.width / 2 + p.vx * SIM_DT * (plan.pre + 1) < edge) {
    step(-1);
    if (tick > 400) throw new Error('noLaunchLead: never reached the runway edge');
  }
  const yLedge = FL * T + tun.ledgeAssist;
  for (let k = 0; k < 300; k++) {
    const px = p.x;
    const py = p.y;
    step(k);
    if (k > plan.jump && p.vy > 0 && py <= yLedge && p.y > yLedge) return px + (p.x - px) * ((yLedge - py) / (p.y - py)) + tun.width / 2 - edge;
  }
  throw new Error('noLaunchLead: never came down');
}

/** The closure's movement bounds, in tiles and rows, derived from the tunings. */
export interface ClosureBounds {
  /** Max rise onto a floor: jump + air jump peaks, ledge assist and a crawler stomp (< 7 tiles). */
  maxRise: number;
  /** Rows above a floor the body can touch: that rise plus the body height. */
  reachRows: number;
  /** Rows the body can still rise once it is falling (the air jump, ledge assist, a stomp, the body). */
  airRows: number;
  /** Horizontal reach while above the source floor: the longest dash-jump, + 1 tile. */
  maxRun: number;
  /** Rows a standing body's collision box overlaps (they must be free of Solid). */
  bodyRows: number;
  /** Rows a standing body's hazard box (inset by HAZARD_INSET) overlaps (they must be free of Thorns). */
  hazardRows: number;
}

let runReach: { tun: PlayerTuning; lead: number } | null = null;

/**
 * Derives the bounds. A stomp bounces from the crawler's top (enemyHeight up) with a held,
 * apex-hanging arc and restores the air jump, so it adds enemyHeight + its apex − the jump's apex over a
 * jump + double jump (one crawler per arc; each crawler floor is a source of its own). The run is the
 * measured §5.4 dash-jump reach.
 */
export function closureBounds(tun: PlayerTuning = DEFAULT_TUNING, wt: WorldTuning = DEFAULT_WORLD_TUNING, T = 48): ClosureBounds {
  const der = deriveTuning(tun);
  const hang = der.apexHangExtra;
  const g2 = 2 * der.gravity;
  const jumpPeak = der.jumpVelocity ** 2 / g2 + hang;
  const airPeak = der.airJumpVelocity ** 2 / g2 + hang;
  const stompPeak = wt.stompBounceVelocity ** 2 / g2 + hang;
  const stomp = Math.max(0, wt.enemyHeight + stompPeak - jumpPeak);
  const riseU = jumpPeak + airPeak + tun.ledgeAssist + stomp;
  if (!runReach || runReach.tun !== tun) runReach = { tun, lead: noLaunchLead(NO_LAUNCH_PLANS.dashJump, tun) };
  return {
    maxRise: Math.floor(riseU / T),
    reachRows: Math.ceil((riseU + tun.height) / T),
    airRows: Math.ceil((airPeak + tun.ledgeAssist + stomp + tun.height) / T),
    maxRun: Math.ceil(runReach.lead / T) + 1,
    bodyRows: Math.ceil(tun.height / T),
    hazardRows: Math.max(1, Math.ceil((tun.height - HAZARD_INSET) / T)),
  };
}

/**
 * Can the body stand on tile (tx, ty)? Solid or OneWay, no Solid in the rows the body overlaps and no
 * Thorns in the rows its hazard box overlaps (HAZARD_INSET lets the head graze thorns above those).
 */
function standable(level: LevelData, tx: number, ty: number, b: ClosureBounds, blocked?: (tx: number, ty: number) => boolean): boolean {
  const k = tileAt(level, tx, ty);
  if ((k !== TileKind.Solid && k !== TileKind.OneWay) || blocked?.(tx, ty)) return false;
  for (let i = 1; i <= b.bodyRows; i++) {
    const a = tileAt(level, tx, ty - i);
    if (a === TileKind.Solid || blocked?.(tx, ty - i)) return false;
    if (i <= b.hazardRows && a === TileKind.Thorns) return false;
  }
  return true;
}

export interface ClosureOptions {
  /** World rects that block like Solid but can't be climbed (a spitter's box, a shrine rect). */
  blockers?: readonly Rect[];
  /** Overrides of the tuning-derived bounds. */
  bounds?: Partial<ClosureBounds>;
}

export interface Closure {
  /** Reached standable floor cells ("tx,ty" of the floor tile). */
  floors: Set<string>;
  /** Reached (touchable) cells. */
  air: Set<string>;
}

interface Source {
  /** Reference floor row (the feet stand on its top edge). */
  ref: number;
  tx: number;
  /** The cell the body starts in. */
  start: Cell;
}

/**
 * The §5.4 conservative no-launch reachability closure. From every reached floor it floods the cells the
 * body can touch: 4-connected cells that are neither Solid nor Thorns (OneWay is open), at most
 * `reachRows` above the floor and, while above it, within `maxRun` tiles. Each flood step up spends one
 * row of the rise; once the body has moved down (the jump is spent) at most `airRows` remain. A standable
 * floor under a touched cell is reached when it is at most `maxRise` tiles above the source (lower floors
 * by falling), and becomes a source itself.
 *
 * A Solid face beside a touched cell can be climbed (a single wall climbs, and a wall slide restores the
 * air jump and dash): the column beside it up to the face's top is touched and the top becomes a source.
 * HAZARD_INSET lets the head (or the feet) graze a Thorns cell above (below) a touched cell, so a Solid
 * face beside that Thorns cell can be slid on too: that wall slide becomes a source at the touched cell
 * (its reference row is the one below it, reached with a rise of at most maxRise).
 * Over-approximates movement without Spirit Launch, so a floor outside `floors` needs a launch.
 */
export function noLaunchClosure(level: LevelData, starts: readonly Cell[], options: ClosureOptions = {}): Closure {
  const T = level.tileSize;
  const W = level.widthTiles;
  const H = level.heightTiles;
  const b: ClosureBounds = { ...closureBounds(DEFAULT_TUNING, DEFAULT_WORLD_TUNING, T), ...options.bounds };
  const blocked = new Uint8Array(W * H);
  for (const r of options.blockers ?? []) {
    for (const c of rectCells(r, T)) if (c.tx >= 0 && c.tx < W && c.ty >= 0 && c.ty < H) blocked[c.ty * W + c.tx] = 1;
  }
  const isBlocked = (tx: number, ty: number): boolean => tx >= 0 && tx < W && ty >= 0 && ty < H && blocked[ty * W + tx] === 1;
  const kind = (tx: number, ty: number): number => tileAt(level, tx, ty);
  const passable = (tx: number, ty: number): boolean => {
    if (tx < 0 || tx >= W || ty < 0 || ty >= H || isBlocked(tx, ty)) return false;
    const k = kind(tx, ty);
    return k !== TileKind.Solid && k !== TileKind.Thorns;
  };
  const face = (tx: number, ty: number): boolean => kind(tx, ty) === TileKind.Solid && !isBlocked(tx, ty);
  const thorns = (tx: number, ty: number): boolean => ty >= 0 && ty < H && kind(tx, ty) === TileKind.Thorns && !isBlocked(tx, ty);

  const floorSet = new Uint8Array(W * H);
  const airSet = new Uint8Array(W * H);
  const sources: Source[] = [];
  const sourceSeen = new Set<string>();
  const addSource = (ref: number, tx: number, start: Cell): void => {
    const k = `${ref},${tx},${start.tx},${start.ty}`;
    if (sourceSeen.has(k) || !passable(start.tx, start.ty)) return;
    sourceSeen.add(k);
    sources.push({ ref, tx, start });
  };
  for (const s of starts) {
    floorSet[s.ty * W + s.tx] = 1;
    addSource(s.ty, s.tx, { tx: s.tx, ty: s.ty - 1 });
  }

  const best = new Int8Array(W * H).fill(-1);
  const touched: number[] = [];
  const qCell: number[] = [];
  const qBudget: number[] = [];
  for (let si = 0; si < sources.length; si++) {
    const src = sources[si] as Source;
    const top = src.ref - b.reachRows;
    for (const i of touched) best[i] = -1;
    touched.length = 0;
    qCell.length = 0;
    qBudget.length = 0;
    const s0 = src.start.ty * W + src.start.tx;
    best[s0] = b.reachRows;
    touched.push(s0);
    qCell.push(s0);
    qBudget.push(b.reachRows);
    for (let qi = 0; qi < qCell.length; qi++) {
      const ci = qCell[qi] as number;
      const budget = qBudget[qi] as number;
      if ((best[ci] as number) > budget) continue;
      const tx = ci % W;
      const ty = (ci - tx) / W;
      airSet[ci] = 1;
      if (src.ref - (ty + 1) <= b.maxRise && !floorSet[ci + W] && standable(level, tx, ty + 1, b, isBlocked)) {
        floorSet[ci + W] = 1;
        addSource(ty + 1, tx, { tx, ty });
      }
      for (let side = -1; side <= 1; side += 2) {
        if (face(tx + side, ty)) {
          let y = ty;
          while (passable(tx, y - 1) && face(tx + side, y - 1)) {
            y--;
            airSet[y * W + tx] = 1;
          }
          addSource(y, tx, { tx, ty: y });
        }
        // The head or the feet grazing a Thorns cell beside a face (the feet no higher than a rise onto
        // row ty + 1 allows): slide on it from here.
        if (src.ref - (ty + 1) <= b.maxRise && ((thorns(tx, ty - 1) && face(tx + side, ty - 1)) || (thorns(tx, ty + 1) && face(tx + side, ty + 1)))) {
          addSource(ty + 1, tx, { tx, ty });
        }
      }
      for (let d = 0; d < 4; d++) {
        const nx = tx + (d === 0 ? 1 : d === 1 ? -1 : 0);
        const ny = ty + (d === 2 ? 1 : d === 3 ? -1 : 0);
        if (ny < top || !passable(nx, ny)) continue;
        if (ny < src.ref && Math.abs(nx - src.tx) > b.maxRun) continue;
        const nb = d === 3 ? budget - 1 : d === 2 ? Math.min(budget, b.airRows) : budget;
        if (nb < 0) continue;
        const ni = ny * W + nx;
        if ((best[ni] as number) >= nb) continue;
        if (best[ni] === -1) touched.push(ni);
        best[ni] = nb;
        qCell.push(ni);
        qBudget.push(nb);
      }
    }
  }
  const floors = new Set<string>();
  const air = new Set<string>();
  for (let i = 0; i < W * H; i++) {
    if (floorSet[i]) floors.add(key(i % W, Math.floor(i / W)));
    if (airSet[i]) air.add(key(i % W, Math.floor(i / W)));
  }
  return { floors, air };
}

/** The floor tile under the player start. */
export function startFloor(level: LevelData): Cell {
  return { tx: Math.floor(level.playerStart.x / level.tileSize), ty: level.playerStart.y / level.tileSize };
}

/**
 * §5.4 shrine chokepoint: the no-launch closure from the player start with every AbilityShrine rect as a
 * blocker (`shrines: false` leaves them open, the control). The course is sealed when this reaches no
 * spitter and not the goal: walls that reach the top edge or thorn-lined faces enclose it, since the
 * closure only moves the way the player can (open sky is not a path).
 */
export function chokepointClosure(level: LevelData, shrines = true): Closure {
  return noLaunchClosure(level, [startFloor(level)], { blockers: shrines ? level.abilityShrines : [] });
}

/** Whether a closure touches any cell of a world rect. */
export function touches(closure: Closure, r: Rect, tileSize: number): boolean {
  return rectCells(r, tileSize).some((c) => closure.air.has(key(c.tx, c.ty)));
}

/** Standable floor cells of a level (the closure's standing rule: Solid or OneWay, body clear, head safe). */
export function standableFloors(level: LevelData): Cell[] {
  const b = closureBounds(DEFAULT_TUNING, DEFAULT_WORLD_TUNING, level.tileSize);
  const out: Cell[] = [];
  for (let ty = 1; ty < level.heightTiles; ty++) {
    for (let tx = 0; tx < level.widthTiles; tx++) if (standable(level, tx, ty, b)) out.push({ tx, ty });
  }
  return out;
}

export interface StreamHit {
  spitter: number;
  tick: number;
  what: string;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  what: string;
}

/**
 * §5.4 fairness: fixed-aim seed flights (traced with the sim's SeedPool until they burst or expire at
 * seedLifetimeTicks) must not touch a player standing still anywhere: on any standable floor tile (feet
 * every `step` u, from the body's first overlap of the tile to its last; spots inside Solid or a spitter's
 * box are skipped) or at a checkpoint's respawn point. Returns the violations.
 */
export function streamFairness(level: LevelData, step = 2): StreamHit[] {
  const T = level.tileSize;
  const tun = DEFAULT_TUNING;
  const r = DEFAULT_WORLD_TUNING.seedRadius;
  const hw = tun.width / 2;
  const spitters = level.enemies.filter((e): e is SpitterDef => e.kind === 'thornSpitter').map(spitterBox);
  const buckets = new Map<number, Box[]>();
  const blockedAt = (x0: number, y0: number, x1: number, y1: number): boolean => {
    for (let ty = Math.floor(y0 / T); ty <= Math.floor((y1 - 1e-6) / T); ty++) {
      for (let tx = Math.floor(x0 / T); tx <= Math.floor((x1 - 1e-6) / T); tx++) if (tileAt(level, tx, ty) === TileKind.Solid) return true;
    }
    for (const s of spitters) if (x0 < s.x + s.w && x1 > s.x && y0 < s.y + s.h && y1 > s.y) return true;
    return false;
  };
  const addBox = (x: number, y: number, what: string, always = false): void => {
    const box: Box = { x0: x - hw, y0: y - tun.height, x1: x + hw, y1: y, what };
    if (!always && blockedAt(box.x0, box.y0, box.x1, box.y1)) return;
    const k = Math.floor(x / T);
    let list = buckets.get(k);
    if (!list) buckets.set(k, (list = []));
    list.push(box);
  };
  for (const f of standableFloors(level)) {
    for (let x = f.tx * T - hw + 1; x <= (f.tx + 1) * T + hw - 1; x += step) addBox(x, f.ty * T, `stand ${f.tx},${f.ty}`);
  }
  for (const c of level.checkpoints) addBox(c.x + c.w / 2, c.y + c.h, `checkpoint ${c.id} respawn`, true);
  const out: StreamHit[] = [];
  for (const { spitter, path } of fixedStreams(level)) {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1] as SeedPoint;
      const b = path[i] as SeedPoint;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2));
      let hit = false;
      for (let k = 0; k <= n && !hit; k++) {
        const x = a.x + ((b.x - a.x) * k) / n;
        const y = a.y + ((b.y - a.y) * k) / n;
        const c0 = Math.floor((x - r - hw) / T) - 1;
        const c1 = Math.floor((x + r + hw) / T) + 1;
        for (let col = c0; col <= c1 && !hit; col++) {
          for (const box of buckets.get(col) ?? []) {
            const qx = Math.max(box.x0, Math.min(x, box.x1));
            const qy = Math.max(box.y0, Math.min(y, box.y1));
            if ((x - qx) ** 2 + (y - qy) ** 2 <= r * r) {
              out.push({ spitter: spitter.id, tick: i, what: box.what });
              hit = true;
              break;
            }
          }
        }
      }
    }
  }
  return out;
}

function main(): void {
  const level = parseMapFile(readFileSync(MAP_PATH, 'utf8'));
  const T = level.tileSize;
  const b = closureBounds(DEFAULT_TUNING, DEFAULT_WORLD_TUNING, T);
  console.log(`closure bounds: ${JSON.stringify(b)}`);
  const sealed = chokepointClosure(level);
  const leaks = level.enemies.filter((e): e is SpitterDef => e.kind === 'thornSpitter' && touches(sealed, spitterBox(e), T)).map((s) => s.id);
  const goalLeak = level.goal ? touches(sealed, level.goal, T) : false;
  console.log(`chokepoint: ${sealed.floors.size} floors reached; spitters reached: [${leaks.join(', ')}]; goal reached: ${goalLeak}`);
  const open = chokepointClosure(level, false);
  const past = level.abilityShrines.map((s) => key((s.x + s.w) / T, (s.y + s.h) / T));
  console.log(`control (shrines open): ${open.floors.size} floors; the floor past each shrine reached: [${past.map((k) => `${k} ${open.floors.has(k)}`).join(', ')}]`);
  const fair = streamFairness(level);
  console.log(`stream fairness: ${fair.length} violations${fair.length ? `, e.g. ${JSON.stringify(fair.slice(0, 5))}` : ''}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
