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
  `aDist` = depth inside (`clamp(−d, 0, shadeDepth = 90)`), `aLit` = how squarely the nearest surface faces the moon (direction (−0.55, −0.83)),
  and `aSpill`, baked light packed as `unorm8x4` (lantern warm, flora teal, thorn rose, each `(1 − d/r)²` within 330, 240 or 130 u).
  Baking static light costs nothing per frame. The flicker lives in additive light pools drawn on top.
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

```glsl
vec3 terrainColor(float depth, vec2 world, float lit, vec3 spill) {
  float t = pow(clamp(depth / uShadeDepth, 0.0, 1.0), 0.7);
  float warp = sw_vnoise(world * 0.0045) * 70.0;
  float strata = sw_vnoise(vec2(world.x * 0.0022, (world.y + warp) * 0.026));
  float mottle = sw_vnoise(world * 0.019 + 13.1);
  vec2 rw = vec2(world.x * 0.866 - world.y * 0.5, world.x * 0.5 + world.y * 0.866);
  float sn = 0.6 * sw_vnoise(vec2(rw.x * 0.06 + 5.3, rw.y * 0.07 + 1.9)) + 0.4 * sw_vnoise(vec2(rw.y * 0.11 + 2.1, rw.x * 0.12 + 8.4));
  float stone = smoothstep(0.64, 0.72, sn);
  float vein = 1.0 - smoothstep(0.0, 0.03, abs(sw_vnoise(vec2(rw.y * 0.011 + 7.7, rw.x * 0.017 + 3.1)) - 0.5));
  vec3 c = mix(vec3(0.0431, 0.0980, 0.1569), vec3(0.0196, 0.0431, 0.0784), t) * (1.0 + 0.55 * (strata - 0.5) + 0.3 * (mottle - 0.5))
    * (1.0 + 0.4 * stone + 0.7 * vein * (1.0 - t));
  c += vec3(0.1000, 0.2500, 0.3100) * (lit * exp(-depth / 16.0));
  c += (vec3(0.3600, 0.1835, 0.0565) * spill.x + vec3(0.0346, 0.2108, 0.1854) * spill.y + vec3(0.3000, 0.0302, 0.0598) * spill.z) * exp(-depth / 46.0);
  return c;
}
// core: finalColor = vec4(terrainColor(vDist, vWorld, vLit, vSpill) + sw_dither(gl_FragCoord.xy), 1.0);
```

(These are the template constants of `terrain.glsl.ts` resolved: edge `#0b1928`, deep `#050b14` = `PALETTE.silhouette`, rim reach 16 u,
spill reach 46 u.)

- **Depth ramp:** the colour runs from the lifted edge colour to the deep silhouette colour over 90 u (`pow 0.7` keeps the lift near the surface).
  The terrain is the darkest plane in the depth ramp. Only the foreground frames are darker.
- **Interior texture:** warped horizontal strata, mottling, embedded stones (peaks of a mid-frequency noise) and root veins (a thin iso-line
  `|n − 0.5| < 0.03` of a stretched noise, strongest near the surface). The stone and vein noises use a lattice rotated by 30°, because
  thresholded value noise on the axis-aligned lattice reads as blocks.
- **Moonlit rim zone:** `lit · exp(−depth/16)` adds a cold light just inside surfaces that face the moon, which ties the ground to the rim-lit
  parallax layers.
- **Spill:** baked lantern, flora and thorn light fades into the ground over 46 u.

## 5. Rules (why grid terrain stops reading as boxes)

With rounded corners and ±4 u displacement alone on 48-u tiles, the project's screenshots still read as **grid boxes**: straight walls, flat
undersides and uniform interiors. The rules it arrived at, now implemented as above:

- **Organic outlines.** Use per-corner radii and facing-dependent displacement, and put the large, slow deformation where collision allows it (undersides:
  lumps and drips). No run of edge should look ruled for more than a tile or two.
- **Interior gradient and texture.** Use a depth-inside gradient plus strata, stones and veins, so large masses don't read as flat fills.
- **Undersides with drips and roots.** Ceilings hang pendant drips in the field itself. Decor adds root `tendril`s under 20 % of ceiling tiles
  (`decorPlacement.ts`).
- **Walkable tops stay within ±2 u of collision.** However organic the rest is, the feet must meet the drawn surface. Clamp the noise, damp its
  amplitude by the up-facing factor, and test the tolerance against the *meshed* contour (`tests/world/terrainMesh.test.ts`).
- **The core must not discard.** Put every ragged or translucent edge (feather, moss blades) in the strips or in decor drawn after the core,
  never in the opaque core.
