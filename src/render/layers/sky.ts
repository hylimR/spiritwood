import { Buffer, BufferUsage, Container, Geometry, GlProgram, Mesh, Shader, UniformGroup } from 'pixi.js';
import type { SkyLayerDef } from '../../contracts/assets.ts';
import type { RenderStats } from '../../contracts/debug.ts';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import { createSkyState } from '../util/states.ts';
import { SKY_FRAGMENT, SKY_VERTEX } from './sky.glsl.ts';
import { skyParams, SKY_STOPS } from './skyShading.ts';

/** Share of the screen the sky still shades after early-Z rejects opaque-covered pixels (typical view). */
const SKY_FILL_ESTIMATE = 0.6;

function createSkyUniforms(def: SkyLayerDef) {
  const p = skyParams(def);
  const stop = (i: number): Float32Array => p.stopColor.slice(i * 3, i * 3 + 3);
  return new UniformGroup({
    uViewSize: { value: new Float32Array([1920, 1080]), type: 'vec2<f32>' },
    uTime: { value: 0, type: 'f32' },
    uStopT: { value: p.stopT.slice(0, SKY_STOPS), type: 'vec4<f32>' },
    uStop0: { value: stop(0), type: 'vec3<f32>' },
    uStop1: { value: stop(1), type: 'vec3<f32>' },
    uStop2: { value: stop(2), type: 'vec3<f32>' },
    uStop3: { value: stop(3), type: 'vec3<f32>' },
    uMoon: { value: new Float32Array([0, 0, p.moonRadius, p.halo]), type: 'vec4<f32>' },
    uMoonColor: { value: new Float32Array(p.moonColor), type: 'vec3<f32>' },
    uStars: { value: p.starDensity, type: 'f32' },
  });
}

/**
 * Sky (slot `sky`): one full-screen quad in view space at DEPTH_SKY, drawn after the opaque pre-pass
 * with depth test on and no write, so it only shades pixels no opaque core covered.
 */
export class SkyView implements RenderView {
  readonly name = 'sky';
  private root: Container | null = null;
  private mesh: Mesh<Geometry, Shader> | null = null;
  private uniforms: ReturnType<typeof createSkyUniforms> | null = null;
  private positions: Buffer | null = null;
  private moonX = 0;
  private moonY = 0;
  private stats: RenderStats | null = null;

  init(ctx: RenderContext): void {
    this.root = new Container({ label: 'sky' });
    ctx.scene.sky.addChild(this.root);
    const def = ctx.manifest.layers.find((l): l is SkyLayerDef => l.kind === 'sky');
    if (!def) return;
    this.moonX = def.moon.x;
    this.moonY = def.moon.y;
    this.uniforms = createSkyUniforms(def);
    this.positions = new Buffer({ data: new Float32Array(8), usage: BufferUsage.VERTEX | BufferUsage.COPY_DST, label: 'sky-positions' });
    const geometry = new Geometry({
      attributes: { aPosition: { buffer: this.positions, format: 'float32x2', stride: 8, offset: 0 } },
      indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
    });
    const shader = new Shader({
      glProgram: GlProgram.from({ vertex: SKY_VERTEX, fragment: SKY_FRAGMENT, name: 'sw-sky', preferredFragmentPrecision: 'highp' }),
      resources: { sky: this.uniforms },
    });
    this.mesh = new Mesh({ geometry, shader, state: createSkyState() });
    this.root.addChild(this.mesh);
    this.onResize(1920, 1080);
    this.stats = ctx.stats;
  }

  onResize(viewW: number, viewH: number): void {
    if (!this.positions || !this.uniforms) return;
    const d = this.positions.data as Float32Array;
    d.set([0, 0, viewW, 0, viewW, viewH, 0, viewH]);
    this.positions.update();
    const u = this.uniforms.uniforms;
    u.uViewSize[0] = viewW;
    u.uViewSize[1] = viewH;
    u.uMoon[0] = this.moonX * viewW;
    u.uMoon[1] = this.moonY * viewH;
  }

  update(frame: FrameInfo): void {
    if (!this.uniforms || !this.stats) return;
    this.uniforms.uniforms.uTime = frame.time % 3600;
    this.stats.fillScreens += SKY_FILL_ESTIMATE;
  }

  destroy(): void {
    this.mesh?.geometry.destroy(true);
    this.mesh?.shader?.destroy();
    this.root?.destroy({ children: true });
    this.root = null;
    this.mesh = null;
  }
}
