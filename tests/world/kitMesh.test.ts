import { describe, expect, test } from 'vitest';
import type { KitElement } from '../../src/render/gen/kit.ts';
import { buildChunks, KIT_STRIDE_FLOATS, MAX_MESH_VERTICES, packTint, type BuildOptions } from '../../src/render/layers/kitMesh.ts';
import { elementRowY, type KitInstance } from '../../src/render/layers/placement.ts';
import { KIT_MODE, KIT_RIM_COLOR, shadeKit, type KitShadeParams } from '../../src/render/layers/kitShading.ts';
import { depthForInstance } from '../../src/render/util/camera.ts';

function element(over: Partial<KitElement> = {}): KitElement {
  return {
    index: 0, category: 'grass', variant: 0, x: 100, y: 200, w: 40, h: 60, unitsPerTexel: 2, anchorX: 20, anchorY: 60,
    sway: 'none', swayScale: 0, emissive: false, cut: 'none', stretchFrom: 60, columnX: 20,
    core: [10, 10, 30, 50], soft: [0, 0, 40, 10, 0, 50, 40, 60], coreArea: 800, softArea: 800,
    ...over,
  };
}

function inst(el: KitElement, x: number, k: number, over: Partial<KitInstance> = {}): KitInstance {
  return { el, x, y: 1000, sx: 1, sy: 1, phase: 0.5, shade: 0.5, k, ...over };
}

const OPTS: BuildOptions = {
  split: true, depthF: 0.5, glow: 0x3fe0c5, chunkWidth: 1000, originX: 0, swayAmp: 4, atlasW: 1024, atlasH: 1024,
};

describe('buildChunks', () => {
  test('positions, UVs, depth and tint of a single instance', () => {
    const el = element();
    const [chunk] = buildChunks([inst(el, 500, 3)], OPTS);
    const core = chunk?.core[0];
    expect(core?.vertexCount).toBe(4);
    const v = core?.vertices as Float32Array;
    // Rect [10,10]-[30,50] around anchor (20, 60) at 2 u/texel.
    expect([v[0], v[1]]).toEqual([500 - 20, 1000 - 100]);
    expect([v[2], v[3]]).toEqual([(100 + 10) / 1024, (200 + 10) / 1024]);
    expect(v[6]).toBeCloseTo(depthForInstance(0.5, 3), 6);
    const tint = new Uint32Array(v.buffer)[7] as number;
    expect(tint).toBe(packTint(0x3fe0c5, 0.5));
    expect(chunk?.band[0]?.vertexCount).toBe(8);
  });

  test('instances go to the chunk of their anchor; core front → back, band back → front', () => {
    const el = element();
    const list = [inst(el, 100, 1), inst(el, 200, 2), inst(el, 1500, 3), inst(el, 300, 4)];
    const chunks = buildChunks(list, OPTS);
    expect(chunks).toHaveLength(2);
    const coreDepths = (chunks[0]?.core[0]?.vertices as Float32Array).filter((_, i) => i % (4 * KIT_STRIDE_FLOATS) === 6);
    expect([...coreDepths]).toEqual([...coreDepths].sort((a, b) => a - b));
    const bandDepths = (chunks[0]?.band[0]?.vertices as Float32Array).filter((_, i) => i % (4 * KIT_STRIDE_FLOATS) === 6);
    expect([...bandDepths]).toEqual([...bandDepths].sort((a, b) => b - a));
  });

  test('blend-only layers put everything in band meshes, back → front, with depth 0', () => {
    const el = element();
    const chunks = buildChunks([inst(el, 100, 2), inst(el, 120, 1)], { ...OPTS, split: false, depthF: null });
    expect(chunks[0]?.core).toEqual([]);
    const m = chunks[0]?.band[0];
    expect(m?.vertexCount).toBe(2 * 12);
    for (let q = 0; q < (m?.vertexCount ?? 0); q++) expect(m?.vertices[q * KIT_STRIDE_FLOATS + 6]).toBe(0);
  });

  test('sway amplitude grows with height from the anchor and is 0 for static elements', () => {
    const el = element({ sway: 'bottom', swayScale: 1, core: [], soft: [0, 0, 40, 30, 0, 30, 40, 60] });
    const [chunk] = buildChunks([inst(el, 100, 1)], OPTS);
    const v = chunk?.band[0]?.vertices as Float32Array;
    const sway = (vert: number): number => v[vert * KIT_STRIDE_FLOATS + 4] as number;
    // Top row (ty 0) at weight 1, middle (ty 30) at 0.25, anchor row (ty 60) at 0.
    const heightUnits = 60 * 2;
    const full = OPTS.swayAmp * (heightUnits / 100);
    expect(sway(0)).toBeCloseTo(full, 5);
    expect(sway(3)).toBeCloseTo(full * 0.25, 5);
    expect(sway(6)).toBeCloseTo(0, 5);
    const [still] = buildChunks([inst(element(), 100, 1)], OPTS);
    expect(still?.band[0]?.vertices[4]).toBe(0);
    expect(chunk?.bounds.x0).toBeLessThan(100 - 40);
  });

  test('top-cut stretch keeps rows below stretchFrom at |sx| and stretches rows above', () => {
    const el = element({ cut: 'top', stretchFrom: 40, anchorY: 60 });
    const i = inst(el, 0, 1, { sx: -1, sy: 3 });
    expect(elementRowY(i, 60)).toBe(1000);
    expect(elementRowY(i, 40)).toBe(1000 - 40);
    expect(elementRowY(i, 0)).toBe(1000 - 40 - 40 * 2 * 3);
    // Flipped instances mirror x.
    const [chunk] = buildChunks([i], OPTS);
    const v = chunk?.core[0]?.vertices as Float32Array;
    expect(v[0]).toBe(-(10 - 20) * 2);
  });

  test('ground fill spans every chunk and is the backmost core quad', () => {
    const el = element();
    const solid = element({ category: 'solid', x: 0, y: 0, w: 24, h: 24 });
    const chunks = buildChunks([inst(el, 100, 1), inst(el, 2500, 2)], { ...OPTS, fill: { x0: -50, y0: 1100, x1: 3100, y1: 1500, el: solid } });
    expect(chunks).toHaveLength(3);
    let area = 0;
    for (const c of chunks) {
      const m = c.core[c.core.length - 1];
      const v = m?.vertices as Float32Array;
      const last = ((m?.vertexCount ?? 0) - 4) * KIT_STRIDE_FLOATS;
      expect(v[last + 6]).toBeCloseTo(depthForInstance(0.5, 0), 6);
      area += ((v[last + 2 * KIT_STRIDE_FLOATS] as number) - (v[last] as number)) * 400;
    }
    expect(area).toBeCloseTo(3150 * 400, 3);
  });

  test('splits meshes before exceeding the Uint16 index range', () => {
    const rects: number[] = [];
    for (let i = 0; i < 6000; i++) rects.push(0, 0, 1, 1);
    const el = element({ core: [], soft: rects });
    const list = [inst(el, 10, 1), inst(el, 20, 2), inst(el, 30, 3)];
    const [chunk] = buildChunks(list, { ...OPTS, split: false });
    expect(chunk?.band.length).toBeGreaterThan(1);
    for (const m of chunk?.band ?? []) expect(m.vertexCount).toBeLessThanOrEqual(MAX_MESH_VERTICES);
    expect(chunk?.band.reduce((n, m) => n + m.vertexCount, 0)).toBe(3 * 6000 * 4);
  });

  test('emissiveOnly keeps only emissive elements', () => {
    const glowy = element({ emissive: true });
    const chunks = buildChunks([inst(element(), 10, 1), inst(glowy, 20, 2)], { ...OPTS, split: false, emissiveOnly: true });
    expect(chunks[0]?.band[0]?.vertexCount).toBe(12);
  });
});

describe('shadeKit (reference shading)', () => {
  const params: KitShadeParams = {
    tint: [0.1, 0.2, 0.3], fogColor: [0.5, 0.6, 0.7], fog: 0, desaturate: 0, rim: 0, rimColor: KIT_RIM_COLOR, glow: 0,
    mistY: 1000, mistDepth: 100, mist: 1,
  };
  const out = new Float32Array(4);

  test('neutral detail and shade reproduce the tint; full fog gives the fog colour', () => {
    shadeKit(out, [0.5, 0, 0, 1], 0.5, [0, 0, 0], 0, params, KIT_MODE.Core);
    expect([...out].map((v) => +v.toFixed(5))).toEqual([0.1, 0.2, 0.3, 1]);
    shadeKit(out, [0.5, 0, 0, 1], 0.5, [0, 0, 0], 0, { ...params, fog: 1 }, KIT_MODE.Core);
    expect([...out].map((v) => +v.toFixed(5))).toEqual([0.5, 0.6, 0.7, 1]);
  });

  test('height mist rises below mistY', () => {
    shadeKit(out, [0.5, 0, 0, 1], 0.5, [0, 0, 0], 1100, params, KIT_MODE.Core);
    expect(out[0]).toBeCloseTo(0.5, 5);
    shadeKit(out, [0.5, 0, 0, 1], 0.5, [0, 0, 0], 1050, params, KIT_MODE.Core);
    expect(out[0]).toBeGreaterThan(0.1);
    expect(out[0]).toBeLessThan(0.5);
  });

  test('band output is premultiplied; glow twin is additive light only', () => {
    shadeKit(out, [0.5, 0, 0, 0.5], 0.5, [0, 0, 0], 0, params, KIT_MODE.Band);
    expect(out[3]).toBe(0.5);
    expect(out[0]).toBeCloseTo(0.05, 5);
    shadeKit(out, [0.5, 0, 1, 1], 0.5, [0.2, 0.8, 0.6], 0, { ...params, glow: 1 }, KIT_MODE.Glow);
    expect(out[3]).toBe(0);
    expect(out[1]).toBeCloseTo(0.8, 5);
  });
});
