import {
  CLEAR, Container, Geometry, GlProgram, Matrix, Mesh, Rectangle, RenderTarget, Shader, State, Texture, TextureSource,
  UniformGroup, type RenderOptions, type TEXTURE_FORMATS, type WebGLRenderer,
} from 'pixi.js';
import type { GradeParams } from '../../contracts/render.ts';
import {
  BLOOM_DOWN_FRAGMENT, BLOOM_UP_FRAGMENT, COMPOSITE_FRAGMENT, FULLSCREEN_VERTEX,
} from './post.glsl.ts';
import { createTargetLayout, layoutSubRects, layoutTargets, MAX_BLOOM_PASSES, type TargetLayout } from './viewport.ts';

/** Render options with the sub-rect `frame` RenderTargetSystem.bind honours (missing from Pixi's type). */
export interface PassOptions extends RenderOptions {
  frame?: Rectangle;
}

interface Target {
  source: TextureSource;
  texture: Texture;
  target: RenderTarget;
}

function createTarget(label: string, format: TEXTURE_FORMATS, depth: boolean): Target {
  const source = new TextureSource({
    width: 1, height: 1, resolution: 1, format, antialias: false, autoGenerateMipmaps: false,
    scaleMode: 'linear', addressMode: 'clamp-to-edge', label,
  });
  const texture = new Texture({ source, label });
  const target = new RenderTarget({ colorTextures: [texture], depth, stencil: false, label });
  return { source, texture, target };
}

function destroyTarget(t: Target): void {
  t.target.destroy();
  t.texture.destroy(false);
  t.source.destroy();
}

/** Blending off, no depth: passes that overwrite every pixel of their viewport. */
function opaqueState(): State {
  const s = new State();
  s.blend = false;
  s.depthTest = false;
  s.depthMask = false;
  return s;
}

/** One full-screen triangle drawn with its own shader into whatever viewport the pass binds. */
class FullscreenPass {
  readonly root = new Container({ label: 'post-pass' });
  readonly mesh: Mesh<Geometry, Shader>;
  readonly shader: Shader;
  readonly uniforms: UniformGroup;

  constructor(geometry: Geometry, program: GlProgram, textures: Record<string, TextureSource>, uniforms: UniformGroup, additive: boolean) {
    this.uniforms = uniforms;
    this.shader = new Shader({ glProgram: program, resources: { ...textures, uPass: uniforms } });
    this.mesh = new Mesh<Geometry, Shader>({ geometry, shader: this.shader, state: additive ? State.for2d() : opaqueState() });
    if (additive) this.mesh.blendMode = 'add';
    this.root.addChild(this.mesh);
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.shader.destroy(false);
  }
}

function passUniforms(): UniformGroup {
  return new UniformGroup({
    uSrcTexel: { value: new Float32Array(2), type: 'vec2<f32>' },
    uSrcScale: { value: new Float32Array(2), type: 'vec2<f32>' },
    uSrcMax: { value: new Float32Array(2), type: 'vec2<f32>' },
    uDither: { value: 0, type: 'f32' },
    uFlipY: { value: 0, type: 'f32' },
  });
}

function program(name: string, fragment: string): GlProgram {
  return GlProgram.from({ name, vertex: FULLSCREEN_VERTEX, fragment, preferredFragmentPrecision: 'highp' });
}

/**
 * Owns the scene target (RGBA8 + depth), the glow target and its dual-filter bloom chain, and the
 * composite pass. Targets are allocated at the maximum size (`allocate`, on resize / quality change);
 * dynamic resolution only moves the sub-rect frames (`setScale`). Every pass reuses a preallocated
 * render-options object.
 */
export class PostChain {
  readonly layout: TargetLayout = createTargetLayout();
  readonly scene: Target;
  readonly glowFormat: TEXTURE_FORMATS;
  readonly sceneFrame = new Rectangle();
  readonly chainFrames: Rectangle[] = [];
  readonly sceneOptions: PassOptions;
  readonly glowOptions: PassOptions;
  readonly compositeOptions: PassOptions;
  readonly compositeUniforms: UniformGroup;
  private readonly chain: Target[] = [];
  private readonly geometry: Geometry;
  private readonly downProgram: GlProgram;
  private readonly upProgram: GlProgram;
  private readonly down: FullscreenPass[] = [];
  private readonly up: FullscreenPass[] = [];
  private readonly downOptions: PassOptions[] = [];
  private readonly upOptions: PassOptions[] = [];
  private readonly composite: FullscreenPass;
  private passes = 0;

  constructor(renderer: WebGLRenderer, sceneRoot: Container, glowRoot: Container, sceneClear: number[]) {
    this.glowFormat = renderer.context.extensions.colorBufferFloat ? 'rgba16float' : 'rgba8unorm';
    this.scene = createTarget('scene', 'rgba8unorm', true);
    for (let k = 0; k <= MAX_BLOOM_PASSES; k++) {
      this.chain.push(createTarget(`glow${k}`, this.glowFormat, false));
      this.chainFrames.push(new Rectangle());
    }
    this.geometry = new Geometry({ attributes: { aPosition: { buffer: new Float32Array([0, 0, 2, 0, 0, 2]), format: 'float32x2' } } });
    this.downProgram = program('sw-bloom-down', BLOOM_DOWN_FRAGMENT);
    this.upProgram = program('sw-bloom-up', BLOOM_UP_FRAGMENT);
    for (let k = 1; k <= MAX_BLOOM_PASSES; k++) {
      const d = new FullscreenPass(this.geometry, this.downProgram, { uSource: (this.chain[k - 1] as Target).source }, passUniforms(), false);
      this.down.push(d);
      this.downOptions.push({ container: d.root, target: (this.chain[k] as Target).target, clear: CLEAR.NONE, frame: this.chainFrames[k] as Rectangle });
    }
    for (let k = 0; k < MAX_BLOOM_PASSES; k++) {
      const u = new FullscreenPass(this.geometry, this.upProgram, { uSource: (this.chain[k + 1] as Target).source }, passUniforms(), true);
      this.up.push(u);
      this.upOptions.push({ container: u.root, target: (this.chain[k] as Target).target, clear: CLEAR.NONE, frame: this.chainFrames[k] as Rectangle });
    }
    this.compositeUniforms = new UniformGroup({
      uSceneUv: { value: new Float32Array(4), type: 'vec4<f32>' },
      uBloomUv: { value: new Float32Array(4), type: 'vec4<f32>' },
      uTexels: { value: new Float32Array(4), type: 'vec4<f32>' },
      uExposure: { value: 1, type: 'f32' },
      uContrast: { value: 1, type: 'f32' },
      uSaturation: { value: 1, type: 'f32' },
      uTemperature: { value: 0, type: 'f32' },
      uVignette: { value: 0, type: 'f32' },
      uBloomIntensity: { value: 0, type: 'f32' },
      uFade: { value: 0, type: 'f32' },
      uAspect: { value: 16 / 9, type: 'f32' },
      uLift: { value: new Float32Array(3), type: 'vec3<f32>' },
      uGamma: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
      uGain: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
      uFog: { value: new Float32Array(3), type: 'vec3<f32>' },
      uFlipY: { value: 1, type: 'f32' },
    });
    this.composite = new FullscreenPass(
      this.geometry, program('sw-composite', COMPOSITE_FRAGMENT),
      { uScene: this.scene.source, uBloom: (this.chain[0] as Target).source }, this.compositeUniforms, false,
    );
    this.sceneOptions = { container: sceneRoot, target: this.scene.target, clear: CLEAR.ALL, clearColor: sceneClear, frame: this.sceneFrame };
    this.glowOptions = { container: glowRoot, target: (this.chain[0] as Target).target, clear: CLEAR.COLOR, clearColor: [0, 0, 0, 0], frame: this.chainFrames[0] as Rectangle };
    this.compositeOptions = { container: this.composite.root, clear: CLEAR.NONE };
  }

  /** Glow target options for drawing other content (e.g. the foreground occluders) over the twins. */
  glowOverlayOptions(container: Container, transform: Matrix): PassOptions {
    return { container, target: (this.chain[0] as Target).target, clear: CLEAR.NONE, frame: this.chainFrames[0] as Rectangle, transform };
  }

  /** (Re)size the targets for a canvas of `pixelWidth × pixelHeight` at most `maxScale`. */
  allocate(pixelWidth: number, pixelHeight: number, maxScale: number, bloomScale: number, passes: number): void {
    const l = layoutTargets(this.layout, pixelWidth, pixelHeight, maxScale, bloomScale, passes);
    this.passes = l.passes;
    this.scene.source.resize(l.sceneAllocW, l.sceneAllocH, 1);
    for (let k = 0; k <= MAX_BLOOM_PASSES; k++) {
      const used = k <= l.passes;
      (this.chain[k] as Target).source.resize(used ? (l.allocW[k] as number) : 1, used ? (l.allocH[k] as number) : 1, 1);
    }
  }

  /** Move the sub-rects for render scale `scale` and refresh every pass's sampling uniforms. */
  setScale(pixelWidth: number, pixelHeight: number, scale: number, bloomScale: number): void {
    const l = layoutSubRects(this.layout, pixelWidth, pixelHeight, scale, bloomScale);
    this.sceneFrame.x = 0;
    this.sceneFrame.y = 0;
    this.sceneFrame.width = l.sceneW;
    this.sceneFrame.height = l.sceneH;
    for (let k = 0; k <= MAX_BLOOM_PASSES; k++) {
      const f = this.chainFrames[k] as Rectangle;
      f.x = 0;
      f.y = 0;
      f.width = l.subW[k] as number;
      f.height = l.subH[k] as number;
    }
    for (let k = 1; k <= MAX_BLOOM_PASSES; k++) this.sourceUniforms((this.down[k - 1] as FullscreenPass).uniforms, k - 1);
    for (let k = 0; k < MAX_BLOOM_PASSES; k++) this.sourceUniforms((this.up[k] as FullscreenPass).uniforms, k + 1);
    const u = this.compositeUniforms.uniforms;
    const sceneUv = u.uSceneUv as Float32Array;
    sceneUv[0] = l.sceneW / l.sceneAllocW;
    sceneUv[1] = l.sceneH / l.sceneAllocH;
    sceneUv[2] = (l.sceneW - 0.5) / l.sceneAllocW;
    sceneUv[3] = (l.sceneH - 0.5) / l.sceneAllocH;
    const bloomUv = u.uBloomUv as Float32Array;
    const bw = l.allocW[0] as number;
    const bh = l.allocH[0] as number;
    bloomUv[0] = (l.subW[0] as number) / bw;
    bloomUv[1] = (l.subH[0] as number) / bh;
    bloomUv[2] = ((l.subW[0] as number) - 0.5) / bw;
    bloomUv[3] = ((l.subH[0] as number) - 0.5) / bh;
    const texels = u.uTexels as Float32Array;
    texels[0] = 1 / l.sceneAllocW;
    texels[1] = 1 / l.sceneAllocH;
    texels[2] = 1 / bw;
    texels[3] = 1 / bh;
  }

  private sourceUniforms(g: UniformGroup, level: number): void {
    const l = this.layout;
    const aw = l.allocW[level] as number;
    const ah = l.allocH[level] as number;
    const sw = l.subW[level] as number;
    const sh = l.subH[level] as number;
    const u = g.uniforms;
    const texel = u.uSrcTexel as Float32Array;
    texel[0] = 1 / aw;
    texel[1] = 1 / ah;
    const scale = u.uSrcScale as Float32Array;
    scale[0] = sw / aw;
    scale[1] = sh / ah;
    const max = u.uSrcMax as Float32Array;
    max[0] = (sw - 0.5) / aw;
    max[1] = (sh - 0.5) / ah;
    u.uDither = level === 1 && this.glowFormat === 'rgba8unorm' ? 1 : 0;
  }

  /** Write this frame's grade, fade and aspect into the composite uniforms. */
  setGrade(g: GradeParams, fade: number, fog: readonly number[], aspect: number, bloom: boolean): void {
    const u = this.compositeUniforms.uniforms;
    u.uExposure = g.exposure;
    u.uContrast = g.contrast;
    u.uSaturation = g.saturation;
    u.uTemperature = g.temperature;
    u.uVignette = g.vignette;
    u.uBloomIntensity = bloom ? g.bloomIntensity / (this.passes + 1) : 0;
    u.uFade = fade;
    u.uAspect = aspect;
    const lift = u.uLift as Float32Array;
    const gamma = u.uGamma as Float32Array;
    const gain = u.uGain as Float32Array;
    const fogU = u.uFog as Float32Array;
    for (let i = 0; i < 3; i++) {
      lift[i] = g.lift[i] as number;
      gamma[i] = g.gamma[i] as number;
      gain[i] = g.gain[i] as number;
      fogU[i] = fog[i] as number;
    }
  }

  /** Bloom: ½-size downsamples, then additive upsamples back to the glow target. */
  renderBloom(renderer: WebGLRenderer): void {
    const p = this.passes;
    for (let k = 1; k <= p; k++) renderer.render(this.downOptions[k - 1] as PassOptions);
    for (let k = p - 1; k >= 0; k--) renderer.render(this.upOptions[k] as PassOptions);
  }

  get bloomPasses(): number {
    return this.passes;
  }

  /** Approximate GPU bytes of the render targets (for the report / overlay, not the texture budget). */
  get targetBytes(): number {
    const l = this.layout;
    let bytes = l.sceneAllocW * l.sceneAllocH * 8;
    const bpp = this.glowFormat === 'rgba16float' ? 8 : 4;
    for (let k = 0; k <= l.passes; k++) bytes += (l.allocW[k] as number) * (l.allocH[k] as number) * bpp;
    return bytes;
  }

  destroy(): void {
    for (const p of this.down) p.destroy();
    for (const p of this.up) p.destroy();
    this.composite.destroy();
    this.geometry.destroy();
    destroyTarget(this.scene);
    for (const t of this.chain) destroyTarget(t);
  }
}
