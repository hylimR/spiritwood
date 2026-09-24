---
name: glow-bloom-grade
description: Emissive glow buffer, owned dual-filter (Kawase-style) bloom and a colour-graded composite for 2D/2.5D WebGL scenes. Draw additive, emissive-only "glow twins" of gameplay-plane content (moss rims, flora, lanterns, hero, particles) into a half/quarter-res RGBA16F buffer (RGBA8 + dither fallback), and draw dark foreground over them so it occludes. Blur with preallocated ½-size down/up passes on dynamic-resolution sub-rects, then composite scene + bloom → exposure → temperature → lift/gamma/gain → contrast → saturation → shoulder → fade → vignette → dither, with per-area grades blended by camera position. Use for glow, bloom, emissive light, halos, light pools, HDR/float render targets, post-processing, colour grading, vignette, banding, mood or zone grades, glow bleeding through occluders, and PixiJS v8 post chains.
---

# Glow, bloom and grade

The technique makes lights feel like light and gives the frame one graded look. In Spiritwood, the
teal flora bulbs, the white spirit hero and the warm shrine lanterns carry soft wide halos. The halos
stop at the near-black foreground leaves, and the moss rims shimmer along the ground. The five areas
read as one world in five moods: calm teal glade, cold gully, deep-blue rootwell with a heavy cool
vignette, airy moonlit canopy, amber shrine. The grade is one composite shader.

## When to use

- A dark scene where emissive things (flora, lanterns, pickups, a glowing character, sparks) should
  bloom, while dark foreground still hides them.
- Many parallax planes, where only some should bloom. The glow buffer can't know what is in front.
- You need area moods (warm, cold, enclosed) that cross-fade as the camera moves, at the cost of one
  full-screen pass.
- You are fill-rate bound (integrated GPUs), use dynamic resolution, and can't afford Gaussian bloom or
  engine filter stacks.
- Don't use it for an unlit, flat-colour look (skip bloom, keep the grade), or when the engine already has
  a depth-aware HDR pipeline you can drive.

## Core idea

- **Glow is energy, not an image.** A separate low-res buffer holds only emitted light. Anything that
  glows is drawn a second time into it: emissive-only, additive, alpha 0. That second copy is the
  **twin**. The glow buffer has no depth, so twins come only from content drawn in front of the opaque
  layers. Occlusion comes from whatever you draw into it *afterwards* (the dark foreground, normal blend).
  Twins never occlude each other.
- **Bloom is a sum of mips.** Halve the buffer `passes` times (4 taps each), then walk back up, adding
  a tent-filtered upsample onto each level. Level 0 ends up as `glow + blur1 + … + blurN`. The halo
  radius roughly doubles per pass, and level 0 dominates the cost.
- **The grade is one pass with a fixed order of operations.** The parameters are per area and are
  blended by camera position in zones with falloff. A CPU reference mirrors the shader line for line.
- **Cheap glow first.** Background glows are *baked* (halo texels in the atlas, added in-scene), and
  "light on the world" is an additive halo sprite. Bloom is reserved for what's in front.

## Recipe

**A. Glow twins** (details and per-content patterns: [references/glow-twins.md](references/glow-twins.md))

1. List what glows and where it sits. Emissive content on the gameplay plane (drawn after the opaque
   layers) gets a twin. The dark near foreground gets no twin, because it occludes. Content on parallax
   layers behind opaque terrain gets a baked halo (atlas halo texels, whose emissive colour the scene
   shader adds). Sky features get an analytic halo in the sky shader.
2. Make each twin share everything: the same program with a second uniform group (`uGlowPass = 1`), the
   same vertex buffer with an emissive-only index subset, the same particle array under a second
   container, the same texture with a grey tint. The twin outputs `vec4(emissive · coverage, 0.0)` and
   draws with additive blend.
3. Each frame, clear the glow buffer to 0 and draw the twins. Then draw the near foreground occluders
   into it with their normal blending.

**B. Bloom chain** (full listing: [references/bloom-chain.md](references/bloom-chain.md))

4. Allocate the scene target (RGBA8 + depth), glow level 0 (scene × `bloomScale`) and `passes` halvings
   **once**, at the maximum render scale. Use RGBA16F if float colour buffers are available, otherwise RGBA8.
5. Per frame, render into **sub-rects** (canvas × render scale). Every sample reads
   `uv · sub/alloc`, clamped half a texel inside the sub-rect. The scale moves in 0.05 steps, at most once
   a second. A step rewrites the frames, the sampling uniforms and the scale of the scene/glow roots,
   and never reallocates a texture.
6. Down passes 1…N: blend off, 4 bilinear taps at ±1 source texel diagonally (a 4×4 box, exact when
   the source size is even and approximate for the ceil-rounded odd sizes).
7. Up passes N−1…0: an 8-tap tent from level k+1, **added** onto level k without clearing. On an RGBA8
   chain, add ±1 LSB dither in the last up-pass.
8. Composite with `bloomIntensity / (passes + 1)`, so a quality change doesn't change brightness.

**C. Composite and grade** (shader, CPU mirror, zones: [references/grade.md](references/grade.md))

9. In order: `scene + bloom·k` → exposure → temperature → lift/gamma/gain → contrast (pivot 0.22) →
   saturation → highlight shoulder → death fade to the fog colour → vignette to a cool tint → dither.
10. Grade zones: weight 1 inside a rect, with a smoothstep falloff over `blend` units outside it.
    Normalise overlaps. The fallback grade takes the leftover weight. Evaluate at the camera centre every
    frame, into a preallocated params object.
11. Generate the shader constants from the same frozen object the CPU reference uses, and unit-test the
    reference, including a check that the shader text contains those constants.

## Minimal code (GLSL ES 3.0)

Full, exact listings are in the references. `tap()` samples the source clamped to its sub-rect.
`sw_dither` is ±1 LSB TPDF, and `sw_saturate` mixes toward Rec.709 luma.

```glsl
// Twin: same program as the scene pass, second uniform group with uGlowPass = 1, blendMode 'add'
if (uGlowPass > 0.5) { finalColor = vec4(glowColor * (a * uGlow), 0.0); return; }
```

```glsl
// Down (blend off). vUv spans the destination sub-rect.
vec2 uv = vUv * uSrcScale;
vec2 o = uSrcTexel;
vec3 c = tap(uv - o) + tap(uv + vec2(o.x, -o.y)) + tap(uv + vec2(-o.x, o.y)) + tap(uv + o);
finalColor = vec4(c * 0.25, 1.0);
```

```glsl
// Up (additive onto the level above, no clear)
vec2 uv = vUv * uSrcScale;
vec2 h = uSrcTexel;
vec3 c = tap(uv + vec2(-h.x, 0.0)) + tap(uv + vec2(h.x, 0.0)) + tap(uv + vec2(0.0, -h.y)) + tap(uv + vec2(0.0, h.y));
c += 2.0 * (tap(uv + vec2(-h.x, -h.y) * 0.5) + tap(uv + vec2(h.x, -h.y) * 0.5)
          + tap(uv + vec2(-h.x, h.y) * 0.5) + tap(uv + vec2(h.x, h.y) * 0.5));
finalColor = vec4(max(c / 12.0 + sw_dither(gl_FragCoord.xy) * uDither, vec3(0.0)), 0.0);
```

```glsl
// Composite core (r = aspect-corrected radius, 1 at the corners)
vec3 c = scene + bloom * uBloomIntensity;
c *= uExposure;
c *= max(vec3(0.0), 1.0 + vec3(0.14, 0.025, -0.14) * uTemperature);
c = max(vec3(0.0), c * uGain + uLift * (1.0 - min(c, vec3(1.0))));
c = pow(c, 1.0 / max(uGamma, vec3(1e-3)));
c = max(vec3(0.0), (c - 0.22) * uContrast + 0.22);
c = max(vec3(0.0), sw_saturate(c, uSaturation));
c = shoulder(c);
c = mix(c, uFog, uFade);
c *= mix(vec3(1.0), vec3(0.14, 0.2, 0.32), smoothstep(0.32, 1.0, r) * uVignette);
c += sw_dither(gl_FragCoord.xy);
```

## PixiJS v8.21 specifics

- Targets: `new RenderTarget({ colorTextures: [new Texture({ source })], depth, stencil: false })`, where
  `source = new TextureSource({ format, scaleMode: 'linear', addressMode: 'clamp-to-edge',
  autoGenerateMipmaps: false, antialias: false })`. The scene target needs `depth: true`, because a plain
  `RenderTexture` target has no depth buffer. The glow levels need no depth. Pick the glow format with
  `renderer.context.extensions.colorBufferFloat ? 'rgba16float' : 'rgba8unorm'` (Pixi requests
  `EXT_color_buffer_float` on WebGL2 at startup). Resize with `source.resize(w, h, 1)` only on resize or
  quality change.
- Sub-rects: extend `RenderOptions` with `frame?: Rectangle`. `RenderTargetSystem.bind` honours it as the
  viewport and projection. Keep one preallocated options object per pass and mutate its `Rectangle`.
- Each pass is a `Mesh` of one triangle (`aPosition` = `[0,0, 2,0, 0,2]`) with its own `Shader` in its own
  `Container`. Blend-off passes use a `State` with `blend = false` (MeshPipe rewrites the blend mode only
  when `state.blend` is true). Additive passes use `State.for2d()` + `mesh.blendMode = 'add'`. Never assign
  `state.blendMode`.
- The triangle bypasses Pixi's projection, so the Y flip is yours: `uFlipY = 1` only on the canvas pass.
- The frame is `render(scene)`, then `render(glow)`, then `render(foregroundIntoGlow)`, then N downs and N
  ups, then `render(composite)`. That's `4 + 2·passes` `renderer.render()` calls: 12 at High (4 passes),
  10 at Medium and 8 at Low. Pixi allocates a little per call (it clones the `frame`, for one), and
  ARCHITECTURE §6 asks for ≤ ~10 calls a frame. High is already over that, so fold new effects into the
  composite instead of adding passes.
- Glow slots are containers with `isRenderGroup: true` under `glowRoot → glowScale`. The pipeline gives
  them the camera transform. Views put twins inside their own child containers, with
  `blendMode = 'add'` on the twin or on its container.
- `GlProgram.from({ vertex, fragment, name, preferredFragmentPrecision: 'highp' })`, and every fragment
  starts with `#version 300 es\nprecision highp float;\nprecision highp int;`.

## Tuning knobs

| Knob | Value in repo | Visual effect |
|---|---|---|
| `bloomScale` | 0.5 (High/Med), 0.25 (Low) | Glow buffer resolution. Lower is cheaper and gives wider, softer halos, but emissives thinner than a glow pixel shimmer or drop out. |
| `bloomPasses` | 4 / 3 / 2 (max 6) | Halo radius. Each pass roughly doubles it. |
| `bloomIntensity` (per area) | 0.9 gully … 1.3 shrine | Overall bloom strength, divided by `passes + 1` in the uniform. |
| Twin gains | hero `GLOW_GAIN` 0.85 × part glow 0.3–1, scarf 0.7, moss 0.55, decor 0.9, particle twins α 0.75 / 0.85 | How much each emitter blooms. Keep the hero brightest. |
| `KIT_GLOW_ADD` | 0.6 | In-scene emissive add of the kit Band pass. It is the only glow parallax layers get (baked halos). |
| Hero halo | radius 260 u, α 0.11, `(1−r)^2.2`, flicker ±7 % / ±3 % | Spirit light lifting the nearby world. |
| exposure | 0.95–1.08 | Global brightness, bloom included. |
| temperature | −0.28 … +0.2 | Cool ↔ warm white balance. |
| lift / gamma / gain | lift ≤ 0.03, γ 0.97–1.05, gain 0.9–1.1 | Shadow tint / midtones / highlight tint. |
| contrast (pivot 0.22) | 1.0–1.09 | Separation of the dark mids. |
| saturation | 0.86–1.06 | Colourfulness after contrast. |
| shoulder | 0.78 | Where highlights start rolling off. |
| vignette, inner, tint | 0.2–0.52, 0.32, (0.14, 0.2, 0.32) | Enclosure. A cool falloff instead of black. |
| zone `blend` | world units | Cross-fade distance between area grades. |

## Pitfalls (rules)

- **Never twin parallax-layer content.** The glow buffer has no depth, so the twin blooms through the
  terrain that hides it. Bake the halo into the layer's scene shading instead.
- **Draw the dark foreground into the glow buffer after the twins,** or lanterns bloom through the black
  framing leaves.
- **Keep bright sources out of the bloom when they sit behind occluders.** A bright moon behind far trees
  peeks through the gaps as jagged white shards. Put bright sky features where occluders are sparse, keep
  their halo soft and in the sky shader, and never twin them.
- **Don't build bloom from Pixi `Filter`s or `KawaseBlurFilter`.** Filters render into pooled textures
  without depth. Kawase doesn't downsample (every pass costs full resolution) and pads its input. Own the chain.
- **Allocate once, move sub-rects.** Clamp every sample half a texel inside the sub-rect. Beyond it lies
  either the clear colour (Pixi's clear ignores `frame`) or a stale, larger frame (chain levels are never
  cleared), and an unclamped edge tap turns it into a seam.
- **Don't clear the up-pass targets.** The up pass adds onto the downsample stored there. The down and
  composite passes overwrite their viewport with blending off.
- **Divide by `passes + 1`,** or switching quality presets changes bloom brightness.
- **Prefer RGBA16F.** RGBA8 clips summed twins at 1 and bands dark halos, so dither the last up-pass
  there. In WebGL2, `EXT_color_buffer_float` makes RGBA16F renderable and blendable, and half floats are
  linearly filterable in core. RGBA32F would also need `EXT_float_blend` (blending) and
  `OES_texture_float_linear` (bilinear taps), so don't use it.
- **highp everywhere.** Pixi prepends `precision mediump float;` to fragment shaders by default. Its
  "already has a precision line" check misses a `#version`-led header. A uniform declared in both stages
  at different precision then fails to link. Pass `preferredFragmentPrecision: 'highp'` and start every
  fragment with `GLSL_FRAGMENT_HEADER` (`#version 300 es`, then highp float and int).
- **Never redeclare Pixi's reserved uniforms** (`uColor`, `uTransformMatrix`, `uProjectionMatrix`,
  `uWorldTransformMatrix`, `uWorldColorAlpha`, `uResolution`, `uRound`) with another type. A `vec3 uColor`
  broke fog and shafts. Name your own (`uFog`, `uTint`, `uGlow`).
- **Shaders that share a `GlProgram` declare identical resources in identical order.** The twin's uniform
  group mirrors the scene group, and per-frame values (`uAA`) are written to both.
- **Additive means `mesh.blendMode = 'add'`,** never `state.blendMode`. MeshPipe overwrites it every frame,
  and its setter re-enables blending.
- **A reused render-options object freezes its root transform.** Pixi stores
  `options.transform = container.localTransform` on first use. Keep roots at identity with the scale on a
  child. When you re-render an existing container into another target, pass your own preallocated
  `transform` Matrix and mutate it. `clearColor` must be a preallocated `number[4]`.
- **Textures and targets are premultiplied.** Twins write rgb with alpha 0. Halo textures go through
  premultiply + `BufferImageSource` + `new Texture`, because `Texture.from` caches by the pixel array.
- **No `filters`, `mask` or `cacheAsTexture` under scene or glow slots.**
- **Draw UI and debug overlays after the composite, straight to the canvas,** so bloom, grade, vignette
  and the death fade never touch them.
- **Grade subtly.** Pivot contrast near the scene's real mids (0.22 at night, not 0.5). Keep every area
  close to the baseline, and let a unit test bound each parameter. Fade to the fog colour, not black.
  Put the shoulder after all gains so bloomed emissives roll off instead of clipping into flat white.

## Budgets (1080p, High)

Post fill in full-screen equivalents (computed from the layout functions at render scale 1): the glow
level 0 clear is 0.25, down passes write 0.083, up passes 0.332, and the composite 1.0. The RGBA16F
chain allocation is about 5.3 MiB. The ARCHITECTURE §6 *budgets* (estimates, not measurements) are twin
fill ≤ 0.1, chain ≤ 0.4, glow twins ≈ 10 draw calls, bloom 2 × passes, composite 1, inside a frame target of
about 70 draws (hard cap 120). Twins add no CPU simulation, since they share arrays and buffers. The
debug overlay (F3) counts draw calls by wrapping `gl.draw*` (`DrawCounter` in `src/render/post/gpu.ts`).

## Worked example in this repo

- `src/render/pipeline.ts`: pass order in `render()`, the `OCCLUDE_GLOW_WITH_FOREGROUND` pass,
  `blendGrades` at `cam.cx/cam.cy`, and `reallocate` / `applyScale` (scale containers, glow matrix).
- `src/render/post/postChain.ts`: targets, `FullscreenPass`, `setScale` / `sourceUniforms` (the clamp
  uniforms and the RGBA8 dither flag), `setGrade`, `renderBloom`.
- `src/render/post/viewport.ts`: `layoutTargets` / `layoutSubRects`. `post.glsl.ts`: all post shaders.
- `src/render/post/gradeMath.ts` (`GRADE`, `gradePixel`), `grade.ts` (`zoneWeight`, `blendGrades`),
  `src/content/grades.ts` (the five area grades), `tests/pipe/grade.test.ts`.
- Twins: `src/render/terrain/terrainView.ts` + `terrain.glsl.ts` (moss), `src/render/fx/decor.ts` (kit
  Glow mode, light pools), `src/render/fx/particles.ts` (shared-array twin),
  `src/render/hero/heroView.ts` (part twins, scarf twin, halo), `src/render/entities/orbs.ts`.
- Baked halos: `src/render/gen/raster.ts` (`haloAt`, finalize), `src/render/layers/kit.glsl.ts`.
- `src/render/shaders/common.ts`: `GLSL_FRAGMENT_HEADER`, `GLSL_DITHER`, `GLSL_COLOR`.
- `src/render/layers/sky.glsl.ts`: the moon's analytic halo (never twinned). `src/render/post/context.ts`
  plus `overlayOptions` in `pipeline.ts`: the debug overlay drawn after the composite.
- Browser-free check: `node tools/preview/pipe/scene.ts <outDir>` writes `scene-grades.png` (the five
  grades side by side, bloomed and graded on the CPU).

## Related skills

- [**sdf-silhouettes**](../sdf-silhouettes/SKILL.md): grows the flora, lanterns and thorns whose
  emissive parts and baked halos this skill lights.
- [**channel-packed-atlas**](../channel-packed-atlas/SKILL.md): the B (emissive) channel and the kit
  shader modes. Band mode adds baked glow in-scene, and Glow mode is the twin.
- [**layered-atmosphere**](../layered-atmosphere/SKILL.md): the value ramp and fog that decide what
  reads as far. Bloom only on the near planes keeps that depth readable.
