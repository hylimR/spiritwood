# Owned dual-filter bloom chain

The full bloom chain as Spiritwood ships it: target layout, sub-rect sampling, the shaders, and the
PixiJS v8.21 wiring. Sources: `src/render/post/viewport.ts`, `src/render/post/post.glsl.ts`,
`src/render/post/postChain.ts`, `src/render/pipeline.ts`.

## 1. Target layout (engine-agnostic)

Level 0 is the glow buffer itself (scene size × `bloomScale`). Level k (1…passes) is half of level k−1.
**Allocate** at the maximum render scale on resize or quality change. **Sub-rects** follow the current
dynamic-resolution scale every frame and never exceed the allocation, so nothing is reallocated.

```ts
export const MAX_BLOOM_PASSES = 6;

export function layoutTargets(out: TargetLayout, pixelWidth: number, pixelHeight: number,
  maxScale: number, bloomScale: number, passes: number): TargetLayout {
  const p = Math.max(0, Math.min(MAX_BLOOM_PASSES, Math.floor(passes)));
  out.passes = p;
  out.sceneAllocW = Math.max(1, Math.ceil(pixelWidth * maxScale - 1e-6));
  out.sceneAllocH = Math.max(1, Math.ceil(pixelHeight * maxScale - 1e-6));
  out.allocW[0] = Math.max(1, Math.ceil(out.sceneAllocW * bloomScale - 1e-6));
  out.allocH[0] = Math.max(1, Math.ceil(out.sceneAllocH * bloomScale - 1e-6));
  for (let k = 1; k <= MAX_BLOOM_PASSES; k++) {
    out.allocW[k] = Math.max(1, Math.ceil(out.allocW[k - 1] / 2));
    out.allocH[k] = Math.max(1, Math.ceil(out.allocH[k - 1] / 2));
  }
  return out;
}

export function layoutSubRects(out: TargetLayout, pixelWidth: number, pixelHeight: number,
  scale: number, bloomScale: number): TargetLayout {
  out.sceneW = Math.min(out.sceneAllocW, Math.max(1, Math.round(pixelWidth * scale)));
  out.sceneH = Math.min(out.sceneAllocH, Math.max(1, Math.round(pixelHeight * scale)));
  out.subW[0] = Math.min(out.allocW[0], Math.max(1, Math.round(out.sceneW * bloomScale)));
  out.subH[0] = Math.min(out.allocH[0], Math.max(1, Math.round(out.sceneH * bloomScale)));
  for (let k = 1; k <= MAX_BLOOM_PASSES; k++) {
    out.subW[k] = Math.max(1, Math.ceil(out.subW[k - 1] / 2));
    out.subH[k] = Math.max(1, Math.ceil(out.subH[k - 1] / 2));
  }
  return out;
}
```

`TargetLayout` holds `allocW/allocH/subW/subH: Int32Array(MAX_BLOOM_PASSES + 1)` plus the scene's
alloc and sub sizes and `passes`. It is created once, and both functions write into it.

## 2. Sampling a sub-rect

Each pass draws one full-screen triangle into the viewport that the pass's `frame` selects, so `vUv`
spans 0..1 over the *destination sub-rect*. You read a source level `s` at:

```
uv    = vUv * (subSize_s / allocSize_s)            // uSrcScale
uv    = clamp(uv, 0.5 / allocSize_s, (subSize_s - 0.5) / allocSize_s)   // uSrcTexel*0.5 .. uSrcMax
texel = 1 / allocSize_s                            // uSrcTexel (the offset unit for the taps)
```

The clamp matters. Texels outside the current sub-rect hold one of two things. For the scene and glow
level 0 it's the clear colour, because Pixi's WebGL clear ignores `frame` (no scissor) and wipes the
whole allocation. For chain levels 1…N it's a stale, larger frame from before a scale step-down, since
those levels are never cleared. An unclamped bilinear tap on the right or bottom edge blends that in,
and you get a dark or bright seam. The composite applies the same clamp to the scene (`uSceneUv`) and
bloom (`uBloomUv`).

## 3. Shaders (GLSL ES 3.0, as in `post.glsl.ts`)

`GLSL_FRAGMENT_HEADER` is `#version 300 es\nprecision highp float;\nprecision highp int;\n`, and
`GLSL_DITHER` defines `sw_dither(fragCoord)`, a TPDF dither of ±1/255 (see `src/render/shaders/common.ts`).

```glsl
// FULLSCREEN_VERTEX. aPosition ∈ {(0,0), (2,0), (0,2)}: one triangle covering the viewport.
#version 300 es
in vec2 aPosition;
uniform float uFlipY;   // 1 only for the pass that writes the canvas
out vec2 vUv;
void main() {
  vUv = vec2(aPosition.x, mix(aPosition.y, 1.0 - aPosition.y, uFlipY));
  gl_Position = vec4(aPosition * 2.0 - 1.0, 0.0, 1.0);
}
```

The repo's vertex also includes the shared `GLSL_VERTEX_TRANSFORM` header. The triangle ignores it,
and Pixi skips uniforms that a program doesn't use.

The two fragments below are complete. In the repo they are built from the shared chunks
`GLSL_FRAGMENT_HEADER` + `SOURCE_TAP` (+ `GLSL_DITHER` for up), which are inlined here.

```glsl
// BLOOM_DOWN_FRAGMENT: ½-size, 4 bilinear taps one source texel off-centre (a 4×4 box)
#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 finalColor;
uniform sampler2D uSource;
uniform vec2 uSrcTexel;   // 1 / source alloc size
uniform vec2 uSrcScale;   // source sub / alloc
uniform vec2 uSrcMax;     // (source sub - 0.5) / alloc
vec3 tap(vec2 uv) { return texture(uSource, clamp(uv, uSrcTexel * 0.5, uSrcMax)).rgb; }

void main() {
  vec2 uv = vUv * uSrcScale;
  vec2 o = uSrcTexel;
  vec3 c = tap(uv + vec2(-o.x, -o.y)) + tap(uv + vec2(o.x, -o.y))
         + tap(uv + vec2(-o.x,  o.y)) + tap(uv + vec2(o.x,  o.y));
  finalColor = vec4(c * 0.25, 1.0);
}
```

```glsl
// BLOOM_UP_FRAGMENT: 2× upsample, 8-tap tent, added onto the destination (additive blend)
#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 finalColor;
uniform float uDither;    // 1 on the last up-pass when the chain is RGBA8
uniform sampler2D uSource;
uniform vec2 uSrcTexel;
uniform vec2 uSrcScale;
uniform vec2 uSrcMax;
vec3 tap(vec2 uv) { return texture(uSource, clamp(uv, uSrcTexel * 0.5, uSrcMax)).rgb; }
float sw_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 sw_dither(vec2 fragCoord) {           // TPDF, ±1/255
  float r = sw_hash12(fragCoord) + sw_hash12(fragCoord + 17.31) - 1.0;
  return vec3(r / 255.0);
}

void main() {
  vec2 uv = vUv * uSrcScale;
  vec2 h = uSrcTexel;
  vec3 c = tap(uv + vec2(-h.x, 0.0)) + tap(uv + vec2(h.x, 0.0))
         + tap(uv + vec2(0.0, -h.y)) + tap(uv + vec2(0.0, h.y));
  c += 2.0 * (tap(uv + vec2(-h.x, -h.y) * 0.5) + tap(uv + vec2(h.x, -h.y) * 0.5)
            + tap(uv + vec2(-h.x,  h.y) * 0.5) + tap(uv + vec2(h.x,  h.y) * 0.5));
  c = c / 12.0 + sw_dither(gl_FragCoord.xy) * uDither;
  finalColor = vec4(max(c, vec3(0.0)), 0.0);
}
```

None of these names collide with Pixi's reserved uniforms (`uColor`, `uTransformMatrix`,
`uProjectionMatrix`, `uWorldTransformMatrix`, `uWorldColorAlpha`, `uResolution`, `uRound`).

Why these taps:

- **Down:** a destination pixel centre in a half-size target lands on the corner shared by 4 source
  texels. Offsetting by ±1 texel diagonally puts each bilinear tap on the corner of a 2×2 quad, so the
  4 taps average a 4×4 block (16 texels) for the price of 4 fetches. This is exact when the source
  sub-rect has an even size. Sizes are ceil-halved, so an odd source makes the ratio slightly under 2
  and the footprint drifts by a fraction of a texel. That's harmless for bloom.
- **Up:** the 4 axis taps (weight 1) and the 4 half-diagonal taps (weight 2) make a tent that hides the
  blockiness of the smaller level. The result is *added* onto the level above, which already holds
  that level's downsample. After the last up-pass, level 0 is `glow + blur1 + blur2 + … + blurN`: the
  sharp twin plus halos that grow roughly 2× in radius per level. Each term keeps about the glow's
  total energy, which is why the composite divides by `passes + 1`.
- **Alpha:** down writes 1 (blend off, it overwrites). Up writes 0, so with additive blending the
  alpha channel is unchanged. The composite reads only `.rgb` from the bloom.

## 4. PixiJS v8.21 wiring (condensed `postChain.ts`)

This is condensed. The repo's `as Target` / `as number` casts on indexed access (house style) and
`destroy()` are left out, and the composite uniform group is listed in [grade.md](grade.md). The repo compiles with `erasableSyntaxOnly`, which
forbids constructor parameter properties, so fields are assigned explicitly.

```ts
import { CLEAR, Container, Geometry, GlProgram, Mesh, Rectangle, RenderTarget, Shader, State, Texture,
  TextureSource, UniformGroup, type RenderOptions, type TEXTURE_FORMATS, type WebGLRenderer } from 'pixi.js';

export interface PassOptions extends RenderOptions { frame?: Rectangle } // honoured by RenderTargetSystem.bind

function createTarget(label: string, format: TEXTURE_FORMATS, depth: boolean) {
  const source = new TextureSource({ width: 1, height: 1, resolution: 1, format, antialias: false,
    autoGenerateMipmaps: false, scaleMode: 'linear', addressMode: 'clamp-to-edge', label });
  const texture = new Texture({ source, label });
  const target = new RenderTarget({ colorTextures: [texture], depth, stencil: false, label });
  return { source, texture, target };
}

function opaqueState(): State {        // MeshPipe only rewrites blendMode when state.blend is true
  const s = new State();
  s.blend = false; s.depthTest = false; s.depthMask = false;
  return s;
}

class FullscreenPass {
  readonly root = new Container({ label: 'post-pass' });
  readonly mesh: Mesh<Geometry, Shader>;
  readonly uniforms: UniformGroup;
  constructor(geometry: Geometry, program: GlProgram, textures: Record<string, TextureSource>,
    uniforms: UniformGroup, additive: boolean) {
    this.uniforms = uniforms;
    const shader = new Shader({ glProgram: program, resources: { ...textures, uPass: uniforms } });
    this.mesh = new Mesh<Geometry, Shader>({ geometry, shader, state: additive ? State.for2d() : opaqueState() });
    if (additive) this.mesh.blendMode = 'add';   // never state.blendMode
    this.root.addChild(this.mesh);
  }
}

const passUniforms = () => new UniformGroup({
  uSrcTexel: { value: new Float32Array(2), type: 'vec2<f32>' },
  uSrcScale: { value: new Float32Array(2), type: 'vec2<f32>' },
  uSrcMax: { value: new Float32Array(2), type: 'vec2<f32>' },
  uDither: { value: 0, type: 'f32' },
  uFlipY: { value: 0, type: 'f32' },
});
const program = (name: string, fragment: string) =>
  GlProgram.from({ name, vertex: FULLSCREEN_VERTEX, fragment, preferredFragmentPrecision: 'highp' });

// constructor (once):
this.glowFormat = renderer.context.extensions.colorBufferFloat ? 'rgba16float' : 'rgba8unorm';
this.scene = createTarget('scene', 'rgba8unorm', true);                 // RGBA8 + depth
for (let k = 0; k <= MAX_BLOOM_PASSES; k++) {
  this.chain.push(createTarget(`glow${k}`, this.glowFormat, false));    // no depth
  this.chainFrames.push(new Rectangle());
}
const geometry = new Geometry({ attributes: { aPosition: { buffer: new Float32Array([0, 0, 2, 0, 0, 2]), format: 'float32x2' } } });
const down = program('sw-bloom-down', BLOOM_DOWN_FRAGMENT);
const up = program('sw-bloom-up', BLOOM_UP_FRAGMENT);
for (let k = 1; k <= MAX_BLOOM_PASSES; k++) {
  const d = new FullscreenPass(geometry, down, { uSource: this.chain[k - 1].source }, passUniforms(), false);
  this.downOptions.push({ container: d.root, target: this.chain[k].target, clear: CLEAR.NONE, frame: this.chainFrames[k] });
}
for (let k = 0; k < MAX_BLOOM_PASSES; k++) {
  const u = new FullscreenPass(geometry, up, { uSource: this.chain[k + 1].source }, passUniforms(), true);
  this.upOptions.push({ container: u.root, target: this.chain[k].target, clear: CLEAR.NONE, frame: this.chainFrames[k] });
}
const composite = new FullscreenPass(geometry, program('sw-composite', COMPOSITE_FRAGMENT),
  { uScene: this.scene.source, uBloom: this.chain[0].source }, compositeUniforms, false);  // see grade.md
this.sceneOptions = { container: sceneRoot, target: this.scene.target, clear: CLEAR.ALL, clearColor: sceneClear, frame: this.sceneFrame };
this.glowOptions = { container: glowRoot, target: this.chain[0].target, clear: CLEAR.COLOR, clearColor: [0, 0, 0, 0], frame: this.chainFrames[0] };
this.compositeOptions = { container: composite.root, clear: CLEAR.NONE };  // canvas; composite uFlipY = 1

// allocate(): on resize / quality change only
const l = layoutTargets(this.layout, pixelWidth, pixelHeight, maxScale, bloomScale, passes);
this.passes = l.passes;
this.scene.source.resize(l.sceneAllocW, l.sceneAllocH, 1);
for (let k = 0; k <= MAX_BLOOM_PASSES; k++) {
  const used = k <= l.passes;                         // unused levels shrink to 1×1
  this.chain[k].source.resize(used ? l.allocW[k] : 1, used ? l.allocH[k] : 1, 1);
}

// setScale(): on a dynamic-resolution step; moves frames + refreshes sampling uniforms
layoutSubRects(this.layout, pixelWidth, pixelHeight, scale, bloomScale);
// chainFrames[k].width/height = subW[k]/subH[k]; sceneFrame = sceneW × sceneH
// down[k-1] samples level k-1, up[k] samples level k+1:
//   uSrcTexel = 1/alloc, uSrcScale = sub/alloc, uSrcMax = (sub - 0.5)/alloc
//   uDither = (level === 1 && glowFormat === 'rgba8unorm') ? 1 : 0   → the last up-pass (up[0]).
//   The same helper also writes uDither into down[1]'s group, whose shader has no uDither, so it's ignored.

// renderBloom(): every frame
const p = this.passes;
for (let k = 1; k <= p; k++) renderer.render(this.downOptions[k - 1]);
for (let k = p - 1; k >= 0; k--) renderer.render(this.upOptions[k]);
```

The frame in `pipeline.ts`:

```ts
r.render(post.sceneOptions);
if (q.bloom) {
  r.render(post.glowOptions);
  if (scene.foreground.children.length > 0) r.render(glowForeground);  // dark occluders over the twins
  post.renderBloom(r);
}
r.render(post.compositeOptions);
```

`glowForeground = post.glowOverlayOptions(scene.foreground, glowForegroundMatrix)` is
`{ container, target: chain[0].target, clear: CLEAR.NONE, frame: chainFrames[0], transform }`. The matrix
is preallocated and set to `(gx, 0, 0, gy, 0, 0)`, where `gx = subW[0] / viewW` and `gy = subH[0] / viewH`,
on every scale change. It maps the foreground's view units into glow pixels. Because you pass it
yourself, Pixi doesn't capture the container's own `localTransform`.

Scale containers: `sceneRoot → sceneScale (scale = sceneW/viewW, sceneH/viewH) → slots`, and
`glowRoot → glowScale (subW[0]/viewW, subH[0]/viewH) → glow slots`. The roots stay at identity because a
reused options object freezes them (Pixi writes `options.transform = container.localTransform` on first use).

## 5. Cost at 1920×1080, render scale 1 (computed from `layoutTargets`/`layoutSubRects`)

| Preset | Levels (px) | Glow clear/fill | Down writes | Up writes | Chain RGBA16F alloc | `render()` calls |
|---|---|---|---|---|---|---|
| High (½, 4) | 960×540 → 60×34 | 0.25 screens | 0.083 | 0.332 | 5.3 MiB | 12 |
| Medium (½, 3) | 960×540 → 120×68 | 0.25 | 0.082 | 0.328 | 5.3 MiB | 10 |
| Low (¼, 2) | 480×270 → 120×68 | 0.063 | 0.020 | 0.078 | 1.3 MiB | 8 |

The table holds every preset at render scale 1 so the rows compare. In the shipping presets at 1080p,
Medium starts at scale 0.83 and Low at 0.67 (`renderScale` capped by `maxRenderPixels`), so their real
numbers are lower. For example, Medium's up writes are 0.228.

Draw calls: 2·passes for the chain, plus 1 for the composite. Each extra pass adds a level at about ¼
of the previous smallest level's area and roughly doubles the halo radius. Level 0 dominates the cost:
its clear, the twins and the final up-pass into it (0.25 of the 0.332 up writes at High). To save fill,
lower `bloomScale` before you drop passes.
