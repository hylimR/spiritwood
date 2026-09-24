# Organic building blocks

Recipes for trees, foliage and part art on top of the repo's `ElementRaster` (`src/render/gen/raster.ts`)
and the SDF helpers (`src/render/gen/sdf.ts`). Section 1 is new code verified against the current API
(typechecks under the repo config and renders; see "What it produces"). Sections 2–5 describe what
already exists in the repo, with the reasoning behind each trick.

## 1. Branching skeleton + clump-of-clumps crowns (fixes "lollipop" trees)

Structure first: a recursive branch system collects its terminal tips; crowns are then grown on those
tips, lowest first, so higher clumps overlap lower ones and every clump is carried by a visible limb.
Each clump is a body, lobes on an irregular envelope (bigger toward the top, where foliage heaps toward
the light) and small tufts on each lobe rim, which gives the fractal outline that reads as leaves at
near scale while the lobes still read as masses at far scale.

```ts
// Lives next to src/render/gen/raster.ts.
import type { Rng } from '../../core/rng.ts';
import { ElementRaster, Mat } from './raster.ts';

const UP = -Math.PI / 2;

export interface Tip { x: number; y: number; ang: number; rad: number }

/** Recursive tapered limbs with gravity sag and light-seeking; collects terminal tips. */
export function branch(
  r: ElementRaster, rng: Rng, x: number, y: number, ang: number, len: number, rad: number, depth: number, tips: Tip[],
  edgePad = 12,
): void {
  const a = ang + rng.range(-0.2, 0.2);
  const pad = edgePad + rad;
  const ex = Math.min(r.w - pad, Math.max(pad, x + Math.cos(a) * len));
  const ey = Math.min(r.h - pad, Math.max(pad, y + Math.sin(a) * len + 0.004 * len * len));
  const bend = rng.range(-0.12, 0.12) * len;
  const mx = (x + ex) / 2 - Math.sin(a) * bend;
  const my = (y + ey) / 2 + Math.cos(a) * bend;
  const endR = rad * 0.66;
  r.curve(x, y, mx, my, ex, ey, rad, endR, Mat.Bark, rad * 0.5, Math.max(4, Math.min(12, Math.round(len / 7))));
  const endAng = Math.atan2(ey - my, ex - mx);
  if (depth <= 0 || endR < 1) {
    tips.push({ x: ex, y: ey, ang: endAng, rad: endR });
    return;
  }
  const n = rng.chance(0.25) ? 3 : 2;
  for (let i = 0; i < n; i++) {
    let ca = endAng + (i - (n - 1) / 2) * 0.7 * rng.range(0.75, 1.2) + rng.range(-0.2, 0.2);
    ca += (UP - ca) * 0.15;
    branch(r, rng, ex, ey, ca, len * rng.range(0.62, 0.8), endR * rng.range(0.85, 1), depth - 1, tips, edgePad);
  }
}

/** Clump of clumps: a body, lobes on an irregular envelope (bigger toward the top), tufts on each lobe rim. */
export function clump(r: ElementRaster, rng: Rng, cx: number, cy: number, rx: number, ry: number, lobes = 6, tufts = 6): void {
  const p1 = rng.range(0, 6.28);
  const p2 = rng.range(0, 6.28);
  const m = Math.min(rx, ry);
  r.ellipse(cx, cy + ry * 0.06, rx * 0.64, ry * 0.6, Mat.Leaf, 3);
  const a0 = rng.range(0, 6.28);
  for (let i = 0; i < lobes; i++) {
    const a = a0 + (i / lobes) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const env = 1 + 0.2 * Math.sin(3 * a + p1) + 0.1 * Math.sin(5 * a + p2);
    const lr = m * rng.range(0.34, 0.48) * (0.9 + 0.25 * Math.max(0, -Math.sin(a)));
    const lx = cx + Math.cos(a) * rx * 0.55 * env;
    const ly = cy + Math.sin(a) * ry * 0.55 * env;
    r.ellipse(lx, ly, lr, lr * rng.range(0.78, 0.95), Mat.Leaf, 2.5);
    for (let t = 0; t < tufts; t++) {
      const ta = a + rng.range(-1.35, 1.35);
      const tr = lr * rng.range(0.18, 0.3);
      const d = lr * rng.range(0.78, 0.98);
      r.ellipse(lx + Math.cos(ta) * d, ly + Math.sin(ta) * d, tr, tr * rng.range(0.75, 1), Mat.Leaf, 1.2);
    }
  }
}

/** A tree: branching skeleton, then crowns at the tips, lowest first so higher clumps overlap. */
export function drawTree(r: ElementRaster, rng: Rng, groundY: number): void {
  const tips: Tip[] = [];
  branch(r, rng, r.w / 2, groundY, UP + rng.range(-0.08, 0.08), r.h * 0.32, 8, 3, tips, 42);
  tips.sort((a, b) => b.y - a.y);
  for (const t of tips) {
    const s = rng.range(16, 24);
    const ext = 6 + s * 1.5;
    const x = Math.min(r.w - ext, Math.max(ext, t.x));
    const y = Math.max(ext, t.y - s * 0.3);
    clump(r, rng, x, y, s * 1.2, s, 5, 5);
  }
}
```

Why the numbers:

- `0.004 * len * len` sag pulls long limbs down more than short ones (gravity); `(UP - ca) * 0.15`
  pulls children toward vertical (light-seeking). Together they give the drooping-then-rising arc of
  real limbs instead of straight fork lines.
- Radius tapers ×0.66 per level and recursion stops below 1 texel, so twigs end thin instead of blunt.
- `k = rad * 0.5` fillets each child into its parent; `curve` adds `k ≥ 0.6` at internal joints.
- The bend (`±0.12·len` perpendicular offset of the Bézier control point) breaks the straight-segment
  look; segments scale with length (`len / 7`, 4–12).
- `edgePad` clamps tips by the size of the crown that will grow there, so crowns land on their twigs
  instead of being pushed off them by the rect clamp. The crown clamp (`6 + s * 1.5`) covers the lobe
  and tuft reach, so nothing reaches the edge fade.
- Lobes use `k = 2.5`, tufts `k = 1.2`: they merge into one mass, but the tuft scallops survive.

What it produces (200×300 texels, depth 3): a leaning trunk forking into 2–3 limbs, each ending in
heaped, scalloped crowns with gaps between them; at ×4 downsampling it still reads as a tree, where a
single ellipse on a stick reads as a lollipop. ≈ 16 ms per tree including `finalize`.

Variations: willow (few clumps plus many `strand` curtains from the limbs), conifer (tiers whose reach,
spacing and droop are jittered, some skipped, with fringed `leaf` skirts instead of a symmetric
fishbone), snag (no crowns; `carve` a jagged break into the top, bare forks, hanging moss strands).

## 2. Existing blocks in `src/render/gen/kitElements.ts`

| Block | What it does and why |
|---|---|
| `fitLength(r, x, y, ang, len, pad)` | Shortens a stroke so its tip stays inside the rect minus margin (never below 35 % of `len`). Use for any stroke aimed at an edge. |
| `limb(r, x0, y0, x1, y1, bend, r0, r1, mat, k = 4, segments = 12)` | Tapered limb bent by moving the Bézier control point `bend` texels along the normal of the chord. |
| `risingTrunk(r, rng, cx, ground, baseR, topR, wobble)` | 16 capsules from below the ground line up through the top edge (a `cut: 'top'` element): lean, two-frequency sine wobble, radius taper `pow(t, 0.7)` with a small ripple, `k = 6` joints. Returns the path; `pathAt(path, t)` attaches branches, moss and fungi to it. |
| `roots(r, rng, cx, groundY, trunkR, spread, count)` | Alternating sides, reach growing outward, each root a `curve` from 1.4–2.6 radii up the trunk down to the ground line, radius 0.42–0.62·r → 1.6, fillet `k = 0.55·r` so the flare melts into the trunk. |
| `cloudCrown(r, rng, cx, cy, rx, ry, clumps, clumpR)` | Soft body plus clumps on an envelope `1 + 0.22 sin 3a + 0.12 sin 5a`, radial bias `pow(rng, 0.4)`, smaller toward the rim. Reads as a blob with satellites on its own; only use it on a skeleton, and keep satellites overlapping the body. |
| `frond(r, rng, bx, by, ang, len, droop, leaf, mat, ribR)` | Curved rib plus paired leaflets at ±1.05 rad from the local tangent, shrinking to 25 % at the tip. Ferns, bush sprays, foreground fronds. |
| `strand(r, rng, x, y, len, sway, r0, r1, leaf, mat)` | Hanging Bézier with alternating downward leaves (vines, moss, curtains, tendrils). `leaf = 0` gives a bare strand. |
| `mushroom(r, rng, x, groundY, h, capR, lean, glow)` | Stem curve, cap ellipse, `carve` for the gill hollow, emissive disc and spots. |
| `glowBulb(r, x, y, rad, halo, haloStrength)` | Petal ellipse, emissive disc, optional baked halo (`haloAt`). |
| `branch(r, rng, x, y, side, len, rad, leafy)` + `sprig` | Side branch with a fork, leaf sprigs and moss strands. The sprig (a fan of similar leaves) reads as a hand at mid scale; replace it with a clump or a drooping spray. |
| `ElementRaster.leaf(bx, by, ang, len, hw, mat)` | Blade with profile `hw·3.98·t(1−t)(1.2−0.4t) + 0.4` ≈ `hw·sin(π·t^0.8)`: rounded base, pointed tip, no transcendental calls. `d = abs(v) − profile` (v = offset across the axis) is a bound, not a true distance: fine for slender blades, too soft for wide ones. |

## 3. Lit part art (`src/render/hero/heroParts.ts`)

Each part is `{ bounds (u), sdf(x, y), thickness, palette, detail? }` baked at `HERO_DENSITY = 3`
texels per unit (drawn at ~1–1.5 px/u, so mipmaps handle minification) with a 6-texel gutter.

- Composite volumes with `smin`: head = `smin(sdEllipse(cranium), sdCircle(cheek), 3.5)`, torso =
  `smin(sdTaperedCapsule(...), sdCircle(chest), 2.4)`. One smooth volume, so one continuous rim.
- Vesica leaf: the intersection (`max`) of two circles whose radius comes from chord and sagitta,
  `r = (hw² + h²) / (2·hw)`, offset `r − hw` either side of the chord. It gives genuinely sharp
  tips; inside, the gradient switches circles along the chord, which shades as a central fold (the
  midrib darkening sits on it).
- Detail as a darkening function (the leaf midrib: `1 − smoothstep(0.05, 0.3, distToRib)`, fading
  toward the tip).
- Light is rotated into each part's rest frame (bone angle + attachment rotation) so the rim lands on
  the moon side after posing; parts are baked twice (`@R`, `@L` with light x mirrored) because the rig
  mirrors when facing left.
- `composePose(..., { silhouette: true })` + `blurRaster` composites a posed rig into a soft white
  ghost on the CPU (`src/render/hero/heroAssets.ts`).

## 4. Stone, arches, thorns, runes (`src/render/entities/entityAtlas.ts`)

`bake(spec)` evaluates `sdf` per texel, derives normals by central differences only where
`-d < normalBand`, and calls a `shade(x, y, d, nx, ny, out)` that returns an alpha multiplier.

- **Noise inside the SDF:** `sdRoundBox(...) + noise.fbm(x * 0.12, y * 0.12, 3) * 1.8`. Low-frequency
  lumps change the outline *and* the normals, so the rim follows the lumps. It is expensive (fbm × 5
  evaluations near the edge), which is why the entity atlas takes ~200 ms for 14 images.
- **Domain warp for lean and taper:** `t = clamp(−y / H)`, `xs = (x + t²·3.5) / (1 − 0.3·t)`, then
  evaluate the box at `(xs, y)`: the monolith leans and narrows toward the top. Scaling a coordinate
  scales the distance metric (here up to ~1.4×), which is harmless for mild warps; strong warps skew the
  AA width and edge noise.
- **Half-plane cut:** `opIntersect(sdEllipse(body), y + 7)` gives a flat belly on the ground.
- **Thorn rows:** `min` over tapered capsules (2.1 → 0.25) rooted along the back arc, pointing outward
  with a backward lean, then `min(smin(mound, head, 5), thorns + 0.2)`: the body fillets smoothly, the
  thorns stay sharp. The thorn field returns `Infinity` below the back (`y > cy + 13`) to skip 17
  capsule evaluations where no thorn can be.
- **Onion ring arch:** `abs(length(p − c) − 42) − 7.5` intersected with the half-plane above the
  spring line, `min`'d with round-box pillars, plinths and a keystone, plus fbm lumps.
- **Spiral rune:** Archimedean spiral distance (min over turns of `|r − (a + bθ)|`, plus the end cap)
  used twice: as a darkening groove on the stone (`1 − smoothstep(0.35, 1.1, d)`) and as its own
  glowing image (`d − 1.2`).
- **Masks from thresholded fbm:** moss caps, and drips from fbm stretched vertically
  (`fbm(x * 0.14, y * 0.05)`) thresholded with a narrow smoothstep.

## 5. Gameplay-safe displacement (`src/render/terrain/terrainField.ts`)

Terrain is one SDF of the solid tiles (convex corners rounded, concave kept sharp). Displacement is
damped on up-facing surfaces, detected from the vertical gradient: amplitude 1.4 u on floors (table
noise peaks near ±0.6, so floors move < 1 u off the collision line) and the full 4 u on walls and
undersides:

```ts
const g = (this.base(x, y + 2) - this.base(x, y - 2)) * 0.25;   // ≈ −1 on floors (y down)
const up = Math.min(1, Math.max(0, (-g - 0.5) / 0.4));
const amp = this.opts.dispAmp + (this.opts.flatAmp - this.opts.dispAmp) * up * up * (3 - 2 * up);
const n = this.noise.sample(x * f, y * f) * 0.8 + this.noise.sample(x * f * 2.7 + 50, y * f * 2.7 + 20) * 0.2;
return d + n * amp;
```

The same idea applies to any silhouette something stands on (logs, bridges, ledges): displace freely
where nothing touches, and keep contact edges within the collision tolerance.
