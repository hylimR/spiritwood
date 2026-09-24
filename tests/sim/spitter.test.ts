import { describe, expect, test } from 'vitest';
import { SIM_DT } from '../../src/config.ts';
import type { LevelData, SpitterDef } from '../../src/contracts/level.ts';
import { Ability, DeathCause, SimEventType } from '../../src/contracts/sim.ts';
import { levelFromAscii } from '../../src/level/ascii.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';
import { MapBuilder, T, WorldRig } from './helpers.ts';
import { anchorSeed, letGo, press } from './launchKit.ts';

const wt = DEFAULT_WORLD_TUNING;
const W = wt.spitterWindupTicks;
const H = DEFAULT_TUNING.height;

/** A 60 × 30 room: the player at column 20, a spitter glyph at column `sx` (both on the floor). */
function level(glyph: 'S' | 'U', sx: number, patch: Partial<SpitterDef> = {}, px = 20): LevelData {
  const l = levelFromAscii(new MapBuilder(60, 30).put(px, 28, 'P').put(sx, 28, glyph).rows());
  const s = l.enemies[0] as SpitterDef;
  Object.assign(s, patch);
  return l;
}

function ticksOf(rig: WorldRig, type: SimEventType): number[] {
  return rig.eventsOf(type).map((e) => e.tick);
}

describe('Thorn Spitter cycle (§5.3)', () => {
  test('phase 0: SpitterWindup on the first active step, SeedFired W ticks later, shots exactly period apart', () => {
    const period = 90;
    const rig = new WorldRig(level('U', 24, { period }));
    const w = rig.world;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    expect(e).toMatchObject({ kind: 'thornSpitter', mode: 'idle', width: wt.spitterWidth, height: wt.spitterHeight });
    rig.step();
    expect(e).toMatchObject({ mode: 'windup', modeTicks: 0, modeDuration: W });
    rig.run(3 * period);
    const A = 1;
    expect(ticksOf(rig, SimEventType.SpitterWindup)).toEqual([A, A + period, A + 2 * period, A + 3 * period]);
    expect(ticksOf(rig, SimEventType.SeedFired)).toEqual([A + W, A + period + W, A + 2 * period + W]);
    const wind = rig.eventsOf(SimEventType.SpitterWindup)[0];
    expect(wind).toMatchObject({ x: e.x, y: e.y - wt.spitterMuzzleHeight, a: W, id: e.id });
  });

  test('phase > 0 (taken mod period): cooldown for the phase, then the cycle', () => {
    for (const [phase, period] of [[25, 90], [115, 90]] as const) {
      const rig = new WorldRig(level('U', 24, { period, phase }));
      const e = rig.world.enemies[0];
      if (!e) throw new Error('fixture');
      rig.step();
      const wait = phase % period;
      expect(e).toMatchObject({ mode: 'cooldown', modeTicks: 0, modeDuration: wait });
      rig.run(wait + W + period);
      expect(ticksOf(rig, SimEventType.SpitterWindup)).toEqual([1 + wait, 1 + wait + period]);
      expect(ticksOf(rig, SimEventType.SeedFired)).toEqual([1 + wait + W, 1 + wait + W + period]);
    }
  });

  test('mode bookkeeping: windup lasts W, cooldown max(1, period − W)', () => {
    const period = 90;
    const rig = new WorldRig(level('U', 24, { period }));
    const e = rig.world.enemies[0];
    if (!e) throw new Error('fixture');
    rig.step();
    for (let k = 1; k < W; k++) {
      rig.step();
      expect(e).toMatchObject({ mode: 'windup', modeTicks: k });
    }
    rig.step();
    expect(e).toMatchObject({ mode: 'cooldown', modeTicks: 0, modeDuration: period - W });
    const short = new WorldRig(level('U', 24, { period: W - 10 }));
    const s = short.world.enemies[0];
    short.run(W + 1);
    expect(s).toMatchObject({ mode: 'cooldown', modeDuration: 1 });
    short.run(1 + W);
    expect(ticksOf(short, SimEventType.SeedFired)).toEqual([1 + W, 1 + W + 1 + W]);
  });

  test('leaving range returns it to idle; the next activation restarts the cycle', () => {
    const rig = new WorldRig(level('U', 24, { period: 90, phase: 10, range: 400 }));
    const w = rig.world;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    rig.run(20);
    expect(e.mode).toBe('windup');
    w.teleport(50 * T, 29 * T);
    rig.step();
    expect(e).toMatchObject({ mode: 'idle', modeTicks: 0, modeDuration: 0 });
    rig.run(30);
    expect(e.mode).toBe('idle');
    rig.log.length = 0;
    w.teleport(20.5 * T, 29 * T);
    rig.step();
    const A = w.tick;
    expect(e).toMatchObject({ mode: 'cooldown', modeDuration: 10 });
    rig.run(10 + W);
    expect(ticksOf(rig, SimEventType.SpitterWindup)).toEqual([A + 10]);
    expect(ticksOf(rig, SimEventType.SeedFired)).toEqual([A + 10 + W]);
  });

  test('the range is measured from the muzzle to the player centre, inclusive', () => {
    const p0 = levelFromAscii(new MapBuilder(60, 30).put(20, 28, 'P').rows()).playerStart;
    const muzzleX = 30.5 * T;
    const muzzleY = 29 * T - wt.spitterMuzzleHeight;
    const d = Math.hypot(muzzleX - p0.x, muzzleY - (p0.y - H / 2));
    for (const [range, active] of [[d, true], [d - 1e-6, false]] as const) {
      const rig = new WorldRig(level('U', 30, { range }));
      rig.step();
      expect(rig.world.enemies[0]?.mode).toBe(active ? 'windup' : 'idle');
    }
  });

  test('player aim is silent off-screen (view inset by spitterViewInset) and without line of sight', () => {
    // The muzzle 11 tiles right of the player; a narrow view keeps it off-screen.
    const offset = 11 * T;
    const onScreenHalf = offset + wt.spitterViewInset;
    const narrow = new WorldRig(level('S', 31), { viewW: 2 * onScreenHalf - 2 });
    narrow.run(30);
    expect(narrow.world.enemies[0]?.mode).toBe('idle');
    narrow.world.setViewSize(2 * onScreenHalf + 2, 1080);
    narrow.step();
    expect(narrow.world.enemies[0]?.mode).toBe('windup');

    const walled = levelFromAscii(new MapBuilder(60, 30).put(20, 28, 'P').put(31, 28, 'S').fill(26, 20, 26, 28, '#').rows());
    const rig = new WorldRig(walled);
    rig.run(30);
    expect(rig.world.enemies[0]?.mode).toBe('idle');
    expect(rig.eventsOf(SimEventType.SpitterWindup)).toHaveLength(0);
    // A fixed-aim spitter needs neither.
    const fixed = levelFromAscii(new MapBuilder(60, 30).put(20, 28, 'P').put(31, 28, 'U').fill(26, 20, 26, 28, '#').rows());
    const f = new WorldRig(fixed, { viewW: 200 });
    f.step();
    expect(f.world.enemies[0]?.mode).toBe('windup');
  });

  test('facing on windup entry: toward the player, or sign(fixedVx) for fixed aim (unchanged when 0)', () => {
    const left = new WorldRig(level('S', 24, { flightTicks: 30 }));
    left.step();
    expect(left.world.enemies[0]?.facing).toBe(-1);
    const fixedRight = new WorldRig(level('U', 24, { fixedVx: 300, fixedVy: -800 }));
    fixedRight.step();
    expect(fixedRight.world.enemies[0]?.facing).toBe(1);
    const fixedLeft = new WorldRig(level('U', 24, { fixedVx: -300, fixedVy: -800 }));
    expect(fixedLeft.world.enemies[0]?.facing).toBe(-1);
    fixedLeft.step();
    expect(fixedLeft.world.enemies[0]?.facing).toBe(-1);
  });
});

describe('Thorn Spitter fire (§5.3)', () => {
  test('a seed from the muzzle: lowest free slot, prev = cur, age 0, lifetime, hostile; it first moves next tick', () => {
    const rig = new WorldRig(level('U', 24, { period: 90 }));
    const w = rig.world;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    const mx = e.x;
    const my = e.y - wt.spitterMuzzleHeight;
    rig.run(W + 1);
    const fired = rig.eventsOf(SimEventType.SeedFired);
    expect(fired).toEqual([{ type: SimEventType.SeedFired, tick: 1 + W, x: mx, y: my, a: 0, b: -wt.spitterDefaultSpeed, id: 0 }]);
    const s = w.projectiles[0];
    if (!s) throw new Error('fixture');
    expect(s).toMatchObject({
      active: true, owner: 'hostile', x: mx, y: my, prevX: mx, prevY: my, vx: 0, vy: -wt.spitterDefaultSpeed,
      age: 0, lifetime: wt.seedLifetimeTicks, spawnTick: 1 + W, sourceId: e.id, radius: wt.seedRadius,
    });
    rig.step();
    expect(s.age).toBe(1);
    expect(s.prevY).toBe(my);
    expect(s.y).toBeCloseTo(my - wt.spitterDefaultSpeed * SIM_DT + 0.5 * wt.seedGravity * SIM_DT * SIM_DT, 9);
  });

  test('with no free slot the shot is skipped, and the cycle carries on', () => {
    const rig = new WorldRig(level('U', 24, { period: 90 }));
    const w = rig.world;
    for (let i = 0; i < w.projectiles.length; i++) anchorSeed(w, 5 * T + i * 10, 5 * T);
    rig.run(W + 1);
    expect(rig.eventsOf(SimEventType.SeedFired)).toHaveLength(w.projectiles.length);
    expect(w.enemies[0]?.mode).toBe('cooldown');
  });

  test('player aim: the ballistic shot lands exactly on the player centre after flightTicks moves', () => {
    const flightTicks = 40;
    const rig = new WorldRig(level('S', 30, { flightTicks, period: 200 }));
    const w = rig.world;
    const p = w.player;
    rig.run(W + 1);
    const fired = rig.eventsOf(SimEventType.SeedFired)[0];
    if (!fired) throw new Error('no shot');
    const tx = p.x;
    const ty = p.y - H / 2;
    const T0 = flightTicks * SIM_DT;
    expect(fired.a).toBeCloseTo((tx - fired.x) / T0, 9);
    expect(fired.b).toBeCloseTo((ty - fired.y) / T0 - 0.5 * wt.seedGravity * T0, 9);
    // Step out of the way: dash left, then keep walking.
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = -1;
    });
    rig.run(flightTicks - 1, (f) => {
      f.moveX = -1;
    });
    const s = w.projectiles[fired.id];
    expect(s?.active).toBe(true);
    expect(s?.age).toBe(flightTicks);
    expect(s?.x).toBeCloseTo(tx, 6);
    expect(s?.y).toBeCloseTo(ty, 6);
  });

  test('a shot faster than seedMaxSpeed is scaled down to it', () => {
    const rig = new WorldRig(level('S', 31, { flightTicks: 5 }));
    rig.run(W + 1);
    const fired = rig.eventsOf(SimEventType.SeedFired)[0];
    if (!fired) throw new Error('no shot');
    expect(Math.hypot(fired.a, fired.b)).toBeCloseTo(wt.seedMaxSpeed, 9);
    expect(fired.a).toBeLessThan(0);
  });
});

describe('Thorn Spitter contact and stun (§5.3)', () => {
  test('harmful from every side, never stomped', () => {
    const side = new WorldRig(level('U', 26, { range: 1 }));
    side.until((w) => !w.player.alive, (f) => {
      f.moveX = 1;
    }, 200);
    expect(side.eventsOf(SimEventType.Died)).toEqual([expect.objectContaining({ a: DeathCause.Enemy })]);
    const above = new WorldRig(level('S', 26, { range: 1 }));
    const e = above.world.enemies[0];
    if (!e) throw new Error('fixture');
    above.world.teleport(e.x, e.y - e.height - 3 * T);
    above.until((w) => !w.player.alive, undefined, 200);
    expect(above.eventsOf(SimEventType.EnemyStomped)).toHaveLength(0);
    expect(above.eventsOf(SimEventType.Died)).toEqual([expect.objectContaining({ a: DeathCause.Enemy })]);
  });

  test('a launch off a player-aimed spitter stuns it: harmless, silent, re-forms into cooldown for a full period', () => {
    const period = 100;
    const rig = new WorldRig(level('S', 23, { period, range: 400, flightTicks: 30 }));
    const w = rig.world;
    w.unlock(Ability.Launch);
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    rig.step();
    expect(w.launch).toMatchObject({ candidateKind: 'enemy', candidateId: e.id });
    // Launch down into the floor: the player stays in range.
    rig.step(press(0, 1));
    rig.step(letGo(0, 1));
    const R = w.tick;
    expect(e).toMatchObject({ mode: 'stunned', modeTicks: 0, modeDuration: wt.spitterStunTicks });
    expect(e.harmful).toBe(false);
    rig.log.length = 0;
    rig.run(wt.spitterStunTicks - 1);
    expect(e.mode).toBe('stunned');
    expect(rig.eventsOf(SimEventType.SpitterWindup)).toHaveLength(0);
    expect(rig.eventsOf(SimEventType.SeedFired)).toHaveLength(0);
    rig.step();
    expect(w.tick).toBe(R + wt.spitterStunTicks);
    expect(rig.eventsOf(SimEventType.EnemyReformed)).toEqual([
      expect.objectContaining({ tick: R + wt.spitterStunTicks, x: e.x, y: e.y, id: e.id }),
    ]);
    expect(e).toMatchObject({ mode: 'cooldown', modeTicks: 0, modeDuration: period });
  });

  test('re-forming waits while the player overlaps it', () => {
    const period = 100;
    const rig = new WorldRig(level('S', 23, { range: 300, flightTicks: 30, period }), { world: { spitterStunTicks: 30 } });
    const w = rig.world;
    w.unlock(Ability.Launch);
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    rig.step();
    rig.step(press(0, 1));
    rig.step(letGo(0, 1));
    expect(e.mode).toBe('stunned');
    // Stand inside it past the stun: harmless, and it waits.
    w.teleport(e.x, e.y);
    rig.run(40);
    expect(w.player.alive).toBe(true);
    expect(e.mode).toBe('stunned');
    // Step out: it re-forms on the first tick without overlap (in range: into cooldown).
    const box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let t = -1;
    for (let i = 0; i < 30 && e.mode === 'stunned'; i++) {
      rig.step((f) => {
        f.moveX = -1;
      });
      const b = w.player.getBounds(box);
      if (t < 0 && b.maxX <= e.x - e.width / 2) t = w.tick;
    }
    expect(rig.eventsOf(SimEventType.EnemyReformed).map((x) => x.tick)).toEqual([t]);
    expect(e).toMatchObject({ mode: 'cooldown', modeDuration: period });
    expect(w.player.alive).toBe(true);
  });

  test('re-forming while the player is out of range goes idle', () => {
    const rig = new WorldRig(level('S', 23, { range: 300, flightTicks: 30 }));
    const w = rig.world;
    w.unlock(Ability.Launch);
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    rig.step();
    rig.step(press(-1, -1));
    rig.step(letGo(-1, -1));
    rig.run(wt.spitterStunTicks, (f) => {
      f.moveX = -1;
    });
    expect(rig.eventsOf(SimEventType.EnemyReformed)).toHaveLength(1);
    expect(e).toMatchObject({ mode: 'idle', modeDuration: 0 });
  });

  test('respawn and reset put it back to idle', () => {
    const rig = new WorldRig(level('S', 30, { flightTicks: 30, range: 700 }));
    const w = rig.world;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    rig.run(10);
    expect(e.mode).toBe('windup');
    w.respawn();
    rig.step();
    rig.run(wt.dyingTicks);
    expect(rig.eventsOf(SimEventType.Respawned)).toHaveLength(1);
    expect(e).toMatchObject({ mode: 'idle', modeTicks: 0 });
    rig.run(3);
    w.reset();
    expect(e).toMatchObject({ mode: 'idle', modeTicks: 0, modeDuration: 0 });
  });

  test('a player-aimed spitter kills with its seed (DeathCause.Seed)', () => {
    const rig = new WorldRig(level('S', 30, { flightTicks: 30, range: 700 }));
    rig.until((w) => !w.player.alive, undefined, 200);
    expect(rig.eventsOf(SimEventType.Died)).toEqual([expect.objectContaining({ a: DeathCause.Seed })]);
    const w = rig.world;
    expect(w.projectiles.filter((s) => s.active).length).toBeLessThanOrEqual(1);
    void anchorSeed;
  });
});
