/**
 * Two painted set pieces for the Hollow Glade (ARCHITECTURE.md §5.8), generated as stand-ins that real
 * paintings replace file for file:
 *
 * - `glade-landmark` (f 0.2): a far crag rising out of the mist between the far treelines, a thin
 *   moonlit waterfall spilling from the cleft in its crown, pines on its ridges;
 * - `glade-frame` (f 0.6): a midground frame, an ancient tree beside the glade whose great bough arches
 *   over it, hung with moss, with a hollow in its trunk holding a faint warm light and glowing fungi.
 *
 * Both are painted in the colours of the depth they claim before its fog (the neighbouring kit layers'
 * tint and rim, interpolated), and their sidecars carry the interpolated fog, fog colour and
 * desaturation, so they land on the aerial-perspective ramp between those layers; `--check` prints the
 * shaded value against the neighbours. Placement is in view fractions of the glade's reference camera
 * (templates.ts), read from public/levels/forest.ldtk.
 *
 *   node tools/art/paint-example.ts [--only glade-landmark|glade-frame] [--preview <dir>]
 *
 * Writes art/plates/<id>.png + <id>.json; then run `npm run art`. `--preview` also writes each plate
 * shaded as the game draws it over its fog colour (<dir>/<id>.shaded.png).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { VIEW_H } from '../../src/config.ts';
import { parseManifest } from '../../src/assets/manifest.ts';
import type { KitLayerDef, LayerManifest, SkyLayerDef } from '../../src/contracts/assets.ts';
import type { QualityLevel } from '../../src/contracts/quality.ts';
import { clamp01, smoothstep } from '../../src/core/math.ts';
import { Rng } from '../../src/core/rng.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { Noise } from '../../src/render/gen/noise.ts';
import { KIT_MODE, KIT_RIM_COLOR, KIT_RIM_SCALE, shadeKit } from '../../src/render/layers/kitShading.ts';
import { kitShadeParams } from '../../src/render/layers/layerModel.ts';
import type { LayerPlacement } from '../../src/render/layers/placement.ts';
import { RECIPES } from '../../src/render/layers/recipes.ts';
import { formatJson } from './json.ts';
import { brush, cover, Field, foliage, hex, luma, mix3, Paint, type RGB } from './painter.ts';
import { areaCameraRange, moonCoverage, moonSweepBox } from './moon.ts';
import { artPaths } from './paths.ts';
import { referenceCamera, resolveArea, type ReferenceCamera } from './templates.ts';

/** The look of a depth between two kit layers: their colours and fog, interpolated by parallax. */
export interface DepthLook {
  f: number;
  tint: RGB;
  fog: number;
  fogColor: RGB;
  desaturate: number;
  rim: number;
  glow: number;
  behind: KitLayerDef;
  front: KitLayerDef;
}

/** Interpolate the base manifest's depth-tested kit layers at parallax `f` (the aerial-perspective ramp). */
export function depthLook(base: LayerManifest, f: number): DepthLook {
  const kits = base.layers.filter((l): l is KitLayerDef => l.kind === 'kit' && l.parallax[0] <= 1).sort((a, b) => a.parallax[0] - b.parallax[0]);
  let a = kits[0] as KitLayerDef;
  let b = kits[kits.length - 1] as KitLayerDef;
  for (let i = 0; i + 1 < kits.length; i++) {
    if ((kits[i] as KitLayerDef).parallax[0] <= f && (kits[i + 1] as KitLayerDef).parallax[0] >= f) {
      a = kits[i] as KitLayerDef;
      b = kits[i + 1] as KitLayerDef;
    }
  }
  const t = clamp01((f - a.parallax[0]) / Math.max(1e-6, b.parallax[0] - a.parallax[0]));
  const lerp = (x: number, y: number): number => x + (y - x) * t;
  const col = (x: string, y: string): RGB => mix3(hex(parseInt(x.slice(1), 16)), hex(parseInt(y.slice(1), 16)), t);
  return {
    f, tint: col(a.tint, b.tint), fog: lerp(a.fog, b.fog), fogColor: col(a.fogColor, b.fogColor), desaturate: lerp(a.desaturate, b.desaturate),
    rim: lerp(a.rim, b.rim), glow: lerp(a.glow, b.glow), behind: a, front: b,
  };
}

function toHex(c: RGB): string {
  return `#${c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** View fractions of the reference 16:9 view → canvas pixels, at parallax f and a texel scale. */
export interface ViewMap {
  x(v: number): number;
  y(v: number): number;
  /** View (layer) units → pixels. */
  s(u: number): number;
}

interface Canvas {
  origin: [number, number];
  w: number;
  h: number;
  map: ViewMap;
}

/** A canvas covering view fractions [vx0, vx1] × [vy0, vy1] of the reference view (and up to `top` in layer y). */
function canvasFor(ref: ReferenceCamera, f: number, ts: number, vx0: number, vy0: number, vx1: number, vy1: number, top: number | null): Canvas {
  const viewW = (VIEW_H * 16) / 9;
  const lx = (v: number): number => ref.cx * f + (v - 0.5) * viewW;
  const ly = (v: number): number => ref.cy * f + (v - 0.5) * VIEW_H;
  const x0 = Math.floor(lx(vx0));
  const y0 = Math.floor(top === null ? ly(vy0) : Math.min(ly(vy0), top));
  const origin: [number, number] = [x0, y0];
  return {
    origin,
    w: Math.ceil((lx(vx1) - x0) / ts),
    h: Math.ceil((ly(vy1) - y0) / ts),
    map: { x: (v) => (lx(v) - x0) / ts, y: (v) => (ly(v) - y0) / ts, s: (u) => u / ts },
  };
}

/** Moonlight from the upper left, slightly toward the viewer (x right, y down, z toward the viewer). */
const LIGHT: [number, number, number] = (() => {
  const l = Math.hypot(-0.55, -0.72, 0.42);
  return [-0.55 / l, -0.72 / l, 0.42 / l];
})();

/** Lambert of a pillow normal: the SDF's outward gradient at the edge, turning to face the viewer inside. */
function pillow(gx: number, gy: number, depth: number, thickness: number, bx = 0, by = 0): number {
  const k = smoothstep(0, thickness, depth);
  const nx = gx * (1 - k) + bx;
  const ny = gy * (1 - k) + by;
  const nz = 0.3 + k * 0.95;
  const l = Math.hypot(nx, ny, nz);
  return Math.max(0, (nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]) / l);
}

/** How much an edge with outward normal (gx, gy) faces the moon (upper left). */
function facing(gx: number, gy: number): number {
  return Math.max(0, gx * -0.55 + gy * -0.83);
}

const G: [number, number] = [0, 0];
const C: RGB = [0, 0, 0];
const T: RGB = [0, 0, 0];

// ---------------------------------------------------------------------------------------------------
// glade-landmark: the far crag

const ROCK = 1;
const PINE = 2;

/** Deterministic hash of an integer to [0, 1). */
function hash01(n: number): number {
  const s = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function paintLandmark(cv: Canvas, look: DepthLook, seed: number): Paint {
  const { w, h, map: M } = cv;
  const noise = new Noise(seed);
  const rng = new Rng(seed);
  const out = new Paint(w, h);
  const P = (pts: number[]): number[] => pts.map((v, i) => (i % 2 === 0 ? M.x(v) : M.y(v)));
  const tint = look.tint;
  const rim = KIT_RIM_COLOR;
  const rimK = look.rim * KIT_RIM_SCALE * 3.4;
  const air: RGB = [look.fogColor[0] + 0.015, look.fogColor[1] + 0.05, look.fogColor[2] + 0.045];

  /**
   * Paint one rock mass: columnar prisms whose moon-side faces catch the light (broad planes, not
   * noise), ledges of scrub between tiers, broken vertical strokes, a moonlit rim, and the air of this
   * depth rising over its base. `haze` pushes a mass further back.
   */
  const rockMass = (field: Field, haze: number, spineX: number): void => {
    const shade: RGB = [tint[0] * 0.4, tint[1] * 0.46, tint[2] * 0.6];
    const mid: RGB = [tint[0] * 0.74, tint[1] * 0.77, tint[2] * 0.84];
    const lit: RGB = [tint[0] * 1.45 + 0.022, tint[1] * 1.38 + 0.04, tint[2] * 1.22 + 0.05];
    const scrub: RGB = [tint[0] * 0.36, tint[1] * 0.7, tint[2] * 0.54];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const d0 = field.d[i] as number;
        if (d0 > field.reach) continue;
        // Jointed rock: tall, uneven columns whose moon-side (left) faces are lit, broken by a few
        // irregular horizontal joints where the columns step and shift.
        const tierC = y * 0.011 + noise.fbm(x * 0.004, 4.4, 2) * 1.3 + noise.noise2(x * 0.02, y * 0.004) * 0.25;
        const tierId = Math.floor(tierC);
        const tier = tierC - tierId;
        const joint = hash01(tierId * 5 + 2) > 0.4 ? 1 : 0.15;
        const warp = noise.fbm(y * 0.004, 2.2, 2) * 0.9 + noise.noise2(y * 0.018, 8.8) * 0.12;
        const c = x * (0.02 + hash01(tierId * 3 + 1) * 0.012) + warp + hash01(tierId * 7 + 3) * 0.9 * joint;
        const id = Math.floor(c);
        const frac = c - id;
        const split = 0.25 + hash01(id * 13 + tierId + seed) * 0.45;
        const face = smoothstep(split + 0.05, split - 0.05, frac) * (0.75 + 0.25 * (1 - frac));
        const crack = (smoothstep(0.94, 0.995, tier) * joint + smoothstep(0.05, 0.0, frac) * 0.5) * (0.6 + 0.4 * hash01(id + 91));
        const lip = smoothstep(0.0, 0.02, tier) * smoothstep(0.07, 0.03, tier) * joint;
        const edgeN = (noise.fbm(x * 0.05, y * 0.026, 3) * 0.7 + (frac - 0.5) * 0.9) * 3;
        const d = d0 + edgeN;
        const wisp = noise.fbm(x * 0.008 + 3.1, y * 0.02, 3) * M.s(95);
        const fade = 1 - smoothstep(M.y(0.6), M.y(0.84), y + wisp);
        const a = cover(d, 1.5) * fade;
        if (a <= 0.002) continue;
        field.gradient(x, y, G);
        const edge = pillow(G[0], G[1], -d, 9, 0, 0);
        const side = smoothstep(M.x(spineX + 0.06), M.x(spineX - 0.06), x);
        const height = smoothstep(M.y(0.66), M.y(0.2), y);
        const interior = 0.12 + face * (0.28 + 0.44 * side) + height * 0.14 + lip * 0.3 * (0.4 + side);
        const k = smoothstep(0, 10, -d);
        const l = edge * (1 - k) + interior * k;
        const stroke = brush(noise, y, x, 12, 2, 1);
        mix3(shade, mid, smoothstep(0.1, 0.42, l), C);
        mix3(C, lit, smoothstep(0.44, 0.84, l + stroke * 0.09) * 0.95, C);
        mix3(C, scrub, lip * (1 - face * 0.5) * smoothstep(0.1, 0.5, noise.fbm(x * 0.03, y * 0.03, 2) + 0.2) * 0.7, C);
        const g = (1 + stroke * 0.08) * (1 - crack * 0.5);
        for (let ch = 0; ch < 3; ch++) C[ch] = (C[ch] as number) * g;
        const r = smoothstep(4.5, 0, -d) * facing(G[0], G[1]) * rimK * (0.75 + 0.25 * stroke) * (1 - haze);
        for (let ch = 0; ch < 3; ch++) C[ch] = (C[ch] as number) + (rim[ch] as number) * r;
        mix3(C, air, Math.min(1, smoothstep(M.y(0.5), M.y(0.8), y + wisp) * 0.92 + haze), C);
        out.over(i, C[0], C[1], C[2], a);
      }
    }
  };

  // The whole crag sits lower than first painted, so its crown clears the frame's bough at the glade's
  // reference camera: view y 0.1 → 0.2, the foot stays in the mist at 0.8.
  const Y2 = (v: number): number => 0.2 + (v - 0.1) * 0.857;
  const P2 = (pts: number[]): number[] => P(pts.map((v, i) => (i % 2 === 0 ? v : Y2(v))));

  // A sister spire behind and to the right, paler: the crag is part of a range lost in the mist.
  const back = new Field(w, h);
  back.reach = 14;
  back.polygon(P2([0.79, 0.8, 0.81, 0.52, 0.83, 0.38, 0.852, 0.3, 0.87, 0.285, 0.885, 0.33, 0.9, 0.45, 0.925, 0.62, 0.945, 0.8]), ROCK, 1, 6);
  rockMass(back, 0.4, 0.86);

  // The crag: a leaning spire with a broken crown (two peaks and the cleft the water leaves by), an
  // overhang, a tower on its shoulder, and boulders at its foot that sink into the mist.
  const rock = new Field(w, h);
  rock.reach = 18;
  rock.polygon(P2([
    0.53, 0.8, 0.55, 0.68, 0.572, 0.6, 0.588, 0.53, 0.603, 0.47, 0.64, 0.455, 0.662, 0.43, 0.667, 0.37, 0.661, 0.33,
    0.674, 0.25, 0.687, 0.17, 0.698, 0.125, 0.712, 0.098, 0.728, 0.106, 0.737, 0.14, 0.746, 0.158, 0.758, 0.15, 0.768, 0.126,
    0.781, 0.13, 0.793, 0.165, 0.801, 0.24, 0.81, 0.33, 0.822, 0.44, 0.84, 0.55, 0.862, 0.66, 0.89, 0.8,
  ]), ROCK, 1, 4);
  rock.polygon(P2([0.583, 0.62, 0.59, 0.5, 0.596, 0.41, 0.604, 0.37, 0.616, 0.36, 0.628, 0.39, 0.633, 0.48, 0.63, 0.62]), ROCK, 2, 5);
  for (let k = 0; k < 9; k++) {
    const bx = 0.56 + k * 0.035 + rng.range(-0.01, 0.01);
    rock.ellipse(M.x(bx), M.y(Y2(0.7 + rng.range(-0.02, 0.03))), M.s(rng.range(50, 90)), M.s(rng.range(35, 60)), ROCK, 3, 18);
  }
  rockMass(rock, 0, 0.73);

  // Pines along the ridges and the tower, nearly black against the sky with a thin moonlit edge.
  const pines = new Field(w, h);
  pines.reach = 5;
  const ridge: [number, number, number][] = [
    [0.6, 0.462, 0.9], [0.609, 0.37, 1.1], [0.62, 0.362, 0.8], [0.645, 0.452, 1], [0.655, 0.445, 0.7], [0.668, 0.335, 0.85],
    [0.7, 0.122, 1.1], [0.708, 0.104, 1.3], [0.717, 0.1, 1.05], [0.724, 0.108, 0.8], [0.771, 0.128, 1.2], [0.779, 0.129, 1],
    [0.787, 0.142, 0.8], [0.796, 0.2, 0.55], [0.853, 0.302, 0.6], [0.861, 0.29, 0.75],
  ];
  const pine = (tx: number, ty: number, scale: number, k: number): void => {
    const cx = M.x(tx);
    const base = M.y(Y2(ty)) + 3;
    const H = M.s(58) * scale * rng.range(0.85, 1.15);
    const lean = rng.range(-0.1, 0.1) * H;
    if (rng.chance(0.12)) {
      pines.capsule(cx, base, cx + lean, base - H * 0.8, 1.4, 0.4, PINE, k);
      pines.capsule(cx + lean * 0.5, base - H * 0.45, cx + lean * 0.5 + H * 0.16, base - H * 0.6, 0.7, 0.3, PINE, k);
      return;
    }
    pines.capsule(cx, base, cx + lean, base - H, 1.3, 0.45, PINE, k);
    const tiers = 8;
    for (let t = 0; t < tiers; t++) {
      const f = t / tiers;
      if (rng.chance(0.1)) continue;
      const ty0 = base - H * (0.15 + f * 0.82);
      const tx0 = cx + lean * (0.15 + f * 0.82);
      const half = ((1 - f) * H * 0.24 + 1.3) * rng.range(0.7, 1.25);
      const droop = half * 0.4;
      pines.polygon([tx0, ty0 - H * 0.15, tx0 + half, ty0 + droop, tx0 + half * 0.35, ty0 + droop * 0.55, tx0 - half * 0.35, ty0 + droop * 0.55, tx0 - half, ty0 + droop], PINE, k, 1.1);
    }
  };
  ridge.forEach(([tx, ty, sc], k) => pine(tx, ty, sc, k));
  const pineCol: RGB = [tint[0] * 0.45, tint[1] * 0.52, tint[2] * 0.66];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d0 = pines.d[i] as number;
      if (d0 > pines.reach) continue;
      const d = d0 + noise.noise2(x * 0.55, y * 0.45) * 0.7;
      const a = cover(d, 1.15);
      if (a <= 0.002) continue;
      pines.gradient(x, y, G);
      const r = smoothstep(2.2, 0, -d) * facing(G[0], G[1]) * rimK * 0.7;
      mix3(pineCol, air, smoothstep(M.y(0.5), M.y(0.76), y) * 0.7, C);
      out.over(i, C[0] + rim[0] * r, C[1] + rim[1] * r, C[2] + rim[2] * r, a);
    }
  }

  // The waterfall: a first drop from the cleft to a ledge, a long fall into the mist, spray at both feet.
  const water: RGB = [0.56, 0.72, 0.84];
  const foam: RGB = [0.86, 0.95, 1];
  const fall = (x0: number, y0: number, x1: number, y1: number, w0: number, w1: number, salt: number): void => {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y1)); y++) {
      const t = (y - y0) / (y1 - y0);
      const cx = x0 + (x1 - x0) * t * t + noise.noise2(y * 0.025, salt) * 1.2;
      const hw = w0 + (w1 - w0) * t;
      for (let x = Math.max(0, Math.floor(cx - hw - 3)); x < Math.min(w, Math.ceil(cx + hw + 3)); x++) {
        const across = Math.abs(x + 0.5 - cx) / hw;
        const strip = cover((across - 1) * hw, 1.6);
        if (strip <= 0) continue;
        const streak = brush(noise, y, x - cx, 20, 1.2, salt) * 0.5 + 0.5;
        const ends = smoothstep(0, 0.06, t) * (1 - smoothstep(0.78, 1, t));
        const a = strip * ends * (0.35 + 0.55 * streak) * (1 - 0.35 * across);
        mix3(water, foam, smoothstep(0.5, 0.95, streak) * (1 - across * 0.7), C);
        mix3(C, air, smoothstep(M.y(0.55), M.y(0.78), y) * 0.6, C);
        out.over(y * w + x, C[0], C[1], C[2], a);
      }
    }
  };
  const spray = (px: number, py: number, rx: number, ry: number, strength: number): void => {
    for (let y = Math.max(0, Math.floor(py - ry * 1.5)); y < Math.min(h, Math.ceil(py + ry)); y++) {
      for (let x = Math.max(0, Math.floor(px - rx * 1.4)); x < Math.min(w, Math.ceil(px + rx * 1.4)); x++) {
        const r = Math.hypot((x - px) / rx, (y - py) / ry);
        const puff = (1 - smoothstep(0.1, 1, r + noise.fbm(x * 0.04, y * 0.06, 3) * 0.45)) * strength;
        if (puff > 0) out.over(y * w + x, 0.34, 0.5, 0.62, puff);
      }
    }
  };
  fall(M.x(0.747), M.y(Y2(0.15)), M.x(0.752), M.y(Y2(0.34)), 2.2, 4, 4);
  spray(M.x(0.753), M.y(Y2(0.338)), M.s(36), M.s(16), 0.36);
  fall(M.x(0.754), M.y(Y2(0.34)), M.x(0.769), M.y(Y2(0.64)), 3.4, 8, 9);
  spray(M.x(0.77), M.y(Y2(0.62)), M.s(120), M.s(50), 0.4);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// glade-frame: the ancient tree and its bough

const BARK = 1;
const LEAF = 2;
const MOSS = 3;

/** A layer-space box (the moon's sweep over the area's cameras). */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * The frame is laid out in layer units around the moon's sweep over the Glade cameras (`moon`, tools/art/
 * moon.ts): the moon is screen-fixed while the frame moves at f 0.6, so the bough and its canopy stay
 * above the box and the trunk left of it at every camera; only sparse, thin strands hang across it.
 */
function paintFrame(cv: Canvas, look: DepthLook, seed: number, moon: Box | null): Paint {
  const { w, h, map: M } = cv;
  const noise = new Noise(seed);
  const rng = new Rng(seed);
  const out = new Paint(w, h);
  const tint = look.tint;
  const rim = KIT_RIM_COLOR;
  const rimK = look.rim * KIT_RIM_SCALE * 1.9;
  const air: RGB = [look.fogColor[0] + 0.015, look.fogColor[1] + 0.045, look.fogColor[2] + 0.04];
  const mistY0 = M.y(0.58);
  const mistY1 = M.y(0.82);
  const flora = hex(0x3fe0c5);
  const warm = hex(0xffb45a);
  const margin = M.s(40);
  const inside = (x: number): number => Math.min(w - margin, Math.max(margin, x));
  // Layer units → canvas texels.
  const ts = 1 / M.s(1);
  const PX = (lx: number): number => (lx - cv.origin[0]) / ts;
  const PY = (ly: number): number => (ly - cv.origin[1]) / ts;
  const keep: Box = moon ?? { x0: cv.origin[0] + w * ts, y0: cv.origin[1] + h * ts, x1: cv.origin[0] + w * ts, y1: cv.origin[1] + h * ts };
  // What stays clear of the moon, with a margin: the bough's underside above `top`, the trunk left of `left`.
  const top = PY(keep.y0 - 18);
  const left = PX(keep.x0 - 16);
  const right = PX(keep.x1 + 16);
  const bottom = PY(keep.y1 + 10);

  // --- Structure: a buttressed trunk rising out of the glade's left edge, forking high above the
  // moon's band into the great bough that arches over the glade and droops at its far end.
  const wood = new Field(w, h);
  wood.reach = 22;
  const ground = M.y(0.8);
  const trunk = {
    base: [left - M.s(166), ground + M.s(30)] as [number, number],
    bend: [left - M.s(214), M.y(0.46)] as [number, number],
    fork: [left - M.s(105), top - M.s(60)] as [number, number],
  };
  const trunkAt = (t: number): [number, number] => {
    const it = 1 - t;
    return [
      it * it * trunk.base[0] + 2 * it * t * trunk.bend[0] + t * t * trunk.fork[0],
      it * it * trunk.base[1] + 2 * it * t * trunk.bend[1] + t * t * trunk.fork[1],
    ];
  };
  const fork = trunk.fork;
  wood.curve(trunk.base[0], trunk.base[1], trunk.bend[0], trunk.bend[1], fork[0], fork[1], M.s(122), M.s(84), BARK, 1, 0, 16);
  // Burls and knuckles on the trunk, never reaching past its moon-side edge.
  for (const [t, dx, r] of [[0.8, -0.3, 34], [0.62, 0.2, 50], [0.35, -0.5, 44]] as const) {
    const [x, y] = trunkAt(t);
    const rr = M.s(r);
    const cx = Math.min(x + dx * M.s(100), left - rr * 1.25 - M.s(8));
    wood.ellipse(cx, y, rr, rr * 1.2, BARK, 1, M.s(26));
  }
  // Buttress roots: a few distinct flanges that grip the ground, with gaps between them.
  const roots: [number, number, number][] = [[-1, 1, 1], [1, 1, 0.95], [-1, 0.55, 0.8], [1, 0.6, 0.75], [-1, 0.25, 0.6], [1, 0.3, 0.55]];
  for (const [side, reachK, thick] of roots) {
    const sx = trunk.base[0] + side * M.s(62) * (0.3 + 0.7 * reachK);
    const sy = ground - M.s(250) * (0.45 + 0.55 * reachK) * rng.range(0.85, 1.1);
    const ex = inside(sx + side * M.s(330) * reachK * rng.range(0.85, 1.1));
    wood.curve(sx, sy, sx + (ex - sx) * 0.3, ground - M.s(50) * reachK, ex, ground + M.s(40), M.s(64) * thick, M.s(12), BARK, 1, M.s(9), 12);
  }
  // Up into the crown, and the bough: thick at the fork, knuckled, arching over and drooping at its end.
  const crownTop = M.s(-30);
  wood.curve(fork[0], fork[1] + M.s(60), fork[0] - M.s(70), (fork[1] + crownTop) / 2, fork[0] - M.s(20), crownTop, M.s(84), M.s(52), BARK, 2, M.s(20), 12);
  // Two quadratic spans: high and level across the moon's band, then down past its far side.
  const end: [number, number] = [Math.min(right + M.s(430), w - M.s(110)), top + M.s(500)];
  const span1: [number, number][] = [[fork[0] + M.s(35), fork[1] + M.s(18)], [left + M.s(255), top - M.s(95)], [(left + right) / 2 + M.s(270), top - M.s(80)]];
  const span2: [number, number][] = [span1[2] as [number, number], [right + M.s(160), top - M.s(50)], end];
  const SPLIT = 0.55;
  const quad = (q: readonly [number, number][], t: number): [number, number] => {
    const it = 1 - t;
    const a = q[0] as [number, number];
    const b = q[1] as [number, number];
    const c = q[2] as [number, number];
    return [it * it * a[0] + 2 * it * t * b[0] + t * t * c[0], it * it * a[1] + 2 * it * t * b[1] + t * t * c[1]];
  };
  const along = (t: number): [number, number] => (t < SPLIT ? quad(span1, t / SPLIT) : quad(span2, (t - SPLIT) / (1 - SPLIT)));
  const boughR = (t: number): number => M.s(70 - 46 * t);
  for (const [q, t0, t1] of [[span1, 0, SPLIT], [span2, SPLIT, 1]] as const) {
    const a = q[0] as [number, number];
    const b = q[1] as [number, number];
    const c = q[2] as [number, number];
    wood.curve(a[0], a[1], b[0], b[1], c[0], c[1], boughR(t0), boughR(t1), BARK, 3, M.s(26), 20);
  }
  for (const t of [0.18, 0.37, 0.55, 0.71, 0.86]) {
    const [x, y] = along(t);
    wood.ellipse(x, y - boughR(t) * 0.1, boughR(t) * 1.25, boughR(t) * 1.05, BARK, 3, M.s(22));
  }
  // The underside of the bough at canvas x (strands hang from it).
  const under = (x: number): { y: number; t: number } => {
    let best = { y: top, t: 0, d: Infinity };
    for (let t = 0; t <= 1; t += 0.002) {
      const [bx, by] = along(t);
      const d = Math.abs(bx - x);
      if (d < best.d) best = { y: by + boughR(t) * 0.8, t, d };
    }
    return { y: best.y, t: best.t };
  };
  // Short, thick limbs rising from the bough and the crown into the canopy; a broken stub.
  const canopy: [number, number, number, number][] = [];
  const limb = (t: number, ang: number, len: number, r: number): void => {
    const [x, y] = along(t);
    const ex = x + Math.cos(ang) * M.s(len);
    const ey = y + Math.sin(ang) * M.s(len);
    wood.curve(x, y, (x + ex) / 2 + M.s(rng.range(-20, 20)), (y + ey) / 2 + M.s(20), ex, ey, M.s(r), M.s(r * 0.55), BARK, 4, M.s(12), 8);
    canopy.push([ex, ey, M.s(150 + len * 0.3), M.s(105 + len * 0.15)]);
  };
  limb(0.2, -1.9, 170, 30);
  limb(0.4, -1.35, 150, 26);
  limb(0.58, -1.7, 130, 22);
  limb(0.76, -1.1, 110, 18);
  limb(0.93, -0.5, 80, 14);
  // A lower limb reaching out of the frame on the left (clear of the moon: it only goes left).
  const [lx0, ly0] = trunkAt(0.72);
  const lx1 = lx0 - M.s(170);
  const ly1 = ly0 - M.s(110);
  wood.curve(lx0, ly0, (lx0 + lx1) / 2, ly0 - M.s(10), lx1, ly1, M.s(30), M.s(12), BARK, 5, M.s(14), 10);
  canopy.push([lx1 + M.s(20), ly1 + M.s(10), M.s(150), M.s(95)]);
  canopy.push([(lx0 + lx1) / 2 - M.s(30), ly0 + M.s(20), M.s(120), M.s(80)]);
  const [sx0, sy0] = along(0.64);
  wood.capsule(sx0, sy0, sx0 + M.s(40), sy0 + M.s(46), M.s(14), M.s(9), BARK, 4, M.s(8));
  canopy.push([fork[0] - M.s(60), crownTop + M.s(40), M.s(210), M.s(130)]);
  canopy.push([fork[0] - M.s(160), fork[1] - M.s(80), M.s(150), M.s(100)]);
  canopy.push([fork[0] + M.s(70), crownTop + M.s(130), M.s(180), M.s(120)]);
  // The far end: a heavy corner of foliage where the bough comes down past the moon's band.
  canopy.push([right + M.s(200), top + M.s(150), M.s(150), M.s(100)]);
  canopy.push([right + M.s(330), top + M.s(330), M.s(150), M.s(105)]);
  canopy.push([end[0] + M.s(30), end[1] + M.s(20), M.s(120), M.s(90)]);
  canopy.push([end[0] - M.s(80), end[1] - M.s(40), M.s(110), M.s(80)]);

  // --- Canopy: overlapping clump-of-clumps masses, lowest first so higher ones overlap. Over the moon's
  // band a mass never reaches below the bough.
  const leaves = new Field(w, h);
  leaves.reach = 10;
  const masses: [number, number, number, number][] = [];
  for (const [cx, cy, rx, ry] of canopy) {
    masses.push([cx, cy, rx, ry]);
    for (let k = 0; k < 3; k++) {
      const a = rng.range(-Math.PI, 0);
      masses.push([cx + Math.cos(a) * rx * 0.7, cy + Math.sin(a) * ry * 0.6 + ry * 0.2, rx * rng.range(0.45, 0.65), ry * rng.range(0.45, 0.65)]);
    }
  }
  masses.sort((a, b) => b[1] + b[3] - (a[1] + a[3]));
  masses.forEach(([cx, cy, rx, ry], k) => {
    // Keep clear of the band: masses beside it stay wholly beside it, masses over it stay above it.
    let x = inside(cx);
    let y = cy;
    if (x >= right) x = Math.max(x, right + rx * 1.05);
    else if (x <= left) x = Math.min(x, left - rx * 1.05);
    else y = Math.min(cy, top - ry * 1.05);
    foliage(leaves, rng, x, y, rx, ry, LEAF, k + 1);
  });

  // --- The hollow in the trunk: an irregular opening.
  const trunkX = (py: number): number => {
    let best = trunk.base[0];
    let bd = Infinity;
    for (let t = 0; t <= 1; t += 0.002) {
      const [x, y] = trunkAt(t);
      if (Math.abs(y - py) < bd) {
        bd = Math.abs(y - py);
        best = x;
      }
    }
    return best;
  };
  const hy = M.y(0.47);
  const hx = trunkX(hy) - M.s(10);
  const hrx = M.s(44);
  const hry = M.s(82);
  const hollowSdf = (x: number, y: number): number => {
    const a = Math.atan2(y - hy, x - hx);
    const wob = 1 + noise.noise2(Math.cos(a) * 1.6 + 5, Math.sin(a) * 1.6 + 5) * 0.22;
    return (Math.hypot((x - hx) / hrx, (y - hy) / hry) - wob) * Math.min(hrx, hry);
  };

  // --- Bark.
  const barkShade: RGB = [tint[0] * 0.56, tint[1] * 0.58, tint[2] * 0.66];
  const barkMid: RGB = [tint[0] * 1.0, tint[1] * 1.0, tint[2] * 1.02];
  const barkLit: RGB = [tint[0] * 2.0 + 0.015, tint[1] * 1.9 + 0.03, tint[2] * 1.6 + 0.035];
  const mossDark: RGB = [0.02, 0.058, 0.056];
  const mossLit: RGB = [0.055, 0.15, 0.13];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d0 = wood.d[i] as number;
      if (d0 > wood.reach) continue;
      const u = wood.u[i] as number;
      const v = wood.v[i] as number;
      const part = wood.part[i] as number;
      // Furrows run along the limb (u), ridges across (v).
      const furrow = noise.ridged(u * 0.01 + noise.noise2(v * 0.02, 1.1) * 0.3, v * 0.12, 3);
      const edgeN = (brush(noise, u, v, 34, 6, 2) * 0.5 + (furrow - 0.5) * 1.1) * 2.8;
      const d = d0 + edgeN;
      const wisp = noise.fbm(x * 0.009, y * 0.02, 3) * M.s(70);
      const fade = 1 - smoothstep(mistY1 - M.s(40), mistY1 + M.s(70), y + wisp);
      const a = cover(d, 1.5) * fade;
      if (a <= 0.002) continue;
      wood.gradient(x, y, G);
      const l = pillow(G[0], G[1], -d, M.s(80), 0, 0);
      const stroke = brush(noise, u, v, 22, 3.5, 5);
      mix3(barkShade, barkMid, smoothstep(0.06, 0.48, l), C);
      mix3(C, barkLit, smoothstep(0.5, 0.95, l + stroke * 0.1) * 0.85, C);
      const k = 0.7 + furrow * 0.55 + stroke * 0.06;
      for (let c = 0; c < 3; c++) C[c] = (C[c] as number) * k;
      // Moss in patches on the upper faces, thicker on the bough.
      const up = Math.max(0, -G[1]) * smoothstep(-2, 14, -d);
      const patch = noise.fbm(x * 0.018, y * 0.018, 3);
      const mossy = smoothstep(0.35, 0.65, up * (part === 3 ? 1.1 : 0.7) + patch * 0.7);
      mix3(C, mix3(mossDark, mossLit, smoothstep(0.35, 0.9, l), T), mossy * 0.85, C);
      const hs = hollowSdf(x + 0.5, y + 0.5);
      if (part === 1 && hs < 0) {
        // The throat: near black, a faint warm light low inside.
        const depth = smoothstep(0, M.s(30), -hs);
        const glow = (1 - smoothstep(0, 1, Math.hypot((x - hx) / hrx, (y - hy - hry * 0.35) / (hry * 0.55)))) * 0.55;
        mix3([0.008, 0.014, 0.024], [warm[0] * 0.3, warm[1] * 0.2, warm[2] * 0.11], glow * depth, C);
      } else if (part === 1 && hs < M.s(12)) {
        // The lip curls in: lit where it faces the moon, dark where it turns away.
        const t = smoothstep(M.s(12), 0, hs);
        const nx = (x - hx) / hrx;
        const ny = (y - hy) / hry;
        const lip = Math.max(0, -(nx * -0.55 + ny * -0.83)) * t;
        for (let c = 0; c < 3; c++) C[c] = (C[c] as number) * (1 - 0.4 * t) + (rim[c] as number) * lip * rimK * 0.7;
      }
      const r = smoothstep(M.s(11), 0, -d) * facing(G[0], G[1]) * rimK * (0.7 + 0.3 * stroke) * (1 - mossy * 0.4);
      for (let c = 0; c < 3; c++) C[c] = (C[c] as number) + (rim[c] as number) * r;
      mix3(C, air, smoothstep(mistY0, mistY1, y + wisp) * 0.9, C);
      out.over(i, C[0], C[1], C[2], a);
    }
  }

  // --- Canopy shading: every lobe is a lit ball inside a lit mass; dabs of broken light on top.
  const leafShade: RGB = [tint[0] * 0.5, tint[1] * 0.66, tint[2] * 0.66];
  const leafMid: RGB = [tint[0] * 0.95, tint[1] * 1.15, tint[2] * 1.02];
  const leafLit: RGB = [tint[0] * 1.6 + 0.012, tint[1] * 1.85 + 0.035, tint[2] * 1.45 + 0.025];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d0 = leaves.d[i] as number;
      if (d0 > leaves.reach) continue;
      const d = d0 + (noise.fbm(x * 0.07, y * 0.07, 2) * 0.6 + noise.noise2(x * 0.3, y * 0.3) * 0.4) * 3;
      const a = cover(d, 1.4);
      if (a <= 0.002) continue;
      leaves.gradient(x, y, G);
      const lobe = leaves.lobeLight(i, x + 0.5, y + 0.5, LIGHT);
      const l = lobe >= 0 ? lobe * 0.8 + pillow(G[0], G[1], -d, M.s(14)) * 0.2 : pillow(G[0], G[1], -d, M.s(30));
      const dab = brush(noise, x + y * 0.4, y - x * 0.25, 7, 3.2, 7);
      mix3(leafShade, leafMid, smoothstep(0.15, 0.55, l), C);
      mix3(C, leafLit, smoothstep(0.6, 0.95, l + dab * 0.14) * 0.8, C);
      const r = smoothstep(M.s(8), 0, -d) * facing(G[0], G[1]) * rimK * 1.05;
      for (let c = 0; c < 3; c++) C[c] = (C[c] as number) * (1 + dab * 0.07) + (rim[c] as number) * r;
      out.over(i, C[0], C[1], C[2], a);
    }
  }

  // --- Moss: curtains beside the trunk and under the bough's drooping end, and single thin strands across
  // the moon's band, spaced wider than the moon so it is never behind more than one of them.
  const strands = new Field(w, h);
  strands.reach = 4;
  const tips: [number, number, number][] = [];
  let sid = 0;
  const strand = (x0: number, len: number, thin: boolean): void => {
    const u = under(x0).y;
    const drift = M.s(rng.range(-16, 16));
    strands.curve(x0, u - M.s(8), x0 + drift * 0.3, u + len * 0.5, x0 + drift, u + len, M.s(thin ? 4.2 : 5), M.s(thin ? 1.3 : 1.4), MOSS, sid, 1.2, 8);
    for (let f = 0.1; f < 0.97; f += thin ? rng.range(0.1, 0.16) : rng.range(0.05, 0.1)) {
      const fx = x0 + drift * f * f;
      const fy = u + len * f;
      const sideF = rng.chance(0.5) ? -1 : 1;
      const size = M.s(thin ? 8 : 11) * (1 - 0.45 * f) * rng.range(0.7, 1.2);
      strands.capsule(fx, fy, fx + sideF * size * 0.8, fy + size, M.s(thin ? 2.6 : 3.2), M.s(0.8), MOSS, sid, 0.8);
    }
    sid++;
    if (len > M.s(200) && rng.chance(thin ? 0.5 : 0.4)) tips.push([x0 + drift, u + len + M.s(3), rng.range(0.7, 1.1)]);
  };
  const curtain = (xc: number, halfWidth: number, longest: number): void => {
    const n = 7 + Math.floor(rng.range(0, 9));
    for (let k = 0; k < n; k++) {
      const q = (k / Math.max(1, n - 1)) * 2 - 1;
      strand(xc + q * halfWidth + M.s(rng.range(-6, 6)), M.s(Math.max(30, longest * (1 - q * q * 0.8) * rng.range(0.55, 1.05))), false);
    }
  };
  curtain(left - M.s(58), M.s(34), rng.range(440, 520));
  curtain(right + M.s(150), M.s(70), rng.range(320, 400));
  curtain(end[0] - M.s(40), M.s(60), rng.range(110, 170));
  const spacing = M.s(2 * 40 + 44);
  for (let x = left + M.s(64); x < right - M.s(30); x += spacing + M.s(rng.range(-10, 10))) strand(x, M.s(rng.range(300, 640)), true);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d0 = strands.d[i] as number;
      if (d0 > strands.reach) continue;
      const a = cover(d0 + noise.noise2(x * 0.45, y * 0.2) * 0.6, 1.1) * 0.96;
      if (a <= 0.002) continue;
      strands.gradient(x, y, G);
      const lit = 0.2 + facing(G[0], G[1]) * 0.6 + noise.noise2(x * 0.05, y * 0.02) * 0.15;
      mix3(mossDark, mossLit, clamp01(lit), C);
      mix3(C, air, smoothstep(mistY0, mistY1, y) * 0.8, C);
      out.over(i, C[0], C[1], C[2], a);
    }
  }

  // --- Glowing fungi: shelves below the hollow and on the roots, beads on the longest moss strands.
  const glowSpot = (fx: number, fy: number, rx: number, ry: number, halo: number, strength: number): void => {
    for (let y = Math.max(0, Math.floor(fy - halo)); y < Math.min(h, Math.ceil(fy + halo)); y++) {
      for (let x = Math.max(0, Math.floor(fx - halo)); x < Math.min(w, Math.ceil(fx + halo)); x++) {
        const e = Math.hypot((x + 0.5 - fx) / rx, (y + 0.5 - fy) / ry);
        const core = cover((e - 1) * Math.min(rx, ry), 1.1);
        const hl = (1 - smoothstep(0, halo, Math.hypot(x + 0.5 - fx, (y + 0.5 - fy) * 1.3))) ** 2.2 * 0.28 * strength;
        const a = Math.max(core, hl);
        if (a <= 0.002) continue;
        const k = core >= hl ? 1 : 0.85;
        out.over(y * w + x, flora[0] * k + 0.1 * core, flora[1] * k + 0.05 * core, flora[2] * k + 0.05 * core, a);
      }
    }
  };
  // Bracket shelves: a dark cap, lit on top, with a glowing gill line underneath; they grow in stacks.
  const shelf = (fx: number, fy: number, size: number): void => {
    const rx = M.s(34) * size;
    const ry = M.s(15) * size;
    for (let y = Math.max(0, Math.floor(fy - ry * 1.2)); y < Math.min(h, Math.ceil(fy + ry)); y++) {
      for (let x = Math.max(0, Math.floor(fx - rx * 1.2)); x < Math.min(w, Math.ceil(fx + rx * 1.2)); x++) {
        const dx = (x + 0.5 - fx) / rx;
        const dy = (y + 0.5 - fy) / ry;
        // A half-lens: rounded cap above, nearly flat gills below.
        const e = dy < 0 ? Math.hypot(dx, dy) : Math.hypot(dx, dy * 3.2);
        const a = cover((e - 1) * ry, 1.3);
        if (a <= 0.002) continue;
        const top = smoothstep(0.2, -0.9, dy) * smoothstep(0.6, -0.6, dx);
        const gill = smoothstep(-0.05, 0.25, dy);
        mix3([tint[0] * 1.1, tint[1] * 1.15, tint[2] * 1.15], [tint[0] * 2.2 + 0.03, tint[1] * 2.1 + 0.05, tint[2] * 1.8 + 0.06], top * 0.8, C);
        mix3(C, [flora[0] * 0.75, flora[1] * 0.85, flora[2] * 0.82], gill * 0.9, C);
        out.over(y * w + x, C[0], C[1], C[2], a);
      }
    }
    glowSpot(fx, fy + ry * 0.25, rx * 0.8, ry * 0.18, M.s(56) * size, 0.95);
  };
  const stack = (fx: number, fy: number, size: number): void => {
    shelf(fx, fy, size);
    shelf(fx + M.s(26) * size, fy + M.s(30) * size, size * 0.75);
    shelf(fx - M.s(20) * size, fy + M.s(52) * size, size * 0.6);
  };
  stack(hx + M.s(26), hy + hry + M.s(40), 1.1);
  stack(Math.min(trunkX(M.y(0.3)) + M.s(96), left - M.s(60)), Math.max(M.y(0.3), bottom + M.s(30)), 0.8);
  stack(trunkX(M.y(0.66)) - M.s(134), M.y(0.66), 0.75);
  for (const [fx, fy, sz] of tips) glowSpot(fx, fy, M.s(4) * sz, M.s(5) * sz, M.s(26) * sz, 0.8);
  // Clusters of small glowing mushrooms among the roots, half in the mist.
  for (const [cx0, n] of [[-250, 4], [-130, 3], [150, 5], [290, 3]] as const) {
    for (let k = 0; k < n; k++) {
      const fx = trunk.base[0] + M.s(19 + cx0 + rng.range(-30, 30));
      const fy = ground - M.s(rng.range(60, 120));
      const stem = M.s(rng.range(10, 22));
      const cap = M.s(rng.range(5, 9));
      for (let y = Math.max(0, Math.floor(fy - stem - cap)); y < Math.min(h, Math.ceil(fy)); y++) {
        for (let x = Math.max(0, Math.floor(fx - cap * 1.3)); x < Math.min(w, Math.ceil(fx + cap * 1.3)); x++) {
          const sStem = Math.abs(x + 0.5 - fx) - M.s(1.6);
          const inStem = y + 0.5 > fy - stem ? cover(sStem, 1) : 0;
          const e = Math.hypot((x + 0.5 - fx) / (cap * 1.2), (y + 0.5 - (fy - stem)) / cap);
          const inCap = y + 0.5 < fy - stem + cap * 0.3 ? cover((e - 1) * cap, 1.1) : 0;
          if (inCap > 0.002) out.over(y * w + x, flora[0] * 0.9 + 0.08, flora[1] * 0.95 + 0.04, flora[2] * 0.92 + 0.04, inCap);
          else if (inStem > 0.002) out.over(y * w + x, 0.1, 0.22, 0.22, inStem * 0.9);
        }
      }
      glowSpot(fx, fy - stem, cap * 0.9, cap * 0.6, M.s(30), 0.8);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------

interface Piece {
  id: string;
  f: number;
  texelScale: number;
  minQuality: QualityLevel;
  seed: number;
  /** View-fraction rect of the reference view; `tall` extends it to the layer's top at the highest camera. */
  rect: [number, number, number, number];
  tall: boolean;
  /** `moon`: the layer-space box the moon sweeps over the Glade cameras at this piece's parallax. */
  paint(cv: Canvas, look: DepthLook, seed: number, moon: Box | null): Paint;
  note: string;
}

export const PIECES: readonly Piece[] = [
  {
    id: 'glade-landmark', f: 0.2, texelScale: 1.5, minQuality: 'low', seed: 0x51a7e, rect: [0.5, 0.15, 0.97, 0.86], tall: false, paint: paintLandmark,
    note: 'Stand-in painted by tools/art/paint-example.ts: a far crag with a moonlit waterfall, between L2 and L3 on the value ramp.',
  },
  {
    id: 'glade-frame', f: 0.6, texelScale: 2, minQuality: 'medium', seed: 0x9a7e, rect: [-0.06, 0, 0.99, 0.84], tall: true, paint: paintFrame,
    note: 'Stand-in painted by tools/art/paint-example.ts: an ancient tree whose bough arches over the glade, between L5 and L6 on the value ramp.',
  },
];

/** Shade a straight RGBA plate as the plate program does (tint #fff, desaturate, fog) for value checks. */
export function shadePlateTexel(tex: Readonly<RGB>, look: DepthLook, out: RGB): RGB {
  let r = tex[0];
  let g = tex[1];
  let b = tex[2];
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r += (l - r) * look.desaturate;
  g += (l - g) * look.desaturate;
  b += (l - b) * look.desaturate;
  out[0] = r + (look.fogColor[0] - r) * look.fog;
  out[1] = g + (look.fogColor[1] - g) * look.fog;
  out[2] = b + (look.fogColor[2] - b) * look.fog;
  return out;
}

/** Shaded body luma of a kit layer (a neutral texel, no rim, above its mist), as value-ramp.ts prints it. */
function kitBody(l: KitLayerDef): number {
  const placement = { extent: { x0: 0, y0: 0, x1: 0, y1: 0 }, baselineY: 0, groundFillTop: null, instances: [] } as LayerPlacement;
  const o = new Float32Array(4);
  shadeKit(o, [0.5, 0, 0, 1], 0.5, [0, 0, 0], -1e9, { ...kitShadeParams(l, RECIPES[l.recipe] as (typeof RECIPES)[string], placement), glow: 0 }, KIT_MODE.Core);
  return luma([o[0] as number, o[1] as number, o[2] as number]);
}

/** Percentiles of the shaded luma of the plate's opaque texels, against its neighbours' kit bodies. */
export function valueReport(rgba: Uint8Array, look: DepthLook): { p10: number; p50: number; p90: number; behind: number; front: number } {
  const v: number[] = [];
  const tex: RGB = [0, 0, 0];
  const o: RGB = [0, 0, 0];
  for (let i = 0; i < rgba.length; i += 4) {
    if ((rgba[i + 3] as number) < 250) continue;
    tex[0] = (rgba[i] as number) / 255;
    tex[1] = (rgba[i + 1] as number) / 255;
    tex[2] = (rgba[i + 2] as number) / 255;
    v.push(luma(shadePlateTexel(tex, look, o)));
  }
  v.sort((a, b) => a - b);
  const pct = (p: number): number => v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? Number.NaN;
  return { p10: pct(0.1), p50: pct(0.5), p90: pct(0.9), behind: kitBody(look.behind), front: kitBody(look.front) };
}

async function main(argv: string[]): Promise<void> {
  const oi = argv.indexOf('--only');
  const only = oi >= 0 ? argv[oi + 1] : null;
  const pi = argv.indexOf('--preview');
  const previewDir = pi >= 0 ? argv[pi + 1] : null;
  const paths = artPaths();
  const level = parseLdtk(JSON.parse(readFileSync(paths.ldtk, 'utf8')));
  const base = parseManifest(JSON.parse(readFileSync(paths.base, 'utf8')));
  const area = resolveArea(level, 'glade');
  const ref = referenceCamera(level, area);
  const range = areaCameraRange(level, area);
  const sky = base.layers.find((l): l is SkyLayerDef => l.kind === 'sky');
  if (!sky) throw new Error('the base manifest has no sky layer');
  mkdirSync(paths.plates, { recursive: true });
  if (previewDir) mkdirSync(previewDir, { recursive: true });
  for (const p of PIECES) {
    if (only && only !== p.id) continue;
    const look = depthLook(base, p.f);
    // Tall pieces reach the layer's top as seen from the highest camera (y = VIEW_H/2).
    const top = p.tall ? (VIEW_H / 2) * p.f - VIEW_H / 2 - 24 : null;
    const cv = canvasFor(ref, p.f, p.texelScale, p.rect[0], p.rect[1], p.rect[2], p.rect[3], top);
    const t0 = performance.now();
    const rgba = p.paint(cv, look, p.seed, moonSweepBox(sky, range, p.f, p.f)).toRgba8();
    const ms = performance.now() - t0;
    const png = await sharp(Buffer.from(rgba), { raw: { width: cv.w, height: cv.h, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();
    writeFileSync(join(paths.plates, `${p.id}.png`), png);
    const sidecar = {
      _note: p.note,
      parallax: [p.f, p.f],
      replaces: null,
      origin: cv.origin,
      texelScale: p.texelScale,
      minQuality: p.minQuality,
      fog: Math.round(look.fog * 1000) / 1000,
      fogColor: toHex(look.fogColor),
      desaturate: Math.round(look.desaturate * 1000) / 1000,
      tint: '#ffffff',
      area: 'glade',
    };
    writeFileSync(join(paths.plates, `${p.id}.json`), formatJson(sidecar));
    const v = valueReport(rgba, look);
    console.log(`${p.id}: ${cv.w}×${cv.h} at layer (${cv.origin.join(', ')}), f ${p.f}, painted in ${ms.toFixed(0)} ms, ${(png.length / 1024).toFixed(0)} KB`);
    console.log(`  shaded luma of opaque texels p10 ${v.p10.toFixed(3)} p50 ${v.p50.toFixed(3)} p90 ${v.p90.toFixed(3)}; bodies: ${look.behind.id} ${v.behind.toFixed(3)} (behind), ${look.front.id} ${v.front.toFixed(3)} (in front)`);
    const moon = moonCoverage({ rgba, width: cv.w, height: cv.h, origin: cv.origin, texelScale: p.texelScale, parallax: [p.f, p.f] }, sky, range);
    console.log(`  hides at most ${(moon.max * 100).toFixed(1)} % of the moon over the Glade cameras (camera ${moon.cx.toFixed(0)}, ${moon.cy.toFixed(0)} at ${moon.aspect.toFixed(2)}:1, zoom ${moon.zoom})`);
    if (previewDir) {
      const shaded = new Uint8Array(rgba.length);
      const tex: RGB = [0, 0, 0];
      const o: RGB = [0, 0, 0];
      for (let i = 0; i < rgba.length; i += 4) {
        const a = (rgba[i + 3] as number) / 255;
        tex[0] = (rgba[i] as number) / 255;
        tex[1] = (rgba[i + 1] as number) / 255;
        tex[2] = (rgba[i + 2] as number) / 255;
        shadePlateTexel(tex, look, o);
        for (let c = 0; c < 3; c++) shaded[i + c] = Math.round(clamp01((o[c] as number) * a + (look.fogColor[c] as number) * 0.55 * (1 - a)) * 255);
        shaded[i + 3] = 255;
      }
      await sharp(Buffer.from(shaded), { raw: { width: cv.w, height: cv.h, channels: 4 } }).png().toFile(join(previewDir, `${p.id}.shaded.png`));
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
