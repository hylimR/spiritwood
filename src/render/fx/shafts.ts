import { Container, GlProgram, Mesh, Shader, UniformGroup, type Geometry } from 'pixi.js';
import { DEPTH_SHAFTS } from '../../config.ts';
import type { QualitySettings } from '../../contracts/quality.ts';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import { interleavedGeometry, type AttributeSpec } from '../layers/geometry.ts';
import { GLSL_FRAGMENT_HEADER, GLSL_NOISE, GLSL_VERSION, GLSL_VERTEX_TRANSFORM } from '../shaders/common.ts';
import type { Extent } from '../util/camera.ts';
import { createTransparentState } from '../util/states.ts';
import { shaftTrapezoid, trapezoidBounds, type Trapezoid } from './shaftGeometry.ts';
import { SHAFT_COLOR, SHAFT_LOOK } from './shaftShading.ts';

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/** Shaft brightness relative to def.intensity. */
export const SHAFT_STRENGTH = SHAFT_LOOK.strength;
/** Rows per shaft (the u mapping is exact via affine attributes; rows only shape the envelope). */
const ROWS = 4;
const STRIDE_FLOATS = 7;

const ATTRS: readonly AttributeSpec[] = [
  { name: 'aPosition', format: 'float32x2', offset: 0 },
  { name: 'aShaft', format: 'float32x4', offset: 8 },
  { name: 'aSeed', format: 'float32', offset: 24 },
];

export const SHAFT_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
in vec4 aShaft;
in float aSeed;
${GLSL_VERTEX_TRANSFORM}
out vec4 vShaft;
out float vSeed;

void main() {
  gl_Position = pixiClipPosition(aPosition, ${DEPTH_SHAFTS.toFixed(4)});
  vShaft = aShaft;
  vSeed = aSeed;
}
`;

/**
 * Additive, depth-tested (behind the terrain core) light shaft (shaftShading.ts). aShaft = (x − left(y),
 * width(y), v, intensity): both components are affine over the trapezoid, so u = x / width is exact
 * per fragment. Two value-noise lookups, no loops.
 */
export const SHAFT_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec4 vShaft;
in float vSeed;
uniform vec3 uShaftColor;
uniform float uStrength;
uniform float uTime;
out vec4 finalColor;
${GLSL_NOISE}

void main() {
  float u = clamp(vShaft.x / max(vShaft.y, 1e-3), 0.0, 1.0);
  float v = clamp(vShaft.z, 0.0, 1.0);
  float across = smoothstep(0.0, 0.24, u) * (1.0 - smoothstep(0.76, 1.0, u));
  float along = smoothstep(0.0, ${f(SHAFT_LOOK.fadeIn)}, v) * pow(max(0.0, 1.0 - v), ${f(SHAFT_LOOK.fall)});
  float n = sw_vnoise(vec2(u * ${f(SHAFT_LOOK.streakFreq)} + vSeed, uTime * ${f(SHAFT_LOOK.streakDrift)} + vSeed * 0.37));
  float streak = ${f(SHAFT_LOOK.streakMin)} + ${f(1 - SHAFT_LOOK.streakMin)} * smoothstep(0.2, 0.8, n);
  float sh = sw_vnoise(vec2(u * 2.3 + vSeed * 1.7, v * ${f(SHAFT_LOOK.shimmerFreq)} - uTime * ${f(SHAFT_LOOK.shimmerSpeed)}));
  float shimmer = ${f(1 - SHAFT_LOOK.shimmerDepth)} + ${f(SHAFT_LOOK.shimmerDepth * 1.6)} * sh;
  float a = across * along * streak * shimmer * vShaft.w * uStrength;
  finalColor = vec4(uShaftColor * a, a);
}
`;

/** Pure: interleaved vertices/indices for all shafts (ROWS quads each). */
export function buildShaftMesh(traps: readonly Trapezoid[]): { vertices: Float32Array; indices: Uint16Array; area: number } {
  const v: number[] = [];
  const idx: number[] = [];
  let area = 0;
  traps.forEach((t, s) => {
    const seed = s * 7.31 + 1.7;
    const base = v.length / STRIDE_FLOATS;
    for (let r = 0; r <= ROWS; r++) {
      const vv = r / ROWS;
      const y = t.y0 + (t.y1 - t.y0) * vv;
      const left = t.topX + (t.botX - t.topX) * vv;
      const w = t.topW + (t.botW - t.topW) * vv;
      v.push(left, y, 0, w, vv, t.intensity, seed);
      v.push(left + w, y, w, w, vv, t.intensity, seed);
    }
    for (let r = 0; r < ROWS; r++) {
      const a = base + r * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
    area += ((t.topW + t.botW) / 2) * (t.y1 - t.y0);
  });
  return { vertices: Float32Array.from(v), indices: Uint16Array.from(idx), area };
}

/** Light shafts (slot `shafts`, world space): all shafts merged into one additive, depth-tested mesh. */
export class ShaftsView implements RenderView {
  readonly name = 'shafts';
  private ctx: RenderContext | null = null;
  private root: Container | null = null;
  private mesh: Mesh<Geometry, Shader> | null = null;
  private uniforms: UniformGroup | null = null;
  private traps: Trapezoid[] = [];
  private bounds: { x0: number; x1: number; y0: number; y1: number }[] = [];
  private areas: number[] = [];
  private enabled = true;
  private readonly view: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    this.root = new Container({ label: 'light-shafts' });
    ctx.scene.shafts.addChild(this.root);
    this.traps = ctx.level.lightShafts.map(shaftTrapezoid);
    if (this.traps.length === 0) return;
    this.bounds = this.traps.map(trapezoidBounds);
    this.areas = this.traps.map((t) => ((t.topW + t.botW) / 2) * (t.y1 - t.y0));
    const data = buildShaftMesh(this.traps);
    const geometry = interleavedGeometry(data.vertices, data.indices, STRIDE_FLOATS * 4, ATTRS, 'light-shafts');
    const uniforms = new UniformGroup({
      uShaftColor: { value: new Float32Array(SHAFT_COLOR), type: 'vec3<f32>' },
      uStrength: { value: SHAFT_STRENGTH, type: 'f32' },
      uTime: { value: 0, type: 'f32' },
    });
    this.uniforms = uniforms;
    const shader = new Shader({
      glProgram: GlProgram.from({ vertex: SHAFT_VERTEX, fragment: SHAFT_FRAGMENT, name: 'sw-shafts', preferredFragmentPrecision: 'highp' }),
      resources: { shaft: uniforms },
    });
    this.mesh = new Mesh({ geometry, shader, state: createTransparentState() });
    this.mesh.blendMode = 'add';
    this.root.addChild(this.mesh);
    this.onQualityChanged(ctx.quality);
  }

  onQualityChanged(q: QualitySettings): void {
    this.enabled = q.lightShafts;
    if (this.root) this.root.visible = this.enabled;
  }

  update(frame: FrameInfo): void {
    const ctx = this.ctx;
    if (!ctx || !this.uniforms || !this.enabled) return;
    (this.uniforms.uniforms as { uTime: number }).uTime = frame.time % 3600;
    const cam = frame.camera;
    const v = this.view;
    v.x0 = cam.left;
    v.x1 = cam.left + cam.width;
    v.y0 = cam.top;
    v.y1 = cam.top + cam.height;
    const viewArea = Math.max(1, cam.width * cam.height);
    let fill = 0;
    for (let i = 0; i < this.bounds.length; i++) {
      const b = this.bounds[i] as { x0: number; x1: number; y0: number; y1: number };
      const w = Math.min(b.x1, v.x1) - Math.max(b.x0, v.x0);
      const h = Math.min(b.y1, v.y1) - Math.max(b.y0, v.y0);
      if (w > 0 && h > 0) fill += ((this.areas[i] as number) * (w * h)) / Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0)) / viewArea;
    }
    ctx.stats.fillScreens += fill;
  }

  destroy(): void {
    this.mesh?.geometry.destroy(true);
    this.mesh?.shader?.destroy();
    this.root?.destroy({ children: true });
    this.root = null;
    this.mesh = null;
    this.ctx = null;
  }
}
