import type { FogLayerDef, LayerManifest, SkyLayerDef } from '../../../src/contracts/assets.ts';
import type { LevelData } from '../../../src/contracts/level.ts';
import { hexToRgb, parseHexColor, type RGB } from '../../../src/core/color.ts';
import type { KitAtlasData } from '../../../src/render/gen/kit.ts';
import { NoiseTable } from '../../../src/render/gen/noiseTable.ts';
import { KIT_STRIDE_FLOATS, type ChunkMeshes, type MeshData } from '../../../src/render/layers/kitMesh.ts';
import { KIT_MODE, shadeKit, type KitMode, type KitShadeParams } from '../../../src/render/layers/kitShading.ts';
import { prepareKitLayer, type PreparedKitLayer } from '../../../src/render/layers/layerModel.ts';
import { shadeSky, skyParams } from '../../../src/render/layers/skyShading.ts';

/**
 * A CPU compositor for browser-free previews: rasterises the real chunk meshes (positions, UVs,
 * per-instance depth order) with the TS reference shading of the sky, kit layers and fog bands.
 * Premultiplied RGB accumulation; output is 8-bit RGBA.
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
  /** Extra passes drawn after the kit layers below the terrain slot (e.g. terrain), in world space. */
  overlays: ((img: Frame) => void)[];
}

export class Frame {
  readonly w: number;
  readonly h: number;
  /** View units per pixel. */
  readonly scale: number;
  readonly viewW: number;
  readonly viewH: number;
  readonly cam: Camera;
  readonly rgb: Float32Array;

  constructor(w: number, h: number, viewW: number, viewH: number, cam: Camera) {
    this.w = w;
    this.h = h;
    this.viewW = viewW;
    this.viewH = viewH;
    this.scale = viewH / h;
    this.cam = cam;
    this.rgb = new Float32Array(w * h * 3);
  }

  /** Premultiplied "over". */
  blend(i: number, r: number, g: number, b: number, a: number): void {
    const o = i * 3;
    this.rgb[o] = r + (this.rgb[o] as number) * (1 - a);
    this.rgb[o + 1] = g + (this.rgb[o + 1] as number) * (1 - a);
    this.rgb[o + 2] = b + (this.rgb[o + 2] as number) * (1 - a);
  }

  toRgba(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < this.w * this.h; i++) {
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round((this.rgb[i * 3 + c] as number) * 255)));
      out[i * 4 + 3] = 255;
    }
    return out;
  }
}

export function buildScene(level: LevelData, manifest: LayerManifest, kit: KitAtlasData): Scene {
  const layers = new Map<string, PreparedKitLayer>();
  for (const def of manifest.layers) {
    if (def.kind === 'kit') layers.set(def.id, prepareKitLayer(def, kit, level.pxWidth, level.pxHeight));
  }
  return { level, manifest, kit, layers, noise: new NoiseTable(77), overlays: [] };
}

function sampleAtlas(kit: KitAtlasData, u: number, v: number, out: Float32Array): void {
  const x = Math.min(kit.width - 1, Math.max(0, Math.floor(u * kit.width)));
  const y = Math.min(kit.height - 1, Math.max(0, Math.floor(v * kit.height)));
  const o = (y * kit.width + x) * 4;
  out[0] = (kit.pixels[o] as number) / 255;
  out[1] = (kit.pixels[o + 1] as number) / 255;
  out[2] = (kit.pixels[o + 2] as number) / 255;
  out[3] = (kit.pixels[o + 3] as number) / 255;
}

interface QuadRef {
  mesh: MeshData;
  q: number;
  depth: number;
  mode: KitMode;
}

function drawKitLayer(img: Frame, scene: Scene, L: PreparedKitLayer): void {
  drawKitChunks(img, scene, L.chunks, L.params, L.def.parallax[0], L.def.parallax[1], L.depthTested);
}

/** Rasterise kit-format chunk meshes in painter order (depth-sorted for depth-tested layers). */
export function drawKitChunks(
  img: Frame, scene: Scene, chunks: readonly ChunkMeshes[], params: KitShadeParams, fx: number, fy: number, depthSorted: boolean,
): void {
  const cam = img.cam;
  const quads: QuadRef[] = [];
  for (const chunk of chunks) {
    for (const m of chunk.core) for (let q = 0; q < m.vertexCount / 4; q++) quads.push({ mesh: m, q, depth: m.vertices[q * 4 * KIT_STRIDE_FLOATS + 6] as number, mode: KIT_MODE.Core });
    for (const m of chunk.band) for (let q = 0; q < m.vertexCount / 4; q++) quads.push({ mesh: m, q, depth: m.vertices[q * 4 * KIT_STRIDE_FLOATS + 6] as number, mode: KIT_MODE.Band });
  }
  // Painter order equivalent to the depth-tested passes: far instances (larger depth) first.
  if (depthSorted) quads.sort((a, b) => b.depth - a.depth);
  const tex = new Float32Array(4);
  const px = new Float32Array(4);
  const u32 = new Uint32Array(4);
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
    u32[0] = new Uint32Array(v.buffer, v.byteOffset + (o0 + 7) * 4, 1)[0] as number;
    const tint = u32[0] as number;
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
        if (tex[3] as number <= 0 && mode !== KIT_MODE.Core) continue;
        shadeKit(px, tex, shade, glow, ly, params, mode);
        img.blend(py * img.w + pxx, px[0] as number, px[1] as number, px[2] as number, px[3] as number);
      }
    }
  }
}

function drawSky(img: Frame, scene: Scene, def: SkyLayerDef, time: number): void {
  const p = skyParams(def);
  const out = new Float32Array(3);
  const mist = (x: number, y: number): number => 0.5 + 0.5 * scene.noise.sample(x * 40, y * 40);
  for (let py = 0; py < img.h; py++) {
    for (let px = 0; px < img.w; px++) {
      shadeSky(out, (px + 0.5) * img.scale, (py + 0.5) * img.scale, img.viewW, img.viewH, time, p, mist);
      const o = (py * img.w + px) * 3;
      img.rgb[o] = out[0] as number;
      img.rgb[o + 1] = out[1] as number;
      img.rgb[o + 2] = out[2] as number;
    }
  }
}

function drawFog(img: Frame, scene: Scene, def: FogLayerDef, time: number): void {
  const [fx, fy] = def.parallax;
  const col = hexToRgb(parseHexColor(def.fogColor));
  const cam = img.cam;
  for (let py = 0; py < img.h; py++) {
    const ly = (py + 0.5) * img.scale - img.viewH / 2 + cam.cy * fy;
    const v = (ly - def.y) / def.height;
    if (Math.abs(v) >= 1) continue;
    const prof = (1 - v * v) * (1 - v * v);
    for (let px = 0; px < img.w; px++) {
      const lx = (px + 0.5) * img.scale - img.viewW / 2 + cam.cx * fx;
      const n = 0.5 + 0.5 * scene.noise.sample((lx + time * def.speed) * 0.05, ly * 0.14);
      const a = def.density * prof * Math.min(1, Math.max(0, n * 1.5 - 0.2));
      img.blend(py * img.w + px, col[0] * a, col[1] * a, col[2] * a, a);
    }
  }
}

/** Render the scene for one camera. `terrainAt` draws world-space content between background and fog. */
export function renderScene(scene: Scene, cam: Camera, w: number, h: number, viewW: number, viewH: number, time = 0): Frame {
  const img = new Frame(w, h, viewW, viewH, cam);
  let overlaysDone = false;
  for (const def of scene.manifest.layers) {
    if (def.kind === 'sky') drawSky(img, scene, def, time);
    else if (def.kind === 'kit') {
      const L = scene.layers.get(def.id) as PreparedKitLayer;
      if (!L.depthTested && !overlaysDone) {
        for (const o of scene.overlays) o(img);
        overlaysDone = true;
      }
      drawKitLayer(img, scene, L);
    } else if (def.kind === 'fog') {
      if (!overlaysDone) {
        for (const o of scene.overlays) o(img);
        overlaysDone = true;
      }
      drawFog(img, scene, def, time);
    }
  }
  if (!overlaysDone) for (const o of scene.overlays) o(img);
  return img;
}

