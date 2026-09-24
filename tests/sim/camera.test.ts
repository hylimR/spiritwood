import { describe, expect, test } from 'vitest';
import { SIM_DT, VIEW_H } from '../../src/config.ts';
import type { Facing } from '../../src/contracts/common.ts';
import type { PlayerMode } from '../../src/contracts/sim.ts';
import { CameraController, type CameraTarget } from '../../src/sim/camera.ts';
import { DEFAULT_CAMERA_TUNING } from '../../src/sim/tuning.ts';
import { MapBuilder, T, WorldRig } from './helpers.ts';

const ct = DEFAULT_CAMERA_TUNING;
const VIEW_W = VIEW_H * (16 / 9);

interface MutableTarget {
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: Facing;
  grounded: boolean;
  mode: PlayerMode;
}

function target(x: number, y: number): MutableTarget & CameraTarget {
  return { x, y, vx: 0, vy: 0, facing: 1, grounded: true, mode: 'ground' };
}

function bigCamera(t: MutableTarget): CameraController {
  const cam = new CameraController();
  cam.setBounds(0, 0, 20000, 10000);
  cam.setViewSize(VIEW_W, VIEW_H);
  cam.snapTo(t, 0);
  return cam;
}

function settle(cam: CameraController, t: CameraTarget, ticks = 240): void {
  for (let i = 0; i < ticks; i++) cam.step(t, SIM_DT);
}

describe('CameraController', () => {
  test('snapTo frames the target immediately with prev = cur', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    expect(cam.x).toBe(5000);
    expect(cam.y).toBe(5000 + ct.targetOffsetY);
    expect(cam.prevX).toBe(cam.x);
    expect(cam.prevY).toBe(cam.y);
    expect(cam.snapTick).toBe(0);
    t.x = 7000;
    cam.snapTo(t, 12);
    expect(cam.x).toBe(7000);
    expect(cam.prevX).toBe(7000);
    expect(cam.snapTick).toBe(12);
  });

  test('horizontal dead zone: moves inside half the width do not move the camera', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    t.x += ct.deadZoneW / 2 - 1;
    settle(cam, t);
    expect(cam.x).toBe(5000);
    t.x += 40;
    settle(cam, t);
    expect(cam.x).toBeCloseTo(t.x - ct.deadZoneW / 2, 3);
  });

  test('a full jump on flat ground moves the camera by less than 1 u vertically', () => {
    const rows = new MapBuilder(80, 40).put(40, 38, 'P').rows();
    const rig = new WorldRig(rows);
    const cam = rig.world.camera;
    rig.run(30);
    const y0 = cam.y;
    let maxDy = 0;
    rig.step((f) => {
      f.jumpPressed = true;
      f.jumpHeld = true;
    });
    for (let i = 0; i < 90; i++) {
      rig.step((f) => {
        f.jumpHeld = true;
      });
      maxDy = Math.max(maxDy, Math.abs(cam.y - y0));
    }
    expect(rig.world.player.grounded).toBe(true);
    expect(maxDy).toBeLessThan(1);
  });

  test('rising higher than airRiseMargin (a double jump or climb) pulls the camera up', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    t.grounded = false;
    t.mode = 'air';
    t.y = 5000 - ct.airRiseMargin - 100;
    settle(cam, t);
    expect(cam.y).toBeLessThan(5000 + ct.targetOffsetY - 40);
    expect(cam.y).toBeCloseTo(t.y + ct.airRiseMargin + ct.deadZoneH / 2 + ct.targetOffsetY, 3);
  });

  test('landing on a higher platform re-frames vertically (platform snapping)', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    t.y = 5000 - 3 * T;
    settle(cam, t);
    expect(cam.y).toBeCloseTo(t.y + ct.deadZoneH / 2 + ct.targetOffsetY, 3);
  });

  test('look-ahead engages after lookAheadCommitTicks of running', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    t.vx = 400;
    for (let i = 0; i < 180; i++) {
      t.x += t.vx * SIM_DT;
      cam.step(t, SIM_DT);
    }
    // Steady state: full look-ahead minus the critically damped follower's lag (v · smoothTime).
    const lead = cam.x - (t.x - ct.deadZoneW / 2);
    expect(Math.abs(lead - (ct.lookAheadX - t.vx * ct.smoothTimeX))).toBeLessThan(5);
  });

  test('a turn-around shorter than lookAheadCommitTicks does not flip the look-ahead', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    t.vx = 400;
    for (let i = 0; i < 180; i++) {
      t.x += t.vx * SIM_DT;
      cam.step(t, SIM_DT);
    }
    const before = cam.x;
    t.vx = -400;
    for (let i = 0; i < ct.lookAheadCommitTicks - 1; i++) {
      t.x += t.vx * SIM_DT;
      cam.step(t, SIM_DT);
    }
    t.vx = 400;
    let minX = cam.x;
    for (let i = 0; i < 60; i++) {
      t.x += t.vx * SIM_DT;
      cam.step(t, SIM_DT);
      minX = Math.min(minX, cam.x);
    }
    expect(before - minX).toBeLessThan(ct.lookAheadX / 2);
  });

  test('a sustained reversal flips the look-ahead', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    t.vx = 400;
    for (let i = 0; i < 180; i++) {
      t.x += t.vx * SIM_DT;
      cam.step(t, SIM_DT);
    }
    t.vx = -400;
    for (let i = 0; i < 240; i++) {
      t.x += t.vx * SIM_DT;
      cam.step(t, SIM_DT);
    }
    const lead = t.x + ct.deadZoneW / 2 - cam.x;
    expect(Math.abs(lead - (ct.lookAheadX + t.vx * ct.smoothTimeX))).toBeLessThan(5);
  });

  test('look-ahead releases after lookAheadHoldTicks standing still', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    t.vx = 400;
    for (let i = 0; i < 120; i++) {
      t.x += t.vx * SIM_DT;
      cam.step(t, SIM_DT);
    }
    t.vx = 0;
    settle(cam, t, ct.lookAheadHoldTicks - 1);
    const held = cam.x - (t.x - ct.deadZoneW / 2);
    expect(held).toBeGreaterThan(ct.lookAheadX * 0.5);
    settle(cam, t, 400);
    expect(Math.abs(cam.x - (t.x - ct.deadZoneW / 2))).toBeLessThan(1);
  });

  test('look-down only when falling fast and well below the last ground', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    t.grounded = false;
    t.mode = 'air';
    t.vy = ct.lookDownFallSpeed;
    t.y = 5000 + ct.lookDownMinDrop - 1;
    settle(cam, t);
    const noLook = cam.y;
    expect(noLook).toBeCloseTo(t.y - ct.deadZoneH / 2 + ct.targetOffsetY, 3);
    t.y = 5000 + ct.lookDownMinDrop;
    settle(cam, t);
    expect(cam.y).toBeCloseTo(t.y - ct.deadZoneH / 2 + ct.targetOffsetY + ct.lookDownMax, 3);
    t.vy = ct.lookDownFallSpeed - 1;
    settle(cam, t);
    expect(cam.y).toBeCloseTo(t.y - ct.deadZoneH / 2 + ct.targetOffsetY, 3);
  });

  test('the target is clamped to the level bounds', () => {
    const cam = new CameraController();
    cam.setBounds(0, 0, 4000, 2000);
    cam.setViewSize(VIEW_W, VIEW_H);
    const t = target(10, 1990);
    cam.snapTo(t, 0);
    expect(cam.x).toBe(VIEW_W / 2);
    expect(cam.y).toBe(2000 - VIEW_H / 2);
    t.x = 3990;
    t.y = 5;
    settle(cam, t, 600);
    expect(cam.x).toBeCloseTo(4000 - VIEW_W / 2, 3);
    expect(cam.y).toBeCloseTo(VIEW_H / 2, 3);
    expect(cam.x).toBeLessThanOrEqual(4000 - VIEW_W / 2);
  });

  test('a resize keeps an unstepped view inside the level at once (title screen, fullscreen toggle)', () => {
    const cam = new CameraController();
    cam.setBounds(0, 0, 4000, 2000);
    cam.setViewSize(VIEW_H * (4 / 3), VIEW_H);
    cam.snapTo(target(10, 1990), 3);
    expect(cam.x).toBe((VIEW_H * (4 / 3)) / 2);
    const wide = VIEW_H * (21 / 9);
    cam.setViewSize(wide, VIEW_H);
    expect(cam.x).toBe(wide / 2);
    expect(cam.prevX).toBe(wide / 2);
    expect(cam.y).toBe(2000 - VIEW_H / 2);
    // Taller view on a short level: centred vertically at once.
    cam.setViewSize(wide, 2400);
    expect(cam.y).toBe(1000);
    expect(cam.prevY).toBe(1000);
    expect(cam.snapTick).toBe(3);
    // The smoothing continues from the clamped position (no drift back out of bounds).
    cam.step(target(10, 1990), SIM_DT);
    expect(cam.x).toBe(wide / 2);
  });

  test('a level smaller than the view stays centred', () => {
    const cam = new CameraController();
    cam.setBounds(0, 0, 900, 600);
    cam.setViewSize(VIEW_W, VIEW_H);
    const t = target(100, 500);
    cam.snapTo(t, 0);
    expect(cam.x).toBe(450);
    expect(cam.y).toBe(300);
    t.x = 800;
    t.vx = 400;
    settle(cam, t, 120);
    expect(cam.x).toBe(450);
    expect(cam.y).toBe(300);
  });

  test('override follows an explicit point, snapTo honours it, clearOverride returns to the target', () => {
    const t = target(5000, 5000);
    const cam = bigCamera(t);
    cam.setOverride(8000, 3000);
    settle(cam, t, 600);
    expect(cam.x).toBeCloseTo(8000, 3);
    expect(cam.y).toBeCloseTo(3000, 3);
    cam.setOverride(9000, 3500);
    cam.snapTo(t, 5);
    expect(cam.x).toBe(9000);
    expect(cam.y).toBe(3500);
    cam.clearOverride();
    settle(cam, t, 600);
    expect(cam.x).toBeCloseTo(5000, 1);
  });

  test('zoom never drops below MIN_CAMERA_ZOOM and prev tracks cur', () => {
    const cam = new CameraController({ ...ct, zoom: 0.5 });
    expect(cam.zoom).toBe(1);
    const t = target(5000, 5000);
    cam.setBounds(0, 0, 20000, 10000);
    cam.snapTo(t, 0);
    t.x += 500;
    cam.step(t, SIM_DT);
    const x1 = cam.x;
    cam.step(t, SIM_DT);
    expect(cam.prevX).toBe(x1);
    expect(cam.prevZoom).toBe(cam.zoom);
  });
});
