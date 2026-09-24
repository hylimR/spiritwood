import type { LevelData } from '../../src/contracts/level.ts';
import type {
  CameraView, CheckpointView, EnemyView, GoalView, OrbView, PlayerView, SimEvent, SimEventQueueView, SimView,
} from '../../src/contracts/sim.ts';
import { VIEW_H } from '../../src/config.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';

export { levelFromAscii } from '../../src/level/ascii.ts';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface FakeSim extends SimView {
  player: Mutable<PlayerView>;
  camera: Mutable<CameraView>;
  events: FakeEventQueue;
  tick: number;
  fade: number;
  prevFade: number;
  elapsed: number;
  completed: boolean;
  orbsCollected: number;
}

export class FakeEventQueue implements SimEventQueueView {
  readonly items: SimEvent[] = [];
  get count(): number {
    return this.items.length;
  }
  get(index: number): SimEvent {
    return this.items[index] as SimEvent;
  }
  push(e: Partial<SimEvent> & Pick<SimEvent, 'type'>): void {
    this.items.push({ tick: 0, x: 0, y: 0, a: 0, b: 0, id: -1, ...e });
  }
  clear(): void {
    this.items.length = 0;
  }
}

/**
 * A static, mutable SimView over `level` for render-side tests (WORLD/PIPE never depend on SIM's
 * implementation): player idle at playerStart, camera centred on it, entities at their spawns.
 */
export function createFakeSimView(level: LevelData, viewW = VIEW_H * (16 / 9), viewH = VIEW_H): FakeSim {
  const p = level.playerStart;
  const player: Mutable<PlayerView> = {
    x: p.x, y: p.y, prevX: p.x, prevY: p.y, vx: 0, vy: 0,
    width: DEFAULT_TUNING.width, height: DEFAULT_TUNING.height, facing: 1, mode: 'ground', grounded: true,
    wallDir: 0, airJumpsLeft: DEFAULT_TUNING.airJumps, airDashesLeft: DEFAULT_TUNING.airDashes,
    dashProgress: 0, dashDir: 0, modeTicks: 0, airTicks: 0, runDistance: 0, inputX: 0, alive: true,
    deadTicks: -1, visible: true, warpTick: -1,
  };
  const camera: Mutable<CameraView> = {
    x: p.x, y: p.y - viewH / 4, prevX: p.x, prevY: p.y - viewH / 4, zoom: 1, prevZoom: 1, snapTick: -1, viewW, viewH,
  };
  const orbs: OrbView[] = level.orbs.map((o) => ({
    id: o.id, x: o.x, y: o.y, prevX: o.x, prevY: o.y, value: o.value,
    radius: DEFAULT_WORLD_TUNING.orbCollectRadius, collected: false, collectedTick: -1,
  }));
  const checkpoints: CheckpointView[] = level.checkpoints.map((c) => ({
    id: c.id, x: c.x, y: c.y, w: c.w, h: c.h, active: false, activatedTick: -1,
  }));
  const enemies: EnemyView[] = level.enemies.map((e) => ({
    id: e.id, x: e.x, y: e.y, prevX: e.x, prevY: e.y, vx: e.speed, facing: 1,
    width: DEFAULT_WORLD_TUNING.enemyWidth, height: DEFAULT_WORLD_TUNING.enemyHeight,
    mode: 'patrol', modeTicks: 0, modeDuration: 0,
  }));
  const goal: GoalView | null = level.goal ? { ...level.goal, reached: false } : null;
  return {
    tick: 0, level, player, orbs, checkpoints, enemies, goal, camera, events: new FakeEventQueue(),
    orbsCollected: 0, orbsTotal: level.orbs.length, fade: 0, prevFade: 0, elapsed: 0, completed: false,
  };
}
