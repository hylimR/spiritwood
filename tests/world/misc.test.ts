import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseManifest } from '../../src/assets/manifest.ts';
import type { FogLayerDef } from '../../src/contracts/assets.ts';
import type { QualityLevel } from '../../src/contracts/quality.ts';
import { shaftEnvelope, shaftPoint, shaftTrapezoid } from '../../src/render/fx/shaftGeometry.ts';
import { buildShaftMesh } from '../../src/render/fx/shafts.ts';
import { polygonArea, triangulate } from '../../src/render/gen/polygon.ts';
import { KIT_STRIDE_FLOATS } from '../../src/render/layers/kitMesh.ts';
import { selectFogBands } from '../../src/render/layers/fog.ts';
import { selectLayers } from '../../src/render/layers/parallaxStack.ts';
import { plateMeshData } from '../../src/render/layers/plates.ts';
import { hash21, MOON_GLOW, shadeSky, SKY_HORIZON, skyHorizonY, skyParams } from '../../src/render/layers/skyShading.ts';
import { fogBandParams, shadeFog } from '../../src/render/layers/fogShading.ts';
import { SHAFT_LOOK, shadeShaft, shaftProfile } from '../../src/render/fx/shaftShading.ts';

const manifest = parseManifest(JSON.parse(readFileSync(new URL('../../public/layers/forest.manifest.json', import.meta.url), 'utf8')));

function triArea(p: number[], idx: number[]): number {
  let a = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [i, j, k] = [idx[t] as number, idx[t + 1] as number, idx[t + 2] as number];
    a += Math.abs(((p[j * 2] as number) - (p[i * 2] as number)) * ((p[k * 2 + 1] as number) - (p[i * 2 + 1] as number))
      - ((p[k * 2] as number) - (p[i * 2] as number)) * ((p[j * 2 + 1] as number) - (p[i * 2 + 1] as number))) / 2;
  }
  return a;
}

describe('triangulate', () => {
  test('convex and concave polygons, both windings: triangle area equals polygon area', () => {
    const square = [0, 0, 10, 0, 10, 10, 0, 10];
    const comb = [0, 0, 30, 0, 30, 20, 25, 20, 25, 5, 20, 5, 20, 20, 10, 20, 10, 5, 5, 5, 5, 20, 0, 20];
    for (const poly of [square, comb, [...comb].reverse().flatMap((_, i, a) => (i % 2 === 0 ? [a[i + 1] as number, a[i] as number] : []))]) {
      const idx = triangulate(poly);
      expect(idx.length).toBe((poly.length / 2 - 2) * 3);
      expect(triArea(poly, idx)).toBeCloseTo(Math.abs(polygonArea(poly)), 6);
    }
  });
});

describe('triangulate (traced hull quirks)', () => {
  const cases: [string, number[]][] = [
    ['repeated vertex', [0, 0, 10, 0, 10, 10, 10, 10, 0, 10]],
    ['closing point repeats the first', [0, 0, 10, 0, 10, 10, 0, 10, 0, 0]],
    ['run of repeats on a collinear edge', [0, 0, 10, 0, 10, 10, 5, 10, 5, 10, 5, 10, 0, 10]],
    ['collinear strip', [0, 0, 2, 0, 4, 0, 6, 0, 8, 0, 8, 2, 6, 2, 4, 2, 2, 2, 0, 2]],
  ];
  for (const [name, poly] of cases) {
    test(`${name}: triangles cover the whole polygon`, () => {
      expect(triArea(poly, triangulate(poly))).toBeCloseTo(Math.abs(polygonArea(poly)), 6);
    });
  }

  test('every shipped plate hull triangulates completely', () => {
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(new URL('../../public/layers/forest.plates.manifest.json', import.meta.url), 'utf8'));
    } catch {
      return;
    }
    for (const l of parseManifest(json).layers) {
      if (l.kind !== 'plate') continue;
      for (const c of l.chunks) {
        for (const poly of [c.hull, c.opaqueHull]) {
          if (poly) expect(triArea(poly, triangulate(poly))).toBeCloseTo(Math.abs(polygonArea(poly)), 3);
        }
      }
    }
  });
});

describe('plateMeshData', () => {
  test('maps chunk texels to the chunk rect with matching UVs', () => {
    const m = plateMeshData([0, 0, 64, 0, 64, 32, 0, 32], { x0: 100, y0: 50, x1: 228, y1: 114 }, 64, 32, 0.8);
    expect(m.vertexCount).toBe(4);
    expect([m.vertices[KIT_STRIDE_FLOATS * 2], m.vertices[KIT_STRIDE_FLOATS * 2 + 1]]).toEqual([228, 114]);
    expect([m.vertices[KIT_STRIDE_FLOATS * 2 + 2], m.vertices[KIT_STRIDE_FLOATS * 2 + 3]]).toEqual([1, 1]);
    expect(m.vertices[6]).toBeCloseTo(0.8, 6);
    expect(m.area).toBeCloseTo(128 * 64, 6);
    expect(m.indices.length).toBe(6);
  });
});

describe('selectLayers', () => {
  const count = (level: QualityLevel, budget: number): number => selectLayers(manifest.layers, level, budget).size;

  test('the shipped manifest gives 10 / 8 / 6 kit layers at High / Medium / Low', () => {
    expect(count('high', 10)).toBe(10);
    expect(count('medium', 8)).toBe(8);
    expect(count('low', 6)).toBe(6);
  });

  test('the budget drops the farthest layers first', () => {
    const on = selectLayers(manifest.layers, 'high', 3);
    const kits = manifest.layers.filter((l) => l.kind === 'kit').sort((a, b) => b.parallax[0] - a.parallax[0]);
    expect([...on].sort()).toEqual(kits.slice(0, 3).map((l) => l.id).sort());
  });
});

describe('selectFogBands', () => {
  const fogs = manifest.layers.filter((l): l is FogLayerDef => l.kind === 'fog');
  const ids = (level: QualityLevel, bands: number): string[] => {
    const on = selectFogBands(fogs, level, bands, []);
    return fogs.filter((_, i) => on[i]).map((f) => f.id);
  };

  test('quality presets: 2 / 2 / 1 bands (ARCHITECTURE.md §5.7)', () => {
    expect(ids('high', 2)).toEqual(['fog-low', 'fog-near']);
    expect(ids('medium', 2)).toEqual(['fog-low', 'fog-near']);
    expect(ids('low', 1)).toEqual(['fog-low']);
  });

  test('a band below its minQuality stays off even when the band count allows it', () => {
    expect(fogs.find((f) => f.id === 'fog-near')?.minQuality).toBe('medium');
    expect(ids('low', 2)).toEqual(['fog-low']);
    expect(ids('high', 0)).toEqual([]);
  });
});

describe('light shafts', () => {
  const shaft = { id: 0, x: 100, y: 0, w: 200, h: 1000, angle: 0.2, spread: 1.5, intensity: 0.6 };

  test('trapezoid follows the LightShaftDef geometry', () => {
    const t = shaftTrapezoid(shaft);
    expect(t.topX).toBe(100);
    expect(t.topW).toBe(200);
    expect(t.botW).toBe(300);
    expect(t.botX + t.botW / 2).toBeCloseTo(100 + 100 + 1000 * Math.tan(0.2), 6);
    const p = { x: 0, y: 0 };
    shaftPoint(t, 0.5, 1, p);
    expect(p.x).toBeCloseTo(t.botX + 150, 6);
    expect(p.y).toBe(1000);
  });

  test('envelope is soft at the sides, fades in at the top and out at the bottom', () => {
    expect(shaftEnvelope(0.5, 0.3)).toBe(1);
    expect(shaftEnvelope(0, 0.3)).toBe(0);
    expect(shaftEnvelope(0.5, 0)).toBe(0);
    expect(shaftEnvelope(0.5, 1)).toBe(0);
    expect(shaftEnvelope(0.1, 0.3)).toBeGreaterThan(0);
  });

  test('mesh attribute (x − left, width) is affine: u = a / b is exact at every vertex', () => {
    const t = shaftTrapezoid(shaft);
    const { vertices, indices } = buildShaftMesh([t]);
    expect(indices.length % 6).toBe(0);
    for (let v = 0; v < vertices.length; v += 7) {
      const x = vertices[v] as number;
      const vv = vertices[v + 4] as number;
      const left = t.topX + (t.botX - t.topX) * vv;
      expect(vertices[v + 2]).toBeCloseTo(x - left, 4);
      expect(vertices[v + 3]).toBeCloseTo(t.topW + (t.botW - t.topW) * vv, 4);
    }
  });
});

describe('sky model', () => {
  const sky = manifest.layers.find((l) => l.kind === 'sky');
  if (sky?.kind !== 'sky') throw new Error('manifest has no sky');
  const p = skyParams(sky);
  const out = [0, 0, 0];
  const flat = (): number => 0;
  /** A horizon far off-screen isolates the gradient. */
  const NO_HORIZON = -1e6;

  test('gradient runs from the top stop to the bottom stop', () => {
    shadeSky(out, 1800, 0, 1920, 1080, NO_HORIZON, 0, p, flat);
    expect(out[2]).toBeCloseTo(p.stopColor[2] as number, 2);
    shadeSky(out, 1800, 1080, 1920, 1080, NO_HORIZON, 0, p, flat);
    expect(out[2]).toBeCloseTo(p.stopColor[11] as number, 2);
  });

  test('a luminous horizon band sits behind the far treelines and drifts slowly with the camera', () => {
    const h = skyHorizonY(1080, 1200, 2400);
    expect(h).toBeCloseTo(1080 * SKY_HORIZON.t, 6);
    // Camera higher up → horizon lower on screen, by a small parallax.
    expect(skyHorizonY(1080, 600, 2400)).toBeCloseTo(h + 600 * SKY_HORIZON.parallax, 6);
    const lum = (y: number, horizon: number): number => {
      shadeSky(out, 1800, y, 1920, 1080, horizon, 0, p, flat);
      return 0.2126 * (out[0] as number) + 0.7152 * (out[1] as number) + 0.0722 * (out[2] as number);
    };
    expect(lum(h, h)).toBeGreaterThan(lum(h, NO_HORIZON) + 0.05);
    expect(lum(h, h)).toBeGreaterThan(lum(h - 400, h));
  });

  test('the moon disc is moonlight-coloured, and its glow lifts the sky around it', () => {
    const mx = p.moonX * 1920;
    const my = p.moonY * 1080;
    shadeSky(out, mx, my, 1920, 1080, NO_HORIZON, 0, p, flat);
    expect(out[0]).toBeGreaterThan(0.9 * p.moonColor[0] - 1e-6);
    const disc = out[0] as number;
    shadeSky(out, mx + p.moonRadius * 4, my, 1920, 1080, NO_HORIZON, 0, p, flat);
    const near = out[2] as number;
    expect(out[0]).toBeLessThan(disc);
    shadeSky(out, mx + p.moonRadius * 16, my, 1920, 1080, NO_HORIZON, 0, p, flat);
    expect(near).toBeGreaterThan((out[2] as number) + 0.01);
    expect(MOON_GLOW.broad).toBeGreaterThan(0);
  });

  test('hash21 matches the GLSL definition', () => {
    const fract = (x: number): number => x - Math.floor(x);
    let px = fract(3 * 123.34);
    let py = fract(4 * 456.21);
    const d = px * (px + 45.32) + py * (py + 45.32);
    px += d;
    py += d;
    expect(hash21(3, 4)).toBeCloseTo(fract(px * py), 10);
  });
});

describe('fog band model', () => {
  const def = manifest.layers.find((l): l is FogLayerDef => l.kind === 'fog');
  if (!def) throw new Error('manifest has no fog band');
  const p = fogBandParams(def);
  const out = [0, 0, 0, 0];

  test('fades to nothing at both band edges and stays within its density', () => {
    for (const noise of [(): number => 0, (): number => 1, (): number => 0.5]) {
      shadeFog(out, 100, def.y - def.height, 0, p, noise);
      expect(out[3]).toBe(0);
      shadeFog(out, 100, def.y + def.height, 0, p, noise);
      expect(out[3]).toBe(0);
      for (let v = -1; v <= 1; v += 0.1) {
        shadeFog(out, 100, def.y + v * def.height, 0, p, noise);
        expect(out[3]).toBeLessThanOrEqual(def.density + 1e-9);
        expect(out[3]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test('dense at the base, eroded into wisps toward the top', () => {
    const noise = (): number => 0.45;
    shadeFog(out, 0, def.y + 0.3 * def.height, 0, p, noise);
    const base = out[3] as number;
    shadeFog(out, 0, def.y - 0.8 * def.height, 0, p, noise);
    expect(base).toBeGreaterThan(out[3] as number);
  });
});

describe('light shaft shading', () => {
  test('zero outside the shaft, brightest in the upper middle, reaching the floor softly', () => {
    const n = (): number => 0.6;
    expect(shadeShaft(-0.01, 0.3, 1, 1, 0, n)).toBe(0);
    expect(shadeShaft(0.5, 1.01, 1, 1, 0, n)).toBe(0);
    expect(shaftProfile(0, 0.3)).toBe(0);
    expect(shaftProfile(0.5, 0)).toBe(0);
    expect(shaftProfile(0.5, 1)).toBe(0);
    const mid = shadeShaft(0.5, 0.2, 1, 1, 0, n);
    const low = shadeShaft(0.5, 0.8, 1, 1, 0, n);
    expect(mid).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(0);
    expect(mid).toBeLessThanOrEqual(SHAFT_LOOK.strength * 1.3);
  });
});
