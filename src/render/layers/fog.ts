import { Container, Geometry, GlProgram, Mesh, Shader, UniformGroup } from 'pixi.js';
import type { FogLayerDef } from '../../contracts/assets.ts';
import type { QualityLevel, QualitySettings } from '../../contracts/quality.ts';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import { hexToRgb, parseHexColor } from '../../core/color.ts';
import { GLSL_DITHER, GLSL_FRAGMENT_HEADER, GLSL_NOISE, GLSL_VERSION, GLSL_VERTEX_TRANSFORM } from '../shaders/common.ts';
import { applyParallax, visibleLayerRect, type Extent } from '../util/camera.ts';
import { meetsQuality } from './layerModel.ts';
import { coverageExtent } from './placement.ts';

export const FOG_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
${GLSL_VERTEX_TRANSFORM}
out vec2 vLayer;

void main() {
  gl_Position = pixiClipPosition(aPosition, 0.0);
  vLayer = aPosition;
}
`;

/** A cheap transparent band: two value-noise lookups, no loops (§6 full-screen layer rule). */
export const FOG_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vLayer;
uniform vec3 uFogColor;
uniform float uDensity;
uniform float uY;
uniform float uHeight;
uniform float uTime;
uniform float uSpeed;
out vec4 finalColor;
${GLSL_NOISE}
${GLSL_DITHER}

void main() {
  float v = (vLayer.y - uY) / uHeight;
  float prof = max(0.0, 1.0 - v * v);
  prof *= prof;
  vec2 p = vec2((vLayer.x + uTime * uSpeed) * 0.0062, vLayer.y * 0.0175);
  float n = sw_vnoise(p) * 0.65 + sw_vnoise(p * 2.3 + vec2(uTime * 0.021, 5.2)) * 0.35;
  float a = uDensity * prof * clamp(n * 1.5 - 0.2, 0.0, 1.0);
  finalColor = vec4((uFogColor + sw_dither(gl_FragCoord.xy)) * a, a);
}
`;

function createFogUniforms(def: FogLayerDef) {
  return new UniformGroup({
    uFogColor: { value: new Float32Array(hexToRgb(parseHexColor(def.fogColor))), type: 'vec3<f32>' },
    uDensity: { value: def.density, type: 'f32' },
    uY: { value: def.y, type: 'f32' },
    uHeight: { value: def.height, type: 'f32' },
    uTime: { value: 0, type: 'f32' },
    uSpeed: { value: def.speed, type: 'f32' },
  });
}

interface Band {
  def: FogLayerDef;
  container: Container;
  mesh: Mesh<Geometry, Shader>;
  uniforms: ReturnType<typeof createFogUniforms>;
  active: boolean;
}

/**
 * Which fog layers draw at a quality level (fills `out`, one flag per def): those whose `minQuality`
 * the level meets, in manifest order, capped at `maxBands` (quality `fogBands`). Pure.
 */
export function selectFogBands(defs: readonly FogLayerDef[], level: QualityLevel, maxBands: number, out: boolean[]): boolean[] {
  out.length = defs.length;
  let n = 0;
  for (let i = 0; i < defs.length; i++) {
    const on = n < maxBands && meetsQuality(level, (defs[i] as FogLayerDef).minQuality);
    if (on) n++;
    out[i] = on;
  }
  return out;
}

/**
 * Low mist bands (slot `fog`, drawn over the gameplay plane): one static quad per manifest fog layer
 * spanning its coverage extent, placed with applyParallax. A band draws when the quality level meets
 * its `minQuality`, up to `fogBands` bands.
 */
export class FogView implements RenderView {
  readonly name = 'fog';
  private root: Container | null = null;
  private ctx: RenderContext | null = null;
  private readonly bands: Band[] = [];
  private readonly vis: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private readonly flags: boolean[] = [];

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.root = new Container({ label: 'fog' });
    ctx.scene.fog.addChild(this.root);
    const program = GlProgram.from({ vertex: FOG_VERTEX, fragment: FOG_FRAGMENT, name: 'sw-fog', preferredFragmentPrecision: 'highp' });
    for (const def of ctx.manifest.layers) {
      if (def.kind !== 'fog') continue;
      const ext = coverageExtent(ctx.level.pxWidth, ctx.level.pxHeight, def.parallax[0], def.parallax[1]);
      const x0 = ext.x0 - 64;
      const x1 = ext.x1 + 64;
      const y0 = def.y - def.height;
      const y1 = def.y + def.height;
      const geometry = new Geometry({
        attributes: { aPosition: new Float32Array([x0, y0, x1, y0, x1, y1, x0, y1]) },
        indexBuffer: new Uint16Array([0, 1, 2, 0, 2, 3]),
      });
      const uniforms = createFogUniforms(def);
      const mesh = new Mesh({ geometry, shader: new Shader({ glProgram: program, resources: { fog: uniforms } }) });
      const container = new Container({ label: def.id });
      container.addChild(mesh);
      this.root.addChild(container);
      this.bands.push({ def, container, mesh, uniforms, active: true });
    }
    this.onQualityChanged(ctx.quality);
  }

  onQualityChanged(q: QualitySettings): void {
    selectFogBands(this.bands.map((b) => b.def), q.level, q.fogBands, this.flags);
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i] as Band;
      b.active = this.flags[i] === true;
      b.container.visible = b.active;
    }
  }

  update(frame: FrameInfo): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const time = frame.time % 3600;
    for (let i = 0; i < this.bands.length; i++) {
      const b = this.bands[i] as Band;
      if (!b.active) continue;
      const fx = b.def.parallax[0];
      const fy = b.def.parallax[1];
      applyParallax(b.container, frame.camera, fx, fy);
      b.uniforms.uniforms.uTime = time;
      visibleLayerRect(frame.camera, fx, fy, this.vis);
      const h = Math.min(b.def.y + b.def.height, this.vis.y1) - Math.max(b.def.y - b.def.height, this.vis.y0);
      if (h > 0) ctx.stats.fillScreens += h / (this.vis.y1 - this.vis.y0);
    }
  }

  destroy(): void {
    for (const b of this.bands) {
      b.mesh.geometry.destroy(true);
      b.mesh.shader?.destroy();
    }
    this.bands.length = 0;
    this.root?.destroy({ children: true });
    this.root = null;
    this.ctx = null;
  }
}
