import { Container, Mesh, State, type Shader } from 'pixi.js';
import type { KitLayerDef, LayerDef, PlateLayerDef } from '../../contracts/assets.ts';
import type { QualityLevel, QualitySettings } from '../../contracts/quality.ts';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import { detectTextureSupport } from '../../assets/textures.ts';
import { applyParallax, depthForParallax, visibleLayerRect, type Extent } from '../util/camera.ts';
import { createOpaqueState, createTransparentState } from '../util/states.ts';
import { PROCEDURAL_KIT, type WorldAssets } from './assets.ts';
import { createKitGeometry, type WorldMesh } from './geometry.ts';
import { createKitLayerUniforms, createKitShader, type KitLayerUniforms } from './kitShader.ts';
import { KIT_MODE } from './kitShading.ts';
import { meetsQuality, plateShadeParams, prepareKitLayer } from './layerModel.ts';
import { PlateLayer } from './plates.ts';

interface ChunkRuntime {
  bounds: Extent;
  meshes: WorldMesh[];
  /** Sum of rect areas (layer units²) of every mesh in the chunk. */
  area: number;
  visible: boolean;
}

interface LayerRuntime {
  def: KitLayerDef | PlateLayerDef;
  fx: number;
  fy: number;
  containers: Container[];
  chunks: ChunkRuntime[];
  plate: PlateLayer | null;
  uniforms: KitLayerUniforms;
  shaders: Shader[];
  sways: boolean;
  active: boolean;
}

/**
 * Which kit/plate layers draw at a quality level: those whose minQuality the level meets, then the
 * farthest are dropped until at most `budget` remain (ARCHITECTURE.md §5.7). Pure.
 */
export function selectLayers(layers: readonly LayerDef[], level: QualityLevel, budget: number): Set<string> {
  const eligible = layers.filter((l) => (l.kind === 'kit' || l.kind === 'plate') && meetsQuality(level, l.minQuality));
  eligible.sort((a, b) => b.parallax[0] - a.parallax[0]);
  return new Set(eligible.slice(0, Math.max(0, budget)).map((l) => l.id));
}

/**
 * The parallax stack (ARCHITECTURE.md §2.3–2.4, §5.5): kit and plate layers far → near. Depth-tested
 * layers (fx ≤ 1) draw opaque cores in slot `opaque` and soft bands in `background`; foreground
 * layers (fx > 1) draw blended in `foreground`. Per frame: parallax transforms, chunk culling
 * (visibility toggled only on enter/leave), sway time, plate streaming and fill estimates.
 */
export class ParallaxStackView implements RenderView {
  readonly name = 'parallax-stack';
  private readonly assets: WorldAssets;
  private ctx: RenderContext | null = null;
  private readonly layers: LayerRuntime[] = [];
  private readonly roots: Container[] = [];
  private readonly vis: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private plateReserve = 0;

  constructor(assets: WorldAssets) {
    this.assets = assets;
  }

  async init(ctx: RenderContext): Promise<void> {
    this.ctx = ctx;
    const defs = ctx.manifest.layers.filter((l): l is KitLayerDef | PlateLayerDef => l.kind === 'kit' || l.kind === 'plate');
    const opaqueRoot = new Container({ label: 'parallax-cores', sortableChildren: true });
    const bandRoot = new Container({ label: 'parallax-bands', sortableChildren: true });
    const fgRoot = new Container({ label: 'parallax-foreground' });
    let near = 1;
    let far = 0;
    for (const d of defs) {
      if (d.parallax[0] > 1) continue;
      near = Math.min(near, depthForParallax(d.parallax[0]));
      far = Math.max(far, depthForParallax(d.parallax[0]));
    }
    opaqueRoot.zIndex = Math.round(near * 1e6);
    bandRoot.zIndex = -Math.round(far * 1e6);
    ctx.scene.opaque.addChild(opaqueRoot);
    ctx.scene.background.addChild(bandRoot);
    ctx.scene.foreground.addChild(fgRoot);
    this.roots.push(opaqueRoot, bandRoot, fgRoot);

    await this.assets.ready;
    const kit = this.assets.kit;
    const texture = this.assets.kitTexture;
    if (!kit || !texture) throw new Error('ParallaxStackView: kit atlas missing');
    const { pxWidth: W, pxHeight: H } = ctx.level;
    this.plateReserve = ctx.textures.totalBytes;
    const coreState = createOpaqueState();
    const bandState = createTransparentState();
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
        const prepared = prepareKitLayer(def, kit, W, H);
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
    this.onQualityChanged(ctx.quality);
  }

  update(frame: FrameInfo): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const cam = frame.camera;
    const vis = this.vis;
    const time = frame.time % 3600;
    let fill = 0;
    for (let l = 0; l < this.layers.length; l++) {
      const rt = this.layers[l] as LayerRuntime;
      if (!rt.active) continue;
      for (let c = 0; c < rt.containers.length; c++) applyParallax(rt.containers[c] as Container, cam, rt.fx, rt.fy);
      visibleLayerRect(cam, rt.fx, rt.fy, vis);
      const visArea = Math.max(1, (vis.x1 - vis.x0) * (vis.y1 - vis.y0));
      for (let c = 0; c < rt.chunks.length; c++) {
        const ch = rt.chunks[c] as ChunkRuntime;
        const b = ch.bounds;
        const w = Math.min(b.x1, vis.x1) - Math.max(b.x0, vis.x0);
        const h = Math.min(b.y1, vis.y1) - Math.max(b.y0, vis.y0);
        const show = w > -2 && h > -2;
        if (show !== ch.visible) {
          ch.visible = show;
          for (let m = 0; m < ch.meshes.length; m++) (ch.meshes[m] as WorldMesh).visible = show;
        }
        if (show && w > 0 && h > 0) fill += (ch.area * (w * h)) / Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0)) / visArea;
      }
      if (rt.plate) {
        rt.plate.update(vis, frame.frame);
        fill += rt.plate.visibleArea(vis) / visArea;
      }
      if (rt.sways) rt.uniforms.uniforms.uTime = time;
    }
    ctx.stats.fillScreens += fill;
  }

  onQualityChanged(q: QualitySettings): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const on = selectLayers(ctx.manifest.layers, q.level, q.layerBudget);
    for (const rt of this.layers) {
      rt.active = on.has(rt.def.id);
      for (const c of rt.containers) c.visible = rt.active;
      rt.uniforms.uniforms.uSway = rt.sways && q.foliageSway ? 1 : 0;
      rt.plate?.setBudget(Math.max(0, ctx.textures.budgetBytes - this.plateReserve));
    }
  }

  destroy(): void {
    for (const rt of this.layers) {
      rt.plate?.destroy();
      for (const ch of rt.chunks) for (const m of ch.meshes) m.geometry.destroy(true);
      for (const s of rt.shaders) s.destroy();
    }
    for (const r of this.roots) r.destroy({ children: true });
    this.layers.length = 0;
    this.roots.length = 0;
    this.ctx = null;
  }
}
