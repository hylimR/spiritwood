import type { InputFrame } from '../../src/contracts/input.ts';
import { SimEventType } from '../../src/contracts/sim.ts';
import type { GameWorld } from '../../src/sim/world.ts';
import type { WorldRig } from './helpers.ts';

export type Dir = -1 | 0 | 1;

export interface ArcOptions {
  /** Double jump at the first apex (vy ≥ 0), or after this many ticks. */
  double?: boolean | number;
  /** Dash at the second apex (after the double jump), or this many ticks after the double jump. */
  dash?: boolean | number;
  /** Release jump after this many ticks (default: hold to the end). */
  holdTicks?: number;
  /** Stop early (e.g. on wall contact). */
  until?: (w: GameWorld) => boolean;
  max?: number;
}

/**
 * Scripted "player" for reach and playthrough tests: every action is a deterministic input timeline
 * whose phase changes are keyed to the sim state (edges, apexes, wall contact), never to wall time.
 */
export class Bot {
  readonly rig: WorldRig;
  /** Feet positions every tick (for PNG traces). */
  readonly trace: [number, number][] = [];

  constructor(rig: WorldRig) {
    this.rig = rig;
  }

  get w(): GameWorld {
    return this.rig.world;
  }

  get p(): GameWorld['player'] {
    return this.rig.world.player;
  }

  step(set?: (f: InputFrame) => void): void {
    this.rig.step(set);
    this.trace.push([this.p.x, this.p.y]);
    if (!this.p.alive) throw new BotError(this, 'the player died');
  }

  /** Hold `dir` (and optionally other input) until `done`, within `max` ticks. */
  hold(dir: Dir, done: (w: GameWorld) => boolean, max = 600, extra?: (f: InputFrame) => void): void {
    for (let i = 0; i < max; i++) {
      if (done(this.w)) return;
      this.step((f) => {
        f.moveX = dir;
        extra?.(f);
      });
    }
    if (!done(this.w)) throw new BotError(this, `hold(${dir}) did not finish within ${max} ticks`);
  }

  idle(ticks: number): void {
    for (let i = 0; i < ticks; i++) this.step();
  }

  /** Run toward feet x (stopping there when `stop`). */
  runTo(x: number, stop = false): void {
    const dir: Dir = x > this.p.x ? 1 : -1;
    this.hold(dir, () => (dir > 0 ? this.p.x >= x : this.p.x <= x));
    if (stop) this.settle();
  }

  /** Let horizontal speed die out on the ground. */
  settle(): void {
    this.hold(0, () => this.p.grounded && this.p.vx === 0, 120);
  }

  /** Wait (holding `dir`) until grounded. */
  land(dir: Dir = 0, max = 400): void {
    this.hold(dir, () => this.p.grounded, max);
  }

  /**
   * One jump arc holding `dir`: optional double jump (at the apex) and dash (at the second apex).
   * Ends when grounded (or `until`).
   */
  arc(dir: Dir, o: ArcOptions = {}): void {
    const max = o.max ?? 400;
    let t = 0;
    let doubled = false;
    let doubleTick = -1;
    let dashed = false;
    let prevVy = this.p.vy;
    const airJumps = this.rig.eventsOf(SimEventType.AirJump).length;
    for (; t < max; t++) {
      const p = this.p;
      if (t > 0 && (p.grounded || o.until?.(this.w))) return;
      let jumpPressed = t === 0;
      let dashPressed = false;
      if (o.double !== undefined && o.double !== false && !doubled && t > 0) {
        const due = typeof o.double === 'number' ? t >= o.double : p.vy >= 0;
        if (due) {
          jumpPressed = true;
          doubled = true;
          doubleTick = t;
        }
      } else if (o.dash !== undefined && o.dash !== false && doubled && !dashed && t > doubleTick) {
        const risen = this.rig.eventsOf(SimEventType.AirJump).length > airJumps;
        const due = typeof o.dash === 'number' ? t - doubleTick >= o.dash : risen && p.vy >= 0 && prevVy < 0;
        if (due) {
          dashPressed = true;
          dashed = true;
        }
      }
      prevVy = p.vy;
      const held = o.holdTicks === undefined || t < o.holdTicks;
      this.step((f) => {
        f.moveX = dir;
        f.jumpPressed = jumpPressed;
        f.jumpHeld = held || jumpPressed;
        f.dashPressed = dashPressed;
      });
    }
    throw new BotError(this, `arc(${dir}) did not land within ${max} ticks`);
  }

  /** Run to the takeoff x (last grounded stretch before an edge), then jump. */
  leap(takeoffX: number, dir: Dir, o: ArcOptions = {}): void {
    this.hold(dir, () => (dir > 0 ? this.p.x >= takeoffX : this.p.x <= takeoffX));
    this.arc(dir, o);
  }

  /**
   * Single-wall climb: slide on the wall on side `wall`, wall-jump, steer back into it, repeat until
   * the feet are above `topY` and the player stands on something (or `until`).
   */
  climb(wall: -1 | 1, topY: number, max = 1200): void {
    for (let t = 0; t < max; t++) {
      const p = this.p;
      if (p.grounded && p.y <= topY) return;
      const press = p.mode === 'wallSlide' && p.wallDir === wall;
      this.step((f) => {
        f.moveX = wall;
        f.jumpPressed = press;
        f.jumpHeld = true;
      });
    }
    throw new BotError(this, `climb(${wall}) did not reach y ≤ ${topY} within ${max} ticks`);
  }

  /** Down + jump on a one-way platform. */
  dropThrough(): void {
    this.step((f) => {
      f.moveY = 1;
      f.jumpPressed = true;
    });
  }
}

export class BotError extends Error {
  override name = 'BotError';

  constructor(bot: Bot, message: string) {
    const p = bot.p;
    super(`${message} at tick ${bot.w.tick}: feet (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) = tile (${Math.floor(p.x / 48)}, ${(p.y / 48).toFixed(2)}), v (${p.vx.toFixed(0)}, ${p.vy.toFixed(0)}), mode ${p.mode}`);
  }
}
