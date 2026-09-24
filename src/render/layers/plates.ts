import { Mesh, type Container, type State, type Texture } from 'pixi.js';
import type { PlateChunkDef, PlateLayerDef } from '../../contracts/assets.ts';
import type { TextureBudget } from '../../contracts/render.ts';
import { plateChunkBytes, plateChunkRect, PLATE_PREFETCH_MARGIN, plateTextureBorder } from '../../assets/plateLayout.ts';
import { ChunkStreamer, type StreamChunk } from '../../assets/streamer.ts';
import { loadTextureSource, textureBytes, unloadTextureSource, type TextureFormatSupport } from '../../assets/textures.ts';
import { triangulate } from '../gen/polygon.ts';
import { depthForInstance, type Extent } from '../util/camera.ts';
import { createKitGeometry, type WorldMesh } from './geometry.ts';
import { KIT_STRIDE_FLOATS, MAX_MESH_VERTICES, packTint, type MeshData } from './kitMesh.ts';
import { createKitShader, type KitLayerUniforms } from './kitShader.ts';
import { KIT_MODE } from './kitShading.ts';

/** How chunk texels map to texture UVs: u = (offset + x) / width, v = (offset + y) / height. */
export interface PlateUv {
  offset: number;
  width: number;
  height: number;
}

function writeVertex(v: Float32Array, u32: Uint32Array, i: number, x: number, y: number, u: number, t: number, depth: number, tint: number): void {
  const o = i * KIT_STRIDE_FLOATS;
  v[o] = x;
  v[o + 1] = y;
  v[o + 2] = u;
  v[o + 3] = t;
  v[o + 6] = depth;
  u32[o + 7] = tint;
}

/** Chunk-local polygon (texels) → kit-format mesh data in layer space (legacy `hull` / `opaqueHull`). */
export function plateMeshData(
  poly: readonly number[], rect: Extent, cw: number, ch: number, depth: number, uv: PlateUv = { offset: 0, width: cw, height: ch },
): MeshData {
  const idx = triangulate(poly);
  const n = poly.length / 2;
  const vertices = new Float32Array(n * KIT_STRIDE_FLOATS);
  const u32 = new Uint32Array(vertices.buffer);
  const sx = (rect.x1 - rect.x0) / cw;
  const sy = (rect.y1 - rect.y0) / ch;
  const b: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  const tint = packTint(0, 0.5);
  let area = 0;
  for (let i = 0; i < n; i++) {
    const px = poly[i * 2] as number;
    const py = poly[i * 2 + 1] as number;
    const x = rect.x0 + px * sx;
    const y = rect.y0 + py * sy;
    writeVertex(vertices, u32, i, x, y, (uv.offset + px) / uv.width, (uv.offset + py) / uv.height, depth, tint);
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

/**
 * Split-hull rects [x, y, w, h, …] (chunk content texels, PlateChunkDef.core / soft) → one kit-format
 * mesh in layer space: 4 vertices and 2 triangles per rect. Null when there are no rects.
 */
export function plateRectsMeshData(rects: readonly number[], rect: Extent, cw: number, ch: number, depth: number, uv: PlateUv): MeshData | null {
  const count = rects.length / 4;
  if (count === 0) return null;
  if (count * 4 > MAX_MESH_VERTICES) throw new Error(`plate chunk: ${count} rects exceed one Uint16 mesh`);
  const vertices = new Float32Array(count * 4 * KIT_STRIDE_FLOATS);
  const u32 = new Uint32Array(vertices.buffer);
  const indices = new Uint16Array(count * 6);
  const sx = (rect.x1 - rect.x0) / cw;
  const sy = (rect.y1 - rect.y0) / ch;
  const tint = packTint(0, 0.5);
  const b: Extent = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let area = 0;
  for (let r = 0; r < count; r++) {
    const tx0 = rects[r * 4] as number;
    const ty0 = rects[r * 4 + 1] as number;
    const tx1 = tx0 + (rects[r * 4 + 2] as number);
    const ty1 = ty0 + (rects[r * 4 + 3] as number);
    const x0 = rect.x0 + tx0 * sx;
    const y0 = rect.y0 + ty0 * sy;
    const x1 = rect.x0 + tx1 * sx;
    const y1 = rect.y0 + ty1 * sy;
    const u0 = (uv.offset + tx0) / uv.width;
    const v0 = (uv.offset + ty0) / uv.height;
    const u1 = (uv.offset + tx1) / uv.width;
    const v1 = (uv.offset + ty1) / uv.height;
    const k = r * 4;
    writeVertex(vertices, u32, k, x0, y0, u0, v0, depth, tint);
    writeVertex(vertices, u32, k + 1, x1, y0, u1, v0, depth, tint);
    writeVertex(vertices, u32, k + 2, x1, y1, u1, v1, depth, tint);
    writeVertex(vertices, u32, k + 3, x0, y1, u0, v1, depth, tint);
    const o = r * 6;
    indices[o] = k;
    indices[o + 1] = k + 1;
    indices[o + 2] = k + 2;
    indices[o + 3] = k;
    indices[o + 4] = k + 2;
    indices[o + 5] = k + 3;
    area += (x1 - x0) * (y1 - y0);
    b.x0 = Math.min(b.x0, x0);
    b.y0 = Math.min(b.y0, y0);
    b.x1 = Math.max(b.x1, x1);
    b.y1 = Math.max(b.y1, y1);
  }
  return { vertices, indices, vertexCount: count * 4, bounds: b, area };
}

/**
 * The texture budget as plates see it: plate textures register in the shared budget as usual, and
 * this view also sums them, so the atlases' share (everything else registered) is read when streaming,
 * not fixed at init (§5.8: the hero and entity atlases register after the parallax stack).
 */
export class PlateBudget implements TextureBudget {
  private readonly inner: TextureBudget;
  private readonly entries = new Map<string, number>();
  private plates = 0;

  constructor(inner: TextureBudget) {
    this.inner = inner;
  }

  set(key: string, bytes: number): void {
    this.inner.set(key, bytes);
    this.plates += bytes - (this.entries.get(key) ?? 0);
    this.entries.set(key, bytes);
  }

  remove(key: string): void {
    this.inner.remove(key);
    const b = this.entries.get(key);
    if (b === undefined) return;
    this.plates -= b;
    this.entries.delete(key);
  }

  get totalBytes(): number {
    return this.inner.totalBytes;
  }

  get budgetBytes(): number {
    return this.inner.budgetBytes;
  }

  /** Bytes of the plate textures currently registered. */
  get plateBytes(): number {
    return this.plates;
  }

  /** What plates may use: the budget minus everything else registered (the atlases). */
  get plateBudget(): number {
    return Math.max(0, this.inner.budgetBytes - (this.inner.totalBytes - this.plates));
  }
}

interface PlateChunk {
  def: PlateChunkDef;
  stream: StreamChunk;
  meshes: WorldMesh[];
  /** Layer units² of the chunk's meshes (fill estimate). */
  area: number;
  texture: Texture | null;
  url: string | null;
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
}

/** Monotonic generation counter: stream and budget keys of a rebuilt layer never collide with old ones. */
let nextGeneration = 1;

/**
 * A painted plate layer: a grid of chunk textures streamed by the shared PlateStreaming and drawn with
 * the kit program (modes PlateCore / PlateBand): per loaded chunk one opaque-core mesh (pre-pass) and one
 * soft mesh (blended) from its split-hull rects, so 2 draws per visible chunk. Chunks that are not loaded
 * simply don't draw. A chunk that fails for good (every encoding, or its load deadline) fails the whole
 * layer: `onFail` lets the stack restore the base layer the plate replaced.
 */
export class PlateLayer {
  def: PlateLayerDef;
  depth: number;
  /** Bumped by every rebuild (hot reload); stream and budget keys carry it. */
  generation = nextGeneration++;
  failed = false;
  onFail: ((layer: PlateLayer, error: unknown) => void) | null = null;
  /** Index in the shared streamer (set by PlateStreaming.add). */
  layerIndex = -1;
  chunks: PlateChunk[] = [];
  private readonly env: PlateEnv;
  private streaming: PlateStreaming | null = null;
  private destroyed = false;

  constructor(def: PlateLayerDef, env: PlateEnv) {
    this.def = def;
    this.env = env;
    this.depth = depthForInstance(def.parallax[0], 1);
    this.buildChunks();
  }

  get id(): string {
    return this.def.id;
  }

  /** @internal PlateStreaming.add */
  attach(streaming: PlateStreaming, layerIndex: number): void {
    this.streaming = streaming;
    this.layerIndex = layerIndex;
    for (const c of this.chunks) c.stream.layer = layerIndex;
  }

  private buildChunks(): void {
    const def = this.def;
    const bytes = plateChunkBytes(def);
    this.chunks = def.chunks.map((c): PlateChunk => {
      const r = plateChunkRect(def, c.col, c.row);
      const stream: StreamChunk = {
        key: `${def.id}#${this.generation}:${c.col}:${c.row}`,
        layer: this.layerIndex,
        x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1,
        // Until it loads, a chunk counts at the RGBA8 worst case the bake budgets with (a KTX2 load can
        // fall back to WebP/PNG); once loaded it counts at its real size (markLoaded).
        bytes,
      };
      return { def: c, stream, meshes: [], area: 0, texture: null, url: null, shown: false };
    });
  }

  /**
   * Hot reload: drop every chunk of the old generation and stream the new definition. Loads of the old
   * generation still in flight release their lease when they land.
   */
  reload(def: PlateLayerDef): void {
    this.evictAll();
    this.def = def;
    this.depth = depthForInstance(def.parallax[0], 1);
    this.generation = nextGeneration++;
    this.failed = false;
    this.buildChunks();
    this.streaming?.rebuild();
  }

  /** @internal PlateStreaming.pump */
  startLoad(key: string): void {
    const c = this.chunkByKey(key);
    const streaming = this.streaming;
    if (!c || !streaming || this.failed) return;
    const gen = this.generation;
    const s = streaming.streamer;
    s.markLoading(key);
    loadTextureSource(c.def.source, this.env.baseUrl, this.env.support, streaming.budget, key).then(
      ({ texture, url }) => {
        if (this.destroyed || gen !== this.generation || this.failed || !s.has(key) || s.state(key) !== 'loading') {
          void unloadTextureSource(url, streaming.budget, key);
          return;
        }
        const src = texture.source;
        const border = plateTextureBorder(this.def, src.pixelWidth, src.pixelHeight);
        let error: unknown;
        if (border === null) {
          error = new Error(`${key}: texture is ${src.pixelWidth}×${src.pixelHeight}, expected the chunk size ${this.def.chunkSize.join('×')} plus an equal border on every side`);
          void unloadTextureSource(url, streaming.budget, key);
        } else {
          try {
            c.texture = texture;
            c.url = url;
            this.buildMeshes(c, texture, border);
            s.markLoaded(key, textureBytes(texture));
            return;
          } catch (e) {
            error = e;
            this.release(c);
          }
        }
        if (s.has(key)) s.markFailed(key);
        this.fail(error);
      },
      (err: unknown) => {
        if (this.destroyed || gen !== this.generation) return;
        if (s.has(key)) s.markFailed(key);
        this.fail(err);
      },
    );
  }

  private chunkByKey(key: string): PlateChunk | undefined {
    for (let i = 0; i < this.chunks.length; i++) if ((this.chunks[i] as PlateChunk).stream.key === key) return this.chunks[i];
    return undefined;
  }

  private fail(err: unknown): void {
    if (this.failed || this.destroyed) return;
    this.failed = true;
    console.warn(`[plates] ${this.def.id} failed to load; falling back`, err);
    this.onFail?.(this, err);
  }

  private buildMeshes(c: PlateChunk, texture: Texture, border: number): void {
    const [cw, ch] = this.def.chunkSize;
    const rect: Extent = { x0: c.stream.x0, y0: c.stream.y0, x1: c.stream.x1, y1: c.stream.y1 };
    const straight = texture.source.alphaMode === 'no-premultiply-alpha';
    const uv: PlateUv = { offset: border, width: texture.source.pixelWidth, height: texture.source.pixelHeight };
    const add = (data: MeshData | null, mode: typeof KIT_MODE.PlateCore | typeof KIT_MODE.PlateBand): void => {
      if (!data) return;
      const core = mode === KIT_MODE.PlateCore;
      const mesh = new Mesh({
        geometry: createKitGeometry(data, c.stream.key),
        shader: createKitShader(texture.source, this.env.uniforms, mode, straight),
        state: core ? this.env.coreState : this.env.bandState,
      });
      mesh.visible = false;
      (core ? this.env.coreParent : this.env.bandParent).addChild(mesh);
      c.meshes.push(mesh);
      c.area += data.area;
    };
    const d = c.def;
    c.area = 0;
    if (d.core || d.soft) {
      // Split hull: disjoint rects, one core mesh and one soft mesh (2 draws per chunk).
      add(plateRectsMeshData(d.core ?? [], rect, cw, ch, this.depth, uv), KIT_MODE.PlateCore);
      add(plateRectsMeshData(d.soft ?? [], rect, cw, ch, this.depth, uv), KIT_MODE.PlateBand);
    } else {
      // Legacy polygons: the band covers the whole hull; over the core its fragments fail the depth test.
      if (d.opaqueHull) add(plateMeshData(d.opaqueHull, rect, cw, ch, this.depth, uv), KIT_MODE.PlateCore);
      add(plateMeshData(d.hull ?? [0, 0, cw, 0, cw, ch, 0, ch], rect, cw, ch, this.depth, uv), KIT_MODE.PlateBand);
    }
    c.shown = false;
  }

  /** @internal PlateStreaming.pump */
  evict(key: string): void {
    const c = this.chunkByKey(key);
    if (c) this.release(c);
  }

  private release(c: PlateChunk): void {
    for (const m of c.meshes) {
      m.geometry.destroy(true);
      m.shader?.destroy();
      m.destroy();
    }
    c.meshes.length = 0;
    c.area = 0;
    c.shown = false;
    const url = c.url;
    c.texture = null;
    c.url = null;
    const streaming = this.streaming;
    if (streaming?.streamer.has(c.stream.key)) streaming.streamer.markUnloaded(c.stream.key);
    if (url && streaming) void unloadTextureSource(url, streaming.budget, c.stream.key);
  }

  /** Release every loaded chunk of this generation. */
  evictAll(): void {
    for (const c of this.chunks) if (c.meshes.length > 0 || c.url) this.release(c);
  }

  /** Per frame, after PlateStreaming.pump: show the loaded chunks that are visible. No allocation. */
  updateVisibility(): void {
    const s = this.streaming?.streamer;
    if (!s) return;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] as PlateChunk;
      const show = c.meshes.length > 0 && s.has(c.stream.key) && s.isVisible(c.stream.key);
      if (show !== c.shown) {
        c.shown = show;
        for (let m = 0; m < c.meshes.length; m++) (c.meshes[m] as WorldMesh).visible = show;
      }
    }
  }

  /** Estimated on-screen fill (layer units²) of the visible loaded chunks: mesh area × visible fraction. */
  visibleArea(visible: Extent): number {
    let a = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] as PlateChunk;
      if (!c.shown) continue;
      const w = Math.min(c.stream.x1, visible.x1) - Math.max(c.stream.x0, visible.x0);
      const h = Math.min(c.stream.y1, visible.y1) - Math.max(c.stream.y0, visible.y0);
      if (w <= 0 || h <= 0) continue;
      a += (c.area * w * h) / Math.max(1, (c.stream.x1 - c.stream.x0) * (c.stream.y1 - c.stream.y0));
    }
    return a;
  }

  /** Chunks with meshes (loaded). */
  get loadedChunks(): number {
    let n = 0;
    for (const c of this.chunks) if (c.meshes.length > 0) n++;
    return n;
  }

  destroy(): void {
    this.evictAll();
    this.destroyed = true;
    this.streaming = null;
  }
}

/**
 * One streamer and one LRU for every plate layer of a stack (§5.8). Its budget is the texture budget
 * minus everything else registered (the atlases), re-read on every pump. At most 2 loads in flight.
 */
export class PlateStreaming {
  readonly streamer: ChunkStreamer;
  readonly budget: PlateBudget;
  private readonly layers: PlateLayer[] = [];
  private readonly owner = new Map<string, PlateLayer>();
  private readonly loads: StreamChunk[] = [];
  private readonly evicts: StreamChunk[] = [];
  private nextIndex = 0;

  constructor(textures: TextureBudget, margin = PLATE_PREFETCH_MARGIN, maxInFlight = 2) {
    this.budget = new PlateBudget(textures);
    this.streamer = new ChunkStreamer([], { margin, maxInFlight, budgetBytes: this.budget.plateBudget });
  }

  add(layer: PlateLayer): void {
    layer.attach(this, this.nextIndex++);
    this.layers.push(layer);
    this.rebuild();
  }

  /** Release a layer's chunks and stop streaming it. */
  remove(layer: PlateLayer): void {
    const i = this.layers.indexOf(layer);
    if (i < 0) return;
    layer.evictAll();
    this.layers.splice(i, 1);
    this.rebuild();
  }

  /** Re-read every layer's chunk list (after add, remove or a layer reload). */
  rebuild(): void {
    const all: StreamChunk[] = [];
    this.owner.clear();
    for (const l of this.layers) {
      for (const c of l.chunks) {
        c.stream.layer = l.layerIndex;
        all.push(c.stream);
        this.owner.set(c.stream.key, l);
      }
    }
    this.streamer.setChunks(all);
  }

  /** Per frame, per plate layer: its visible layer-space rect, or null when the layer is off. */
  setVisible(layer: PlateLayer, visible: Extent | null, frame: number): void {
    this.streamer.updateLayer(layer.layerIndex, visible, frame);
  }

  /** Per frame, after every setVisible: apply the budget, start loads, evict, show loaded chunks. */
  pump(): void {
    const s = this.streamer;
    s.setBudget(this.budget.plateBudget);
    s.nextLoads(this.loads);
    for (let i = 0; i < this.loads.length; i++) {
      const key = (this.loads[i] as StreamChunk).key;
      this.owner.get(key)?.startLoad(key);
    }
    s.evictions(this.evicts);
    for (let i = 0; i < this.evicts.length; i++) {
      const key = (this.evicts[i] as StreamChunk).key;
      this.owner.get(key)?.evict(key);
    }
    for (let i = 0; i < this.layers.length; i++) (this.layers[i] as PlateLayer).updateVisibility();
  }

  get layerCount(): number {
    return this.layers.length;
  }

  destroy(): void {
    for (const l of this.layers) l.destroy();
    this.layers.length = 0;
    this.rebuild();
  }
}
