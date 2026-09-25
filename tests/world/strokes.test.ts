import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseManifest } from '../../src/assets/manifest.ts';
import { MAX_ASPECT, VIEW_H } from '../../src/config.ts';
import type { LevelData } from '../../src/contracts/level.ts';
import { placeDecor } from '../../src/render/fx/decorPlacement.ts';
import {
  BRUSH_SIZE, BrushKernel, brushStroke, cellsAround, DRY_SCALE, LINE_BODY, POLAR_BODY, STROKE, strokeWidthTexels, type StrokeOptions,
} from '../../src/render/gen/brush.ts';
import { generateKit, kitSeed, type KitAtlasData, type KitElement } from '../../src/render/gen/kit.ts';
import {
  ELEMENT_SPECS, KIT_CATEGORIES, MIN_INSTANCE_SCALE, MIN_PX_PER_UNIT, STROKE_GAIN, STROKE_NEAR_GAIN, type ElementSpec, type KitCategory,
} from '../../src/render/gen/kitElements.ts';
import { NoiseTable } from '../../src/render/gen/noiseTable.ts';
import { EDGE_NOISE_MAX, ElementRaster, Mat, POLAR_FADE_IN, POLAR_FADE_OUT, STROKE_SEAM } from '../../src/render/gen/raster.ts';
import { KIT_FRAGMENT } from '../../src/render/layers/kit.glsl.ts';
import { recipeStrokeGain } from '../../src/render/layers/layerModel.ts';
import { RECIPES, type Recipe } from '../../src/render/layers/recipes.ts';
import { renderScaleCap } from '../../src/render/post/viewport.ts';
import { TERRAIN_CORE_FRAGMENT, TERRAIN_CORE_VERTEX, TERRAIN_EDGE_FRAGMENT, TERRAIN_EDGE_VERTEX } from '../../src/render/terrain/terrain.glsl.ts';
import {
  buildTerrainMesh, CORE_STRIDE_FLOATS, CORE_STROKE_OFFSET, DEFAULT_TERRAIN, EDGE_STRIDE_FLOATS, STROKE_JUMP, strokeContinuity,
  type TerrainMesh,
} from '../../src/render/terrain/terrainMesh.ts';
import {
  shadeTerrainCore, TERRAIN_STROKE_CELLS, TERRAIN_STROKE_CLAMP, TERRAIN_STROKE_CONT_MAX, TERRAIN_STROKE_DEPTH, TERRAIN_STROKE_GAIN,
  TERRAIN_STROKE_KD, TERRAIN_STROKE_KS, TERRAIN_STROKE_WRAP, terrainStrokeAA, terrainStrokeValue,
} from '../../src/render/terrain/terrainShading.ts';
import { TERRAIN_CORE_ATTRS } from '../../src/render/terrain/terrainView.ts';
import { premultiplyRgba } from '../../src/render/util/texture.ts';
import { QUALITY_PRESETS } from '../../src/settings/quality.ts';
import { vnoise } from '../../tools/preview/world/glslNoise.ts';
import { layerStrokeStats, mip1Atlas } from '../../tools/preview/world/strokeStats.ts';
import { levelFromAscii } from '../shared/fixtures.ts';

const OPTS: StrokeOptions = { width: 4, stretch: STROKE.stretch, amount: STROKE.amount, rim: STROKE.rim, dry: STROKE.dry, gain: 1 };
const manifest = parseManifest(JSON.parse(readFileSync(new URL('../../public/layers/forest.manifest.json', import.meta.url), 'utf8')));

/**
 * The fewest screen pixels per layer unit, derived here from the presets on their own: each preset at
 * its dynamic-resolution floor on 21:9 canvases (the widest the game letterboxes to) from 360 to 4320
 * rows, wherever the preset's pixel budget sets the render scale (smaller canvases are smaller windows
 * than the preset is sized for).
 */
function worstPxPerUnit(): number {
  let min = Infinity;
  for (const q of Object.values(QUALITY_PRESETS)) {
    for (let h = 360; h <= 4320; h++) {
      const w = Math.floor(h * MAX_ASPECT);
      const cap = renderScaleCap(w, h, q.maxRenderPixels);
      if (cap >= q.renderScale) continue;
      min = Math.min(min, (h * cap * (q.minRenderScale / q.renderScale)) / VIEW_H);
    }
  }
  return min;
}
const PX_PER_UNIT_FLOOR = worstPxPerUnit();

function raster(w: number, h: number, draw: (r: ElementRaster) => void, noiseOffset = 3): { r: ElementRaster; px: Uint8Array } {
  const r = new ElementRaster(w, h, new NoiseTable(99), noiseOffset, null);
  r.configure({ strokes: OPTS });
  draw(r);
  const px = new Uint8Array(w * h * 4);
  r.finalize(px, w, 0, 0, { strokes: OPTS });
  return { r, px };
}

/** The specs with their stroke options patched. */
function withStrokes(specs: readonly ElementSpec[], patch: Partial<StrokeOptions>): ElementSpec[] {
  return specs.map((s) => ({ ...s, finalize: { ...s.finalize, strokes: s.finalize.strokes ? { ...s.finalize.strokes, ...patch } : null } }));
}

/** Circular distance of two stroke coordinates s (mod W). */
function sDist(a: number, b: number, W: number): number {
  const d = Math.abs((((a - b) % W) + W) % W);
  return Math.min(d, W - d);
}

describe('kit stroke frames (raster.ts)', () => {
  test('a curve paints one stroke: the along coordinate runs continuously over its segments', () => {
    const { r } = raster(220, 120, (q) => q.curve(20, 95, 110, 5, 200, 95, 9, 5, Mat.Bark, 0, 12));
    const c = new Float64Array(5);
    const d = new Float64Array(5);
    let pairs = 0;
    let maxJump = 0;
    let uMin = Infinity;
    let uMax = -Infinity;
    for (let y = 1; y < r.h; y++) {
      for (let x = 1; x < r.w; x++) {
        if (!r.strokeCoord(x, y, c)) continue;
        uMin = Math.min(uMin, c[0] as number);
        uMax = Math.max(uMax, c[0] as number);
        for (const [nx, ny] of [[x - 1, y], [x, y - 1]] as const) {
          if (!r.strokeCoord(nx, ny, d)) continue;
          pairs++;
          // A texel step moves (u, v) by at most √2 inside one frame; segment joints add a little.
          maxJump = Math.max(maxJump, Math.abs((c[0] as number) - (d[0] as number)), Math.abs((c[1] as number) - (d[1] as number)));
        }
      }
    }
    expect(pairs).toBeGreaterThan(1000);
    // (Segment joints of this tight arch add up to radius × bend per segment ≈ 9 × 0.26 texels.)
    expect(maxJump).toBeLessThan(3.5);
    // u follows the arc (≈ 245 texels) rather than x or y.
    expect(uMax - uMin).toBeGreaterThan(200);
  });

  test('a lobe paints around its centre: (r̄·φ, ρ·r̄), periodic, at the element\'s own stroke width, faded to its mean at the centre', () => {
    const { r } = raster(140, 120, (q) => {
      q.framePolar(70, 60, 40, 32);
      q.ellipse(70, 60, 40, 32, Mat.Leaf, 0);
      q.releaseFrame();
    });
    const c = new Float64Array(5);
    let wraps = 0;
    let prev = Number.NaN;
    let period = 0;
    for (let k = 0; k <= 360; k++) {
      const a = (k / 360) * Math.PI * 2;
      expect(r.strokeCoord(Math.round(70 + Math.cos(a) * 28), Math.round(60 + Math.sin(a) * 22), c)).toBe(true);
      period = c[3] as number;
      if (!Number.isNaN(prev)) {
        const du = (c[0] as number) - prev;
        if (du < -period / 2) wraps++;
        else expect(Math.abs(du)).toBeLessThan(period / 20);
      }
      prev = c[0] as number;
    }
    expect(period).toBeCloseTo(2 * Math.PI * 36, 6);
    expect(wraps).toBe(1);
    // No compression: v runs one texel per texel of radius (r̄ = 36 here), so strokes keep the width
    // they have everywhere else on the element instead of growing with the lobe.
    const v = (x: number): number => (r.strokeCoord(x, 60, c) ? (c[1] as number) : Number.NaN);
    const rho = (x: number): number => Math.hypot((x + 0.5 - 70) / 40, 0.5 / 32);
    expect(v(70 + 36) - v(70 + 16)).toBeCloseTo((rho(70 + 36) - rho(70 + 16)) * 36, 6);
    // The centre fades to the frame's mean (φ bunches up there): no eye.
    expect(r.strokeCoord(70, 60, c)).toBe(true);
    expect(c[2]).toBe(0);
    expect(POLAR_FADE_IN).toBeGreaterThan(0);
  });

  test('lobes take whole table periods around, at least 4 broad cells (dabs, not a light and a dark half)', () => {
    for (let period = 1; period < 3000; period *= 1.07) {
      for (const len of [15, 20, 42.5, 90]) {
        const n = cellsAround(period, len);
        expect(n % 4).toBe(0);
        expect(n).toBeGreaterThanOrEqual(4);
        if (n > 4) expect(Math.abs(period / len - n)).toBeLessThanOrEqual(2);
      }
    }
    // The polar brush value itself (not only u) repeats after one revolution.
    for (const r of [3, 11, 36, 150]) {
      const p = 2 * Math.PI * r;
      for (let u = -p; u < p; u += p / 97) {
        for (const v of [0.3, 7, 40.2]) expect(brushStroke(u + p, v, p, OPTS)).toBeCloseTo(brushStroke(u, v, p, OPTS), 9);
      }
    }
  });

  test('a lobe\'s baked brush is continuous across φ = ±π and varies around each ring (no concentric bands)', () => {
    let wrapMax = 0;
    let otherMax = 0;
    let wrapPairs = 0;
    let wrapSum = 0;
    let zeroSum = 0;
    let zeroPairs = 0;
    let ringVar = 0;
    let allVar = 0;
    for (const seed of [1, 3, 5, 7, 11, 13]) {
      const { r } = raster(140, 120, (q) => {
        q.framePolar(70, 60, 40, 32);
        q.ellipse(70, 60, 40, 32, Mat.Leaf, 0);
        q.releaseFrame();
      }, seed);
      const st = r.stroke;
      const rho = (x: number, y: number): number => Math.hypot((x + 0.5 - 70) / 40, (y + 0.5 - 60) / 32);
      // Vertical pairs (x, y)–(x, y + 1) away from the faded centre and the edge; y = 59 → 60 on the left
      // crosses φ = ±π.
      for (let y = 25; y < 95; y++) {
        for (let x = 25; x < 115; x++) {
          const i = y * r.w + x;
          const j = i + r.w;
          if (!((st.ba[i] as number) > 0 && (st.ba[j] as number) > 0)) continue;
          const q = Math.min(rho(x, y), rho(x, y + 1));
          if (q < POLAR_FADE_OUT || Math.max(rho(x, y), rho(x, y + 1)) > 0.9) continue;
          const d = Math.abs((st.bm[i] as number) - (st.bm[j] as number));
          if (y === 59 && x < 70) {
            wrapMax = Math.max(wrapMax, d);
            wrapSum += d;
            wrapPairs++;
          } else {
            otherMax = Math.max(otherMax, d);
            if (y === 59) {
              zeroSum += d;
              zeroPairs++;
            }
          }
        }
      }
      // Rings: the brush's variance around a ring at ρ ≈ 0.7 against its variance over the whole band.
      const ring: number[] = [];
      const band: number[] = [];
      for (let y = 0; y < r.h; y++) {
        for (let x = 0; x < r.w; x++) {
          const i = y * r.w + x;
          if (!((st.ba[i] as number) > 0)) continue;
          const q = rho(x, y);
          if (q > POLAR_FADE_OUT && q < 0.9) band.push(st.bm[i] as number);
          if (Math.abs(q - 0.7) < 0.02) ring.push(st.bm[i] as number);
        }
      }
      const variance = (a: number[]): number => {
        const m = a.reduce((s, x) => s + x, 0) / a.length;
        return a.reduce((s, x) => s + (x - m) * (x - m), 0) / a.length;
      };
      ringVar += variance(ring);
      allVar += variance(band);
    }
    expect(wrapPairs).toBeGreaterThan(40);
    // A seam would pair unrelated brush values (a mean jump of about 0.5, up to 2): the pairs across
    // φ = ±π look like the mirrored ones across φ = 0 and like any other pair.
    expect(wrapMax).toBeLessThanOrEqual(otherMax);
    expect(wrapSum / wrapPairs).toBeLessThan(2 * (zeroSum / zeroPairs) + 0.05);
    // Concentric bands would leave each ring near-constant (ring variance ≪ band variance).
    expect(ringVar / allVar).toBeGreaterThan(0.5);
  });

  test('where two lobes meet, the brush stays continuous (the runner-up fade), well below the unfaded jump', () => {
    const kernel = new BrushKernel(OPTS);
    const c = new Float64Array(5);
    for (const seed of [3, 1, 5, 11, 17]) {
      const { r } = raster(170, 120, (q) => {
        q.framePolar(60, 60, 34, 28);
        q.ellipse(60, 60, 34, 28, Mat.Leaf, 2.5);
        q.releaseFrame();
        q.framePolar(102, 62, 30, 26);
        q.ellipse(102, 62, 30, 26, Mat.Leaf, 2.5);
        q.releaseFrame();
      }, seed);
      const st = r.stroke;
      const group = r.frames.group;
      // The owner-only brush value (no runner-up fade): what a seam would look like. Away from the fade
      // it reproduces the bake's brush up to its centring (paintLum subtracts the stroke mean).
      const own = new Float64Array(r.w * r.h);
      let offset = Number.NaN;
      let spread = 0;
      for (let i = 0; i < own.length; i++) {
        if (!((st.ba[i] as number) > 0)) continue;
        const x = i % r.w;
        const y = (i - x) / r.w;
        r.strokeCoord(x, y, c);
        const b = kernel.body((c[3] as number) > 0, c[0] as number, c[1] as number, kernel.along(c[3] as number));
        own[i] = (c[4] as number) + (b - (c[4] as number)) * (c[2] as number);
        if ((st.run[i * 2 + 1] as number) - (st.own[i * 2 + 1] as number) >= STROKE_SEAM) {
          const k = own[i] - (st.bm[i] as number);
          if (Number.isNaN(offset)) offset = k;
          else spread = Math.max(spread, Math.abs(k - offset));
        }
      }
      expect(spread, `seed ${seed}`).toBeLessThan(1e-4);
      let across = 0;
      let faded = 0;
      let maxFaded = 0;
      let maxOwn = 0;
      let maxWithin = 0;
      let sumFaded = 0;
      let sumOwn = 0;
      for (let y = 1; y < r.h; y++) {
        for (let x = 1; x < r.w; x++) {
          const i = y * r.w + x;
          if (!((st.ba[i] as number) > 0)) continue;
          if ((st.run[i * 2 + 1] as number) - (st.own[i * 2 + 1] as number) < STROKE_SEAM) faded++;
          for (const j of [i - 1, i - r.w]) {
            if (!((st.ba[j] as number) > 0)) continue;
            const df = Math.abs((st.bm[i] as number) - (st.bm[j] as number));
            if (group[st.own[i * 2] as number] === group[st.own[j * 2] as number]) {
              maxWithin = Math.max(maxWithin, df);
              continue;
            }
            const dOwn = Math.abs((own[i] as number) - (own[j] as number));
            across++;
            maxFaded = Math.max(maxFaded, df);
            maxOwn = Math.max(maxOwn, dOwn);
            sumFaded += df;
            sumOwn += dOwn;
          }
        }
      }
      expect(across, `seed ${seed}`).toBeGreaterThan(20);
      expect(faded, `seed ${seed}`).toBeGreaterThan(across);
      // The boundary changes no faster than the brush inside a form does, and well below the jumps
      // the two frames make without the fade (measured: max 0.18–0.37 of them, mean 0.12–0.31).
      expect(maxFaded, `seed ${seed}`).toBeLessThanOrEqual(maxWithin);
      expect(maxFaded, `seed ${seed}`).toBeLessThan(maxOwn * 0.5);
      expect(sumFaded, `seed ${seed}`).toBeLessThan(sumOwn * 0.45);
    }
  });

  test('the brush: elongated along u, zero-mean, periodic tables', () => {
    for (const t of [LINE_BODY, POLAR_BODY]) {
      let sum = 0;
      let seam = 0;
      let inner = 0;
      for (let y = 0; y < BRUSH_SIZE; y++) {
        for (let x = 0; x < BRUSH_SIZE; x++) {
          const v = t[y * BRUSH_SIZE + x] as number;
          expect(Math.abs(v)).toBeLessThan(1);
          sum += v;
        }
        // Wrap-around is as smooth as any other step.
        seam = Math.max(seam, Math.abs((t[y * BRUSH_SIZE] as number) - (t[y * BRUSH_SIZE + BRUSH_SIZE - 1] as number)));
        for (let x = 1; x < BRUSH_SIZE; x++) inner = Math.max(inner, Math.abs((t[y * BRUSH_SIZE + x] as number) - (t[y * BRUSH_SIZE + x - 1] as number)));
      }
      expect(Math.abs(sum / (BRUSH_SIZE * BRUSH_SIZE))).toBeLessThan(0.1);
      expect(seam).toBeLessThanOrEqual(inner + 1e-6);
    }
    // Mean |gradient| along the stroke is a fraction of the one across it (stretch 4–6 : 1).
    const k = new BrushKernel(OPTS);
    const ka = k.along(0);
    let gu = 0;
    let gv = 0;
    for (let v = 0; v < 400; v += 1.3) {
      for (let u = 0; u < 400; u += 1.7) {
        const b = k.body(false, u, v, ka);
        gu += Math.abs(k.body(false, u + 0.5, v, ka) - b);
        gv += Math.abs(k.body(false, u, v + 0.5, ka) - b);
      }
    }
    expect(gu * 3).toBeLessThan(gv);
  });

  test('dry brush: the edge displacement stays within the existing edge-noise budget', () => {
    const noise = new NoiseTable(1234);
    let peak = 0;
    for (let y = 0; y < 256; y += 0.37) for (let x = 0; x < 256; x += 0.41) peak = Math.max(peak, Math.abs(noise.sample(x, y)));
    // finalize: d += (n1·(0.75 − 0.35·dry) + n2·0.25·(1 − dry) + brush·DRY_SCALE·0.6·dry)·disp, with |brush| < 1.
    for (const dry of [0, 0.5, 1]) {
      const bound = peak * (0.75 - 0.35 * dry) + peak * 0.25 * (1 - dry) + DRY_SCALE * 0.6 * dry;
      expect(bound).toBeLessThanOrEqual(EDGE_NOISE_MAX);
      // …and never more than the plain edge noise could displace (n1·0.75 + n2·0.25).
      expect(bound).toBeLessThanOrEqual(peak + 1e-9);
    }
  });
});

describe('stroke widths at the minimum render scale', () => {
  test('the pixel floor comes from the quality presets (Low on a 21:9 canvas: 0.39 px/u)', () => {
    expect(MIN_PX_PER_UNIT).toBeCloseTo(PX_PER_UNIT_FLOOR, 3);
    expect(PX_PER_UNIT_FLOOR).toBeGreaterThan(0.3);
    expect(PX_PER_UNIT_FLOOR).toBeLessThan(0.4);
  });

  test('every element\'s strokes are ≥ 3 texels and ≥ 2 px for its smallest placed instance', () => {
    for (const s of ELEMENT_SPECS) {
      const o = s.finalize.strokes;
      expect(o, s.category).toBeTruthy();
      if (!o) continue;
      expect(o.width).toBeGreaterThanOrEqual(STROKE.minTexels);
      expect(o.width * s.unitsPerTexel * MIN_INSTANCE_SCALE[s.category] * PX_PER_UNIT_FLOOR, s.key ?? s.category)
        .toBeGreaterThanOrEqual(STROKE.minPixels - 1e-6);
      expect(o.width).toBeCloseTo(strokeWidthTexels(o.width * s.unitsPerTexel, s.unitsPerTexel, MIN_INSTANCE_SCALE[s.category], MIN_PX_PER_UNIT), 9);
      expect(o.stretch).toBeGreaterThanOrEqual(4);
      expect(o.stretch).toBeLessThanOrEqual(6);
      expect(o.gain).toBe(STROKE_GAIN[s.category]);
    }
  });

  test('the minimum instance scales are not optimistic: no recipe places a category smaller', () => {
    for (const def of manifest.layers) {
      if (def.kind !== 'kit') continue;
      const recipe = RECIPES[def.recipe];
      expect(recipe).toBeTruthy();
      for (const s of recipe?.streams ?? []) {
        for (const it of s.items) {
          expect(MIN_INSTANCE_SCALE[it.category], `${def.id} ${it.category}`).toBeLessThanOrEqual(def.scale[0] * (it.scale?.[0] ?? 1) + 1e-6);
        }
        // An attached crown takes its host's scale (placement.ts attachCrown): the smallest item's.
        if (s.attach) {
          const host = Math.min(...s.items.map((it) => def.scale[0] * (it.scale?.[0] ?? 1)));
          expect(MIN_INSTANCE_SCALE[s.attach.category], `${def.id} ${s.attach.category}`).toBeLessThanOrEqual(host + 1e-6);
        }
      }
    }
  });

  test('…nor any decor placeDecor places (every tile kind and hint, many seeds)', () => {
    const fake = (category: KitCategory, variant: number): KitElement => ({
      index: 0, category, variant, x: 0, y: 0, w: 120, h: 80, unitsPerTexel: 1, anchorX: 60, anchorY: 80, sway: 'none', swayScale: 0,
      emissive: false, cut: 'none', stretchFrom: 0, columnX: 60, core: [], soft: [], coreArea: 0, softArea: 0,
    });
    const byCategory = {} as Record<KitCategory, KitElement[]>;
    for (const c of KIT_CATEGORIES) byCategory[c] = [fake(c, 0), fake(c, 1)];
    // Ceilings with hanging thorns, one-way runs, platforms (floors and ceilings), floor thorns, ground.
    const N = 64;
    const row = (spans: readonly (readonly [number, number, string])[]): string => {
      const r: string[] = Array.from({ length: N }, (_, i) => (i === 0 || i === N - 1 ? '#' : '.'));
      for (const [a, b, ch] of spans) for (let i = a; i < b; i++) r[i] = ch;
      return r.join('');
    };
    const rows = [
      row([[0, N, '#']]),
      row([[1, 22, '^']]),
      row([]),
      row([[8, 17, '='], [29, 39, '='], [48, 55, '=']]),
      row([]),
      row([[6, 23, '#'], [34, 52, '#']]),
      row([]),
      row([[10, 30, '^']]),
      row([[0, N, '#']]),
      row([[0, N, '#']]),
    ];
    const placed = new Map<KitCategory, number>();
    for (let seed = 1; seed <= 40; seed++) {
      const level: LevelData = levelFromAscii(rows, { seed });
      for (let k = 0; k < 24; k++) level.decorHints.push({ id: k, kind: k % 2 === 0 ? 'flora' : 'lantern', x: 100 + k * 110, y: 8 * level.tileSize });
      const p = placeDecor(level, { byCategory });
      for (const inst of [...p.back, ...p.front]) {
        const c = inst.el.category;
        // Bridge logs stretch along their strokes only: across them the scale is |sy|.
        const s = c === 'bridge' ? Math.abs(inst.sy) : Math.min(Math.abs(inst.sx), Math.abs(inst.sy));
        placed.set(c, Math.min(placed.get(c) ?? Infinity, s));
      }
    }
    const inRecipes = new Set<KitCategory>();
    for (const r of Object.values(RECIPES)) for (const s of r.streams) for (const it of s.items) inRecipes.add(it.category);
    expect(placed.size).toBeGreaterThanOrEqual(8);
    for (const [c, m] of placed) {
      expect(MIN_INSTANCE_SCALE[c], c).toBeLessThanOrEqual(m + 1e-9);
      // …and read from placeDecor's ranges rather than guessed low (the sampled minimum is within 0.02).
      if (!inRecipes.has(c)) expect(m - MIN_INSTANCE_SCALE[c], c).toBeLessThan(0.02);
    }
  });
});

describe('painted kit atlas', () => {
  const SUBSET = ELEMENT_SPECS.filter((s) => ['farBroad', 'rock', 'fern', 'grass', 'mushrooms'].includes(s.key ?? s.category));
  const seed = kitSeed('forest-kit');
  let kits: { painted: KitAtlasData; plain: KitAtlasData; ms: number } | null = null;
  const forestKits = (): { painted: KitAtlasData; plain: KitAtlasData; ms: number } => {
    if (!kits) {
      const t0 = performance.now();
      const painted = generateKit(seed);
      const ms = performance.now() - t0;
      const plain = generateKit(seed, undefined, undefined, ELEMENT_SPECS.map((s) => ({ ...s, finalize: { ...s.finalize, strokes: null } })));
      kits = { painted, plain, ms };
    }
    return kits;
  };

  test('deterministic in any build order, and different from the plain atlas', () => {
    const a = generateKit(321, 1024, 1024, SUBSET);
    const b = generateKit(321, 1024, 1024, SUBSET);
    expect(Buffer.from(a.pixels).equals(Buffer.from(b.pixels))).toBe(true);
    const listed = generateKit(321, 1024, 1024, SUBSET, 'listed');
    expect(Buffer.from(listed.pixels).equals(Buffer.from(a.pixels))).toBe(true);
    const plain = generateKit(321, 1024, 1024, SUBSET.map((s) => ({ ...s, finalize: { ...s.finalize, strokes: null } })));
    expect(Buffer.from(a.pixels).equals(Buffer.from(plain.pixels))).toBe(false);
  });

  test('the rim mask breaks up, but every mip-1 texel of the uploaded (premultiplied) atlas keeps its value within 1 code', () => {
    const on = forestKits().painted;
    const off = generateKit(seed, undefined, undefined, withStrokes(ELEMENT_SPECS, { rim: 0 }));
    const W = on.width;
    const pOn = on.pixels.slice();
    const pOff = off.pixels.slice();
    premultiplyRgba(pOn);
    premultiplyRgba(pOff);
    let blocks = 0;
    let changed = 0;
    let worst = 0;
    let worstRounded = 0;
    for (let by = 0; by < on.height; by += 2) {
      for (let bx = 0; bx < W; bx += 2) {
        let q0 = 0;
        let q1 = 0;
        let diff = false;
        for (let j = 0; j < 2; j++) {
          for (let q = 0; q < 2; q++) {
            const o = ((by + j) * W + bx + q) * 4;
            if (on.pixels[o + 3] !== off.pixels[o + 3]) throw new Error('the rim pass changed coverage');
            q0 += pOff[o + 1] as number;
            q1 += pOn[o + 1] as number;
            if (on.pixels[o + 1] !== off.pixels[o + 1]) diff = true;
          }
        }
        if (q0 === 0 && q1 === 0) continue;
        blocks++;
        if (diff) changed++;
        // The GPU's mip 1 is the 2×2 average of the premultiplied bytes (rounded either way).
        worst = Math.max(worst, Math.abs(q1 - q0) / 4);
        worstRounded = Math.max(worstRounded, Math.abs(Math.round(q1 / 4) - Math.round(q0 / 4)));
      }
    }
    expect(blocks).toBeGreaterThan(5000);
    expect(changed / blocks).toBeGreaterThan(0.2);
    expect(worst).toBeLessThan(1);
    expect(worstRounded).toBeLessThanOrEqual(1);
  });

  test('visibility: strokes move the final luma of L3–L8 (L4–L8 at their stroke gain) while every layer keeps its mean (±1 code)', () => {
    const { painted, plain, ms } = forestKits();
    const stats = layerStrokeStats(manifest, plain, painted);
    console.info(`[strokes] painted forest kit baked in ${ms.toFixed(0)} ms (cold in this worker)`);
    expect(stats.length).toBe(10);
    for (const s of stats) {
      expect(Math.abs(s.meanAfter - s.meanBefore), s.id).toBeLessThanOrEqual(1);
      expect(Math.abs(s.coverage), s.id).toBeLessThan(0.01);
      // Stroke bodies (the upper half of the |Δ| distribution) clear 3 codes; ±10–15 % of R would not.
      // The mid and near planes read at 1:1: their stroke gain scales that.
      const g = /^L[4-8]-/.test(s.id) ? STROKE_NEAR_GAIN : 1;
      if (/^L[3-8]-/.test(s.id)) {
        expect(s.p75, s.id).toBeGreaterThanOrEqual(3 * g);
        expect(s.p90, s.id).toBeGreaterThanOrEqual(3.5 * g);
      }
    }
  });

  test('visibility at mip 1: the far layers keep their strokes where the GPU minifies (low render scale)', () => {
    const { painted, plain } = forestKits();
    const mip0 = layerStrokeStats(manifest, plain, painted);
    const mip1 = layerStrokeStats(manifest, mip1Atlas(plain), mip1Atlas(painted));
    for (let i = 0; i < mip1.length; i++) {
      const s = mip1[i];
      const s0 = mip0[i];
      if (!s || !s0) continue;
      expect(Math.abs(s.meanAfter - s.meanBefore), s.id).toBeLessThanOrEqual(1);
      if (/^L[1-3]-/.test(s.id)) {
        // Strokes ≥ 3 texels wide survive a 2×2 average (speckle would not).
        expect(s.p75, s.id).toBeGreaterThanOrEqual(3);
        expect(s.p75 / s0.p75, s.id).toBeGreaterThan(0.85);
      }
    }
  });
});

describe('stroke gain', () => {
  test('one gain per layer: the mid and near planes (L4–L8) at STROKE_NEAR_GAIN, the others at 1', () => {
    let near = 0;
    for (const def of manifest.layers) {
      if (def.kind !== 'kit') continue;
      const recipe = RECIPES[def.recipe] as Recipe;
      const g = recipeStrokeGain(recipe);
      expect(g, def.id).toBe(/^L[4-8]-/.test(def.id) ? STROKE_NEAR_GAIN : 1);
      if (g > 1) near++;
    }
    expect(near).toBe(5);
    expect(STROKE_NEAR_GAIN).toBeGreaterThan(1);
    const mid = RECIPES.midForest as Recipe;
    const mixed: Recipe = { ...mid, streams: [...mid.streams, { items: [{ category: 'farTree', weight: 1 }], density: 1, from: 'baseline', y: [0, 0] }] };
    expect(() => recipeStrokeGain(mixed)).toThrow(/stroke gain/);
    // The kit shader and the reference shading apply it the same way.
    expect(KIT_FRAGMENT).toContain('float k = (1.0 + uStrokeGain * (ch.r - 0.5)) * (0.8 + 0.4 * vTint.a);');
  });

  test('the bake stores an element\'s own detail divided by its gain; the shading multiplies it back (within rounding)', () => {
    const specs = ELEMENT_SPECS.filter((s) => ['midCrown', 'rock'].includes(s.key ?? s.category));
    const bake = (gain: number): KitAtlasData => generateKit(77, 1024, 1024, withStrokes(specs, { amount: 0, gain }));
    const a = bake(1);
    const b = bake(STROKE_NEAR_GAIN);
    let n = 0;
    let worst = 0;
    let coverage = 0;
    for (let o = 0; o < a.pixels.length; o += 4) {
      if (b.pixels[o + 3] !== a.pixels[o + 3]) coverage++;
      if (a.pixels[o + 3] === 0) continue;
      const back = 127.5 + STROKE_NEAR_GAIN * ((b.pixels[o] as number) - 127.5);
      worst = Math.max(worst, Math.abs(Math.min(255, Math.max(0, back)) - (a.pixels[o] as number)));
      n++;
    }
    expect(coverage).toBe(0);
    expect(n).toBeGreaterThan(10000);
    // Two roundings: ½ code of the plain byte, and ½ code × the gain of the divided one.
    expect(worst).toBeLessThanOrEqual(0.5 + 0.5 * STROKE_NEAR_GAIN + 1e-9);
  });
});

describe('terrain strokes', () => {
  const ISLAND = [
    '................................',
    '................................',
    '....######..............####....',
    '....######..............####....',
    '....######.......#......####....',
    '..........########..............',
    '..........########..............',
    '..........###..###......######..',
    '..........###..###......######..',
    '................................',
    '................................',
  ];
  // A one-tile ledge (its medial axis inside the stroke band), a lone tile (a short outline) and a
  // 4×4 block (convex corners whose mitres run through the band).
  const LEDGES = [
    '..............................',
    '..............................',
    '...##############.............',
    '..............................',
    '..............................',
    '...............#..............',
    '..............................',
    '.....####.....................',
    '.....####.....................',
    '.....####.....................',
    '.....####.....................',
    '..............................',
    '..............................',
  ];
  /** Deterministic scattered-tile levels (stress: thin necks, diagonal contacts, tiny islands). */
  const scattered = (seed: number, density: number): string[] => {
    let s = seed >>> 0;
    const next = (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296;
    const rows: string[] = [];
    for (let y = 0; y < 20; y++) {
      let r = '';
      for (let x = 0; x < 40; x++) r += y > 0 && y < 19 && x > 0 && x < 39 && next() < density ? '#' : '.';
      rows.push(r);
    }
    return rows;
  };
  const mesh = buildTerrainMesh(levelFromAscii(ISLAND));
  const ledges = buildTerrainMesh(levelFromAscii(LEDGES));
  const W = TERRAIN_STROKE_WRAP;
  const C = DEFAULT_TERRAIN.cell;
  const spillBits = (a: Float32Array, o: number): number => new Uint32Array(a.buffer, a.byteOffset + o * 4, 1)[0] as number;
  const coreCont = (v: Float32Array, o: number): number => (spillBits(v, o + 4) >>> 24) / TERRAIN_STROKE_CONT_MAX;
  const perimeter = (pts: Float32Array): number => {
    const n = pts.length / 2;
    let p = 0;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      p += Math.hypot((pts[k1 * 2] as number) - (pts[k * 2] as number), (pts[k1 * 2 + 1] as number) - (pts[k * 2 + 1] as number));
    }
    return p;
  };
  /** Contour start point: the lowest (max y), leftmost on ties — as buildTerrainMesh picks it. */
  const startPoint = (pts: Float32Array): number => {
    let k0 = 0;
    for (let k = 1; k < pts.length / 2; k++) {
      const y = pts[k * 2 + 1] as number;
      const y0 = pts[k0 * 2 + 1] as number;
      if (y > y0 || (y === y0 && (pts[k * 2] as number) < (pts[k0 * 2] as number))) k0 = k;
    }
    return k0;
  };
  /** Contour point (x, y) → [contour, index], for the edge strips (their vertices sit on the points). */
  const pointIndex = (m: TerrainMesh): Map<string, [number, number]> => {
    const map = new Map<string, [number, number]>();
    m.contours.forEach((c, ci) => {
      for (let k = 0; k < c.points.length / 2; k++) map.set(`${c.points[k * 2]},${c.points[k * 2 + 1]}`, [ci, k]);
    });
    return map;
  };

  test('core vertices carry the stroke coordinate: stride 7, aStroke at float 5', () => {
    expect(CORE_STRIDE_FLOATS).toBe(7);
    const a = TERRAIN_CORE_ATTRS.find((x) => x.name === 'aStroke');
    expect(a).toEqual({ name: 'aStroke', format: 'float32x2', offset: CORE_STROKE_OFFSET * 4 });
    for (const c of mesh.chunks) expect(c.core.length % CORE_STRIDE_FLOATS).toBe(0);
  });

  test('s is the arc length from each contour\'s lowest point, scaled so long contours close on whole wraps', () => {
    let long = 0;
    for (const m of [mesh, ledges]) {
      expect(m.contours.length).toBeGreaterThan(1);
      for (const c of m.contours) {
        const n = c.points.length / 2;
        const k0 = startPoint(c.points);
        expect(c.arc[k0]).toBe(0);
        const P = perimeter(c.points);
        if (P >= W / 2) {
          long++;
          expect(c.arcScale).toBeCloseTo((Math.round(P / W) * W) / P, 12);
          expect(c.arcScale).toBeLessThanOrEqual(2);
          // The closure lands on a multiple of the wrap: s is seamless at the start point.
          const turns = (P * c.arcScale) / W;
          expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-9);
        } else {
          expect(c.arcScale).toBe(1);
        }
        for (let k = 0; k < n; k++) {
          const k1 = (k + 1) % n;
          if (k1 === k0) continue;
          const len = Math.hypot((c.points[k1 * 2] as number) - (c.points[k * 2] as number), (c.points[k1 * 2 + 1] as number) - (c.points[k * 2 + 1] as number));
          expect((c.arc[k1] as number) - (c.arc[k] as number)).toBeCloseTo(len * c.arcScale, 6);
        }
      }
      // Edge strips: each quad's s runs from the arc length (wrapped) by the segment's scaled length.
      const at = pointIndex(m);
      let quads = 0;
      for (const ch of m.chunks) {
        const e = ch.edge;
        for (let q = 0; q < e.length / EDGE_STRIDE_FLOATS; q += 4) {
          const o0 = q * EDGE_STRIDE_FLOATS;
          const o2 = (q + 2) * EDGE_STRIDE_FLOATS;
          const hit = at.get(`${e[o0]},${e[o0 + 1]}`);
          expect(hit).toBeDefined();
          const c = m.contours[(hit as [number, number])[0]] as TerrainMesh['contours'][number];
          const len = Math.hypot((e[o2] as number) - (e[o0] as number), (e[o2 + 1] as number) - (e[o0 + 1] as number));
          const s0 = e[o0 + 7] as number;
          expect(s0).toBeGreaterThanOrEqual(0);
          expect(s0).toBeLessThan(W);
          expect((e[o2 + 7] as number) - s0).toBeCloseTo(len * c.arcScale, 3);
          quads++;
        }
      }
      expect(quads).toBeGreaterThan(50);
    }
    expect(long).toBeGreaterThanOrEqual(4);
  });

  test('inside the rim zone, s and d come from the nearest contour point', () => {
    let checked = 0;
    let ties = 0;
    let mismatches = 0;
    const cands: number[] = [];
    for (const m of [mesh, ledges]) {
      for (const ch of m.chunks) {
        const v = ch.core;
        for (let o = 0; o < v.length; o += CORE_STRIDE_FLOATS) {
          const depth = v[o + 2] as number;
          if (depth <= 0 || depth > TERRAIN_STROKE_DEPTH) continue;
          const x = v[o] as number;
          const y = v[o + 1] as number;
          // Every contour point within 1e-3 of the nearest distance (equidistant points may pick either).
          let best = Infinity;
          cands.length = 0;
          for (const c of m.contours) {
            const n = c.points.length / 2;
            for (let k = 0; k < n; k++) {
              const k1 = (k + 1) % n;
              const ax = c.points[k * 2] as number;
              const ay = c.points[k * 2 + 1] as number;
              const dx = (c.points[k1 * 2] as number) - ax;
              const dy = (c.points[k1 * 2 + 1] as number) - ay;
              const l2 = dx * dx + dy * dy;
              const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (l2 || 1)));
              const d = Math.hypot(x - ax - dx * t, y - ay - dy * t);
              if (d > best + 1e-3) continue;
              if (d < best - 1e-3) cands.length = 0;
              if (d < best) best = d;
              cands.push(d, ((c.arc[k] as number) + t * Math.sqrt(l2) * c.arcScale) % W);
            }
          }
          expect(v[o + CORE_STROKE_OFFSET + 1]).toBeCloseTo(best, 2);
          const s = (v[o + CORE_STROKE_OFFSET] as number) % W;
          let match = false;
          let tie = false;
          for (let q = 0; q < cands.length; q += 2) {
            if ((cands[q] as number) > best + 1e-3) continue;
            if (sDist(s, cands[q + 1] as number, W) < 0.05) match = true;
            else tie = true;
          }
          if (!match) mismatches++;
          else if (tie) ties++;
          else checked++;
        }
      }
    }
    expect(mismatches).toBe(0);
    expect(checked).toBeGreaterThan(1000);
    // (True ties: corners on the diagonal of a convex corner, equidistant from both faces.)
    expect(ties).toBeLessThan(checked * 0.2);
  });

  test('continuity weights: 0 at a jump of s (4-neighbours and diagonals) or without s, 0.5 next to one, 1 elsewhere', () => {
    // Columns 0–5 and 6–11 take s from two sides of a thin mass; one corner is out of the band.
    const nx = 12;
    const ny = 5;
    const s = new Float32Array(nx * ny);
    const d = new Float32Array(nx * ny).fill(5);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) s[j * nx + i] = i < 6 ? 100 + i * C : 700 + i * C;
    d[(ny - 1) * nx + 11] = -1;
    const out = new Float32Array(nx * ny);
    strokeContinuity(s, d, nx, ny, C, out);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const w = out[j * nx + i] as number;
        // (Out-of-band corners have no s: 0, without marking their neighbours.)
        if (j === ny - 1 && i === 11) expect(w).toBe(0);
        else if (i === 5 || i === 6) expect(w, `${i},${j}`).toBe(0);
        else if (i === 4 || i === 7) expect(w, `${i},${j}`).toBe(0.5);
        else expect(w, `${i},${j}`).toBe(1);
      }
    }
    // s runs on across the wrap (…, 1012, 6, 24, …): continuous.
    const sw = new Float32Array(6 * 3);
    for (let j = 0; j < 3; j++) for (let i = 0; i < 6; i++) sw[j * 6 + i] = (W - 30 + i * 18) % W;
    const ow = new Float32Array(6 * 3);
    strokeContinuity(sw, new Float32Array(6 * 3).fill(5), 6, 3, C, ow);
    for (const w of ow) expect(w).toBe(1);
  });

  test('continuity on the mesh: the thin ledge\'s medial axis and the block\'s mitres fade, the outline keeps full strokes', () => {
    const T = 48;
    let axis = 0;
    let mitre = 0;
    let face = 0;
    for (const ch of ledges.chunks) {
      const v = ch.core;
      for (let o = 0; o < v.length; o += CORE_STRIDE_FLOATS) {
        const x = v[o] as number;
        const y = v[o + 1] as number;
        const w = coreCont(v, o);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
        // Ledge (tiles 3–16 on row 2): corners at y = 114 and 126 sit either side of its medial axis.
        if (x > 6 * T && x < 13 * T && (y === 114 || y === 126)) {
          expect(w, `${x},${y}`).toBe(0);
          axis++;
        }
        // Block (tiles 5–8 × 7–10): its top-left corner's mitre at 30–54 u deep.
        const a = (x - 246) / C;
        if (y - 342 === x - 246 && a >= 2 && a <= 4) {
          expect(w, `${x},${y}`).toBe(0);
          mitre++;
        }
        // …while the middle of its top face keeps full strokes down to 30 u.
        if (x === 330 && y >= 342 && y <= 366) {
          expect(w, `${x},${y}`).toBe(1);
          face++;
        }
        // Crossings on the long outlines carry weight 1.
        if ((v[o + 2] as number) === 0 && Math.abs(x - 10 * T) < 3 * T && Math.abs(y - 2 * T) < 2) expect(w).toBe(1);
      }
    }
    expect(axis).toBeGreaterThan(20);
    expect(mitre).toBe(3);
    expect(face).toBe(3);
  });

  test('a short outline (P < W/2) keeps its length and fades its strokes out at its start point', () => {
    const at = pointIndex(ledges);
    let short = 0;
    for (const [ci, c] of ledges.contours.entries()) {
      if (perimeter(c.points) >= W / 2) continue;
      short++;
      const n = c.points.length / 2;
      const k0 = startPoint(c.points);
      const want = new Map([[k0, 0], [(k0 + 1) % n, Math.round(0.5 * TERRAIN_STROKE_CONT_MAX)], [(k0 + n - 1) % n, Math.round(0.5 * TERRAIN_STROKE_CONT_MAX)]]);
      let seen = 0;
      for (const ch of ledges.chunks) {
        const e = ch.edge;
        for (let o = 0; o < e.length; o += EDGE_STRIDE_FLOATS) {
          const hit = at.get(`${e[o]},${e[o + 1]}`);
          if (!hit || hit[0] !== ci) continue;
          const byte = spillBits(e, o + 8) >>> 24;
          expect(byte).toBe(want.get(hit[1]) ?? TERRAIN_STROKE_CONT_MAX);
          seen++;
        }
      }
      expect(seen).toBeGreaterThan(n);
    }
    expect(short).toBeGreaterThanOrEqual(1);
  });

  test('no visible triangle spans more than half a wrap in s; full-weight ones hold no jump; spill stays finite', () => {
    const levels = [ISLAND, LEDGES, scattered(1, 0.3), scattered(2, 0.37), scattered(3, 0.44), scattered(4, 0.51)];
    let visible = 0;
    let wide = 0;
    let jumps = 0;
    let badSpill = 0;
    for (const rows of levels) {
      const m = rows === ISLAND ? mesh : rows === LEDGES ? ledges : buildTerrainMesh(levelFromAscii(rows));
      for (const ch of m.chunks) {
        const v = ch.core;
        for (let o = 0; o < v.length; o += CORE_STRIDE_FLOATS) {
          if (!Number.isFinite(v[o + 4] as number) || spillBits(v, o + 4) >>> 24 > TERRAIN_STROKE_CONT_MAX) badSpill++;
        }
        for (let o = 0; o < ch.edge.length; o += EDGE_STRIDE_FLOATS) {
          if (!Number.isFinite(ch.edge[o + 8] as number) || spillBits(ch.edge, o + 8) >>> 24 > TERRAIN_STROKE_CONT_MAX) badSpill++;
        }
        const idx = ch.coreIndices;
        for (let t = 0; t < idx.length; t += 3) {
          const a = (idx[t] as number) * CORE_STRIDE_FLOATS;
          const b = (idx[t + 1] as number) * CORE_STRIDE_FLOATS;
          const c = (idx[t + 2] as number) * CORE_STRIDE_FLOATS;
          if ((v[a + 2] as number) > TERRAIN_STROKE_DEPTH || (v[b + 2] as number) > TERRAIN_STROKE_DEPTH || (v[c + 2] as number) > TERRAIN_STROKE_DEPTH) continue;
          const sa = v[a + CORE_STROKE_OFFSET] as number;
          const sb = v[b + CORE_STROKE_OFFSET] as number;
          const sc = v[c + CORE_STROKE_OFFSET] as number;
          const span = Math.max(sa, sb, sc) - Math.min(sa, sb, sc);
          const wMax = Math.max(coreCont(v, a), coreCont(v, b), coreCont(v, c));
          const wMin = Math.min(coreCont(v, a), coreCont(v, b), coreCont(v, c));
          if (wMax > 0) {
            visible++;
            if (span > W / 2) wide++;
          }
          if (wMin === 1 && span > 2 * STROKE_JUMP * C) jumps++;
        }
      }
    }
    expect(visible).toBeGreaterThan(5000);
    expect(wide).toBe(0);
    expect(jumps).toBe(0);
    expect(badSpill).toBe(0);
  });

  test('the shaders declare the stroke attribute, the continuity weight, the portable periodic noise and the fwidth clamp', () => {
    expect(TERRAIN_CORE_VERTEX).toContain('in vec2 aStroke;');
    expect(TERRAIN_CORE_VERTEX).toMatch(/vStroke = vec3\(aStroke \* .*, min\(1\.0, aSpill\.w \* [0-9.]+\)\);/);
    expect(TERRAIN_EDGE_VERTEX).toContain('aEdge.w');
    expect(TERRAIN_EDGE_VERTEX).toMatch(/min\(1\.0, aSpill\.w \* [0-9.]+\)/);
    expect(TERRAIN_CORE_FRAGMENT).toContain('float strokeAA = terrainStrokeAA(vStroke.xy) * vStroke.z;');
    expect(TERRAIN_EDGE_FRAGMENT).toContain('float strokeAA = terrainStrokeAA(stroke) * vStrokeS.y;');
    const N = `${TERRAIN_STROKE_CELLS}.0`;
    for (const src of [TERRAIN_CORE_FRAGMENT, TERRAIN_EDGE_FRAGMENT]) {
      expect(src).toContain('fwidth(');
      expect(src).toContain(`smoothstep(${TERRAIN_STROKE_CLAMP}, ${2 * TERRAIN_STROKE_CLAMP}, max(fwidth(c.x), fwidth(c.y)))`);
      expect(src).toContain('float terrainStroke(vec2 c)');
      expect(src).toContain(`float i0 = mod(i.x + 0.5, ${N}) - 0.5;`);
      expect(src).toContain(`float i1 = mod(i.x + 1.5, ${N}) - 0.5;`);
      expect(src).not.toContain(`mod(i.x, ${N})`);
      const g = Number.isInteger(TERRAIN_STROKE_GAIN) ? `${TERRAIN_STROKE_GAIN}.0` : `${TERRAIN_STROKE_GAIN}`;
      expect(src).toContain(`float sv = 0.5 + ${g} * (terrainStroke(stroke) - 0.5);`);
      // One more value-noise lookup than before: 9 in the core colour (≤ 10 per fragment).
      const start = src.indexOf('vec3 terrainColor(');
      const body = src.slice(start, src.indexOf('\n}\n', start));
      const lookups = (body.match(/sw_vnoise\(/g) ?? []).length + (body.match(/terrainStroke\(stroke\)/g) ?? []).length;
      expect(lookups).toBe(9);
    }
  });

  test('the lattice index is exact under any highp rounding of mod (mod(i + 0.5, N) − 0.5)', () => {
    const N = TERRAIN_STROKE_CELLS;
    // GLSL mod(x, y) = x − y·floor(x / y); a driver's x / y may come out an ulp or two either side.
    const gmod = (x: number, y: number, e: number): number => x - y * Math.floor((x / y) * (1 + e));
    let naive = 0;
    for (let i = -4 * N; i <= 4 * N; i++) {
      const want = ((i % N) + N) % N;
      for (const e of [-3e-7, 0, 3e-7]) {
        expect(gmod(i + 0.5, N, e) - 0.5).toBe(want);
        expect(gmod(i + 1.5, N, e) - 0.5).toBe((want + 1) % N);
        if (gmod(i, N, e) !== want) naive++;
      }
    }
    // (The plain mod(i, N) returns N on some exact multiples: a seam every wrap.)
    expect(naive).toBeGreaterThan(0);
    // The CPU mirror is periodic over the wrap, cell boundaries included.
    for (const d of [0, 7.5, 31]) {
      for (let k = 0; k <= N; k++) {
        const s = (k * W) / N;
        expect(terrainStrokeValue(s + W, d)).toBeCloseTo(terrainStrokeValue(s, d), 9);
        expect(Math.abs(terrainStrokeValue(s + 1e-4, d) - terrainStrokeValue(s - 1e-4, d))).toBeLessThan(1e-3);
      }
    }
  });

  test('every depth row of the stroke texture averages 0.5 over a wrap (no light or dark inner outline)', () => {
    const n = 2048;
    for (let d = 0; d <= TERRAIN_STROKE_DEPTH; d += 0.25) {
      let sum = 0;
      for (let k = 0; k < n; k++) sum += terrainStrokeValue(((k + 0.37) * W) / n, d);
      expect(Math.abs(sum / n - 0.5), `d ${d}`).toBeLessThanOrEqual(0.02);
    }
    // The lattice is antithetic along s: half a wrap on, the value mirrors about 0.5.
    for (const d of [0, 3.3, 17, 42.5]) {
      for (const s of [0, 1.5, 100, 511.9, 700]) expect(terrainStrokeValue(s + W / 2, d) + terrainStrokeValue(s, d)).toBeCloseTo(1, 6);
    }
  });

  test('stroke frequency: under the clamp at the minimum render scale (arc scale ≤ 2 included), faded out beyond it', () => {
    expect(Math.max(2 * TERRAIN_STROKE_KS, TERRAIN_STROKE_KD) / PX_PER_UNIT_FLOOR).toBeLessThan(TERRAIN_STROKE_CLAMP);
    expect(terrainStrokeAA(0)).toBe(1);
    expect(terrainStrokeAA(TERRAIN_STROKE_CLAMP)).toBe(1);
    expect(terrainStrokeAA(2 * TERRAIN_STROKE_CLAMP)).toBe(0);
    expect(terrainStrokeAA(0.35)).toBeGreaterThan(terrainStrokeAA(0.45));
  });

  test('strokes replace the fine strata near the surface only, with the same mean value', () => {
    const a = [0, 0, 0];
    const b = [0, 0, 0];
    const spill = [0, 0, 0];
    const luma = (c: number[]): number => 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
    // Deep inside: identical.
    shadeTerrainCore(a, TERRAIN_STROKE_DEPTH + 5, DEFAULT_TERRAIN.shadeDepth, 1234, 567, 0, spill, vnoise, { s: 100, d: 40, aa: 1 });
    shadeTerrainCore(b, TERRAIN_STROKE_DEPTH + 5, DEFAULT_TERRAIN.shadeDepth, 1234, 567, 0, spill, vnoise, null);
    expect(a).toEqual(b);
    // At the surface: the stroke pattern (mean 0.5, like the strata noise) keeps the zone's value.
    let sa = 0;
    let sb = 0;
    let diff = 0;
    let n = 0;
    for (let y = 0; y < 600; y += 7) {
      for (let x = 0; x < 3000; x += 11) {
        shadeTerrainCore(a, 6, DEFAULT_TERRAIN.shadeDepth, 3000 + x, 900 + y, 0, spill, vnoise, { s: x % W, d: 6 + (y % 40), aa: 1 });
        shadeTerrainCore(b, 6, DEFAULT_TERRAIN.shadeDepth, 3000 + x, 900 + y, 0, spill, vnoise, null);
        sa += luma(a);
        sb += luma(b);
        diff += Math.abs(luma(a) - luma(b));
        n++;
      }
    }
    expect(Math.abs(sa / sb - 1)).toBeLessThan(0.03);
    expect(diff / n).toBeGreaterThan(0.003);
    // A zero continuity weight (aa 0) leaves the plain strata.
    shadeTerrainCore(a, 6, DEFAULT_TERRAIN.shadeDepth, 3100, 950, 0, spill, vnoise, { s: 300, d: 6, aa: 0 });
    shadeTerrainCore(b, 6, DEFAULT_TERRAIN.shadeDepth, 3100, 950, 0, spill, vnoise, null);
    expect(a).toEqual(b);
  });
});
