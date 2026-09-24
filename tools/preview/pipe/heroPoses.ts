/**
 * CPU-posed hero previews: every clip at a few phases (large), a facing-left row, and the same poses at
 * in-game scale (1 and 1.5 px per world unit) to judge silhouette and readability.
 * Usage: node tools/preview/pipe/heroPoses.ts [outDir]
 */
import { join } from 'node:path';
import { PALETTE } from '../../../src/config.ts';
import { createRaster } from '../../../src/render/hero/atlas.ts';
import { composePose } from '../../../src/render/hero/heroBake.ts';
import { createHeroClips, HERO_CLIP, type HeroClipName } from '../../../src/render/hero/heroClips.ts';
import { buildHeroAtlas } from '../../../src/render/hero/heroParts.ts';
import { createHeroSkeleton, HERO_PARTS } from '../../../src/render/hero/heroRig.ts';
import { Animator } from '../../../src/render/hero/rig.ts';
import { createImage, gradientImage, hexToRgb, outDir, savePng, type Image } from './common.ts';

const dir = outDir();
const atlas = buildHeroAtlas();
const skeleton = createHeroSkeleton();
const clips = createHeroClips(skeleton);
const animator = new Animator(skeleton, clips);
const core = skeleton.indexOf('core');

const POSES: [HeroClipName, number][] = [
  ['idle', 0], ['idle', 0.45], ['run', 0], ['run', 0.22], ['run', 0.45], ['run', 0.64], ['run', 0.82],
  ['jump', 1], ['fall', 0.25], ['land', 0], ['wallSlide', 0], ['wallJump', 0.5], ['doubleJump', 0.1],
  ['doubleJump', 0.45], ['doubleJump', 0.8], ['dash', 0], ['dead', 1], ['respawn', 0], ['respawn', 0.55],
];

function pose(name: HeroClipName, phase: number): void {
  animator.snap(HERO_CLIP[name], phase);
  animator.apply(skeleton);
  if (name === 'doubleJump') {
    const t = phase;
    const eased = 1 - Math.pow(1 - t, 3);
    skeleton.pose[core * 5 + 2] = (skeleton.pose[core * 5 + 2] as number) + eased * Math.PI * 2;
  }
}

function blit(dst: Image, src: { w: number; h: number; data: Float32Array }, ox: number, oy: number): void {
  for (let y = 0; y < src.h; y++) {
    for (let x = 0; x < src.w; x++) {
      const s = (y * src.w + x) * 4;
      const a = src.data[s + 3] as number;
      if (a <= 0) continue;
      const o = ((oy + y) * dst.w + ox + x) * 4;
      for (let c = 0; c < 3; c++) dst.data[o + c] = (dst.data[o + c] as number) * (1 - a) + (src.data[s + c] as number) * a;
    }
  }
}

const DETAIL: [HeroClipName, number][] = [['idle', 0.2], ['run', 0.22], ['jump', 1], ['fall', 0.25], ['wallSlide', 0], ['dash', 0]];

function render(scale: number, cellW: number, cellH: number, facingLeft: boolean, poses = POSES): Image {
  const cols = poses.length;
  const img = gradientImage(cellW * cols, cellH, hexToRgb(PALETTE.skyHorizon), hexToRgb(PALETTE.fogDeep));
  poses.forEach(([name, phase], i) => {
    pose(name, phase);
    skeleton.evaluate(facingLeft ? [-1, 0, 0, 1, 0, 0] : undefined);
    const cell = createRaster(cellW, cellH);
    composePose(cell, atlas, skeleton, HERO_PARTS, {
      scale, originX: cellW / 2, originY: cellH - 12 * (scale / 5 + 0.4), facingLeft,
    });
    blit(img, cell, i * cellW, 0);
  });
  return img;
}

const big = render(5, 230, 420, false);
const left = render(5, 230, 420, true);
const combined = createImage(big.w, big.h * 2);
combined.data.set(big.data, 0);
combined.data.set(left.data, big.data.length);
savePng(combined, join(dir, 'hero-poses.png'));
savePng(render(1, 60, 90, false), join(dir, 'hero-poses-1x.png'));
savePng(render(9, 330, 700, false, DETAIL), join(dir, 'hero-detail.png'));
savePng(render(1.5, 80, 120, false), join(dir, 'hero-poses-1.5x.png'));
console.log(`hero poses → ${dir}`);
