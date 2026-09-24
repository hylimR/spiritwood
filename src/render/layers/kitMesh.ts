import type { KitElement } from '../gen/kit.ts';
import { depthForInstance, type Extent } from '../util/camera.ts';
import { elementRowY, type KitInstance } from './placement.ts';

/**
 * Interleaved kit vertex: aPosition (2 f32), aUV (2 f32), aSway (2 f32: amplitude, phase),
 * aDepth (f32), aTint (unorm8x4: glow rgb + brightness variation in alpha).
 */
export const KIT_STRIDE_FLOATS = 8;
export const KIT_STRIDE_BYTES = KIT_STRIDE_FLOATS * 4;
/** Uint16 index limit. */
export const MAX_MESH_VERTICES = 65535;
/** Sway wave amplitude is at most ~1.3× the baked amplitude; bounds are padded by this factor. */
const SWAY_BOUNDS_FACTOR = 1.4;

export interface MeshData {
  vertices: Float32Array;
  indices: Uint16Array;
  vertexCount: number;
  /** Layer-space bounds without sway. */
  bounds: Extent;
  /** Sum of rect areas (layer units²), for fill estimates. */
  area: number;
}

export interface ChunkMeshes {
  /** Layer-space bounds of everything in the chunk, padded for sway. */
  bounds: Extent;
  /** Opaque cores, indexed front → back. Empty for blend-only layers. */
  core: MeshData[];
  /** Soft bands (or everything, for blend-only layers), indexed back → front. */
  band: MeshData[];
}

export interface FillQuad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The kit's solid block; the quad samples its centre texels. */
  el: KitElement;
}

export interface BuildOptions {
  /** true: core + band meshes (depth-tested layers); false: one blended mesh set in `band`. */
  split: boolean;
  /** Parallax fx for per-instance depth; null writes depth 0 (non-depth-tested slots). */
  depthF: number | null;
  /** Glow colour 0xRRGGBB baked into aTint.rgb. */
  glow: number | ((inst: KitInstance) => number);
  /** Layer-space chunk width; ≤ 0 or Infinity = one chunk. */
  chunkWidth: number;
  /** Left edge the chunk grid starts from. */
  originX: number;
  /** Sway amplitude, layer units per 100 u of element height at weight 1. */
  swayAmp: number;
  atlasW: number;
  atlasH: number;
  /** Only emissive elements (glow twins). */
  emissiveOnly?: boolean;
  fill?: FillQuad | null;
}

class MeshBuilder {
  private v: number[] = [];
  private i: number[] = [];
  private n = 0;
  private area = 0;
  private b: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  readonly done: MeshData[] = [];

  quad(
    x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number,
    sw0: number, sw1: number, phase: number, depth: number, tint: number,
  ): void {
    if (this.n + 4 > MAX_MESH_VERTICES) this.flush();
    const base = this.n;
    this.vert(x0, y0, u0, v0, sw0, phase, depth, tint);
    this.vert(x1, y0, u1, v0, sw0, phase, depth, tint);
    this.vert(x1, y1, u1, v1, sw1, phase, depth, tint);
    this.vert(x0, y1, u0, v1, sw1, phase, depth, tint);
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    this.area += Math.abs((x1 - x0) * (y1 - y0));
  }

  private vert(x: number, y: number, u: number, v: number, sw: number, phase: number, depth: number, tint: number): void {
    this.v.push(x, y, u, v, sw, phase, depth, tint);
    this.n++;
    const b = this.b;
    if (x < b.x0) b.x0 = x;
    if (x > b.x1) b.x1 = x;
    if (y < b.y0) b.y0 = y;
    if (y > b.y1) b.y1 = y;
  }

  flush(): void {
    if (this.n === 0) return;
    const vertices = new Float32Array(this.v.length);
    const u32 = new Uint32Array(vertices.buffer);
    for (let k = 0; k < this.v.length; k++) {
      if (k % KIT_STRIDE_FLOATS === KIT_STRIDE_FLOATS - 1) u32[k] = this.v[k] as number;
      else vertices[k] = this.v[k] as number;
    }
    this.done.push({ vertices, indices: Uint16Array.from(this.i), vertexCount: this.n, bounds: this.b, area: this.area });
    this.v = [];
    this.i = [];
    this.n = 0;
    this.area = 0;
    this.b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  }
}

/** Pack glow rgb and a 0..1 brightness variation into a little-endian RGBA8 uint32. */
export function packTint(rgb: number, shade: number): number {
  const r = (rgb >> 16) & 255;
  const g = (rgb >> 8) & 255;
  const b = rgb & 255;
  const a = Math.round(Math.min(1, Math.max(0, shade)) * 255);
  return (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
}

function swayWeight(el: KitElement, ty: number): number {
  if (el.sway === 'bottom') return Math.min(1, Math.max(0, (el.anchorY - ty) / Math.max(1, el.anchorY)));
  if (el.sway === 'top') return Math.min(1, Math.max(0, (ty - el.anchorY) / Math.max(1, el.h - el.anchorY)));
  return 0;
}

function emitRects(
  mb: MeshBuilder, inst: KitInstance, rects: readonly number[], o: BuildOptions, swayK: number, depth: number, tint: number,
): void {
  const el = inst.el;
  const sx = inst.sx * el.unitsPerTexel;
  for (let r = 0; r < rects.length; r += 4) {
    const tx0 = rects[r] as number;
    const ty0 = rects[r + 1] as number;
    const tx1 = rects[r + 2] as number;
    const ty1 = rects[r + 3] as number;
    const w0 = swayWeight(el, ty0);
    const w1 = swayWeight(el, ty1);
    mb.quad(
      inst.x + (tx0 - el.anchorX) * sx, elementRowY(inst, ty0),
      inst.x + (tx1 - el.anchorX) * sx, elementRowY(inst, ty1),
      (el.x + tx0) / o.atlasW, (el.y + ty0) / o.atlasH, (el.x + tx1) / o.atlasW, (el.y + ty1) / o.atlasH,
      w0 * w0 * swayK, w1 * w1 * swayK, inst.phase, depth, tint,
    );
  }
}

/**
 * Merge instances into per-chunk static meshes (ARCHITECTURE.md §5.5). Instances go to the chunk of
 * their anchor x; the optional ground fill is split at chunk edges. Core meshes are indexed front →
 * back (early-Z), band meshes back → front (painter order). Meshes never exceed 65535 vertices.
 */
export function buildChunks(instances: readonly KitInstance[], o: BuildOptions): ChunkMeshes[] {
  const single = !(o.chunkWidth > 0) || !Number.isFinite(o.chunkWidth);
  let maxX = o.originX;
  // Chunks follow the instances; the fill's tails merge into the first and last chunk.
  for (const inst of instances) maxX = Math.max(maxX, inst.x);
  const count = single ? 1 : Math.max(1, Math.floor((maxX - o.originX) / o.chunkWidth) + 1);
  const buckets: KitInstance[][] = [];
  for (let c = 0; c < count; c++) buckets.push([]);
  for (const inst of instances) {
    if (o.emissiveOnly && !inst.el.emissive) continue;
    const c = single ? 0 : Math.min(count - 1, Math.max(0, Math.floor((inst.x - o.originX) / o.chunkWidth)));
    (buckets[c] as KitInstance[]).push(inst);
  }
  const out: ChunkMeshes[] = [];
  for (let c = 0; c < count; c++) {
    const list = buckets[c] as KitInstance[];
    const coreB = new MeshBuilder();
    const bandB = new MeshBuilder();
    let swayPad = 0;
    const byK = list.slice().sort((a, b) => a.k - b.k);
    const tintOf = (inst: KitInstance): number => packTint(typeof o.glow === 'function' ? o.glow(inst) : o.glow, inst.shade);
    const depthOf = (k: number): number => (o.depthF === null ? 0 : depthForInstance(o.depthF, k));
    const swayOf = (inst: KitInstance): number => {
      if (inst.el.sway === 'none' || o.swayAmp <= 0) return 0;
      const hUnits = inst.el.h * inst.el.unitsPerTexel * Math.abs(inst.sy);
      const k = inst.el.swayScale * o.swayAmp * (hUnits / 100);
      swayPad = Math.max(swayPad, k * SWAY_BOUNDS_FACTOR);
      return k;
    };
    // The ground fill is the backmost thing in its layer: last in the front → back core order,
    // first in the back → front band order.
    const emitFill = (target: MeshBuilder): void => {
      if (!o.fill || o.emissiveOnly) return;
      const f = o.fill;
      const x0 = single || c === 0 ? f.x0 : Math.max(f.x0, o.originX + c * o.chunkWidth);
      const x1 = single || c === count - 1 ? f.x1 : Math.min(f.x1, o.originX + (c + 1) * o.chunkWidth);
      if (x1 <= x0) return;
      const el = f.el;
      const cu = (el.x + el.w / 2) / o.atlasW;
      const cv = (el.y + el.h / 2) / o.atlasH;
      target.quad(x0, f.y0, x1, f.y1, cu, cv, cu, cv, 0, 0, 0, depthOf(0), packTint(0, 0.5));
    };
    if (o.split) {
      for (let i = byK.length - 1; i >= 0; i--) {
        const inst = byK[i] as KitInstance;
        emitRects(coreB, inst, inst.el.core, o, swayOf(inst), depthOf(inst.k), tintOf(inst));
      }
      emitFill(coreB);
      for (const inst of byK) emitRects(bandB, inst, inst.el.soft, o, swayOf(inst), depthOf(inst.k), tintOf(inst));
    } else {
      emitFill(bandB);
      for (const inst of byK) {
        const k = swayOf(inst);
        const tint = tintOf(inst);
        emitRects(bandB, inst, inst.el.core, o, k, depthOf(inst.k), tint);
        emitRects(bandB, inst, inst.el.soft, o, k, depthOf(inst.k), tint);
      }
    }
    coreB.flush();
    bandB.flush();
    if (coreB.done.length === 0 && bandB.done.length === 0) continue;
    const bounds: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const m of [...coreB.done, ...bandB.done]) {
      bounds.x0 = Math.min(bounds.x0, m.bounds.x0 - swayPad);
      bounds.x1 = Math.max(bounds.x1, m.bounds.x1 + swayPad);
      bounds.y0 = Math.min(bounds.y0, m.bounds.y0);
      bounds.y1 = Math.max(bounds.y1, m.bounds.y1);
    }
    out.push({ bounds, core: coreB.done, band: bandB.done });
  }
  return out;
}
