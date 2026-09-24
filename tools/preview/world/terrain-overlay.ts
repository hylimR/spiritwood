import { buildTerrainMesh, CORE_STRIDE_FLOATS, DEFAULT_TERRAIN, EDGE_KIND_MOSS, EDGE_STRIDE_FLOATS, type TerrainMesh } from '../../../src/render/terrain/terrainMesh.ts';
import {
  litFromNormal, MOSS_GLOW_COLOR, mossAlpha, mossGlow, mossSpeck, shadeMoss, shadeTerrainCore,
} from '../../../src/render/terrain/terrainShading.ts';
import type { Frame, Scene } from './compose.ts';
import { vnoise } from './glslNoise.ts';

type Shader = (i: number, b0: number, b1: number, b2: number) => void;

/** Glow strength of the moss twin (TerrainView's MOSS_GLOW). */
const MOSS_GLOW = 0.55;

/** Rasterise a triangle given in pixel coordinates, calling `shade` with barycentrics per pixel. */
export function rasterTri(img: Frame, x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, shade: Shader): void {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(img.w - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(img.h - 1, Math.ceil(Math.max(y0, y1, y2)));
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(area) < 1e-9) return;
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      const cx = px + 0.5;
      const cy = py + 0.5;
      const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
      const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      shade(py * img.w + px, w0, w1, w2);
    }
  }
}

/** Unpack an unorm8x4 spill slot (warm, flora, thorn) from an interleaved float array. */
function spillOf(data: Float32Array, index: number, out: number[]): number[] {
  const u = new Uint32Array(data.buffer, data.byteOffset + index * 4, 1)[0] as number;
  out[0] = (u & 255) / 255;
  out[1] = ((u >> 8) & 255) / 255;
  out[2] = ((u >> 16) & 255) / 255;
  return out;
}

export function drawTerrain(img: Frame, mesh: TerrainMesh, aaPx = 1.25): void {
  const col = new Float32Array(4);
  const sd = DEFAULT_TERRAIN.shadeDepth;
  const viewL = img.cam.cx - img.viewW / 2 - 60;
  const viewR = img.cam.cx + img.viewW / 2 + 60;
  const viewT = img.cam.cy - img.viewH / 2 - 60;
  const viewB = img.cam.cy + img.viewH / 2 + 60;
  const sA = [0, 0, 0];
  const sB = [0, 0, 0];
  const sC = [0, 0, 0];
  const sp = [0, 0, 0];
  for (const ch of mesh.chunks) {
    if (ch.bounds.x1 < viewL || ch.bounds.x0 > viewR || ch.bounds.y1 < viewT || ch.bounds.y0 > viewB) continue;
    const v = ch.core;
    const idx = ch.coreIndices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = (idx[t] as number) * CORE_STRIDE_FLOATS;
      const b = (idx[t + 1] as number) * CORE_STRIDE_FLOATS;
      const c = (idx[t + 2] as number) * CORE_STRIDE_FLOATS;
      const [ax, ay] = img.toPx(v[a] as number, v[a + 1] as number);
      const [bx, by] = img.toPx(v[b] as number, v[b + 1] as number);
      const [cx, cy] = img.toPx(v[c] as number, v[c + 1] as number);
      spillOf(v, a + 4, sA);
      spillOf(v, b + 4, sB);
      spillOf(v, c + 4, sC);
      rasterTri(img, ax, ay, bx, by, cx, cy, (i, w0, w1, w2) => {
        const depth = (v[a + 2] as number) * w0 + (v[b + 2] as number) * w1 + (v[c + 2] as number) * w2;
        const lit = (v[a + 3] as number) * w0 + (v[b + 3] as number) * w1 + (v[c + 3] as number) * w2;
        for (let k = 0; k < 3; k++) sp[k] = (sA[k] as number) * w0 + (sB[k] as number) * w1 + (sC[k] as number) * w2;
        const wx = img.worldX(i % img.w);
        const wy = img.worldY(Math.floor(i / img.w));
        shadeTerrainCore(col, depth, sd, wx, wy, lit, sp, vnoise);
        const o = i * 3;
        img.rgb[o] = col[0] as number;
        img.rgb[o + 1] = col[1] as number;
        img.rgb[o + 2] = col[2] as number;
      });
    }
    // Edge strips (AA feather, then moss) with the vertex shader's offsets.
    const e = ch.edge;
    const ei = ch.edgeIndices;
    const aaW = aaPx * img.scale;
    const pos = (k: number): [number, number, number, number, number, number] => {
      const o = k * EDGE_STRIDE_FLOATS;
      const side = e[o + 4] as number;
      const kind = e[o + 5] as number;
      const off = kind === EDGE_KIND_MOSS ? (side < 0 ? side * DEFAULT_TERRAIN.mossIn : side * DEFAULT_TERRAIN.mossOut) : side * aaW;
      const [px, py] = img.toPx((e[o] as number) + (e[o + 2] as number) * off, (e[o + 1] as number) + (e[o + 3] as number) * off);
      return [px, py, side, kind, e[o + 6] as number, litFromNormal(e[o + 2] as number, e[o + 3] as number)];
    };
    for (let t = 0; t < ei.length; t += 3) {
      const A = pos(ei[t] as number);
      const B = pos(ei[t + 1] as number);
      const Cc = pos(ei[t + 2] as number);
      const kind = A[3];
      spillOf(e, (ei[t] as number) * EDGE_STRIDE_FLOATS + 8, sA);
      rasterTri(img, A[0], A[1], B[0], B[1], Cc[0], Cc[1], (i, w0, w1, w2) => {
        const side = A[2] * w0 + B[2] * w1 + Cc[2] * w2;
        const up = A[4] * w0 + B[4] * w1 + Cc[4] * w2;
        const lit = A[5] * w0 + B[5] * w1 + Cc[5] * w2;
        const wx = img.worldX(i % img.w);
        const wy = img.worldY(Math.floor(i / img.w));
        if (kind === EDGE_KIND_MOSS) {
          const al = mossAlpha(side, up, wx, wy, vnoise);
          const s = mossSpeck(wx, wy, vnoise);
          shadeMoss(col, al, s, sA);
          img.blend(i, col[0] as number, col[1] as number, col[2] as number, col[3] as number);
          const g = mossGlow(al, s) * MOSS_GLOW;
          img.addGlow(i, MOSS_GLOW_COLOR[0] * g, MOSS_GLOW_COLOR[1] * g, MOSS_GLOW_COLOR[2] * g);
        } else {
          const al = Math.min(1, Math.max(0, (1 - side) / 2));
          shadeTerrainCore(col, 0, sd, wx, wy, lit, sA, vnoise);
          img.blend(i, (col[0] as number) * al, (col[1] as number) * al, (col[2] as number) * al, al);
        }
      });
    }
  }
}

/** Adds the terrain pass to a preview scene. */
export function addTerrain(scene: Scene): TerrainMesh {
  const mesh = buildTerrainMesh(scene.level);
  scene.overlays.push((img) => drawTerrain(img, mesh));
  return mesh;
}
