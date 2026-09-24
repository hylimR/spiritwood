# Parallax space, coverage extents and the value ramp

The listings here are verbatim from `src/render/util/camera.ts`, `src/render/layers/placement.ts` and
`src/render/layers/layerModel.ts`, unless marked otherwise.

## 1. The transform

A layer has a parallax factor `f = (fx, fy)`, where 0 is infinitely far, 1 is the gameplay plane, and more than 1 is foreground.
For camera centre `C`, zoom `z` and view size `V` (view units: `VIEW_H = 1080` tall, `VIEW_H·aspect` wide):

```
zoomF = 1 + (z − 1)·f
view  = (p − C·f)·zoomF + V/2
```

- `C·f` is the parallax shift. A layer with f = 0.1 scrolls a tenth as fast as the gameplay plane.
- `zoomF` makes distant layers zoom less. With a single scale, a zoom-in would magnify the sky as much as the hero,
  and depth would collapse.
- Screen shake is scaled by `min(f, 1)`, so far layers barely shake and foreground layers shake no more than the gameplay plane.
- `fy = 0` anchors a layer to the screen vertically (fog bands and foreground frames): `view.y = p.y + V/2`.

```ts
export function depthForParallax(f: number): number {
  return 0.05 + 0.9 * (1 - clamp(f, 0, 1));
}

export function depthForInstance(f: number, k: number): number {
  return depthForParallax(f) - k * DEPTH_INSTANCE_EPS;
}

export function zoomForParallax(zoom: number, f: number): number {
  return 1 + (zoom - 1) * f;
}

export function applyParallax(container: Container, cam: CameraFrame, fx: number, fy: number): void {
  const zx = zoomForParallax(cam.zoom, fx);
  const zy = zoomForParallax(cam.zoom, fy);
  const sx = cam.shakeX * Math.min(fx, 1);
  const sy = cam.shakeY * Math.min(fy, 1);
  container.scale.set(zx, zy);
  container.position.set(cam.viewW * 0.5 - cam.cx * fx * zx + sx, cam.viewH * 0.5 - cam.cy * fy * zy + sy);
}

/** Layer-space rect currently visible for a parallax layer. */
export function visibleLayerRect(cam: CameraFrame, fx: number, fy: number, out: Extent): Extent {
  const zx = zoomForParallax(cam.zoom, fx);
  const zy = zoomForParallax(cam.zoom, fy);
  const hx = cam.viewW / (2 * zx);
  const hy = cam.viewH / (2 * zy);
  const sx = (cam.shakeX * Math.min(fx, 1)) / zx;
  const sy = (cam.shakeY * Math.min(fy, 1)) / zy;
  out.x0 = cam.cx * fx - hx - sx;
  out.x1 = cam.cx * fx + hx - sx;
  out.y0 = cam.cy * fy - hy - sy;
  out.y1 = cam.cy * fy + hy - sy;
  return out;
}
```

`applyParallax` is the only place in the repo that turns a parallax factor into a transform. Every parallax view calls it
for each of its containers every frame. The pipeline calls it with f = 1 on the world-space slots. Keep one implementation and
test it (`tests/shared/camera.test.ts` checks that the visible rect maps exactly onto `[0, V]`).

## 2. How much a layer must cover

With the camera clamped to the level (centre `Cx ∈ [Vw/2, W − Vw/2]`) and zoom 1, the visible layer-space interval is
`[Cx·f − Vw/2, Cx·f + Vw/2]`. Its union over the camera's range is:

```
x0 = f·Vw/2 − Vw/2      = −(1 − f)·Vw/2
x1 = f·(W − Vw/2) + Vw/2 = f·W + (1 − f)·Vw/2
width = f·W + (1 − f)·Vw
```

At f = 0 that is exactly one view width, a static backdrop. At f = 1 it is the level. The code below generalises this to a
minimum zoom, since zooming out shows more, and to levels narrower than the view, where the camera centre sits at `W/2`:

```ts
export function layerExtent(
  levelW: number, levelH: number, viewW: number, viewH: number, fx: number, fy: number, minZoom = 1, out?: Extent,
): Extent {
  const e = out ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  const halfWorldW = viewW / (2 * minZoom);
  const halfWorldH = viewH / (2 * minZoom);
  const cMinX = Math.min(halfWorldW, levelW / 2);
  const cMaxX = Math.max(levelW - halfWorldW, levelW / 2);
  const cMinY = Math.min(halfWorldH, levelH / 2);
  const cMaxY = Math.max(levelH - halfWorldH, levelH / 2);
  const hx = viewW / (2 * zoomForParallax(minZoom, fx));
  const hy = viewH / (2 * zoomForParallax(minZoom, fy));
  e.x0 = cMinX * fx - hx;
  e.x1 = cMaxX * fx + hx;
  e.y0 = cMinY * fy - hy;
  e.y1 = cMaxY * fy + hy;
  return e;
}

export function coverageExtent(levelW: number, levelH: number, fx: number, fy: number): Extent {
  const a = layerExtent(levelW, levelH, VIEW_H * MIN_ASPECT, VIEW_H, fx, fy, MIN_CAMERA_ZOOM);
  const b = layerExtent(levelW, levelH, VIEW_H * MAX_ASPECT, VIEW_H, fx, fy, MIN_CAMERA_ZOOM);
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}
```

**Why the union over aspects:** placement walks a seeded RNG left to right across the extent. If the extent depended
on the live window, a resize would shift the RNG sequence and every tree would jump, which is the "reshuffle". Build once for
the union of the narrowest (4:3) and widest (21:9) aspect at the smallest zoom, and the forest is identical for every window.
Zooming out past `MIN_CAMERA_ZOOM` needs a rebuild, so clamp the camera instead.

## 3. Placement inside the extent (what the ramp is applied to)

- `baselineY = extent.y0 + def.baseline · (extent.y1 − extent.y0)`. Each layer has its own ground line. The baselines
  step down from far to near (0.62, 0.66, 0.70, 0.80, 0.82, 0.84, 0.86, 0.88), so the lower edge of every plane sits in front of mist rather than
  directly on the plane behind it.
- Streams anchor to `baseline`, `top` (canopy tops hang in from above) or `bottom` (foreground frames), and walk left → right with a seeded
  step of `1000 / (layer.density · stream.density)` × a random 0.55–1.45 (tiled streams such as `groundEdge` go edge to edge).
- **Clearings (air in x):** a stream can carry `gaps: { scale, below }`, a smooth 1D noise with one value per `scale` units. Instances are skipped
  where it falls below `below`, and no two neighbouring cells are both clear, so the openings stay glade-sized. Trunk streams also use
  `clearAtHints`: nothing is placed within `HINT_CLEARING` = 320 layer units of `hint.x · f` for the goal and every lantern, so the plane opens
  up behind gameplay landmarks.
- Painter order is stream order, then scale within a stream (smaller = farther), and a crown attached to a trunk (`attach`) draws right after
  that trunk. `k = 1..n` is written into the instance. `k = 0` is reserved for the layer's ground-fill quad, the backmost thing in the layer.
- Top-cut elements (trunks leaving the frame) have their upper rows stretched until the cut clears `extent.y0 − 12`, so a cut
  never shows at any camera position.
- `placeLayer` throws past `MAX_INSTANCES_PER_LAYER` (1024). That limit is part of the depth budget (see the depth pre-pass reference).

## 4. The aerial-perspective ramp (forest manifest)

These values come from `scripts/value-ramp.ts`, which runs the real `kitShadeParams` and `shadeKit` on
`public/layers/forest.manifest.json`. The body is a neutral texel (R = 0.5, shade 0.5) with no rim, and rim-lit uses G = 1. Mist is the colour once the
height mist has fully risen (recipe `mist` strength toward the recipe mist colour).

| layer | f | depth | tint | fog / fogColor | desat | rim | body (luma) | rim-lit | full mist (luma) |
|---|---|---|---|---|---|---|---|---|---|
| L1 farthest treeline | 0.08 | 0.878 | `#1a2a50` | 0.70 / `#2c4c78` | 0.25 | 0.10 | `#284269` (0.247) | 0.261 | `#2c4c78` (0.284) |
| L2 far treeline | 0.16 | 0.806 | `#152445` | 0.60 / `#274470` | 0.20 | 0.15 | `#21375c` (0.208) | 0.235 | `#274470` (0.255) |
| L3 misty trunks | 0.28 | 0.698 | `#10203a` | 0.50 / `#213d63` | 0.15 | 0.20 | `#1a2e4c` (0.173) | 0.218 | `#213d63` (0.227) |
| L4 mid forest | 0.40 | 0.590 | `#0c1a2e` | 0.40 / `#1b3a55` | 0.12 | 0.30 | `#13273c` (0.141) | 0.222 | `#1a4059` (0.227) |
| L5 mid forest | 0.52 | 0.482 | `#0a1627` | 0.30 / `#173450` | 0.08 | 0.40 | `#0e1f32` (0.113) | 0.239 | `#163a54` (0.205) |
| L6 mid forest | 0.66 | 0.356 | `#09131f` | 0.20 / `#142d45` | 0.04 | 0.50 | `#0b1826` (0.088) | 0.268 | `#133349` (0.179) |
| L7 near trunks | 0.80 | 0.230 | `#07101a` | 0.10 / `#11273b` | 0 | 0.70 | `#08121d` (0.066) | 0.350 | `#0f2738` (0.137) |
| L8 near trunks | 0.90 | 0.140 | `#050c15` | 0.04 / `#0f2234` | 0 | 0.85 | `#050d16` (0.047) | 0.414 | `#0d2231` (0.118) |
| F1 / F2 frame | 1.25 / 1.55 | (no depth) | `#03060b` / `#020408` | 0 | 0 | 0 | 0.022 / 0.015 | same | same |

What the table shows:

- **Body value falls monotonically** (0.247 → 0.047). The steps shrink from 0.039 (L1 → L2) to 0.019 (L7 → L8). They are largest at the far end, where
  rim contrast is lowest and the value step is the only thing separating the planes.
- **Contrast rises toward the viewer.** The gap between body and rim-lit grows from 0.014 (L1) to 0.367 (L8). Far layers are
  flat washes, and near layers are near-black with bright moonlit edges.
- **Saturation rises toward the viewer** (desaturate 0.25 → 0). The fog colour darkens and shifts from indigo to teal-navy (`#2c4c78` →
  `#0f2234`), so the air behind a plane is always brighter than the air in front of it.
- **Every plane's mist is brighter than the body of the plane behind it** (for example, L5 mist 0.205 against L4 body 0.141, and L8 mist 0.118 against L7
  body 0.066). The bottom of each plane dissolves into a band that is lighter than the next plane back, and that band is the "air" between them.
  Mid and near recipes lift the mist toward teal (`mistLift` (0, 0.035, 0.03) and (0, 0.025, 0.025) added to the fog colour), so the mist glows
  rather than greys.
- **The foreground is a separate regime.** It is near-black, has no rim and uses a baked blur (`softness: 9 * FG_K` = 6 texels at 3.3 u/texel
  in `kitElements.ts`). It frames the view and doesn't take part in the ramp.
- **Softness is part of the ramp too.** Far trees use 2.5 u/texel, canopies and mid trunks 2, near trunks and root arches 1.4, and small near props
  1.1–1.6, so far edges are softer for free. Far elements also bake a bottom fade into the atlas (`fadeBottom`), so far masses never fill down to
  the screen bottom.

Value steps alone don't separate planes. An earlier version of this ramp, with body steps of 0.02–0.03, the height mist in each layer's own fog colour, one blue fog family and no clearings,
read in the project's screenshot review as one flat blue wall wherever far and mid canopies overlapped. More layers did not fix it. What did:
per-layer mist colour, wider far steps, clearings in x (section 3), a stronger rim that grows toward the viewer, and a different silhouette vocabulary per
depth band (see sdf-silhouettes). The script's `minStep` flag (default 0.015) is a heuristic, so judge overlapping planes in a rendered frame.

### Height mist (the "air" in y)

```ts
// kitShadeParams (layerModel.ts)
mistColor: [fogColor[0] + recipe.mistLift[0], fogColor[1] + recipe.mistLift[1], fogColor[2] + recipe.mistLift[2]],
mistY: placement.baselineY - recipe.mistDepth * 0.25,
mistDepth: recipe.mistDepth,
mist: recipe.mist,
```

```glsl
float mistAmount() {
  float t = clamp((vLayerY - uMistY) / max(uMistDepth, 1e-3), 0.0, 1.0);
  return min(1.0, t * t * uMist);
}
// c = mix(mix(c, uFogColor, uFog), uMistColor, mistAmount());
```

- The mist starts `0.25·mistDepth` above the baseline and rises quadratically (t²), so the base of each trunk stays mostly readable.
  It reaches `uMist` at `mistY + mistDepth`.
- Recipes: far treeline `mist 1, depth 260` (the bottom dissolves completely into the fog colour), mid `0.9, 360`, near `0.75, 400`, frame `0`.
- `vLayerY` is the **unswayed** layer-space y (`aPosition.y`), so the mist doesn't wobble with the wind.
- Glow is cut by the combined fog (`fog = uFog + (1 − uFog)·m`, `e = B·(1 − 0.6·fog)`), so glowing flowers deep in the mist glow less.

## 5. Quality thinning keeps the ramp's shape

`selectLayers` keeps the layers whose `minQuality` the level meets, then drops the farthest ones down to the layer budget. The manifest
spreads `minQuality` so that each tier thins the stack evenly and doesn't cut off one end:

| quality | kit layers drawn |
|---|---|
| low (budget 6) | L2, L4, L6, L7, L8, F1 |
| medium (8) | + L3, F2 |
| high (10) | + L1, L5 |

On Low the steps widen where a layer is dropped (L2 → L4 is 0.067, L4 → L6 0.053), but the ramp still runs from the pale far layers to the dark near ones. Fog bands follow the
same pattern (`selectFogBands`: `fog-low` always, `fog-near` from Medium).
