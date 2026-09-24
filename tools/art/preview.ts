/**
 * Painted plates in context, without a browser: the CPU scene preview of tools/preview/world/ (sky, kit
 * layers, terrain, decor, shafts, particles, fog) with the art/plates/ layers spliced in, then the bloom
 * and the blended area grade (the CPU reference of the post chain).
 *
 *   node tools/art/preview.ts <outDir> [area] [--baked webp|png|ktx2] [--aspect 16:9|4:3|21:9] [--w 1280]
 *                              [--at name=x,y …] [--without] [--upto <layer id prefix>] [cameras…]
 *
 * Default: the sources in art/plates/ drawn straight from their PNGs (what `npm run art` would bake);
 * `--baked` decodes the committed chunk files instead (KTX2 is transcoded like the GPU path, so ETC1S
 * artefacts show). Cameras: <area>-left / -ref / -right (the camera sweep and the template reference),
 * or `--at name=x,y` with the hero's feet at world (x, y). `--without` renders the same cameras without
 * plates, for before/after comparisons.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_ASPECT, MIN_ASPECT, PALETTE, VIEW_H } from '../../src/config.ts';
import { AREA_GRADE_TABLE, DEFAULT_GRADE } from '../../src/content/grades.ts';
import { parseManifest } from '../../src/assets/manifest.ts';
import { PLATE_BORDER, PLATE_CONTENT, PLATE_TEXTURE } from '../../src/assets/plateLayout.ts';
import { spliceManifest } from '../../src/assets/splice.ts';
import type { LayerManifest, PlateLayerDef } from '../../src/contracts/assets.ts';
import type { LevelData } from '../../src/contracts/level.ts';
import { hexToRgb, type RGB } from '../../src/core/color.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { generateKit, kitSeed } from '../../src/render/gen/kit.ts';
import { blendGrades, createGradeParams } from '../../src/render/post/grade.ts';
import { gradePixel } from '../../src/render/post/gradeMath.ts';
import { DEFAULT_CAMERA_TUNING } from '../../src/sim/tuning.ts';
import { outDir, save } from '../preview/world/common.ts';
import { buildScene, preparePlate, renderScene, type Camera, type Frame, type PlateChunkImage, type PreparedPlate } from '../preview/world/compose.ts';
import { decorOverlay, particlesOverlay, shaftsOverlay } from '../preview/world/gameplay-overlay.ts';
import { decodeKtx2 } from '../preview/world/plates.ts';
import { addTerrain } from '../preview/world/terrain-overlay.ts';
import { scanPlates } from './bake.ts';
import { artPaths } from './paths.ts';
import { plateLayerDef } from './sidecar.ts';
import sharp from 'sharp';
import { referenceCamera, resolveArea } from './templates.ts';

type Format = 'webp' | 'png' | 'ktx2';

/** A plate drawn from its whole source image (one "chunk" the size of the image). */
async function sourcePlate(id: string, png: string, def: PlateLayerDef): Promise<PreparedPlate> {
  const { data, info } = await sharp(png, { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const whole: PlateLayerDef = { ...def, id, chunkSize: [info.width, info.height], chunks: [{ col: 0, row: 0, source: { png: 'memory.png' } }] };
  return preparePlate(whole, [{ col: 0, row: 0, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), straight: false }]);
}

/** A baked plate from its chunk files, border cropped (compose.ts samples content-sized chunks). */
async function bakedPlate(def: PlateLayerDef, layersDir: string, format: Format): Promise<PreparedPlate> {
  const chunks: PlateChunkImage[] = [];
  for (const c of def.chunks) {
    const f: Format = c.source[format] ? format : c.source.webp ? 'webp' : 'png';
    const rel = (c.source[f] as string).split('?')[0] as string;
    const bytes = new Uint8Array(readFileSync(join(layersDir, rel)));
    let rgba: Uint8Array;
    if (f === 'ktx2') rgba = (await decodeKtx2(bytes)).rgba;
    else {
      const { data } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      rgba = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    const content = new Uint8Array(PLATE_CONTENT * PLATE_CONTENT * 4);
    for (let y = 0; y < PLATE_CONTENT; y++) {
      const from = ((y + PLATE_BORDER) * PLATE_TEXTURE + PLATE_BORDER) * 4;
      content.set(rgba.subarray(from, from + PLATE_CONTENT * 4), y * PLATE_CONTENT * 4);
    }
    chunks.push({ col: c.col, row: c.row, rgba: content, straight: f === 'ktx2' });
  }
  return preparePlate(def, chunks);
}

/** Box blur of an RGB float image (separable, `passes` times). */
function blur(src: Float32Array, w: number, h: number, radius: number, passes = 2): Float32Array {
  const a = src.slice();
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

/** Half-res glow twins blurred at 4 radii (the dual-filter chain), then the blended area grade. */
function post(img: Frame, level: LevelData, cam: Camera): Uint8Array {
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
  const k = hw / 640;
  const levels = [half, ...[2, 4, 9, 18].map((r) => blur(half, hw, hh, Math.max(1, Math.round(r * k))))];
  const grade = blendGrades(createGradeParams(), level.gradeZones, cam.cx, cam.cy, AREA_GRADE_TABLE, DEFAULT_GRADE);
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
      gradePixel(px, s, bl, grade, 0, fog, r);
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round((px[c] as number) * 255)));
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const dir = outDir();
  const args = process.argv.slice(3);
  const take = (flag: string): string | null => {
    const i = args.indexOf(flag);
    if (i < 0) return null;
    const v = args[i + 1] ?? null;
    args.splice(i, 2);
    return v;
  };
  const baked = take('--baked') as Format | null;
  const aspectArg = take('--aspect') ?? '16:9';
  const W = Number(take('--w') ?? 1280);
  const upto = take('--upto');
  const without = args.includes('--without');
  const at: [string, number, number][] = [];
  for (let v = take('--at'); v !== null; v = take('--at')) {
    const [name, pos] = v.split('=');
    const [x, y] = (pos ?? '').split(',').map(Number);
    if (!name || !Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`bad --at ${v}`);
    at.push([name, x as number, y as number]);
  }
  const rest = args.filter((a) => !a.startsWith('--'));
  const areaArg = rest[0] && !rest[0].includes('-') ? rest.shift() as string : 'glade';
  const aspect = aspectArg === '21:9' ? MAX_ASPECT : aspectArg === '4:3' ? MIN_ASPECT : 16 / 9;
  const viewW = VIEW_H * aspect;

  const paths = artPaths();
  const level = parseLdtk(JSON.parse(readFileSync(paths.ldtk, 'utf8')));
  const base = parseManifest(JSON.parse(readFileSync(paths.base, 'utf8')));
  let manifest: LayerManifest = base;
  const plates = new Map<string, PreparedPlate>();
  if (!without) {
    if (baked) {
      manifest = parseManifest(JSON.parse(readFileSync(paths.generated, 'utf8')));
      for (const l of manifest.layers) if (l.kind === 'plate') plates.set(l.id, await bakedPlate(l, paths.layers, baked));
    } else {
      const { plates: sources, errors } = await scanPlates(paths);
      if (errors.length) throw new Error(errors.join('\n'));
      manifest = spliceManifest(base, sources.map((s) => ({ layer: plateLayerDef(s.id, s.sidecar), replaces: s.sidecar.replaces })));
      for (const s of sources) plates.set(s.id, await sourcePlate(s.id, s.png, plateLayerDef(s.id, s.sidecar)));
    }
  }
  if (upto) {
    const end = manifest.layers.findIndex((l) => l.id.startsWith(upto));
    if (end < 0) throw new Error(`--upto ${upto}: no such layer`);
    manifest = { ...manifest, layers: manifest.layers.slice(0, end + 1) };
  }
  const kit = generateKit(kitSeed('forest-kit'));
  const scene = buildScene(level, manifest, kit);
  scene.plates = plates;
  if (!upto) {
    scene.overlays.push(shaftsOverlay(scene));
    addTerrain(scene);
    const decor = decorOverlay(scene);
    scene.overlays.push(decor.back, decor.front, particlesOverlay(scene));
  }
  const area = resolveArea(level, areaArg);
  const ref = referenceCamera(level, area);
  const clamp = (v: number, half: number, size: number): number => (size <= 2 * half ? size / 2 : Math.min(size - half, Math.max(half, v)));
  const feetCam = (name: string, x: number, y: number): Camera => ({
    name, cx: clamp(x, viewW / 2, level.pxWidth), cy: clamp(y + DEFAULT_CAMERA_TUNING.targetOffsetY, VIEW_H / 2, level.pxHeight),
  });
  const cams: Camera[] = [
    { name: `${area.id}-left`, cx: clamp(area.x0, viewW / 2, level.pxWidth), cy: ref.cy },
    { name: `${area.id}-ref`, cx: clamp(ref.cx, viewW / 2, level.pxWidth), cy: ref.cy },
    { name: `${area.id}-right`, cx: clamp(area.x1, viewW / 2, level.pxWidth), cy: ref.cy },
    ...at.map(([n, x, y]) => feetCam(n, x, y)),
  ];
  const only = rest;
  const suffix = `${without ? '-without' : baked ? `-${baked}` : ''}${aspectArg === '16:9' ? '' : `-${aspectArg.replace(':', 'x')}`}`;
  for (const cam of cams) {
    if (only.length && !only.includes(cam.name)) continue;
    const t0 = performance.now();
    const f = renderScene(scene, cam, W, Math.round(W / aspect), viewW, VIEW_H, 12.5);
    save(dir, `art-${cam.name}${suffix}.png`, post(f, level, cam), f.w, f.h);
    console.log(`  camera (${cam.cx.toFixed(0)}, ${cam.cy.toFixed(0)}) in ${(performance.now() - t0).toFixed(0)} ms`);
  }
}

await main();
