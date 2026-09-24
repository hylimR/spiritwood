import type { FogLayerDef, LayerManifest, SkyLayerDef } from '../../../src/contracts/assets.ts';
import type { LevelData } from '../../../src/contracts/level.ts';
import type { RGB } from '../../../src/core/color.ts';
import type { KitAtlasData } from '../../../src/render/gen/kit.ts';
import { NoiseTable } from '../../../src/render/gen/noiseTable.ts';
import { fogBandParams, shadeFog } from '../../../src/render/layers/fogShading.ts';
import { KIT_STRIDE_FLOATS, type ChunkMeshes, type MeshData } from '../../../src/render/layers/kitMesh.ts';
import { KIT_MODE, shadeKit, type KitMode, type KitShadeParams } from '../../../src/render/layers/kitShading.ts';
import { clearingHints, prepareKitLayer, type PreparedKitLayer } from '../../../src/render/layers/layerModel.ts';
import { shadeSky, skyHorizonY, skyParams } from '../../../src/render/layers/skyShading.ts';
import { vnoise } from './glslNoise.ts';

/**
 * A CPU compositor for browser-free previews: rasterises the real chunk meshes (positions, UVs,
 * per-instance depth order) with the TS reference shading of the sky, kit layers and fog bands.
 * Premultiplied RGB accumulation plus an additive glow buffer (the glow twins that feed bloom).
 */
export interface Camera {
  name: string;
  cx: number;
  cy: number;
}

export interface Scene {
  level: LevelData;
  manifest: LayerManifest;
  kit: KitAtlasData;
  layers: Map<string, PreparedKitLayer>;
  noise: NoiseTable;
  /** Extra passes drawn after the depth-tested kit layers (shafts, terrain, decor, particles…). */
  overlays: ((img: Frame) => void)[];
  /** Passes drawn after the fog bands and before the foreground layers. */
  lateOverlays: ((img: Frame) => void)[];
}

export class Frame {
  readonly w: number;
  readonly h: number;
  /** View units per pixel. */
  readonly scale: number;
  readonly viewW: number;
  readonly viewH: number;
  readonly cam: Camera;
  readonly time: number;
  readonly rgb: Float32Array;
  /** Additive glow twins (full resolution; the post step downsamples it). */
  readonly glow: Float32Array;

  constructor(w: number, h: number, viewW: number, viewH: number, cam: Camera, time: number) {
    this.w = w;
    this.h = h;
    this.viewW = viewW;
    this.viewH = viewH;
    this.scale = viewH / h;
    this.cam = cam;
    this.time = time;
    this.rgb = new Float32Array(w * h * 3);
    this.glow = new Float32Array(w * h * 3);
  }

  /** Premultiplied "over". */
  blend(i: number, r: number, g: number, b: number, a: number): void {
    const o = i * 3;
    this.rgb[o] = r + (this.rgb[o] as number) * (1 - a);
    this.rgb[o + 1] = g + (this.rgb[o + 1] as number) * (1 - a);
    this.rgb[o + 2] = b + (this.rgb[o + 2] as number) * (1 - a);
  }

  add(i: number, r: number, g: number, b: number): void {
    const o = i * 3;
    this.rgb[o] = (this.rgb[o] as number) + r;
    this.rgb[o + 1] = (this.rgb[o + 1] as number) + g;
    this.rgb[o + 2] = (this.rgb[o + 2] as number) + b;
  }

  addGlow(i: number, r: number, g: number, b: number): void {
    const o = i * 3;
    this.glow[o] = (this.glow[o] as number) + r;
    this.glow[o + 1] = (this.glow[o + 1] as number) + g;
    this.glow[o + 2] = (this.glow[o + 2] as number) + b;
  }

  /** World (gameplay plane) → pixel. */
  toPx(x: number, y: number): [number, number] {
    return [(x - this.cam.cx + this.viewW / 2) / this.scale, (y - this.cam.cy + this.viewH / 2) / this.scale];
  }

  /** Pixel centre → world. */
  worldX(px: number): number {
    return (px + 0.5) * this.scale + this.cam.cx - this.viewW / 2;
  }

  worldY(py: number): number {
    return (py + 0.5) * this.scale + this.cam.cy - this.viewH / 2;
  }
}

export function buildScene(level: LevelData, manifest: LayerManifest, kit: KitAtlasData): Scene {
  const layers = new Map<string, PreparedKitLayer>();
  for (const def of manifest.layers) {
    if (def.kind === 'kit') layers.set(def.id, prepareKitLayer(def, kit, level.pxWidth, level.pxHeight, clearingHints(level)));
  }
  return { level, manifest, kit, layers, noise: new NoiseTable(77), overlays: [], lateOverlays: [] };
}

/** Bilinear straight-alpha atlas sample, weighted like a premultiplied GPU fetch. */
function sampleAtlas(kit: KitAtlasData, u: number, v: number, out: Float32Array): void {
  const x = u * kit.width - 0.5;
  const y = v * kit.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  const p = kit.pixels;
  for (let j = 0; j < 2; j++) {
    const yy = Math.min(kit.height - 1, Math.max(0, y0 + j));
    for (let i = 0; i < 2; i++) {
      const xx = Math.min(kit.width - 1, Math.max(0, x0 + i));
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const o = (yy * kit.width + xx) * 4;
      const al = ((p[o + 3] as number) / 255) * w;
      r += (p[o] as number) * al;
      g += (p[o + 1] as number) * al;
      b += (p[o + 2] as number) * al;
      a += al;
    }
  }
  const ia = a > 1e-6 ? 1 / (a * 255) : 0;
  out[0] = r * ia;
  out[1] = g * ia;
  out[2] = b * ia;
  out[3] = a;
}

interface QuadRef {
  mesh: MeshData;
  q: number;
  depth: number;
  mode: KitMode;
}

export interface DrawKitOptions {
  /** Draw every quad as a glow twin into the glow buffer instead of the scene. */
  glowOnly?: boolean;
}

/** Rasterise kit-format chunk meshes in painter order (depth-sorted for depth-tested layers). */
export function drawKitChunks(
  img: Frame, scene: Scene, chunks: readonly ChunkMeshes[], params: KitShadeParams, fx: number, fy: number, depthSorted: boolean,
  opts: DrawKitOptions = {},
): void {
  const cam = img.cam;
  const quads: QuadRef[] = [];
  const glowOnly = opts.glowOnly === true;
  for (const chunk of chunks) {
    for (const m of chunk.core) {
      for (let q = 0; q < m.vertexCount / 4; q++) {
        quads.push({ mesh: m, q, depth: m.vertices[q * 4 * KIT_STRIDE_FLOATS + 6] as number, mode: glowOnly ? KIT_MODE.Glow : KIT_MODE.Core });
      }
    }
    for (const m of chunk.band) {
      for (let q = 0; q < m.vertexCount / 4; q++) {
        quads.push({ mesh: m, q, depth: m.vertices[q * 4 * KIT_STRIDE_FLOATS + 6] as number, mode: glowOnly ? KIT_MODE.Glow : KIT_MODE.Band });
      }
    }
  }
  // Painter order equivalent to the depth-tested passes: far instances (larger depth) first.
  if (depthSorted) quads.sort((a, b) => b.depth - a.depth);
  const tex = new Float32Array(4);
  const px = new Float32Array(4);
  const glow: RGB = [0, 0, 0];
  for (const { mesh, q, mode } of quads) {
    const v = mesh.vertices;
    const o0 = q * 4 * KIT_STRIDE_FLOATS;
    const o2 = o0 + 2 * KIT_STRIDE_FLOATS;
    const x0 = v[o0] as number;
    const y0 = v[o0 + 1] as number;
    const u0 = v[o0 + 2] as number;
    const t0 = v[o0 + 3] as number;
    const x1 = v[o2] as number;
    const y1 = v[o2 + 1] as number;
    const u1 = v[o2 + 2] as number;
    const t1 = v[o2 + 3] as number;
    const tint = new Uint32Array(v.buffer, v.byteOffset + (o0 + 7) * 4, 1)[0] as number;
    glow[0] = (tint & 255) / 255;
    glow[1] = ((tint >> 8) & 255) / 255;
    glow[2] = ((tint >> 16) & 255) / 255;
    const shade = ((tint >>> 24) & 255) / 255;
    // Layer → view → pixels.
    const vx0 = (x0 - cam.cx * fx) + img.viewW / 2;
    const vx1 = (x1 - cam.cx * fx) + img.viewW / 2;
    const vy0 = (y0 - cam.cy * fy) + img.viewH / 2;
    const vy1 = (y1 - cam.cy * fy) + img.viewH / 2;
    const sxa = Math.min(vx0, vx1) / img.scale;
    const sxb = Math.max(vx0, vx1) / img.scale;
    const sya = Math.min(vy0, vy1) / img.scale;
    const syb = Math.max(vy0, vy1) / img.scale;
    if (sxb < 0 || sya > img.h || sxa > img.w || syb < 0) continue;
    const pxa = Math.max(0, Math.ceil(sxa - 0.5));
    const pxb = Math.min(img.w, Math.ceil(sxb - 0.5));
    const pya = Math.max(0, Math.ceil(sya - 0.5));
    const pyb = Math.min(img.h, Math.ceil(syb - 0.5));
    for (let py = pya; py < pyb; py++) {
      const vy = (py + 0.5) * img.scale;
      const ly = vy - img.viewH / 2 + cam.cy * fy;
      const tv = (ly - y0) / (y1 - y0);
      const vv = t0 + (t1 - t0) * tv;
      for (let pxx = pxa; pxx < pxb; pxx++) {
        const vx = (pxx + 0.5) * img.scale;
        const lx = vx - img.viewW / 2 + cam.cx * fx;
        const tu = (lx - x0) / (x1 - x0);
        sampleAtlas(scene.kit, u0 + (u1 - u0) * tu, vv, tex);
        if ((tex[3] as number) <= 0 && mode !== KIT_MODE.Core) continue;
        shadeKit(px, tex, shade, glow, ly, params, mode);
        const i = py * img.w + pxx;
        if (mode === KIT_MODE.Glow) img.addGlow(i, px[0] as number, px[1] as number, px[2] as number);
        else img.blend(i, px[0] as number, px[1] as number, px[2] as number, px[3] as number);
      }
    }
  }
}

function drawKitLayer(img: Frame, scene: Scene, L: PreparedKitLayer): void {
  drawKitChunks(img, scene, L.chunks, L.params, L.def.parallax[0], L.def.parallax[1], L.depthTested);
}

function drawSky(img: Frame, scene: Scene, def: SkyLayerDef): void {
  const p = skyParams(def);
  const out = new Float32Array(3);
  const horizon = skyHorizonY(img.viewH, img.cam.cy, scene.level.pxHeight);
  for (let py = 0; py < img.h; py++) {
    for (let px = 0; px < img.w; px++) {
      shadeSky(out, (px + 0.5) * img.scale, (py + 0.5) * img.scale, img.viewW, img.viewH, horizon, img.time, p, vnoise);
      const o = (py * img.w + px) * 3;
      img.rgb[o] = out[0] as number;
      img.rgb[o + 1] = out[1] as number;
      img.rgb[o + 2] = out[2] as number;
    }
  }
}

function drawFog(img: Frame, def: FogLayerDef): void {
  const [fx, fy] = def.parallax;
  const p = fogBandParams(def);
  const cam = img.cam;
  const out = new Float32Array(4);
  for (let py = 0; py < img.h; py++) {
    const ly = (py + 0.5) * img.scale - img.viewH / 2 + cam.cy * fy;
    if (Math.abs(ly - def.y) >= def.height) continue;
    for (let px = 0; px < img.w; px++) {
      const lx = (px + 0.5) * img.scale - img.viewW / 2 + cam.cx * fx;
      shadeFog(out, lx, ly, img.time, p, vnoise);
      img.blend(py * img.w + px, out[0] as number, out[1] as number, out[2] as number, out[3] as number);
    }
  }
}

/** Render one camera in slot order: sky, depth-tested layers, overlays, fog, late overlays, foreground. */
export function renderScene(scene: Scene, cam: Camera, w: number, h: number, viewW: number, viewH: number, time = 0): Frame {
  const img = new Frame(w, h, viewW, viewH, cam, time);
  let overlaysDone = false;
  let lateDone = false;
  const overlays = (): void => {
    if (overlaysDone) return;
    for (const o of scene.overlays) o(img);
    overlaysDone = true;
  };
  const late = (): void => {
    if (lateDone) return;
    overlays();
    for (const o of scene.lateOverlays) o(img);
    lateDone = true;
  };
  for (const def of scene.manifest.layers) {
    if (def.kind === 'sky') drawSky(img, scene, def);
    else if (def.kind === 'kit') {
      const L = scene.layers.get(def.id) as PreparedKitLayer;
      if (!L.depthTested) late();
      drawKitLayer(img, scene, L);
    } else if (def.kind === 'fog') {
      overlays();
      drawFog(img, def);
    }
  }
  late();
  return img;
}
