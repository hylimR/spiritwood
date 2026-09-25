---
name: sdf-silhouettes
description: Grow organic 2D silhouettes procedurally on the CPU from signed distance fields - circles, ellipses, tapered capsules and Bezier strokes joined with smooth-min, noise-displaced edges, seeded variants, recursive light-seeking branching and volume-shaded clump-of-clumps foliage - rasterised inside each shape's bounds with smoothstep anti-aliasing into a sprite atlas, plus lit SDF part art (pillow normals, rim light). Use when generating trees (oak, willow, conifer, birch, snag), crowns, foliage, roots, vines, ferns, grass, rocks, mushrooms, thorns or creature parts procedurally; when silhouettes look like clip-art, blobs or "lollipops" and need fractal, drooping edges that read at far and near scale; when adding edge noise, fillets, holes or blur to an SDF; when CPU atlas generation is slow or blocks boot (budgets, time-slicing); or to preview generated textures as PNGs without a browser.
---

# SDF silhouettes

Organic shapes grown from distance fields, baked on the CPU into an atlas once at boot.

## When to use

- Procedural scenery sprites (trees, canopies, trunks, roots, vines, ferns, grass, rocks, mushrooms,
  lanterns, brambles) or character/creature part art, deterministic from a seed.
- Silhouettes read as clip-art (lollipop trees, blob bushes, fishbone conifers) and need structure,
  droop and fractal edges.
- You need AA or deliberately blurred edges, fillets, carved holes, or a bake that fits a boot budget.
- Not for shapes that animate/morph or must stay crisp at any zoom: evaluate the SDF in a fragment
  shader instead ([GLSL port](references/toolkit.md#glsl-es-30-port-gpu-evaluation)).

## Core idea

- A shape is `d(x, y)`: negative inside, 0 on the contour, positive outside, in texels. Union = `min`,
  fillet = `smin(a, b, k)`, cut = `max(a, -b)`, shell = `abs(d) - t`, keep-above-a-line = `max(d, y - y0)` (y down).
- Pixels come from `coverage(d, soft)` = smoothstep across `soft` texels: AA at any size for free, and a
  large `soft` bakes a blur. Noise added to `d` near the contour makes edges organic, and the same
  smoothstep anti-aliases the noisy edge.
- Structure is code (skeleton, then masses, then detail); variety is a seeded RNG per element id.
- Cost model: every shape writes only its bounding box (+ a reach band) into one shared Float32 distance
  buffer, tagging each texel with the nearest shape's material (and shading). One `finalize` pass over
  the touched rows turns distance + material into pixels. Never "all shapes at every texel".

## Recipe

1. **Frame the element.** Rect size in texels, a transparent margin (≥ 2^maxMip texels; 6 here),
   an anchor (feet or hang point) and a density (`unitsPerTexel`) that puts ~0.5–2 texels on each
   screen pixel at the layer's scale (≤ 2 because the kit shader clamps to mip 1).
2. **Seed from stable ids.** ``new Rng((hashString(`${key}:${variant}`) ^ atlasSeed) >>> 0)`` with
   `key = spec.key ?? spec.category`; one tileable noise table per atlas; a per-element noise offset.
   Variants differ in *kind* (separate archetype specs: broad, willow, slender, conifer, snag).
3. **Size the reach**: `r.configure(finalizeOptions)` before drawing, with the options `finalize` gets.
4. **Skeleton.** Trunk as a wandering tapered path of capsules; limbs as quadratic Bézier strokes
   (`curve` = N tapered capsules); recursion with sag and light-seeking (`branchSystem`), reporting
   every terminal twig and fork to callbacks. Blend joints with `k ≈ 0.4–0.6·r`.
5. **Masses.** Record a clump at each tip/fork, then draw them lowest first so higher clumps overlap
   lower ones. Each clump = body + lobes on an irregular envelope + tufted rims (+ an occasional carved
   sky hole), volume-shaded from the light (`volume`/`lobe`).
6. **Detail.** Leaf blades, drooping leaf sprays, curtains, fringed conifer skirts, moss, root flares,
   emissive `glow` discs and baked `haloAt` light. Keep every stroke inside the rect minus the margin.
7. **Finalize.** Per-material edge noise (amplitude, frequency), softness, rim, bottom fade for
   mist-drowned bases, edge fade except at intentional `cut` edges.
8. **Look at it** at near scale (1–2×), far scale (box-downsampled ×4) and as pure alpha (PNG + Read
   tool). Fix the big gesture first; noise never rescues a bad silhouette.
9. **Time it.** Per element and per atlas; generate as a step generator and time-slice per element.

## Minimal code (TypeScript)

Same math as `src/render/gen/sdf.ts`, written with `Math.sqrt` as `raster.ts` inlines it (sdf.ts uses
`Math.hypot`, see Pitfalls).

```ts
export function sdTaperedCapsule(px: number, py: number, ax: number, ay: number, bx: number, by: number, ra: number, rb: number): number {
  const pax = px - ax, pay = py - ay, bax = bx - ax, bay = by - ay;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / (bax * bax + bay * bay || 1)));
  const dx = pax - bax * h, dy = pay - bay * h;
  return Math.sqrt(dx * dx + dy * dy) - (ra + (rb - ra) * h);
}
export function smin(a: number, b: number, k: number): number {       // max extra bulge k/4
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
export function coverage(d: number, soft: number): number {           // == 1 - smoothstep(-soft/2, soft/2, d)
  const t = 0.5 - d / Math.max(1e-6, soft);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

// Excerpt, the M1 ElementRaster.put: smooth-union into the buffer; the nearer shape owns material and shading.
// Since M2 this logic is written out inside each shape loop, which also records the texel's stroke frame
// (see the painterly-strokes skill); the ownership rule is unchanged.
if (k > 0 && old < FAR) {
  if (d < old) { this.mat[i] = mat; this.shade[i] = this.volOn ? this.volAt(x, y) : 0; }
  this.dist[i] = smin(old, d, k);
} else if (d < old) { this.dist[i] = d; this.mat[i] = mat; this.shade[i] = this.volOn ? this.volAt(x, y) : 0; }

// Excerpt, ElementRaster.finalize: noise only in the edge band (reach = disp·1.2 + soft), then coverage.
if (d0 < reach) {
  let d = d0;
  if (disp > 0 && d0 > -reach) d += (noise.sample(x * f + nox, y * f + noy) * 0.75 + noise.sample(x * f * 3.1 + 71 + nox, y * f * 3.1 + 13 + noy) * 0.25) * disp;
  const t = 0.5 - d * invSoft;
  a = (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t)) * aRow;
}
```

The branching-to-foliage pattern (`trees.ts` `midCrown`, abridged; `drawClumps` is module-private):

```ts
const clumps: number[] = [];
const tip: TipFn = (x, y) => { clumps.push(x, y - 4 * s, rng.range(24, 32) * s); };
const fork: TipFn = (x, y) => { clumps.push(x, y - 6 * s, rng.range(22, 28) * s); };
const style: BranchStyle = { ...OAK, taper: 0.6, pad: 34 * s, rise: 0.3, tri: 0.15 };
branchSystem(r, rng, cx, y, UP + side * rng.range(0.7, 1.2), halfW * rng.range(0.38, 0.46), 6 * s, 1, style, tip, fork);
drawClumps(r, rng, clumps, 0.72, LEAFY);   // lowest first, clamped inside the rect
```

Self-contained, engine-agnostic listing (RNG, primitives, noise table, splat raster, lit-part baker,
GLSL ES 3.0 port): [references/toolkit.md](references/toolkit.md). The repo's tree generator explained
(branching, clumps, volume shading, archetypes, other blocks, stone/arch/thorn tricks, terrain):
[references/building-blocks.md](references/building-blocks.md).

## Tuning knobs

| Knob | Visual effect |
|---|---|
| `k` smin radius (texels) | 0 crisp overlaps (blades, needles, independent leaves); 1–3 clumps and lobes melt into one mass; `0.4–0.6·r` limb joints (≤ 6 on trunks, root flares `min(8, 0.4·r)`); 7–14 soft ground and foreground masses. |
| taper | Child/parent radius 0.6–0.68 per branch level; recursion stops below 0.7–1.1 texels, so twigs end thin. Untapered strokes read as tubes, round ends as clubs. |
| `BranchStyle` | `spread` 0.85–0.95 rad between siblings, `jitter`, `rise` 0.1–0.3 (pull toward up: light-seeking), `droop` (sag ∝ len²), `tri` chance of 3 children, `lenMin/lenMax` 0.55–0.82, `pad` keeps limb ends clear of the rect edge by the foliage they carry. |
| `curve` segments | 5–6 for short strokes, 10–16 for long arcs; too few shows kinks on the outside of the bend. Joints after the first get `k ≥ 0.6` to hide creases. |
| `DISP` / `FREQ` per material | Edge wobble amplitude (texels) and noise frequency (table units per texel). Soft 6 / 0.35 big lobes, Leaf 3.2 / 1.6, Moss 2.2 / 1.2, Needle 2.2 / 2.6 fine and frequent, Stone 1.6 / 0.6, Bark 1.2 / 0.9, PaleBark 0.9, Petal 0.4 and Stem 0.3 crisp. The 0.75/0.25 two-octave sample peaks ≈ ±0.5 (rms ≈ 0.17), so visible wobble ≈ 0.2–0.5 × DISP. |
| `dispScale` | Per element: 1 far and mid, ≈ 0.53 blurred foreground, 0.15–0.3 grass, ferns, flowers (thin strokes). |
| `softness` | AA width, 1.25 texels by default (1.3 far); 4–6 bakes an out-of-focus blur (foreground frame). |
| `fadeBottom` | `[0.66, 1]` far trees, `[0.55, 1]` far treeline: bases dissolve into mist instead of a hard line. |
| `volume(cx, cy, r, k, flat)` / `lobe` | Luminance ramp toward the light across radius `r`, clamped ±`k`: clump 0.2 + lobe 0.1 make each lobe a lit ball inside a lit mass; `flat` −0.02…−0.04 darkens undergrowth. |
| crown envelope | `1 + 0.2·sin 3a + 0.1·sin 5a` makes a lumpy, non-elliptic outline; lobes on the upper rim up to ~28 % bigger heap the crown toward the light. |
| `edgeFade` / `cut` | Fade to 0 inside the margin (safety net), except at a declared `cut` edge that placement hides. |
| lit part `thickness` | Pillow-normal depth: large (head 8 u) = soft rounded volume, small (limbs 1.3–1.8 u) = flat with a thin rim. |

## Design rules: read at far and near scale

1. Three scales of detail: big gesture (lean, mass distribution, negative space) → mid (limbs, lobes,
   tiers) → small (tufts, blades, twigs, edge noise). Only the big gesture survives the far view.
2. Crowns are clumps of clumps carried by visible limbs, never one convex blob on a stick. Heap lobes
   toward the light, let the underside thin and droop, punch an occasional sky hole.
3. Everything droops or tapers: limbs sag, strands hang, sprays droop, conifer tiers sag and fringe.
4. Repeats are irregular: jitter spacing, size and angle, drop a few (conifer tier branches: 12 %
   missing, 15 % reaching long, ~17 % stunted), break mirror symmetry.
5. Everything is attached: every clump sits on a tip or fork; strands hang from something.
6. The silhouette defines shape only. Separate planes with a value ramp (far lighter, bluer, softer)
   and fog gaps between them (layered-atmosphere), not with more outline detail.
7. Mind what is behind: a bright moon behind gappy far foliage shows through as jagged white shards. Put
   bright sky features in open sky or fully behind a dense mass, or soften them.
8. Gameplay surfaces get organic outlines, interior gradients and drips/roots underneath, but walkable
   tops stay within ±2 u of collision: pick the displacement amplitude by facing from the SDF gradient
   (`TerrainField.sample`: floors 1.2 u, walls 3.5 u, undersides lumps 9 u + drips), and test it.
9. Judge at display scale. If a thumbnail downsampled ×4 doesn't say "tree", change the gesture.

## Pitfalls (rules)

- **No lollipops.** A round crown on a stick reads as clip-art at every scale (the old `cloudCrown`
  far trees did). Grow clump-of-clumps crowns on the tips of a branching skeleton.
- **No floating satellites.** Small clumps scattered around a central body detach from it and read as
  paint splatter. Place each clump on a tip or fork so it overlaps its limb.
- **No fishbones.** Tiers or leaflets at a fixed step, mirrored left/right, read as a fish skeleton.
- **No hands.** A fan of ~10–13 similar blades radiating up from one twig tip reads as a raised hand or
  claw at mid scale (the old `midTrunk` `sprig`). Use `leafSpray` (fan that droops outward around a
  small core ellipse) or a clump.
- **Configure the reach.** Shapes record distances only within `reach[mat] (+k)`: 8 texels unless
  `configure(o)` sets `DISP·dispScale·1.2 + soft + 0.75`; pass it the options `finalize` gets (skipping
  it changed 3,670 bytes of this kit: truncated soft edges and different blends).
- **Edge noise is a distance offset.** Where it exceeds a stroke's radius the stroke vanishes or
  doubles. Keep the peak offset (≈0.5 × DISP × dispScale) below the thinnest radius.
- **`sdEllipse` is approximate.** Exact on the contour, but it underestimates by min/max off the long
  axis (aspect 5: 0.4 instead of 2.0 texels), so AA and noise stretch at the tips. Keep aspect ≤ ~3 where
  tips show; use tapered capsules for long thin shapes.
- **Order matters.** `carve` and `smin` act on what is already in the buffer: carve after the shapes it
  cuts, and a later shape refills the hole. `smin` blends with every earlier shape within reach, not
  just the intended partner: use `k = 0` for independent overlaps.
- **Material and shading come from the nearest shape,** so a fat bark–leaf fillet splits along the
  bisector. Blend distances, not materials; set `volume` before the shapes it should shade.
- **Stay inside the rect.** Shorten strokes (`fitLength`), clamp limb ends by `pad` and clumps by their
  radius (`drawClumps`); the edge fade is a safety net, and a rect-cut silhouette looks sliced.
- **Seed from ids, not loop indices.** Distinct specs of one category need distinct `key`s. The noise
  offset is the job index, so inserting a spec shifts later elements' edge noise. Draw optional passes
  from an `rng.fork(salt)` taken at a fixed point (the fork itself consumes one draw).
- **Normalise noise before using it as an amplitude.** Table fbm has rms ≈ 0.2; the terrain scales it
  ×2.2 and clamps to ±1, so `flatAmp`/`dispAmp` are hard bounds the tests can check.
- **`Math.hypot` in texel loops is ~11–16× slower** than `Math.sqrt(dx*dx + dy*dy)` in V8 (measured).
- **Per-texel fbm is ~5× a table lookup** (≈ 70 vs 12–15 ns). Bulk atlases sample a tileable table;
  keep `Noise.fbm`/`ridged` for small bakes, and compute central-difference normals only within
  `normalBand` of the edge (4 extra SDF evaluations per texel).
- **GLSL:** `union`, `sample`, `filter`, `common`, `input`, `output`, `active` are reserved words in
  GLSL ES 3.00. Opaque passes use no `discard`.

## Budget and time-slicing

Measured here in M1 (Node 22, one machine; the M2 painterly pass adds ≈ +136 ms cold, brush tables
included; see painterly-strokes): forest kit, 79 elements into 2048×2048, ≈ 445–455 ms cold and
≈ 215–280 ms warm (target 400 ms on a laptop; `tests/world/kit.test.ts` fails above 4 s). Warm: draw
≈ 95 ms, finalize ≈ 60 ms (only touched row spans), hull extraction ≈ 55 ms; noise table ≈ 20 ms. The
slowest element is ≈ 10 ms warm (`nearTrunk:2`); the first one ≈ 44 ms while the JIT is cold. Entity
atlas (14 images, fbm inside the SDFs) ≈ 160–210 ms; hero atlas (27 frames) ≈ 70 ms.

- One element is the atomic unit of work: a step generator yields after each one, and the browser
  awaits `pacedYield()` (`src/render/layers/assets.ts`: yields only after ≥ 8 ms of work, via
  `scheduler.yield()` or a `MessageChannel` round trip, since nested `setTimeout` clamps to ≥ 4 ms).
  Tests and tools drain the same generator synchronously (`generateKit`).
- Keep the per-element work in a plain function (`buildElement`) called from the generator: V8
  optimises loops in plain functions much sooner, which matters for the single cold run at boot.
- Reuse buffers across elements (`Scratch`), record per-row touched spans so `finalize` skips empty
  space, and clip capsule/leaf rows to the slab around the segment. Code:
  [building-blocks.md §6](references/building-blocks.md#6-time-slicing-the-bake).

## PixiJS v8 specifics

- Upload with `textureFromRgba` (`src/render/util/texture.ts`): `new BufferImageSource(...)` +
  `new Texture({ source })`. `Texture.from` caches by the pixel array, so a reused buffer returns a
  stale texture.
- Generators write straight alpha; Pixi textures are premultiplied. `textureFromRgba` premultiplies in
  place, so drop the pixel buffer after upload.
- Minified atlases use `autoGenerateMipmaps: true`, gutters ≥ 2^maxMip between rects, plus the
  transparent margin inside each rect. The kit shader clamps LOD to `KIT_MAX_MIP` (1), so an element
  minified by more than ~2× undersamples mip 1 and aliases: pick `unitsPerTexel` accordingly.
- Sprites, Graphics, ParticleContainers (and Meshes without their own `State`) use `State.for2d()`:
  no depth test, no depth write. The kit is drawn as merged meshes with a custom shader and states that
  split each element into an opaque core and a soft band (channel-packed-atlas).
- For SDFs evaluated in a Pixi fragment shader: `#version 300 es` then `precision highp float;`, and
  pass `preferredFragmentPrecision: 'highp'` to `GlProgram.from`. Pixi strips the version line and
  prepends `precision <preferred> float;` (default mediump); without your own highp line, a uniform
  shared with the highp vertex stage fails to link. Never redeclare Pixi's uniform names (`uColor`,
  `uTransformMatrix`, `uProjectionMatrix`, `uWorldTransformMatrix`, `uWorldColorAlpha`, `uResolution`,
  `uRound`).
- Mirrored rigs flip the baked light: hero parts are baked twice (`@R`, `@L` with the light mirrored)
  so the rim stays on the moon side when facing left.

## Worked example in this repo

- `src/render/gen/sdf.ts`: primitives, `smin`, `coverage`, `sdCurve`.
- `src/render/gen/raster.ts`: `ElementRaster` (`configure`, bbox splats, `put`, `capsule`, `curve`,
  `ellipse`, `leaf` blade profile, `carve`, `glow`, `haloAt`, `volume`/`lobe`/`noVolume`, `columnX`),
  `Scratch`, `Mat` with per-material `DISP`/`FREQ`/`RIM`, and `finalize`.
- `src/render/gen/trees.ts`: `branchSystem` + `BranchStyle` (`OAK`, `TWIG`), `limbAlong`, `clump` +
  `LEAFY`, `drawClumps`, `trunkPath`, `risingColumn`, `rootFlare`, `curtainStrand`, `leafSpray`, and the
  archetypes (`broadTree`, `willowTree`, `slenderTree`, `coniferTree`, `snagTree`, `midOakTrunk`,
  `midWillowTrunk`, `midConiferTrunk`, `midBirchPair`, `canopyCeiling`, `nearTrunk`, `midCrown`).
- `src/render/gen/kitElements.ts`: `ELEMENT_SPECS` (rects, anchors, `key`, finalize options, `draw`),
  `farArchetype`, `midTrunkSpec`, and the small blocks (`fitLength`, `frond`, `strand`, `mushroom`,
  `glowBulb`). Recipes change with art passes; treat them as examples of the techniques.
- `src/render/gen/kit.ts`: seeding, `buildElement`, the step generator, packing and hulls.
- `src/render/gen/noise.ts` (`Noise.fbm`, `ridged`), `noiseTable.ts` (tileable table), `src/core/rng.ts`.
- `src/render/hero/heroParts.ts` (lit SDF parts) and `heroBake.ts` `composePose` (CPU compositor,
  silhouette mode for the blurred ghost); `src/render/entities/entityAtlas.ts` (`bake()`, `normalBand`,
  stone, arch, thorns, rune); `src/render/terrain/terrainField.ts` (facing-dependent displacement).
- Preview: `node tools/preview/world/kit-preview.ts <dir>` (whole atlas, channels, hulls),
  `node tools/preview/pipe/heroAtlas.ts <dir>`, `node tools/preview/pipe/entityAtlas.ts <dir>`, and
  `node .claude/skills/sdf-silhouettes/scripts/preview-element.ts <category|key> <dir>` (every matching
  spec at near scale, far scale and as alpha, byte-identical to the atlas). Open the PNGs with Read.

## Related skills

- [channel-packed-atlas](../channel-packed-atlas/SKILL.md): what `finalize` writes (R detail, G rim,
  B emissive, A coverage), hulls, mips and gutters, and how the kit shader consumes it.
- [layered-atmosphere](../layered-atmosphere/SKILL.md): placing these silhouettes on parallax planes
  with a value ramp and fog gaps.
- [glow-bloom-grade](../glow-bloom-grade/SKILL.md): turning the emissive channel and baked halos into
  bloom and a graded image.
- [painterly-strokes](../painterly-strokes/SKILL.md): recording a local stroke frame per texel as these
  shapes are drawn, and baking gouache brushwork into the atlas without speckle.
