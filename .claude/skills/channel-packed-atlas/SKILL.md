---
name: channel-packed-atlas
description: Channel-packed material atlas plus tight hull meshes for layered 2D scenes (parallax forests, silhouettes, foliage, props, painted backdrops). Bake each element once into straight RGBA8 (R luminance detail, G rim-light mask, B emissive mask, A coverage), pack it with mip-safe gutters and upload it premultiplied, so one shader tints, fogs, rim-lights and glows every layer from uniforms. Split each element's alpha into an opaque core (depth pre-pass, blending off, early-Z) and a soft band of column-strip rects to cut overdraw, and merge instances into static per-chunk meshes (Uint16, per-vertex sway, depth and tint). Also covers painted plates (PNG to WebP + KTX2 bake, hull polygons, chunk streaming with fallback). Use for texture atlases, overdraw or fill-rate problems, rim light, emissive masks, mipmap bleeding, alpha hulls, mesh batching, KTX2/Basis loading and PixiJS v8 custom meshes.
---

# Channel-packed atlas and tight hull meshes

With this technique, one texture and one shader program draw every silhouette in a layered 2D scene. In Spiritwood,
75 procedural elements in a 2048×1792 atlas (19.6 MB with mips) feed 10 parallax layers (8 depth-tested, 2 blended
foreground frames; 43 static meshes), plus decor and its glow twins. The debug overlay counted 58–85 draw calls for a
whole High-quality frame (a software-renderer capture, so there are no GPU timings).

## When to use

- The scene has many layers of the same kind of content (trunks, canopies, roots, grass, rocks, vines),
  and the layers differ only in tint, fog, rim strength and glow. Aerial perspective then comes from uniforms, and you don't repaint anything.
- You are fill-rate bound: large alpha-mapped sprites stacked 10 or more deep, especially on integrated GPUs.
- You have procedural (CPU SDF) elements, or painted or AI plates, that need the same shading and the same tight meshes.
- Don't use it for a handful of sprites (plain Sprites are fine) or for art whose colour varies per texel.
  Use the plate path for that. It keeps the colour texture but reuses the meshes and the program.

## Core idea

- **Shading = shape × material × light, and only the per-texel part goes in the texture.** The per-layer
  palette (tint, fog, rim colour, glow colour) is a set of uniforms. The texture stores only what varies per texel:
  R brightness detail (0.5 = neutral), G how strongly this edge faces the light, B which parts glow, A coverage.
  The same atlas then reads as pale, foggy and soft at the back and as dark, crisp and rim-lit at the front.
- **Hug the alpha, and split opaque from soft.** Each element becomes a few dozen axis-aligned rects (69 on average here)
  covering its visible texels. The rects wholly on opaque texels form the *core*, drawn with blending off and depth write on,
  near → far, so early-Z rejects everything behind it. The rest form the *soft band*, blended far → near and depth-tested.
  The rects cover 34% of the element rect area (measured), so the GPU never rasterises the other 66%, and opaque interiors are shaded about once per pixel.
- **Merge everything static at load time.** Instances become one static mesh per chunk per pass. Per-instance data
  (depth, sway, glow colour, brightness) goes into vertex attributes, so drawing a chunk takes one draw call per pass.

## Recipe

### A. Bake the channels (engine-agnostic)

1. Rasterise each element into a signed-distance buffer (negative inside) with a material id, an emissive
   buffer and a halo buffer (see sdf-silhouettes). Give every element rect a transparent margin
   (`ELEMENT_MARGIN = 6`, at least the hull `pad`), and fade alpha to 0 across it, except on a deliberately cut edge.
2. Finalize every texel into straight RGBA8 in one row-major pass:
   - **A** = `coverage(d + noise·disp[mat], softness)` (smoothstep AA) × the vertical fade × the edge fade.
   - **R** = `0.5 + (materialNoise + 0.07·(0.5 − y/h))·detail`. This is per-material grain plus a baked top-light gradient.
   - **G** = the rim, `a·((1 − s1)·0.7 + (1 − s2)·0.5)·RIM[mat]·rimStrength`, where s1 and s2 are the final coverage one
     rim-width and 0.45 rim-width *toward the light*. A texel lights up when it is covered and the texels toward the light are not.
   - **B** = emissive (max-blended discs). A baked halo extends A beyond the shape as "pure light": where the halo exceeds
     the shape's coverage, B blends toward 1, G toward 0 and R toward 0.5.
   - **RGB = 0 wherever the A byte is 0.** Premultiplying would zero them anyway; this keeps the straight buffer, the
     channel dumps and any straight-alpha consumer clean.
3. Pack the rects with a skyline bottom-left packer: tallest first, then widest, with a stable tie-break. Leave
   `gutter ≥ 2^maxMip` texels between rects and at the border (on top of each element's margin), and throw on overflow instead of clipping.
4. Upload the atlas premultiplied, generate mipmaps, and sample it with an explicit LOD clamped to `maxMip`. Gutters and core
   insets only protect that many mip levels.

The rim is a directional edge detector on the *final* coverage, so it follows noise displacement, smooth unions and carved
holes with no extra work. For a clean SDF, an analytic alternative (not used or tested in this repo) is
`a · saturate(dot(normalize(∇d), L)) · (1 − smoothstep(0, w, −d))`, with ∇d pointing outward and L toward the light.
The repo's two-tap form, from `ElementRaster.finalize`, with L = (−0.55, −0.83) toward the upper-left moon (y down):

```ts
const lx1 = Math.round(-0.55 * rimWidth);
const ly1 = Math.min(-1, Math.round(-0.83 * rimWidth));
const lx2 = Math.round(-0.55 * rimWidth * 0.45);
const ly2 = Math.min(-1, Math.round(-0.83 * rimWidth * 0.45));
// per texel, after alpha[i] = a (rows above are already final, so one pass suffices):
const s1 = alphaAt(alpha, w, h, x + lx1, y + ly1);
const s2 = alphaAt(alpha, w, h, x + lx2, y + ly2);
rim = clamp01(a * ((1 - s1) * 0.7 + (1 - s2) * 0.5) * (RIM[m] as number) * rimStrength);
```

### B. Split every element into core and soft band (engine-agnostic)

5. Build two masks from alpha. `visible` is `a > 1`, dilated by `pad = 2^maxMip`, so filtered fringes are not clipped.
   `opaque` is `a ≥ 254`, eroded by `coreInset = 1 + 2^maxMip`, so the core never samples a translucent texel at any mip level up to maxMip.
6. Walk columns of `cell` texels. In each column, find the visible row spans: snap them outward to `snap`, merge spans
   separated by less than `minGap`, and cap the count at `maxSpans` by filling the smallest gaps. Inside each span, take the
   longest run where the whole column is core, snap it inward, and keep it if it is at least `minCore` rows. The span becomes
   soft above, core, soft below.
7. Where adjacent columns produce the same `(y0, y1, kind)` rect, merge them into one wide rect. The tested invariants: every
   visible texel is covered exactly once, core rects lie only on eroded-opaque texels, and no two rects overlap. Run the split
   on a conservative 2× downsample (a block is visible if any of its texels is, opaque only if all are). It is 4× cheaper, and the invariants still hold.
8. For swaying elements, split the rects on a *global* row grid (`SWAY_ROW_STEP = 24`) so the vertex bend has
   vertices to bend. For top-cut elements, split at the stretch row as well.

### C. Merge the instances into static chunk meshes (engine-agnostic)

9. Bucket the instances by anchor x into chunks of `chunkWidth` layer units (at least 2048; layers with fx ≤ 0.3 use a single chunk).
   Within a chunk, emit core rects front → back (for early-Z) and band rects back → front (painter's order).
10. Use one interleaved 32-byte vertex (`KIT_STRIDE_BYTES`):

| attribute | format | offset | content |
|---|---|---|---|
| `aPosition` | float32x2 | 0 | layer-space position |
| `aUV` | float32x2 | 8 | atlas UV of the rect corner |
| `aSway` | float32x2 | 16 | `weight² × amplitude`, instance phase |
| `aDepth` | float32 | 24 | `depthForParallax(f) − k·DEPTH_INSTANCE_EPS` (k = painter order) |
| `aTint` | unorm8x4 | 28 | glow rgb + per-instance shade (written through a `Uint32Array` view) |

11. The sway weight is 0 at the anchor and 1 at the far end of the element, and squaring it keeps the base planted. Pad each chunk's
    culling bounds by 1.4× the largest amplitude. The core and the band get the *same* attribute, so they bend together.
12. Flush a mesh before it passes 65,535 vertices (Uint16 indices), then upload it once into static buffers.
13. Draw in up to three passes:
    - Cores: blending off, depth test and depth write on. The shader outputs alpha 1 and never discards.
    - Bands: premultiplied blending, depth test on, no depth write.
    - Glow twins: the emissive-only instances again, drawn additively into the glow buffer (see glow-bloom-grade). That buffer
      has no depth, so nothing occludes a twin. Of the kit content, only decor near the gameplay plane is twinned; parallax layers keep their glow in-scene (the B term of the core and band modes).

A degenerate-UV quad that samples the centre of a solid block element fills flat ground in the same draw call.

### D. Painted plates (file-backed, same program)

14. Bake: split the RGBA image into 1024² chunks (skip empty ones), write each as a palette PNG, a WebP and a mipmapped KTX2
    (ETC1S) with sharp and ktx2-encoder, add per-chunk polygons, then write and validate the manifest. The `hull` takes the min top
    and max bottom of each 16-texel strip. The `opaqueHull` takes the strip runs of α ≥ 254, inset by 5, and all its strips must share one row so the polygon can't fold.
15. Before encoding, set the RGB of transparent texels to the surrounding colour (here the mist colour). WebP and KTX2
    store straight alpha, and when they are filtered, black transparent texels bleed dark fringes into the edges.
16. At runtime, stream the chunks near the camera (nearest first, at most 2 in flight, within a byte budget), pick KTX2, then
    WebP, then PNG, and ear-clip the polygons into the same vertex format. Draw `opaqueHull` in the core pass and `hull` in the
    band pass, both at the layer's depth. Where the band overlaps the core, its fragments get exactly the same depth (z comes
    from `aDepth` alone, not from the transform) and fail LESS, so early-Z drops them and you don't need to subtract the polygons.

### Shader (GLSL ES 3.0, excerpt of `kit.glsl.ts` with the constants inlined and the plate branch omitted)

Uniforms and the helpers `fogAmount`, `sw_dither`, `sw_luma` are in the full program ([atlas-and-shader §8–9](references/atlas-and-shader.md)).

```glsl
vec4 sampleClamped(vec2 uv) {
  vec2 size = vec2(textureSize(uTexture, 0));
  vec2 d = max(abs(dFdx(uv * size)), abs(dFdy(uv * size)));
  float lod = clamp(log2(max(max(d.x, d.y), 1e-6)), 0.0, 1.0); // 1.0 = KIT_MAX_MIP
  return textureLod(uTexture, uv, lod);
}
void main() {
  vec4 t = sampleClamped(vUV);             // premultiplied
  float a = t.a;
  vec3 dither = sw_dither(gl_FragCoord.xy);
  vec3 ch = t.rgb / max(a, 1e-4);          // back to straight channel data
  float k = (0.5 + ch.r) * (0.8 + 0.4 * vTint.a);
  vec3 c = uTint * k + uRimColor * (ch.g * uRim * 0.5);
  c = mix(c, vec3(sw_luma(c)), uDesat);
  float fog = fogAmount();
  c = mix(c, uFogColor, fog);
  vec3 g = vTint.rgb * uGlow;
  float e = ch.b * (1.0 - fog * 0.6) * step(1e-4, uGlow);
  c = mix(c, g * 1.25, e);
  if (uMode < 0.5) finalColor = vec4(c + dither, 1.0);                          // core
  else if (uMode > 3.5) finalColor = vec4(g * e * a, 0.0);                      // glow twin
  else finalColor = vec4((c + dither) * a + g * (e * a * 0.6), a);              // band
}
```

Sway lives in the vertex stage: `p.x += (sin(uTime*1.35 + aSway.y + p.x*0.0045)*0.75 + sin(uTime*0.52 + aSway.y*1.7 + p.x*0.0013)*0.5) * aSway.x * uSway;`.

## PixiJS v8.21 specifics

- **Upload.** Don't use `Texture.from(pixels)`. It caches by the resource object, so a reused scratch buffer returns a stale texture.
  Premultiply the buffer in place, then build the texture yourself with
  `new Texture({ source: new BufferImageSource({ resource, width, height, format: 'rgba8unorm', alphaMode: 'premultiplied-alpha', scaleMode: 'linear', autoGenerateMipmaps: true }) })`.
  `scaleMode: 'linear'` also sets the mipmap filter, so the clamped `textureLod` is trilinear. The repo's `textureFromRgba` is listed in [atlas-and-shader](references/atlas-and-shader.md).
- **Program.** Create it once with `GlProgram.from({ vertex, fragment, name, preferredFragmentPrecision: 'highp' })`, and start the
  fragment source with `#version 300 es\nprecision highp float;`. Without either, Pixi injects `precision mediump float`, and any
  uniform that both stages use (vertex default highp) fails to link. Every `Shader` that shares the program must declare the same resources in the same order
  (`uTexture`, `kitLayer`, `kitPass`), because Pixi caches the uniform sync per program. Share one layer `UniformGroup` between
  a layer's core and band shaders, and give a glow twin its own group when its values differ (decor's twin uses glow 0.9, its scene pass 1).
- **Uniform names.** Never redeclare Pixi's reserved names (`uColor`, `uTransformMatrix`, `uProjectionMatrix`,
  `uWorldTransformMatrix`, `uWorldColorAlpha`, `uResolution`, `uRound`) with a different type. The layer tint is `uTint`.
- **Geometry.** Use `new Buffer({ data, usage: BufferUsage.VERTEX | BufferUsage.STATIC })` and `BufferUsage.INDEX | STATIC`
  for the indices, and set `autoGarbageCollect = false` on the buffers and the `Geometry`. Name the position attribute `aPosition`:
  `Geometry.bounds` reads it (stride-aware). Those bounds ignore the vertex-shader sway, so cull chunks with your own padded bounds.
- **Depth.** The scene target must be `new RenderTarget({ colorTextures: [tex], depth: true })`, because a plain RenderTexture has no
  depth buffer. Pixi never calls `gl.depthFunc`, so the test is LESS. Use a core `State` with blend off, depth test and depth write on,
  and a band `State` with blend on, depth test on and depth write off. Sprites, Graphics and ParticleContainers ignore depth, and filters and
  `cacheAsTexture` render into pooled textures that have no depth. Keep all of them, and masks (the context has no stencil), out of these passes.
- **Additive twins.** Set `mesh.blendMode = 'add'`, never `state.blendMode`. MeshPipe overwrites the state's blend mode every frame.
- **KTX2.** Add `import 'pixi.js/ktx2'`. Call `setKTXTranscoderPath` with **absolute** URLs built as `new URL('transcoders/ktx/libktx.js', document.baseURI).href`
  (the same for the `.wasm` file), because the worker resolves relative paths against `location.origin`. Serve (dev) and emit (build) the
  transcoder from `node_modules/pixi.js/transcoders/ktx` with a small Vite plugin, so it always matches the installed Pixi (the repo never copies it into `public/`).
  The KTX2 worker delivers `alphaMode: 'no-premultiply-alpha'`, while PNG and WebP loaded through `Assets` are
  premultiplied on upload. Branch the shader on `texture.source.alphaMode` (`uStraight`). Release a texture with `Assets.unload(url)`.

## Tuning knobs

| Knob (repo value) | Visual / cost effect |
|---|---|
| `KIT_MAX_MIP` (1) | A higher value aliases less when zoomed out or at low render scale, but needs wider gutters and insets, which shrink the cores. |
| `KIT_GUTTER` (4), `ELEMENT_MARGIN` (6) | Together they stop neighbours bleeding at mips up to maxMip. The margin must be at least the hull pad (tested). |
| hull `cell` (6) | Narrower columns give a tighter hull (less fill) but more rects and vertices. |
| hull `maxSpans` (4), `minGap` (4) | These cap the quads per column. Filled gaps become soft overdraw. |
| hull `coreInset` (1 + 2^maxMip), `pad` (2^maxMip) | The mip-safety margins. Don't lower them. |
| hull `minCore` (8), `snap` (2) | Larger values mean fewer, bigger rects and less core. |
| `SWAY_ROW_STEP` (24) | Smaller steps give a smoother bend at the cost of more vertices. |
| finalize `softness` (1.25; 9 on foreground frames, 6 on their vines) | The AA width in texels. Large values bake a blur, which is cheaper than a filter. |
| finalize `rimWidth` / `rimStrength`, `RIM[mat]` | Rim thickness in texels and per-material response. Use 0 for dark foreground frames. |
| `DISP[mat]` / `FREQ[mat]`, `dispScale` | Edge raggedness per material (leaves 4.5 texels, bark 1.2). |
| `unitsPerTexel` (far/mid 2, near 1–1.4, blurred fg 2.2) | Texel density per element. Coarse far texels give softer edges for free, which is aerial perspective. Give near layers their own finer elements instead of scaling up far ones. Stay within 2× minification, because the LOD clamp stops at mip 1 (inferred from the clamp, not measured; at the Low tier's floor, 720p × 0.5 render scale ≈ 0.33 px/u, 1 u/texel elements reach ~3×). |
| layer `uRim` × 0.5, `uGlow`, instance `shade` (0.38–0.62) | Rim and glow per layer. Shade varies brightness by about ±5% so repeats don't read as clones. |
| plate `CHUNK` (1024), `TEXEL_SCALE` (1.5), strip 16 / inset 5 | Chunk granularity, world units per texel, and hull tightness. |
| WebP q84 / alpha 90, ETC1S `qualityLevel` 160, streamer margin 480, 2 in flight | Plate size, quality and prefetch behaviour. |

## Pitfalls (rules)

- Gutters must be at least `2^maxMip` on top of a transparent element margin of at least `pad`, the core inset at least
  `1 + 2^maxMip`, and the shader must clamp the LOD to maxMip. If any of these is missing, neighbours bleed in at far mips, and
  an opaque core (alpha forced to 1, no discard) samples translucent texels and grows a hard edge.
- Opaque-pass shaders never `discard` or write `gl_FragDepth`, because either one disables early-Z. The core geometry itself has to be
  exact, which is what the invariant tests (`tests/world/hull.test.ts`, and the core-on-opaque check in `kit.test.ts`) guard.
- Store the channels straight, zero RGB where A = 0, premultiply once at upload, and divide by `max(a, 1e-4)` before using
  R, G or B as data. Filtering or mip-averaging straight channels pulls in the zero RGB of transparent neighbours and darkens the edges.
- `textureFromRgba` premultiplies the caller's buffer in place. Keep only the metadata afterwards, or copy the buffer first.
- The rim reads the *final* alpha, so vertical fades (`fadeBottom`) leak a faint false rim (G up to ≈ 0.2, measured) across the
  whole fade band. It is visible in the G dump at the bases of far trees. Hide those bases in fog, or compute the rim from the coverage before the fade.
  The single-pass rim also only works because the taps point to rows that are already final (light from above). A light from below needs a two-pass finalize or a bottom-up row order.
- Core and band must be displaced identically, with the same attribute and the same formula, and split on the same global row grid. Otherwise seams open while
  the elements sway. Pad the culling bounds by the sway amplitude, or the tips pop at chunk edges.
- Traced hull polygons contain duplicate points and collinear runs. Use an ear clipper that skips duplicates and drops zero-area
  corners when it stalls, and assert that the triangle area equals the polygon area for every shipped hull (`tests/world/misc.test.ts`). A hull strip with
  no visible texels pinches the polygon, so fall back to the bounding box. All opaque-hull strips must share one row.
- A KTX2 load whose worker or WASM is blocked (CSP) never settles. Give it a deadline (12 s), fall back to WebP/PNG, disable KTX2 for the rest of the session, and unload any late arrival.
- Prefetch only within the byte budget, or a budget smaller than the wanted set makes loads and evictions thrash. Visible chunks always load. A chunk that failed for good is never offered again.

## Worked example in this repo

- `src/render/gen/raster.ts` `ElementRaster.finalize`: channel packing, rim taps, halo-as-light, and zero RGB where A = 0.
  Browse `src/render/gen/kitElements.ts` for per-element `finalize` options and `unitsPerTexel`.
- `src/render/gen/kit.ts`: `KIT_MAX_MIP`, `KIT_HULL`, gutters, and the per-element pipeline (raster → pack → alpha copy →
  `computeSplitHullHalf` → row splits). `generateKitAsync` yields between elements so the boot screen stays responsive (about 400 ms).
  Also `pack.ts` (skyline packer), `hull.ts` (split hull), `polygon.ts` (ear clipping) and `particleAtlas.ts` (same packer, white tintable frames, pow2 height).
- `src/render/util/texture.ts` (upload and budget), `src/render/layers/assets.ts` (mipmapped kit and particle atlases, and
  frame `Texture`s sharing one source), `src/render/util/states.ts` (core, sky and band `State`s), `src/render/util/camera.ts` (`depthForInstance`).
- `src/render/layers/kitMesh.ts` (`buildChunks`, `packTint`, sway weights), `src/render/layers/geometry.ts` (static
  interleaved geometry), `src/render/layers/kit.glsl.ts`, `kitShader.ts` and `kitShading.ts` (the program, the modes, and a TS
  reference `shadeKit`), `src/render/shaders/common.ts` (GLSL header and `pixiClipPosition`).
- `src/render/layers/parallaxStack.ts` (core and band containers per layer, States) and `src/render/fx/decor.ts` (blend-only
  decor, and glow twins with `emissiveOnly` + `KIT_MODE.Glow` + `blendMode = 'add'`).
- Plates: `tools/plates/bake-plates.ts` (`npm run plates`), `tools/plates/paint.ts` (`chunkHulls`, colour dilation),
  `src/render/layers/plates.ts`, `src/assets/{textures,streamer,manifest}.ts`, `src/contracts/assets.ts`. The layer is
  `L3-plate-treeline` in `public/layers/forest.plates.manifest.json` (open it with `?manifest=plates`). Each chunk's hull covers about 63% of
  the chunk and its opaque core 10–11%.
- Inspect the atlas without a browser: `node tools/preview/world/kit-preview.ts <outDir>` writes the composite, the R/G/B/A
  dumps and `kit-hulls.png` (core green, soft red). Measured: 5161 rects, hull 34% of the element rect area, core 32% of
  the hull, and at most 11k vertices per chunk mesh.
- Tests: `npx vitest run tests/world/{hull,kit,kitMesh,misc,textures,streamer}.test.ts --maxWorkers=2`.

Full listings for reuse: [atlas and shader](references/atlas-and-shader.md), [split hull](references/split-hull.md),
[chunk meshes](references/chunk-meshes.md), [painted plates](references/painted-plates.md).

## Related skills

- [**sdf-silhouettes**](../sdf-silhouettes/SKILL.md): how the elements are drawn into the distance buffer (organic clumps, fractal edges, readable at far and near scale). This skill starts where that one's distance field ends.
- [**layered-atmosphere**](../layered-atmosphere/SKILL.md): the per-layer value ramp (`tint`, `fog`, `desaturate`, height mist) that this shader's uniforms implement, and the fog gaps between planes.
- [**glow-bloom-grade**](../glow-bloom-grade/SKILL.md): where the B channel ends up. Glow twins render into the glow buffer and feed the owned bloom chain and the grade.
