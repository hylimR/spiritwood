import { describe, expect, test } from 'vitest';
import { SIM_DT } from '../../src/config.ts';
import { Ability, DeathCause, SeedBurstCause, SimEventType } from '../../src/contracts/sim.ts';
import { DEFAULT_LAUNCH_TUNING, DEFAULT_TUNING, DEFAULT_WORLD_TUNING } from '../../src/sim/tuning.ts';
import type { GameWorld } from '../../src/sim/world.ts';
import { MapBuilder, T, WorldRig } from './helpers.ts';
import { anchorSeed, aim, press } from './launchKit.ts';

const wt = DEFAULT_WORLD_TUNING;
const H = DEFAULT_TUNING.height;
const G = wt.seedGravity;

/** A hostile seed fired by the test (sourceId −1). */
function fire(w: GameWorld, x: number, y: number, vx: number, vy: number) {
  const s = w.seeds.fire(x, y, vx, vy, -1, w.tick, w.events);
  if (!s) throw new Error('pool full');
  return s;
}

/** A big empty room; the player parked far bottom-left. */
function open(w = 80, h = 60): WorldRig {
  return new WorldRig(new MapBuilder(w, h).put(2, h - 2, 'P').rows());
}

describe('seeds (§5.3)', () => {
  test('trapezoid integration is exact for the constant gravity; it first moves the tick after it is fired', () => {
    const rig = open();
    const w = rig.world;
    const x0 = 40 * T;
    const y0 = 30 * T;
    const vx = 300;
    const vy = -700;
    const s = fire(w, x0, y0, vx, vy);
    for (let n = 1; n <= 40; n++) {
      rig.step();
      const t = n * SIM_DT;
      expect(s.age).toBe(n);
      expect(s.x).toBeCloseTo(x0 + vx * t, 9);
      expect(s.y).toBeCloseTo(y0 + vy * t + 0.5 * G * t * t, 9);
      expect(s.vy).toBeCloseTo(vy + G * t, 9);
    }
  });

  test('speed is capped at seedMaxSpeed', () => {
    const rig = open(40, 400);
    const w = rig.world;
    const s = fire(w, 20 * T, 2 * T, 0, 0);
    let prev = 0;
    for (let i = 0; i < 120; i++) {
      rig.step();
      expect(Math.hypot(s.vx, s.vy)).toBeLessThanOrEqual(wt.seedMaxSpeed + 1e-9);
      expect(s.vy).toBeGreaterThanOrEqual(prev);
      prev = s.vy;
    }
    expect(s.vy).toBe(wt.seedMaxSpeed);
  });

  test('a centre entering Solid bursts it (Terrain) at the first sub-step inside, n = ceil(|d| / radius)', () => {
    const rig = open();
    const w = rig.world;
    // Straight right at full speed toward the right border (Solid column 79): a reflected seed flies straight.
    const s = fire(w, 70 * T, 20 * T, 0, 0);
    w.seeds.reflect(s.id, wt.seedMaxSpeed, 0, w.tick);
    const face = 79 * T;
    let burst = null;
    for (let i = 0; i < 60 && !burst; i++) {
      const x0 = s.x;
      rig.step();
      burst = rig.eventsOf(SimEventType.SeedBurst)[0] ?? null;
      if (burst) {
        const d = wt.seedMaxSpeed * SIM_DT;
        const n = Math.ceil(d / wt.seedRadius);
        expect(n).toBeGreaterThan(1);
        expect(burst).toMatchObject({ a: SeedBurstCause.Terrain, b: 1, id: s.id });
        expect(burst.x).toBeGreaterThanOrEqual(face);
        expect(burst.x - face).toBeLessThan(d / n + 1e-9);
        // The burst position is one of the equal sub-steps.
        const k = (burst.x - x0) / (d / n);
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
      }
    }
    expect(burst).not.toBeNull();
    expect(s.active).toBe(false);
  });

  test('outside the left, right and top edges counts as Solid; below the bottom it expires past seedOutMargin', () => {
    const rig = new WorldRig(new MapBuilder(30, 20, false).fill(0, 19, 5, 19, '#').put(2, 18, 'P').rows());
    const w = rig.world;
    const left = fire(w, 10 * T, 5 * T, -wt.seedMaxSpeed, 0);
    const top = fire(w, 20 * T, 1 * T, 0, -wt.seedMaxSpeed);
    const down = fire(w, 20 * T, 5 * T, 0, wt.seedMaxSpeed);
    rig.run(60);
    const bursts = rig.eventsOf(SimEventType.SeedBurst);
    const of = (id: number) => bursts.find((b) => b.id === id);
    expect(of(left.id)).toMatchObject({ a: SeedBurstCause.Terrain });
    expect(of(left.id)?.x).toBeLessThan(0);
    expect(of(top.id)).toMatchObject({ a: SeedBurstCause.Terrain });
    expect(of(top.id)?.y).toBeLessThan(0);
    const b = of(down.id);
    expect(b).toMatchObject({ a: SeedBurstCause.Expired });
    expect(b?.y).toBeGreaterThan(w.level.pxHeight + wt.seedOutMargin);
    expect((b?.y ?? 0) - wt.seedMaxSpeed * SIM_DT).toBeLessThanOrEqual(w.level.pxHeight + wt.seedOutMargin);
  });

  test('OneWay and Thorns do not stop seeds', () => {
    const rows = new MapBuilder(40, 40).put(2, 38, 'P').fill(10, 20, 30, 20, '=').fill(10, 24, 30, 24, '^').rows();
    const rig = new WorldRig(rows);
    const s = fire(rig.world, 20 * T, 15 * T, 0, 0);
    rig.until(() => s.y > 25 * T, undefined, 60);
    expect(s.active).toBe(true);
  });

  test('expiry by age, not ticks: aiming does not age seeds; age ≥ lifetime expires it', () => {
    const rig = new WorldRig(new MapBuilder(40, 30).put(20, 28, 'P').rows());
    const w = rig.world;
    w.unlock(Ability.Launch);
    // A reflected seed parked in the air (no gravity) far from the player.
    const s = anchorSeed(w, 5 * T, 5 * T);
    expect(s.lifetime).toBe(wt.reflectedLifetimeTicks);
    const [cx, cy] = [w.player.x, w.player.y - H / 2];
    anchorSeed(w, cx + 80, cy);
    rig.step();
    rig.step(press());
    const frozenAge = s.age;
    rig.run(DEFAULT_LAUNCH_TUNING.aimMaxTicks - 1, aim());
    expect(w.frozen).toBe(true);
    expect(s.age).toBe(frozenAge);
    rig.run(wt.reflectedLifetimeTicks - frozenAge - 1);
    expect(s.active).toBe(true);
    expect(s.age).toBe(wt.reflectedLifetimeTicks - 1);
    rig.step();
    expect(s.active).toBe(false);
    expect(rig.eventsOf(SimEventType.SeedBurst).find((b) => b.id === s.id)).toMatchObject({ a: SeedBurstCause.Expired, b: 1 });
  });

  test('hostile seeds pass through enemies; reflected seeds never hurt the player', () => {
    const rig = new WorldRig(new MapBuilder(40, 30).put(10, 28, 'P').put(25, 28, 'E').rows());
    const w = rig.world;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    const s = fire(w, e.x - 150, e.y - e.height / 2, 900, -G * 0.3);
    rig.until(() => s.x > e.x + 150 || !s.active, undefined, 30);
    expect(s.active).toBe(true);
    expect(rig.eventsOf(SimEventType.EnemyHit)).toHaveLength(0);
    // A reflected seed through the player.
    const p = w.player;
    const r = anchorSeed(w, p.x - 100, p.y - H / 2);
    w.seeds.reflect(r.id, 600, 0, w.tick);
    rig.run(30);
    expect(p.alive).toBe(true);
  });

  test('a hostile seed touching the player box kills (DeathCause.Seed) and bursts (Player)', () => {
    const rig = new WorldRig(new MapBuilder(40, 30).put(20, 28, 'P').rows());
    const w = rig.world;
    const p = w.player;
    // Falling onto the head: its circle touches the box when the centre is within radius of the top.
    const s = fire(w, p.x + p.width / 2 + wt.seedRadius - 1, p.y - H - 60, 0, 0);
    rig.until(() => !p.alive, undefined, 60);
    expect(rig.eventsOf(SimEventType.Died)).toEqual([expect.objectContaining({ a: DeathCause.Seed })]);
    const b = rig.eventsOf(SimEventType.SeedBurst)[0];
    expect(b).toMatchObject({ a: SeedBurstCause.Player, b: 0, id: s.id, tick: w.tick });
    expect(b?.y).toBeGreaterThan(p.y - H - wt.seedRadius);
    expect(s.active).toBe(false);
  });

  test('no tunnelling at the maximum speeds (a seed at seedMaxSpeed against a dashing player)', () => {
    // The relative motion per tick stays below the 52 u overlap span in every alignment.
    const span = DEFAULT_TUNING.width + 2 * wt.seedRadius;
    const rel = (DEFAULT_TUNING.dashSpeed + wt.seedMaxSpeed) * SIM_DT;
    expect(rel).toBeLessThan(span);
    for (let phase = 0; phase < 45; phase += 1.5) {
      // No seed gravity here, so the head-on line stays at the player's height.
      const rig = new WorldRig(new MapBuilder(80, 30).put(10, 28, 'P').rows(), { world: { seedGravity: 0 } });
      const w = rig.world;
      const p = w.player;
      const s = fire(w, p.x + 200 + phase, p.y - H / 2, -wt.seedMaxSpeed, 0);
      rig.step((f) => {
        f.dashPressed = true;
        f.moveX = 1;
      });
      rig.until(() => !p.alive || s.x < p.x - 200, (f) => {
        f.moveX = 1;
      }, 30);
      expect(p.alive, `phase ${phase}`).toBe(false);
      expect(p.mode === 'dead' && rig.eventsOf(SimEventType.DashEnd).length === 0, `phase ${phase}: hit mid-dash`).toBe(true);
    }
  });

  test('respawn, teleport and reset free every slot silently', () => {
    for (const how of ['respawn', 'teleport', 'reset'] as const) {
      const rig = new WorldRig(new MapBuilder(40, 30).put(20, 28, 'P').rows());
      const w = rig.world;
      for (let i = 0; i < 5; i++) fire(w, (5 + i) * T, 5 * T, 0, 0);
      rig.step();
      rig.log.length = 0;
      if (how === 'respawn') {
        w.respawn();
        rig.run(wt.dyingTicks + 1);
      } else if (how === 'teleport') {
        w.teleport(30 * T, 29 * T);
      } else {
        w.reset();
      }
      rig.drain();
      expect(w.projectiles.every((s) => !s.active), how).toBe(true);
      // The seeds were still falling (none reached the floor): no burst anywhere.
      expect(rig.eventsOf(SimEventType.SeedBurst), how).toHaveLength(0);
    }
  });
});
