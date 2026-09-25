---
name: painterly-strokes
description: Hand-painted gouache/oil brush strokes baked into procedural 2D art - a channel-packed SDF sprite atlas and an SDF terrain mesh - without speckle. Each shape records a local stroke frame (along/across a capsule or curve, (r̄·φ, ρ·r̄) around a lobe, along a leaf, plain (x, y) for ground and rocks) per texel at raster time; an elongated two-scale brush texture is evaluated in that frame; strokes cross-fade where forms meet; a per-layer stroke gain in the shading makes them read at 1:1 without clipping R; the rim mask is redistributed inside 2×2 blocks so mips and the value ramp don't move; alpha edges get dry-brush breakup; terrain vertices carry an arc-length stroke coordinate (s, depth) that closes on whole wraps, a continuity weight that fades strokes smoothly at medial axes and mitres, and an fwidth frequency clamp. Use when procedural art looks airbrushed, vector-flat or CG-smooth and should read as painted; when adding brush texture, stroke direction, dry-brush edges or paint-like variation to sprites, atlases or terrain; when a noise texture "rotated along the form" shimmers or speckles; or when a painterly bake must fit a boot budget.
---

# Painterly strokes

Brush strokes that follow each form, baked once into the atlas (zero runtime cost) and computed per
fragment on the terrain from a vertex attribute. Built on the kit of `sdf-silhouettes`, packed as in
`channel-packed-atlas`, shaded under the value ramp of `layered-atmosphere`.

## When to use

- Procedural sprites or terrain read as airbrushed or vector-flat and should read as painted: visible,
  form-following strokes at 1:1, soft broken edges, no outlines.
- The look must not cost the gameplay read: silhouettes, the aerial-perspective value ramp and the
  terrain/background separation stay put (strokes are zero-mean and bounded).
- Not for a texture that must animate or scroll across a form (bake it, or evaluate it in the shader
  from the same local coordinates), and not a substitute for good silhouettes and values.

## Core idea: local stroke coordinates, never a rotated global coordinate

A painter's stroke runs along the form. The tempting shortcut, rotating texel or world coordinates by a
per-texel (or per-vertex) direction, warps the noise domain: where the direction turns quickly (lobe
centres, terrain corners) the rotated coordinate sweeps the noise at many times its intended frequency.
Measured: 7–19× near lobe centres, shimmering on terrain corners. That is exactly the speckle to avoid.

Instead every shape owns a **stroke frame**, and a texel's coordinate is measured in its owner's frame:

| Shape | Frame | (u along, v across) |
|---|---|---|
| capsule, curve (a chain of capsules) | line | along the segment from the stroke's start (u0 continues over the segments of one curve or `beginStroke()` group), signed distance across |
| ellipse, lobe (+ its tufts and leaves, held) | polar | (r̄·φ, ρ·r̄) with ρ the ellipse-normalised radius and r̄ the mean radius (no compression: the strokes keep the element's width) |
| leaf blade | line | along the blade |
| ground, rocks, root arches | xy | plain (x, y): horizontal strokes, one frame for all its shapes (no seams) |

The shape that wins a texel (nearest SDF distance) records its frame index and its own distance next to
`mat`/`shade`: one interleaved `[frame, distance]` pair per texel, one cache line per write. The frame
itself (origin, axis, radii, brush offsets, the brush-table map) lives in a small per-element table
(≈ 5.6 k frames for 79 elements), not per texel.

```ts
// Written out in the capsule / ellipse / leaf loops (put): the nearer shape owns the texel.
if (d < old) {
  if (mats[i] !== 0 && frames.group[own[i * 2]] !== grp) this.demote(i);   // keep a runner-up
  own[i * 2] = shape;      // frame index
  own[i * 2 + 1] = d;      // the shape's own (unblended) distance
  dist[i] = k > 0 && old < FAR ? smin(old, d, k) : d;
  mats[i] = mat;
  shade[i] = volOn ? this.volAt(x, y) : 0;
} else if (k > 0 && d < old + k && old < FAR) dist[i] = smin(old, d, k);
```

Held frames make a compound form paint as one: `framePolar(cx, cy, rx, ry)` … `releaseFrame()` around a
lobe with its tufts and rim leaves, `frameLine(a, b)` around a conifer tier with its fringe or a willow
strand with its leaves, `strokeFrame('xy')` around ground masses. `beginStroke()`/`endStroke()` make
the segments of a trunk path one continuous stroke.

## Recipe (kit atlas)

1. **Frames at draw time.** Each primitive starts its own frame unless one is held; curves and
   `beginStroke` groups share a group (no seams between their segments). Polar frames fade to the
   frame's ring mean (16 samples) between ρ = 0.12 and 0.45 (φ bunches up at the centre; a hard centre
   reads as an eye). Lobes are **not** compressed in brush space: squeezing a big lobe to about one
   stroke width made its strokes as wide as the lobe (28 u on a canopy top, 92–146 u on the frame's
   lobes) and left two broad cells around it, a light half and a dark half at a random angle that fought
   the upper-left form lighting. With r̄ as it is, a lobe's strokes have the element's width and wrap it
   in dabs; the centre fade keeps concentric bands and eyes away.
2. **Brush.** One precomputed periodic table per frame kind (128², bilinear, wrap by mask):
   `softsign(2.2 · (0.64 · broad + 0.36 · fine))`, gradient noise at two scales (fine = twice the broad
   frequency on both axes), unit rms before shaping, so stroke bodies are even plateaus with soft edges.
   Cells are sized from the stroke width w: broad bands ≈ 2w wide, strokes `stretch` (5) times longer
   than wide. Polar tables have four broad cells around, and the along scale is rounded to a multiple of
   four cells per revolution (`cellsAround`: whole table periods, at least one), so φ wraps without a
   seam and every lobe takes at least four dabs around.
3. **Widths in layer units.** `strokeWidthTexels(units, unitsPerTexel, minInstanceScale, pxPerUnit)` =
   max(3 texels, units / unitsPerTexel, 2 px at the minimum render scale for the smallest instance the
   recipes and placeDecor place). Below ~3 texels a stroke is speckle at 1:1 and vanishes at mip 1.
   **Derive the pixel floor from the quality presets, never guess it:** each preset at its
   minRenderScale on the widest canvas the game letterboxes to (MAX_ASPECT), big enough that its pixel
   budget caps the render scale (`renderScaleCap`). Low: 0.388 px/u, not 0.5 (and not 1080p's 0.444);
   at 0.5, 15 categories fell below 2 px.
4. **Evaluate once per covered texel**, in tight loops over index lists (brushOwners, brushRunners):
   the frame's affine map into table space (precomputed per frame; polar: sqrt + a polynomial atan2),
   one bilinear lookup, the polar fade. Only texels that can end up covered need it (distance below
   the dry-brush band).
5. **Seams: fade from the runner-up.** When a shape takes a texel from a shape of another frame group,
   the old owner becomes the texel's runner-up (the nearest such). The new owner's brush fades in from
   the runner-up's over `STROKE_SEAM` = 5 of distance gap `(td − sd)`: continuous at the boundary, each
   form keeps its own strokes a few texels in. One-sided and cheap (≈ 25 % of texels evaluate twice).
6. **Luminance (R) and the stroke gain.** `R += lim · (brush − mean)`, `lim = min(amount, (R − 0.02)·0.85,
   (0.98 − R)·0.85) · (1 − emissive)` (no strokes on pure light), the mean alpha·lim-weighted over the
   element so the element's mean value does not move. To make strokes read louder without clipping R,
   raise the gain in the shading, not the amplitude: the bake stores the element's own detail as
   `0.5 + (lum − 0.5) / g` and the shader computes `k = (1 + g·(R − 0.5))·(0.8 + 0.4·shade)`, so the
   detail comes back unchanged (within one rounding) and only the strokes gain, with the headroom the
   division freed. g is per layer (one value for every category a recipe places: `recipeStrokeGain`
   throws on a mix): 1.75 on the mid and near planes (L4–L8), 1 on the fogged far planes, the dark frame
   and the decor. The plain atlas (the pre-M2 look) must be shaded at g = 1.
7. **Rim mask (G): break it up, keep the block means.** See below.
8. **Dry brush on alpha edges.** Part of the edge noise becomes the brush value itself, so edges fray
   along the strokes, within the same displacement budget (below).
9. **Look at it** (gallery `--lum` shows R stretched; scene previews at the GPU cameras, 2× crops) and
   measure it (`tools/preview/world/stroke-report.ts`).

## Visibility maths

The kit shader computes `k = (1 + g·(R − 0.5))(0.8 + 0.4·shade)` and `c = tint·k + rim…`, then
desaturates and fogs toward the layer's fog colour. So a change ΔR moves final luma by about
`ΔR · 255 · g · luma(tint)·(1 − desat…) · (1 − fog)`: the layer's **codes per unit R** (measured: L1
12.4, L2 14.1, L3 15.2, L4 25.7, L5 25.3, L6 24.8, L7 23.3, L8 18.8 with g = 1.75, F1 5.7, F2 3.9). Hence:

- ±10–15 % of R is ≤ 2 codes: invisible. Strokes need ±0.3–0.4 in R to change luma by 3–5 codes.
- With amount 0.4 and plateau-shaped brush values (|b| median ≈ 0.7), the measured |Δ luma| on opaque
  texels is p75 3.5–4.4 codes on L1–L3 and 6.0–7.9 on L4–L8 (p90 6.9–9.2), while every layer's
  alpha-weighted mean luma moves by ≤ 0.03 codes and coverage by ≤ 0.3 %. At mip 1 the far layers keep
  95 % of it (strokes ≥ 3 texels survive the 2×2 average).
- A gain multiplies the strokes, not the dry-brush edges or the rim mask, and post-grade 1:1 frames mix
  in far layers, fog and the gameplay plane: g = 1.5 gave only ×1.34 post-grade |Δ luma| on L4–L8
  pixels, 1.75 gives ×1.53. Measure the effect where you want it, post-grade, before tuning.
- Fog divides everything: far layers need no extra amplitude (their gain is already lower), and the
  foreground frame (5.7 and 3.9 codes per unit R) barely shows strokes; that is fine.

## Mean-preserving mask breakup (rim G)

Mip 1 averages 2×2 blocks aligned to even atlas rows and columns, and the kit shader samples mip 0–1.
If strokes changed the rim mask's block means, the mip-averaged rim, and with it a layer's value, would
shift. So the rim changes only *inside* each block:

```ts
// Per aligned 2×2 block with a rim byte ≥ 4 (listed by finalize as it writes G; the pass visits
// only those). The premultiplied sum S = Σ G·A is the invariant.
const s = k * (Σ A·brush / Σ A);                        // the block's stroke, covered texels only
w_q = s ≥ 0 ? G_q · max(0, 1 + s·(2·G_q/Gmax − 1))       // light stroke: concentrate toward the peak
            : G_q − (Gmax − G_q)·s·0.5;                  // dark stroke: flatten toward it
G'_q = w_q · S / Σ w·A;                                  // same premultiplied sum
λ = largest blend toward the old values that keeps every G' ≤ 255;
round with the premultiplied error carried to the next texel (the sum stays exact)
```

At 1:1 the rim alternates crisp and soft along the strokes; at mip 1 it is the same light. Check it on
the bytes the GPU averages: premultiplied as uploaded (`premultiplyRgba`), then the 2×2 mean: under
1 code before rounding (≤ 0.75 measured), so ≤ 1 code after, whatever the driver's rounding.

## Dry brush within the edge-noise budget

Plain edges: `d += (0.75·n1 + 0.25·n2)·disp` (two octaves of the table noise, peak ≈ 0.6). Painted:
`d += (n1·(0.75 − 0.35·dry) + n2·0.25·(1 − dry) + brush·DRY_SCALE·0.6·dry)·disp`, DRY_SCALE = 0.19 / 0.7
(the brush scaled to the edge noise's rms). The bound stays ≤ the plain one and ≤ `EDGE_NOISE_MAX`
(0.75), so no stroke thinner than before vanishes, texels beyond the band skip the noise, and the
coverage change stays ≈ 0.1 %. With dry = 1 the fine octave is replaced entirely (one lookup less).

## Terrain: arc-length stroke coordinate and the fwidth clamp

The terrain is a mesh (marching squares over an SDF), shaded per fragment; strokes there follow the
outline:

1. **Vertices carry (s, d)** (core stride 5 → 7 floats, `aStroke`): s = arc length of the nearest
   contour point, measured from the contour's lowest point (max y, then min x; usually below the level
   or an underside), wrapped mod W = 1024 so the hash keeps float precision; d = distance to that
   point. Crossings get their own arc length; interior grid corners within the blend depth + one cell
   get theirs by splatting each contour segment over the corners around it.
2. **Close every long outline on whole wraps.** For a contour of perimeter P ≥ W/2, s is the arc length
   × `round(P/W)·W/P` (0.67–2), so it returns to a multiple of W at the start point and the texture,
   periodic over W, has no seam there (unscaled, s restarted with a visible 12 u staircase and a break
   in the AA strip). Shorter outlines keep their length and fade their strokes out at the start point
   (continuity weight 0 there, 0.5 at its neighbours).
3. **The wrap without seams.** The stroke noise is periodic over the wrap (its along lattice index is
   taken mod 18 cells), and each polygon takes the shortest arc of the circle holding its s values: the
   values below the widest gap use copies of their vertices shifted by +W, so s interpolates the short
   way. Edge strips carry s in `aEdge.w`, unwrapped within each quad (a1 = a0 + length × scale).
4. **Portable periodic index.** `mod(i.x, 18.0)` on an exact multiple can return 18.0 under highp
   rounding on some drivers (a seam every wrap). Offset away from the multiples:
   `mod(i.x + 0.5, 18.0) − 0.5` (and `+ 1.5` for the neighbour); mirror it exactly on the CPU.
5. **No inner outline.** Every depth row of the texture must average 0.5 over a wrap, or the rim zone
   shows a faint light or dark band at some depth along every contour (seed-chosen salts gave 0.39–0.69).
   Make the lattice antithetic along s — the value half a period on is `1 − v` — and shape it with a
   curve symmetric about 0.5 (`smoothstep(0.22, 0.78)`): each row's mean is then exactly 0.5.
6. **Continuity weight.** Where the nearest contour point jumps (a thin mass's medial axis, a convex
   corner's mitre), s is discontinuous and a triangle across the jump interpolates garbage. The fwidth
   clamp alone fades those triangles one by one: at 1 px/u that is a stepped crack along every medial
   axis and mitre, so convex corners are **not** "left to the frequency clamp". Instead each grid corner
   gets a weight at build time: 0 where s jumps to a 4- or diagonal neighbour by more than 2.5 u per u
   (or it has no s), 0.5 next to such a corner, 1 elsewhere; crossings take their contour's (1, or the
   short-outline fade). Packed as `round(w·126)` in the unused 4th byte of `aSpill` (no stride change;
   ≤ 126 keeps the packed float finite), interpolated, it multiplies the stroke weight: a smooth fade.
   Invariants: no triangle with a weight > 0 spans more than W/2 in s; no triangle with all weights 1
   spans more than 2 × 2.5 cells.
7. **Shading.** Near the surface the stroke value *replaces* the fine strata value (same mean 0.5, same
   role), blending back to the world-space strata between 14 and 60 u of depth: the value separation
   from the background is untouched. Contrast-shaped value noise in (s, d): 57 u along, 11 u across
   (≈ 5 : 1). One more value-noise lookup (9 per fragment). The rim's stroke gain (2) multiplies the
   stroke value's deviation from 0.5; because the strokes replace the strata noise rather than add to
   it, their change grows slower than the gain (2 gives ×1.45 post-grade |Δ luma| over gain 1).
8. **fwidth clamp.** `aa = 1 − smoothstep(0.25, 0.5, max(fwidth(sc.x), fwidth(sc.y)))` in lattice cells
   per pixel (a value-noise cycle spans ≈ 2 cells, so this fades between 0.125 and 0.25 cycles/px).
   Nominal strokes stay below it (0.23 cells/px across at the lowest render scale, 0.388 px/u; the arc
   scale ≤ 2 keeps the along frequency below the across one), so it only guards the frequency; the
   continuity weight handles the discontinuities.

```glsl
float terrainStrokeAA(vec2 c) {   // c = (s·KS, d·KD): lattice cells; call in main (uniform control flow)
  return 1.0 - smoothstep(0.25, 0.5, max(fwidth(c.x), fwidth(c.y)));
}
// main: float strokeAA = terrainStrokeAA(vStroke.xy) * vStroke.z;   (z = the continuity weight)
float sv = 0.5 + 2.0 * (terrainStroke(stroke) - 0.5);
strata = mix(strata, sv, (1.0 - smoothstep(14.0, 60.0, depth)) * strokeAA);
```

## Budgets (measured, Node 22, this machine, cold)

- Kit bake: tables + bake +136–138 ms over the M1 kit (paired median of 20 interleaved cold runs, each
  started on an idle machine; budget +150): brush tables ≈ 15 ms at module load, M1 ≈ 450 ms. The
  measurement is noisy (±10 ms between runs of 15–30 pairs): gate each round on an idle machine.
- Same atlas size, no new textures, no runtime cost beyond one uniform: draw calls and fill unchanged.
- Terrain mesh build: +60 ms over M1 on the 260 × 50 level (the corner splat, the continuity pass,
  shortest-arc polygons with a fast path for short spans). Fragment cost: +1 value-noise lookup, one
  more varying (3 floats in the core, 2 on the edge strips).
- What it took (V8): evaluate the brush in tight module-level loops over index lists (a method that
  returns a double boxes it on every call; > 460 bytes of bytecode is never inlined), reloading a
  frame's parameters only when the owner changes; precompute each frame's map into table space; write
  the per-texel recording out in the shape loops (a non-inlined `put` boxes the distance, doubling GC);
  compute the stroke amplitude and list the rim blocks in finalize's loop as the bytes are written
  (read the float32 `alpha` back, not the float64 local, to stay byte-identical); hand finalize one
  fixed-shape options object (spread spec objects of assorted keys deoptimise it); build both brush
  octaves in one pass; build the smallest elements first (byte-identical atlas, since elements are
  independent) so the new loops reach optimised code on cheap elements.

## Pitfalls (rules)

- **Never rotate the noise domain per texel or per vertex.** Use the owning shape's frame.
- **One polar frame per lobe reads as bubbles** when the brush makes rings; give it at least four
  broad cells around (whole table periods), share the frame with the lobe's tufts and leaves, fade to
  the ring mean at the centre. Don't compress big lobes in brush space: the strokes then scale with
  the lobe and two cells around make a light and a dark half.
- **Seams come from ownership changes, not from frames.** Fade from the runner-up; don't blend
  frames' coordinates (unrelated coordinates mixed over a band sweep hundreds of cells).
- **Speckle comes from strokes narrower than ~3 texels or 2 px on screen**, from noise with too much
  fine octave, and from stroke gradients inside tiny shapes. Size strokes in layer units, check the
  smallest placed instance (recipes and decor), at the pixel floor derived from the presets.
- **Louder strokes: gain in the shading, not amplitude in the bake** (R clips, and the element's own
  detail would grow with it). Shade the plain atlas at gain 1 when comparing.
- **Zero-mean per element and bounded per texel,** or the value ramp drifts and R clips.
- **Keep scratch honest.** Per-texel scratch reused across elements must be written before it is read
  (the rim pass reads the stroke amplitude of every covered texel of its blocks: halo-only texels
  have none).
- **Rim breakup must keep the premultiplied 2×2 sums**, aligned to the atlas (not the element) grid.
- **CPU mirrors of GLSL hashes need float32** (`Math.fround` at each step): a float64 `fract(p·123.34)`
  is a different random number at large coordinates.
- **Derivatives in uniform control flow:** evaluate `fwidth` in `main` before branching, pass it in.
- **Mesh wrap:** interpolating a wrapped coordinate across the wrap sweeps the whole period in one
  triangle; duplicate the vertices shifted by one period, and make the texture periodic over it. Close
  long outlines on whole periods, and take `mod` of whole numbers off the multiples.
- **A texture that replaces a mean-0.5 term must average 0.5 at every depth**, not just overall, or it
  draws an inner outline.

## Tools and tests

- `node tools/preview/world/element-gallery.ts <out> --zoom 3 [--before] [--lum] <names…>`: elements,
  shaded or as the R structure (× the stroke gain); `scene-preview.ts <out> --shots [--ldtk file]
  [--before | --before-kit | --before-terrain] [--upto L8] [--crop x,y,w,h --zoom 2]`: the GPU
  screenshot cameras, with either part of the pass off to measure its share; `compare-shots.ts <gpuDir>
  <cpuDir> <out> [--suffix -before]`: CPU vs GPU luma per region; `stroke-report.ts <out>`: the
  per-layer table above, at mip 0 and mip 1.
- `tests/world/strokes.test.ts`: frame continuity along curves and around lobes (u and the brush value
  across φ = ±π, no concentric bands, ≥ 4 cells around, no compression), no seams across lobe
  boundaries (a margin below the unfaded jump, several seeds), the pixel floor derived from the presets,
  widths ≥ 3 texels and 2 px for the smallest instance recipes (host scale for attached crowns) and
  placeDecor place, brush elongation and periodicity, the dry-brush bound, determinism in any build
  order, the rim invariant on premultiplied mip-1 bytes, per-layer visibility (scaled by the gain) and
  mean luma, visibility at mip 1, the stroke gain (one per layer, detail restored within rounding),
  terrain stride 7, arc length from the lowest point with closure on whole wraps, nearest-point (s, d)
  (ties aside, every s matches), continuity weights (unit grid, thin ledge, mitre, short outline),
  triangle spans, the per-depth period mean, the portable mod, the shader strings and the frequency at
  the pixel floor.
