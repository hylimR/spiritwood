---
name: layered-atmosphere
description: Deep, atmospheric 2D parallax stacks for side-scrollers and platformers (night forests, misty layered scenes, caves, cities). One parallax transform view = (p − C·f)·zoomF + V/2 and an aspect-independent extent so seeded placement never reshuffles; an aerial-perspective value ramp (per-layer tint, desaturation, fog, rim light, a luminous height mist and clearings that leave air between planes); a shader sky (gradient, horizon glow, moon corona, stars), eroding fog bands, light shafts, vertex wind sway, dithered dark gradients; and an overdraw-killing depth pre-pass (opaque cores near→far with early-Z, sky only on uncovered pixels, soft bands far→near without depth write, SDF terrain as the nearest opaque plane) with the PixiJS v8 recipe. Use when parallax layers look flat, muddy or like one wall, for fog, mist, haze, depth, sky or moon work, or parallax fill-rate problems.
---

# Layered atmosphere: parallax depth, aerial perspective and a depth pre-pass

Spiritwood's background is a sky shader, 8 depth-tested kit layers (f 0.08–0.9), the terrain, 2 fog bands and 2 dark
foreground frames. Far layers are pale indigo, flat and soft. Near layers are near-black with bright moonlit rims, and every plane's lower edge
dissolves into a luminous mist. On the synthetic preview level, the CPU scene preview reports 1.12–1.53 screens of opaque core and 1.18–1.49 screens
of soft band across its five cameras, in 18–30 kit draws. These are CPU estimates, not GPU measurements. Thanks to the pre-pass, the opaque part is shaded about once per pixel.

## When to use

- A 2D scene needs depth from many planes (parallax forests, cities, caves, underwater), and its layers read as one flat wall, look muddy, or
  lose the foreground/background separation.
- You want fog, mist, haze, a moonlit or sunset sky, or light shafts that sit *between* planes rather than on top of everything.
- Stacked full-screen alpha layers make you fill-rate bound (integrated GPUs, 10+ layers).
- Not for a single static backdrop image, and not for true 3D (use a real depth-sorted 3D camera).

## Core idea

- **Depth is a value ramp, not a layer count.** Every plane is shaded by one program from a handful of uniforms (`tint`, `desaturate`, `fog`,
  `fogColor`, `rim`, mist). Far planes are lighter, bluer, flatter and softer. Near planes are darker, more saturated, more rim-lit and crisper.
  A **height mist**, brighter than the plane behind, dissolves each plane's base, and **clearings** open gaps in x. Together they leave *air* between planes.
- **Parallax is one affine map per layer:** `view = (p − C·f)·(1 + (z−1)·f) + V/2`. Static geometry covers the union of
  every view the clamped camera can show at any supported aspect, so nothing depends on the live window.
- **Treat the stack like a 3D scene with a depth buffer.** Opaque interiors draw first, near → far, writing depth, so early-Z
  rejects everything hidden. The sky fills only what is left. Translucent edges blend far → near, tested against depth but not writing it.

## Recipe

**A. Parallax space** (engine-agnostic; derivation in [parallax and ramp](references/parallax-and-ramp.md))
1. Choose `f = (fx, fy)` per layer: 0 is at infinity, 1 is the gameplay plane, more than 1 is foreground. Space the depth-tested layers at least 0.02 apart and
   keep them at 0.95 or less. Use `fy = 0` to pin a layer to the screen vertically (fog bands, foreground frames).
2. Place each layer every frame with one function (scale = `zoomF`, position = `V/2 − C·f·zoomF + shake·min(f,1)`). Keep exactly one implementation.
3. Build static content over `coverageExtent`: the union of `layerExtent(W, H, VIEW_H·MIN_ASPECT, …)` and the same at
   `MAX_ASPECT`, at the minimum zoom. The width is `f·W + (1−f)·Vw`. Seed placement from the layer's seed only, never from the window.

**B. Aerial-perspective ramp and air**
4. Shade every layer with one program:
   `c = tint·(0.5+R)·(0.8+0.4·shade) + rimColor·G·rim·0.5`, then `c = mix(c, luma(c), desat)`, then `c = mix(c, fogColor, fog)`
   (distance), then `c = mix(c, mistColor, m)` (height mist), then emissive glow attenuated by `1 − 0.6·(fog + (1−fog)·m)`.
5. Height mist: `m = min(1, t²·mist)`, where `t = clamp((layerY − mistY)/mistDepth)` and `mistY = baseline − 0.25·mistDepth`. Use the unswayed y.
   The mist colour is the fog colour plus a small teal lift (`mistLift`), so the mist glows rather than greys. Far recipes use `mist 1` (the base dissolves fully),
   mid 0.9 and near 0.75.
6. Ramp the parameters monotonically from far to near: `fog` 0.70 → 0.04, `desat` 0.25 → 0, `rim` 0.10 → 0.85, tint and fog colour darker
   (indigo → teal-navy). Step the baselines down (0.62 → 0.88 of the extent). Make every plane's full mist brighter than the body of the plane behind it (true for every forest pair).
   Check it with `node .claude/skills/layered-atmosphere/scripts/value-ramp.ts`.
7. Open clearings: gap noise per stream, and no trunks within 320 layer units of gameplay landmarks (`x·f`). Use coarser texels for far elements
   (softer edges for free) and a baked bottom fade. Foreground frames are a separate regime: near-black, no rim, baked blur.

**C. Sky, fog bands, shafts, sway, dither** (full shaders in [shaders](references/shaders.md))
8. Sky: one view-space quad at depth 0.99 with a 4-stop gradient, a luminous horizon band (an asymmetric Gaussian that drifts with camera y at
   parallax 0.06, behind the far treeline bases), faint cloud streaks from the same noise, a moon with a three-lobe corona, limb darkening and maria,
   and jittered-grid stars that fade into the haze and near the moon.
9. Fog bands: one quad each, spanning `y ± height` (at most ⅓ of the screen tall). The noise is stretched about 3.3:1 in x, with a threshold that rises toward
   the top, so the base is a dense bank and the top erodes into wisps with brighter crests. The colour is brighter than the scene, and they sit in front of the gameplay plane
   (fx > 1, fy 0) at low density (0.16–0.22).
10. Light shafts: additive trapezoids with exact `u = (x − left)/width`, streaks along the shaft, and a travelling shimmer, at depth 0.055.
11. Wind sway: in the vertex shader, displace x by `wave(time, phase, restX)·weight²·amp`. Core and band use the same attribute and formula.
12. Add ±1 LSB TPDF dither to the straight colour of every dark-gradient output (sky, kit layers, fog bands, terrain) before premultiplying.

**D. Depth-ordered passes** (the full model and the Pixi code are in [depth pre-pass](references/depth-prepass-pixi.md))
13. Give the scene target a depth buffer. Clear depth to 1 and use depth test LESS.
14. `depth(f) = 0.05 + 0.9·(1 − f)`. Per instance: `depth − k/65536`, with painter order k ≤ 1024 so instances never cross into the next layer.
    Write it as `gl_Position.z = depth·2 − 1` (w = 1).
15. Pass order:
    - **opaque**: terrain core, then layer cores near → far. Blend off, depth write on, indices front → back.
    - **sky**: blend off, depth test on, no write.
    - **bands**: far → near, premultiplied, test on, no write, indices back → front.
    - **shafts**: additive, depth 0.055, test on, no write.
    - Everything else draws on top without depth.
16. Opaque and sky shaders never `discard` or write `gl_FragDepth`. Either one disables early-Z.

**E. Terrain as the nearest opaque layer** (see [terrain](references/terrain-layer.md))
17. Build an SDF of the solid tiles: hashed per-corner radii, and displacement by facing (floors ±1.2 u, walls ±3.5 u, undersides with lumps and pendant drips).
    Run marching squares on a half-offset 12-u grid, refining crossings against the exact field. Emit a core mesh at `DEPTH_TERRAIN` whose vertices carry depth-inside,
    moon-facing and baked spill; a feather strip about 2.5 px wide; and a moss lip on up-facing edges.

## Minimal code

The repo's parallax placement uses only `scale.set` and `position.set`, so any scene-graph node works (`src/render/util/camera.ts`):

```ts
export function applyParallax(container: Container, cam: CameraFrame, fx: number, fy: number): void {
  const zx = zoomForParallax(cam.zoom, fx);
  const zy = zoomForParallax(cam.zoom, fy);
  const sx = cam.shakeX * Math.min(fx, 1);
  const sy = cam.shakeY * Math.min(fy, 1);
  container.scale.set(zx, zy);
  container.position.set(cam.viewW * 0.5 - cam.cx * fx * zx + sx, cam.viewH * 0.5 - cam.cy * fy * zy + sy);
}
export function depthForParallax(f: number): number {
  return 0.05 + 0.9 * (1 - clamp(f, 0, 1));
}
export function depthForInstance(f: number, k: number): number {
  return depthForParallax(f) - k * DEPTH_INSTANCE_EPS;
}
```

The kit fragment core (GLSL ES 3.00, `src/render/layers/kit.glsl.ts`, constants resolved):

```glsl
float mistAmount() {
  float t = clamp((vLayerY - uMistY) / max(uMistDepth, 1e-3), 0.0, 1.0);
  return min(1.0, t * t * uMist);
}
// after un-premultiplying the atlas sample: ch = R detail, G rim mask, B emissive
float k = (0.5 + ch.r) * (0.8 + 0.4 * vTint.a);
vec3 c = uTint * k + uRimColor * (ch.g * uRim * 0.5);
c = mix(c, vec3(sw_luma(c)), uDesat);
float m = mistAmount();
c = mix(mix(c, uFogColor, uFog), uMistColor, m);
float fog = uFog + (1.0 - uFog) * m;
vec3 g = vTint.rgb * uGlow;
float e = ch.b * (1.0 - fog * 0.6) * step(1e-4, uGlow);
c = mix(c, g * 1.25, e);
// core: finalColor = vec4(c + dither, 1.0);
// band: finalColor = vec4((c + dither) * a + g * (e * a * 0.6), a);
```

## PixiJS v8.21 specifics

- Scene target: `new RenderTarget({ colorTextures: [texture], depth: true, stencil: false })`. A `RenderTexture` target has
  **no depth buffer**, and the test then silently passes everything. `renderer.render({ …, clear: CLEAR.ALL })` clears depth to 1.0.
- Pixi never calls `gl.depthFunc`, so the test is LESS and equal depths fail.
- The three States in `src/render/util/states.ts`:
  - opaque: `blend=false, depthTest=true, depthMask=true`;
  - sky: `blend=false, depthTest=true, depthMask=false`;
  - transparent: `blend=true, depthTest=true, depthMask=false`.
- Additive meshes: `mesh.blendMode = 'add'`, **never** `state.blendMode`. MeshPipe overwrites it every frame, and the setter
  turns blending back on.
- Slot containers are `isRenderGroup: true`. The `opaque` and `background` slots have `sortableChildren = true`. Cores get
  `zIndex = round(depth·1e6)` (near first) and bands `−round(depth·1e6)` (far first), so draw order doesn't depend on `addChild` order.
- Plain Sprites, Graphics and ParticleContainers have no depth test, so they may be used only from slot `terrain` onward. `filters`, `mask` and
  `cacheAsTexture` render into depthless pooled textures and are forbidden under any scene or glow slot.
- Fragment shaders start with `#version 300 es\nprecision highp float;`, and pass `GlProgram.from({ …, preferredFragmentPrecision: 'highp' })`.
  Otherwise Pixi's default `mediump` makes a uniform shared with the vertex stage fail to link.
- Never redeclare Pixi's uniforms (`uColor`, `uTransformMatrix`, `uProjectionMatrix`, `uWorldTransformMatrix`,
  `uWorldColorAlpha`, `uResolution`, `uRound`) with another type. A `vec3 uColor` broke fog and shafts. Use `uFogColor`, `uTint`, `uViewSize` and similar names.
- Everything is premultiplied: bands and fog output `vec4(rgb·a, a)`, cores and the sky output alpha 1.
- The reused render-options object freezes the root transform. Keep the root at identity and scale a child container.

## Tuning knobs

| Knob (forest value) | Visual effect |
|---|---|
| `fog` per layer (0.70 → 0.04) | Distance. It is the main value separator between planes. |
| `fogColor` per layer (`#2c4c78` → `#0f2234`) | Colour of the air. Keep far air brighter than near air, so depth reads as receding light. |
| `desaturate` (0.25 → 0) | Colour drains with distance. Saturation is reserved for the near planes and the hero. |
| `tint` (`#1a2a50` → `#050c15`) | Body colour before fog. Darken it toward the viewer. |
| `rim` (0.10 → 0.85), `KIT_RIM_SCALE` 0.5 | Moonlit edges. Contrast grows toward the viewer, and near silhouettes pop. |
| recipe `mist` / `mistDepth` / `mistLift` (far 1 / 260 / 0, mid 0.9 / 360 / (0, .035, .03), near 0.75 / 400 / (0, .025, .025)) | How much of each plane's base dissolves, over what height, and how luminous the mist is. This is the air in y. |
| `baseline` (0.62 → 0.88) | Where each plane's ground sits. Staggering the baselines lets the mist show between planes. |
| stream `gaps {scale, below}`, `HINT_CLEARING` 320 | Clearings. This is the air in x, and it frames gameplay landmarks. |
| sky `gradient`, `moon {x 0.27, y 0.15, radius 40, halo 1}`, `starDensity` 0.6, `SKY_HORIZON`, `MOON_GLOW` | Sky mood. `halo` scales all three corona lobes. Stars fade at 20–44 % of the view height. |
| fog band `y`, `height`, `density`, `speed`, `fogColor`; `FOG_SHAPE` thresholds and crest | Band placement (fy 0: view y = y + viewH/2), thickness (≤ ⅓ screen), opacity, drift, and how wispy the top is. |
| `sway` (0.5–0.65) × recipe `swayAmp` (mid/near 4, frame 3 u per 100 u of height) | Wind strength. Quality Low sets `uSway = 0` (`foliageSway: false`). |
| `SHAFT_LOOK.strength` 0.26, `DEPTH_SHAFTS` 0.055 | Shaft brightness. The depth keeps shafts behind the ground but over every layer. |
| `minQuality` per layer | Which planes drop at Low or Medium. Thin the stack evenly and keep both ends of the ramp. |

## Pitfalls (rules)

- **Ten layers at similar values read as one flat wall.** Ramp value, saturation, contrast and softness monotonically with depth. Then add
  air: a height mist brighter than the plane behind, clearings, and a different silhouette vocabulary per depth band. An earlier version of this ramp,
  with 0.02–0.03 luma body steps, a mist in each layer's own fog colour and no clearings, read as one blue wall. Don't fix it by adding layers.
  The script's `minStep` flag (0.015) is only a heuristic, so judge overlapping planes in a rendered frame.
- **A bright feature in view space shows through canopy gaps as jagged shards.** The sky is parallax 0, while the treelines slide over it
  as the camera moves in y. The first moon, at view (0.24, 0.2), splintered through far canopy gaps. Place bright sky features where occluders are sparse
  at *every* camera y (the moon now sits at (0.27, 0.15), above the far treeline tops), or soften them (a lower-contrast disc, a wide corona).
- **A plain RenderTexture target has no depth.** With no depth attachment the test passes everything: later (farther) cores paint
  over nearer ones, and the full-screen sky paints over every core, with no error. Build the target with `depth: true` and check it.
- **Never set `state.blendMode`** on a depth-tested mesh. It re-enables blending on the opaque state and is overwritten anyway.
- **Equal depths fail LESS.** Without the per-instance epsilon, a front instance's soft band disappears over a back instance's core.
  Keep `k ≤ 1024` and the layer gap ≥ 0.02, or instance depths cross into the next layer.
- **No discard or gl_FragDepth** in opaque or sky programs. The core geometry must be exactly opaque instead (see channel-packed-atlas).
- **Core and band must sway identically** (same attribute, formula and row grid). Evaluate the mist at the rest y, and pad chunk culling
  bounds by the sway amplitude (1.4×).
- **Dark gradients band in 8 bits.** Dither every one at the source, not only in the composite.
- **Keep shader time small** (`frame.time % 3600`), or `sin()` loses precision in fp32 after long sessions.
- **Only pure custom-shader meshes go in the depth-tested slots.** A Sprite or Graphics there paints over the terrain drawn in the pre-pass.
- **Keep every shader's TS twin in sync** (`shadeKit`, `shadeSky`, `shadeFog`, `shadeShaft`, `shadeTerrainCore`), or the browser-free previews lie.
- **Grid terrain reads as boxes** unless it has organic outlines, an interior gradient and texture, and undersides with drips and roots.
- **Big solid masses read as holes.** Lift terrain interiors off black, give them structure visible at gameplay zoom, and carve any mass that fills much of a view (Spiritwood keeps dead rock under 8 % of every gameplay view).
  Walkable tops must stay within ±2 u of collision: clamp the noise, damp it on up-facing surfaces, and test the meshed contour.

## Worked example in this repo

- `ARCHITECTURE.md` §2.3–2.5 (the rules), §5.5 (the layer table), §6 (fill and draw budgets).
- `src/render/util/camera.ts`: `applyParallax`, `layerExtent`, `visibleLayerRect`, `depthForParallax`, `depthForInstance`.
  `src/render/util/states.ts`: the three States. `src/config.ts`: the `DEPTH_*` constants, `MAX_INSTANCES_PER_LAYER`, `MAX_LAYER_PARALLAX`,
  `MIN_LAYER_PARALLAX_GAP`, the aspect and zoom limits, and `PALETTE`.
- `public/layers/forest.manifest.json`: the whole ramp as data (sky, L1–L8, fog-low, fog-near, F1–F2).
- `src/render/layers/parallaxStack.ts`: core and band containers with zIndex, States, chunk culling and `selectLayers`.
  `layerModel.ts` (`kitShadeParams`: mist from baseline and recipe), `placement.ts` (`coverageExtent`, seeded streams, clearings, painter k),
  `recipes.ts` (`mist`, `mistDepth`, `mistLift`, `swayAmp`, `gaps`), and `kit.glsl.ts` / `kitShader.ts` / `kitShading.ts` (the shader, its uniforms and its TS twin).
- `src/render/layers/sky.ts`, `sky.glsl.ts`, `skyShading.ts` (sky). `fog.ts`, `fogShading.ts` (bands, `selectFogBands`).
  `src/render/fx/shafts.ts`, `shaftShading.ts`, `shaftGeometry.ts`.
- `src/render/terrain/*`: `terrainField.ts` (SDF), `terrainMesh.ts` (marching squares), `terrainLight.ts` (baked spill), `terrain.glsl.ts`,
  `terrainShading.ts`, `terrainView.ts`.
- `src/render/post/postChain.ts` `createTarget` (the depth RT), `src/render/pipeline.ts` (slots, `sortableChildren`, world-slot transforms),
  `src/contracts/render.ts` (`SCENE_SLOTS` order), `src/settings/quality.ts` (layer budget, fog bands, sway per tier).
- Previews without a browser: `node tools/preview/world/scene-preview.ts <outDir> glade` composes the real meshes with the
  TS shading into `<outDir>/scene-glade.png` and prints fill and draws per layer and per camera. `node .claude/skills/layered-atmosphere/scripts/value-ramp.ts`
  prints the ramp and flags steps below a threshold.
- Tests: `npx vitest run tests/shared/camera.test.ts tests/world/{glsl,placement,manifest,terrainMesh,kitMesh,misc}.test.ts --maxWorkers=2`.

## Related skills

- [sdf-silhouettes](../sdf-silhouettes/SKILL.md): the shapes the ramp is applied to. Organic clumps and fractal edges that read at far and near scale,
  so each plane has a readable silhouette vocabulary.
- [channel-packed-atlas](../channel-packed-atlas/SKILL.md): the R/G/B/A atlas this shader reads, the opaque-core / soft-band hull split that makes the
  pre-pass possible, and the static chunk meshes with per-vertex depth and sway.
- [glow-bloom-grade](../glow-bloom-grade/SKILL.md): emissive twins, the owned bloom chain and the per-area grade. Parallax layers are never twinned (the glow RT has
  no depth), so background flora bakes its halo into the scene instead.
