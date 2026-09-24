import { buildTerrainMesh, CORE_STRIDE_FLOATS, DEFAULT_TERRAIN, EDGE_KIND_MOSS, EDGE_STRIDE_FLOATS, type TerrainMesh } from '../../../src/render/terrain/terrainMesh.ts';
import { mossAlpha, shadeMoss, shadeTerrainCore } from '../../../src/render/terrain/terrainShading.ts';
import type { Frame, Scene } from './compose.ts';

type Shader = (i: number, b0: number, b1: number, b2: number) => void;

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

/** World → pixel for the gameplay plane. */
function toPx(img: Frame, x: number, y: number): [number, number] {
  return [(x - img.cam.cx + img.viewW / 2) / img.scale, (y - img.cam.cy + img.viewH / 2) / img.scale];
}

export function drawTerrain(img: Frame, scene: Scene, mesh: TerrainMesh, aaPx = 1.5): void {
  const col = new Float32Array(4);
  const n = scene.noise;
  const sd = DEFAULT_TERRAIN.shadeDepth;
  const viewL = img.cam.cx - img.viewW / 2 - 60;
  const viewR = img.cam.cx + img.viewW / 2 + 60;
  const viewT = img.cam.cy - img.viewH / 2 - 60;
  const viewB = img.cam.cy + img.viewH / 2 + 60;
  for (const ch of mesh.chunks) {
    if (ch.bounds.x1 < viewL || ch.bounds.x0 > viewR || ch.bounds.y1 < viewT || ch.bounds.y0 > viewB) continue;
    const v = ch.core;
    const idx = ch.coreIndices;
    for (let t = 0; t < idx.length; t += 3) {
      const a = (idx[t] as number) * CORE_STRIDE_FLOATS;
      const b = (idx[t + 1] as number) * CORE_STRIDE_FLOATS;
      const c = (idx[t + 2] as number) * CORE_STRIDE_FLOATS;
      const [ax, ay] = toPx(img, v[a] as number, v[a + 1] as number);
      const [bx, by] = toPx(img, v[b] as number, v[b + 1] as number);
      const [cx, cy] = toPx(img, v[c] as number, v[c + 1] as number);
      rasterTri(img, ax, ay, bx, by, cx, cy, (i, w0, w1, w2) => {
        const depth = (v[a + 2] as number) * w0 + (v[b + 2] as number) * w1 + (v[c + 2] as number) * w2;
        const wx = ((v[a] as number) * w0 + (v[b] as number) * w1 + (v[c] as number) * w2);
        const wy = ((v[a + 1] as number) * w0 + (v[b + 1] as number) * w1 + (v[c + 1] as number) * w2);
        shadeTerrainCore(col, depth, sd, n.sample(wx * 0.05, wy * 0.05));
        const o = i * 3;
        img.rgb[o] = col[0] as number;
        img.rgb[o + 1] = col[1] as number;
        img.rgb[o + 2] = col[2] as number;
      });
    }
    // Edge strips (AA feather, then moss) — offsets applied as in the vertex shader.
    const e = ch.edge;
    const ei = ch.edgeIndices;
    const aaW = aaPx * img.scale;
    const pos = (k: number): [number, number, number, number, number] => {
      const o = k * EDGE_STRIDE_FLOATS;
      const side = e[o + 4] as number;
      const kind = e[o + 5] as number;
      const off = kind === EDGE_KIND_MOSS ? (side < 0 ? side * DEFAULT_TERRAIN.mossIn : side * DEFAULT_TERRAIN.mossOut) : side * aaW;
      const [px, py] = toPx(img, (e[o] as number) + (e[o + 2] as number) * off, (e[o + 1] as number) + (e[o + 3] as number) * off);
      return [px, py, side, kind, e[o + 6] as number];
    };
    for (let t = 0; t < ei.length; t += 3) {
      const A = pos(ei[t] as number);
      const B = pos(ei[t + 1] as number);
      const Cc = pos(ei[t + 2] as number);
      const kind = A[3];
      const oA = (ei[t] as number) * EDGE_STRIDE_FLOATS;
      rasterTri(img, A[0], A[1], B[0], B[1], Cc[0], Cc[1], (i, w0, w1, w2) => {
        const side = A[2] * w0 + B[2] * w1 + Cc[2] * w2;
        const up = A[4] * w0 + B[4] * w1 + Cc[4] * w2;
        const wx = (e[oA] as number);
        const wy = (e[oA + 1] as number);
        if (kind === EDGE_KIND_MOSS) {
          const px = (i % img.w) * img.scale + img.cam.cx - img.viewW / 2;
          const py = Math.floor(i / img.w) * img.scale + img.cam.cy - img.viewH / 2;
          const al = mossAlpha(side, up, 0.5 + 0.5 * n.sample(px * 0.09, py * 0.09));
          shadeMoss(col, al, 0.5 + 0.5 * n.sample(px * 0.7 + 30, py * 0.7));
          img.blend(i, col[0] as number, col[1] as number, col[2] as number, col[3] as number);
        } else {
          const al = Math.min(1, Math.max(0, (1 - side) / 2));
          shadeTerrainCore(col, 0, sd, n.sample(wx * 0.05, wy * 0.05));
          img.blend(i, (col[0] as number) * al, (col[1] as number) * al, (col[2] as number) * al, al);
        }
      });
    }
  }
}

/** Adds the terrain pass to a preview scene. */
export function addTerrain(scene: Scene): TerrainMesh {
  const mesh = buildTerrainMesh(scene.level);
  scene.overlays.push((img) => drawTerrain(img, scene, mesh));
  return mesh;
}
