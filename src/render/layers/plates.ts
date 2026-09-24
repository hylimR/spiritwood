import { Mesh, type Container, type State, type Texture } from 'pixi.js';
import type { PlateChunkDef, PlateLayerDef } from '../../contracts/assets.ts';
import type { TextureBudget } from '../../contracts/render.ts';
import { ChunkStreamer, type StreamChunk } from '../../assets/streamer.ts';
import { loadTextureSource, unloadTextureSource, type TextureFormatSupport } from '../../assets/textures.ts';
import { triangulate } from '../gen/polygon.ts';
import { depthForInstance, type Extent } from '../util/camera.ts';
import { createKitGeometry, type WorldMesh } from './geometry.ts';
import { KIT_STRIDE_FLOATS, packTint, type MeshData } from './kitMesh.ts';
import { createKitShader, type KitLayerUniforms } from './kitShader.ts';
import { KIT_MODE } from './kitShading.ts';

/** Chunk-local polygon (texels) → kit-format mesh data in layer space. */
export function plateMeshData(poly: readonly number[], rect: Extent, cw: number, ch: number, depth: number): MeshData {
  const idx = triangulate(poly);
  const n = poly.length / 2;
  const vertices = new Float32Array(n * KIT_STRIDE_FLOATS);
  const u32 = new Uint32Array(vertices.buffer);
  const sx = (rect.x1 - rect.x0) / cw;
  const sy = (rect.y1 - rect.y0) / ch;
  const b: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let area = 0;
  for (let i = 0; i < n; i++) {
    const px = poly[i * 2] as number;
    const py = poly[i * 2 + 1] as number;
    const x = rect.x0 + px * sx;
    const y = rect.y0 + py * sy;
    const o = i * KIT_STRIDE_FLOATS;
    vertices[o] = x;
    vertices[o + 1] = y;
    vertices[o + 2] = px / cw;
    vertices[o + 3] = py / ch;
    vertices[o + 6] = depth;
    u32[o + 7] = packTint(0, 0.5);
    b.x0 = Math.min(b.x0, x);
    b.x1 = Math.max(b.x1, x);
    b.y0 = Math.min(b.y0, y);
    b.y1 = Math.max(b.y1, y);
  }
  for (let t = 0; t < idx.length; t += 3) {
    const a = (idx[t] as number) * 2;
    const c = (idx[t + 1] as number) * 2;
    const d = (idx[t + 2] as number) * 2;
    area += Math.abs(((poly[c] as number) - (poly[a] as number)) * ((poly[d + 1] as number) - (poly[a + 1] as number))
      - ((poly[d] as number) - (poly[a] as number)) * ((poly[c + 1] as number) - (poly[a + 1] as number))) / 2 * sx * sy;
  }
  return { vertices, indices: Uint16Array.from(idx), vertexCount: n, bounds: b, area };
}

interface PlateChunk {
  def: PlateChunkDef;
  stream: StreamChunk;
  meshes: WorldMesh[];
  texture: Texture | null;
  url: string | null;
  failed: boolean;
  shown: boolean;
}

export interface PlateEnv {
  coreParent: Container;
  bandParent: Container;
  coreState: State;
  bandState: State;
  uniforms: KitLayerUniforms;
  baseUrl: string;
  support: TextureFormatSupport;
  budget: TextureBudget;
  budgetBytes: number;
  /** Prefetch margin in layer units. */
  margin: number;
}

/**
 * A painted plate layer: a grid of texture chunks streamed by ChunkStreamer and drawn with the kit
 * program (modes PlateCore/PlateBand). Chunks that are not loaded simply don't draw.
 */
export class PlateLayer {
  readonly def: PlateLayerDef;
  readonly depth: number;
  private readonly chunks: PlateChunk[] = [];
  private readonly byKey = new Map<string, PlateChunk>();
  private readonly streamer: ChunkStreamer;
  private readonly loads: StreamChunk[] = [];
  private readonly evicts: StreamChunk[] = [];
  private readonly env: PlateEnv;
  private destroyed = false;

  constructor(def: PlateLayerDef, env: PlateEnv) {
    this.def = def;
    this.env = env;
    this.depth = depthForInstance(def.parallax[0], 1);
    const [cw, ch] = def.chunkSize;
    const ts = def.texelScale;
    const streamChunks: StreamChunk[] = [];
    for (const c of def.chunks) {
      const x0 = def.origin[0] + c.col * cw * ts;
      const y0 = def.origin[1] + c.row * ch * ts;
      const stream: StreamChunk = {
        key: `${def.id}:${c.col}:${c.row}`,
        x0, y0, x1: x0 + cw * ts, y1: y0 + ch * ts,
        // Estimate before loading: compressed (1 B/texel + mips) when KTX2 is available, else RGBA8.
        bytes: env.support.ktx2 && c.source.ktx2 ? Math.ceil(cw * ch * 4 / 3) : cw * ch * 4,
      };
      streamChunks.push(stream);
      const pc: PlateChunk = { def: c, stream, meshes: [], texture: null, url: null, failed: false, shown: false };
      this.chunks.push(pc);
      this.byKey.set(stream.key, pc);
    }
    this.streamer = new ChunkStreamer(streamChunks, { margin: env.margin, maxInFlight: 2, budgetBytes: env.budgetBytes });
  }

  setBudget(bytes: number): void {
    this.streamer.setBudget(bytes);
  }

  /** Per frame: stream, evict and show/hide loaded chunks. Allocates only when a load starts. */
  update(visible: Extent, frame: number): void {
    const s = this.streamer;
    s.update(visible, frame);
    s.nextLoads(this.loads);
    for (let i = 0; i < this.loads.length; i++) this.startLoad(this.byKey.get((this.loads[i] as StreamChunk).key) as PlateChunk);
    s.evictions(this.evicts);
    for (let i = 0; i < this.evicts.length; i++) this.evict(this.byKey.get((this.evicts[i] as StreamChunk).key) as PlateChunk);
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] as PlateChunk;
      const show = c.meshes.length > 0 && s.isVisible(c.stream.key);
      if (show !== c.shown) {
        c.shown = show;
        for (let m = 0; m < c.meshes.length; m++) (c.meshes[m] as WorldMesh).visible = show;
      }
    }
  }

  private startLoad(c: PlateChunk): void {
    if (c.failed) return;
    const key = c.stream.key;
    this.streamer.markLoading(key);
    loadTextureSource(c.def.source, this.env.baseUrl, this.env.support, this.env.budget, key).then(
      ({ texture, url }) => {
        if (this.destroyed || this.streamer.state(key) !== 'loading') {
          void unloadTextureSource(url, this.env.budget, key);
          return;
        }
        c.texture = texture;
        c.url = url;
        this.buildMeshes(c, texture);
        this.streamer.markLoaded(key);
      },
      (err: unknown) => {
        console.warn(`[plates] failed to load ${key}`, err);
        c.failed = true;
        if (!this.destroyed) this.streamer.markFailed(key);
      },
    );
  }

  private buildMeshes(c: PlateChunk, texture: Texture): void {
    const [cw, ch] = this.def.chunkSize;
    const rect: Extent = { x0: c.stream.x0, y0: c.stream.y0, x1: c.stream.x1, y1: c.stream.y1 };
    const straight = texture.source.alphaMode === 'no-premultiply-alpha';
    const band = c.def.hull ?? [0, 0, cw, 0, cw, ch, 0, ch];
    const add = (poly: readonly number[], mode: typeof KIT_MODE.PlateCore | typeof KIT_MODE.PlateBand): void => {
      const data = plateMeshData(poly, rect, cw, ch, this.depth);
      const mesh = new Mesh({
        geometry: createKitGeometry(data, c.stream.key),
        shader: createKitShader(texture.source, this.env.uniforms, mode, straight),
        state: mode === KIT_MODE.PlateCore ? this.env.coreState : this.env.bandState,
      });
      mesh.visible = false;
      (mode === KIT_MODE.PlateCore ? this.env.coreParent : this.env.bandParent).addChild(mesh);
      c.meshes.push(mesh);
    };
    if (c.def.opaqueHull) add(c.def.opaqueHull, KIT_MODE.PlateCore);
    add(band, KIT_MODE.PlateBand);
    c.shown = false;
  }

  private evict(c: PlateChunk): void {
    for (const m of c.meshes) {
      m.geometry.destroy(true);
      m.shader?.destroy();
      m.destroy();
    }
    c.meshes.length = 0;
    c.shown = false;
    const url = c.url;
    c.texture = null;
    c.url = null;
    this.streamer.markUnloaded(c.stream.key);
    if (url) void unloadTextureSource(url, this.env.budget, c.stream.key);
  }

  /** Estimated on-screen fill contribution (layer units²) of visible loaded chunks. */
  visibleArea(visible: Extent): number {
    let a = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] as PlateChunk;
      if (!c.shown) continue;
      const w = Math.min(c.stream.x1, visible.x1) - Math.max(c.stream.x0, visible.x0);
      const h = Math.min(c.stream.y1, visible.y1) - Math.max(c.stream.y0, visible.y0);
      if (w > 0 && h > 0) a += w * h;
    }
    return a;
  }

  destroy(): void {
    this.destroyed = true;
    for (const c of this.chunks) if (c.meshes.length > 0 || c.url) this.evict(c);
  }
}
