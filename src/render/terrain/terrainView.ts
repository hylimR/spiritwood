import { Container, GlProgram, Mesh, Shader, UniformGroup } from 'pixi.js';
import { DEPTH_TERRAIN } from '../../config.ts';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import { interleavedGeometry, type AttributeSpec, type WorldMesh } from '../layers/geometry.ts';
import { applyParallax, type Extent } from '../util/camera.ts';
import { createOpaqueState } from '../util/states.ts';
import {
  TERRAIN_CORE_FRAGMENT, TERRAIN_CORE_VERTEX, TERRAIN_EDGE_FRAGMENT, TERRAIN_EDGE_VERTEX,
} from './terrain.glsl.ts';
import { buildTerrainMesh, CORE_STRIDE_FLOATS, DEFAULT_TERRAIN, EDGE_STRIDE_FLOATS, type TerrainChunk } from './terrainMesh.ts';

export const TERRAIN_CORE_ATTRS: readonly AttributeSpec[] = [
  { name: 'aPosition', format: 'float32x2', offset: 0 },
  { name: 'aDist', format: 'float32', offset: 8 },
  { name: 'aLit', format: 'float32', offset: 12 },
  { name: 'aSpill', format: 'unorm8x4', offset: 16 },
  { name: 'aStroke', format: 'float32x2', offset: 20 },
];
export const TERRAIN_EDGE_ATTRS: readonly AttributeSpec[] = [
  { name: 'aPosition', format: 'float32x2', offset: 0 },
  { name: 'aNormal', format: 'float32x2', offset: 8 },
  { name: 'aEdge', format: 'float32x4', offset: 16 },
  { name: 'aSpill', format: 'unorm8x4', offset: 32 },
];
/** AA feather half-width in device pixels. */
export const AA_PX = 1.25;
/** The feather never exceeds this (u), even for a degenerate pxPerUnit (e.g. 0 before the first resize). */
export const AA_MAX_UNITS = 4;

/** AA feather half-width in world units for `pxPerUnit` scene pixels per view unit at camera `zoom`. */
export function terrainAAWidth(pxPerUnit: number, zoom: number): number {
  const pxPerWorld = pxPerUnit * zoom;
  if (!(pxPerWorld > 0)) return AA_MAX_UNITS;
  return Math.min(AA_MAX_UNITS, AA_PX / pxPerWorld);
}
/** Moss light strength in the glow twin. */
const MOSS_GLOW = 0.55;

function edgeUniforms(glowPass: boolean) {
  return new UniformGroup({
    uAA: { value: 1, type: 'f32' },
    uMossIn: { value: DEFAULT_TERRAIN.mossIn, type: 'f32' },
    uMossOut: { value: DEFAULT_TERRAIN.mossOut, type: 'f32' },
    uShadeDepth: { value: DEFAULT_TERRAIN.shadeDepth, type: 'f32' },
    uGlowPass: { value: glowPass ? 1 : 0, type: 'f32' },
    uGlow: { value: MOSS_GLOW, type: 'f32' },
  });
}

interface ChunkRuntime {
  data: TerrainChunk;
  meshes: WorldMesh[];
  visible: boolean;
}

/**
 * Terrain (ARCHITECTURE.md §5.5): opaque cores in slot `opaque` at DEPTH_TERRAIN (positioned with
 * applyParallax at f = 1, since parallax slots are view space), AA feather + moss rim strips in slot
 * `terrain`, and moss glow twins in glow slot `world`. Chunks are culled against the camera.
 */
export class TerrainView implements RenderView {
  readonly name = 'terrain';
  private ctx: RenderContext | null = null;
  private core: Container | null = null;
  private edges: Container | null = null;
  private glow: Container | null = null;
  private readonly chunks: ChunkRuntime[] = [];
  private readonly shaders: Shader[] = [];
  private edgeU: ReturnType<typeof edgeUniforms> | null = null;
  private glowU: ReturnType<typeof edgeUniforms> | null = null;
  private readonly view: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.core = new Container({ label: 'terrain-core', zIndex: Math.round(DEPTH_TERRAIN * 1e6) });
    this.edges = new Container({ label: 'terrain-edges' });
    this.glow = new Container({ label: 'terrain-moss-glow' });
    ctx.scene.opaque.addChild(this.core);
    ctx.scene.terrain.addChild(this.edges);
    ctx.glow.world.addChild(this.glow);

    const t0 = performance.now();
    const mesh = buildTerrainMesh(ctx.level);
    console.info(`[world] terrain: ${mesh.chunks.length} chunks, ${(performance.now() - t0).toFixed(0)} ms`);
    const coreProgram = GlProgram.from({
      vertex: TERRAIN_CORE_VERTEX, fragment: TERRAIN_CORE_FRAGMENT, name: 'sw-terrain-core', preferredFragmentPrecision: 'highp',
    });
    const edgeProgram = GlProgram.from({
      vertex: TERRAIN_EDGE_VERTEX, fragment: TERRAIN_EDGE_FRAGMENT, name: 'sw-terrain-edge', preferredFragmentPrecision: 'highp',
    });
    const coreShader = new Shader({
      glProgram: coreProgram,
      resources: { terrain: new UniformGroup({ uShadeDepth: { value: DEFAULT_TERRAIN.shadeDepth, type: 'f32' } }) },
    });
    this.edgeU = edgeUniforms(false);
    this.glowU = edgeUniforms(true);
    const edgeShader = new Shader({ glProgram: edgeProgram, resources: { edge: this.edgeU } });
    const glowShader = new Shader({ glProgram: edgeProgram, resources: { edge: this.glowU } });
    this.shaders.push(coreShader, edgeShader, glowShader);
    const opaque = createOpaqueState();

    for (const ch of mesh.chunks) {
      const meshes: WorldMesh[] = [];
      const label = `terrain:${ch.col},${ch.row}`;
      if (ch.coreIndices.length > 0) {
        const g = interleavedGeometry(ch.core, ch.coreIndices, CORE_STRIDE_FLOATS * 4, TERRAIN_CORE_ATTRS, `${label}:core`);
        meshes.push(this.core.addChild(new Mesh({ geometry: g, shader: coreShader, state: opaque })));
      }
      if (ch.edgeIndices.length > 0) {
        const g = interleavedGeometry(ch.edge, ch.edgeIndices, EDGE_STRIDE_FLOATS * 4, TERRAIN_EDGE_ATTRS, `${label}:edge`);
        meshes.push(this.edges.addChild(new Mesh({ geometry: g, shader: edgeShader })));
        if (ch.mossIndices.length > 0) {
          const shared = g.getBuffer('aPosition');
          const gm = interleavedGeometry(ch.edge, ch.mossIndices, EDGE_STRIDE_FLOATS * 4, TERRAIN_EDGE_ATTRS, `${label}:moss`, shared);
          const twin = new Mesh({ geometry: gm, shader: glowShader });
          twin.blendMode = 'add';
          meshes.push(this.glow.addChild(twin));
        }
      }
      this.chunks.push({ data: ch, meshes, visible: true });
    }
  }

  update(frame: FrameInfo): void {
    const ctx = this.ctx;
    if (!ctx || !this.core || !this.edgeU || !this.glowU) return;
    const cam = frame.camera;
    applyParallax(this.core, cam, 1, 1);
    const aa = terrainAAWidth(frame.pxPerUnit, cam.zoom);
    this.edgeU.uniforms.uAA = aa;
    this.glowU.uniforms.uAA = aa;
    const v = this.view;
    const pad = DEFAULT_TERRAIN.mossIn + 16;
    v.x0 = cam.left - pad - Math.abs(cam.shakeX);
    v.x1 = cam.left + cam.width + pad + Math.abs(cam.shakeX);
    v.y0 = cam.top - pad - Math.abs(cam.shakeY);
    v.y1 = cam.top + cam.height + pad + Math.abs(cam.shakeY);
    const viewArea = Math.max(1, cam.width * cam.height);
    let fill = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] as ChunkRuntime;
      const b = c.data.bounds;
      const w = Math.min(b.x1, v.x1) - Math.max(b.x0, v.x0);
      const h = Math.min(b.y1, v.y1) - Math.max(b.y0, v.y0);
      const show = w > 0 && h > 0;
      if (show !== c.visible) {
        c.visible = show;
        for (let m = 0; m < c.meshes.length; m++) (c.meshes[m] as WorldMesh).visible = show;
      }
      if (show) {
        const frac = (w * h) / Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0));
        fill += (c.data.coreArea + c.data.edgeLength * aa * 2 + c.data.mossArea) * frac / viewArea;
      }
    }
    ctx.stats.fillScreens += fill;
  }

  destroy(): void {
    // Moss twins share the edge vertex buffer: collect buffers once, then destroy.
    const buffers = new Set<{ destroy(): void }>();
    for (const c of this.chunks) {
      for (const m of c.meshes) {
        for (const b of m.geometry.buffers) buffers.add(b);
        m.geometry.destroy(false);
      }
    }
    for (const b of buffers) b.destroy();
    for (const s of this.shaders) s.destroy();
    this.core?.destroy({ children: true });
    this.edges?.destroy({ children: true });
    this.glow?.destroy({ children: true });
    this.chunks.length = 0;
    this.shaders.length = 0;
    this.ctx = null;
  }
}
