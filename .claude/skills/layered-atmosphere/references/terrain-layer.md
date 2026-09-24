# Terrain as the nearest opaque layer

The terrain is the gameplay plane (f = 1). In the atmosphere it is the nearest, darkest and crispest opaque plane.
It has three parts:

1. an opaque **core** mesh in the pre-pass at `DEPTH_TERRAIN` 0.05, which occludes every parallax layer through early-Z;
2. a thin **AA feather** strip;
3. a **moss lip** strip on up-facing edges, whose light is also twinned into the glow buffer.

Parts 2 and 3 draw in slot `terrain` with no depth test. Sources: `src/render/terrain/terrainField.ts`,
`terrainMesh.ts`, `terrainLight.ts`, `terrain.glsl.ts`, `terrainShading.ts` (the TS twin), `terrainView.ts`.

## 1. A signed distance field of the tiles, displaced by facing

```ts
export const DEFAULT_FIELD: TerrainFieldOptions = {
  cornerRadius: 10,
  cornerJitter: 3,
  underRadius: 16,
  underJitter: 8,
  dispAmp: 3.5,
  flatAmp: 1.2,
  underAmp: 9,
  dripLen: 30,
  dispFreq: 0.75,
  maxDist: 96,
  seed: 1,
};
export const FLOOR_TOLERANCE = 2;
export const WALL_TOLERANCE = 4;
```

- `base(x, y)` is an exact rounded-box distance to the nearest differing tile in a 5×5 tile neighbourhood. Only **convex** corners are rounded,
  and each corner's radius is hashed: top corners 10–13 u (so walkable tops stay flat almost to the edge), bottom corners 16–24 u (capped at half
  a tile), which makes undersides irregular. Concave corners stay sharp. Lookups beyond the level repeat the edge tiles, so the level border never
  shows an artificial edge.
- `sample(x, y)` displaces the surface by **facing**, taken from the vertical gradient of `base` (y down: floors have ∂d/∂y ≈ −1, undersides ≈ +1):

```ts
const g = (this.base(x, y + 2) - this.base(x, y - 2)) * 0.25;
const up = smooth01((-g - 0.5) / 0.4);
const down = smooth01((g - 0.35) / 0.45);
const f = o.dispFreq;
const nz = (this.noise.sample(x * f, y * f) * 0.8 + this.noise.sample(x * f * 2.7 + 50, y * f * 2.7 + 20) * 0.2) * NORM;
const n = nz < -1 ? -1 : nz > 1 ? 1 : nz;
let v = d + n * (o.dispAmp + (o.flatAmp - o.dispAmp) * up);
if (down > 0) {
  const l = this.noise.sample(x * 0.6 + 90, y * 0.6 + 40) * NORM;
  const lump = l < -1 ? -1 : l > 1 ? 1 : l;
  v += down * (lump * o.underAmp - this.drip(x));
}
return v;
```

- **Clamp the noise to ±1** (`NORM = 2.2` scales the table's fbm, whose RMS is about 0.2, to about ±1). That makes the tolerances provable:
  floors move at most 1.2 u and walls at most 3.5 u. The tests check drawn floors within ±`FLOOR_TOLERANCE` (2 u) and walls within
  ±`WALL_TOLERANCE` (4 u) of the collision surface, away from corners.
- **Undersides are free**, since the player only bonks them. They get ±9 u lumps plus pendant **drips**: on a 76-u cell grid, 70 % of cells
  hang one pointed bump, 13–25 u half-width, `dripLen·(0.35…1)` long with a `t^1.6` profile. Subtracting from the distance makes the solid
  bulge down.
- Early outs keep it cheap: beyond the displacement band it returns `d`, and far enough outside with no solid above it skips the noise.

## 2. Marching squares into chunked meshes

- Grid: `cell = 12` u (a quarter tile), offset by half a cell from the tile lines (`gx0 ≡ C/2 mod C`). Tile corners then fall on
  cell centres, so rounded corners are sampled symmetrically. The outer ring is forced outside (`+maxDist`) so every contour closes.
  The geometry extends `margin` 48 u beyond the level for screen shake.
- Crossings are refined against the exact field with regula falsi plus a bisection guard (up to 8 iterations, stopping at |f| < 1e-3). Contours
  then sit on the displaced surface, not on a linear interpolation of 12-unit samples. That matters for drips and the floor tolerance.
- Saddles (codes 5 and 10) are resolved by sampling the field at the cell centre.
- The segment table is oriented so that the solid lies on the left when walking a segment. In y-down space the outward normal of a
  direction `(dx, dy)` is then `(−dy, dx)`. Vertex normals average the two adjacent segments and apply miter compensation
  (`1/cos`, with cos clamped to ≥ 0.35), so the strips keep a constant width around corners.
- The core is a per-cell polygon (inside corners plus crossings), fan-triangulated. A core vertex (5 floats) carries `aPosition`,
  `aDist` = depth inside, `aLit` = how squarely the nearest surface faces the moon (direction (−0.55, −0.83)),
  and `aSpill`, baked light packed as `unorm8x4` (lantern warm, flora teal, thorn rose, each `(1 − d/r)²` within 330, 240 or 130 u).
  Baking static light costs nothing per frame. The flicker lives in additive light pools drawn on top.
- `aDist` must keep growing deep inside thick masses, or they shade flat. The field is clamped (`maxDist` 96 u), so `interiorDepth`
  keeps the exact `−d` where the field is below its clamp and fills deeper samples with a two-pass chamfer distance (3×3 plus knight
  moves, within a few percent of Euclidean) seeded from that band, capped at `shadeDepth + TERRAIN_DEEP_REACH` = 90 + 336 u. The forced
  outer ring seeds nothing, so ground that runs off the level edge keeps deepening instead of meeting a phantom surface.
- Chunks are 16 tiles (768 u) with Uint16 indices, and the builder throws past 65,535 vertices. Each contour segment goes to the chunk of
  the cell that produced it.

## 3. Strips: AA feather and moss lip

Edge vertex (9 floats): `aPosition (2)`, `aNormal (2)`, `aEdge = (side ±1, kind 0 AA / 1 moss, up 0..1, 0)` and `aSpill`. The vertex
shader offsets each vertex along its normal *at draw time*:

```glsl
float side = aEdge.x;
float off = aEdge.y > 0.5 ? (side < 0.0 ? side * uMossIn : side * uMossOut) : side * uAA;
vec2 p = aPosition + aNormal * off;
```

The feather's half-width is recomputed every frame in world units, so the strip stays about 2 × 1.25 device pixels wide at any render scale or zoom:

```ts
export const AA_PX = 1.25;
export const AA_MAX_UNITS = 4;
export function terrainAAWidth(pxPerUnit: number, zoom: number): number {
  const pxPerWorld = pxPerUnit * zoom;
  if (!(pxPerWorld > 0)) return AA_MAX_UNITS;
  return Math.min(AA_MAX_UNITS, AA_PX / pxPerWorld);
}
```

- The feather's alpha is `(1 − side)/2`: opaque at `−AA` (inside the core), transparent at `+AA`. Its colour is the core colour at depth 0,
  so the inner half blends invisibly over the core. This is the terrain's only AA. The scene target has no MSAA, and the strip covers the core's
  hard edge.
- The moss reaches 9 u into the ground and 6 u out of it. Segments with `max(up) ≥ 0.12` get a moss quad, and the shader fades it in with
  `smoothstep(0.12, 0.55, up)`. The outer half is a tufted lip: blades of alpha along the edge overhang the silhouette and break the straight line.
  It has patchy value-noise coverage and glowing specks. The glow twin reuses the edge vertex buffer with moss-only indices and draws with
  `mesh.blendMode = 'add'` in glow slot `world`.

## 4. Shading

8 value-noise lookups and 2 hashes per fragment (`terrain.glsl.ts`, template constants resolved; CPU twin `shadeTerrainCore` and
`stoneAt` in `terrainShading.ts`):

```glsl
vec3 terrainColor(float depth, vec2 world, float lit, vec3 spill) {
  float t = pow(clamp(depth / uShadeDepth, 0.0, 1.0), 0.7);
  float k = clamp((depth - uShadeDepth) / 336.0, 0.0, 1.0);
  float warp = sw_vnoise(world * 0.0045) * 70.0;
  float strata = sw_vnoise(vec2(world.x * 0.0022, (world.y + warp) * 0.026));
  float mottle = sw_vnoise(world * 0.019 + 13.1);
  float band = sw_vnoise(vec2(world.x * 0.0011 + 3.1, (world.y + warp * 1.5) * 0.0072 + 7.3));
  float seam = 1.0 - smoothstep(0.0, 0.016, abs(band - 0.5));
  vec2 rw = vec2(world.x * 0.866 - world.y * 0.5, world.x * 0.5 + world.y * 0.866);
  float sn = 0.6 * sw_vnoise(vec2(rw.x * 0.06 + 5.3, rw.y * 0.07 + 1.9)) + 0.4 * sw_vnoise(vec2(rw.y * 0.11 + 2.1, rw.x * 0.12 + 8.4));
  float pebble = smoothstep(0.64, 0.72, sn);
  float vein = 1.0 - smoothstep(0.0, 0.03, abs(sw_vnoise(vec2(rw.y * 0.011 + 7.7, rw.x * 0.017 + 3.1)) - 0.5));
  float root = (1.0 - smoothstep(0.0, 0.022, abs(sw_vnoise(vec2(rw.x * 0.0095 + 1.3, rw.y * 0.0032 + 4.9)) - 0.5)))
    * smoothstep(0.3, 0.62, band);
  vec2 q = rw / 72.0;
  vec2 qi = floor(q);
  float hs = sw_hash21(qi + vec2(41.7, 12.9));
  float su = fract(hs * 7.3);
  float sr = (0.11 + 0.23 * su * su) * 72.0;
  vec2 sq = (q - qi) * 72.0 - (sr + (72.0 - 2.0 * sr) * fract(hs * vec2(31.1, 57.7)));
  float asp = 0.62 + 0.38 * fract(hs * 91.3);
  vec2 se = vec2(sq.x, sq.y / asp);
  float sd = length(se) / sr * (1.0 + 0.5 * (sn - 0.5) + 0.4 * (mottle - 0.5));
  float has = 1.0 - step(0.3, hs);
  float body = has * (1.0 - smoothstep(0.9, 1.0, sd));
  vec2 sn2 = vec2(se.x, se.y / asp);
  float facing = dot(vec2(0.866 * sn2.x + 0.5 * sn2.y, -0.5 * sn2.x + 0.866 * sn2.y), vec2(-0.5500, -0.8300)) / (length(sn2) + 1e-6);
  float crevice = has * smoothstep(0.98, 1.05, sd) * (1.0 - smoothstep(1.05, 1.2, sd)) * (0.2 + 0.8 * smoothstep(-0.2, 0.7, -facing));
  float lum = (1.0 + 0.55 * (1.0 - 0.45 * k) * (strata - 0.5) + 0.3 * (mottle - 0.5))
    * (0.85 + 0.3 * band) * (1.0 - 0.34 * seam)
    * (1.0 - 0.35 * crevice);
  float detail = 1.0 + 0.4 * pebble + 0.7 * vein * (1.0 - 0.6 * t)
    + 0.45 * root + 0.2 * body + 0.42 * body * min(sd, 1.0) * facing;
  vec3 tint = mix(vec3(1.0), vec3(0.8000, 1.1400, 1.0600), smoothstep(0.35, 0.65, band));
  vec3 c = mix(vec3(0.0431, 0.0980, 0.1569), mix(vec3(0.0290, 0.0540, 0.0970), vec3(0.0310, 0.0520, 0.1080), k), t) * tint * (lum * detail);
  vec2 gc = floor(world / 26.0);
  float gh = sw_hash21(gc + vec2(17.3, 5.1));
  vec2 gp = (gc + 0.2 + 0.6 * fract(gh * vec2(13.7, 71.3))) * 26.0;
  float glint = step(0.965, gh) * (1.0 - smoothstep(0.6, 2.8, length(world - gp)));
  c += mix(vec3(0.0494, 0.2284, 0.1854), vec3(0.0974, 0.1544, 0.2000), step(0.5, fract(gh * 431.7))) * glint;
  c += vec3(0.1000, 0.2500, 0.3100) * (lit * exp(-depth / 16.0));
  c += (vec3(0.3600, 0.1835, 0.0565) * spill.x + vec3(0.0346, 0.2108, 0.1854) * spill.y + vec3(0.3000, 0.0302, 0.0598) * spill.z) * exp(-depth / 46.0);
  return c;
}
// core: finalColor = vec4(terrainColor(vDist, vWorld, vLit, vSpill) + sw_dither(gl_FragCoord.xy), 1.0);
```

- **Two ramps, no black.** `t` runs from the lifted edge colour `#0b1928` over the rim zone (`shadeDepth` 90 u, `pow 0.7` keeps the lift
  near the surface) into a deep indigo/teal-black (0.029, 0.054, 0.097). `k` then drifts it slightly more indigo, to (0.031, 0.052, 0.108),
  over the next 336 u instead of darkening. Interior p95 stays below `fogDeep`, so the terrain is still the darkest gameplay plane and
  separates from every background layer; only the foreground frames are darker.
- **Structure that survives gameplay zoom:** broad strata bands (a slow noise over warped rows, about 140 u apart) alternate indigo and
  teal-shifted at ±15 % brightness, with thin dark bedding seams on their 0.5 iso-line; a root network (iso-line of a noise stretched down
  and to the right, shown only where the band is high, so it breaks into strands); fine strata and mottling; pebbles (peaks of a
  mid-frequency noise); rootlets (thin iso-line, strongest near the surface).
- **Embedded stones:** at most one per 72-u cell of a lattice rotated by 30° (30 % of cells), radius 8–25 u, an ellipse kept inside its
  cell. The outline is scaled by the pebble and mottle noises already sampled, so no stone is a perfect ellipse. Pillow shading lightens
  the moon-facing rim and darkens the far one, and the crevice is a contact shadow on the far side (20 % strength on the lit side).
  A symmetric dark ring around a round stone reads as a bubble.
- **Rotated lattices:** the pebble, rootlet, root and stone noises use a lattice rotated by 30°, because thresholded value noise on the
  axis-aligned lattice reads as blocks.
- **Glints:** at most one faint moss or mineral speck (≈ 2.8 u) per 26-u cell in 3.5 % of cells.
- **Moonlit rim zone:** `lit · exp(−depth/16)` adds a cold light just inside surfaces that face the moon, which ties the ground to the
  rim-lit parallax layers.
- **Spill:** baked lantern, flora and thorn light fades into the ground over 46 u.

## 5. Rules (why grid terrain stops reading as boxes)

With rounded corners and ±4 u displacement alone on 48-u tiles, the project's screenshots still read as **grid boxes**: straight walls, flat
undersides and uniform interiors. The rules it arrived at, now implemented as above:

- **Organic outlines.** Use per-corner radii and facing-dependent displacement, and put the large, slow deformation where collision allows it (undersides:
  lumps and drips). No run of edge should look ruled for more than a tile or two.
- **Interior gradient and texture.** Use a depth-inside gradient plus strata, stones and veins, so large masses don't read as flat fills.
- **Big masses read as holes.** An interior that sinks to near-black reads as a void, however well textured its rim. Lift the floor off
  black, keep structure visible at gameplay zoom, and carve the level itself: in Spiritwood, solid rock more than 3 tiles from open air
  covers < 8 % of any gameplay view (`node tools/level/masses.ts`, enforced by `tests/level/forest.test.ts`). A 23 × 28-tile cliff that
  filled 60 % of the goal view became ledges, a column, a knoll and open air onto the forest.
- **Undersides with drips and roots.** Ceilings hang pendant drips in the field itself. Decor adds root `tendril`s under 20 % of ceiling tiles
  (`decorPlacement.ts`).
- **Walkable tops stay within ±2 u of collision.** However organic the rest is, the feet must meet the drawn surface. Clamp the noise, damp its
  amplitude by the up-facing factor, and test the tolerance against the *meshed* contour (`tests/world/terrainMesh.test.ts`).
- **The core must not discard.** Put every ragged or translucent edge (feather, moss blades) in the strips or in decor drawn after the core,
  never in the opaque core.
