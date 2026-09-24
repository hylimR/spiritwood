/**
 * Entity close-ups through the real EntitiesView (CPU-rendered, bloomed and graded): lumen stones
 * dormant / just activated / resting, the Gloomcrawler walking and stunned, the Moonwell shrine idle
 * and surging, and orbs (idle, magnetised, being collected).
 * Usage: node tools/preview/pipe/entities.ts [outDir]
 */
import { join } from 'node:path';
import { Container, Matrix } from 'pixi.js';
import { PALETTE } from '../../../src/config.ts';
import { AREA_GRADE_TABLE } from '../../../src/content/grades.ts';
import { SimEventType, type SimEvent } from '../../../src/contracts/sim.ts';
import type { GradeParams } from '../../../src/contracts/render.ts';
import { EntitiesView } from '../../../src/render/entities/entitiesView.ts';
import { gradePixel } from '../../../src/render/post/gradeMath.ts';
import { createFakeSimView, levelFromAscii, type FakeSim } from '../../../tests/shared/fixtures.ts';
import { createFrame as createFrameInfo, createTestContext, stepFrame } from '../../../tests/pipe/helpers.ts';
import type { FrameInfo, RenderContext } from '../../../src/contracts/render.ts';
import { blurFrame, createFrame, renderTree, type Frame } from './cpuScene.ts';
import { hexToRgb, mutable, outDir, savePng, type Image } from './common.ts';

const dir = outDir();

const MAP = [
  '.....................................................',
  '.....................................................',
  '.....................................................',
  '..C.....C.....C.......EEEEEEE.......EEEEEEE......GG..',
  '#####################################################',
];

interface Rig {
  ctx: RenderContext;
  sim: FakeSim;
  view: EntitiesView;
  frame: FrameInfo;
}

function rig(): Rig {
  const level = levelFromAscii(MAP);
  level.orbs.push({ id: 0, x: 60, y: 60, value: 1 }, { id: 1, x: 160, y: 60, value: 1 }, { id: 2, x: 260, y: 60, value: 1 });
  const ctx = createTestContext(level);
  const sim = createFakeSimView(level);
  const view = new EntitiesView();
  view.init(ctx);
  return { ctx, sim, view, frame: createFrameInfo(sim, ctx) };
}

function run(r: Rig, frames: number, each?: (i: number) => void, events: SimEvent[] = []): void {
  for (let i = 0; i < frames; i++) {
    each?.(i);
    r.sim.tick++;
    stepFrame(r.frame, r.sim, 1 / 60, 1);
    if (i === 0) for (const e of events) r.view.onSimEvent(e, r.frame);
    r.view.update(r.frame);
  }
}

/** Point the fake camera at a shot so the view's culling keeps it on screen. */
function aim(r: Rig, x: number, y: number): void {
  Object.assign(r.sim.camera, { x, y, prevX: x, prevY: y });
}

function shot(r: Rig, scale: number, cx: number, cy: number, w: number, h: number, grade: GradeParams): Image {
  const view = new Matrix().translate(-(cx - w / (2 * scale)), -(cy - h / (2 * scale))).scale(scale, scale);
  const scene = createFrame(w, h);
  const top = hexToRgb(PALETTE.fogFar);
  const bottom = hexToRgb(PALETTE.fogDeep);
  const ground = hexToRgb(PALETTE.silhouette);
  const groundY = 4 * 48;
  for (let y = 0; y < h; y++) {
    const wy = cy + (y - h / 2) / scale;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const t = y / h;
      const c = wy >= groundY ? ground : top.map((v, k) => (v + ((bottom[k] as number) - v) * t) * 0.8);
      scene.data.set([c[0] as number, c[1] as number, c[2] as number, 1], o);
    }
  }
  const root = new Container();
  root.addChild(r.ctx.scene.entities);
  renderTree(scene, root, view);
  const glowRoot = new Container();
  glowRoot.addChild(r.ctx.glow.entities);
  const half = createFrame(Math.ceil(w / 2), Math.ceil(h / 2));
  renderTree(half, glowRoot, view.clone().prepend(new Matrix().scale(0.5, 0.5)));
  const levels: Frame[] = [half, blurFrame(half, 2), blurFrame(half, 5), blurFrame(half, 12), blurFrame(half, 24)];
  const out: Image = { w, h, data: new Float32Array(w * h * 4) };
  const px: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const ho = (Math.min(half.h - 1, y >> 1) * half.w + Math.min(half.w - 1, x >> 1)) * 4;
      const bloom: [number, number, number] = [0, 0, 0];
      for (const l of levels) for (let c = 0; c < 3; c++) bloom[c] += (l.data[ho + c] as number) / levels.length;
      gradePixel(px, [scene.data[o] as number, scene.data[o + 1] as number, scene.data[o + 2] as number], bloom, grade, 0, hexToRgb(PALETTE.fogDeep), 0);
      out.data.set([px[0], px[1], px[2], 1], o);
    }
  }
  return out;
}

function stitch(images: Image[]): Image {
  const w = images.reduce((s, i) => s + i.w, 0);
  const h = Math.max(...images.map((i) => i.h));
  const out: Image = { w, h, data: new Float32Array(w * h * 4) };
  let ox = 0;
  for (const img of images) {
    for (let y = 0; y < img.h; y++) out.data.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), (y * w + ox) * 4);
    ox += img.w;
  }
  return out;
}

const shots: Image[] = [];

// Lumen stones: dormant, activated 0.25 s ago (flare + rising beam), resting (activated earlier, not current).
{
  const r = rig();
  const [a, b, c] = r.sim.checkpoints;
  if (b) Object.assign(b, { active: true, activatedTick: 45 });
  if (c) Object.assign(c, { active: false, activatedTick: 1 });
  void a;
  aim(r, 8 * 48, 110);
  run(r, 60);
  shots.push(shot(r, 1.5, 8 * 48 + 24, 110, 1100, 420, AREA_GRADE_TABLE.glade));
}

// Gloomcrawlers: walking, and stunned 30% into the stun.
{
  const r = rig();
  const [walk, stunned] = r.sim.enemies.map(mutable);
  if (stunned) Object.assign(stunned, { mode: 'stunned', modeDuration: 180, modeTicks: 40, vx: 0, x: 1400, prevX: 1400 });
  aim(r, 1330, 150);
  run(r, 50, (i) => {
    if (walk) {
      walk.prevX = walk.x;
      walk.x += 90 / 60;
    }
    if (stunned) stunned.modeTicks = 40 + i;
  });
  shots.push(shot(r, 3, 1330, 150, 1100, 420, AREA_GRADE_TABLE.canopy));
}

// Moonwell shrine: idle and surging.
for (const reached of [false, true]) {
  const r = rig();
  const goal = r.sim.goal ? mutable(r.sim.goal) : null;
  if (goal && reached) goal.reached = true;
  const events: SimEvent[] = reached ? [{ type: SimEventType.GoalReached, tick: 0, x: 0, y: 0, a: 30, b: 0, id: -1 }] : [];
  if (goal) aim(r, goal.x + goal.w / 2, goal.y);
  run(r, 20, undefined, events);
  if (goal) shots.push(shot(r, 2.2, goal.x + goal.w / 2, goal.y + goal.h - 90, 520, 520, AREA_GRADE_TABLE.shrine));
}

// Orbs: idle, magnetised (moving fast), collected 0.1 s ago.
{
  const r = rig();
  const [idle, mag, col] = r.sim.orbs.map(mutable);
  aim(r, 160, 60);
  run(r, 30, (i) => {
    if (mag) {
      mag.prevX = mag.x;
      mag.x += 1000 / 60;
      mag.prevY = mag.y;
      if (i === 29) mag.x = 160;
      if (i === 29) mag.prevX = 160 - 1000 / 60;
    }
    if (col && i === 24) Object.assign(col, { collected: true, collectedTick: r.sim.tick });
  });
  void idle;
  shots.push(shot(r, 3, 160, 60, 700, 520, AREA_GRADE_TABLE.glade));
}

savePng(stitch(shots.slice(0, 2)), join(dir, 'entities-a.png'));
savePng(stitch(shots.slice(2)), join(dir, 'entities-b.png'));
console.log(`entity previews → ${dir}`);
