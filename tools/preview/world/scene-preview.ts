/**
 * Compose the forest (sky, kit layers, shafts, terrain, decor, particles, fog, foreground) for a set
 * of cameras, then bloom the glow twins and apply the blended area grade (the CPU reference of the
 * post chain), and write PNGs. Kit layers sample the atlas like the kit shader (trilinear, LOD clamped
 * to KIT_MAX_MIP).
 *
 *   node tools/preview/world/scene-preview.ts [outDir] [--w 1280] [--time 12.5] [--raw] [camera names…]
 *   node tools/preview/world/scene-preview.ts [outDir] --level forest [--ldtk file] [--at name=fx,fy …] [camera names…]
 *   node tools/preview/world/scene-preview.ts [outDir] --shots [camera names…]
 *   … [--plates baked|paint] [--plate-format ktx2|webp|png] [--upto L3] [--before | --before-kit | --before-terrain]
 *   … [--crop x,y,w,h [--zoom 2]]
 *
 * `--shots` frames the main session's GPU screenshot cameras (shots/m2-base/cameras.txt: the real
 * level, teleport, 1.8 s of play) by running the sim the same way, so the PNGs line up with them.
 * `--before` renders the pre-M2 look for comparison: the kit atlas without the painterly strokes and
 * the terrain without its stroke term (`--before-kit` / `--before-terrain`: only one of the two, to
 * measure each part's share). `--crop` cuts a region (at --w) and `--zoom` enlarges it
 * (nearest neighbour).
 *
 * The default is the synthetic preview level and its five area cameras. `--level forest` loads the
 * real public/levels/forest.ldtk and frames gameplay cameras the way the sim camera does (feet in
 * tiles, targetOffsetY, clamped to the level at 16:9), with a hero stand-in at the feet and the orbs;
 * `--ldtk file` reads another LDtk file the same way (e.g. an older revision, to compare), and
 * `--at name=fx,fy` adds a camera with the feet at tile (fx, fy).
 * `--plates baked` renders public/layers/forest.plates.manifest.json (the demo plate replaces L3) from
 * its chunk files in `--plate-format` (default webp; ktx2 is transcoded like the GPU path, so ETC1S
 * artefacts show); `--plates paint` repaints the plate in memory with tools/plates/paint.ts instead.
 * `--upto <id prefix>` keeps the layers up to the first one whose id starts with the prefix and drops
 * the gameplay plane (terrain, decor, shafts, particles), to compare distant planes on their own.
 */
import { readFileSync } from 'node:fs';
import { PALETTE, TILE, VIEW_H } from '../../../src/config.ts';
import { AREA_GRADE_TABLE, DEFAULT_GRADE } from '../../../src/content/grades.ts';
import type { AreaGradeId, LevelData } from '../../../src/contracts/level.ts';
import { hexToRgb, type RGB } from '../../../src/core/color.ts';
import { parseManifest } from '../../../src/assets/manifest.ts';
import { parseLdtk } from '../../../src/level/loader.ts';
import { generateKit, KIT_HEIGHT, KIT_WIDTH, kitSeed } from '../../../src/render/gen/kit.ts';
import { ELEMENT_SPECS } from '../../../src/render/gen/kitElements.ts';
import { createInputFrame } from '../../../src/contracts/input.ts';
import { GameWorld } from '../../../src/sim/world.ts';
import { polygonArea } from '../../../src/render/gen/polygon.ts';
import { blendGrades, createGradeParams } from '../../../src/render/post/grade.ts';
import { gradePixel } from '../../../src/render/post/gradeMath.ts';
import { visibleLayerRect } from '../../../src/render/util/camera.ts';
import { DEFAULT_CAMERA_TUNING } from '../../../src/sim/tuning.ts';
import { LDTK_PATH } from '../../level/build-level.ts';
import { buildScene, renderScene, type Camera, type Frame } from './compose.ts';
import { outDir, save } from './common.ts';
import { loadBakedPlates, paintedPlates, type PlateFormat } from './plates.ts';
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
const cropZoom = opt('zoom', 1);
const ci = args.indexOf('--crop');
const crop = ci >= 0 ? (args[ci + 1] as string).split(',').map(Number) : null;
if (ci >= 0) args.splice(ci, 2);
const TIME = opt('time', 12.5);
const raw = args.includes('--raw');
const shots = args.includes('--shots');
const before = args.includes('--before');
const beforeKit = before || args.includes('--before-kit');
const beforeTerrain = before || args.includes('--before-terrain');
const li = args.indexOf('--level');
const forestArg = shots || (li >= 0 && args[li + 1] === 'forest');
if (li >= 0) args.splice(li, 2);
const ldi = args.indexOf('--ldtk');
const ldtkPath = ldi >= 0 ? (args[ldi + 1] as string) : LDTK_PATH;
if (ldi >= 0) args.splice(ldi, 2);
/** A real LDtk level (the shipped forest, or `--ldtk file`), rather than the synthetic preview level. */
const realLevel = forestArg || ldi >= 0;
/** Extra cameras: `--at name=fx,fy` (feet at tile fx, fy of the real level). */
const extraAt: [string, number, number][] = [];
for (let i = args.indexOf('--at'); i >= 0; i = args.indexOf('--at')) {
  const [name, pos] = (args[i + 1] ?? '').split('=');
  const [fx, fy] = (pos ?? '').split(',').map(Number);
  if (!name || !Number.isFinite(fx) || !Number.isFinite(fy)) throw new Error(`bad --at ${args[i + 1]}`);
  extraAt.push([name, fx as number, fy as number]);
  args.splice(i, 2);
}
const str = (name: string): string | null => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return null;
  const v = args[i + 1] as string;
  args.splice(i, 2);
  return v;
};
const platesArg = str('plates');
if (platesArg !== null && platesArg !== 'baked' && platesArg !== 'paint') throw new Error(`bad --plates ${platesArg}`);
const plateFormat = (str('plate-format') ?? 'webp') as PlateFormat;
const upto = str('upto');
const only = args.filter((a) => !a.startsWith('--'));

const layersUrl = new URL('../../../public/layers/', import.meta.url);
const baseManifest = parseManifest(JSON.parse(readFileSync(new URL('forest.manifest.json', layersUrl), 'utf8')));
const painted = platesArg === 'paint' ? paintedPlates(baseManifest) : null;
if (painted) console.log(`plate painted in ${painted.ms.toFixed(0)} ms`);
let manifest = painted
  ? painted.manifest
  : platesArg === 'baked' ? parseManifest(JSON.parse(readFileSync(new URL('forest.plates.manifest.json', layersUrl), 'utf8'))) : baseManifest;
if (upto) {
  const end = manifest.layers.findIndex((l) => l.id.startsWith(upto));
  if (end < 0) throw new Error(`--upto ${upto}: no such layer`);
  manifest = { ...manifest, layers: manifest.layers.slice(0, end + 1) };
}
const level: LevelData = realLevel ? parseLdtk(JSON.parse(readFileSync(ldtkPath, 'utf8'))) : previewLevel();
const t0 = performance.now();
// `--before`: the same elements without the painterly pass (byte-identical to the M1 atlas).
const kit = generateKit(
  kitSeed('forest-kit'), KIT_WIDTH, KIT_HEIGHT,
  beforeKit ? ELEMENT_SPECS.map((sp) => ({ ...sp, finalize: { ...sp.finalize, strokes: null } })) : ELEMENT_SPECS,
);
const t1 = performance.now();
const scene = buildScene(level, manifest, kit);
// The plain atlas stores its detail undivided: its layers shade at stroke gain 1 (the pre-M2 look).
if (beforeKit) for (const L of scene.layers.values()) L.params.strokeGain = 1;
if (painted) scene.plates = painted.plates;
else if (platesArg === 'baked') scene.plates = await loadBakedPlates(manifest, plateFormat);
const t2 = performance.now();
if (!upto) {
  scene.overlays.push(shaftsOverlay(scene));
  addTerrain(scene, { strokes: !beforeTerrain });
}
const t3 = performance.now();
if (!upto) {
  const decor = decorOverlay(scene);
  scene.overlays.push(decor.back);
  if (realLevel) scene.overlays.push(entitiesOverlay(level));
  scene.overlays.push(decor.front, particlesOverlay(scene));
  console.log(`decor ${decor.count}`);
}
console.log(`kit ${(t1 - t0).toFixed(0)} ms, layers ${(t2 - t1).toFixed(0)} ms, terrain ${(t3 - t2).toFixed(0)} ms`);
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

const viewW = VIEW_H * (16 / 9);

/** Gameplay cameras on the real level: the player's feet (tiles), framed like the settled sim camera. */
const FOREST_FEET: readonly [string, number, number][] = [
  ['start', 4.5, 43], ['cp1', 83.5, 40], ['rootwell-mid', 91, 28], ['cp2', 96.5, 12], ['canopy-gap', 118, 12],
  ['cp3', 145.5, 14], ['moonwell-top', 170, 17], ['moonwell-ledge', 178, 22], ['moonwell-mid', 186, 29],
  ['moonwell-low', 186, 36], ['goal', 194.5, 44],
];

function feetCamera(name: string, fx: number, fy: number): Camera & { feet: [number, number] } {
  const x = fx * TILE;
  const y = fy * TILE;
  const clamp = (v: number, half: number, size: number): number => (size <= 2 * half ? size / 2 : Math.min(size - half, Math.max(half, v)));
  return {
    name, cx: clamp(x, viewW / 2, level.pxWidth), cy: clamp(y + DEFAULT_CAMERA_TUNING.targetOffsetY, VIEW_H / 2, level.pxHeight), feet: [x, y],
  };
}

/**
 * The main session's GPU screenshot cameras (shots/m2-base/cameras.txt): teleport the player, play
 * 108 ticks (1.8 s) with neutral input, and read the settled camera, as the shots were taken.
 */
const SHOT_TELEPORTS: readonly [string, (lv: LevelData) => [number, number]][] = [
  ['03-glade-checkpoint', (lv) => checkpointFeet(lv, 0)],
  ['04-thorn-gully', () => [2976, 1920]],
  ['05-rootwell', () => [4392, 1440]],
  ['06-rootwell-summit', (lv) => checkpointFeet(lv, 2)],
  ['07-canopy-walk', () => [5088, 576]],
  ['08-canopy-checkpoint', (lv) => checkpointFeet(lv, 3)],
  ['09-moonwell-ledge', () => [8736, 1056]],
  ['10-moonwell-descent', () => [8736, 1632]],
  ['11-moonwell-shrine', (lv) => (lv.goal ? [lv.goal.x - 200, lv.goal.y + lv.goal.h] : [0, 0])],
];

function checkpointFeet(lv: LevelData, i: number): [number, number] {
  const c = lv.checkpoints[i];
  return c ? [c.x + c.w / 2, c.y + c.h] : [0, 0];
}

function shotCameras(): PreviewCamera[] {
  const input = createInputFrame();
  return SHOT_TELEPORTS.map(([name, at]) => {
    const world = new GameWorld(level);
    const [x, y] = at(level);
    world.teleport(x, y);
    for (let i = 0; i < 108; i++) world.step(input);
    return { name, cx: world.camera.x, cy: world.camera.y, feet: [world.player.x, world.player.y] as [number, number] };
  });
}

type PreviewCamera = Camera & { feet?: [number, number]; grade?: AreaGradeId };
const cams: PreviewCamera[] = shots
  ? shotCameras()
  : realLevel
  ? [...FOREST_FEET, ...extraAt].map(([n, fx, fy]) => feetCamera(n, fx, fy))
  : [
    { name: 'glade', cx: 1100, cy: 1700, grade: 'glade' },
    { name: 'gully', cx: 2700, cy: 1750, grade: 'gully' },
    { name: 'rootwell', cx: 4300, cy: 1100, grade: 'rootwell' },
    { name: 'canopy', cx: 6000, cy: 800, grade: 'canopy' },
    { name: 'shrine', cx: 8800, cy: 1750, grade: 'shrine' },
  ];

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
// Plate layers: opaque hull (core) and hull minus core (band) per chunk, uniform density inside each chunk.
for (const [id, P] of scene.plates) {
  const { def } = P;
  const [fx, fy] = def.parallax;
  const [cw, ch] = def.chunkSize;
  const ts = def.texelScale;
  let worst = { core: 0, band: 0, draws: 0 };
  for (let ci = 0; ci < cams.length; ci++) {
    const cam = cams[ci] as Camera;
    const frame = { cx: cam.cx, cy: cam.cy, zoom: 1, viewW, viewH: VIEW_H, left: cam.cx - viewW / 2, top: cam.cy - VIEW_H / 2, width: viewW, height: VIEW_H, shakeX: 0, shakeY: 0 };
    visibleLayerRect(frame, fx, fy, vis);
    const visArea = (vis.x1 - vis.x0) * (vis.y1 - vis.y0);
    const acc = { core: 0, band: 0, draws: 0 };
    for (const c of def.chunks) {
      const x0 = def.origin[0] + c.col * cw * ts;
      const y0 = def.origin[1] + c.row * ch * ts;
      const w = Math.min(x0 + cw * ts, vis.x1) - Math.max(x0, vis.x0);
      const h = Math.min(y0 + ch * ts, vis.y1) - Math.max(y0, vis.y0);
      if (w <= 0 || h <= 0) continue;
      // Visible fraction of the chunk (layer units² per texel² cancel out) over the visible area.
      const k = (w * h) / (cw * ch) / visArea;
      // The band mesh spans the whole hull, but over the core its fragments fail the depth test.
      const core = c.opaqueHull ? Math.abs(polygonArea(c.opaqueHull)) : 0;
      acc.core += core * k;
      acc.band += (Math.abs(polygonArea(c.hull ?? [0, 0, cw, 0, cw, ch, 0, ch])) - core) * k;
      acc.draws += c.opaqueHull ? 2 : 1;
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
  console.log(`camera ${cam.name}: kit/plate layers core ${t.core.toFixed(2)} + band ${t.band.toFixed(2)} screens, ${t.draws} draws`);
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

/** Stand-ins for the hero (a glowing spirit capsule at the feet) and the orbs, so framing and scale read. */
function entitiesOverlay(lv: LevelData): (img: Frame) => void {
  const spirit = hexToRgb(PALETTE.spiritGlow);
  const warm = hexToRgb(PALETTE.warmAccent);
  const blob = (img: Frame, x: number, y: number, rx: number, ry: number, rgb: RGB, a: number, glowR: number, glow: number): void => {
    const [cx, cy] = img.toPx(x, y);
    const R = Math.max(rx, ry, glowR) / img.scale + 2;
    for (let py = Math.max(0, Math.floor(cy - R)); py < Math.min(img.h, Math.ceil(cy + R)); py++) {
      for (let px = Math.max(0, Math.floor(cx - R)); px < Math.min(img.w, Math.ceil(cx + R)); px++) {
        const dx = (px + 0.5 - cx) * img.scale;
        const dy = (py + 0.5 - cy) * img.scale;
        const e = Math.hypot(dx / rx, dy / ry);
        const i = py * img.w + px;
        const k = Math.min(1, Math.max(0, (1 - e) * 4)) * a;
        if (k > 0) img.blend(i, rgb[0] * k, rgb[1] * k, rgb[2] * k, k);
        const g = Math.max(0, 1 - Math.hypot(dx, dy) / glowR);
        if (g > 0) img.addGlow(i, rgb[0] * g * g * glow, rgb[1] * g * g * glow, rgb[2] * g * g * glow);
      }
    }
  };
  return (img) => {
    for (const o of lv.orbs) blob(img, o.x, o.y, 9, 9, warm, 1, 34, 0.9);
    const feet = (img.cam as Camera & { feet?: [number, number] }).feet;
    if (feet) {
      blob(img, feet[0], feet[1] - 29, 14, 29, spirit, 0.95, 70, 0.8);
      blob(img, feet[0], feet[1] - 50, 11, 11, spirit, 1, 40, 0.6);
    }
  };
}

/** Bloom (half-res glow twins, 4 blur levels averaged as the dual-filter chain does) + the blended area grade. */
function post(img: Frame, cam: PreviewCamera): Uint8Array {
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
  const grade = cam.grade
    ? AREA_GRADE_TABLE[cam.grade]
    : blendGrades(createGradeParams(), level.gradeZones, cam.cx, cam.cy, AREA_GRADE_TABLE, DEFAULT_GRADE);
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

const suffix = before ? '-before' : beforeKit ? '-before-kit' : beforeTerrain ? '-before-terrain' : '';
for (const cam of cams) {
  if (only.length && !only.includes(cam.name)) continue;
  const f = renderScene(scene, cam, W, Math.round((W * 9) / 16), viewW, VIEW_H, TIME);
  const img = post(f, cam);
  if (crop) {
    const [cx, cy, cw, chh] = crop as [number, number, number, number];
    const z = Math.max(1, Math.round(cropZoom));
    const out = new Uint8Array(cw * z * chh * z * 4);
    for (let y = 0; y < chh * z; y++) {
      for (let x = 0; x < cw * z; x++) {
        const src = ((cy + Math.floor(y / z)) * f.w + cx + Math.floor(x / z)) * 4;
        out.set(img.subarray(src, src + 4), (y * cw * z + x) * 4);
      }
    }
    save(dir, `crop-${cam.name}${suffix}.png`, out, cw * z, chh * z);
  } else {
    save(dir, `scene-${cam.name}${suffix}.png`, img, f.w, f.h);
  }
}
