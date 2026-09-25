import { Container, Mesh, State, type Shader } from 'pixi.js';
import type { KitLayerDef, LayerDef, LayerManifest, PlateLayerDef } from '../../contracts/assets.ts';
import type { QualityLevel, QualitySettings } from '../../contracts/quality.ts';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import { registerPlateHotReload, type PlateHotTarget } from '../../assets/hotReload.ts';
import { detectTextureSupport, type TextureFormatSupport } from '../../assets/textures.ts';
import { applyParallax, depthForParallax, visibleLayerRect, type Extent } from '../util/camera.ts';
import { createOpaqueState, createTransparentState } from '../util/states.ts';
import { PROCEDURAL_KIT, type WorldAssets } from './assets.ts';
import { createKitGeometry, type WorldMesh } from './geometry.ts';
import { createKitLayerUniforms, createKitShader, type KitLayerUniforms } from './kitShader.ts';
import { KIT_MODE, type KitShadeParams } from './kitShading.ts';
import { clearingHints, meetsQuality, plateShadeParams, prepareKitLayer } from './layerModel.ts';
import { PlateLayer, PlateStreaming } from './plates.ts';

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
  /** A base layer drawn because the plate that replaced it failed: that plate's id. */
  standsFor: string | null;
}

/**
 * Which kit layers draw at a quality level: those whose minQuality the level meets, then the farthest
 * are dropped until at most `budget` remain (ARCHITECTURE.md §5.7). Plate layers never count: they are
 * gated by minQuality alone (selectPlates). Pure.
 */
export function selectLayers(layers: readonly LayerDef[], level: QualityLevel, budget: number): Set<string> {
  const eligible = layers.filter((l) => l.kind === 'kit' && meetsQuality(level, l.minQuality));
  eligible.sort((a, b) => b.parallax[0] - a.parallax[0]);
  return new Set(eligible.slice(0, Math.max(0, budget)).map((l) => l.id));
}

/** Plate layers drawn at a quality level: every one whose minQuality the level meets (§5.8). Pure. */
export function selectPlates(layers: readonly LayerDef[], level: QualityLevel): Set<string> {
  return new Set(layers.filter((l) => l.kind === 'plate' && meetsQuality(level, l.minQuality)).map((l) => l.id));
}

function writeShade(u: KitLayerUniforms, p: KitShadeParams): void {
  const g = u.uniforms;
  g.uTint.set(p.tint);
  g.uFogColor.set(p.fogColor);
  g.uMistColor.set(p.mistColor ?? p.fogColor);
  g.uRimColor.set(p.rimColor);
  g.uFog = p.fog;
  g.uDesat = p.desaturate;
  g.uRim = p.rim;
  g.uGlow = p.glow;
  g.uMistY = p.mistY;
  g.uMistDepth = p.mistDepth;
  g.uMist = p.mist;
}

/**
 * The parallax stack (ARCHITECTURE.md §2.3–2.4, §5.5, §5.8): kit and plate layers far → near.
 * Depth-tested layers (fx ≤ 1) draw opaque cores in slot `opaque` and soft bands in `background`;
 * foreground layers (fx > 1) draw blended in `foreground`. Per frame: parallax transforms, chunk culling
 * (visibility toggled only on enter/leave), sway time, plate streaming through one shared streamer and
 * fill estimates. A plate layer that fails to load is replaced by the base layer it replaced; in dev,
 * a repainted plate reloads in place (src/assets/hotReload.ts).
 */
export class ParallaxStackView implements RenderView, PlateHotTarget {
  readonly name = 'parallax-stack';
  private readonly assets: WorldAssets;
  private ctx: RenderContext | null = null;
  private readonly layers: LayerRuntime[] = [];
  private readonly roots: Container[] = [];
  private readonly vis: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /** The stack's own copy of the manifest (hot reload updates it; failure fallbacks don't). */
  private manifest: LayerManifest | null = null;
  private streaming: PlateStreaming | null = null;
  private support: TextureFormatSupport = { ktx2: false, webp: true };
  private coreState: State | null = null;
  private bandState: State | null = null;
  private fgState: State | null = null;
  private clearings: number[] = [];
  private unregisterHot: (() => void) | null = null;

  constructor(assets: WorldAssets) {
    this.assets = assets;
  }

  get manifestUrl(): string {
    return this.ctx?.manifestUrl ?? '';
  }

  currentManifest(): LayerManifest {
    if (!this.manifest) throw new Error('ParallaxStackView: not initialised');
    return this.manifest;
  }

  async init(ctx: RenderContext): Promise<void> {
    this.ctx = ctx;
    this.manifest = { ...ctx.manifest, layers: [...ctx.manifest.layers] };
    const defs = ctx.manifest.layers.filter((l): l is KitLayerDef | PlateLayerDef => l.kind === 'kit' || l.kind === 'plate');
    const replaced = Object.values(ctx.manifest.replaced ?? {});
    const opaqueRoot = new Container({ label: 'parallax-cores', sortableChildren: true });
    const bandRoot = new Container({ label: 'parallax-bands', sortableChildren: true });
    // Foreground layers draw far → near by zIndex, so a layer added later (a restored base layer, a
    // hot-reloaded plate) still lands in its place.
    const fgRoot = new Container({ label: 'parallax-foreground', sortableChildren: true });
    let near = 1;
    let far = 0;
    for (const d of [...defs, ...replaced]) {
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
    if (!this.assets.kit || !this.assets.kitTexture) throw new Error('ParallaxStackView: kit atlas missing');
    this.coreState = createOpaqueState();
    this.bandState = createTransparentState();
    this.fgState = State.for2d();
    this.clearings = clearingHints(ctx.level);
    this.streaming = new PlateStreaming(ctx.textures);
    if ([...defs, ...replaced].some((d) => d.kind === 'plate')) this.support = await detectTextureSupport(ctx.renderer);
    for (const def of defs) this.addLayer(def, null);
    this.unregisterHot = registerPlateHotReload(this);
    this.onQualityChanged(ctx.quality);
  }

  /** Build one kit or plate layer into the stack (its core and band containers ordered by depth). */
  private addLayer(def: KitLayerDef | PlateLayerDef, standsFor: string | null): LayerRuntime | null {
    const ctx = this.ctx;
    const [opaqueRoot, bandRoot, fgRoot] = this.roots as [Container, Container, Container];
    const kit = this.assets.kit;
    const texture = this.assets.kitTexture;
    const coreState = this.coreState;
    const bandState = this.bandState;
    const fgState = this.fgState;
    if (!ctx || !kit || !texture || !coreState || !bandState || !fgState || !this.streaming) return null;
    const fx = def.parallax[0];
    const fy = def.parallax[1];
    const depthTested = fx <= 1;
    const z = Math.round(depthForParallax(fx) * 1e6);
    const core = new Container({ label: `${def.id}:core`, zIndex: z });
    // Depth-tested bands draw far → near (−depth); foreground bands by fx (nearer = larger fx = later).
    const band = new Container({ label: `${def.id}:band`, zIndex: depthTested ? -z : Math.round(fx * 1e6) });
    const containers = depthTested ? [core, band] : [band];
    let rt: LayerRuntime;
    if (def.kind === 'kit') {
      const atlas = ctx.manifest.atlases.find((a) => a.id === def.atlas);
      if (atlas?.source.procedural !== PROCEDURAL_KIT) {
        console.warn(`[world] layer ${def.id}: only the procedural '${PROCEDURAL_KIT}' atlas is supported; skipped`);
        return null;
      }
      const { pxWidth: W, pxHeight: H } = ctx.level;
      const prepared = prepareKitLayer(def, kit, W, H, this.clearings);
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
      rt = {
        def, fx, fy, containers, chunks, plate: null, uniforms, shaders: [coreShader, bandShader],
        sways: prepared.swayAmp > 0, active: true, standsFor,
      };
    } else {
      const uniforms = createKitLayerUniforms(plateShadeParams(def));
      // Foreground plates (fx > 1) have no depth pass: their cores draw blended in the band container.
      const plate = new PlateLayer(def, {
        coreParent: depthTested ? core : band, bandParent: band, coreState: depthTested ? coreState : fgState,
        bandState: depthTested ? bandState : fgState, uniforms, baseUrl: ctx.manifestUrl, support: this.support,
      });
      plate.onFail = (p) => this.onPlateFailed(p);
      this.streaming.add(plate);
      rt = { def, fx, fy, containers, chunks: [], plate, uniforms, shaders: [], sways: false, active: true, standsFor };
    }
    if (depthTested) {
      opaqueRoot.addChild(core);
      bandRoot.addChild(band);
    } else {
      fgRoot.addChild(band);
      core.destroy();
    }
    this.layers.push(rt);
    return rt;
  }

  private removeLayer(rt: LayerRuntime): void {
    if (rt.plate) {
      this.streaming?.remove(rt.plate);
      rt.plate.destroy();
    }
    for (const ch of rt.chunks) for (const m of ch.meshes) m.geometry.destroy(true);
    for (const s of rt.shaders) s.destroy();
    for (const c of rt.containers) c.destroy({ children: true });
    const i = this.layers.indexOf(rt);
    if (i >= 0) this.layers.splice(i, 1);
  }

  /** A plate failed for good: drop it and draw the base layer it replaced, if any (§5.8). */
  private onPlateFailed(plate: PlateLayer): void {
    const rt = this.layers.find((l) => l.plate === plate);
    if (!rt || !this.ctx) return;
    this.removeLayer(rt);
    const base = this.manifest?.replaced?.[plate.id];
    if (base && (base.kind === 'kit' || base.kind === 'plate')) {
      console.warn(`[plates] ${plate.id}: drawing the base layer ${base.id} it replaced instead`);
      this.addLayer(base, plate.id);
    }
    this.onQualityChanged(this.ctx.quality);
  }

  /** The layers the stack holds (tests, debug): a failed plate shows as the base layer standing for it. */
  describeLayers(): { id: string; kind: 'kit' | 'plate'; active: boolean; standsFor: string | null }[] {
    return this.layers.map((rt) => ({ id: rt.def.id, kind: rt.def.kind, active: rt.active, standsFor: rt.standsFor }));
  }

  /** Hot reload (PlateHotTarget): evict, rebuild the meshes and re-stream one plate layer. */
  reloadPlate(def: PlateLayerDef, manifest: LayerManifest): boolean {
    const ctx = this.ctx;
    if (!ctx || !this.manifest || !this.manifest.layers.some((l) => l.id === def.id && l.kind === 'plate')) return false;
    // A failed plate stands replaced by its base layer: take that out and build the plate again.
    const stand = this.layers.find((l) => l.standsFor === def.id);
    if (stand) this.removeLayer(stand);
    const rt = this.layers.find((l) => l.plate !== null && l.def.id === def.id);
    if (rt?.plate) {
      rt.plate.reload(def);
      rt.def = def;
      writeShade(rt.uniforms, plateShadeParams(def));
    } else if (!this.addLayer(def, null)) {
      return false;
    }
    this.manifest = { ...manifest, layers: [...manifest.layers] };
    this.onQualityChanged(ctx.quality);
    return true;
  }

  update(frame: FrameInfo): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const cam = frame.camera;
    const vis = this.vis;
    const time = frame.worldTime % 3600;
    const streaming = this.streaming;
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
      if (rt.plate && streaming) streaming.setVisible(rt.plate, vis, frame.frame);
      if (rt.sways) rt.uniforms.uniforms.uTime = time;
    }
    if (streaming) {
      streaming.pump();
      for (let l = 0; l < this.layers.length; l++) {
        const rt = this.layers[l] as LayerRuntime;
        if (!rt.active || !rt.plate) continue;
        visibleLayerRect(cam, rt.fx, rt.fy, vis);
        fill += rt.plate.visibleArea(vis) / Math.max(1, (vis.x1 - vis.x0) * (vis.y1 - vis.y0));
      }
    }
    ctx.stats.fillScreens += fill;
  }

  onQualityChanged(q: QualitySettings): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const defs = this.layers.map((rt) => rt.def);
    const kits = selectLayers(defs, q.level, q.layerBudget);
    const plates = selectPlates(defs, q.level);
    for (const rt of this.layers) {
      rt.active = kits.has(rt.def.id) || plates.has(rt.def.id);
      for (const c of rt.containers) c.visible = rt.active;
      rt.uniforms.uniforms.uSway = rt.sways && q.foliageSway ? 1 : 0;
      // An inactive plate wants nothing; the shared LRU evicts its chunks when the budget needs room.
      if (rt.plate && !rt.active) this.streaming?.setVisible(rt.plate, null, 0);
    }
  }

  destroy(): void {
    this.unregisterHot?.();
    this.unregisterHot = null;
    for (const rt of this.layers) {
      rt.plate?.destroy();
      for (const ch of rt.chunks) for (const m of ch.meshes) m.geometry.destroy(true);
      for (const s of rt.shaders) s.destroy();
    }
    this.streaming?.destroy();
    this.streaming = null;
    for (const r of this.roots) r.destroy({ children: true });
    this.layers.length = 0;
    this.roots.length = 0;
    this.ctx = null;
    this.manifest = null;
  }
}
