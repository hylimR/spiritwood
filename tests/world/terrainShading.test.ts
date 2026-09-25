import { describe, expect, test } from 'vitest';
import { PALETTE } from '../../src/config.ts';
import { hexToRgb } from '../../src/core/color.ts';
import { TERRAIN_CORE_FRAGMENT, TERRAIN_EDGE_FRAGMENT } from '../../src/render/terrain/terrain.glsl.ts';
import { DEFAULT_TERRAIN } from '../../src/render/terrain/terrainMesh.ts';
import {
  shadeTerrainCore, type StoneSample, stoneAt, TERRAIN_CORE_COLOR, TERRAIN_DEEP_COLOR, TERRAIN_DEEP_REACH, TERRAIN_GLINT_DENSITY,
  TERRAIN_GLINT_MINERAL, TERRAIN_GLINT_MOSS, TERRAIN_STONE_CELL,
} from '../../src/render/terrain/terrainShading.ts';
import { vnoise } from '../../tools/preview/world/glslNoise.ts';

const luma = (c: ArrayLike<number>): number => 0.2126 * (c[0] as number) + 0.7152 * (c[1] as number) + 0.0722 * (c[2] as number);
const SD = DEFAULT_TERRAIN.shadeDepth;
const NO_SPILL = [0, 0, 0] as const;

interface Stats {
  mean: number;
  p95: number;
  rgb: [number, number, number];
  /** Coefficient of variation of tile-sized (48 u) block means: structure that survives gameplay zoom. */
  blockCv: number;
}

/** Shade a 40 × 40-tile patch of interior at a fixed depth, 4 u apart. */
function patch(depth: number, x0 = 3000, y0 = 900): Stats {
  const out = [0, 0, 0];
  const all: number[] = [];
  const blocks: number[] = [];
  const rgb: [number, number, number] = [0, 0, 0];
  for (let by = 0; by < 40; by++) {
    for (let bx = 0; bx < 40; bx++) {
      let s = 0;
      let n = 0;
      for (let y = 0; y < 48; y += 4) {
        for (let x = 0; x < 48; x += 4) {
          shadeTerrainCore(out, depth, SD, x0 + bx * 48 + x, y0 + by * 48 + y, 0, NO_SPILL, vnoise);
          const l = luma(out);
          all.push(l);
          s += l;
          n++;
          for (let c = 0; c < 3; c++) rgb[c] += out[c] as number;
        }
      }
      blocks.push(s / n);
    }
  }
  all.sort((a, b) => a - b);
  const mean = all.reduce((a, b) => a + b, 0) / all.length;
  const bm = blocks.reduce((a, b) => a + b, 0) / blocks.length;
  const bsd = Math.sqrt(blocks.reduce((a, b) => a + (b - bm) ** 2, 0) / blocks.length);
  return { mean, p95: all[Math.floor(all.length * 0.95)] as number, rgb: rgb.map((v) => v / all.length) as [number, number, number], blockCv: bsd / bm };
}

describe('terrain core shading (terrainShading.ts, mirrored by terrain.glsl.ts)', () => {
  const surface = patch(0);
  const rimEnd = patch(SD);
  const heart = patch(SD + TERRAIN_DEEP_REACH);
  /** The previous interior floor (#050B14 silhouette): big masses read as holes at this value. */
  const oldFloor = luma(hexToRgb(PALETTE.silhouette));

  test('the interior floor is a lifted indigo/teal-black, not black', () => {
    for (const s of [rimEnd, heart]) {
      expect(s.mean).toBeGreaterThan(oldFloor * 1.3);
      // Blue-dominant, green above red: indigo/teal, not neutral grey or violet.
      expect(s.rgb[2]).toBeGreaterThan(s.rgb[1] * 1.5);
      expect(s.rgb[1]).toBeGreaterThan(s.rgb[0] * 1.6);
    }
  });

  test('value contrast: even bright interior stays below the darkest fog of the background', () => {
    const fogDeep = luma(hexToRgb(PALETTE.fogDeep));
    for (const s of [rimEnd, heart]) expect(s.p95).toBeLessThan(fogDeep);
    // And the surface zone stays the lighter read around every mass.
    expect(surface.mean).toBeGreaterThan(rimEnd.mean * 1.5);
  });

  test('large-scale structure (bands, seams, roots, stones) reads at tile scale deep inside', () => {
    expect(rimEnd.blockCv).toBeGreaterThan(0.1);
    expect(heart.blockCv).toBeGreaterThan(0.1);
  });

  test('deeper interiors drift toward indigo instead of sinking to black', () => {
    expect(heart.mean).toBeGreaterThan(rimEnd.mean * 0.95);
    expect(heart.rgb[2] / heart.rgb[1]).toBeGreaterThan(rimEnd.rgb[2] / rimEnd.rgb[1]);
    expect(TERRAIN_CORE_COLOR[2]).toBeGreaterThan(TERRAIN_DEEP_COLOR[2]);
    // The drift stops at the cap the mesh writes: nothing changes past it.
    const out = [0, 0, 0];
    const past = [0, 0, 0];
    shadeTerrainCore(out, SD + TERRAIN_DEEP_REACH, SD, 5123, 1777, 0, NO_SPILL, vnoise);
    shadeTerrainCore(past, SD + TERRAIN_DEEP_REACH * 2, SD, 5123, 1777, 0, NO_SPILL, vnoise);
    expect(past).toEqual(out);
  });

  test('the moonlit rim zone and spill stay at the surface', () => {
    const lit = [0, 0, 0];
    const unlit = [0, 0, 0];
    shadeTerrainCore(lit, 0, SD, 4000, 1000, 1, NO_SPILL, vnoise);
    shadeTerrainCore(unlit, 0, SD, 4000, 1000, 0, NO_SPILL, vnoise);
    expect(luma(lit)).toBeGreaterThan(luma(unlit) + 0.1);
    shadeTerrainCore(lit, SD * 2, SD, 4000, 1000, 1, [1, 1, 1], vnoise);
    shadeTerrainCore(unlit, SD * 2, SD, 4000, 1000, 0, NO_SPILL, vnoise);
    expect(luma(lit) - luma(unlit)).toBeLessThan(0.02);
  });

  test('glints are sparse and faint', () => {
    expect(TERRAIN_GLINT_DENSITY).toBeLessThan(0.05);
    for (const c of [TERRAIN_GLINT_MOSS, TERRAIN_GLINT_MINERAL]) expect(Math.max(...c)).toBeLessThan(0.25);
  });

  test('stones sit in a contact shadow on the far side, not a ring (a full ring reads as a bubble)', () => {
    const st: StoneSample = { body: 0, pillow: 0, crevice: 0, d: 0, facing: 0 };
    let lit = 0;
    let far = 0;
    let nLit = 0;
    let nFar = 0;
    const span = TERRAIN_STONE_CELL * 12;
    for (let y = 0; y < span; y += 1) {
      for (let x = 0; x < span; x += 1) {
        stoneAt(st, x, y, 0);
        if (st.d < 1.06 || st.d > 1.12) continue;
        if (st.facing > 0.7) { lit += st.crevice; nLit++; }
        else if (st.facing < -0.7) { far += st.crevice; nFar++; }
      }
    }
    expect(nLit).toBeGreaterThan(100);
    expect(nFar).toBeGreaterThan(100);
    expect(lit / nLit).toBeLessThan(0.3 * (far / nFar));
  });

  test('stone outlines follow the lump: the same point leaves the stone when the outline shrinks', () => {
    const st: StoneSample = { body: 0, pillow: 0, crevice: 0, d: 0, facing: 0 };
    let moved = 0;
    for (let y = 0; y < TERRAIN_STONE_CELL * 6; y += 2) {
      for (let x = 0; x < TERRAIN_STONE_CELL * 6; x += 2) {
        stoneAt(st, x, y, 0);
        const flat = st.body;
        stoneAt(st, x, y, 0.15);
        if (flat > 0.99 && st.body < 0.01) moved++;
      }
    }
    expect(moved).toBeGreaterThan(20);
  });

  test('the shaders bake the same constants (the depth drift, the glint density, the stone shape)', () => {
    for (const src of [TERRAIN_CORE_FRAGMENT, TERRAIN_EDGE_FRAGMENT]) {
      expect(src).toContain(`/ ${TERRAIN_DEEP_REACH}.0`);
      expect(src).toContain(`step(${1 - TERRAIN_GLINT_DENSITY}, gh)`);
      expect(src).toContain('(1.0 + 0.5 * (sn - 0.5) + 0.4 * (mottle - 0.5))');
      expect(src).toContain('(0.2 + 0.8 * smoothstep(-0.2, 0.7, -facing))');
      expect(src).toContain('vec3 terrainColor(float depth, vec2 world, float lit, vec3 spill, vec2 stroke, float strokeAA)');
    }
  });
});
