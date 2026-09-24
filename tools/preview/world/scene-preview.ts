/**
 * Compose the forest (sky, kit layers, shafts, terrain, decor, particles, fog, foreground) for the
 * five area cameras of the synthetic preview level, then bloom the glow twins and apply the area's
 * composite grade (the CPU reference of the post chain), and write PNGs.
 * Usage: node tools/preview/world/scene-preview.ts [outDir] [--w 1280] [--time 12.5] [--raw] [camera names…]
 */
import { readFileSync } from 'node:fs';
import { PALETTE, VIEW_H } from '../../../src/config.ts';
import { AREA_GRADE_TABLE } from '../../../src/content/grades.ts';
import type { AreaGradeId } from '../../../src/contracts/level.ts';
import { hexToRgb, type RGB } from '../../../src/core/color.ts';
import { parseManifest } from '../../../src/assets/manifest.ts';
import { generateKit, kitSeed } from '../../../src/render/gen/kit.ts';
import { gradePixel } from '../../../src/render/post/gradeMath.ts';
import { visibleLayerRect } from '../../../src/render/util/camera.ts';
import { buildScene, renderScene, type Camera, type Frame } from './compose.ts';
import { outDir, save } from './common.ts';
import { decorOverlay, particlesOverlay, shaftsOverlay } from './gameplay-overlay.ts';
import { previewLevel } from './level.ts';
import { addTerrain } from './terrain-overlay.ts';

const dir = outDir();
const args = process.argv.slice(3);
const opt = (name: string, def: number): number => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = Number(args[i + 1]);
  args.splice(i, 2);
  return v;
};
const W = opt('w', 1280);
const ci = args.indexOf('--crop');
const crop = ci >= 0 ? (args[ci + 1] as string).split(',').map(Number) : null;
if (ci >= 0) args.splice(ci, 2);
const TIME = opt('time', 12.5);
const raw = args.includes('--raw');
const only = args.filter((a) => !a.startsWith('--'));

const manifestPath = new URL('../../../public/layers/forest.manifest.json', import.meta.url);
const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
const level = previewLevel();
const t0 = performance.now();
const kit = generateKit(kitSeed('forest-kit'));
const t1 = performance.now();
const scene = buildScene(level, manifest, kit);
const t2 = performance.now();
scene.overlays.push(shaftsOverlay(scene));
addTerrain(scene);
const t3 = performance.now();
const decor = decorOverlay(scene);
scene.overlays.push(decor.back, decor.front, particlesOverlay(scene));
console.log(`kit ${(t1 - t0).toFixed(0)} ms, layers ${(t2 - t1).toFixed(0)} ms, terrain ${(t3 - t2).toFixed(0)} ms, decor ${decor.count}`);
for (const [id, L] of scene.layers) {
  let verts = 0;
  let maxMesh = 0;
  for (const c of L.chunks) {
    for (const m of [...c.core, ...c.band]) {
      verts += m.vertexCount;
      maxMesh = Math.max(maxMesh, m.vertexCount);
    }
  }
  console.log(`${id}: ${L.placement.instances.length} instances, ${L.chunks.length} chunks, ${verts} verts (max mesh ${maxMesh})`);
}

/** The main session's GPU screenshot cameras (centre x, y) and the grade of each area. */
const cams: (Camera & { grade: AreaGradeId })[] = [
  { name: 'glade', cx: 1100, cy: 1700, grade: 'glade' },
  { name: 'gully', cx: 2700, cy: 1750, grade: 'gully' },
  { name: 'rootwell', cx: 4300, cy: 1100, grade: 'rootwell' },
  { name: 'canopy', cx: 6000, cy: 800, grade: 'canopy' },
  { name: 'shrine', cx: 8800, cy: 1750, grade: 'shrine' },
];
const viewW = VIEW_H * (16 / 9);

// Fill (screens, core / band) and draw calls per kit layer, worst of the preview cameras.
// Uniform density is assumed inside each chunk mesh, as in ParallaxStackView's estimate.
const vis = { x0: 0, y0: 0, x1: 0, y1: 0 };
const perCam = cams.map(() => ({ core: 0, band: 0, draws: 0 }));
for (const [id, L] of scene.layers) {
  const [fx, fy] = L.def.parallax;
  let worst = { core: 0, band: 0, draws: 0 };
  for (let ci = 0; ci < cams.length; ci++) {
    const cam = cams[ci] as Camera;
    const frame = { cx: cam.cx, cy: cam.cy, zoom: 1, viewW, viewH: VIEW_H, left: cam.cx - viewW / 2, top: cam.cy - VIEW_H / 2, width: viewW, height: VIEW_H, shakeX: 0, shakeY: 0 };
    visibleLayerRect(frame, fx, fy, vis);
    const visArea = (vis.x1 - vis.x0) * (vis.y1 - vis.y0);
    const acc = { core: 0, band: 0, draws: 0 };
    for (const c of L.chunks) {
      const on = Math.min(c.bounds.x1, vis.x1) > Math.max(c.bounds.x0, vis.x0) && Math.min(c.bounds.y1, vis.y1) > Math.max(c.bounds.y0, vis.y0);
      if (!on) continue;
      acc.draws += c.core.length + c.band.length;
      for (const [list, key] of [[c.core, 'core'], [c.band, 'band']] as const) {
        for (const m of list) {
          const b = m.bounds;
          const w = Math.min(b.x1, vis.x1) - Math.max(b.x0, vis.x0);
          const h = Math.min(b.y1, vis.y1) - Math.max(b.y0, vis.y0);
          if (w > 0 && h > 0) acc[key] += (m.area * w * h) / Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0)) / visArea;
        }
      }
    }
    const tot = perCam[ci] as typeof acc;
    tot.core += acc.core;
    tot.band += acc.band;
    tot.draws += acc.draws;
    if (acc.core + acc.band > worst.core + worst.band) worst = acc;
  }
  console.log(`${id}: fill core ${worst.core.toFixed(2)} + band ${worst.band.toFixed(2)} screens, ${worst.draws} draws`);
}
cams.forEach((cam, i) => {
  const t = perCam[i] as { core: number; band: number; draws: number };
  console.log(`camera ${cam.name}: kit layers core ${t.core.toFixed(2)} + band ${t.band.toFixed(2)} screens, ${t.draws} draws`);
});

/** Box blur of an RGB float image (separable, `passes` times). */
function blur(src: Float32Array, w: number, h: number, radius: number, passes = 2): Float32Array {
  let a = src.slice();
  const b = new Float32Array(src.length);
  const norm = 1 / (2 * radius + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += a[(y * w + Math.min(w - 1, Math.max(0, k))) * 3 + c] as number;
        for (let x = 0; x < w; x++) {
          b[(y * w + x) * 3 + c] = s * norm;
          s += (a[(y * w + Math.min(w - 1, x + radius + 1)) * 3 + c] as number) - (a[(y * w + Math.max(0, x - radius)) * 3 + c] as number);
        }
      }
    }
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += b[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c] as number;
        for (let y = 0; y < h; y++) {
          a[(y * w + x) * 3 + c] = s * norm;
          s += (b[(Math.min(h - 1, y + radius + 1) * w + x) * 3 + c] as number) - (b[(Math.max(0, y - radius) * w + x) * 3 + c] as number);
        }
      }
    }
  }
  return a;
}

/** Bloom (half-res glow twins, 4 blur levels averaged as the dual-filter chain does) + the area grade. */
function post(img: Frame, gradeId: AreaGradeId): Uint8Array {
  const hw = Math.floor(img.w / 2);
  const hh = Math.floor(img.h / 2);
  const half = new Float32Array(hw * hh * 3);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) s += img.glow[((y * 2 + j) * img.w + x * 2 + i) * 3 + c] as number;
        half[(y * hw + x) * 3 + c] = s / 4;
      }
    }
  }
  const scale = hw / 640;
  const levels = [half, ...[2, 4, 9, 18].map((r) => blur(half, hw, hh, Math.max(1, Math.round(r * scale))))];
  const grade = AREA_GRADE_TABLE[gradeId];
  const fog = hexToRgb(PALETTE.fogDeep);
  const out = new Uint8Array(img.w * img.h * 4);
  const px: RGB = [0, 0, 0];
  const s: RGB = [0, 0, 0];
  const bl: RGB = [0, 0, 0];
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      const i = y * img.w + x;
      const hi = (Math.min(hh - 1, y >> 1) * hw + Math.min(hw - 1, x >> 1)) * 3;
      for (let c = 0; c < 3; c++) {
        s[c] = img.rgb[i * 3 + c] as number;
        let b = 0;
        for (const l of levels) b += l[hi + c] as number;
        bl[c] = b / levels.length;
      }
      const r = Math.hypot((x / img.w - 0.5) * (img.w / img.h), y / img.h - 0.5) / Math.hypot(0.5 * (img.w / img.h), 0.5);
      if (raw) {
        px[0] = s[0] + bl[0];
        px[1] = s[1] + bl[1];
        px[2] = s[2] + bl[2];
      } else {
        gradePixel(px, s, bl, grade, 0, fog, r);
      }
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round((px[c] as number) * 255)));
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

for (const cam of cams) {
  if (only.length && !only.includes(cam.name)) continue;
  const f = renderScene(scene, cam, W, Math.round((W * 9) / 16), viewW, VIEW_H, TIME);
  const img = post(f, cam.grade);
  if (crop) {
    const [cx, cy, cw, chh] = crop as [number, number, number, number];
    const out = new Uint8Array(cw * chh * 4);
    for (let y = 0; y < chh; y++) out.set(img.subarray(((cy + y) * f.w + cx) * 4, ((cy + y) * f.w + cx + cw) * 4), y * cw * 4);
    save(dir, `crop-${cam.name}.png`, out, cw, chh);
  } else {
    save(dir, `scene-${cam.name}.png`, img, f.w, f.h);
  }
}
