import { Container, Mesh, Particle, type ParticleContainer, type Shader, type Texture } from 'pixi.js';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import type { WorldAssets } from '../layers/assets.ts';
import { createKitGeometry, type WorldMesh } from '../layers/geometry.ts';
import { buildChunks, type ChunkMeshes } from '../layers/kitMesh.ts';
import { createKitLayerUniforms, createKitShader, type KitLayerUniforms } from '../layers/kitShader.ts';
import { KIT_MODE, KIT_RIM_COLOR, type KitShadeParams } from '../layers/kitShading.ts';
import type { KitInstance } from '../layers/placement.ts';
import type { Extent } from '../util/camera.ts';
import { placeDecor, type DecorHalo, type DecorInstance } from './decorPlacement.ts';
import { fixedParticleContainer } from './particlePool.ts';

/** Gameplay-plane decor: dark teal silhouettes with moonlit rims and full-strength emissive parts. */
export const DECOR_SHADE: KitShadeParams = {
  tint: [0.05, 0.095, 0.115],
  fogColor: [0, 0, 0],
  fog: 0,
  desaturate: 0,
  rim: 0.75,
  rimColor: KIT_RIM_COLOR,
  glow: 1,
  mistY: 0,
  mistDepth: 1,
  mist: 0,
};
/** Sway amplitude for decor (u per 100 u of element height). */
const DECOR_SWAY = 5;
/** Decor chunk width (u): full-height columns. */
const DECOR_CHUNK = 1536;
/** Emissive strength of the glow twins. */
const DECOR_GLOW = 0.9;

interface ChunkRuntime {
  bounds: Extent;
  meshes: WorldMesh[];
  area: number;
  visible: boolean;
}

export interface HaloRuntime {
  def: DecorHalo;
  particle: Particle;
}

/**
 * Additive light pools (lanterns, big flora) as one ParticleContainer on the particle atlas' soft dot.
 * Only colour (the flicker) streams per frame; positions and sizes are static attributes.
 */
export function createHaloContainer(halos: readonly DecorHalo[], dot: Texture, out: HaloRuntime[]): ParticleContainer<Particle> {
  const particles: Particle[] = [];
  for (const def of halos) {
    const scale = (def.radius * 2) / dot.width;
    const p = new Particle({ texture: dot, x: def.x, y: def.y, scaleX: scale, scaleY: scale, anchorX: 0.5, anchorY: 0.5, tint: def.color, alpha: def.alpha });
    particles.push(p);
    out.push({ def, particle: p });
  }
  const pc = fixedParticleContainer({ texture: dot, particles, dynamicProperties: { position: false, vertex: false, rotation: false, uvs: false, color: true } });
  pc.blendMode = 'add';
  return pc;
}

/**
 * Decor (ARCHITECTURE.md §5.5): back decor (grass, flowers, mushrooms, tendrils, bridges, brambles,
 * flora, lanterns) in slot `terrain`, front grass/brambles in slot `front`, additive glow twins of the
 * emissive parts in glow slot `world`, and flickering light pools in slot `front`. Everything is
 * world space (the pipeline applies the camera); chunks are culled on enter/leave.
 */
export class DecorView implements RenderView {
  readonly name = 'decor';
  private readonly assets: WorldAssets;
  private ctx: RenderContext | null = null;
  private back: Container | null = null;
  private front: Container | null = null;
  private glow: Container | null = null;
  private lights: Container | null = null;
  private halos: ParticleContainer<Particle> | null = null;
  private readonly chunks: ChunkRuntime[] = [];
  private readonly haloList: HaloRuntime[] = [];
  private readonly shaders: Shader[] = [];
  private sceneU: KitLayerUniforms | null = null;
  private glowU: KitLayerUniforms | null = null;
  private readonly view: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };

  constructor(assets: WorldAssets) {
    this.assets = assets;
  }

  async init(ctx: RenderContext): Promise<void> {
    this.ctx = ctx;
    this.back = new Container({ label: 'decor-back' });
    this.front = new Container({ label: 'decor-front' });
    this.glow = new Container({ label: 'decor-glow' });
    const lights = new Container({ label: 'decor-lights' });
    this.lights = lights;
    ctx.scene.terrain.addChild(this.back);
    ctx.scene.front.addChild(this.front);
    ctx.scene.front.addChild(lights);
    ctx.glow.world.addChild(this.glow);

    await this.assets.ready;
    const kit = this.assets.kit;
    const texture = this.assets.kitTexture;
    const frames = this.assets.particleFrames;
    if (!kit || !texture || !frames) throw new Error('DecorView: world assets missing');
    const placement = placeDecor(ctx.level, kit);
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

    this.halos = createHaloContainer(placement.halos, frames.dot, this.haloList);
    lights.addChild(this.halos);
  }

  update(frame: FrameInfo): void {
    const ctx = this.ctx;
    if (!ctx || !this.sceneU || !this.glowU) return;
    const cam = frame.camera;
    const time = frame.time % 3600;
    const sway = frame.quality.foliageSway ? 1 : 0;
    this.sceneU.uniforms.uTime = time;
    this.sceneU.uniforms.uSway = sway;
    this.glowU.uniforms.uTime = time;
    this.glowU.uniforms.uSway = sway;
    const v = this.view;
    v.x0 = cam.left - 64 - Math.abs(cam.shakeX);
    v.x1 = cam.left + cam.width + 64 + Math.abs(cam.shakeX);
    v.y0 = cam.top - 64 - Math.abs(cam.shakeY);
    v.y1 = cam.top + cam.height + 64 + Math.abs(cam.shakeY);
    const viewArea = Math.max(1, cam.width * cam.height);
    let fill = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] as ChunkRuntime;
      const b = c.bounds;
      const w = Math.min(b.x1, v.x1) - Math.max(b.x0, v.x0);
      const h = Math.min(b.y1, v.y1) - Math.max(b.y0, v.y0);
      const show = w > 0 && h > 0;
      if (show !== c.visible) {
        c.visible = show;
        for (let m = 0; m < c.meshes.length; m++) (c.meshes[m] as WorldMesh).visible = show;
      }
      if (show) fill += (c.area * (w * h)) / Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0)) / viewArea;
    }
    for (let i = 0; i < this.haloList.length; i++) {
      const h = this.haloList[i] as HaloRuntime;
      const d = h.def;
      const f = 1 + d.flicker * (Math.sin(time * 2.1 + d.phase) * 0.6 + Math.sin(time * 5.3 + d.phase * 1.7) * 0.4);
      h.particle.alpha = d.alpha * f;
      if (d.x + d.radius > v.x0 && d.x - d.radius < v.x1 && d.y + d.radius > v.y0 && d.y - d.radius < v.y1) {
        fill += (Math.PI * d.radius * d.radius * 0.5) / viewArea;
      }
    }
    ctx.stats.fillScreens += fill;
  }

  destroy(): void {
    for (const c of this.chunks) for (const m of c.meshes) m.geometry.destroy(true);
    for (const s of this.shaders) s.destroy();
    this.back?.destroy({ children: true });
    this.front?.destroy({ children: true });
    this.lights?.destroy({ children: true });
    this.glow?.destroy({ children: true });
    this.chunks.length = 0;
    this.haloList.length = 0;
    this.shaders.length = 0;
    this.ctx = null;
  }
}
