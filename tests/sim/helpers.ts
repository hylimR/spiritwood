import { createInputFrame, type InputFrame } from '../../src/contracts/input.ts';
import type { LevelData } from '../../src/contracts/level.ts';
import type { SimEvent, SimEventType } from '../../src/contracts/sim.ts';
import { SimEventQueue } from '../../src/core/events.ts';
import { levelFromAscii } from '../../src/level/ascii.ts';
import { CollisionGrid } from '../../src/level/grid.ts';
import { PlayerController } from '../../src/sim/player.ts';
import { DEFAULT_TUNING, type PlayerTuning } from '../../src/sim/tuning.ts';
import { GameWorld, type WorldOptions } from '../../src/sim/world.ts';

export const T = 48;

/** An open room `w` tiles wide and `h` tall with a solid border and floor. */
export function room(w: number, h: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h - 1; y++) rows.push(`#${'.'.repeat(w - 2)}#`);
  rows.push('#'.repeat(w));
  return rows;
}

/** Mutable ASCII map builder: a solid border (sides + floor) around open space. */
export class MapBuilder {
  readonly w: number;
  readonly h: number;
  readonly cells: string[][];

  constructor(w: number, h: number, border = true) {
    this.w = w;
    this.h = h;
    this.cells = [];
    for (let y = 0; y < h; y++) {
      const row: string[] = [];
      for (let x = 0; x < w; x++) row.push(border && (x === 0 || x === w - 1 || y === h - 1) ? '#' : '.');
      this.cells.push(row);
    }
  }

  /** Fill the inclusive tile rect with `ch`. */
  fill(x0: number, y0: number, x1: number, y1: number, ch: string): this {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) (this.cells[y] as string[])[x] = ch;
    return this;
  }

  put(x: number, y: number, ch: string): this {
    return this.fill(x, y, x, y, ch);
  }

  rows(): string[] {
    return this.cells.map((r) => r.join(''));
  }
}

/** Plain copy of an event (queue records are reused). */
export function copyEvent(e: SimEvent): SimEvent {
  return { type: e.type, tick: e.tick, x: e.x, y: e.y, a: e.a, b: e.b, id: e.id };
}

/** Reset every field of `f` to neutral input (no movement, nothing held or pressed). */
export function neutral(f: InputFrame): InputFrame {
  f.moveX = 0;
  f.moveY = 0;
  f.jumpHeld = false;
  f.jumpPressed = false;
  f.dashHeld = false;
  f.dashPressed = false;
  f.launchHeld = false;
  f.launchPressed = false;
  f.launchReleased = false;
  return f;
}

/** A lone PlayerController on a grid (ASCII rows or a level), stepped tick by tick with a recorded event log. */
export class PlayerRig {
  readonly grid: CollisionGrid;
  readonly player: PlayerController;
  readonly events = new SimEventQueue(256);
  readonly log: SimEvent[] = [];
  readonly input: InputFrame = createInputFrame();
  tick = 0;

  constructor(rows: readonly string[] | LevelData, tuning: Partial<PlayerTuning> = {}) {
    const level = Array.isArray(rows) ? levelFromAscii(rows as readonly string[]) : (rows as LevelData);
    this.grid = CollisionGrid.fromLevel(level);
    this.player = new PlayerController(this.grid, { ...DEFAULT_TUNING, ...tuning });
    this.player.reset(level.playerStart.x, level.playerStart.y, 0);
  }

  /** One tick with `set` applied to a fresh neutral input. */
  step(set?: (f: InputFrame) => void): PlayerController {
    const f = neutral(this.input);
    set?.(f);
    this.tick++;
    this.player.step(f, this.tick, this.events);
    for (let i = 0; i < this.events.count; i++) this.log.push(copyEvent(this.events.get(i)));
    this.events.clear();
    return this.player;
  }

  run(ticks: number, set?: (f: InputFrame, i: number) => void): PlayerController {
    for (let i = 0; i < ticks; i++) this.step(set ? (f) => set(f, i) : undefined);
    return this.player;
  }

  /** Step until `done` (at most `max` ticks); returns the ticks taken or -1. */
  until(done: (p: PlayerController) => boolean, set?: (f: InputFrame) => void, max = 600): number {
    for (let i = 1; i <= max; i++) {
      this.step(set);
      if (done(this.player)) return i;
    }
    return -1;
  }

  eventsOf(type: SimEventType): SimEvent[] {
    return this.log.filter((e) => e.type === type);
  }

  clearLog(): void {
    this.log.length = 0;
  }
}

/** A GameWorld over ASCII rows with an event log drained every tick. */
export class WorldRig {
  readonly level: LevelData;
  readonly world: GameWorld;
  readonly log: SimEvent[] = [];
  readonly input: InputFrame = createInputFrame();

  constructor(rows: readonly string[] | LevelData, options: WorldOptions = {}) {
    this.level = Array.isArray(rows) ? levelFromAscii(rows as readonly string[]) : (rows as LevelData);
    this.world = new GameWorld(this.level, { eventCapacity: 256, ...options });
    this.drain();
  }

  /** One tick with `set` applied to a fresh neutral input (launch inputs included). */
  step(set?: (f: InputFrame) => void): GameWorld {
    const f = neutral(this.input);
    set?.(f);
    this.world.step(f);
    this.drain();
    return this.world;
  }

  run(ticks: number, set?: (f: InputFrame, i: number) => void): GameWorld {
    for (let i = 0; i < ticks; i++) this.step(set ? (f) => set(f, i) : undefined);
    return this.world;
  }

  until(done: (w: GameWorld) => boolean, set?: (f: InputFrame) => void, max = 600): number {
    for (let i = 1; i <= max; i++) {
      this.step(set);
      if (done(this.world)) return i;
    }
    return -1;
  }

  drain(): void {
    const q = this.world.events;
    for (let i = 0; i < q.count; i++) this.log.push(copyEvent(q.get(i)));
    q.clear();
  }

  eventsOf(type: SimEventType): SimEvent[] {
    return this.log.filter((e) => e.type === type);
  }
}
