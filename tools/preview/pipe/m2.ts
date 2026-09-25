/**
 * M2 PIPE previews in the real forest (CPU composite, bloomed and graded): the Thorn Spitter's poses,
 * seeds with their trails (hostile and reflected), the ability shrine before and after the unlock, and
 * the Spirit Launch marks (candidate ring, locked ring + aim arrow under the freeze grade, the release
 * burst), and the anchor (fixed-aim) spitters against a player-aimed one in the real Thornveil and
 * through their rhythm. Each at gameplay scale (1 px per unit, as at 1080p) and 3×.
 * Usage: node tools/preview/pipe/m2.ts [outDir] [spitter|seeds|shrine|launch|hero|anchors|rhythm …]
 */
import { join } from 'node:path';
import { MAX_PROJECTILES, TILE } from '../../../src/config.ts';
import { AREA_GRADE_TABLE } from '../../../src/content/grades.ts';
import type { AbilityShrineDef, EnemyDef, LevelData, SpitterDef } from '../../../src/contracts/level.ts';
import type { FrameInfo } from '../../../src/contracts/render.ts';
import { SimEventType, type SimEvent } from '../../../src/contracts/sim.ts';
import { EntitiesView } from '../../../src/render/entities/entitiesView.ts';
import { HeroView } from '../../../src/render/hero/heroView.ts';
import { createFakeSimView, type FakeSim } from '../../../tests/shared/fixtures.ts';
import { createFrame, createTestContext, stepFrame } from '../../../tests/pipe/helpers.ts';
import { outDir, savePng } from './common.ts';
import { column, floorY, forestShot, loadForest, row, type ForestScene } from './forestShot.ts';

const dir = outDir();
const only = process.argv.slice(3);
const want = (name: string): boolean => only.length === 0 || only.includes(name);
const forest = loadForest();
const GRAVITY = 1400;

interface Stage {
  sim: FakeSim;
  entities: EntitiesView;
  hero: HeroView;
  frame: FrameInfo;
  events: SimEvent[];
}

function spitterDef(x: number, y: number, aim: 'player' | 'fixed' = 'player'): SpitterDef {
  return { id: 0, kind: 'thornSpitter', x, y, aim, fixedVx: 0, fixedVy: aim === 'fixed' ? -900 : 0, range: 720, period: 150, phase: 0, flightTicks: 60 };
}

function stage(f: ForestScene, spitters: SpitterDef[], shrines: AbilityShrineDef[] = []): Stage {
  const enemies: EnemyDef[] = [...f.level.enemies, ...spitters];
  enemies.forEach((e, i) => { e.id = i; });
  const lv: LevelData = { ...f.level, enemies, abilityShrines: shrines };
  const ctx = createTestContext(lv);
  const sim = createFakeSimView(lv);
  for (const e of sim.enemies) {
    if (e.kind !== 'thornSpitter') continue;
    e.width = 44;
    e.height = 60;
  }
  const entities = new EntitiesView();
  entities.init(ctx);
  const hero = new HeroView();
  hero.init(ctx);
  f.content = [ctx.scene.entities, ctx.scene.hero];
  f.glow = [ctx.glow.entities, ctx.glow.hero];
  return { sim, entities, hero, frame: createFrame(sim, ctx), events: [] };
}

function run(s: Stage, n: number, each?: (i: number) => void): void {
  for (let i = 0; i < n; i++) {
    each?.(i);
    s.sim.tick++;
    stepFrame(s.frame, s.sim, 1 / 60, 1);
    for (const e of s.events) {
      s.entities.onSimEvent(e, s.frame);
      s.hero.onSimEvent(e, s.frame);
    }
    s.events.length = 0;
    s.entities.update(s.frame);
    s.hero.update(s.frame);
  }
}

function emit(s: Stage, type: SimEvent['type'], x: number, y: number, a = 0, b = 0, id = -1): void {
  s.events.push({ type, tick: s.sim.tick, x, y, a, b, id });
}

/** Point the fake sim camera at the shot (views cull against it). */
function aimCam(s: Stage, x: number, y: number): void {
  Object.assign(s.sim.camera, { x, y, prevX: x, prevY: y });
}

function placeHero(s: Stage, x: number, y: number, facing: 1 | -1 = 1): void {
  const p = s.sim.player;
  Object.assign(p, { x, y, prevX: x, prevY: y, facing, warpTick: s.sim.tick });
}

/** Step a seed one tick along a ballistic (hostile) or straight (reflected) path. */
function stepSeed(s: Stage, i: number): void {
  const p = s.sim.projectiles[i];
  if (!p || !p.active) return;
  const dt = 1 / 60;
  p.prevX = p.x;
  p.prevY = p.y;
  const g = p.owner === 'hostile' ? GRAVITY : 0;
  const vy1 = p.vy + g * dt;
  p.x += p.vx * dt;
  p.y += (p.vy + vy1) * dt / 2;
  p.vy = vy1;
  p.age++;
}

function fire(s: Stage, i: number, x: number, y: number, vx: number, vy: number, owner: 'hostile' | 'reflected' = 'hostile', age = 0): void {
  const p = s.sim.projectiles[i];
  if (!p) return;
  Object.assign(p, {
    active: true, owner, x, y, prevX: x, prevY: y, vx, vy, spawnTick: s.sim.tick, age: 0,
    lifetime: owner === 'hostile' ? 300 : 150, sourceId: -1,
  });
  for (let k = 0; k < age; k++) stepSeed(s, i);
}

const veil = AREA_GRADE_TABLE.veil;
const outputs: string[] = [];
const save = (img: Parameters<typeof savePng>[0], name: string): void => {
  savePng(img, join(dir, name));
  outputs.push(name);
};

// ---- Thorn Spitter poses: idle, windup 50 %, windup 95 %, just fired, stunned, re-forming ----------------
if (want('spitter')) {
  const gy = floorY(forest.level, 24, 30);
  const xs = [20.6, 22.1, 23.6, 25.1, 26.6, 28.1].map((t) => t * TILE);
  const s = stage(forest, xs.map((x) => spitterDef(x, gy)));
  placeHero(s, 17 * TILE, floorY(forest.level, 17, 30));
  aimCam(s, 23 * TILE, gy - 200);
  const base = forest.level.enemies.length;
  const en = (k: number) => s.sim.enemies[base + k] as FakeSim['enemies'][number];
  run(s, 30);
  const W = 36;
  const set = (k: number, mode: 'idle' | 'windup' | 'cooldown' | 'stunned', ticks: number, dur: number): void => {
    Object.assign(en(k), { mode, modeTicks: ticks, modeDuration: dur, facing: -1 });
  };
  set(0, 'idle', 0, 0);
  set(1, 'windup', 18, W);
  set(2, 'windup', 34, W);
  set(3, 'windup', 30, W);
  set(4, 'stunned', 60, 300);
  set(5, 'stunned', 290, 300);
  run(s, 6, () => {
    en(1).modeTicks = Math.min(W - 1, en(1).modeTicks + 1);
    en(2).modeTicks = Math.min(W - 1, en(2).modeTicks + 1);
    en(3).modeTicks += 1;
  });
  // Fire from #3 (recoil + flash), re-form #5 (bloom).
  set(3, 'cooldown', 0, 114);
  fire(s, 0, xs[3] as number, gy - 50, -380, -520);
  emit(s, SimEventType.SeedFired, xs[3] as number, gy - 50, -380, -520, 0);
  (s.sim.projectiles[0] as { sourceId: number }).sourceId = base + 3;
  set(5, 'cooldown', 0, 150);
  emit(s, SimEventType.EnemyReformed, xs[5] as number, gy, 0, 0, base + 5);
  run(s, 4, () => stepSeed(s, 0));
  const cx = 24.35 * TILE;
  const cy = gy - 34;
  const one = forestShot(forest, cx, cy, 560, 170, 1, veil);
  const three = forestShot(forest, cx, cy, 1560, 360, 3, veil);
  save(column([one, three]), 'm2-spitter-poses.png');
  save(forestShot(forest, 22 * TILE, gy - 220, 1280, 720, 1, veil), 'm2-spitter-gameplay.png');
}

// ---- Seeds: hostile embers on an arc, a reflected wisp, fading ends ----------------------------------------
if (want('seeds')) {
  const gy = floorY(forest.level, 24, 30);
  const s = stage(forest, [spitterDef(27.5 * TILE, gy), spitterDef(20.5 * TILE, gy, 'fixed')]);
  placeHero(s, 16 * TILE, floorY(forest.level, 16, 30));
  aimCam(s, 23.5 * TILE, gy - 190);
  run(s, 10);
  fire(s, 0, 27.5 * TILE, gy - 50, -420, -760, 'hostile', 0);
  fire(s, 1, 20.5 * TILE, gy - 50, 0, -900, 'hostile', 0);
  run(s, 14, () => {
    stepSeed(s, 0);
    stepSeed(s, 1);
  });
  fire(s, 2, 22 * TILE, gy - 250, 1000, -80, 'reflected', 0);
  fire(s, 3, 24 * TILE, gy - 120, -300, 200, 'hostile', 0);
  const p3 = s.sim.projectiles[3];
  run(s, 8, (i) => {
    for (let k = 0; k < 4; k++) stepSeed(s, k);
    if (i === 0 && p3) p3.age = 290 - 8;
  });
  void MAX_PROJECTILES;
  const cx = 23.5 * TILE;
  const cy = gy - 190;
  save(forestShot(forest, cx, cy, 640, 360, 1, veil), 'm2-seeds-1x.png');
  save(forestShot(forest, cx, cy, 1440, 810, 3, veil), 'm2-seeds-3x.png');
}

// ---- Ability shrine: waiting (lit) and just taken (flare) ------------------------------------------------
if (want('shrine')) {
  const gy = floorY(forest.level, 86, 30);
  const shrine = (tx: number, id: number): AbilityShrineDef => ({ id, x: tx * TILE, y: gy - 4 * TILE, w: TILE, h: 4 * TILE, ability: 'launch' });
  const shots = [];
  for (const unlocked of [false, true]) {
    const s = stage(forest, [], [shrine(86, 0)]);
    placeHero(s, (unlocked ? 86.5 : 83) * TILE, gy);
    aimCam(s, 86.5 * TILE, gy - 70);
    run(s, 20);
    if (unlocked) {
      s.sim.launch.unlocked = true;
      emit(s, SimEventType.AbilityUnlocked, 86.5 * TILE, gy, 1, 0, 0);
      run(s, 12);
    }
    shots.push(forestShot(forest, 86.5 * TILE, gy - 70, 360, 220, 1, AREA_GRADE_TABLE.canopy));
    shots.push(forestShot(forest, 86.5 * TILE, gy - 70, 720, 440, 2.5, AREA_GRADE_TABLE.canopy));
  }
  save(row(shots), 'm2-shrine.png');
}

// ---- Spirit Launch: candidate ring on a seed and on a spitter; aiming (locked ring, arrow, freeze grade) --
if (want('launch')) {
  const gy = floorY(forest.level, 24, 30);
  const shots = [];
  for (const phase of ['candidate', 'aim', 'release']) {
    const s = stage(forest, [spitterDef(27.2 * TILE, gy)]);
    placeHero(s, 23 * TILE, gy);
    aimCam(s, 23.2 * TILE, gy - 110);
    s.sim.launch.unlocked = true;
    run(s, 10);
    fire(s, 0, 22.4 * TILE, gy - 150, 0, 0, 'hostile', 0);
    const seed = s.sim.projectiles[0];
    const spitterId = s.sim.enemies.length - 1;
    Object.assign(s.sim.launch, { candidateKind: 'seed', candidateId: 0, candidateX: seed?.x ?? 0, candidateY: seed?.y ?? 0, range: 170 });
    run(s, 12);
    let freeze = 0;
    if (phase !== 'candidate') {
      Object.assign(s.sim.launch, {
        candidateKind: 'none', candidateId: -1, targetKind: 'seed', targetId: 0, targetX: seed?.x ?? 0, targetY: seed?.y ?? 0,
        aimX: 0.6, aimY: -0.8, aimTicks: 30, aimMaxTicks: 120,
      });
      s.sim.player.mode = 'launchAim';
      s.sim.frozen = true;
      emit(s, SimEventType.LaunchAim, seed?.x ?? 0, seed?.y ?? 0, 1, 0, 0);
      run(s, 14, () => { s.sim.launch.aimTicks++; });
      freeze = 1;
    }
    if (phase === 'release') {
      s.sim.player.mode = 'launched';
      s.sim.frozen = false;
      const a = Math.atan2(-0.8, 0.6);
      Object.assign(s.sim.player, { vx: Math.cos(a) * 1150, vy: Math.sin(a) * 1150 });
      emit(s, SimEventType.Launch, s.sim.player.x, s.sim.player.y, a, 1, 0);
      run(s, 5, () => {
        const p = s.sim.player;
        p.prevX = p.x;
        p.prevY = p.y;
        p.x += p.vx / 60;
        p.y += p.vy / 60;
      });
      freeze = 0.3;
    }
    void spitterId;
    shots.push(forestShot(forest, 23.2 * TILE, gy - 110, 420, 260, 1, veil, 12.5, freeze));
    shots.push(forestShot(forest, 23.2 * TILE, gy - 110, 840, 520, 2.5, veil, 12.5, freeze));
  }
  save(column([row(shots.filter((_, i) => i % 2 === 0)), row(shots.filter((_, i) => i % 2 === 1))]), 'm2-launch.png');
}

// ---- Hero: the aim crouch reaching for targets (left, up-right) and launch dives at four angles ----------
if (want('hero')) {
  const gy = floorY(forest.level, 24, 30);
  const panels = [];
  const hx = 23 * TILE;
  const targets: [number, number][] = [[-60, -80], [55, -120]];
  for (const [tx, ty] of targets) {
    const s = stage(forest, []);
    placeHero(s, hx, gy);
    aimCam(s, hx, gy - 60);
    s.sim.launch.unlocked = true;
    run(s, 6);
    fire(s, 0, hx + tx, gy + ty, 0, 0, 'hostile', 0);
    Object.assign(s.sim.launch, {
      targetKind: 'seed', targetId: 0, targetX: hx + tx, targetY: gy + ty, aimX: -tx / Math.hypot(tx, ty), aimY: -ty / Math.hypot(tx, ty),
      aimTicks: 20, aimMaxTicks: 120,
    });
    s.sim.player.mode = 'launchAim';
    s.sim.frozen = true;
    emit(s, SimEventType.LaunchAim, hx + tx, gy + ty, 1, 0, 0);
    run(s, 24, () => { s.sim.launch.aimTicks++; });
    panels.push(forestShot(forest, hx + tx * 0.25, gy - 45, 400, 400, 5, veil, 12.5, 1));
  }
  for (const angle of [-Math.PI / 2, -Math.PI / 4, -0.12, Math.PI / 5]) {
    const s = stage(forest, []);
    placeHero(s, hx, gy - 160);
    aimCam(s, hx, gy - 200);
    run(s, 6);
    const p = s.sim.player;
    Object.assign(p, { mode: 'launched', grounded: false, vx: Math.cos(angle) * 1150, vy: Math.sin(angle) * 1150, facing: Math.cos(angle) >= 0 ? 1 : -1 });
    emit(s, SimEventType.Launch, p.x, p.y, angle, 1, 0);
    run(s, 7, () => {
      p.prevX = p.x;
      p.prevY = p.y;
      p.x += p.vx / 60;
      p.y += p.vy / 60;
      p.vy += 1400 * 0.35 / 60;
    });
    panels.push(forestShot(forest, p.x, p.y - 30, 400, 400, 3.2, veil));
  }
  save(row(panels), 'm2-hero.png');
}

// ---- Anchors (fixed aim) vs player-aimed spitters: the real Thornveil at gameplay scale, and the rhythm ---
if (want('anchors')) {
  const s = stage(forest, []);
  const spitters = s.sim.enemies.filter((e) => e.kind === 'thornSpitter');
  const byCell = (tx: number, ty: number) => spitters.find((e) => Math.abs(e.x - (tx + 0.5) * TILE) < 2 && Math.abs(e.y - (ty + 1) * TILE) < 2);
  const teach = byCell(181, 29);
  const rise = byCell(189, 32);
  const shaft = byCell(216, 18);
  const stun = byCell(208, 21);
  if (!teach || !rise || !shaft || !stun) throw new Error('Thornveil spitters not found');
  const W = 36;
  const set = (e: FakeSim['enemies'][number], mode: 'idle' | 'windup' | 'cooldown', ticks: number, dur: number, facing: 1 | -1 = 1): void => {
    Object.assign(e, { mode, modeTicks: ticks, modeDuration: dur, facing });
  };
  placeHero(s, 205.2 * TILE, 22 * TILE, 1);
  aimCam(s, 200 * TILE, 24 * TILE);
  run(s, 20);
  set(teach, 'windup', 26, W);
  set(rise, 'cooldown', 30, 54);
  set(stun, 'windup', 22, W, -1);
  set(shaft, 'windup', 34, W);
  run(s, 3, () => {
    teach.modeTicks++;
    rise.modeTicks++;
    stun.modeTicks++;
    shaft.modeTicks = Math.min(W - 1, shaft.modeTicks + 1);
  });
  // The shaft anchor fires straight up: flash, squash, a seed leaving its tip.
  set(shaft, 'cooldown', 0, 54);
  fire(s, 0, shaft.x, shaft.y - 50, 0, -850);
  (s.sim.projectiles[0] as { sourceId: number }).sourceId = shaft.id;
  emit(s, SimEventType.SeedFired, shaft.x, shaft.y - 50, 0, -850, 0);
  run(s, 5, () => {
    stepSeed(s, 0);
    teach.modeTicks = Math.min(W - 1, teach.modeTicks + 1);
    rise.modeTicks++;
    stun.modeTicks = Math.min(W - 1, stun.modeTicks + 1);
    shaft.modeTicks++;
  });
  const shots: ReturnType<typeof forestShot>[] = [];
  const view = (x: number, y: number, w: number, h: number, scale = 1): void => {
    aimCam(s, x, y);
    run(s, 1);
    shots.push(forestShot(forest, x, y, w, h, scale, veil));
  };
  // Gameplay scale: the teach pit, the rise gate's pedestal in its thorn chasm, the stun gate's hunter
  // beside the vertical gate's anchor.
  view(181.5 * TILE, 30 * TILE - 90, 520, 300);
  view(189.5 * TILE, 33 * TILE - 110, 520, 300);
  view(212.4 * TILE, 20 * TILE, 600, 300);
  save(row(shots.splice(0)), 'm2-anchors-thornveil.png');
  // Each at 3×: the three anchors (windup, cooldown, just fired) and the stun gate's hunter (windup).
  view(teach.x, teach.y - 45, 540, 420, 3);
  view(rise.x, rise.y - 45, 540, 420, 3);
  view(shaft.x, shaft.y - 45, 540, 420, 3);
  view(stun.x, stun.y - 45, 540, 420, 3);
  save(row(shots.splice(0)), 'm2-anchors-3x.png');
}

// ---- An anchor's rhythm: idle, cooldown 25 % / 90 %, windup 50 % / 95 %, just fired; a 60° anchor --------
if (want('rhythm')) {
  const gy = floorY(forest.level, 24, 30);
  const xs = [20.6, 22.1, 23.6, 25.1, 26.6, 28.1, 29.6].map((t) => t * TILE);
  const defs = xs.map((x) => spitterDef(x, gy, 'fixed'));
  const angled = defs[6] as SpitterDef;
  angled.fixedVx = 900 * Math.cos(Math.PI / 3);
  angled.fixedVy = -900 * Math.sin(Math.PI / 3);
  const s = stage(forest, defs);
  placeHero(s, 17.5 * TILE, floorY(forest.level, 17, 30));
  aimCam(s, 25 * TILE, gy - 200);
  const base = forest.level.enemies.length;
  const en = (k: number) => s.sim.enemies[base + k] as FakeSim['enemies'][number];
  run(s, 30);
  const W = 36;
  const set = (k: number, mode: 'idle' | 'windup' | 'cooldown', ticks: number, dur: number): void => {
    Object.assign(en(k), { mode, modeTicks: ticks, modeDuration: dur });
  };
  set(0, 'idle', 0, 0);
  set(1, 'cooldown', 13, 54);
  set(2, 'cooldown', 48, 54);
  set(3, 'windup', 17, W);
  set(4, 'windup', 33, W);
  set(5, 'windup', 30, W);
  set(6, 'windup', 26, W);
  run(s, 1);
  set(5, 'cooldown', 0, 54);
  fire(s, 0, xs[5] as number, gy - 50, 0, -900);
  (s.sim.projectiles[0] as { sourceId: number }).sourceId = base + 5;
  emit(s, SimEventType.SeedFired, xs[5] as number, gy - 50, 0, -900, 0);
  run(s, 3, () => stepSeed(s, 0));
  const cx = 25.1 * TILE;
  const cy = gy - 34;
  const one = forestShot(forest, cx, cy, 600, 130, 1, veil);
  const three = forestShot(forest, cx, cy, 1800, 330, 3, veil);
  save(column([one, three]), 'm2-anchor-rhythm.png');
}

console.log(`m2 previews → ${dir}: ${outputs.join(', ')}`);
