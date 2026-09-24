---
name: sdf-silhouettes
description: Grow organic 2D silhouettes procedurally on the CPU from signed distance fields - circles, ellipses, boxes, tapered capsules and Bezier strokes joined with smooth-min, noise-displaced edges, seeded variants and recursive branching - rasterised inside each shape's bounds with smoothstep anti-aliasing into a sprite/texture atlas, plus lit SDF part art (pillow normals, rim light). Use when generating trees, crowns, foliage, trunks, roots, vines, ferns, grass, rocks, mushrooms, lanterns, thorns or creature/character parts procedurally; when silhouettes look like clip-art, blobs or "lollipops" and need fractal, drooping edges that read at far and near scale; when adding edge noise, fillets, holes or blur to an SDF; when CPU atlas generation is slow or blocks boot (budgets, time-slicing); or to preview generated textures as PNGs without a browser.
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
  shader instead (GLSL port in [references/toolkit.md](references/toolkit.md)).

## Core idea

- A shape is `d(x, y)`: negative inside, 0 on the contour, positive outside, in texels. Union = `min`,
  fillet = `smin(a, b, k)`, cut = `max(a, -b)`, shell = `abs(d) - t`, keep-above-a-line = `max(d, y - y0)` (y down).
- Pixels come from `coverage(d, soft)` = smoothstep across `soft` texels: AA at any size for free, and a
  large `soft` bakes a blur. Noise added to `d` near the contour makes edges organic, and the same
  smoothstep anti-aliases the noisy edge.
- Structure is code (skeleton, then masses, then detail); variety is a seeded RNG per element id.
- Cost model: every shape writes only its own bounding box (+ a reach band) into one shared Float32
  distance buffer, tagging each texel with the nearest shape's material. One `finalize` pass then
  turns distance + material into pixels. You never evaluate "all shapes at every texel".

## Recipe

1. **Frame the element.** Rect size in texels, a transparent margin (≥ 2^maxMip texels; 6 here),
   an anchor (feet or hang point) and a density (`unitsPerTexel`) that puts ~0.5–2 texels on each
   screen pixel at the layer's scale.
2. **Seed from stable ids.** ``new Rng((hashString(`${category}:${variant}`) ^ atlasSeed) >>> 0)``;
   one tileable noise table per atlas; a per-element noise offset. Variants differ in *kind*
   (`v % 3` picks cloud / spire / forked tree), not just jitter.
3. **Skeleton.** Trunk as a wandering tapered path of capsules; limbs as quadratic Bézier strokes
   (`curve` = N tapered capsules); recursion with sag and light-seeking. Blend joints with `k ≈ 0.5·r`.
4. **Masses.** Foliage as clumps of clumps placed on skeleton tips, lowest first so higher clumps
   overlap lower ones; irregular envelope; a few carved sky holes.
5. **Detail.** Leaf blades, rim tufts, hanging strands, moss cushions, root flares, emissive `glow`
   discs and baked `haloAt` light. Keep every stroke inside the rect minus the margin.
6. **Finalize.** Per-material edge noise (amplitude, frequency), softness, rim, bottom fade for
   mist-drowned bases, edge fade except at intentional `cut` edges.
7. **Look at it** at near scale (1–2×), far scale (box-downsampled ×4) and as pure alpha (PNG + Read
   tool). Fix the big gesture first; noise never rescues a bad silhouette.
8. **Time it.** Per element and per atlas; generate as a step generator and time-slice per element.

## Minimal code (TypeScript, matches `src/render/gen/`)

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

// Excerpt, ElementRaster.put: smooth-union into the buffer; the nearer shape owns the material.
if (k > 0 && old < FAR) { if (d < old) mat[i] = m; dist[i] = smin(old, d, k); }
else if (d < old) { dist[i] = d; mat[i] = m; }

// Excerpt, ElementRaster.finalize: noise only in the edge band, then coverage.
const disp = DISP[m] * dispScale, reach = disp * 1.2 + soft;
if (d0 < reach) {
  let d = d0;
  if (disp > 0 && d0 > -reach) d += (n(x * f, y * f) * 0.75 + n(x * f * 3.1 + 71, y * f * 3.1 + 13) * 0.25) * disp;
  a = coverage(d, soft) * rowFade;
}
```

A building block using the repo API (`kitElements.ts` `mushroom`, abridged): stem stroke, cap, carved
gills, emissive disc.

```ts
r.curve(x, groundY + 1, x + lean * 0.3, groundY - h * 0.5, topX, topY, capR * 0.2, capR * 0.14, Mat.Stem, 1, 5);
r.ellipse(topX, topY - capR * 0.12, capR, capR * 0.5, Mat.Fungus, 1.5);
r.carve(topX, topY + capR * 0.62, capR * 0.72);      // after the cap: carve only cuts what exists
r.glow(topX, topY + capR * 0.02, capR * 0.72, glow, 1.2);
```

Self-contained, engine-agnostic listing (RNG, primitives, noise table, splat raster, lit-part baker,
GLSL ES 3.0 port): [references/toolkit.md](references/toolkit.md). Organic building blocks (recursive
branching, clump-of-clumps crowns, fronds, strands, roots, stone/arch/thorn tricks):
[references/building-blocks.md](references/building-blocks.md).

## Tuning knobs

| Knob | Visual effect |
|---|---|
| `k` smin radius (texels) | 0 crisp overlaps (blades, petals, independent leaves); 1–3 clumps and lobes melt into one mass; 4–6 trunk/limb fillets and root flares; 8–14 soft ground and foreground masses. |
| taper `ra → rb` | Tips at 25–40 % of the base read as growth; untapered strokes read as tubes, round ends as clubs. |
| `curve` segments | 5–6 for short strokes, 10–16 for long arcs; too few shows kinks on the outside of the bend. Joints after the first get `k ≥ 0.6` to hide creases. |
| `DISP` / `FREQ` per material | Edge wobble amplitude (texels) and noise frequency (table units per texel). Leaf 4.5 / 1.1 lumpy, Moss 2.2, Stone 1.6 / 0.6, Bark 1.2 subtle, Petal 0.4 and Stem 0.3 crisp, Soft 6 / 0.35 big lobes. Table values peak near ±0.6 (rms ≈ 0.2), so visible wobble ≈ 0.2–0.6 × DISP. |
| `dispScale` | Per element: 1.2 far (rougher reads as foliage at a distance), 0.8 blurred foreground, 0.15–0.3 grass, ferns, flowers (thin strokes). |
| `softness` | AA width, 1.25 texels by default; 6–9 bakes an out-of-focus blur (foreground frame layers). |
| `fadeBottom` | `[0.62, 1]`: far trunks dissolve into mist instead of ending on a hard line. |
| `edgeFade` / `cut` | Fade to 0 inside the margin (safety net), except at a declared `cut` edge that placement hides. |
| crown envelope | `1 + 0.2·sin 3a + 0.1·sin 5a` makes a lumpy, non-elliptic outline; `pow(rng, 0.4)` biases clumps to the rim; lobes bigger toward the light heap the crown up. |
| lit part `thickness` | Pillow-normal depth: large (head 8 u) = soft rounded volume, small (limbs 1.3–1.8 u) = flat with a thin rim. |

## Design rules: read at far and near scale

1. Three scales of detail: big gesture (lean, mass distribution, negative space) → mid (limbs, lobes,
   tiers) → small (tufts, blades, twigs, edge noise). Only the big gesture survives the far view.
2. Crowns are clumps of clumps carried by visible limbs, never one convex blob on a stick. Heap lobes
   toward the light, let the underside thin and droop, punch one or two sky holes.
3. Everything droops or tapers: limbs sag, strands hang, fronds bend toward the tip, conifer tiers sag
   and fringe.
4. Repeats are irregular: jitter spacing, size and angle, drop a few, break mirror symmetry.
5. Everything is attached: every clump overlaps its parent or sits on a twig; strands hang from
   something.
6. The silhouette defines shape only. Separate planes with a value ramp (far lighter, bluer, softer)
   and fog gaps between them (layered-atmosphere), not with more outline detail.
7. Mind what is behind: a bright moon behind sparse far trees shows through the gaps as jagged white
   shards. Put bright sky features where occluders are dense or absent, or soften them.
8. Gameplay surfaces get organic outlines, interior gradients and drips/roots underneath, but walkable
   tops stay within ±2 u of collision: damp displacement on up-facing edges using the SDF gradient
   (`TerrainField.sample`: amplitude 4 u on walls, 1.4 u on floors).
9. Judge at display scale. If a thumbnail downsampled ×4 doesn't say "tree", change the gesture.

## Pitfalls (rules)

- **No lollipops.** A round crown on a stick reads as clip-art at every scale (the current far
  `cloudCrown` trees do). Use the clump-of-clumps crown on a branching skeleton.
- **No floating satellites.** Small clumps scattered out to ~1.3× the crown radius detach and read as
  paint splatter. Clamp clump placement so each one overlaps the body.
- **No fishbones.** Tiers or leaflets at a fixed step, mirrored left/right, read as a fish skeleton.
- **No hands.** A fan of 5–8 same-size leaves at a twig end reads as a raised hand or claw at mid
  scale (the `midTrunk` `sprig`s do in real-GPU screenshots). Use drooping sprays of many small,
  varied leaves or a clump.
- **Edge noise is a distance offset.** Where it exceeds a stroke's radius the stroke vanishes or
  doubles. Keep the peak offset (≈0.6 × DISP × dispScale) below the thinnest radius.
- **`sdEllipse` is approximate.** It is exact on the contour but underestimates by min/max off the long
  axis (aspect 5: 0.4 instead of 2.0 texels), so AA and noise stretch at the tips. Keep aspect ≤ ~3;
  use tapered capsules for long thin shapes.
- **Distances exist only within reach** (8 + k texels of a capsule/ellipse, 6 of a leaf). Finalize reads out to
  `soft/2 + peak displacement`; if you raise softness or displacement, raise the reach too or the
  outer edge is truncated.
- **Order matters.** `carve` and `smin` act on what is already in the buffer: carve after the shapes it
  cuts, and a later shape refills the hole. `smin` blends with every earlier shape within reach, not
  just the intended partner: use `k = 0` for independent overlaps.
- **Material is chosen by the nearest shape,** so a fat bark–leaf fillet splits along the bisector.
  Blend distances, not materials.
- **Stay inside the rect.** Shorten strokes (`fitLength`) and clamp tips by the size of what grows on
  them; the edge fade is a safety net, and a rect-cut silhouette looks sliced.
- **Seed from ids, not loop indices.** Shapes are seeded from `category:variant`, but the noise offset
  is the job index, so inserting a spec shifts later elements' edge noise. Draw optional passes from
  `rng.fork(salt)` so changing their count doesn't reshuffle the structure.
- **`Math.hypot` in texel loops is ~13× slower** than `Math.sqrt(dx*dx + dy*dy)` in V8 (measured).
- **Per-texel fbm is ~5× a table lookup** (71 vs 15 ns). Bulk atlases sample a tileable table; keep
  `Noise.fbm`/`ridged` for small bakes, and compute central-difference normals only within
  `normalBand` of the edge (4 extra SDF evaluations per texel).
- **GLSL:** `union`, `sample`, `filter`, `common`, `input`, `output`, `active` are reserved words in
  GLSL ES 3.00. Opaque passes use no `discard`.

## Budget and time-slicing

Measured here: forest kit, 75 elements into 2048×1792, ≈ 405–425 ms cold in Node and 432 ms at boot in
Chrome (≈ 260–290 ms once the JIT is warm; target ≈ 400 ms on a laptop, `tests/world/kit.test.ts` fails
above 4 s). Draw ≈ 40 % and finalize ≈ 60 % of rasterisation time (finalize walks the whole rect, so
keep rects tight); hull extraction ≈ 70 ms; the noise table 21 ms. Entity atlas (14 images, fbm inside
the SDFs): 208 ms. Hero atlas (27 frames): 67 ms.

The element is the atomic unit of work: the largest takes ≈ 16 ms warm (`nearTrunk:2`), and the first
one ≈ 33 ms while the JIT is cold. `kit.ts` is a step generator:

```ts
function* kitSteps(seed: number, width: number, height: number, specs: readonly ElementSpec[]): Generator<void, KitAtlasData> {
  // abridged: pack rects, allocate pixels, build the noise table
  yield;
  for (let i = 0; i < jobs.length; i++) {
    // seed rng from `${category}:${variant}`, draw, finalize into the atlas, extract the hull
    yield;
  }
  return { width, height, pixels, elements, byCategory, ms: 0 };
}
export async function generateKitAsync(
  seed: number, pause: () => Promise<void>, width = KIT_WIDTH, height = KIT_HEIGHT, specs: readonly ElementSpec[] = ELEMENT_SPECS,
): Promise<KitAtlasData> {
  const it = kitSteps(seed, width, height, specs);
  for (;;) { const s = it.next(); if (s.done) return s.value; await pause(); }
}
```

`pacedYield()` (`src/render/layers/assets.ts`) only yields after ≥ 8 ms of work, via
`scheduler.yield()` or a `MessageChannel` round trip (nested `setTimeout` is clamped to ≥ 4 ms).
Tests and tools drain the same generator synchronously (`generateKit`).

## PixiJS v8 specifics

- Upload with `textureFromRgba` (`src/render/util/texture.ts`): `new BufferImageSource(...)` +
  `new Texture({ source })`. `Texture.from` caches by the pixel array, so a reused buffer returns a
  stale texture.
- Generators write straight alpha; Pixi textures are premultiplied. `textureFromRgba` premultiplies in
  place, so drop the pixel buffer after upload.
- Minified atlases use `autoGenerateMipmaps: true`, gutters ≥ 2^maxMip between rects, plus the
  transparent margin inside each rect. The kit shader clamps LOD to `KIT_MAX_MIP` (1), so an element
  minified by more than ~2× aliases: pick `unitsPerTexel` accordingly.
- Plain Sprites, Graphics and ParticleContainers ignore depth. The kit is drawn as merged meshes with
  a custom shader that splits each element into an opaque core and a soft band (channel-packed-atlas).
- For SDFs evaluated in a Pixi fragment shader: start with `precision highp` (or pass
  `preferredFragmentPrecision: 'highp'`), and never redeclare Pixi's uniform names (`uColor`,
  `uTransformMatrix`, `uProjectionMatrix`, `uWorldTransformMatrix`, `uWorldColorAlpha`,
  `uResolution`, `uRound`).
- Mirrored rigs flip the baked light: hero parts are baked twice (`@R`, `@L` with the light mirrored)
  so the rim stays on the moon side when facing left.

## Worked example in this repo

- `src/render/gen/sdf.ts`: primitives, `smin`, `coverage`, `sdCurve`.
- `src/render/gen/raster.ts`: `ElementRaster` (bbox splats, `put`, `capsule`, `curve`, `ellipse`,
  `leaf` blade profile, `carve`, `glow`, `haloAt`), `Mat` with per-material `DISP`/`FREQ`/`RIM`, and
  `finalize` (edge noise, coverage, rim look-back, bottom and edge fades).
- `src/render/gen/kitElements.ts`: building blocks (`limb`, `roots`, `cloudCrown`, `frond`, `strand`,
  `mushroom`, `risingTrunk`, `branch`, `sprig`, `fitLength`) and `ELEMENT_SPECS` (rects, anchors,
  finalize options, `draw`). The recipes are being reworked by an art pass; treat them as examples.
- `src/render/gen/kit.ts`: seeding, the step generator, packing and hulls.
- `src/render/gen/noise.ts` (`Noise.fbm`, `ridged`), `noiseTable.ts` (tileable table), `src/core/rng.ts`.
- `src/render/hero/heroParts.ts`: lit SDF parts (`smin` of ellipse + circle head, `vesica` leaf,
  pillow normal, rim toward the light); `heroBake.ts` `composePose` (CPU compositor, silhouette mode for
  the blurred ghost).
- `src/render/entities/entityAtlas.ts`: `bake()` with `normalBand`, stone shading, domain-warped
  lean/taper, half-plane cuts, onion-ring arch, thorn rows, spiral rune.
- `src/render/terrain/terrainField.ts`: gradient-aware displacement that keeps floors flat.
- Preview: `node tools/preview/world/kit-preview.ts <dir>` (whole atlas, channels, hulls),
  `node tools/preview/pipe/heroAtlas.ts <dir>`, `node tools/preview/pipe/entityAtlas.ts <dir>`, and
  `node .claude/skills/sdf-silhouettes/scripts/preview-element.ts <category> <dir>` (one category at
  near scale, far scale and as alpha, pixel-identical to the atlas). Open the PNGs with Read.

## Related skills

- **channel-packed-atlas**: what `finalize` writes (R detail, G rim, B emissive, A coverage), hulls,
  mips and gutters, and how the kit shader consumes it.
- **layered-atmosphere**: placing these silhouettes on parallax planes with a value ramp and fog gaps.
- **glow-bloom-grade**: turning the emissive channel and baked halos into bloom and a graded image.
