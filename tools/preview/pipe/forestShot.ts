/**
 * Real-forest backdrops for the PIPE previews: the WORLD preview compositor renders the shipped level
 * (sky, kit layers, shafts, terrain, decor, fog, foreground) on the CPU, and our display trees (entity
 * and hero slots plus their glow twins) are composited in as an overlay between the back and front
 * decor, then bloomed and graded with the composite's CPU reference.
 */
import { readFileSync } from 'node:fs';
import { Container, Matrix } from 'pixi.js';
import { PALETTE, TILE, VIEW_H } from '../../../src/config.ts';
import { parseManifest } from '../../../src/assets/manifest.ts';
import { TileKind, type LevelData } from '../../../src/contracts/level.ts';
import type { GradeParams } from '../../../src/contracts/render.ts';
import { hexToRgb, type RGB } from '../../../src/core/color.ts';
import { tileAt } from '../../../src/core/tiles.ts';
import { parseLdtk } from '../../../src/level/loader.ts';
import { generateKit, kitSeed } from '../../../src/render/gen/kit.ts';
import { gradePixel } from '../../../src/render/post/gradeMath.ts';
import { LDTK_PATH } from '../../level/build-level.ts';
import { buildScene, renderScene, type Camera, type Frame as WorldFrame, type Scene } from '../world/compose.ts';
import { decorOverlay, particlesOverlay, shaftsOverlay } from '../world/gameplay-overlay.ts';
import { addTerrain } from '../world/terrain-overlay.ts';
import { createFrame, renderTree } from './cpuScene.ts';
import type { Image } from './common.ts';

export interface ForestScene {
  level: LevelData;
  scene: Scene;
  /** Containers drawn by the overlay: scene content and glow twins (world space). */
  content: Container[];
  glow: Container[];
}

/** The shipped level with its forest composed once (a few seconds: kit atlas and layer meshes). */
export function loadForest(): ForestScene {
  const level = parseLdtk(JSON.parse(readFileSync(LDTK_PATH, 'utf8')));
  const manifest = parseManifest(JSON.parse(readFileSync(new URL('../../../public/layers/forest.manifest.json', import.meta.url), 'utf8')));
  const kit = generateKit(kitSeed('forest-kit'));
  const scene = buildScene(level, manifest, kit);
  scene.overlays.push(shaftsOverlay(scene));
  addTerrain(scene);
  const decor = decorOverlay(scene);
  const forest: ForestScene = { level, scene, content: [], glow: [] };
  scene.overlays.push(decor.back, (img) => drawViews(img, forest), decor.front, particlesOverlay(scene));
  return forest;
}

/** Feet y (u) of the first standable floor at or below tile row `fromTy` in column `tx`. */
export function floorY(level: LevelData, tx: number, fromTy: number): number {
  for (let ty = Math.max(1, fromTy); ty < level.heightTiles; ty++) {
    if (tileAt(level, tx, ty) === TileKind.Solid && tileAt(level, tx, ty - 1) !== TileKind.Solid) return ty * TILE;
  }
  return level.pxHeight;
}

function drawViews(img: WorldFrame, forest: ForestScene): void {
  const s = 1 / img.scale;
  const view = new Matrix(s, 0, 0, s, (-img.cam.cx + img.viewW / 2) * s, (-img.cam.cy + img.viewH / 2) * s);
  const composite = (roots: Container[], target: Float32Array): void => {
    const f = createFrame(img.w, img.h);
    const root = new Container();
    for (const c of roots) root.addChild(c);
    renderTree(f, root, view);
    for (const c of roots) root.removeChild(c);
    for (let i = 0; i < img.w * img.h; i++) {
      const a = f.data[i * 4 + 3] as number;
      for (let c = 0; c < 3; c++) target[i * 3 + c] = (f.data[i * 4 + c] as number) + (target[i * 3 + c] as number) * (1 - a);
    }
  };
  composite(forest.content, img.rgb);
  composite(forest.glow, img.glow);
}

function blur(src: Float32Array, w: number, h: number, radius: number, passes = 2): Float32Array {
  let a = src.slice();
  const b = new Float32Array(src.length);
  const norm = 1 / (2 * radius + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += a[(y * w + Math.min(w - 1, Math.max(0, k))) * 3 + c] as number;
        for (let x = 0; x < w; x++) {
          b[(y * w + x) * 3 + c] = sum * norm;
          sum += (a[(y * w + Math.min(w - 1, x + radius + 1)) * 3 + c] as number) - (a[(y * w + Math.max(0, x - radius)) * 3 + c] as number);
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) sum += b[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c] as number;
        for (let y = 0; y < h; y++) {
          a[(y * w + x) * 3 + c] = sum * norm;
          sum += (b[(Math.min(h - 1, y + radius + 1) * w + x) * 3 + c] as number) - (b[(Math.max(0, y - radius) * w + x) * 3 + c] as number);
        }
      }
    }
  }
  return a;
}

/**
 * Render the forest around (cx, cy) with the overlay, `pxPerUnit` pixels per world unit (1 = gameplay
 * scale at 1080p), then bloom (half-res twins, four blur levels) and grade. `time` drives the world's
 * animation (sway, fog, shafts).
 */
export function forestShot(
  forest: ForestScene, cx: number, cy: number, w: number, h: number, pxPerUnit: number, grade: GradeParams, time = 12.5, freeze = 0,
): Image {
  const cam: Camera = { name: 'pipe', cx, cy };
  const f = renderScene(forest.scene, cam, w, h, w / pxPerUnit, h / pxPerUnit, time);
  const hw = Math.floor(f.w / 2);
  const hh = Math.floor(f.h / 2);
  const half = new Float32Array(hw * hh * 3);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) sum += f.glow[((y * 2 + j) * f.w + x * 2 + i) * 3 + c] as number;
        half[(y * hw + x) * 3 + c] = sum / 4;
      }
    }
  }
  // Blur radii in glow pixels scale with the zoom so a closeup blooms like the 1× frame.
  const k = pxPerUnit * (VIEW_H / 1080);
  const levels = [half, ...[2, 4, 9, 18].map((r) => blur(half, hw, hh, Math.max(1, Math.round(r * k))))];
  const g: GradeParams = { ...grade, lift: [...grade.lift], gamma: [...grade.gamma], gain: [...grade.gain] };
  if (freeze > 0) {
    g.saturation *= 1 - 0.35 * freeze;
    g.temperature -= 0.3 * freeze;
    g.vignette += 0.15 * freeze;
  }
  const fog = hexToRgb(PALETTE.fogDeep);
  const out: Image = { w: f.w, h: f.h, data: new Float32Array(f.w * f.h * 4) };
  const px: RGB = [0, 0, 0];
  const sc: RGB = [0, 0, 0];
  const bl: RGB = [0, 0, 0];
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const i = y * f.w + x;
      const hi = (Math.min(hh - 1, y >> 1) * hw + Math.min(hw - 1, x >> 1)) * 3;
      for (let c = 0; c < 3; c++) {
        sc[c] = f.rgb[i * 3 + c] as number;
        let b = 0;
        for (const l of levels) b += l[hi + c] as number;
        bl[c] = b / levels.length;
      }
      const r = Math.hypot((x / f.w - 0.5) * (f.w / f.h), y / f.h - 0.5) / Math.hypot(0.5 * (f.w / f.h), 0.5);
      gradePixel(px, sc, bl, g, 0, fog, r);
      out.data[i * 4] = px[0];
      out.data[i * 4 + 1] = px[1];
      out.data[i * 4 + 2] = px[2];
      out.data[i * 4 + 3] = 1;
    }
  }
  return out;
}

/** Side-by-side images (top-aligned, `gap` px apart, dark gutter). */
export function row(images: readonly Image[], gap = 6): Image {
  const w = images.reduce((s, i) => s + i.w, 0) + gap * (images.length - 1);
  const h = Math.max(...images.map((i) => i.h));
  const out: Image = { w, h, data: new Float32Array(w * h * 4) };
  for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = 1;
  let ox = 0;
  for (const img of images) {
    for (let y = 0; y < img.h; y++) out.data.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), (y * w + ox) * 4);
    ox += img.w + gap;
  }
  return out;
}

export function column(images: readonly Image[], gap = 6): Image {
  const w = Math.max(...images.map((i) => i.w));
  const h = images.reduce((s, i) => s + i.h, 0) + gap * (images.length - 1);
  const out: Image = { w, h, data: new Float32Array(w * h * 4) };
  for (let i = 0; i < w * h; i++) out.data[i * 4 + 3] = 1;
  let oy = 0;
  for (const img of images) {
    for (let y = 0; y < img.h; y++) out.data.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), ((oy + y) * w) * 4);
    oy += img.h + gap;
  }
  return out;
}
