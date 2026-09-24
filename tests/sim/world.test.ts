import { describe, expect, test } from 'vitest';
import { KILL_MARGIN, SIM_DT } from '../../src/config.ts';
import type { InputFrame } from '../../src/contracts/input.ts';
import type { CrawlerDef } from '../../src/contracts/level.ts';
import { DeathCause, SimEventType } from '../../src/contracts/sim.ts';
import { levelFromAscii } from '../../src/level/ascii.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';
import { GameWorld } from '../../src/sim/world.ts';
import { MapBuilder, T, WorldRig } from './helpers.ts';

const wt = DEFAULT_WORLD_TUNING;
const H = DEFAULT_TUNING.height;

const right = (f: InputFrame): void => {
  f.moveX = 1;
};

describe('construction and SimView guarantees', () => {
  const rows = new MapBuilder(40, 12)
    .put(3, 10, 'P').put(8, 9, 'o').put(12, 9, 'o').put(15, 10, 'C').put(25, 10, 'C')
    .fill(28, 10, 33, 10, 'E').put(36, 10, 'G').rows();

  test('player at playerStart, camera snapped, entities in LevelData order', () => {
    const rig = new WorldRig(rows);
    const w = rig.world;
    expect(w.player.x).toBe(w.level.playerStart.x);
    expect(w.player.y).toBe(w.level.playerStart.y);
    expect(w.player.grounded).toBe(true);
    expect(w.camera.prevX).toBe(w.camera.x);
    expect(w.camera.snapTick).toBe(0);
    expect(w.orbsTotal).toBe(2);
    expect(w.orbs.map((o) => o.id)).toEqual(w.level.orbs.map((o) => o.id));
    expect(w.orbs[0]?.radius).toBe(wt.orbCollectRadius);
    expect(w.checkpoints.map((c) => c.id)).toEqual([0, 1]);
    expect(w.enemies.map((e) => e.id)).toEqual([0]);
    expect(w.enemies[0]?.modeDuration).toBe(0);
    expect(w.goal).not.toBeNull();
    expect(w.tick).toBe(0);
    expect(rig.log).toHaveLength(0);
  });

  test('options merge over the defaults once', () => {
    const w = new GameWorld(levelFromAscii(rows), {
      tuning: { maxRunSpeed: 300 }, camera: { deadZoneW: 10 }, world: { stunTicks: 5 }, viewW: 1000, viewH: 800,
    });
    expect(w.player.tuning.maxRunSpeed).toBe(300);
    expect(w.player.tuning.jumpHeight).toBe(DEFAULT_TUNING.jumpHeight);
    expect(w.camera.tuning.deadZoneW).toBe(10);
    expect(w.worldTuning.stunTicks).toBe(5);
    expect(w.camera.viewW).toBe(1000);
    expect(w.camera.viewH).toBe(800);
    w.setViewSize(1440, 1080);
    expect(w.camera.viewW).toBe(1440);
  });

  test('reset keeps array and element identity', () => {
    const rig = new WorldRig(rows);
    const w = rig.world;
    const orbs = w.orbs;
    const orb0 = w.orbs[0];
    const enemy0 = w.enemies[0];
    const cp0 = w.checkpoints[0];
    const goal = w.goal;
    rig.run(120, right);
    w.reset();
    expect(w.orbs).toBe(orbs);
    expect(w.orbs[0]).toBe(orb0);
    expect(w.enemies[0]).toBe(enemy0);
    expect(w.checkpoints[0]).toBe(cp0);
    expect(w.goal).toBe(goal);
  });
});

describe('death timeline (§5.3)', () => {
  /** Thorn pit directly right of the start; checkpoint optional. */
  function pit(withCheckpoint: boolean): WorldRig {
    const m = new MapBuilder(30, 12).put(3, 10, 'P').fill(8, 11, 12, 11, '^').put(20, 9, 'o');
    if (withCheckpoint) m.put(5, 10, 'C');
    return new WorldRig(m.rows());
  }

  test('fade, visibility, respawn at playerStart, events, warpTick', () => {
    const rig = pit(false);
    const w = rig.world;
    const D = rig.until((x) => !x.player.alive, right, 200);
    expect(D).toBeGreaterThan(0);
    const deathTick = w.tick;
    const died = rig.eventsOf(SimEventType.Died);
    expect(died).toHaveLength(1);
    expect(died[0]?.a).toBe(DeathCause.Thorns);
    expect(died[0]?.tick).toBe(deathTick);
    expect(died[0]?.y).toBe(w.player.y - H / 2);
    expect(w.fade).toBe(0);
    expect(w.player.visible).toBe(true);
    expect(w.player.deadTicks).toBe(0);
    const deathX = w.player.x;
    for (let k = 1; k < wt.dyingTicks; k++) {
      rig.step(right);
      expect(w.player.deadTicks).toBe(k);
      expect(w.fade).toBeCloseTo(Math.min(1, k / wt.fadeOutTicks), 12);
      expect(w.player.visible).toBe(k < wt.deathHideTicks);
      expect(w.player.x).toBe(deathX);
      expect(w.player.alive).toBe(false);
    }
    rig.step(right);
    const R = w.tick;
    expect(R - deathTick).toBe(wt.dyingTicks);
    expect(w.player.alive).toBe(true);
    expect(w.player.visible).toBe(true);
    expect(w.player.x).toBe(w.level.playerStart.x);
    expect(w.player.y).toBe(w.level.playerStart.y);
    expect(w.player.prevX).toBe(w.player.x);
    expect(w.player.warpTick).toBe(R);
    expect(w.camera.snapTick).toBe(R);
    expect(w.fade).toBe(1);
    const respawned = rig.eventsOf(SimEventType.Respawned);
    expect(respawned).toHaveLength(1);
    expect(respawned[0]).toMatchObject({ tick: R, x: w.level.playerStart.x, y: w.level.playerStart.y, id: -1 });
    for (let k = 1; k <= wt.fadeInTicks + 2; k++) {
      rig.step();
      expect(w.fade).toBeCloseTo(Math.max(0, 1 - k / wt.fadeInTicks), 12);
      expect(w.prevFade).toBeCloseTo(Math.max(0, 1 - (k - 1) / wt.fadeInTicks), 12);
    }
  });

  test('dying again during the fade-in continues the fade from where it was', () => {
    const rig = pit(false);
    const w = rig.world;
    w.respawn();
    rig.step();
    rig.run(wt.dyingTicks);
    expect(w.player.alive).toBe(true);
    rig.run(Math.floor(wt.fadeInTicks / 2));
    const mid = w.fade;
    expect(mid).toBeGreaterThan(0.3);
    w.respawn();
    rig.step();
    expect(w.player.alive).toBe(false);
    expect(w.fade).toBe(mid);
    let prev = w.fade;
    for (let k = 1; k < wt.dyingTicks; k++) {
      rig.step();
      expect(w.fade).toBeGreaterThanOrEqual(prev);
      prev = w.fade;
    }
    expect(prev).toBe(1);
  });

  test('respawns at the active checkpoint bottom-centre', () => {
    const rig = pit(true);
    const w = rig.world;
    rig.until((x) => !x.player.alive, right, 200);
    rig.run(wt.dyingTicks);
    const c = w.level.checkpoints[0];
    expect(c).toBeDefined();
    if (!c) return;
    expect(w.player.x).toBe(c.x + c.w / 2);
    expect(w.player.y).toBe(c.y + c.h);
    expect(rig.eventsOf(SimEventType.Respawned)[0]?.id).toBe(c.id);
  });

  test('input is ignored while dying and nothing kills a dead player', () => {
    const rig = pit(false);
    const w = rig.world;
    rig.until((x) => !x.player.alive, right, 200);
    w.respawn();
    rig.run(wt.dyingTicks - 1, (f) => {
      f.moveX = -1;
      f.jumpPressed = true;
      f.dashPressed = true;
    });
    expect(rig.eventsOf(SimEventType.Died)).toHaveLength(1);
    expect(rig.eventsOf(SimEventType.Jump)).toHaveLength(0);
    expect(rig.eventsOf(SimEventType.Dash)).toHaveLength(0);
    rig.step();
    expect(w.player.alive).toBe(true);
    rig.run(3);
    expect(rig.eventsOf(SimEventType.Died)).toHaveLength(1);
  });

  test('respawn() queues a Debug death for the next step', () => {
    const rig = pit(false);
    const w = rig.world;
    rig.run(5);
    w.respawn();
    expect(w.player.alive).toBe(true);
    rig.step();
    expect(w.player.alive).toBe(false);
    expect(rig.eventsOf(SimEventType.Died)[0]?.a).toBe(DeathCause.Debug);
  });

  test('falling past the kill plane kills', () => {
    const m = new MapBuilder(20, 10, false).fill(0, 9, 5, 9, '#').put(2, 8, 'P');
    const rig = new WorldRig(m.rows());
    const w = rig.world;
    rig.until((x) => !x.player.alive, right, 400);
    const died = rig.eventsOf(SimEventType.Died);
    expect(died).toHaveLength(1);
    expect(died[0]?.a).toBe(DeathCause.Fall);
    expect(w.player.y).toBeGreaterThan(w.level.pxHeight + KILL_MARGIN);
  });

  test('uncollected orbs return to their spawns un-magnetised; collected ones stay collected', () => {
    const m = new MapBuilder(40, 12).put(3, 10, 'P').put(5, 9, 'o').put(12, 9, 'o');
    const rig = new WorldRig(m.rows());
    const w = rig.world;
    const drifting = w.orbs[1];
    if (!drifting) throw new Error('fixture');
    rig.until(() => drifting.x !== drifting.prevX, right, 300);
    expect(w.orbs[0]?.collected).toBe(true);
    expect(drifting.collected).toBe(false);
    w.respawn();
    rig.step();
    expect(w.player.alive).toBe(false);
    const frozenX = drifting.x;
    rig.run(wt.dyingTicks - 1);
    expect(drifting.x).toBe(frozenX);
    rig.step();
    expect(w.player.alive).toBe(true);
    expect(w.orbs[0]?.collected).toBe(true);
    expect(w.orbsCollected).toBe(1);
    expect(drifting.x).toBe(w.level.orbs[1]?.x);
    expect(drifting.y).toBe(w.level.orbs[1]?.y);
    expect(drifting.prevX).toBe(w.level.orbs[1]?.x);
    w.teleport(30 * T, 11 * T);
    rig.run(10);
    expect(drifting.x).toBe(w.level.orbs[1]?.x);
  });
});

describe('orbs', () => {
  test('magnetise within the radius, accelerate toward the player centre, collect once', () => {
    const m = new MapBuilder(40, 12).put(3, 10, 'P').put(9, 8, 'o');
    const rig = new WorldRig(m.rows());
    const w = rig.world;
    const orb = w.orbs[0];
    if (!orb) throw new Error('fixture');
    rig.until(() => orb.x !== orb.prevX || orb.collected, right, 120);
    const p = w.player;
    const dx = orb.prevX - p.prevX;
    const dy = orb.prevY - (p.prevY - H / 2);
    expect(Math.hypot(dx, dy)).toBeLessThanOrEqual(wt.orbMagnetRadius + DEFAULT_TUNING.maxRunSpeed * SIM_DT);
    const collectedAt = rig.until(() => orb.collected, right, 60);
    expect(collectedAt).toBeGreaterThan(0);
    const ev = rig.eventsOf(SimEventType.OrbCollected);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ id: orb.id, a: orb.value, x: orb.x, y: orb.y, tick: w.tick });
    expect(orb.collectedTick).toBe(w.tick);
    expect(w.orbsCollected).toBe(1);
    rig.run(30, right);
    expect(rig.eventsOf(SimEventType.OrbCollected)).toHaveLength(1);
  });

  test('magnetised orbs obey the acceleration and speed caps', () => {
    const m = new MapBuilder(40, 12).put(3, 10, 'P').put(5, 8, 'o');
    const rig = new WorldRig(m.rows());
    const orb = rig.world.orbs[0];
    if (!orb) throw new Error('fixture');
    rig.step();
    const v1 = Math.hypot(orb.x - orb.prevX, orb.y - orb.prevY) / SIM_DT;
    expect(v1).toBeGreaterThan(0);
    expect(v1).toBeCloseTo(wt.orbMagnetAccel * SIM_DT, 9);
    for (let i = 0; i < 30 && !orb.collected; i++) {
      rig.step();
      const v = Math.hypot(orb.x - orb.prevX, orb.y - orb.prevY) / SIM_DT;
      expect(v).toBeLessThanOrEqual(wt.orbMaxSpeed + 1e-9);
    }
    expect(orb.collected).toBe(true);
  });
});

describe('checkpoints', () => {
  test('latest touched wins; the event fires only on a change', () => {
    const m = new MapBuilder(40, 12).put(3, 10, 'P').put(8, 10, 'C').put(16, 10, 'C');
    const rig = new WorldRig(m.rows());
    const w = rig.world;
    rig.until((x) => x.checkpoints[0]?.active === true, right, 120);
    const first = rig.eventsOf(SimEventType.CheckpointActivated);
    expect(first).toHaveLength(1);
    const c0 = w.level.checkpoints[0];
    expect(first[0]).toMatchObject({ id: 0, x: (c0?.x ?? 0) + (c0?.w ?? 0) / 2, y: (c0?.y ?? 0) + (c0?.h ?? 0) });
    expect(w.checkpoints[0]?.activatedTick).toBe(w.tick);
    rig.run(5);
    expect(rig.eventsOf(SimEventType.CheckpointActivated)).toHaveLength(1);
    rig.until((x) => x.checkpoints[1]?.active === true, right, 120);
    expect(w.checkpoints[0]?.active).toBe(false);
    expect(w.checkpoints[0]?.activatedTick).toBeGreaterThan(0);
    rig.until((x) => x.checkpoints[0]?.active === true, (f) => {
      f.moveX = -1;
    }, 120);
    const all = rig.eventsOf(SimEventType.CheckpointActivated).map((e) => e.id);
    expect(all).toEqual([0, 1, 0]);
    expect(w.checkpoints[1]?.active).toBe(false);
  });
});

describe('enemies', () => {
  /** A crawler patrolling columns 10–19 on flat ground. */
  const rows = new MapBuilder(40, 14).put(3, 12, 'P').fill(10, 12, 19, 12, 'E').rows();

  test('patrol turns at the range ends', () => {
    const rig = new WorldRig(rows);
    const e = rig.world.enemies[0];
    const def = rig.world.level.enemies[0] as CrawlerDef | undefined;
    if (!e || !def) throw new Error('fixture');
    let minX = e.x;
    let maxX = e.x;
    let turns = 0;
    let facing = e.facing;
    for (let i = 0; i < 1200; i++) {
      rig.step();
      minX = Math.min(minX, e.x);
      maxX = Math.max(maxX, e.x);
      if (e.facing !== facing) turns++;
      facing = e.facing;
      expect(e.vx).toBe(e.facing * def.speed);
    }
    expect(minX).toBe(def.patrolMinX);
    expect(maxX).toBe(def.patrolMaxX);
    expect(turns).toBeGreaterThanOrEqual(3);
    expect(e.y).toBe(def.y);
  });

  test('patrol turns at walls and ledges inside a wide range', () => {
    const level = levelFromAscii(new MapBuilder(40, 14).put(3, 12, 'P').fill(12, 11, 12, 12, '#').fill(16, 13, 30, 13, '.').rows());
    level.enemies.push({ id: 0, kind: 'gloomcrawler', x: 14 * T, y: 13 * T, patrolMinX: 2 * T, patrolMaxX: 35 * T, speed: 200 });
    const rig = new WorldRig(level);
    const e = rig.world.enemies[0];
    if (!e) throw new Error('fixture');
    let minX = e.x;
    let maxX = e.x;
    for (let i = 0; i < 1200; i++) {
      rig.step();
      minX = Math.min(minX, e.x);
      maxX = Math.max(maxX, e.x);
    }
    expect(minX - e.width / 2).toBe(13 * T);
    expect(maxX + e.width / 2).toBe(16 * T);
  });

  test('an enemy with nowhere to walk stands guard instead of turning every tick', () => {
    // A single `E` is narrower than the crawler (patrolMinX = patrolMaxX), and a speed-0 crawler.
    const level = levelFromAscii(new MapBuilder(40, 14).put(3, 12, 'P').put(20, 12, 'E').fill(28, 12, 33, 12, 'E').rows());
    const narrow = level.enemies[0] as CrawlerDef | undefined;
    const still = level.enemies[1] as CrawlerDef | undefined;
    if (!narrow || !still) throw new Error('fixture');
    expect(narrow.patrolMinX).toBe(narrow.patrolMaxX);
    still.speed = 0;
    const rig = new WorldRig(level);
    for (const e of rig.world.enemies) expect(e.vx).toBe(0);
    rig.run(120);
    for (let i = 0; i < rig.world.enemies.length; i++) {
      const e = rig.world.enemies[i];
      const def = level.enemies[i] as CrawlerDef | undefined;
      expect(e?.x).toBe(def?.x);
      expect(e?.vx).toBe(0);
      expect(e?.facing).toBe(1);
      expect(e?.harmful).toBe(true);
    }
  });

  test('side contact kills (DeathCause.Enemy)', () => {
    const rig = new WorldRig(rows);
    rig.until((x) => !x.player.alive, right, 300);
    expect(rig.eventsOf(SimEventType.Died)[0]?.a).toBe(DeathCause.Enemy);
  });

  test('stomp from above: bounce, stun, harmless, deferred re-form', () => {
    const level = levelFromAscii(rows);
    const rig = new WorldRig(level, { world: { stunTicks: 30 } });
    const w = rig.world;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    w.teleport(e.x, e.y - e.height - 3 * T);
    rig.until(() => e.mode === 'stunned', undefined, 120);
    expect(w.player.alive).toBe(true);
    expect(w.player.vy).toBeLessThan(0);
    const stomped = rig.eventsOf(SimEventType.EnemyStomped);
    expect(stomped).toHaveLength(1);
    expect(stomped[0]).toMatchObject({ id: e.id, x: e.x, y: e.y - e.height });
    expect(e.modeDuration).toBe(30);
    expect(e.modeTicks).toBe(0);
    expect(e.harmful).toBe(false);
    // Stand inside the stunned enemy: harmless, and re-forming waits until the player leaves.
    const sx = e.x;
    w.teleport(sx, e.y);
    rig.run(40);
    expect(w.player.alive).toBe(true);
    expect(e.mode).toBe('stunned');
    expect(e.x).toBe(sx);
    rig.until(() => e.mode === 'patrol', (f) => {
      f.moveX = -1;
    }, 120);
    const reformed = rig.eventsOf(SimEventType.EnemyReformed);
    expect(reformed).toHaveLength(1);
    expect(reformed[0]).toMatchObject({ id: e.id, x: sx, y: e.y });
    expect(w.player.alive).toBe(true);
  });

  test('stomp bounce height is cuttable like a jump', () => {
    const heights: number[] = [];
    for (const held of [true, false]) {
      const rig = new WorldRig(rows);
      const w = rig.world;
      const e = w.enemies[0];
      if (!e) throw new Error('fixture');
      w.teleport(e.x, e.y - e.height - 3 * T);
      rig.until(() => e.mode === 'stunned', (f) => {
        f.jumpHeld = held;
      }, 120);
      const y0 = w.player.y;
      let minY = y0;
      for (let i = 0; i < 60; i++) {
        rig.step((f) => {
          f.jumpHeld = held;
        });
        minY = Math.min(minY, w.player.y);
      }
      heights.push(y0 - minY);
    }
    const g = w0Gravity();
    const full = (wt.stompBounceVelocity * wt.stompBounceVelocity) / (2 * g);
    expect(Math.abs((heights[0] as number) - full)).toBeLessThan(10);
    expect(heights[1]).toBeLessThan((heights[0] as number) / 2);
  });

  test('enemies reset to spawn on respawn', () => {
    const rig = new WorldRig(rows);
    const w = rig.world;
    const e = w.enemies[0];
    const def = w.level.enemies[0] as CrawlerDef | undefined;
    if (!e || !def) throw new Error('fixture');
    rig.run(100);
    expect(e.x).not.toBe(def.x);
    w.respawn();
    rig.run(wt.dyingTicks + 1);
    expect(w.player.alive).toBe(true);
    expect(e.mode).toBe('patrol');
    expect(Math.abs(e.x - def.x)).toBeLessThanOrEqual(def.speed * SIM_DT * 2);
  });
});

function w0Gravity(): number {
  return (2 * DEFAULT_TUNING.jumpHeight) / (DEFAULT_TUNING.jumpTimeToApex * DEFAULT_TUNING.jumpTimeToApex);
}

describe('goal and timer', () => {
  const rows = new MapBuilder(30, 12).put(3, 10, 'P').put(12, 10, 'G').rows();

  test('the timer starts on the first non-neutral input and stops at the goal; GoalReached fires once', () => {
    const rig = new WorldRig(rows);
    const w = rig.world;
    rig.run(30);
    expect(w.elapsed).toBe(0);
    rig.step(right);
    expect(w.elapsed).toBeCloseTo(SIM_DT, 12);
    const ticks = rig.until((x) => x.completed, right, 300);
    expect(ticks).toBeGreaterThan(0);
    const goal = rig.eventsOf(SimEventType.GoalReached);
    expect(goal).toHaveLength(1);
    expect(goal[0]?.a).toBeCloseTo((ticks + 1) * SIM_DT, 9);
    expect(w.elapsed).toBeCloseTo((ticks + 1) * SIM_DT, 9);
    expect(w.goal?.reached).toBe(true);
    const at = w.elapsed;
    rig.run(60, right);
    expect(w.elapsed).toBe(at);
    expect(rig.eventsOf(SimEventType.GoalReached)).toHaveLength(1);
    const x = w.player.x;
    rig.run(10, (f) => {
      f.moveX = -1;
    });
    expect(w.player.x).toBeLessThan(x);
  });
});

describe('reset and teleport', () => {
  const rows = new MapBuilder(40, 12).put(3, 10, 'P').put(8, 9, 'o').put(12, 10, 'C').fill(20, 10, 25, 10, 'E').put(34, 10, 'G').rows();

  test('reset clears the queue, then emits Reset; everything back to the start', () => {
    const rig = new WorldRig(rows);
    const w = rig.world;
    rig.run(90, right);
    expect(w.orbsCollected).toBe(1);
    expect(w.checkpoints[0]?.active).toBe(true);
    w.events.push(SimEventType.Jump, w.tick, 0, 0);
    w.reset();
    expect(w.events.count).toBe(1);
    const e = w.events.get(0);
    expect(e.type).toBe(SimEventType.Reset);
    expect(e.x).toBe(w.level.playerStart.x);
    expect(e.y).toBe(w.level.playerStart.y);
    expect(w.orbsCollected).toBe(0);
    expect(w.orbs[0]?.collected).toBe(false);
    expect(w.orbs[0]?.collectedTick).toBe(-1);
    expect(w.checkpoints[0]?.active).toBe(false);
    expect(w.checkpoints[0]?.activatedTick).toBe(-1);
    expect(w.elapsed).toBe(0);
    expect(w.completed).toBe(false);
    expect(w.player.x).toBe(w.level.playerStart.x);
    expect(w.player.warpTick).toBe(w.tick);
    expect(w.camera.snapTick).toBe(w.tick);
    expect(w.enemies[0]?.x).toBe(w.level.enemies[0]?.x);
    const tick = w.tick;
    rig.drain();
    rig.step();
    expect(w.tick).toBe(tick + 1);
  });

  test('after reset() the same inputs replay exactly like a fresh world (restart from scratch)', () => {
    const script = (f: InputFrame, i: number): void => {
      // A neutral-direction dash first: its direction comes from `facing`.
      f.dashPressed = i === 5;
      f.jumpPressed = i === 40 || i === 70;
      f.jumpHeld = i >= 40 && i < 90;
      f.moveX = i >= 100 && i < 160 ? 1 : 0;
    };
    const fresh = new WorldRig(rows);
    const used = new WorldRig(rows);
    used.run(60, (f, i) => {
      f.moveX = i < 50 ? 1 : -1;
      f.jumpPressed = i === 10;
    });
    expect(used.world.player.facing).toBe(-1);
    used.world.reset();
    used.log.length = 0;
    used.drain();
    fresh.log.length = 0;
    fresh.run(200, script);
    used.run(200, script);
    const a = fresh.world;
    const b = used.world;
    for (const k of ['x', 'y', 'vx', 'vy', 'facing', 'mode', 'airJumpsLeft', 'airDashesLeft', 'dashDir', 'runDistance'] as const) {
      expect(b.player[k], k).toBe(a.player[k]);
    }
    expect(b.camera.x).toBe(a.camera.x);
    expect(b.camera.y).toBe(a.camera.y);
    expect(b.enemies[0]?.x).toBe(a.enemies[0]?.x);
    expect(b.elapsed).toBe(a.elapsed);
    const strip = (log: WorldRig['log']): unknown[] => log.map((e) => ({ ...e, tick: 0 })).filter((e) => e.type !== SimEventType.Reset);
    expect(strip(used.log)).toEqual(strip(fresh.log));
  });

  test('teleport moves the feet, zeroes velocity, snaps the camera and emits Teleported', () => {
    const rig = new WorldRig(rows);
    const w = rig.world;
    rig.run(20, right);
    w.teleport(30 * T, 11 * T);
    expect(w.player.x).toBe(30 * T);
    expect(w.player.y).toBe(11 * T);
    expect(w.player.prevX).toBe(30 * T);
    expect(w.player.vx).toBe(0);
    expect(w.player.warpTick).toBe(w.tick);
    expect(w.camera.snapTick).toBe(w.tick);
    expect(w.camera.prevX).toBe(w.camera.x);
    const tp = w.events.get(w.events.count - 1);
    expect(tp).toMatchObject({ type: SimEventType.Teleported, x: 30 * T, y: 11 * T });
  });
});
