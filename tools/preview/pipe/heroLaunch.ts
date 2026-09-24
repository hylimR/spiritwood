/**
 * The hero's Spirit Launch aim crouch reaching for targets (red crosses) in four directions, alone on a
 * dark backdrop at 3× (the arm and facing read without the forest behind).
 * Usage: node tools/preview/pipe/heroLaunch.ts [outDir]
 */
import { join } from 'node:path';
import { Container, Matrix } from 'pixi.js';
import { SimEventType } from '../../../src/contracts/sim.ts';
import { HeroView } from '../../../src/render/hero/heroView.ts';
import { createFakeSimView, levelFromAscii } from '../../../tests/shared/fixtures.ts';
import { createFrame as createFrameInfo, createTestContext, stepFrame } from '../../../tests/pipe/helpers.ts';
import { createFrame, renderTree } from './cpuScene.ts';
import { outDir, savePng, type Image } from './common.ts';
const out = outDir();
const level = levelFromAscii(['.'.repeat(40), '.'.repeat(40), '....P'.padEnd(40, '.'), '#'.repeat(40)]);
const panels: Image[] = [];
for (const [tx, ty] of [[-60, -80], [55, -120], [70, 0], [-40, 30]] as const) {
  const ctx = createTestContext(level);
  const sim = createFakeSimView(level);
  const hero = new HeroView();
  hero.init(ctx);
  const frame = createFrameInfo(sim, ctx);
  const p = sim.player;
  for (let i = 0; i < 6; i++) { sim.tick++; stepFrame(frame, sim); hero.update(frame); }
  Object.assign(sim.launch, { unlocked: true, targetKind: 'seed', targetId: 0, targetX: p.x + tx, targetY: p.y + ty, aimX: 0, aimY: -1 });
  p.mode = 'launchAim';
  hero.onSimEvent({ type: SimEventType.LaunchAim, tick: 0, x: p.x + tx, y: p.y + ty, a: 1, b: 0, id: 0 }, frame);
  frame.timeScale = 0.08;
  for (let i = 0; i < 30; i++) { sim.tick++; stepFrame(frame, sim); hero.update(frame); }
  const W = 240, H = 240, S = 3;
  const f = createFrame(W, H);
  for (let i = 0; i < W * H; i++) { f.data[i * 4] = 0.04; f.data[i * 4 + 1] = 0.07; f.data[i * 4 + 2] = 0.12; f.data[i * 4 + 3] = 1; }
  const view = new Matrix().translate(-(p.x - W / (2 * S)), -(p.y - 30 - H / (2 * S))).scale(S, S);
  const root = new Container();
  root.addChild(ctx.scene.hero);
  renderTree(f, root, view);
  // target marker
  const mx = Math.round((p.x + tx - (p.x - W / (2 * S))) * S), my = Math.round((p.y + ty - (p.y - 30 - H / (2 * S))) * S);
  for (let d = -4; d <= 4; d++) for (const [x, y] of [[mx + d, my], [mx, my + d]]) if (x >= 0 && y >= 0 && x < W && y < H) f.data.set([1, 0.3, 0.4, 1], (y * W + x) * 4);
  panels.push({ w: W, h: H, data: f.data });
}
const w = panels.length * 244;
const img: Image = { w, h: 240, data: new Float32Array(w * 240 * 4) };
panels.forEach((pn, k) => { for (let y = 0; y < 240; y++) img.data.set(pn.data.subarray(y * 240 * 4, (y + 1) * 240 * 4), (y * w + k * 244) * 4); });
savePng(img, join(out, 'hero-aim.png'));
