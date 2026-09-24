import { describe, expect, test } from 'vitest';
import { SIM_DT, SIM_HZ } from '../../src/config.ts';
import type { InputFrame } from '../../src/contracts/input.ts';
import { SimEventType } from '../../src/contracts/sim.ts';
import { approach } from '../../src/core/math.ts';
import { Rng } from '../../src/core/rng.ts';
import { DEFAULT_TUNING, deriveTuning } from '../../src/sim/tuning.ts';
import { MapBuilder, PlayerRig, T } from './helpers.ts';

const tun = DEFAULT_TUNING;
const der = deriveTuning(tun);
const HALF_W = tun.width / 2;

/** 40 × 24 room, player on the floor at column `px`. */
function flat(px = 10): string[] {
  return new MapBuilder(40, 24).put(px, 22, 'P').rows();
}

const hold = (dir: number) => (f: InputFrame): void => {
  f.moveX = dir;
};

/** Rig with the player placed mid-air at feet (x, y), vy = 0. */
function airborne(rows: string[], x: number, y: number, tuning = {}): PlayerRig {
  const rig = new PlayerRig(rows, tuning);
  rig.player.reset(x, y, 0);
  return rig;
}

function apexOf(rig: PlayerRig, set: (f: InputFrame, i: number) => void, ticks = 90): { height: number; tick: number } {
  const y0 = rig.player.y;
  let minY = y0;
  let tick = 0;
  for (let i = 0; i < ticks; i++) {
    rig.step((f) => set(f, i));
    if (rig.player.y < minY) {
      minY = rig.player.y;
      tick = i + 1;
    }
  }
  return { height: y0 - minY, tick };
}

describe('jump arcs (§5.1 test contract)', () => {
  test('full held jump apex and timing', () => {
    const rig = new PlayerRig(flat());
    const { height, tick } = apexOf(rig, (f, i) => {
      f.jumpPressed = i === 0;
      f.jumpHeld = true;
    });
    expect(height).toBeGreaterThanOrEqual(tun.jumpHeight);
    expect(height).toBeLessThanOrEqual(tun.jumpHeight + der.apexHangExtra + 1);
    const rise = (der.jumpVelocity - tun.apexThreshold) / der.gravity;
    const hang = tun.apexThreshold / (der.gravity * tun.apexGravityMult);
    expect(Math.abs(tick - Math.round((rise + hang) * SIM_HZ))).toBeLessThanOrEqual(1);
  });

  test('tap jump (variable height minimum)', () => {
    const rig = new PlayerRig(flat());
    const { height } = apexOf(rig, (f, i) => {
      f.jumpPressed = i === 0;
    });
    const v1 = der.jumpVelocity - der.gravity * SIM_DT;
    const expected = ((der.jumpVelocity + v1) / 2) * SIM_DT + (v1 * v1) / (2 * der.gravity * tun.jumpCutGravityMult);
    expect(Math.abs(height - expected)).toBeLessThan(2);
    expect(height).toBeLessThan(tun.jumpHeight / 2);
  });

  test('releasing later gives monotonically higher jumps', () => {
    let last = 0;
    for (const holdTicks of [1, 4, 8, 12, 16, 20, 30]) {
      const rig = new PlayerRig(flat());
      const { height } = apexOf(rig, (f, i) => {
        f.jumpPressed = i === 0;
        f.jumpHeld = i < holdTicks;
      });
      expect(height).toBeGreaterThanOrEqual(last);
      last = height;
    }
  });

  test('air jump from rest', () => {
    const rig = airborne(flat(), 20 * T, 10 * T);
    const { height } = apexOf(rig, (f, i) => {
      f.jumpPressed = i === 0;
      f.jumpHeld = true;
    });
    expect(height).toBeGreaterThanOrEqual(tun.airJumpHeight);
    expect(height).toBeLessThanOrEqual(tun.airJumpHeight + der.apexHangExtra + 1);
    const air = rig.eventsOf(SimEventType.AirJump);
    expect(air).toHaveLength(1);
    expect(air[0]?.b).toBe(tun.airJumps - 1);
  });

  test('Jump and Land event payloads', () => {
    const rig = new PlayerRig(flat());
    const start = { x: rig.player.x, y: rig.player.y };
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    const jump = rig.eventsOf(SimEventType.Jump);
    expect(jump).toEqual([{ type: SimEventType.Jump, tick: 1, x: start.x, y: start.y, a: 1, b: 0, id: -1 }]);
    let vyBefore = 0;
    const air = rig.until((p) => {
      if (!p.grounded) vyBefore = p.vy;
      return p.grounded;
    }, (f) => {
      f.jumpHeld = true;
    });
    expect(air).toBeGreaterThan(0);
    const land = rig.eventsOf(SimEventType.Land);
    expect(land).toHaveLength(1);
    expect(land[0]?.y).toBe(start.y);
    expect(land[0]?.b).toBeGreaterThanOrEqual(tun.jumpHeight);
    expect(land[0]?.b).toBeLessThanOrEqual(tun.jumpHeight + der.apexHangExtra + 1);
    expect(land[0]?.a).toBeCloseTo(Math.min(tun.maxFallSpeed, vyBefore + der.gravity * tun.fallGravityMult * SIM_DT), 9);
    expect(rig.player.mode).toBe('ground');
    expect(rig.player.modeTicks).toBe(0);
    expect(rig.player.vy).toBe(0);
  });

  test('spawning on the ground emits no Land', () => {
    const rig = new PlayerRig(flat());
    expect(rig.player.grounded).toBe(true);
    rig.run(5);
    expect(rig.log).toHaveLength(0);
  });

  test('fast fall raises the fall cap while holding down', () => {
    const rows = new MapBuilder(20, 80).rows();
    const normal = airborne(rows, 10 * T, 5 * T);
    normal.run(120);
    expect(normal.player.vy).toBe(tun.maxFallSpeed);
    const fast = airborne(rows, 10 * T, 5 * T);
    fast.run(120, (f) => {
      f.moveY = 1;
    });
    expect(fast.player.vy).toBe(tun.fastFallSpeed);
  });
});

describe('running', () => {
  /** Ticks for the documented ground rule (turnAccel while opposing, accel after crossing 0) to reach `target`. */
  function modelTicks(v0: number, target: number): number {
    let v = v0;
    let n = 0;
    while (v !== target && n < 1000) {
      const rate = v !== 0 && Math.sign(target) !== Math.sign(v) ? tun.turnAccel : tun.groundAccel;
      v = approach(v, target, rate * SIM_DT);
      n++;
    }
    return n;
  }

  test('acceleration, deceleration and turn times', () => {
    const rig = new PlayerRig(flat());
    const accelTicks = Math.ceil(tun.maxRunSpeed / (tun.groundAccel * SIM_DT));
    expect(modelTicks(0, tun.maxRunSpeed)).toBe(accelTicks);
    rig.run(accelTicks - 1, hold(1));
    expect(rig.player.vx).toBeLessThan(tun.maxRunSpeed);
    rig.step(hold(1));
    expect(rig.player.vx).toBe(tun.maxRunSpeed);

    const turnTicks = modelTicks(tun.maxRunSpeed, -tun.maxRunSpeed);
    expect(turnTicks).toBeLessThan(2 * accelTicks);
    rig.run(turnTicks - 1, hold(-1));
    expect(rig.player.vx).toBeGreaterThan(-tun.maxRunSpeed);
    rig.step(hold(-1));
    expect(rig.player.vx).toBe(-tun.maxRunSpeed);

    const decelTicks = Math.ceil(tun.maxRunSpeed / (tun.groundDecel * SIM_DT));
    rig.run(decelTicks - 1);
    expect(rig.player.vx).toBeLessThan(0);
    rig.step();
    expect(rig.player.vx).toBe(0);
  });

  test('trapezoid displacement while accelerating', () => {
    const rig = new PlayerRig(flat());
    const x0 = rig.player.x;
    rig.step(hold(1));
    const v1 = tun.groundAccel * SIM_DT;
    expect(rig.player.vx).toBeCloseTo(v1, 9);
    expect(rig.player.x - x0).toBeCloseTo((v1 / 2) * SIM_DT, 9);
  });

  test('air control uses the air rates', () => {
    const rig = new PlayerRig(flat());
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.step((f) => {
      f.jumpHeld = true;
      f.moveX = 1;
    });
    expect(rig.player.vx).toBeCloseTo(tun.airAccel * SIM_DT, 9);
    rig.step((f) => {
      f.jumpHeld = true;
    });
    expect(rig.player.vx).toBeCloseTo(Math.max(0, tun.airAccel * SIM_DT - tun.airDecel * SIM_DT), 9);
  });

  test('analog input scales the target speed; runDistance and inputX follow', () => {
    const rig = new PlayerRig(flat());
    rig.run(60, hold(0.5));
    expect(rig.player.vx).toBeCloseTo(tun.maxRunSpeed / 2, 9);
    expect(rig.player.inputX).toBe(0.5);
    expect(rig.player.runDistance).toBeCloseTo(rig.player.x - 10.5 * T, 6);
  });

  test('over-speed decays at the decel rate, preserving momentum (dash-jump)', () => {
    const rig = new PlayerRig(flat(3));
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
      f.moveX = 1;
    });
    expect(rig.player.vx).toBe(tun.dashSpeed - tun.airDecel * SIM_DT);
    let prev = rig.player.vx;
    for (let i = 0; i < 20; i++) {
      rig.step((f) => {
        f.jumpHeld = true;
        f.moveX = 1;
      });
      expect(prev - rig.player.vx).toBeCloseTo(tun.airDecel * SIM_DT, 9);
      prev = rig.player.vx;
    }
    expect(prev).toBeGreaterThan(tun.maxRunSpeed);
  });
});

describe('coyote time and jump buffer', () => {
  /** Ledge edge at column 12; player runs right off it. Returns the first airborne tick. */
  function ledgeRig(): { rig: () => PlayerRig; offTick: number } {
    const rows = new MapBuilder(40, 24).fill(1, 12, 12, 22, '#').put(4, 11, 'P').rows();
    const make = (): PlayerRig => new PlayerRig(rows);
    const probe = make();
    const off = probe.until((p) => !p.grounded, hold(1));
    expect(off).toBeGreaterThan(0);
    return { rig: make, offTick: off };
  }

  test('walk off: a press on airborne tick coyoteTicks ground-jumps, one tick later it air-jumps', () => {
    const { rig, offTick } = ledgeRig();
    const jumpOn = (tick: number): PlayerRig => {
      const r = rig();
      r.run(offTick + tun.coyoteTicks + 2, (f, i) => {
        f.moveX = 1;
        f.jumpPressed = i + 1 === tick;
        f.jumpHeld = i + 1 >= tick;
      });
      return r;
    };
    const inWindow = jumpOn(offTick + tun.coyoteTicks - 1);
    expect(inWindow.eventsOf(SimEventType.Jump)).toHaveLength(1);
    expect(inWindow.eventsOf(SimEventType.AirJump)).toHaveLength(0);
    expect(inWindow.player.airJumpsLeft).toBe(tun.airJumps);

    const late = jumpOn(offTick + tun.coyoteTicks);
    expect(late.eventsOf(SimEventType.Jump)).toHaveLength(0);
    expect(late.eventsOf(SimEventType.AirJump)).toHaveLength(1);
  });

  test('coyote is consumed by the jump (no second ground jump)', () => {
    const { rig, offTick } = ledgeRig();
    const r = rig();
    r.run(offTick + 6, (f, i) => {
      f.moveX = 1;
      f.jumpPressed = i + 1 === offTick + 1 || i + 1 === offTick + 3;
      f.jumpHeld = true;
    });
    expect(r.eventsOf(SimEventType.Jump)).toHaveLength(1);
  });

  test('buffer edges (no air jumps): a press k ticks before landing fires iff within the window', () => {
    const rows = flat();
    const land = airborne(rows, 20 * T, 18 * T, { airJumps: 0 });
    const L = land.until((p) => p.grounded);
    expect(L).toBeGreaterThan(tun.jumpBufferTicks + 2);
    for (let k = 0; k <= tun.jumpBufferTicks + 2; k++) {
      const rig = airborne(rows, 20 * T, 18 * T, { airJumps: 0 });
      const press = L - k;
      rig.run(L + tun.jumpBufferTicks + 2, (f, i) => {
        f.jumpPressed = i + 1 === press;
      });
      const jumps = rig.eventsOf(SimEventType.Jump);
      const fires = press + tun.jumpBufferTicks - 1 >= L + 1;
      expect(jumps.length, `k=${k}`).toBe(fires ? 1 : 0);
      if (fires) expect(jumps[0]?.tick).toBe(L + 1);
    }
  });

  test('a press 1–8 ticks before landing with the air jump available fires the air jump', () => {
    const rows = flat();
    const land = airborne(rows, 20 * T, 18 * T);
    const L = land.until((p) => p.grounded);
    for (let k = 1; k <= 8; k++) {
      const rig = airborne(rows, 20 * T, 18 * T);
      rig.run(L, (f, i) => {
        f.jumpPressed = i + 1 === L - k;
      });
      const air = rig.eventsOf(SimEventType.AirJump);
      expect(air, `k=${k}`).toHaveLength(1);
      expect(air[0]?.tick).toBe(L - k);
    }
  });

  test('an early air-jump press waits until vy has decayed (never lowers the arc)', () => {
    const rig = new PlayerRig(flat());
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    const firesAt = rig.until(() => rig.eventsOf(SimEventType.AirJump).length > 0, (f) => {
      f.jumpHeld = true;
    }, tun.jumpBufferTicks);
    expect(firesAt).toBeGreaterThan(0);
    expect(rig.player.vy).toBeCloseTo(-der.airJumpVelocity + der.gravity * SIM_DT, 9);
    const expectedWait = Math.ceil((der.jumpVelocity - der.airJumpVelocity) / (der.gravity * SIM_DT)) - 1;
    expect(rig.eventsOf(SimEventType.AirJump)[0]?.tick).toBe(2 + expectedWait);
  });
});

describe('double jump', () => {
  test('exactly one air jump, restored on landing', () => {
    const rig = new PlayerRig(flat());
    const press = (f: InputFrame): void => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    };
    rig.step(press);
    rig.run(20, (f) => {
      f.jumpHeld = true;
    });
    rig.step(press);
    rig.run(20);
    rig.step(press);
    expect(rig.eventsOf(SimEventType.AirJump)).toHaveLength(1);
    expect(rig.player.airJumpsLeft).toBe(0);
    rig.until((p) => p.grounded);
    expect(rig.player.airJumpsLeft).toBe(tun.airJumps);
  });

  /** Tall room; a wall column at x = 20. */
  function wallRoom(): string[] {
    return new MapBuilder(40, 40).fill(20, 1, 22, 38, '#').rows();
  }

  const toWall = (f: InputFrame): void => {
    f.moveX = 1;
    f.jumpHeld = true;
  };

  test('bare wall contact never restores it; entering a wall slide does', () => {
    const rig = airborne(wallRoom(), 18 * T, 20 * T);
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    expect(rig.player.airJumpsLeft).toBe(0);
    rig.until((p) => p.wallDir === 1, toWall, 60);
    expect(rig.player.vy).toBeLessThan(0);
    rig.run(4, toWall);
    expect(rig.player.wallDir).toBe(1);
    expect(rig.player.airJumpsLeft).toBe(0);
    rig.until((p) => p.vy > 0);
    rig.run(10);
    expect(rig.player.wallDir).toBe(1);
    expect(rig.player.mode).toBe('air');
    expect(rig.player.airJumpsLeft).toBe(0);
    rig.until((p) => p.mode === 'wallSlide', hold(1), 5);
    expect(rig.player.airJumpsLeft).toBe(tun.airJumps);
  });

  test('a wall jump restores the air jump and air dash', () => {
    const rig = airborne(wallRoom(), 18 * T, 20 * T);
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.until((p) => p.wallDir === 1, toWall, 60);
    expect(rig.player.vy).toBeLessThan(0);
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    expect(rig.eventsOf(SimEventType.DashEnd)[0]?.b).toBe(2);
    expect(rig.player.airJumpsLeft).toBe(0);
    expect(rig.player.airDashesLeft).toBe(0);
    expect(rig.player.mode).not.toBe('wallSlide');
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    expect(rig.eventsOf(SimEventType.WallJump)).toHaveLength(1);
    expect(rig.player.airJumpsLeft).toBe(tun.airJumps);
    expect(rig.player.airDashesLeft).toBe(tun.airDashes);
  });
});

describe('wall slide and wall jump', () => {
  /** Left border wall; player hanging next to it. */
  function leftWall(): PlayerRig {
    const rows = new MapBuilder(30, 60).rows();
    return airborne(rows, T + HALF_W, 20 * T);
  }

  test('slide caps the fall speed and reports the wall', () => {
    const rig = leftWall();
    rig.run(90, hold(-1));
    const p = rig.player;
    expect(p.mode).toBe('wallSlide');
    expect(p.vy).toBeLessThanOrEqual(tun.wallSlideMaxSpeed);
    expect(p.vy).toBeGreaterThan(0);
    expect(p.wallDir).toBe(-1);
    expect(p.facing).toBe(1);
    const start = rig.eventsOf(SimEventType.WallSlideStart);
    expect(start).toHaveLength(1);
    expect(start[0]?.a).toBe(-1);
    expect(start[0]?.x).toBe(T);
  });

  test('the slide cap holds from the entry tick of a fast fall', () => {
    const rig = leftWall();
    // Fall clear of the wall for a while, then drift into it at full fall speed.
    rig.player.x += 3 * T;
    rig.run(40);
    expect(rig.player.vy).toBeGreaterThan(tun.wallSlideMaxSpeed * 2);
    const entered = rig.until((p) => p.mode === 'wallSlide', hold(-1), 120);
    expect(entered).toBeGreaterThan(0);
    expect(rig.eventsOf(SimEventType.WallSlideStart)).toHaveLength(1);
    expect(rig.player.modeTicks).toBe(0);
    expect(rig.player.vy).toBeLessThanOrEqual(tun.wallSlideMaxSpeed);
  });

  test('wall stick: input away is ignored for the stick window, then the slide releases', () => {
    const rig = leftWall();
    rig.run(20, hold(-1));
    const x = rig.player.x;
    rig.run(tun.wallStickTicks - 1, hold(1));
    expect(rig.player.x).toBe(x);
    expect(rig.player.mode).toBe('wallSlide');
    rig.step(hold(1));
    expect(rig.player.mode).toBe('air');
    const end = rig.eventsOf(SimEventType.WallSlideEnd);
    expect(end).toHaveLength(1);
    expect(end[0]?.b).toBe(0);
    rig.step(hold(1));
    expect(rig.player.x).toBeGreaterThan(x);
  });

  test('wall jump: direction, impulse, facing, event and height', () => {
    const rig = leftWall();
    rig.run(20, hold(-1));
    const y0 = rig.player.y;
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    const p = rig.player;
    expect(p.vx).toBe(tun.wallJumpVx);
    expect(p.facing).toBe(1);
    const wj = rig.eventsOf(SimEventType.WallJump);
    expect(wj).toHaveLength(1);
    expect(wj[0]?.a).toBe(1);
    expect(wj[0]?.x).toBe(T);
    expect(rig.eventsOf(SimEventType.WallSlideEnd)[0]?.b).toBe(2);
    let minY = p.y;
    for (let i = 0; i < 60; i++) {
      rig.step((f) => {
        f.jumpHeld = true;
      });
      minY = Math.min(minY, p.y);
    }
    const height = y0 - minY;
    expect(height).toBeGreaterThanOrEqual(tun.wallJumpHeight - 2);
    expect(height).toBeLessThanOrEqual(tun.wallJumpHeight + der.apexHangExtra + 2);
  });

  test('horizontal control ramps back over the wall-jump lock', () => {
    const rig = leftWall();
    rig.run(20, hold(-1));
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
      f.moveX = -1;
    });
    expect(rig.player.vx).toBe(tun.wallJumpVx);
    let vx = rig.player.vx;
    for (let k = 1; k <= tun.wallJumpLockTicks; k++) {
      rig.step((f) => {
        f.jumpHeld = true;
        f.moveX = -1;
      });
      const expected = tun.airTurnAccel * (Math.min(k, tun.wallJumpLockTicks) / tun.wallJumpLockTicks) * SIM_DT;
      const rate = k < tun.wallJumpLockTicks ? expected : tun.airTurnAccel * SIM_DT;
      expect(vx - rig.player.vx, `k=${k}`).toBeCloseTo(rate, 6);
      vx = rig.player.vx;
      if (vx <= 0) break;
    }
  });

  test('jump release is ignored during the lock', () => {
    const released = leftWall();
    released.run(20, hold(-1));
    released.step((f) => {
      f.jumpPressed = true;
    });
    released.run(tun.wallJumpLockTicks - 1);
    const held = leftWall();
    held.run(20, hold(-1));
    held.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    held.run(tun.wallJumpLockTicks - 1, (f) => {
      f.jumpHeld = true;
    });
    expect(released.player.vy).toBe(held.player.vy);
  });

  test('single-wall climb gains at least 130 u per cycle', () => {
    const rig = leftWall();
    rig.run(10, hold(-1));
    const tops: number[] = [];
    let cycles = 0;
    let lastSlideStarts = rig.eventsOf(SimEventType.WallSlideStart).length;
    for (let i = 0; i < 600 && cycles < 4; i++) {
      const starts = rig.eventsOf(SimEventType.WallSlideStart).length;
      const press = starts > lastSlideStarts || i === 0;
      lastSlideStarts = starts;
      if (press) {
        tops.push(rig.player.y);
        cycles++;
      }
      rig.step((f) => {
        f.moveX = -1;
        f.jumpPressed = press;
        f.jumpHeld = true;
      });
    }
    expect(tops.length).toBe(4);
    for (let i = 1; i < tops.length; i++) expect((tops[i - 1] as number) - (tops[i] as number)).toBeGreaterThanOrEqual(130);
    expect(rig.eventsOf(SimEventType.WallJump)).toHaveLength(4);
  });

  test('wall coyote: a jump shortly after leaving the wall is still a wall jump', () => {
    const rig = leftWall();
    rig.run(20, hold(-1));
    rig.run(tun.wallStickTicks + 1, hold(1));
    expect(rig.player.wallDir).toBe(0);
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    const wj = rig.eventsOf(SimEventType.WallJump);
    expect(wj).toHaveLength(1);
    expect(wj[0]?.x).toBe(T);
  });

  test('WallSlideEnd reasons: landed and wall ended', () => {
    const landed = airborne(new MapBuilder(20, 12).rows(), T + HALF_W, 6 * T);
    landed.until((p) => p.grounded, hold(-1));
    expect(landed.eventsOf(SimEventType.WallSlideEnd).map((e) => e.b)).toEqual([1]);

    const rows = new MapBuilder(20, 30).fill(8, 1, 9, 12, '#').rows();
    const ended = airborne(rows, 10 * T + HALF_W, 8 * T);
    ended.until((p) => p.y > 16 * T, hold(-1));
    expect(ended.eventsOf(SimEventType.WallSlideEnd).map((e) => e.b)).toEqual([3]);
  });
});

describe('dash', () => {
  test('exact distance, zero vy, progress and timed end', () => {
    const rig = airborne(flat(), 10 * T, 12 * T);
    const x0 = rig.player.x;
    const y0 = rig.player.y;
    const progress: number[] = [];
    rig.step((f) => {
      f.dashPressed = true;
      f.dashHeld = true;
      f.moveX = 1;
    });
    progress.push(rig.player.dashProgress);
    for (let k = 1; k < tun.dashTicks; k++) {
      rig.step();
      progress.push(rig.player.dashProgress);
      expect(rig.player.mode).toBe('dash');
      expect(rig.player.vy).toBe(0);
    }
    expect(rig.player.x - x0).toBeCloseTo(tun.dashSpeed * tun.dashTicks * SIM_DT, 2);
    expect(rig.player.y).toBe(y0);
    expect(progress[0]).toBeCloseTo(1 / tun.dashTicks, 12);
    expect(progress[tun.dashTicks - 1]).toBe(1);
    rig.step();
    expect(rig.player.mode).toBe('air');
    expect(rig.player.dashProgress).toBe(0);
    const end = rig.eventsOf(SimEventType.DashEnd);
    expect(end).toHaveLength(1);
    expect(end[0]?.b).toBe(0);
    const dash = rig.eventsOf(SimEventType.Dash);
    expect(dash[0]).toMatchObject({ a: 1, b: 1 });
    expect(rig.player.vx).toBeLessThanOrEqual(tun.dashEndSpeed);
    expect(rig.player.vx).toBeGreaterThan(tun.dashEndSpeed - tun.airDecel * SIM_DT - 1e-9);
  });

  test('direction: input, else facing', () => {
    const rig = new PlayerRig(flat(20));
    rig.step(hold(-1));
    rig.run(3);
    rig.step((f) => {
      f.dashPressed = true;
    });
    expect(rig.player.dashDir).toBe(-1);
    expect(rig.eventsOf(SimEventType.Dash)[0]).toMatchObject({ a: -1, b: 0 });
  });

  test('cooldown counts from the start tick', () => {
    const rig = new PlayerRig(flat(3));
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    rig.run(tun.dashCooldownTicks - 2);
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    expect(rig.eventsOf(SimEventType.Dash)).toHaveLength(1);
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    const dashes = rig.eventsOf(SimEventType.Dash);
    expect(dashes).toHaveLength(2);
    expect((dashes[1]?.tick as number) - (dashes[0]?.tick as number)).toBe(tun.dashCooldownTicks);
  });

  test('one air dash until landing', () => {
    const rig = airborne(flat(), 10 * T, 6 * T);
    rig.step((f) => {
      f.dashPressed = true;
    });
    rig.run(tun.dashCooldownTicks + 2);
    rig.step((f) => {
      f.dashPressed = true;
    });
    expect(rig.eventsOf(SimEventType.Dash)).toHaveLength(1);
    expect(rig.player.airDashesLeft).toBe(0);
    rig.until((p) => p.grounded);
    expect(rig.player.airDashesLeft).toBe(tun.airDashes);
  });

  test('hitting a wall ends the dash with vx = 0 (b = 2)', () => {
    const rows = new MapBuilder(30, 12).fill(14, 1, 14, 10, '#').put(11, 10, 'P').rows();
    const rig = new PlayerRig(rows);
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    rig.until((p) => p.mode !== 'dash');
    expect(rig.player.x + HALF_W).toBe(14 * T);
    expect(rig.player.vx).toBe(0);
    expect(rig.eventsOf(SimEventType.DashEnd)[0]?.b).toBe(2);
  });

  test('dash-jump: a jump during a ground dash cancels it and keeps vx', () => {
    const rig = new PlayerRig(flat(3));
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    rig.run(3, hold(1));
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
      f.moveX = 1;
    });
    const jump = rig.eventsOf(SimEventType.Jump);
    expect(jump).toHaveLength(1);
    expect(jump[0]?.b).toBe(1);
    expect(rig.eventsOf(SimEventType.DashEnd)[0]?.b).toBe(1);
    expect(rig.player.vx).toBeCloseTo(tun.dashSpeed - tun.airDecel * SIM_DT, 9);
    expect(rig.player.vy).toBeLessThan(0);
  });

  test('same-tick jump + dash: the dash starts, the buffered jump cancels it next tick', () => {
    const rig = new PlayerRig(flat(3));
    rig.step((f) => {
      f.dashPressed = true;
      f.jumpPressed = true;
      f.jumpHeld = true;
      f.moveX = 1;
    });
    expect(rig.player.mode).toBe('dash');
    expect(rig.eventsOf(SimEventType.Jump)).toHaveLength(0);
    rig.step((f) => {
      f.jumpHeld = true;
      f.moveX = 1;
    });
    const jump = rig.eventsOf(SimEventType.Jump);
    expect(jump).toHaveLength(1);
    expect(jump[0]?.tick).toBe(2);
    expect(jump[0]?.b).toBe(1);
  });

  test('ledge assist: a dash pops onto a ledge within ledgeAssist, one unit more is blocked', () => {
    const rows = new MapBuilder(30, 20).fill(15, 10, 28, 18, '#').rows();
    const top = 10 * T;
    const pops = airborne(rows, 13 * T, top + tun.ledgeAssist);
    pops.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    pops.run(tun.dashTicks);
    expect(pops.player.y).toBe(top);
    expect(pops.player.grounded).toBe(true);
    expect(pops.player.x).toBeGreaterThan(15 * T);
    expect(pops.eventsOf(SimEventType.DashEnd)[0]?.b).toBe(0);

    const blocked = airborne(rows, 13 * T, top + tun.ledgeAssist + 1);
    blocked.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    blocked.until((p) => p.mode !== 'dash');
    expect(blocked.player.x + HALF_W).toBe(15 * T);
    expect(blocked.eventsOf(SimEventType.DashEnd)[0]?.b).toBe(2);
  });

  test('ledge assist while falling into a ledge edge', () => {
    const rows = new MapBuilder(30, 20).fill(15, 10, 28, 18, '#').rows();
    const top = 10 * T;
    const rig = airborne(rows, 15 * T - HALF_W - 2, top + 4);
    expect(rig.until((p) => p.grounded, hold(1), 20)).toBeGreaterThan(0);
    expect(rig.player.y).toBe(top);
    expect(rig.player.x - HALF_W).toBeGreaterThan(15 * T - tun.width);
    expect(rig.eventsOf(SimEventType.Land)).toHaveLength(1);
  });
});

describe('corner correction', () => {
  /** A ceiling block whose left edge overlaps the head by `overlap` u when jumping straight up. */
  function corner(overlap: number): PlayerRig {
    const rows = new MapBuilder(30, 14).fill(15, 8, 20, 8, '#').rows();
    const rig = new PlayerRig(rows);
    rig.player.reset(15 * T + overlap - HALF_W, 13 * T, 0);
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.run(30, (f) => {
      f.jumpHeld = true;
    });
    return rig;
  }

  test(`nudges past a corner overlapping by cornerCorrection u`, () => {
    const rig = corner(tun.cornerCorrection);
    expect(rig.player.x + HALF_W).toBe(15 * T);
    expect(rig.player.y - rig.player.height).toBeLessThan(9 * T - T / 2);
  });

  test('bonks one unit beyond it', () => {
    const rig = corner(tun.cornerCorrection + 1);
    expect(rig.player.x + HALF_W).toBe(15 * T + tun.cornerCorrection + 1);
    expect(rig.player.y - rig.player.height).toBeGreaterThanOrEqual(9 * T);
  });

  test('the head bonks with vy = 0 under a flat ceiling', () => {
    const rows = new MapBuilder(30, 14).fill(1, 9, 28, 9, '#').put(10, 12, 'P').rows();
    const rig = new PlayerRig(rows);
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.until((p) => p.vy >= 0, (f) => {
      f.jumpHeld = true;
    });
    expect(rig.player.y - rig.player.height).toBe(10 * T);
  });
});

describe('one-way platforms', () => {
  const rows = new MapBuilder(30, 20).fill(8, 14, 14, 14, '=').put(10, 13, 'P').rows();

  test('down + jump drops through (no Jump), then lands below', () => {
    const rig = new PlayerRig(rows);
    expect(rig.player.grounded).toBe(true);
    rig.step((f) => {
      f.jumpPressed = true;
      f.moveY = 1;
    });
    expect(rig.eventsOf(SimEventType.DropThrough)).toHaveLength(1);
    expect(rig.eventsOf(SimEventType.Jump)).toHaveLength(0);
    rig.until((p) => p.grounded, (f) => {
      f.moveY = 1;
    });
    expect(rig.player.y).toBe(19 * T);
  });

  test('down + jump on solid ground is a normal jump', () => {
    const rig = new PlayerRig(new MapBuilder(30, 20).put(10, 18, 'P').rows());
    rig.step((f) => {
      f.jumpPressed = true;
      f.moveY = 1;
    });
    expect(rig.eventsOf(SimEventType.Jump)).toHaveLength(1);
  });

  test('jump up through from below and land on top', () => {
    const rig = new PlayerRig(new MapBuilder(30, 20).fill(8, 16, 14, 16, '=').put(10, 18, 'P').rows());
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    rig.until((p) => p.grounded, (f) => {
      f.jumpHeld = true;
    });
    expect(rig.player.y).toBe(16 * T);
  });
});

describe('facing', () => {
  test('follows input above dirThreshold only', () => {
    const rig = new PlayerRig(flat());
    rig.step(hold(-1));
    expect(rig.player.facing).toBe(-1);
    rig.step(hold(tun.dirThreshold * 0.9));
    expect(rig.player.facing).toBe(-1);
    rig.step(hold(tun.dirThreshold));
    expect(rig.player.facing).toBe(1);
  });

  test('keeps the launch direction during the wall-jump lock', () => {
    const rig = airborne(new MapBuilder(30, 60).rows(), T + HALF_W, 20 * T);
    rig.run(20, hold(-1));
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
      f.moveX = -1;
    });
    for (let i = 0; i < tun.wallJumpLockTicks - 1; i++) {
      rig.step(hold(-1));
      expect(rig.player.facing).toBe(1);
    }
    rig.run(2, hold(-1));
    expect(rig.player.facing).toBe(-1);
  });

  test('dash direction wins while dashing', () => {
    const rig = new PlayerRig(flat(20));
    rig.step((f) => {
      f.dashPressed = true;
      f.moveX = 1;
    });
    rig.step(hold(-1));
    expect(rig.player.facing).toBe(1);
  });
});

describe('state bookkeeping', () => {
  test('modeTicks is 0 on the entry tick; airTicks counts from the last grounded tick', () => {
    const rig = new PlayerRig(flat());
    rig.run(3);
    expect(rig.player.modeTicks).toBe(3);
    rig.step((f) => {
      f.jumpPressed = true;
    });
    expect(rig.player.mode).toBe('air');
    expect(rig.player.modeTicks).toBe(0);
    expect(rig.player.airTicks).toBe(1);
    rig.step();
    expect(rig.player.modeTicks).toBe(1);
    expect(rig.player.airTicks).toBe(2);
  });

  test('kill and reset', () => {
    const rig = new PlayerRig(flat());
    rig.player.kill(4);
    expect(rig.player.alive).toBe(false);
    expect(rig.player.mode).toBe('dead');
    expect(rig.player.deadTicks).toBe(0);
    const x = rig.player.x;
    rig.run(3, hold(1));
    expect(rig.player.x).toBe(x);
    expect(rig.player.deadTicks).toBe(3);
    rig.player.reset(5 * T, 23 * T, 42);
    expect(rig.player.alive).toBe(true);
    expect(rig.player.deadTicks).toBe(-1);
    expect(rig.player.warpTick).toBe(42);
    expect(rig.player.prevX).toBe(5 * T);
    expect(rig.player.mode).toBe('ground');
  });

  test('a jump that bonks on a flush ceiling without leaving the ground leaves no stale jump arc', () => {
    // A two-tile-tall hero under a ceiling flush with its head: the jump fires (Jump event) but the
    // head bonks on the first tick, so there is no landing. Walking off the ledge afterwards with jump
    // held must fall with the normal gravity, not the apex hang of a jump arc.
    const tall = { height: 2 * T };
    const rows = new MapBuilder(20, 12).fill(1, 5, 4, 5, '#').put(2, 7, 'P').fill(1, 8, 5, 8, '#').rows();
    const walkOff = (rig: PlayerRig): number[] => {
      const vys: number[] = [];
      for (let i = 0; i < 40; i++) {
        rig.step((f) => {
          f.moveX = 1;
          f.jumpHeld = true;
        });
        vys.push(rig.player.vy);
      }
      return vys;
    };
    const bonked = new PlayerRig(rows, tall);
    expect(bonked.player.grounded).toBe(true);
    bonked.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    expect(bonked.eventsOf(SimEventType.Jump)).toHaveLength(1);
    expect(bonked.player.grounded).toBe(true);
    expect(bonked.player.vy).toBe(0);
    const reference = new PlayerRig(rows, tall);
    reference.step();
    expect(walkOff(bonked)).toEqual(walkOff(reference));
  });

  test('bounce: cuttable jump-like impulse restoring abilities', () => {
    const rig = airborne(flat(), 10 * T, 10 * T);
    rig.step((f) => {
      f.jumpPressed = true;
      f.dashPressed = true;
    });
    rig.run(tun.dashTicks + 30);
    expect(rig.player.airJumpsLeft).toBe(0);
    const v = 800;
    rig.player.bounce(v);
    expect(rig.player.vy).toBe(-v);
    expect(rig.player.mode).toBe('air');
    expect(rig.player.airJumpsLeft).toBe(tun.airJumps);
    expect(rig.player.airDashesLeft).toBe(tun.airDashes);
    // Released jump: the whole rise runs at the jump-cut gravity.
    const released = apexOf(rig, () => {});
    expect(Math.abs(released.height - (v * v) / (2 * der.gravity * tun.jumpCutGravityMult))).toBeLessThan(1);
  });
});

describe('determinism', () => {
  test('identical input sequences give identical state after 600 ticks', () => {
    const rows = new MapBuilder(60, 30).fill(20, 20, 30, 20, '=').fill(35, 12, 36, 28, '#').fill(40, 25, 50, 28, '^').put(5, 28, 'P').rows();
    const script = (seed: number): InputFrame[] => {
      const rng = new Rng(seed);
      const out: InputFrame[] = [];
      let mx = 0;
      for (let i = 0; i < 600; i++) {
        if (rng.chance(0.08)) mx = rng.pick([-1, 0, 1, 0.5]);
        out.push({
          moveX: mx, moveY: rng.chance(0.05) ? 1 : 0, jumpPressed: rng.chance(0.06), jumpHeld: rng.chance(0.6),
          dashPressed: rng.chance(0.02), dashHeld: false, launchPressed: false, launchHeld: false,
        });
      }
      return out;
    };
    const a = new PlayerRig(rows);
    const b = new PlayerRig(rows);
    const inputs = script(7);
    for (const f of inputs) {
      a.step((g) => Object.assign(g, f));
      b.step((g) => Object.assign(g, f));
    }
    expect(a.player.x).toBe(b.player.x);
    expect(a.player.y).toBe(b.player.y);
    expect(a.player.vx).toBe(b.player.vx);
    expect(a.player.vy).toBe(b.player.vy);
    expect(a.log).toEqual(b.log);
    expect(a.log.length).toBeGreaterThan(10);
  });
});
