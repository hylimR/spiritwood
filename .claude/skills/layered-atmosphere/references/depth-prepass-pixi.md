# Depth pre-pass for a parallax stack (engine-agnostic model + PixiJS v8.21 recipe)

The code is from the repo: `src/render/util/states.ts`, `src/render/post/postChain.ts`, `src/render/pipeline.ts`,
`src/render/layers/parallaxStack.ts`, `src/render/layers/sky.ts`, `src/render/layers/fog.ts`, `src/render/fx/shafts.ts`
and `src/render/terrain/terrainView.ts`. Excerpts are trimmed but not rewritten.

## 1. The model

Each depth-tested layer draws twice:

- as an **opaque core**: the fully covered interior of every shape, as meshes (see channel-packed-atlas for the split);
- as a **soft band**: every translucent texel (AA edges, mist fades, halos).

| pass (slot) | content | order | blend | depth test | depth write |
|---|---|---|---|---|---|
| `opaque` | terrain core, then layer cores | near → far (and front → back inside a mesh) | off | LESS | on |
| `sky` | one full-screen quad at depth 0.99 | — | off | LESS | off |
| `background` | layer soft bands | far → near (back → front inside a mesh) | premultiplied | LESS | off |
| `shafts` | additive light shafts at depth 0.055 | — | add | LESS | off |
| `terrain` onward | terrain AA/moss strips, decor, entities, hero, front decor, particles, fog, foreground | slot order | normal/add | off | off |

Why each choice:

- **Cores near → far with depth write.** The first core to cover a pixel writes its depth, and early-Z then kills every farther
  core's fragment *before shading*. So every opaque-covered pixel is shaded about once, however many layers overlap it (ARCHITECTURE §2.4).
  The rejected fragments cost only rasterization and a depth test. Early-Z is a hardware optimisation, not a guarantee, so keep the conditions
  that allow it (no discard, no `gl_FragDepth`) and the ones that make it pay off (depth write on, near → far order).
- **Sky after the cores.** The sky is the most expensive full-screen shader (noise, moon, stars). At depth 0.99 with LESS it survives only
  where no core wrote. The §6 budget allows it ≤ 0.5 screens after the reject, and the debug fill estimate uses `SKY_FILL_ESTIMATE = 0.6`.
  These are budgets and estimates, not GPU measurements.
- **Bands far → near without depth write.** Translucent pixels must composite in painter order. Depth test still rejects a band
  fragment behind a nearer core. Bands don't write depth, so they never cut each other.
- **Everything from `terrain` on ignores depth.** It is all in front of the parallax stack by construction, so it needs no test, and
  plain Pixi Sprites, Graphics and ParticleContainers could not test anyway.

### Depth values

```
depthForParallax(f) = 0.05 + 0.9·(1 − clamp(f, 0, 1))      terrain 0.05 … f=0 → 0.95
depthForInstance(f, k) = depthForParallax(f) − k·DEPTH_INSTANCE_EPS    (EPS = 1/65536, k = painter order)
DEPTH_SKY 0.99, DEPTH_SHAFTS 0.055, DEPTH_TERRAIN 0.05
```

The shader writes `gl_Position.z = depth·2 − 1` with `w = 1`, so window depth = `depth` (default depth range).

**Budget arithmetic** (why the constants are what they are):

- The instance offset is at most `MAX_INSTANCES_PER_LAYER · EPS = 1024/65536 ≈ 0.0156`.
- The minimum layer gap is `MIN_LAYER_PARALLAX_GAP · 0.9 = 0.02 · 0.9 = 0.018`, which is more than 0.0156. Instance depths never cross into
  the next layer.
- The nearest layer has `f ≤ MAX_LAYER_PARALLAX = 0.95`, so its depth is at least `0.095 − 0.0156 ≈ 0.079`. That is still behind shafts (0.055) and terrain (0.05).
- EPS is 256 steps of the 24-bit depth buffer (Pixi allocates `DEPTH24_STENCIL8` on WebGL2), well above rounding.
- The manifest validator (`src/assets/manifest.ts`) enforces the fx ≤ 0.95 and gap ≥ 0.02 rules.

**Why a per-instance epsilon:** with every instance of a layer at one depth, LESS fails for equal depths. The soft band of a *front*
instance would then be rejected where it overlaps a *back* instance's core, and halos get cut. With the epsilon, nearer instances are
strictly nearer:

- the front band passes over the back core;
- the back band fails behind the front core;
- a band never redraws over its *own* core (equal depth fails LESS), so band and core rects may overlap freely.

The layer's ground-fill quad uses `k = 0`, the backmost depth in the layer.

## 2. PixiJS v8.21: render target with depth

```ts
function createTarget(label: string, format: TEXTURE_FORMATS, depth: boolean): Target {
  const source = new TextureSource({
    width: 1, height: 1, resolution: 1, format, antialias: false, autoGenerateMipmaps: false,
    scaleMode: 'linear', addressMode: 'clamp-to-edge', label,
  });
  const texture = new Texture({ source, label });
  const target = new RenderTarget({ colorTextures: [texture], depth, stencil: false, label });
  return { source, texture, target };
}
// scene: createTarget('scene', 'rgba8unorm', true)
```

- A `RenderTexture` passed as `target` has **no depth buffer**. The depth test then silently passes everything: farther cores
  overwrite nearer ones, the sky quad overwrites every core, and nothing warns you. Use
  `new RenderTarget({ colorTextures: [tex], depth: true })`.
- `renderer.render({ container, target, clear: CLEAR.ALL, clearColor, frame })` clears depth to 1.0 (Pixi never calls `gl.clearDepth`, so the WebGL default applies). Pixi forces
  `depthMask(true)` for the clear, so the sky and band states (write off) don't block it.
- Pixi never calls `gl.depthFunc`, so the test is the WebGL default **LESS**. Design depths for LESS: equal depth fails.
- Keep `antialias: false` on the scene colour source (ARCHITECTURE §2.4). Edge AA comes from geometry: the soft bands and the
  terrain feather strip.
- The render-options object is preallocated and reused every frame. Pixi writes `options.transform` into it, so a reused object
  freezes the root's transform. Keep the root at identity and put the RT scale on a child (`sceneRoot → sceneScale → slots`).
  `clearColor` is a preallocated `number[4]`.

## 3. PixiJS v8.21: the three States

```ts
export function createOpaqueState(): State {
  const s = new State();
  s.blend = false;
  s.depthTest = true;
  s.depthMask = true;
  return s;
}
export function createSkyState(): State {
  const s = new State();
  s.blend = false;
  s.depthTest = true;
  s.depthMask = false;
  return s;
}
export function createTransparentState(): State {
  const s = new State();
  s.blend = true;
  s.depthTest = true;
  s.depthMask = false;
  return s;
}
```

- For additive meshes set **`mesh.blendMode = 'add'`**, never `state.blendMode`. `MeshPipe.execute` does
  `if (mesh.state.blend) mesh.state.blendMode = getAdjustedBlendModeBlend(mesh.groupBlendMode, …)` every frame, and the
  `State.blendMode` setter also sets `blend = value !== 'none'`, so assigning it on an opaque state turns blending back on.
- Plain `Sprite`, `Graphics` and `ParticleContainer` use Pixi's default 2D state (no depth test). In slots `opaque`, `sky`, `background` or `shafts` they
  would paint over the terrain drawn in the pre-pass. They are allowed only from slot `terrain` onward.
- `filters`, `mask` and `cacheAsTexture` render into pooled textures without depth, so they are forbidden anywhere under a scene or glow
  slot (ARCHITECTURE §2.4). The WebGL2 context is also created with `depth: false, stencil: false`, since all depth lives in the scene RT.
- Opaque and sky fragment shaders never `discard` and never write `gl_FragDepth`. Either one disables early-Z for the draw. The static
  lint `tests/world/glsl.test.ts` enforces this for every WORLD program.

## 4. Slots and sortable z-order

```ts
function slotContainers<K extends string>(names: readonly K[], parent: Container, prefix: string): Record<K, Container> {
  const out = {} as Record<K, Container>;
  for (const name of names) {
    const c = new Container({ isRenderGroup: true, label: `${prefix}:${name}` });
    parent.addChild(c);
    out[name] = c;
  }
  return out;
}
const scene = slotContainers<SceneSlot>(SCENE_SLOTS, this.sceneScale, 'scene');
scene.opaque.sortableChildren = true;
scene.background.sortableChildren = true;
```

Pixi sorts siblings by ascending `zIndex`, and the lowest draws first. Encode depth order in `zIndex` rather than in `addChild` order, so
views that initialise in any order still interleave correctly:

```ts
// parallaxStack.ts: per layer
const z = Math.round(depthForParallax(fx) * 1e6);
const core = new Container({ label: `${def.id}:core`, zIndex: z });    // opaque: small depth (near) first
const band = new Container({ label: `${def.id}:band`, zIndex: -z });   // background: large depth (far) first
// roots inside the slots
opaqueRoot.zIndex = Math.round(near * 1e6);
bandRoot.zIndex = -Math.round(far * 1e6);
// terrainView.ts: the nearest opaque thing
this.core = new Container({ label: 'terrain-core', zIndex: Math.round(DEPTH_TERRAIN * 1e6) });
ctx.scene.opaque.addChild(this.core);
```

`isRenderGroup` on each slot means that toggling a chunk's `visible` rebuilds only that slot's instruction list. Toggle visibility only when
a chunk enters or leaves the view, never for animation.

## 5. Wiring each pass

Core and band meshes per chunk (parallaxStack.ts):

```ts
const coreState = createOpaqueState();
const bandState = createTransparentState();
const fgState = State.for2d();
// ...
meshes.push(core.addChild(new Mesh({ geometry: createKitGeometry(m, `${def.id}:${c}:core`), shader: coreShader, state: coreState })));
// ...
meshes.push(band.addChild(new Mesh({
  geometry: createKitGeometry(m, `${def.id}:${c}:band`), shader: bandShader, state: depthTested ? bandState : fgState,
})));
```

Foreground layers (fx > 1) have no core. They go blended into slot `foreground` with `State.for2d()`.

Sky (sky.ts): one quad in view space, resized on `onResize`, drawn with the sky state:

```ts
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
```

Shafts (shafts.ts): world space, depth-tested behind the terrain core, additive:

```ts
this.mesh = new Mesh({ geometry, shader, state: createTransparentState() });
this.mesh.blendMode = 'add';
```

Fog bands (fog.ts): slot `fog` (after particles, before foreground). They use the default state with no depth test, so the depth 0
their vertex shader writes is ignored:

```ts
const mesh = new Mesh({ geometry, shader: new Shader({ glProgram: program, resources: { fog: uniforms } }) });
```

Terrain core (terrainView.ts): slot `opaque`, which is view space, so the view positions it at f = 1 itself:

```ts
meshes.push(this.core.addChild(new Mesh({ geometry: g, shader: coreShader, state: opaque })));
// update():
applyParallax(this.core, cam, 1, 1);
```

## 6. Per-frame update (zero allocation)

```ts
for (let l = 0; l < this.layers.length; l++) {
  const rt = this.layers[l] as LayerRuntime;
  if (!rt.active) continue;
  for (let c = 0; c < rt.containers.length; c++) applyParallax(rt.containers[c] as Container, cam, rt.fx, rt.fy);
  visibleLayerRect(cam, rt.fx, rt.fy, vis);
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
  }
  if (rt.sways) rt.uniforms.uniforms.uTime = time;   // time = frame.time % 3600
}
```

Chunk bounds are padded by 1.4× the largest sway amplitude, so swaying tips never pop at chunk edges. `uTime` wraps at 3600 s, which keeps
`sin(uTime·k + …)` precise in fp32 after hours of play.

## 7. Shader-program rules that bit this project (Pixi 8.21)

- Vertex shaders start with `#version 300 es`. Fragment shaders start with
  `#version 300 es\nprecision highp float;\nprecision highp int;\n` (`GLSL_FRAGMENT_HEADER`), and `GlProgram.from` gets
  `preferredFragmentPrecision: 'highp'`. Pixi's default fragment precision is `mediump` (vertex: `highp`), and it prepends its own
  `precision` line unless the source (after the `#version` line is stripped) starts with `precision`. A uniform declared in both stages
  (for example a `uTime` used by both a vertex sway and a fragment effect) then has mismatched precision, and **the program fails to link**.
  Today no repo program shares a uniform across stages. The header and the option keep it safe when one does.
- Never declare your own uniform with a Pixi reserved name: `uColor`, `uTransformMatrix`, `uProjectionMatrix`,
  `uWorldTransformMatrix`, `uWorldColorAlpha`, `uResolution`, `uRound`. A `vec3 uColor` for the fog colour collided with the mesh-local
  `vec4 uColor` and broke both fog and shafts. The repo names them `uFogColor`, `uShaftColor` and `uTint`.
- Shaders that share one `GlProgram` must declare the same resources in the same order, because Pixi caches the uniform sync per program.
  The kit core, band and twin shaders all use `{ uTexture, kitLayer, kitPass }` and share the layer's `UniformGroup`.
- Name the position attribute `aPosition`. Pixi derives mesh bounds from it.
- Textures and render targets are premultiplied. Bands and fog output `vec4(rgb·a, a)`, while cores and the sky output alpha 1.
