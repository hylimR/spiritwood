import { describe, expect, test } from 'vitest';
import { SIM_DT } from '../../src/config.ts';
import type { InputFrame } from '../../src/contracts/input.ts';
import { Ability, DeathCause, EnemyHitCause, LaunchTargetCode, SeedBurstCause, SimEventType } from '../../src/contracts/sim.ts';
import { levelFromAscii } from '../../src/level/ascii.ts';
import { DEFAULT_LAUNCH_TUNING, DEFAULT_TUNING, DEFAULT_WORLD_TUNING, deriveTuning } from '../../src/sim/tuning.ts';
import type { GameWorld } from '../../src/sim/world.ts';
import { MapBuilder, T, WorldRig } from './helpers.ts';
import { aim, anchorSeed, FreeBody, keyAim, launchRig, letGo, press } from './launchKit.ts';

const tun = DEFAULT_TUNING;
const der = deriveTuning(tun);
const lt = DEFAULT_LAUNCH_TUNING;
const wt = DEFAULT_WORLD_TUNING;
const H = tun.height;

/** 40 × 30 room, the player standing at column 20 (feet on row 29's top). */
function room(): string[] {
  return new MapBuilder(40, 30).put(20, 28, 'P').rows();
}

/** Player centre. */
function centre(w: GameWorld): [number, number] {
  return [w.player.x, w.player.y - w.player.height / 2];
}

/**
 * Park an anchor seed at an offset from the player centre, step once so it is published as the
 * candidate, then grab it with the aim (mx, my). Returns the grab tick.
 */
function grabAnchor(rig: WorldRig, ox: number, oy: number, mx = 0, my = 0): number {
  const w = rig.world;
  const [cx, cy] = centre(w);
  anchorSeed(w, cx + ox, cy + oy);
  rig.step();
  expect(w.launch.candidateKind).toBe('seed');
  rig.step(press(mx, my));
  expect(w.player.mode).toBe('launchAim');
  return w.tick;
}

/** Step until the player is grounded (at most `max` ticks), tracking the highest feet y. */
function flyToLanding(rig: WorldRig, set?: (f: InputFrame) => void, max = 300): { minY: number; ticks: number } {
  const p = rig.world.player;
  let minY = p.y;
  for (let i = 1; i <= max; i++) {
    rig.step(set);
    if (p.y < minY) minY = p.y;
    if (p.grounded) return { minY, ticks: i };
  }
  throw new Error('no landing');
}

describe('launched phase (§5.1.1)', () => {
  test('straight-up launch from rest: the apex gain matches the integration', () => {
    const rig = launchRig(room());
    const p = rig.world.player;
    const y0 = p.y;
    grabAnchor(rig, 100, 0, 0, -1);
    rig.step(letGo(0, -1));
    const { minY } = flyToLanding(rig);
    const ref = new FreeBody();
    ref.release(0, -1);
    let refMin = 0;
    for (let i = 0; i < 300 && ref.vy <= 0; i++) {
      ref.step();
      refMin = Math.min(refMin, ref.y);
    }
    expect(Math.abs(y0 - minY - -refMin)).toBeLessThan(2);
    expect(y0 - minY).toBeGreaterThan(8 * T);
  });

  test('45° launch holding forward after the phase: travel, airtime and peak match the integration', () => {
    // A 2-tile pillar over open air, so the flight crosses back through the launch height.
    const rig = launchRig(new MapBuilder(70, 30, false).fill(4, 20, 5, 29, '#').put(5, 19, 'P').rows());
    const w = rig.world;
    const p = w.player;
    grabAnchor(rig, -60, 0, 1, -1);
    const x0 = p.x;
    const y0 = p.y;
    let minY = y0;
    let px = p.x;
    let py = p.y;
    rig.step(letGo(1, -1));
    let k = 1;
    for (; k < 200 && p.y < y0; k++) {
      px = p.x;
      py = p.y;
      rig.step((f) => {
        f.moveX = 1;
      });
      minY = Math.min(minY, p.y);
    }
    const travel = px + (p.x - px) * ((y0 - py) / (p.y - py)) - x0;

    const [ax, ay] = keyAim(1, -1);
    const ref = new FreeBody();
    ref.release(ax, ay);
    ref.step();
    let refK = 1;
    let rpx = 0;
    let rpy = 0;
    let refMin = 0;
    for (; refK < 200 && ref.y < 0; refK++) {
      rpx = ref.x;
      rpy = ref.y;
      ref.step({ moveX: 1 });
      refMin = Math.min(refMin, ref.y);
    }
    const refTravel = rpx + (ref.x - rpx) * ((0 - rpy) / (ref.y - rpy));
    expect(Math.abs(travel - refTravel)).toBeLessThan(2);
    expect(k).toBe(refK);
    expect(Math.abs(y0 - minY - -refMin)).toBeLessThan(2);
  });

  test('tick convention: modeTicks 0 … flightTicks − 1, flight gravity replaces the table, vx is held', () => {
    const rig = launchRig(room());
    const w = rig.world;
    const p = w.player;
    const G = grabAnchor(rig, 100, 0, 1, -1);
    expect(p.modeTicks).toBe(0);
    rig.step(letGo(1, -1));
    const R = w.tick;
    expect(R).toBe(G + 1);
    const [ax, ay] = keyAim(1, -1);
    expect(p.mode).toBe('launched');
    expect(p.modeTicks).toBe(0);
    expect(p.vx).toBe(ax * lt.speed);
    expect(p.vy).toBeCloseTo(ay * lt.speed + der.gravity * lt.flightGravityMult * SIM_DT, 9);
    expect(p.facing).toBe(1);
    for (let k = 1; k < lt.flightTicks; k++) {
      const vy = p.vy;
      // Input against the flight changes neither vx nor the gravity.
      rig.step((f) => {
        f.moveX = -1;
      });
      expect(p.mode, `R + ${k}`).toBe('launched');
      expect(p.modeTicks).toBe(k);
      expect(p.vx).toBe(ax * lt.speed);
      expect(p.vy).toBeCloseTo(vy + der.gravity * lt.flightGravityMult * SIM_DT, 9);
    }
    rig.step((f) => {
      f.moveX = -1;
    });
    expect(w.tick).toBe(R + lt.flightTicks);
    expect(p.mode).toBe('air');
    expect(p.modeTicks).toBe(0);
    // Normal rules again: turning against the over-speed uses the air turn rate.
    expect(p.vx).toBeCloseTo(ax * lt.speed - tun.airTurnAccel * SIM_DT, 9);
  });

  test('afterwards over-speed decays toward the input target at the air decel rate', () => {
    const rig = launchRig(new MapBuilder(120, 40).put(10, 38, 'P').rows());
    const p = rig.world.player;
    grabAnchor(rig, -60, 0, 1, -1);
    rig.step(letGo(1, -1));
    rig.run(lt.flightTicks - 1, (f) => {
      f.moveX = 1;
    });
    let vx = p.vx;
    for (let i = 0; i < 10; i++) {
      rig.step((f) => {
        f.moveX = 1;
      });
      expect(vx - p.vx).toBeCloseTo(tun.airDecel * SIM_DT, 9);
      vx = p.vx;
    }
    expect(vx).toBeGreaterThan(tun.maxRunSpeed);
  });

  test('the fall cap is max(cap, speed) during the phase (cap = fastFallSpeed while holding down)', () => {
    expect(lt.speed).toBeGreaterThan(tun.maxFallSpeed);
    expect(lt.speed).toBeLessThan(tun.fastFallSpeed);
    for (const down of [false, true]) {
      const rig = launchRig(new MapBuilder(30, 90).put(15, 20, 'P').fill(1, 21, 28, 21, '=').rows());
      const p = rig.world.player;
      // Drop through the one-way ledge so the straight-down launch starts in open air.
      rig.step((f) => {
        f.moveY = 1;
        f.jumpPressed = true;
      });
      rig.run(10);
      // An anchor straight above: a neutral release launches straight down.
      grabAnchor(rig, 0, -100);
      rig.step((f) => {
        f.launchReleased = true;
        f.moveY = down ? 1 : 0;
      });
      const g = der.gravity * lt.flightGravityMult * SIM_DT;
      let vy = lt.speed;
      for (let k = 0; k < lt.flightTicks; k++) {
        if (k > 0) {
          rig.step((f) => {
            f.moveY = down ? 1 : 0;
          });
        }
        vy = Math.min(vy + g, down ? tun.fastFallSpeed : lt.speed);
        expect(p.mode).toBe('launched');
        expect(p.vy).toBeCloseTo(vy, 9);
      }
      rig.step((f) => {
        f.moveY = down ? 1 : 0;
      });
      expect(p.mode).toBe('air');
      expect(p.vy).toBe(down ? Math.min(tun.fastFallSpeed, vy + der.gravity * tun.fallGravityMult * SIM_DT) : tun.maxFallSpeed);
    }
  });

  test('no wall slide starts during the phase; a wall zeroes only vx', () => {
    // Falling flush against a wall on the right, launch down-right into it, holding into the wall.
    const rig = launchRig(new MapBuilder(40, 80).fill(24, 1, 26, 78, '#').put(10, 78, 'P').rows());
    const w = rig.world;
    const p = w.player;
    w.teleport(24 * T - tun.width / 2, 20 * T);
    rig.run(5);
    grabAnchor(rig, -60, 0, 1, 1);
    const into = (f: InputFrame): void => {
      f.moveX = 1;
    };
    rig.step(letGo(1, 1));
    const R = w.tick;
    for (let k = 0; k < lt.flightTicks; k++) {
      if (k > 0) rig.step(into);
      expect(p.mode, `R + ${k}`).toBe('launched');
      expect(p.wallDir).toBe(1);
      expect(p.vx).toBe(0);
      expect(p.vy).toBeGreaterThan(0);
    }
    expect(rig.eventsOf(SimEventType.WallSlideStart)).toHaveLength(0);
    rig.step(into);
    expect(w.tick).toBe(R + lt.flightTicks);
    expect(p.mode).toBe('wallSlide');
    expect(rig.eventsOf(SimEventType.WallSlideStart)).toHaveLength(1);
  });

  test('a ceiling zeroes only vy; landing ends the phase (on R when the launch leaves you on the ground)', () => {
    const rows = new MapBuilder(60, 30).fill(1, 25, 58, 25, '#').put(10, 28, 'P').rows();
    const rig = launchRig(rows);
    const w = rig.world;
    const p = w.player;
    grabAnchor(rig, -60, 0, 1, -1);
    rig.step(letGo(1, -1));
    const [ax] = keyAim(1, -1);
    expect(rig.until(() => p.vy >= 0, undefined, lt.flightTicks - 1)).toBeGreaterThan(0);
    expect(p.mode).toBe('launched');
    expect(p.y - p.height).toBe(26 * T);
    expect(p.vy).toBe(0);
    expect(p.vx).toBe(ax * lt.speed);

    // A horizontal launch along the ground lands on the release tick.
    const flat = launchRig(room());
    grabAnchor(flat, -60, 0, 1, 0);
    flat.step(letGo(1, 0));
    const fp = flat.world.player;
    expect(fp.mode).toBe('ground');
    expect(fp.grounded).toBe(true);
    const land = flat.eventsOf(SimEventType.Land);
    expect(land).toHaveLength(1);
    expect(land[0]?.tick).toBe(flat.world.tick);
    expect(fp.vx).toBe(lt.speed);
  });

  test('a jump or a dash after the input lock ends the phase', () => {
    for (const kind of ['jump', 'dash'] as const) {
      const rig = launchRig(new MapBuilder(80, 40).put(10, 38, 'P').rows());
      const w = rig.world;
      const p = w.player;
      // Grab in mid-air (on the way up a jump), so the horizontal launch doesn't land.
      rig.step((f) => {
        f.jumpPressed = true;
        f.jumpHeld = true;
      });
      rig.run(5, (f) => {
        f.jumpHeld = true;
      });
      grabAnchor(rig, -60, 0, 1, 0);
      rig.step(letGo(1, 0));
      const R = w.tick;
      expect(p.mode).toBe('launched');
      rig.run(lt.inputLockTicks - 1);
      rig.step((f) => {
        f.moveX = 1;
        if (kind === 'jump') f.jumpPressed = true;
        else f.dashPressed = true;
      });
      expect(w.tick).toBe(R + lt.inputLockTicks);
      expect(p.mode).toBe(kind === 'jump' ? 'air' : 'dash');
      if (kind === 'jump') {
        const air = rig.eventsOf(SimEventType.AirJump);
        expect(air.at(-1)?.tick).toBe(R + lt.inputLockTicks);
        expect(p.vy).toBeLessThan(0);
      } else {
        expect(rig.eventsOf(SimEventType.Dash).at(-1)?.tick).toBe(R + lt.inputLockTicks);
      }
    }
  });
});

/** Everything the freeze keeps still (player fields except modeTicks, entities, launch target). */
function frozenState(w: GameWorld): unknown {
  const p = w.player;
  const l = w.launch;
  return {
    player: {
      x: p.x, y: p.y, prevX: p.prevX, prevY: p.prevY, vx: p.vx, vy: p.vy, facing: p.facing, mode: p.mode, grounded: p.grounded,
      wallDir: p.wallDir, airJumpsLeft: p.airJumpsLeft, airDashesLeft: p.airDashesLeft, dashProgress: p.dashProgress,
      dashDir: p.dashDir, airTicks: p.airTicks, runDistance: p.runDistance, inputX: p.inputX, alive: p.alive,
      deadTicks: p.deadTicks, visible: p.visible, warpTick: p.warpTick,
    },
    enemies: w.enemies.map((e) => ({
      x: e.x, y: e.y, prevX: e.prevX, prevY: e.prevY, vx: e.vx, facing: e.facing, mode: e.mode, modeTicks: e.modeTicks,
      modeDuration: e.modeDuration,
    })),
    seeds: w.projectiles.map((s) => ({ ...s })),
    orbs: w.orbs.map((o) => ({ x: o.x, y: o.y, prevX: o.prevX, prevY: o.prevY, collected: o.collected })),
    checkpoints: w.checkpoints.map((c) => ({ active: c.active, activatedTick: c.activatedTick })),
    goal: w.goal?.reached,
    launch: {
      unlocked: l.unlocked, candidateKind: l.candidateKind, candidateId: l.candidateId, targetKind: l.targetKind,
      targetId: l.targetId, targetX: l.targetX, targetY: l.targetY, aimMaxTicks: l.aimMaxTicks, range: l.range,
    },
    orbsCollected: w.orbsCollected,
    frozen: w.frozen,
  };
}

/** Hold the aim with busy input (jump and dash presses, a changing direction) for one tick. */
function busyAim(k: number) {
  return (f: InputFrame): void => {
    f.launchHeld = true;
    f.moveX = k % 2 ? 1 : -1;
    f.moveY = -1;
    f.jumpPressed = true;
    f.jumpHeld = true;
    f.dashPressed = true;
  };
}

describe('freeze (§5.1.1)', () => {
  /** A fixed spitter (its seed in flight), a patrolling crawler, a magnetised orb in flight, a checkpoint, the goal. */
  function busyWorld(): WorldRig {
    const rows = new MapBuilder(60, 30).put(20, 28, 'P').put(8, 28, 'U').fill(30, 28, 40, 28, 'E').put(40, 27, 'o')
      .put(50, 28, 'C').put(55, 28, 'G').rows();
    return launchRig(rows, { world: { orbMagnetRadius: 1000 } });
  }

  test('while aiming only modeTicks, the aim, aimTicks, the tick, the timer and the camera change', () => {
    const rig = busyWorld();
    const w = rig.world;
    const p = w.player;
    rig.run(40);
    const G = grabAnchor(rig, -100, 0, 1, -1);
    expect(w.frozen).toBe(true);
    // Something is in motion everywhere.
    expect(w.projectiles.some((s) => s.active && s.owner === 'hostile')).toBe(true);
    expect(w.orbs[0]?.collected).toBe(false);
    expect(w.orbs[0]?.x).not.toBe(w.level.orbs[0]?.x);
    const snap = frozenState(w);
    const zoom0 = w.camera.zoom;
    let elapsed = w.elapsed;
    for (let k = 1; k <= 30; k++) {
      rig.step(busyAim(k));
      expect(w.tick).toBe(G + k);
      expect(frozenState(w), `aiming tick ${k}`).toEqual(snap);
      expect(p.modeTicks).toBe(k);
      expect(w.launch.aimTicks).toBe(k);
      expect(w.launch.aimX).toBeCloseTo((k % 2 ? 1 : -1) * Math.SQRT1_2, 12);
      expect(w.launch.aimY).toBeCloseTo(-Math.SQRT1_2, 12);
      expect(w.elapsed).toBeCloseTo(elapsed + SIM_DT, 12);
      elapsed = w.elapsed;
    }
    expect(w.camera.zoom).toBeGreaterThan(zoom0);
    // Presses while aiming are dropped: nothing fired then, nothing buffered for later.
    rig.step(letGo(0, -1));
    rig.run(10);
    for (const type of [SimEventType.Jump, SimEventType.AirJump, SimEventType.Dash]) expect(rig.eventsOf(type)).toHaveLength(0);
  });

  test('the release restores stepping', () => {
    const rig = busyWorld();
    const w = rig.world;
    rig.run(40);
    grabAnchor(rig, -100, 0, 0, -1);
    rig.run(10, aim(0, -1));
    const crawler = w.enemies[0];
    const spitter = w.enemies[1];
    const seed = w.projectiles.find((s) => s.active && s.owner === 'hostile');
    const orb = w.orbs[0];
    if (!crawler || !spitter || !seed || !orb) throw new Error('fixture');
    const before = { cx: crawler.x, sm: spitter.modeTicks, age: seed.age, sy: seed.y, ox: orb.x };
    rig.step(letGo(0, -1));
    expect(w.frozen).toBe(false);
    expect(crawler.x).not.toBe(before.cx);
    expect(spitter.modeTicks).toBe(before.sm + 1);
    expect(seed.age).toBe(before.age + 1);
    expect(seed.y).not.toBe(before.sy);
    expect(orb.x).not.toBe(before.ox);
  });

  test('the respawn fade keeps going while aiming', () => {
    const rig = launchRig(room());
    const w = rig.world;
    w.respawn();
    rig.step();
    rig.run(wt.dyingTicks);
    const respawnTick = w.tick;
    expect(rig.eventsOf(SimEventType.Respawned).at(-1)?.tick).toBe(respawnTick);
    grabAnchor(rig, -100, 0);
    for (let k = 0; k < wt.fadeInTicks; k++) {
      expect(w.fade).toBeCloseTo(Math.max(0, 1 - (w.tick - respawnTick) / wt.fadeInTicks), 12);
      rig.step(aim());
    }
    expect(w.frozen).toBe(true);
    expect(w.fade).toBe(0);
  });
});

describe('aiming and release (§5.1.1)', () => {
  test('the aim: the input vector (normalised) from dirThreshold, else away from the target, else straight up', () => {
    const rig = launchRig(room());
    const w = rig.world;
    const l = w.launch;
    grabAnchor(rig, 100, 0);
    // Neutral: from the target centre to the player centre.
    expect([l.aimX, l.aimY]).toEqual([-1, 0]);
    rig.step(aim(0.6, -0.8));
    expect(l.aimX).toBeCloseTo(0.6, 12);
    expect(l.aimY).toBeCloseTo(-0.8, 12);
    const at = tun.dirThreshold / Math.SQRT2;
    rig.step(aim(at + 1e-9, at + 1e-9));
    expect(l.aimX).toBeCloseTo(Math.SQRT1_2, 9);
    expect(l.aimY).toBeCloseTo(Math.SQRT1_2, 9);
    rig.step(aim(at - 1e-6, at - 1e-6));
    expect([l.aimX, l.aimY]).toEqual([-1, 0]);

    // The target centre on the player centre: straight up.
    const up = launchRig(room());
    grabAnchor(up, 0, 0);
    expect([up.world.launch.aimX, up.world.launch.aimY]).toEqual([0, -1]);
    up.step(letGo());
    expect(up.eventsOf(SimEventType.Launch)[0]?.a).toBe(Math.atan2(-1, 0));
  });

  test('release on launchReleased, on !launchHeld, or when aimTicks reaches aimMaxTicks', () => {
    const edge = launchRig(room());
    const G1 = grabAnchor(edge, 100, 0);
    edge.step((f) => {
      f.launchHeld = true;
      f.launchReleased = true;
    });
    expect(edge.eventsOf(SimEventType.Launch).map((e) => e.tick)).toEqual([G1 + 1]);

    const held = launchRig(room());
    const G2 = grabAnchor(held, 100, 0);
    held.run(5, aim());
    held.step();
    expect(held.eventsOf(SimEventType.Launch).map((e) => e.tick)).toEqual([G2 + 6]);

    const timeout = launchRig(room());
    const G3 = grabAnchor(timeout, 100, 0);
    const l = timeout.world.launch;
    expect(l.aimMaxTicks).toBe(lt.aimMaxTicks);
    timeout.run(lt.aimMaxTicks - 1, aim());
    expect(timeout.world.player.mode).toBe('launchAim');
    expect(l.aimTicks).toBe(lt.aimMaxTicks - 1);
    timeout.step(aim());
    expect(timeout.eventsOf(SimEventType.Launch).map((e) => e.tick)).toEqual([G3 + lt.aimMaxTicks]);
    expect(l.aimTicks).toBe(lt.aimMaxTicks);
  });

  test('the release sets every listed controller field; events and LaunchView', () => {
    // Spend the air jump and the air dash first, then grab an anchor in mid-air and launch up-left.
    const rig = launchRig(new MapBuilder(60, 30).put(30, 28, 'P').rows());
    const w = rig.world;
    const p = w.player;
    const l = w.launch;
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.run(3, (f) => {
      f.jumpHeld = true;
    });
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    rig.run(tun.dashTicks + 1);
    expect(p.airJumpsLeft).toBe(0);
    expect(p.airDashesLeft).toBe(0);
    const [cx, cy] = centre(w);
    const s = anchorSeed(w, cx + 50, cy - 20);
    rig.step();
    const tx = s.x;
    const ty = s.y;
    rig.step(press(-1, -1));
    const G = w.tick;
    const aimEv = rig.eventsOf(SimEventType.LaunchAim);
    expect(aimEv).toEqual([{ type: SimEventType.LaunchAim, tick: G, x: tx, y: ty, a: LaunchTargetCode.Seed, b: 0, id: s.id }]);
    expect(l).toMatchObject({ targetKind: 'seed', targetId: s.id, targetX: tx, targetY: ty, aimTicks: 0, candidateKind: 'none' });
    const fx = p.x;
    const fy = p.y;
    rig.step(letGo(-1, -1));
    const [ax, ay] = keyAim(-1, -1);
    const ev = rig.eventsOf(SimEventType.Launch);
    expect(ev).toEqual([{ type: SimEventType.Launch, tick: G + 1, x: fx, y: fy, a: Math.atan2(ay, ax), b: LaunchTargetCode.Seed, id: s.id }]);
    expect(p.mode).toBe('launched');
    expect(p.facing).toBe(-1);
    expect(p.airJumpsLeft).toBe(tun.airJumps);
    expect(p.airDashesLeft).toBe(tun.airDashes);
    expect(p.vx).toBe(ax * lt.speed);
    expect(l).toMatchObject({ targetKind: 'seed', targetId: s.id, aimX: ax, aimY: ay, aimTicks: 1, range: lt.range });
    // The seed is flung the opposite way at seedSpeed as a new (reflected) flight.
    expect(s).toMatchObject({ owner: 'reflected', spawnTick: G + 1, lifetime: wt.reflectedLifetimeTicks, age: 1 });
    expect(s.vx).toBeCloseTo(-ax * lt.seedSpeed, 9);
    expect(s.vy).toBeCloseTo(-ay * lt.seedSpeed, 9);
    expect(s.x).toBeCloseTo(tx - ax * lt.seedSpeed * SIM_DT, 9);
    expect(s.y).toBeCloseTo(ty - ay * lt.seedSpeed * SIM_DT, 9);
    // The target fields stay until the next grab; the aim holds the launch direction.
    rig.run(5);
    expect(l).toMatchObject({ targetKind: 'seed', targetId: s.id, aimX: ax, aimY: ay });
  });

  test('a grab ends a dash (DashEnd b = 3) and a wall slide (WallSlideEnd b = 4)', () => {
    const dash = launchRig(room());
    const s = anchorSeed(dash.world, dash.world.player.x + 150, dash.world.player.y - H / 2);
    dash.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    dash.step((f) => {
      f.launchPressed = true;
      f.launchHeld = true;
    });
    expect(dash.world.launch.targetId).toBe(s.id);
    expect(dash.eventsOf(SimEventType.DashEnd)).toEqual([expect.objectContaining({ b: 3, tick: dash.world.tick })]);
    expect(dash.world.player).toMatchObject({ mode: 'launchAim', vx: 0, vy: 0, dashProgress: 0 });

    const wall = launchRig(new MapBuilder(30, 60).rows());
    const w = wall.world;
    w.teleport(T + tun.width / 2, 20 * T);
    wall.run(20, (f) => {
      f.moveX = -1;
    });
    expect(w.player.mode).toBe('wallSlide');
    const [cx, cy] = centre(w);
    anchorSeed(w, cx + 100, cy);
    wall.step((f) => {
      f.moveX = -1;
    });
    wall.step(press(-1));
    expect(wall.eventsOf(SimEventType.WallSlideEnd).at(-1)).toMatchObject({ b: 4, tick: w.tick });
    expect(w.player).toMatchObject({ mode: 'launchAim', vx: 0, vy: 0 });
  });

  test('an enemy target: EnemyHit (cause Launch) at the enemy centre before Launch; the enemy is stunned, never moved', () => {
    const rig = launchRig(new MapBuilder(40, 30).put(20, 28, 'P').put(23, 28, 'E').rows());
    const w = rig.world;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    rig.step();
    expect(w.launch).toMatchObject({ candidateKind: 'enemy', candidateId: e.id, candidateX: e.x, candidateY: e.y - e.height / 2 });
    rig.step(press(0, -1));
    expect(rig.eventsOf(SimEventType.LaunchAim)[0]).toMatchObject({ a: LaunchTargetCode.Enemy, id: e.id, x: e.x, y: e.y - e.height / 2 });
    const ex = e.x;
    rig.step(letGo(0, -1));
    const hit = rig.log.findIndex((x) => x.type === SimEventType.EnemyHit);
    const launch = rig.log.findIndex((x) => x.type === SimEventType.Launch);
    expect(hit).toBeGreaterThanOrEqual(0);
    expect(hit).toBeLessThan(launch);
    expect(rig.log[hit]).toMatchObject({ a: EnemyHitCause.Launch, id: e.id, x: ex, y: e.y - e.height / 2, tick: w.tick });
    expect(rig.log[launch]).toMatchObject({ b: LaunchTargetCode.Enemy, id: e.id });
    expect(e.mode).toBe('stunned');
    expect(e.modeDuration).toBe(wt.stunTicks);
    expect(e.x).toBe(ex);
  });
});

describe('grab rules (§5.1.1)', () => {
  /** The candidate after parking one anchor at the offset and stepping once. */
  function candidateFor(rows: string[], ox: number, oy: number): string {
    const rig = launchRig(rows);
    const [cx, cy] = centre(rig.world);
    anchorSeed(rig.world, cx + ox, cy + oy);
    rig.step();
    return rig.world.launch.candidateKind;
  }

  test('range is inclusive at the edge', () => {
    expect(candidateFor(room(), lt.range, 0)).toBe('seed');
    expect(candidateFor(room(), 0, -lt.range)).toBe('seed');
    expect(candidateFor(room(), lt.range + 1e-6, 0)).toBe('none');
  });

  test('line of sight: Solid blocks, OneWay and Thorns do not', () => {
    const wall = (ch: string): string[] => new MapBuilder(40, 30).put(20, 28, 'P').fill(22, 20, 22, 28, ch).rows();
    expect(candidateFor(wall('#'), 120, 0)).toBe('none');
    expect(candidateFor(wall('='), 120, 0)).toBe('seed');
    expect(candidateFor(wall('^'), 120, 0)).toBe('seed');
  });

  test('a segment through a tile corner tests both neighbours', () => {
    // The player centre P = (20.5 T, 29 T − 29); the segment runs through the corner (22 T, 27 T).
    const cx = 20.5 * T;
    const cy = 29 * T - H / 2;
    const ox = (22 * T - cx) * 1.5;
    const oy = (27 * T - cy) * 1.5;
    const withTile = (tx: number, ty: number): string[] => new MapBuilder(40, 30).put(20, 28, 'P').put(tx, ty, '#').rows();
    expect(candidateFor(room(), ox, oy)).toBe('seed');
    // The two tiles the segment crosses, and the two neighbours of the corner.
    expect(candidateFor(withTile(21, 27), ox, oy)).toBe('none');
    expect(candidateFor(withTile(22, 26), ox, oy)).toBe('none');
    expect(candidateFor(withTile(22, 27), ox, oy)).toBe('none');
    expect(candidateFor(withTile(21, 26), ox, oy)).toBe('none');
    // A diagonal tile the segment never touches.
    expect(candidateFor(withTile(23, 27), ox, oy)).toBe('seed');
  });

  test('the nearest valid target; ties go to seeds, then to the lower id', () => {
    // A crawler standing guard 3 tiles right: its centre is (23.5 T, 29 T − enemyHeight/2).
    const rows = new MapBuilder(40, 30).put(20, 28, 'P').put(23, 28, 'E').put(17, 28, 'E').rows();
    const rig = launchRig(rows);
    const w = rig.world;
    const [cx, cy] = centre(w);
    const [e0, e1] = w.enemies;
    if (!e0 || !e1) throw new Error('fixture');
    rig.step();
    // Two enemies at the same distance: the lower id.
    expect(w.launch).toMatchObject({ candidateKind: 'enemy', candidateId: Math.min(e0.id, e1.id) });
    // The enemy centres are at (±dx, dy) from the player centre; seeds at (∓dy, −dx) are exactly as
    // far and clear of the crawlers (a reflected seed touching one would burst on it).
    const dx = Math.abs(e0.x - cx);
    const dy = e0.y - e0.height / 2 - cy;
    // A seed at the same distance as the enemies wins.
    const s1 = anchorSeed(w, cx - dy, cy - dx);
    rig.step();
    expect(w.launch).toMatchObject({ candidateKind: 'seed', candidateId: s1.id });
    // A second seed at the same distance: the lower slot id.
    const s2 = anchorSeed(w, cx + dy, cy - dx);
    expect(s2.id).toBeGreaterThan(s1.id);
    rig.step();
    expect(w.launch).toMatchObject({ candidateKind: 'seed', candidateId: s1.id });
    // A nearer target wins outright.
    const s3 = anchorSeed(w, cx, cy - 40);
    rig.step();
    expect(w.launch).toMatchObject({ candidateKind: 'seed', candidateId: s3.id, candidateX: s3.x, candidateY: s3.y });
  });

  test('the candidate is empty while aiming, dead or locked', () => {
    const rig = new WorldRig(room());
    const w = rig.world;
    const [cx, cy] = centre(w);
    anchorSeed(w, cx + 50, cy);
    rig.step();
    expect(w.launch.unlocked).toBe(false);
    expect(w.launch.candidateKind).toBe('none');
    rig.step(press());
    expect(w.player.mode).not.toBe('launchAim');
    expect(rig.eventsOf(SimEventType.LaunchFizzle)).toHaveLength(0);
    w.unlock(Ability.Launch);
    rig.step();
    expect(w.launch.candidateKind).toBe('seed');
    rig.step(press());
    expect(w.launch.candidateKind).toBe('none');
    rig.step(letGo());
    w.respawn();
    rig.step();
    expect(w.player.alive).toBe(false);
    expect(w.launch.candidateKind).toBe('none');
  });

  test('regrab: the last target is excluded on R + 1 … R + regrabTicks (enemy by id)', () => {
    const rig = launchRig(new MapBuilder(40, 30).put(20, 28, 'P').put(23, 28, 'E').rows());
    const w = rig.world;
    rig.step();
    rig.step(press(0, 1));
    // Launch straight down into the floor: the player stays in range of the crawler.
    rig.step(letGo(0, 1));
    const R = w.tick;
    expect(w.player.grounded).toBe(true);
    // Candidate published at step 8 of R + k decides the grab on R + k + 1.
    for (let k = 0; k <= lt.regrabTicks; k++) {
      if (k > 0) rig.step();
      expect(w.launch.candidateKind, `published on R + ${k}`).toBe(k < lt.regrabTicks ? 'none' : 'enemy');
    }
    expect(w.tick).toBe(R + lt.regrabTicks);
    rig.step(press());
    expect(w.player.mode).toBe('launchAim');
    expect(w.tick).toBe(R + lt.regrabTicks + 1);
  });

  test('regrab: a seed is excluded by (id, spawnTick), so a reused pool slot is a new target', () => {
    // A slow fling keeps the reflected seed in range.
    const rig = launchRig(room(), { launch: { seedSpeed: 1 } });
    const w = rig.world;
    const s = anchorSeed(w, w.player.x + 100, w.player.y - H / 2);
    rig.step();
    rig.step(press(0, 1));
    rig.step(letGo(0, 1));
    const R = w.tick;
    expect(s).toMatchObject({ active: true, owner: 'reflected', spawnTick: R });
    rig.run(3);
    expect(w.launch.candidateKind).toBe('none');
    // Burst it and reuse its slot: the new flight is grabbable at once.
    s.active = false;
    const again = anchorSeed(w, w.player.x - 100, w.player.y - H / 2);
    expect(again.id).toBe(s.id);
    rig.step();
    expect(w.tick).toBeLessThan(R + lt.regrabTicks);
    expect(w.launch).toMatchObject({ candidateKind: 'seed', candidateId: s.id });
  });

  test('a press up to bufferTicks − 1 ticks early still grabs; a later candidate fizzles', () => {
    for (const late of [false, true]) {
      const rig = launchRig(room());
      const w = rig.world;
      rig.step(press());
      const p = w.tick;
      // The candidate is published at step 8 of p + bufferTicks − 2 (grab at p + bufferTicks − 1), or one later.
      rig.run(lt.bufferTicks - 3 + (late ? 1 : 0), aim());
      anchorSeed(w, w.player.x + 100, w.player.y - H / 2);
      rig.step(aim());
      expect(w.launch.candidateKind).toBe('seed');
      rig.step(aim());
      if (!late) {
        expect(w.player.mode).toBe('launchAim');
        expect(rig.eventsOf(SimEventType.LaunchAim)[0]?.tick).toBe(p + lt.bufferTicks - 1);
        expect(rig.eventsOf(SimEventType.LaunchFizzle)).toHaveLength(0);
      } else {
        expect(w.player.mode).not.toBe('launchAim');
        expect(rig.eventsOf(SimEventType.LaunchFizzle)).toEqual([
          expect.objectContaining({ tick: p + lt.bufferTicks, x: w.player.x, y: w.player.y - H / 2 }),
        ]);
      }
    }
  });

  test('a fizzle on expiry; no fizzle while locked, dead or aiming', () => {
    const fizzle = launchRig(room());
    fizzle.step(press());
    fizzle.run(lt.bufferTicks);
    expect(fizzle.eventsOf(SimEventType.LaunchFizzle).map((e) => e.tick)).toEqual([1 + lt.bufferTicks]);

    const locked = new WorldRig(room());
    locked.step(press());
    locked.run(lt.bufferTicks * 2);
    expect(locked.eventsOf(SimEventType.LaunchFizzle)).toHaveLength(0);

    const dead = launchRig(room());
    dead.world.respawn();
    dead.step(press());
    dead.run(lt.bufferTicks * 2, press());
    expect(dead.world.player.alive).toBe(false);
    expect(dead.eventsOf(SimEventType.LaunchFizzle)).toHaveLength(0);
    // A buffer set just before a death dies with the player.
    const dying = launchRig(room());
    dying.step(press());
    dying.world.respawn();
    dying.run(lt.bufferTicks * 2);
    expect(dying.eventsOf(SimEventType.LaunchFizzle)).toHaveLength(0);

    const aiming = launchRig(room());
    grabAnchor(aiming, 100, 0);
    aiming.run(lt.bufferTicks * 3, press());
    expect(aiming.world.player.mode).toBe('launchAim');
    expect(aiming.eventsOf(SimEventType.LaunchFizzle)).toHaveLength(0);
  });
});

describe('controller state after a release (§5.1.1)', () => {
  const jumps = (rig: WorldRig): number[] =>
    [SimEventType.Jump, SimEventType.WallJump].map((t) => rig.eventsOf(t).length);

  test('after a ground grab no jump fires a ground jump from stale coyote', () => {
    for (let at = 0; at <= lt.inputLockTicks + 3; at++) {
      const rig = launchRig(room());
      const w = rig.world;
      grabAnchor(rig, 100, 0, 0, -1);
      rig.step(letGo(0, -1));
      const R = w.tick;
      rig.run(at, (f) => {
        f.jumpHeld = true;
      });
      rig.step((f) => {
        f.jumpPressed = true;
        f.jumpHeld = true;
      });
      expect(w.tick).toBe(R + at + 1);
      rig.run(30, (f) => {
        f.jumpHeld = true;
      });
      expect(jumps(rig), `press on R + ${at + 1}`).toEqual([0, 0]);
    }
  });

  test('after a wall-slide grab no jump fires a wall jump from stale wall coyote', () => {
    for (let at = lt.inputLockTicks; at <= lt.inputLockTicks + 3; at++) {
      const rig = launchRig(new MapBuilder(30, 60).rows());
      const w = rig.world;
      w.teleport(T + tun.width / 2, 20 * T);
      rig.run(20, (f) => {
        f.moveX = -1;
      });
      expect(w.player.mode).toBe('wallSlide');
      const [cx, cy] = centre(w);
      anchorSeed(w, cx + 100, cy + 40);
      rig.step((f) => {
        f.moveX = -1;
      });
      rig.step(press(1, -1));
      rig.step(letGo(1, -1));
      const R = w.tick;
      rig.run(at - 1);
      rig.step((f) => {
        f.jumpPressed = true;
        f.jumpHeld = true;
      });
      expect(w.tick).toBe(R + at);
      expect(jumps(rig)).toEqual([0, 0]);
      expect(rig.eventsOf(SimEventType.WallJump)).toHaveLength(0);
    }
  });

  test('a dash in progress at the grab leaves the dash usable after the release', () => {
    const rig = launchRig(new MapBuilder(60, 30).put(20, 28, 'P').rows());
    const w = rig.world;
    const p = w.player;
    // Jump, air dash, and grab mid-dash.
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.run(4, (f) => {
      f.jumpHeld = true;
    });
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    expect(p.airDashesLeft).toBe(0);
    const [cx, cy] = centre(w);
    anchorSeed(w, cx + 100, cy);
    rig.step();
    rig.step(press(0, -1));
    expect(rig.eventsOf(SimEventType.DashEnd).at(-1)?.b).toBe(3);
    rig.step(letGo(0, -1));
    const R = w.tick;
    rig.run(lt.inputLockTicks - 1);
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = -1;
    });
    const dashes = rig.eventsOf(SimEventType.Dash);
    expect(dashes).toHaveLength(2);
    expect(dashes[1]?.tick).toBe(R + lt.inputLockTicks);
    expect(p.mode).toBe('dash');
  });

  test('jump and dash presses on R … R + inputLockTicks − 1 are dropped, not buffered', () => {
    for (const kind of ['jump', 'dash'] as const) {
      for (let at = 0; at < lt.inputLockTicks + 1; at++) {
        const rig = launchRig(new MapBuilder(80, 40).put(10, 38, 'P').rows());
        const w = rig.world;
        rig.step((f) => {
          f.jumpPressed = true;
          f.jumpHeld = true;
        });
        rig.run(5, (f) => {
          f.jumpHeld = true;
        });
        grabAnchor(rig, -60, 0, 1, 0);
        // A horizontal launch in mid-air: an air jump or an air dash press would fire at once. Press on R + at.
        const pressIt = (f: InputFrame): void => {
          if (kind === 'jump') {
            f.jumpPressed = true;
            f.jumpHeld = true;
          } else {
            f.dashPressed = true;
            f.dashHeld = true;
            f.moveX = 1;
          }
        };
        rig.step((f) => {
          letGo(1, 0)(f);
          if (at === 0) pressIt(f);
        });
        const R = w.tick;
        if (at > 0) {
          rig.run(at - 1);
          rig.step(pressIt);
        }
        expect(w.tick).toBe(R + at);
        rig.run(Math.max(tun.jumpBufferTicks, tun.dashTicks));
        const fired = rig.eventsOf(kind === 'jump' ? SimEventType.AirJump : SimEventType.Dash).filter((e) => e.tick >= R);
        if (at < lt.inputLockTicks) expect(fired, `${kind} press on R + ${at}`).toHaveLength(0);
        else expect(fired.map((e) => e.tick), `${kind} press on R + ${at}`).toEqual([R + at]);
      }
    }
  });

  test('the release clears the wall-jump lock: facing follows the input on R + 1', () => {
    // A wall jump off the left wall faces right and locks facing for wallJumpLockTicks.
    const wallJumpThenHoldLeft = (grab: boolean): { facing: number; tick: number; jumpTick: number } => {
      const rig = launchRig(new MapBuilder(30, 60).rows());
      const w = rig.world;
      w.teleport(T + tun.width / 2, 20 * T);
      rig.run(20, (f) => {
        f.moveX = -1;
      });
      expect(w.player.mode).toBe('wallSlide');
      rig.step((f) => {
        f.jumpPressed = true;
        f.jumpHeld = true;
        f.moveX = -1;
      });
      const jumpTick = w.tick;
      expect(rig.eventsOf(SimEventType.WallJump)).toHaveLength(1);
      expect(w.player.facing).toBe(1);
      if (grab) {
        const [cx, cy] = centre(w);
        anchorSeed(w, cx + 80, cy);
        rig.step((f) => {
          f.jumpHeld = true;
        });
        rig.step(press(0, -1));
        rig.step(letGo(0, -1));
      } else {
        rig.run(3, (f) => {
          f.jumpHeld = true;
        });
      }
      rig.step((f) => {
        f.moveX = -1;
      });
      return { facing: w.player.facing, tick: w.tick, jumpTick };
    };
    const locked = wallJumpThenHoldLeft(false);
    expect(locked.tick - locked.jumpTick).toBeLessThan(tun.wallJumpLockTicks);
    expect(locked.facing).toBe(1);
    const released = wallJumpThenHoldLeft(true);
    expect(released.tick - released.jumpTick).toBe(locked.tick - locked.jumpTick);
    expect(released.facing).toBe(-1);
  });

  test('the release clears the drop-through: a launch down right after one lands on the next OneWay', () => {
    const rig = launchRig(new MapBuilder(30, 60).put(15, 20, 'P').fill(1, 21, 28, 21, '=').fill(1, 23, 28, 23, '=').rows());
    const w = rig.world;
    rig.step((f) => {
      f.moveY = 1;
      f.jumpPressed = true;
    });
    const dropTick = w.tick;
    expect(rig.eventsOf(SimEventType.DropThrough)).toHaveLength(1);
    const [cx, cy] = centre(w);
    anchorSeed(w, cx + 80, cy);
    rig.step();
    rig.step(press(0, 1));
    rig.step(letGo(0, 1));
    rig.until((x) => x.player.grounded, undefined, 40);
    // Still inside the old drop-through window, so only the cleared timer lets the OneWay catch it.
    expect(w.tick - dropTick).toBeLessThan(tun.dropThroughTicks);
    expect(w.player.grounded).toBe(true);
    expect(w.player.y).toBe(23 * T);
  });
});

describe('input (§5.1.1)', () => {
  test('a release and re-press inside one frame releases, then buffers (and grabs the next candidate)', async () => {
    const { InputManager } = await import('../../src/input/input.ts');
    const { FakeKeys, FakePads } = await import('../input/fakes.ts');
    const keys = new FakeKeys();
    const pads = new FakePads();
    const input = new InputManager({ target: keys.target, getGamepads: pads.get });
    const rig = launchRig(room());
    const w = rig.world;
    const [cx, cy] = centre(w);
    // Just below-right of the centre: a neutral release launches up-left, past the second anchor.
    const first = anchorSeed(w, cx + 30, cy + 25);
    anchorSeed(w, cx - 40, cy - 100);
    const tick = (): void => {
      input.beginFrame();
      rig.step((f) => {
        input.nextTick(f);
      });
    };
    tick();
    expect(w.launch.candidateId).toBe(first.id);
    keys.down('KeyC');
    tick();
    expect(w.player.mode).toBe('launchAim');
    tick();
    expect(w.player.mode).toBe('launchAim');
    // Release and re-press inside one frame: one tick releases (and buffers the press) …
    keys.up('KeyC');
    keys.down('KeyC');
    tick();
    const R = w.tick;
    expect(rig.eventsOf(SimEventType.Launch).map((e) => e.tick)).toEqual([R]);
    expect(w.player.mode).toBe('launched');
    // … and the buffered press grabs the other anchor on the next tick (the first is the last target).
    tick();
    expect(w.player.mode).toBe('launchAim');
    expect(rig.eventsOf(SimEventType.LaunchAim).map((e) => e.tick)).toEqual([R - 2, R + 1]);
    input.destroy();
  });
});

describe('seeds flung off (§5.1.1)', () => {
  /** The player left of a target enemy, an anchor between them: a neutral release flings the seed at it. */
  function flingAt(glyph: 'E' | 'S' | 'U'): { rig: WorldRig; seedId: number } {
    const rows = new MapBuilder(40, 30).put(10, 28, 'P').put(16, 28, glyph).rows();
    const level = levelFromAscii(rows);
    // Keep the spitter asleep: out of range of the player.
    for (const e of level.enemies) if (e.kind === 'thornSpitter') e.range = 10;
    const rig = new WorldRig(level);
    rig.world.unlock(Ability.Launch);
    const w = rig.world;
    const [cx, cy] = centre(w);
    const s = anchorSeed(w, cx + 80, cy);
    rig.step();
    rig.step(press());
    rig.step(letGo());
    return { rig, seedId: s.id };
  }

  test('it flies −aim at seedSpeed; the first enemy it touches takes EnemyHit (Seed) and is stunned', () => {
    for (const glyph of ['E', 'S'] as const) {
      const { rig, seedId } = flingAt(glyph);
      const w = rig.world;
      const s = w.projectiles[seedId];
      const e = w.enemies[0];
      if (!s || !e) throw new Error('fixture');
      expect(s.vx).toBe(lt.seedSpeed);
      expect(s.vy).toBe(-0);
      expect(rig.until(() => !s.active, undefined, 60)).toBeGreaterThan(0);
      const hit = rig.eventsOf(SimEventType.EnemyHit);
      expect(hit).toEqual([expect.objectContaining({ a: EnemyHitCause.Seed, id: e.id, x: e.x, y: e.y - e.height / 2, tick: w.tick })]);
      expect(rig.eventsOf(SimEventType.SeedBurst).at(-1)).toMatchObject({ a: SeedBurstCause.Enemy, b: 1, id: seedId, tick: w.tick });
      expect(e.mode).toBe('stunned');
      expect(e.modeDuration).toBe(glyph === 'E' ? wt.stunTicks : wt.spitterStunTicks);
    }
  });

  test('a fixed-aim spitter is never stunned: the seed bursts without a hit', () => {
    const { rig, seedId } = flingAt('U');
    const w = rig.world;
    const s = w.projectiles[seedId];
    const e = w.enemies[0];
    if (!s || !e) throw new Error('fixture');
    const mode = e.mode;
    rig.until(() => !s.active, undefined, 60);
    expect(rig.eventsOf(SimEventType.EnemyHit)).toHaveLength(0);
    expect(rig.eventsOf(SimEventType.SeedBurst).at(-1)).toMatchObject({ a: SeedBurstCause.Enemy, id: seedId });
    expect(e.mode).toBe(mode);
  });

  test('a fixed-aim spitter is never a launch target (a press with only it in range fizzles); its seeds are', () => {
    const rig = launchRig(new MapBuilder(40, 30).put(20, 28, 'P').put(23, 28, 'U').rows());
    const w = rig.world;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    const [cx, cy] = centre(w);
    expect(Math.hypot(e.x - cx, e.y - e.height / 2 - cy)).toBeLessThanOrEqual(lt.range);
    rig.step();
    expect(w.launch.candidateKind).toBe('none');
    rig.step(press(0, -1));
    rig.run(lt.bufferTicks);
    expect(w.player.mode).not.toBe('launchAim');
    expect(rig.eventsOf(SimEventType.LaunchFizzle)).toHaveLength(1);
    // Its seed, once fired and in range, is the candidate.
    expect(rig.until((x) => x.launch.candidateKind !== 'none', undefined, 300)).toBeGreaterThan(0);
    expect(w.launch.candidateKind).toBe('seed');
    expect(w.projectiles[w.launch.candidateId]?.sourceId).toBe(e.id);
    expect(rig.eventsOf(SimEventType.EnemyHit)).toHaveLength(0);
  });

  test('a reflected seed or a launch restarts a running stun', () => {
    const rig = launchRig(new MapBuilder(40, 30).put(20, 28, 'P').put(23, 28, 'E').rows());
    const w = rig.world;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    rig.step();
    rig.step(press(0, 1));
    rig.step(letGo(0, 1));
    expect(e.mode).toBe('stunned');
    rig.run(lt.regrabTicks + 5);
    expect(e.modeTicks).toBe(lt.regrabTicks + 5);
    // A launch off it restarts the stun.
    rig.step(press(0, 1));
    rig.step(letGo(0, 1));
    expect(e.mode).toBe('stunned');
    expect(e.modeTicks).toBe(0);
    expect(rig.eventsOf(SimEventType.EnemyHit).map((h) => h.a)).toEqual([EnemyHitCause.Launch, EnemyHitCause.Launch]);
    // A reflected seed restarts it too: fling an anchor at it (launching away from it, left).
    rig.run(lt.regrabTicks + 5);
    const ticks = e.modeTicks;
    expect(ticks).toBe(lt.regrabTicks + 5);
    const [cx, cy] = centre(w);
    anchorSeed(w, cx + 40, cy);
    rig.step();
    expect(w.launch.candidateKind).toBe('seed');
    rig.step(press(-1, 0));
    rig.step(letGo(-1, 0));
    expect(rig.until(() => rig.eventsOf(SimEventType.EnemyHit).length === 3, undefined, 30)).toBeGreaterThan(0);
    expect(rig.eventsOf(SimEventType.EnemyHit).at(-1)).toMatchObject({ a: EnemyHitCause.Seed, id: e.id, tick: w.tick });
    expect(e.mode).toBe('stunned');
    expect(e.modeTicks).toBe(0);
    expect(e.modeDuration).toBe(wt.stunTicks);
  });
});

describe('grace (§5.1.1)', () => {
  test('enemy contact cannot kill on R … R + graceTicks − 1; it kills again after', () => {
    // A fixed-aim spitter (never stunned) right of the player; launch into it along the ground.
    const level = levelFromAscii(new MapBuilder(40, 30).put(20, 28, 'P').put(23, 28, 'U').rows());
    const sp = level.enemies[0];
    if (sp?.kind === 'thornSpitter') sp.range = 10;
    const rig = new WorldRig(level);
    const w = rig.world;
    w.unlock(Ability.Launch);
    const [cx, cy] = centre(w);
    anchorSeed(w, cx - 60, cy);
    rig.step();
    rig.step(press(1, 0));
    rig.step(letGo(1, 0));
    const R = w.tick;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    const box = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let overlapped = -1;
    for (let k = 1; k < 30 && w.player.alive; k++) {
      rig.step();
      const pb = w.player.getBounds(box);
      const touching = pb.maxX > e.x - e.width / 2 && pb.minX < e.x + e.width / 2;
      if (touching && overlapped < 0) overlapped = w.tick;
    }
    expect(overlapped).toBeGreaterThan(R);
    expect(overlapped).toBeLessThan(R + lt.graceTicks);
    const died = rig.eventsOf(SimEventType.Died);
    expect(died).toEqual([expect.objectContaining({ a: DeathCause.Enemy, tick: R + lt.graceTicks })]);
  });

  test('hostile seeds neither kill nor burst during grace; a stomp still bounces and ends the launched phase', () => {
    const rig = launchRig(new MapBuilder(40, 60).put(20, 58, 'P').put(20, 30, 'E').fill(19, 31, 21, 31, '#').rows());
    const w = rig.world;
    const p = w.player;
    const e = w.enemies[0];
    if (!e) throw new Error('fixture');
    // Above the crawler's platform, grab an anchor and launch straight down onto it.
    w.teleport(e.x, e.y - e.height - 3 * T);
    const [cx, cy] = centre(w);
    anchorSeed(w, cx + 100, cy);
    rig.step();
    rig.step(press(0, 1));
    // A hostile seed crossing the player during the grace window.
    const hostile = w.seeds.fire(p.x, p.y - H / 2 + 30, 0, 0, -1, w.tick, w.events);
    if (!hostile) throw new Error('fixture');
    rig.step(letGo(0, 1));
    const R = w.tick;
    rig.until(() => e.mode === 'stunned', undefined, lt.graceTicks);
    expect(w.tick).toBeLessThan(R + lt.graceTicks);
    expect(w.tick).toBeLessThan(R + lt.flightTicks);
    expect(rig.eventsOf(SimEventType.EnemyStomped)).toHaveLength(1);
    expect(p.vy).toBeLessThan(0);
    // The bounce ends the launched phase (the normal airborne rules apply again).
    expect(p.mode).toBe('air');
    expect(p.alive).toBe(true);
    expect(hostile.active).toBe(true);
    expect(rig.eventsOf(SimEventType.SeedBurst).filter((b) => b.a === SeedBurstCause.Player)).toHaveLength(0);
  });

  test('after grace a hostile seed kills (DeathCause.Seed) and bursts (Player)', () => {
    const rig = launchRig(room());
    const w = rig.world;
    const p = w.player;
    grabAnchor(rig, 100, 0, 0, 1);
    rig.step(letGo(0, 1));
    const R = w.tick;
    rig.run(lt.graceTicks - 1);
    const s = w.seeds.fire(p.x, p.y - H / 2 - 40, 0, 0, -1, w.tick, w.events);
    if (!s) throw new Error('fixture');
    rig.step();
    expect(w.tick).toBe(R + lt.graceTicks);
    expect(rig.eventsOf(SimEventType.Died)).toEqual([expect.objectContaining({ a: DeathCause.Seed, tick: R + lt.graceTicks })]);
    expect(rig.eventsOf(SimEventType.SeedBurst).at(-1)).toMatchObject({ a: SeedBurstCause.Player, b: 0, id: s.id });
    expect(s.active).toBe(false);
  });
});

describe('chains, cancellation and determinism (§5.1.1)', () => {
  test('grabbing from launched works (a chain)', () => {
    const rig = launchRig(new MapBuilder(60, 40).put(20, 38, 'P').rows());
    const w = rig.world;
    const p = w.player;
    const [cx, cy] = centre(w);
    anchorSeed(w, cx + 100, cy);
    // A second anchor on the way up.
    const next = anchorSeed(w, cx, cy - 200);
    rig.step();
    rig.step(press(0, -1));
    rig.step(letGo(0, -1));
    expect(rig.until(() => w.launch.candidateId === next.id, undefined, lt.flightTicks)).toBeGreaterThan(0);
    expect(p.mode).toBe('launched');
    rig.step(press(0, -1));
    expect(p.mode).toBe('launchAim');
    expect(w.launch.targetId).toBe(next.id);
    rig.step(letGo(0, -1));
    expect(p.mode).toBe('launched');
    expect(rig.eventsOf(SimEventType.Launch)).toHaveLength(2);
  });

  test('abilities are restored on every release', () => {
    const rig = launchRig(new MapBuilder(80, 40).put(20, 38, 'P').rows());
    const w = rig.world;
    const p = w.player;
    const spend = (): void => {
      rig.step((f) => {
        f.dashPressed = true;
        f.moveX = 1;
      });
      rig.run(tun.dashTicks);
      rig.until(() => p.vy > -der.airJumpVelocity, undefined, 60);
      rig.step((f) => {
        f.jumpPressed = true;
      });
      expect(p.airJumpsLeft).toBe(0);
      expect(p.airDashesLeft).toBe(0);
    };
    const launchUp = (): void => {
      const [cx, cy] = centre(w);
      anchorSeed(w, cx + 100, cy);
      rig.step();
      rig.step(press(0, -1));
      rig.step(letGo(0, -1));
      expect(p.airJumpsLeft).toBe(tun.airJumps);
      expect(p.airDashesLeft).toBe(tun.airDashes);
      rig.run(lt.inputLockTicks - 1);
    };
    rig.step((f) => {
      f.jumpPressed = true;
    });
    spend();
    launchUp();
    spend();
    launchUp();
    expect(rig.eventsOf(SimEventType.Launch)).toHaveLength(2);
    expect(rig.eventsOf(SimEventType.Dash)).toHaveLength(2);
    expect(rig.eventsOf(SimEventType.AirJump)).toHaveLength(2);
  });

  test('a queued debug respawn during an aim kills at step 2: no Launch, the world unfreezes that tick', () => {
    const rig = launchRig(new MapBuilder(60, 30).put(20, 28, 'P').fill(30, 28, 40, 28, 'E').rows());
    const w = rig.world;
    const crawler = w.enemies[0];
    if (!crawler) throw new Error('fixture');
    grabAnchor(rig, 100, 0);
    rig.run(5, aim());
    const x = crawler.x;
    w.respawn();
    rig.step(aim());
    expect(w.player.alive).toBe(false);
    expect(w.player.deadTicks).toBe(0);
    expect(w.frozen).toBe(false);
    expect(crawler.x).not.toBe(x);
    expect(rig.eventsOf(SimEventType.Launch)).toHaveLength(0);
    expect(rig.eventsOf(SimEventType.Died)).toEqual([expect.objectContaining({ a: DeathCause.Debug, tick: w.tick })]);
    rig.run(wt.dyingTicks);
    expect(w.player.alive).toBe(true);
    expect(rig.eventsOf(SimEventType.Launch)).toHaveLength(0);
  });

  test('teleport and reset cancel an aim and free every seed slot silently', () => {
    for (const how of ['teleport', 'reset'] as const) {
      const rig = launchRig(room());
      const w = rig.world;
      grabAnchor(rig, 100, 0);
      rig.drain();
      rig.log.length = 0;
      if (how === 'teleport') w.teleport(w.player.x + T, w.player.y);
      else w.reset();
      rig.drain();
      expect(w.frozen).toBe(false);
      expect(w.player.mode).not.toBe('launchAim');
      expect(w.projectiles.every((s) => !s.active)).toBe(true);
      expect(rig.log.map((e) => e.type)).toEqual([how === 'teleport' ? SimEventType.Teleported : SimEventType.Reset]);
      rig.run(10, aim());
      expect(rig.eventsOf(SimEventType.Launch)).toHaveLength(0);
      expect(w.launch.unlocked).toBe(how === 'teleport');
    }
  });

  test('identical input scripts give identical states', () => {
    const run = (): { log: unknown[]; state: unknown } => {
      const rows = new MapBuilder(60, 30).put(10, 28, 'P').put(30, 28, 'S').put(4, 28, 'U').fill(40, 28, 50, 28, 'E').rows();
      const rig = launchRig(rows);
      const w = rig.world;
      for (let i = 0; i < 600; i++) {
        rig.step((f) => {
          f.moveX = i % 97 < 50 ? 1 : -1;
          f.moveY = i % 41 < 5 ? -1 : 0;
          f.jumpPressed = i % 23 === 0;
          f.jumpHeld = i % 23 < 12;
          f.dashPressed = i % 71 === 0;
          f.launchPressed = i % 37 === 0;
          f.launchHeld = i % 37 < 9;
        });
      }
      return { log: rig.log, state: { ...frozenState(w) as object, tick: w.tick, cam: [w.camera.x, w.camera.y, w.camera.zoom] } };
    };
    const a = run();
    const b = run();
    expect(b.state).toEqual(a.state);
    expect(b.log).toEqual(a.log);
    expect(a.log.length).toBeGreaterThan(20);
  });
});
