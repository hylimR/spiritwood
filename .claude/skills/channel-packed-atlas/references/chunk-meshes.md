# Chunk mesh listings (channel-packed-atlas)

This file shows how instances of atlas elements become static per-chunk meshes: one draw per chunk per pass, with Uint16 indices and
per-vertex sway, depth and tint. The listings are verbatim from commit `2ef9428` (the art pass).

## 1. Depth per layer and per instance

With LESS, a higher painter order k gets a smaller depth, so it wins.

`src/render/util/camera.ts` lines 7–18:

```ts
/** Depth for a parallax factor (ARCHITECTURE.md §2.4): terrain 0.05 … farthest ≈ 0.95. */
export function depthForParallax(f: number): number {
  return 0.05 + 0.9 * (1 - clamp(f, 0, 1));
}

/**
 * Depth of instance `k` (painter order, 0 = backmost) inside a layer, so overlapping instances in one
 * layer resolve front-over-back under depth test LESS.
 */
export function depthForInstance(f: number, k: number): number {
  return depthForParallax(f) - k * DEPTH_INSTANCE_EPS;
}
```

`DEPTH_INSTANCE_EPS = 1 / 65536` and `MAX_INSTANCES_PER_LAYER = 1024` (`src/config.ts`, enforced by `placeLayer`), so one layer
spans at most 1024 / 65536 = 1/64 of depth. The vertex shader writes z from `aDepth` alone (`pixiClipPosition` in
`src/render/shaders/common.ts`), so the depth order does not depend on the parallax transform.

## 2. Element row → layer y (stretch above `stretchFrom` for top-cut elements)

`src/render/layers/placement.ts` lines 68–74:

```ts
export function elementRowY(inst: Pick<KitInstance, 'el' | 'y' | 'sx' | 'sy'>, ty: number): number {
  const el = inst.el;
  const u = el.unitsPerTexel;
  const s = Math.abs(inst.sx);
  const sf = el.stretchFrom;
  return ty >= sf ? inst.y + (ty - el.anchorY) * u * s : inst.y + (sf - el.anchorY) * u * s + (ty - sf) * u * inst.sy;
}
```

## 3. Mesh builder, tint packing, sway weights, chunking

`src/render/layers/kitMesh.ts` lines 1–225:

```ts
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
```

## 4. Static interleaved geometry (PixiJS v8.21)

`src/render/layers/geometry.ts` lines 1–43:

```ts
import { Buffer, BufferUsage, Geometry, type Attribute, type Mesh, type Shader, type VertexFormat } from 'pixi.js';
import { KIT_STRIDE_BYTES, MAX_MESH_VERTICES, type MeshData } from './kitMesh.ts';

/** Meshes built from custom geometry and a custom shader. */
export type WorldMesh = Mesh<Geometry, Shader>;

/** A GPU buffer uploaded once (STATIC_DRAW) and exempt from Pixi's idle-resource GC. */
export function staticBuffer(data: Float32Array | Uint16Array, index: boolean, label: string): Buffer {
  const b = new Buffer({ data, usage: (index ? BufferUsage.INDEX : BufferUsage.VERTEX) | BufferUsage.STATIC, label });
  b.autoGarbageCollect = false;
  return b;
}

export interface AttributeSpec {
  name: string;
  format: VertexFormat;
  offset: number;
}

/** Interleaved static geometry. The position attribute must be named `aPosition` (Pixi bounds). */
export function interleavedGeometry(
  vertices: Float32Array, indices: Uint16Array, stride: number, attrs: readonly AttributeSpec[], label: string, shared?: Buffer,
): Geometry {
  if (vertices.length / (stride / 4) > MAX_MESH_VERTICES) throw new Error(`${label}: more than ${MAX_MESH_VERTICES} vertices`);
  const buffer = shared ?? staticBuffer(vertices, false, `${label}-vertices`);
  const attributes: Record<string, Attribute> = {};
  for (const a of attrs) attributes[a.name] = { buffer, format: a.format, stride, offset: a.offset };
  const g = new Geometry({ attributes, indexBuffer: staticBuffer(indices, true, `${label}-indices`) });
  g.autoGarbageCollect = false;
  return g;
}

export const KIT_ATTRIBUTES: readonly AttributeSpec[] = [
  { name: 'aPosition', format: 'float32x2', offset: 0 },
  { name: 'aUV', format: 'float32x2', offset: 8 },
  { name: 'aSway', format: 'float32x2', offset: 16 },
  { name: 'aDepth', format: 'float32', offset: 24 },
  { name: 'aTint', format: 'unorm8x4', offset: 28 },
];

export function createKitGeometry(m: MeshData, label: string): Geometry {
  return interleavedGeometry(m.vertices, m.indices, KIT_STRIDE_BYTES, KIT_ATTRIBUTES, label);
}
```

## 5. GPU states for the core, sky and band passes

`src/render/util/states.ts` lines 1–35:

```ts
import { State } from 'pixi.js';

/**
 * GPU states for the depth-ordered scene passes (ARCHITECTURE.md §2.4). Use one of these on every
 * custom-shader Mesh in slots `opaque`, `sky`, `background`, `shafts`. For additive meshes set
 * `mesh.blendMode = 'add'` on the display object — never assign `state.blendMode` (Pixi's MeshPipe
 * overwrites it from the group blend mode every frame, and the setter re-enables blending).
 */

/** Opaque cores: no blending, depth test + write. Shaders must not `discard` or write gl_FragDepth. */
export function createOpaqueState(): State {
  const s = new State();
  s.blend = false;
  s.depthTest = true;
  s.depthMask = true;
  return s;
}

/** Sky: fills only pixels no opaque core wrote. No blending, depth test, no depth write. */
export function createSkyState(): State {
  const s = new State();
  s.blend = false;
  s.depthTest = true;
  s.depthMask = false;
  return s;
}

/** Soft bands / shafts: premultiplied blending (or additive via mesh.blendMode), depth test, no write. */
export function createTransparentState(): State {
  const s = new State();
  s.blend = true;
  s.depthTest = true;
  s.depthMask = false;
  return s;
}
```

## 6. Wiring a depth-tested layer: core and band containers, one mesh per chunk per pass

This is from `src/render/layers/parallaxStack.ts`. The core containers are sorted near → far (zIndex = depth) and the band containers far → near.
Layers with fx > 1 (foreground) are blend-only with `State.for2d()`. `clearingHints` hands placement the goal and lantern x positions, where the mid and near trunk streams leave clearings.

`src/render/layers/parallaxStack.ts` lines 91–151:

```ts
    const coreState = createOpaqueState();
    const bandState = createTransparentState();
    const clearings = clearingHints(ctx.level);
    const fgState = State.for2d();

    for (const def of defs) {
      const fx = def.parallax[0];
      const fy = def.parallax[1];
      const depthTested = fx <= 1;
      const z = Math.round(depthForParallax(fx) * 1e6);
      const core = new Container({ label: `${def.id}:core`, zIndex: z });
      const band = new Container({ label: `${def.id}:band`, zIndex: -z });
      const containers = depthTested ? [core, band] : [band];
      if (depthTested) {
        opaqueRoot.addChild(core);
        bandRoot.addChild(band);
      } else {
        fgRoot.addChild(band);
      }
      if (def.kind === 'kit') {
        const atlas = ctx.manifest.atlases.find((a) => a.id === def.atlas);
        if (atlas?.source.procedural !== PROCEDURAL_KIT) {
          console.warn(`[world] layer ${def.id}: only the procedural '${PROCEDURAL_KIT}' atlas is supported in M1; skipped`);
          continue;
        }
        const prepared = prepareKitLayer(def, kit, W, H, clearings);
        const uniforms = createKitLayerUniforms(prepared.params);
        const coreShader = createKitShader(texture.source, uniforms, KIT_MODE.Core);
        const bandShader = createKitShader(texture.source, uniforms, KIT_MODE.Band);
        const chunks: ChunkRuntime[] = [];
        for (let c = 0; c < prepared.chunks.length; c++) {
          const ch = prepared.chunks[c] as (typeof prepared.chunks)[number];
          const meshes: WorldMesh[] = [];
          let area = 0;
          for (const m of ch.core) {
            meshes.push(core.addChild(new Mesh({ geometry: createKitGeometry(m, `${def.id}:${c}:core`), shader: coreShader, state: coreState })));
            area += m.area;
          }
          for (const m of ch.band) {
            meshes.push(band.addChild(new Mesh({
              geometry: createKitGeometry(m, `${def.id}:${c}:band`), shader: bandShader, state: depthTested ? bandState : fgState,
            })));
            area += m.area;
          }
          chunks.push({ bounds: ch.bounds, meshes, area, visible: true });
        }
        this.layers.push({
          def, fx, fy, containers, chunks, plate: null, uniforms, shaders: [coreShader, bandShader],
          sways: prepared.swayAmp > 0, active: true,
        });
      } else {
        const support = await detectTextureSupport(ctx.renderer);
        const uniforms = createKitLayerUniforms(plateShadeParams(def));
        const plate = new PlateLayer(def, {
          coreParent: core, bandParent: band, coreState, bandState: depthTested ? bandState : fgState, uniforms,
          baseUrl: ctx.manifestUrl, support, budget: ctx.textures,
          budgetBytes: Math.max(0, ctx.textures.budgetBytes - this.plateReserve), margin: 480,
        });
        this.layers.push({ def, fx, fy, containers, chunks: [], plate, uniforms, shaders: [], sways: false, active: true });
      }
    }
```

## 7. Blend-only decor and additive glow twins

This is from `src/render/fx/decor.ts`. The twin set is the same instances filtered by `emissiveOnly`, drawn with
`KIT_MODE.Glow` into the glow buffer with `mesh.blendMode = 'add'`. Never set `state.blendMode`, because MeshPipe overwrites it.

`src/render/fx/decor.ts` lines 106–133:

```ts
    this.sceneU = createKitLayerUniforms(DECOR_SHADE);
    this.glowU = createKitLayerUniforms({ ...DECOR_SHADE, glow: DECOR_GLOW });
    const sceneShader = createKitShader(texture.source, this.sceneU, KIT_MODE.Band);
    const glowShader = createKitShader(texture.source, this.glowU, KIT_MODE.Glow);
    this.shaders.push(sceneShader, glowShader);

    const glowOf = (inst: KitInstance): number => (inst as DecorInstance).glow;
    const build = (list: readonly KitInstance[], emissiveOnly: boolean): ChunkMeshes[] => buildChunks(list, {
      split: false, depthF: null, glow: glowOf, chunkWidth: DECOR_CHUNK, originX: -DECOR_CHUNK / 2, swayAmp: DECOR_SWAY,
      atlasW: kit.width, atlasH: kit.height, emissiveOnly,
    });
    const addChunks = (sets: ChunkMeshes[], parent: Container, shader: Shader, additive: boolean, label: string): void => {
      for (let c = 0; c < sets.length; c++) {
        const set = sets[c] as ChunkMeshes;
        const meshes: WorldMesh[] = [];
        let area = 0;
        for (const m of set.band) {
          const mesh = new Mesh({ geometry: createKitGeometry(m, `${label}:${c}`), shader });
          if (additive) mesh.blendMode = 'add';
          meshes.push(parent.addChild(mesh));
          area += m.area;
        }
        this.chunks.push({ bounds: set.bounds, meshes, area: additive ? 0 : area, visible: true });
      }
    };
    addChunks(build(placement.back, false), this.back, sceneShader, false, 'decor-back');
    addChunks(build(placement.front, false), this.front, sceneShader, false, 'decor-front');
    addChunks(build([...placement.back, ...placement.front], true), this.glow, glowShader, true, 'decor-glow');
```

