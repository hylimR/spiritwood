import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { MAX_PROJECTILES } from '../../src/config.ts';
import type { LevelData } from '../../src/contracts/level.ts';
import { Ability, SimEventType } from '../../src/contracts/sim.ts';
import { Rng } from '../../src/core/rng.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { overlapsSolid } from '../../src/sim/physics.ts';
import { DEFAULT_CAMERA_TUNING } from '../../src/sim/tuning.ts';
import { LDTK_PATH } from '../../tools/level/build-level.ts';
import { WorldRig } from './helpers.ts';

const level: LevelData = parseLdtk(JSON.parse(readFileSync(LDTK_PATH, 'utf8')));

/**
 * Random-input soak over forest.ldtk: state invariants that must hold on every tick. Odd seeds also
 * press Spirit Launch (unlocked), so aims, freezes, flights and flung seeds are soaked too.
 */
describe('invariants under random input (forest.ldtk)', () => {
  test('finite state, never embedded in Solid, camera and enemies in bounds, bookkeeping consistent', () => {
    const failures: string[] = [];
    let launched = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const rig = new WorldRig(level);
      const w = rig.world;
      const rng = new Rng(seed);
      const c = w.checkpoints[seed % w.checkpoints.length];
      if (c) w.teleport(c.x + c.w / 2, c.y + c.h);
      const launches = seed % 2 === 1;
      if (launches) w.unlock(Ability.Launch);
      // The camera clamps its target with the current zoom; aiming zooms in (a looser bound).
      const zoom = launches ? Math.max(DEFAULT_CAMERA_TUNING.zoom, DEFAULT_CAMERA_TUNING.aimZoom) : DEFAULT_CAMERA_TUNING.zoom;
      let mx = 0;
      let my = 0;
      let held = false;
      let launchHeld = false;
      for (let i = 0; i < 3000 && failures.length < 5; i++) {
        if (rng.chance(0.06)) mx = rng.pick([-1, 0, 1, 0.4, -0.6]);
        if (rng.chance(0.04)) my = rng.pick([0, 0, 1, -1]);
        if (rng.chance(0.08)) held = !held;
        const jump = rng.chance(0.07);
        const dash = rng.chance(0.03);
        const launchPress = launches && !launchHeld && rng.chance(0.05);
        const launchRelease = launchHeld && rng.chance(0.1);
        if (launchPress) launchHeld = true;
        if (launchRelease) launchHeld = false;
        rig.step((f) => {
          f.moveX = mx;
          f.moveY = my;
          f.jumpPressed = jump;
          f.jumpHeld = held || jump;
          f.dashPressed = dash;
          f.dashHeld = dash;
          f.launchPressed = launchPress;
          f.launchHeld = launchHeld;
          f.launchReleased = launchRelease;
        });
        launched += rig.eventsOf(SimEventType.Launch).length;
        rig.log.length = 0;
        const p = w.player;
        const cam = w.camera;
        const at = `seed ${seed} tick ${w.tick}`;
        for (const v of [p.x, p.y, p.vx, p.vy, cam.x, cam.y, w.fade]) if (!Number.isFinite(v)) failures.push(`${at}: non-finite state`);
        if (p.alive && overlapsSolid(w.grid, p)) failures.push(`${at}: player (${p.x}, ${p.y}) inside Solid`);
        if (p.mode === 'wallSlide' && p.vy > p.tuning.wallSlideMaxSpeed + 1e-9) failures.push(`${at}: slide faster than the cap`);
        const halfW = cam.viewW / (2 * zoom);
        const halfH = cam.viewH / (2 * zoom);
        if (cam.x < halfW - 1e-6 || cam.x > level.pxWidth - halfW + 1e-6) failures.push(`${at}: camera x ${cam.x} out of bounds`);
        if (cam.y < halfH - 1e-6 || cam.y > level.pxHeight - halfH + 1e-6) failures.push(`${at}: camera y ${cam.y} out of bounds`);
        if (!launches && cam.zoom !== DEFAULT_CAMERA_TUNING.zoom) failures.push(`${at}: zoom ${cam.zoom} without a launch`);
        if (w.frozen !== (p.alive && p.mode === 'launchAim')) failures.push(`${at}: frozen ${w.frozen} in mode ${p.mode}`);
        let seeds = 0;
        for (const s of w.projectiles) {
          if (!s.active) continue;
          seeds++;
          if (!Number.isFinite(s.x) || !Number.isFinite(s.y) || !Number.isFinite(s.vx) || !Number.isFinite(s.vy)) failures.push(`${at}: non-finite seed ${s.id}`);
          if (s.age > s.lifetime) failures.push(`${at}: seed ${s.id} outlived its lifetime`);
        }
        if (seeds > MAX_PROJECTILES) failures.push(`${at}: ${seeds} seeds`);
        if (w.fade < 0 || w.fade > 1) failures.push(`${at}: fade ${w.fade}`);
        for (let k = 0; k < w.enemies.length; k++) {
          const e = w.enemies[k];
          const def = level.enemies[k];
          if (e && def && def.kind === 'gloomcrawler' && (e.x < def.patrolMinX || e.x > def.patrolMaxX)) failures.push(`${at}: enemy ${k} left its patrol range`);
        }
        let collected = 0;
        for (const o of w.orbs) if (o.collected) collected++;
        if (collected !== w.orbsCollected) failures.push(`${at}: orbsCollected ${w.orbsCollected} ≠ ${collected}`);
        if (p.alive !== (p.deadTicks < 0)) failures.push(`${at}: alive/deadTicks disagree`);
        if (p.alive && p.grounded && p.vy !== 0) failures.push(`${at}: grounded with vy ${p.vy}`);
        if (p.alive && p.grounded !== (p.airTicks === 0)) failures.push(`${at}: grounded/airTicks disagree`);
        if (p.alive && (p.mode === 'dash') !== (p.dashProgress > 0)) failures.push(`${at}: dash mode/progress disagree`);
        if (p.dashProgress < 0 || p.dashProgress > 1) failures.push(`${at}: dashProgress ${p.dashProgress}`);
        if (p.alive && p.mode === 'ground' && !p.grounded) failures.push(`${at}: ground mode while airborne`);
      }
    }
    expect(failures).toEqual([]);
    expect(launched).toBeGreaterThan(0);
  });
});
