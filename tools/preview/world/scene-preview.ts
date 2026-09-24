/**
 * Compose the parallax forest (sky, kit layers, fog, foreground; terrain when available) for a few
 * camera positions of the synthetic preview level and write PNGs.
 * Usage: node tools/preview/world/scene-preview.ts [outDir] [camera names…]
 */
import { readFileSync } from 'node:fs';
import { VIEW_H } from '../../../src/config.ts';
import { visibleLayerRect } from '../../../src/render/util/camera.ts';
import { parseManifest } from '../../../src/assets/manifest.ts';
import { generateKit, kitSeed } from '../../../src/render/gen/kit.ts';
import { buildScene, renderScene, type Camera } from './compose.ts';
import { outDir, save } from './common.ts';
import { previewLevel } from './level.ts';
import { addTerrain } from './terrain-overlay.ts';
import { decorOverlay, particlesOverlay, shaftsOverlay } from './gameplay-overlay.ts';

const dir = outDir();
const only = process.argv.slice(3);
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
scene.overlays.push(decor.back, decor.front, particlesOverlay());
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

const cams: Camera[] = [
  { name: 'glade', cx: 1150, cy: 1860 },
  { name: 'gully', cx: 2750, cy: 1800 },
  { name: 'rootwell', cx: 4300, cy: 1150 },
  { name: 'canopy', cx: 6300, cy: 640 },
  { name: 'shrine', cx: 8850, cy: 1860 },
];
const viewW = VIEW_H * (16 / 9);

// Fill (screens at 1080p, core / band) and draw calls per layer, worst of the preview cameras.
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

for (const cam of cams) {
  if (only.length && !only.includes(cam.name)) continue;
  const f = renderScene(scene, cam, 960, 540, viewW, VIEW_H, 12.5);
  save(dir, `scene-${cam.name}.png`, f.toRgba(), f.w, f.h);
}
