# Organic building blocks

How the repo grows its trees and props, on top of `ElementRaster` (`src/render/gen/raster.ts`) and the
SDF helpers (`src/render/gen/sdf.ts`). Section 1 is the core of `src/render/gen/trees.ts`, verbatim
apart from dropped doc comments and two exports added (`drawClumps`, `leafSpray` are module-private in
the repo); it typechecks under the repo config. To reuse it outside this repo, copy
`src/core/{rng,math}.ts` and `src/render/gen/{sdf,noiseTable,raster,trees}.ts`: they import nothing
else. For a smaller, fully standalone raster see [toolkit.md](toolkit.md).

## 1. Branching skeleton + clump-of-clumps crowns (fixes "lollipop" trees)

Structure first: a recursive branch system reports every terminal twig (`tip`) and fork (`forkTip`);
the callbacks only *record* clumps. The clumps are then drawn lowest first, so higher clumps overlap
lower ones and every clump sits on a visible limb. Each clump is a body, lobes on an irregular envelope
(bigger toward the top, where foliage heaps toward the light) and small tufts on each lobe rim: the
fractal outline reads as leaves at near scale while the lobes still read as masses at far scale.

```ts
import type { Rng } from '../../core/rng.ts';
import { ElementRaster, Mat } from './raster.ts';

const UP = -Math.PI / 2;
const P = { x: 0, y: 0 };

export interface BranchStyle {
  mat: Mat;
  taper: number;
  lenMin: number;
  lenMax: number;
  spread: number;
  jitter: number;
  rise: number;
  droop: number;
  tri: number;
  minRad: number;
  blend: number;
  pad?: number;
}

export const OAK: BranchStyle = {
  mat: Mat.Bark, taper: 0.68, lenMin: 0.62, lenMax: 0.82, spread: 0.85, jitter: 0.28, rise: 0.18, droop: 0.12, tri: 0.3,
  minRad: 1.1, blend: 0.55,
};
export const TWIG: BranchStyle = {
  mat: Mat.Bark, taper: 0.62, lenMin: 0.55, lenMax: 0.75, spread: 0.95, jitter: 0.35, rise: 0.1, droop: 0.04, tri: 0.2,
  minRad: 0.7, blend: 0.4,
};

function clampIn(r: ElementRaster, pad: number): void {
  P.x = Math.min(r.w - pad, Math.max(pad, P.x));
  P.y = Math.min(r.h - pad, Math.max(pad, P.y));
}

export function limbAlong(
  r: ElementRaster, x: number, y: number, ang: number, len: number, r0: number, r1: number, mat: Mat, sag: number, bend: number,
  k: number, pad = 8,
): number {
  const dx = Math.cos(ang);
  const dy = Math.sin(ang);
  P.x = x + dx * len;
  P.y = y + dy * len + sag * len * len * 0.01;
  clampIn(r, pad);
  const ex = P.x;
  const ey = P.y;
  const mx = (x + ex) / 2 - dy * bend * len;
  const my = (y + ey) / 2 + dx * bend * len - sag * len * len * 0.004;
  r.curve(x, y, mx, my, ex, ey, r0, r1, mat, k, Math.max(4, Math.min(12, Math.round(len / 7))));
  P.x = ex;
  P.y = ey;
  return Math.atan2(ey - my, ex - mx);
}

export type TipFn = (x: number, y: number, ang: number, rad: number, depth: number) => void;

export function branchSystem(
  r: ElementRaster, rng: Rng, x: number, y: number, ang: number, len: number, rad: number, depth: number, s: BranchStyle,
  tip: TipFn | null, forkTip: TipFn | null = null,
): void {
  const a = ang + rng.range(-s.jitter, s.jitter) * 0.5;
  const endR = rad * s.taper;
  const endAng = limbAlong(r, x, y, a, len, rad, endR, s.mat, s.droop, rng.range(-0.12, 0.12), rad * s.blend, s.pad ?? 8);
  const ex = P.x;
  const ey = P.y;
  if (depth <= 0 || endR < s.minRad) {
    if (tip) tip(ex, ey, endAng, endR, depth);
    return;
  }
  if (forkTip) forkTip(ex, ey, endAng, endR, depth);
  const n = rng.chance(s.tri) ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * s.spread * rng.range(0.75, 1.2) + rng.range(-s.jitter, s.jitter);
    let ca = endAng + off;
    // Light-seeking: pull toward straight up.
    ca += (UP - ca) * s.rise;
    branchSystem(r, rng, ex, ey, ca, len * rng.range(s.lenMin, s.lenMax), endR * rng.range(0.85, 1), depth - 1, s, tip, forkTip);
  }
}

export interface ClumpStyle {
  mat: Mat;
  lobes: number;
  tufts: number;
  shade: number;
  lobeShade: number;
  flat: number;
  holes: number;
}

export const LEAFY: ClumpStyle = { mat: Mat.Leaf, lobes: 6, tufts: 6, shade: 0.2, lobeShade: 0.1, flat: 0, holes: 0 };

export function clump(r: ElementRaster, rng: Rng, cx: number, cy: number, rx: number, ry: number, s: ClumpStyle = LEAFY): void {
  const p1 = rng.range(0, 6.28);
  const p2 = rng.range(0, 6.28);
  const env = (a: number): number => 1 + 0.2 * Math.sin(3 * a + p1) + 0.1 * Math.sin(5 * a + p2);
  r.volume(cx - rx * 0.12, cy - ry * 0.18, Math.max(rx, ry) * 1.1, s.shade, s.flat);
  r.ellipse(cx, cy + ry * 0.06, rx * 0.64, ry * 0.6, s.mat, 3);
  const n = Math.max(3, s.lobes);
  const a0 = rng.range(0, 6.28);
  const m = Math.min(rx, ry);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const e = env(a) * rng.range(0.85, 1.05);
    // Lobes along the upper rim sit a little higher and larger (foliage heaps up toward the light).
    const upness = Math.max(0, -Math.sin(a));
    const lr = m * rng.range(0.34, 0.48) * (0.9 + 0.25 * upness);
    const lx = cx + Math.cos(a) * rx * 0.55 * e;
    const ly = cy + Math.sin(a) * ry * 0.55 * e;
    r.lobe(lx - lr * 0.3, ly - lr * 0.35, lr * 1.1, s.lobeShade);
    r.ellipse(lx, ly, lr, lr * rng.range(0.78, 0.95), s.mat, 2.5);
    const tufts = s.tufts;
    for (let t = 0; t < tufts; t++) {
      const ta = a + rng.range(-1.35, 1.35);
      const tr = lr * rng.range(0.18, 0.3);
      const d = lr * rng.range(0.78, 0.98);
      r.ellipse(lx + Math.cos(ta) * d, ly + Math.sin(ta) * d * 0.92, tr, tr * rng.range(0.75, 1), s.mat, 1.2);
      // Big clumps (seen up close) get pointed leaves breaking their rim.
      if (lr > 12 && rng.chance(0.7)) {
        const len = tr * rng.range(1.2, 1.8);
        const bx = lx + Math.cos(ta) * (d + tr * 0.4);
        const by = ly + Math.sin(ta) * (d + tr * 0.4) * 0.92;
        r.leaf(bx, by, ta + rng.range(-0.5, 0.5) + 0.25, len, len * 0.3, s.mat);
      }
    }
  }
  r.noVolume();
  if (m > 9 && rng.chance(s.holes)) {
    const ha = rng.range(0, 6.28);
    const hd = rng.range(0.25, 0.5);
    r.carve(cx + Math.cos(ha) * rx * hd, cy + Math.sin(ha) * ry * hd, m * rng.range(0.1, 0.16));
  }
}

export function drawClumps(r: ElementRaster, rng: Rng, list: number[], squash: number, style: ClumpStyle, topCut = false): void {
  const order: number[] = [];
  for (let i = 0; i < list.length; i += 3) order.push(i);
  order.sort((a, b) => (list[b + 1] as number) - (list[a + 1] as number));
  for (const i of order) {
    const rad = list[i + 2] as number;
    const rx = Math.min(rad * 1.2, r.w / 2 - 10);
    const x = Math.min(r.w - 10 - rx, Math.max(10 + rx, list[i] as number));
    const y0 = list[i + 1] as number;
    const ry = topCut ? rad * squash : Math.min(rad * squash, r.h / 2 - 10);
    const y = topCut ? y0 : Math.max(10 + ry, y0);
    if (rx < 4 || ry < 4) continue;
    clump(r, rng, x, y, rx, ry, { ...style, lobes: rad > 18 ? 6 : 5, tufts: rad > 18 ? 6 : 4 });
  }
}

export function leafSpray(r: ElementRaster, rng: Rng, x: number, y: number, ang: number, size: number, s: number): void {
  const n = Math.round(9 + size / (2 * s));
  for (let i = 0; i < n; i++) {
    const u = rng.next();
    // Leaves fan around the twig direction and droop under gravity toward the outside.
    const a = ang + rng.range(-1.2, 1.2) + (Math.PI / 2 - ang) * 0.35 * u;
    const d = size * rng.range(0.05, 0.55);
    const bx = x + Math.cos(a) * d;
    const by = y + Math.sin(a) * d;
    const len = size * rng.range(0.35, 0.6);
    r.leaf(bx, by, a + rng.range(-0.5, 0.5) + 0.4, len, len * 0.3, Mat.Leaf);
  }
  r.ellipse(x, y, size * 0.32, size * 0.26, Mat.Leaf, 2);
}
```

`volume`/`lobe`/`noVolume` (raster.ts) set a shading ramp that `put` stores with each texel it wins:
`shade = flat + k·clamp(((x + 0.5 − cx)·Lx + (y + 0.5 − cy)·Ly) / r, −1, 1)` per active volume, with
`(Lx, Ly) = (−0.55, −0.83)` toward the moon; `finalize` adds it to the luminance channel. The clump
volume is centred up-left of the clump, so most of it shades darker with a lit cap; each lobe adds a
smaller ramp of its own, so the crown reads as lit balls inside a lit mass rather than a flat cut-out.

Why the numbers:

- `sag·len²·0.01` pulls long limbs down more than short ones (gravity), while the control point is
  lifted by `sag·len²·0.004` and bent `±0.12·len` sideways, so limbs arch up and then droop instead of
  running straight; `(UP − ca)·rise` pulls children toward vertical (light-seeking).
- Radius tapers ×`taper` (0.6–0.68) per level and ×0.85–1 at each child, and recursion stops below
  `minRad` (0.7–1.1 texels), so twigs end thin instead of blunt. `k = rad·blend` fillets each child
  into its parent; `curve` adds `k ≥ 0.6` at internal joints; segments scale with length (`len/7`, 4–12).
- `pad` keeps limb ends clear of the rect edge by the size of the foliage they carry, and
  `drawClumps` clamps each clump by its own radius, so nothing reaches the edge fade.
- Lobes use `k = 2.5`, tufts `k = 1.2`: they merge into one mass, but the tuft scallops survive. Clumps
  with lobes over 12 texels (near layers) add pointed leaves through the rim.
- Holes are carved *after* the clump (`carve` only cuts what exists), only in clumps over 9 texels and
  only when the style asks (`LEAFY.holes` is 0; the far treeline uses 0.3).

Archetypes in `trees.ts` built from these (see them with
`node .claude/skills/sdf-silhouettes/scripts/preview-element.ts farTree <dir>`):

| Archetype | What makes it read |
|---|---|
| `broadTree` | Short thick `trunkPath`, 3–5 limbs fanned over ~1.6–2.1 rad plus one low sideways limb, `branchSystem` depth 2 with tip and fork clumps (bigger higher up), `drawClumps` squash 0.82. |
| `willowTree` | Leaning trunk, 4–5 arching `curve` limbs, a dome of flattened clumps (squash 0.62) along an arc, then dense `curtainStrand`s every 3.4·s texels (×0.7–1.3, 12 % skipped), longest at the rim. |
| `slenderTree` | 2–3 `PaleBark` stems; 8–11 short side twigs (`limbAlong`) from the upper half, each ending in a `leafSpray`, one volume per stem crown. |
| `coniferTree` | Tiers every 12–16·s texels: a drooping `Needle` rib plus a fringed skirt of hanging needle blades (sawtooth edge) and short upward needles; 12 % of mid-tier branches missing, 15 % reaching 1.15–1.35×, ~17 % stunted; a thin bent leader. |
| `snagTree` | Splintered top (4 tapering shards), 4–6 bare `branchSystem` limbs (`TWIG`), moss `curtainStrand`s from half the tips. |
| `risingColumn` + `mid*Trunk`, `nearTrunk` | Trunk wanders up to a stretch row, then a straight column leaves the rect top (`r.columnX` records it for placement); limbs, clumps, curtains, tiers or leaf sprays sit below the stretch row. |
| `canopyCeiling`, `midCrown` | A clump band running through the top edge (`topCut`) with limbs hanging from it; crown sections hung on stretched columns so tall trees keep foliage when the camera climbs. |

## 2. Other blocks

| Block | What it does and why |
|---|---|
| `fitLength(r, x, y, ang, len, pad)` (kitElements) | Shortens a stroke so its tip stays inside the rect minus margin and `pad` (never below 35 % of `len`). Use for any stroke aimed at an edge. |
| `limbAlong(r, x, y, ang, len, r0, r1, mat, sag, bend, k, pad = 8)` | One tapered, bent, sagging limb; leaves the end point in the module's `P` and returns the end direction. |
| `trunkPath(r, rng, cx, ground, topY, baseR, topR, wobble, lean, mat, segs = 14)` | `segs` capsules from just below the ground line: lean `∝ t²`, two-frequency sine wobble, radius taper `pow(t, 0.75)` with a small ripple, `k = min(6, 0.5·baseR)`. Returns the path; `pathPoint(path, t, P)` attaches limbs, moss and fungi to it. |
| `rootFlare(r, rng, cx, groundY, trunkR, spread, count, mat)` | Alternating sides, reach growing outward, each root a `curve` from 1.2–2.4 radii up the trunk down to the ground line, radius 0.4–0.6·r → 1.2, fillet `k = min(8, 0.4·r)` so the flare melts into the trunk. |
| `curtainStrand(r, rng, x, y, len, drift, r0, leaf, mat)` | Hanging Bézier (willow curtains, moss) with alternating drooping leaves every `0.75·leaf`; `leaf = 0` gives a bare strand. `strand` (kitElements) is the older vine variant with a sideways sway. |
| `leafSpray(r, rng, x, y, ang, size, s)` | `9 + size/2s` blades fanned ±1.2 rad around the twig direction and drooping toward the ground, around a small core ellipse: a feathery twig end that doesn't read as a hand. |
| `frond(r, rng, bx, by, ang, len, droop, leaf, mat, ribR)` (kitElements) | Curved rib plus paired leaflets at ±1.05 rad from the local tangent, shrinking to 25 % at the tip. Ferns, bush sprays, foreground fronds. |
| `mushroom`, `glowBulb` (kitElements) | Stem curve, cap ellipse, `carve` for the gill hollow, emissive disc and spots; petal ellipse, emissive disc and optional baked halo (`haloAt`). |
| `farArchetype`, `midTrunkSpec` (kitElements) | Wrap a tree function as a spec with its own seed `key`. Far trees are stored at `FAR_K = 0.8` of the design density (rect ×0.8, `unitsPerTexel` 2.5): they are the softest layers. Mid trunks are 620 texels tall, cut at the top, stretching above row 170. |
| `ElementRaster.leaf(bx, by, ang, len, hw, mat)` | Blade with profile `hw·3.98·t(1−t)(1.2−0.4t) + 0.4` ≈ `hw·sin(π·t^0.8)`: rounded base, pointed tip, no transcendental calls. `d = abs(v) − profile` (v = offset across the axis) is not a true distance: it overestimates where the outline is steep (near the ends of wide blades), which narrows the AA and edge-noise band there. Fine for slender blades. |

## 3. Lit part art (`src/render/hero/heroParts.ts`)

Each part is `{ bounds (u), sdf(x, y), thickness, palette, detail? }` baked at `HERO_DENSITY = 3`
texels per unit (drawn at ~1–1.5 px/u, so mipmaps handle minification) with a 6-texel gutter.

- Composite volumes with `smin`: head = `smin(sdEllipse(cranium), sdCircle(cheek), 3.5)`, torso =
  `smin(sdTaperedCapsule(...), sdCircle(chest), 2.4)`. One smooth volume, so one continuous rim.
- Vesica leaf: the intersection (`max`) of two circles whose radius comes from chord and sagitta,
  `r = (hw² + h²) / (2·hw)`, offset `r − hw` either side of the chord. It gives genuinely sharp
  tips; inside, the gradient switches circles along the chord, which shades as a central fold (the
  midrib darkening sits on it).
- Detail as a darkening function (the leaf midrib: `(1 − smoothstep(0.05, 0.3, distToRib))·0.28`,
  fading toward the tip).
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
  evaluations inside the normal band), which is why the entity atlas takes ~160–210 ms for 14 images.
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

Terrain is one SDF of the solid tiles: convex corners rounded per corner (hash-varied, 10–13 u on top
so walkable tops stay flat almost to the edge, 16–24 u underneath), concave corners kept sharp. The
displacement amplitude is picked by facing, from the vertical gradient of the undisplaced field:

```ts
const g = (this.base(x, y + 2) - this.base(x, y - 2)) * 0.25;   // ≈ −1 on floors, ≈ +1 under ceilings (y down)
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

`NORM = 2.2` lifts the table's rms ≈ 0.2 to about ±1 and the clamp makes it a hard bound, so the
defaults (`flatAmp` 1.2 u, `dispAmp` 3.5 u, `underAmp` 9 u, drips up to `dripLen` 30 u on a hashed
76 u cell grid) are guarantees: `tests/world/terrainMesh.test.ts` checks tops within `FLOOR_TOLERANCE`
(2 u) and walls within `WALL_TOLERANCE` (4 u). The same idea applies to any silhouette something
stands on (logs, bridges, ledges): displace freely where nothing touches, bound the contact edges, and
test the bound.

## 6. Time-slicing the bake

`src/render/gen/kit.ts`, abridged. One element per step; the per-element work lives in a plain
function because V8 optimises loops there much sooner than in a generator body.

```ts
function* kitSteps(seed: number, width: number, height: number, specs: readonly ElementSpec[]): Generator<void, KitAtlasData> {
  // abridged: build jobs and pack their rects, allocate pixels, the noise table, byCategory
  const scratch = new Scratch();
  yield;
  for (let i = 0; i < jobs.length; i++) {
    const el = buildElement(jobs[i] as Job, i, elements.length, seed, noise, scratch, pixels, width);
    elements.push(el);
    byCategory[el.category].push(el);
    yield;
  }
  return { width, height, pixels, elements, byCategory, ms: 0 };
}

export async function generateKitAsync(
  seed: number, pause: () => Promise<void>, width = KIT_WIDTH, height = KIT_HEIGHT, specs: readonly ElementSpec[] = ELEMENT_SPECS,
): Promise<KitAtlasData> {
  const it = kitSteps(seed, width, height, specs);
  for (;;) {
    const s = it.next();
    if (s.done) return s.value;
    await pause();
  }
}
```

`buildElement` seeds ``new Rng((hashString(`${spec.key ?? spec.category}:${variant}`) ^ seed) >>> 0)``,
creates `new ElementRaster(spec.w, spec.h, noise, i + 1, scratch)`, calls `r.configure(spec.finalize)`,
`spec.draw(r, rng, variant)`, `r.finalize(pixels, width, x, y, { edgeFade: ELEMENT_MARGIN, cut:
spec.cut, ...spec.finalize })`, then extracts the split hull from the element's alpha.
