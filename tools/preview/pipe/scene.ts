/**
 * Browser-free mock frame of the PIPE views: HeroView + EntitiesView driven by a fake sim through a
 * few seconds of motion, rendered with the CPU renderer over a simple night backdrop, then bloomed
 * (multi-radius blur of the glow twins) and graded with the composite's CPU reference.
 * Usage: node tools/preview/pipe/scene.ts [outDir]
 */
import { join } from 'node:path';
import { Container, Matrix } from 'pixi.js';
import { PALETTE, TILE } from '../../../src/config.ts';
import { AREA_GRADE_TABLE } from '../../../src/content/grades.ts';
import { AREA_GRADES } from '../../../src/contracts/level.ts';
import { SimEventType, type SimEvent } from '../../../src/contracts/sim.ts';
import type { GradeParams } from '../../../src/contracts/render.ts';
import { tileAt } from '../../../src/core/tiles.ts';
import { EntitiesView } from '../../../src/render/entities/entitiesView.ts';
import { HeroView } from '../../../src/render/hero/heroView.ts';
import { gradePixel } from '../../../src/render/post/gradeMath.ts';
import { createFakeSimView, levelFromAscii } from '../../../tests/shared/fixtures.ts';
import { createFrame as createFrameInfo, createTestContext, stepFrame } from '../../../tests/pipe/helpers.ts';
import { blurFrame, createFrame, renderTree, type Frame } from './cpuScene.ts';
import { hexToRgb, mutable, outDir, savePng, type Image } from './common.ts';

const MAP = [
  '............................................................',
  '............................................................',
  '............................................................',
  '............................................................',
  '................................o.o.o.......................',
  '.......................................######...............',
  '............................o...............................',
  '..........................======.................GG.........',
  '....C...P.....o...o...................EEEEEEE...............',
  '############################......##########################',
  '############################......##########################',
];

const dir = outDir();
const level = levelFromAscii(MAP);
const ctx = createTestContext(level);
const sim = createFakeSimView(level);
const hero = new HeroView();
const entities = new EntitiesView();
entities.init(ctx);
hero.init(ctx);
const frame = createFrameInfo(sim, ctx);
const events: SimEvent[] = [];
const emit = (type: SimEvent['type'], a = 0, b = 0, id = -1): void => {
  events.push({ type, tick: sim.tick, x: sim.player.x, y: sim.player.y, a, b, id });
};

const p = sim.player;
const cp = sim.checkpoints[0];
if (cp) Object.assign(cp, { active: true, activatedTick: 0 });
const enemy = sim.enemies[0] ? mutable(sim.enemies[0]) : undefined;

/** Scripted motion: run right, jump, double jump near the apex, fall onto the platform. */
function tick(i: number): void {
  sim.tick++;
  p.prevX = p.x;
  p.prevY = p.y;
  if (enemy) {
    enemy.prevX = enemy.x;
    enemy.x += enemy.vx / 60;
    if (enemy.x > enemy.x + 1e9) enemy.vx = -enemy.vx;
  }
  const orb = sim.orbs[3] ? mutable(sim.orbs[3]) : undefined;
  if (orb) {
    orb.prevX = orb.x;
    orb.prevY = orb.y;
    orb.x += (p.x - orb.x) * 0.03;
    orb.y += (p.y - 30 - orb.y) * 0.03;
  }
  if (i < 40) {
    p.vx = 440;
    p.inputX = 1;
    p.runDistance += 440 / 60;
  } else if (i === 40) {
    emit(SimEventType.Jump, 1);
    p.grounded = false;
    p.mode = 'air';
    p.vy = -905;
  } else if (i === 58) {
    emit(SimEventType.AirJump, 1);
    p.vy = -720;
  }
  if (i === 84) {
    emit(SimEventType.Dash, 1, 1);
    p.mode = 'dash';
    p.vy = 0;
    p.vx = 1180;
  } else if (i === 94) {
    emit(SimEventType.DashEnd, 1);
    p.mode = 'air';
    p.vx = 440;
  }
  if (!p.grounded && p.mode !== 'dash') p.vy += 2380 / 60;
  p.x += p.vx / 60;
  p.y += p.vy / 60;
}

const SHOTS = [6, 30, 47, 61, 72, 95];
let glade: Image | null = null;
const gradePanels: Image[] = [];
const closeups: Image[] = [];
const STOP = 110;
for (let i = 0; i < STOP; i++) {
  tick(i);
  stepFrame(frame, sim, 1 / 60, 1);
  ctx.stats.fillScreens = 0;
  for (const e of events) {
    entities.onSimEvent(e, frame);
    hero.onSimEvent(e, frame);
  }
  events.length = 0;
  entities.update(frame);
  hero.update(frame);
  if (SHOTS.includes(i)) closeups.push(render(4, p.x, p.y - 36, 360, 400, AREA_GRADE_TABLE.glade));
  if (i === 80) glade = render(1, p.x - 200, 300, 1280, 720, AREA_GRADE_TABLE.glade);
  if (i === 30) {
    for (const id of AREA_GRADES) gradePanels.push(render(1, p.x - 60, p.y - 90, 520, 400, AREA_GRADE_TABLE[id]));
  }
}

function render(scale: number, cx: number, cy: number, w: number, h: number, grade: GradeParams): Image {
  const view = new Matrix().translate(-(cx - w / (2 * scale)), -(cy - h / (2 * scale))).scale(scale, scale);
  const scene = createFrame(w, h);
  const top = hexToRgb(PALETTE.skyHorizon);
  const bottom = hexToRgb(PALETTE.fogDeep);
  for (let y = 0; y < h; y++) {
    const wy = cy + (y - h / 2) / scale;
    const t = Math.min(1, Math.max(0, y / h));
    for (let x = 0; x < w; x++) {
      const wx = cx + (x - w / 2) / scale;
      const solid = tileAt(level, Math.floor(wx / TILE), Math.floor(wy / TILE)) !== 0 && wy >= 0;
      const o = (y * w + x) * 4;
      const c = solid ? hexToRgb(PALETTE.silhouette) : top.map((v, k) => v + ((bottom[k] as number) - v) * t);
      scene.data[o] = c[0] as number;
      scene.data[o + 1] = c[1] as number;
      scene.data[o + 2] = c[2] as number;
      scene.data[o + 3] = 1;
    }
  }
  const root = new Container();
  root.addChild(ctx.scene.entities, ctx.scene.hero);
  renderTree(scene, root, view);
  const glowRoot = new Container();
  glowRoot.addChild(ctx.glow.entities, ctx.glow.hero);
  const half = createFrame(Math.ceil(w / 2), Math.ceil(h / 2));
  renderTree(half, glowRoot, view.clone().prepend(new Matrix().scale(0.5, 0.5)));
  const levels: Frame[] = [half, blurFrame(half, 2), blurFrame(half, 6), blurFrame(half, 14), blurFrame(half, 28)];
  const out: Image = { w, h, data: new Float32Array(w * h * 4) };
  const px: [number, number, number] = [0, 0, 0];
  const fog = hexToRgb(PALETTE.fogDeep);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const ho = (Math.min(half.h - 1, y >> 1) * half.w + Math.min(half.w - 1, x >> 1)) * 4;
      const bloom: [number, number, number] = [0, 0, 0];
      for (const l of levels) for (let c = 0; c < 3; c++) bloom[c] += (l.data[ho + c] as number) / levels.length;
      const r = Math.hypot((x / w - 0.5) * (w / h), y / h - 0.5) / Math.hypot(0.5 * (w / h), 0.5);
      gradePixel(px, [scene.data[o] as number, scene.data[o + 1] as number, scene.data[o + 2] as number], bloom, grade, 0, fog, r);
      out.data[o] = px[0];
      out.data[o + 1] = px[1];
      out.data[o + 2] = px[2];
      out.data[o + 3] = 1;
    }
  }
  return out;
}

if (glade) savePng(glade, join(dir, 'scene-glade.png'));
const strip: Image = { w: closeups.length * 360, h: 400, data: new Float32Array(closeups.length * 360 * 400 * 4) };
closeups.forEach((img, k) => {
  for (let y = 0; y < img.h; y++) strip.data.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), (y * strip.w + k * img.w) * 4);
});
savePng(strip, join(dir, 'scene-hero-closeups.png'));
const grades: Image = { w: gradePanels.length * 520, h: 400, data: new Float32Array(gradePanels.length * 520 * 400 * 4) };
gradePanels.forEach((img, k) => {
  for (let y = 0; y < img.h; y++) grades.data.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), (y * grades.w + k * img.w) * 4);
});
savePng(grades, join(dir, 'scene-grades.png'));
console.log(`scene preview (hero at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, fill ${ctx.stats.fillScreens.toFixed(3)}) → ${dir}`);
