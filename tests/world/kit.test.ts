import { describe, expect, test } from 'vitest';
import { generateKit, KIT_GUTTER, KIT_HULL, SWAY_ROW_STEP, type KitAtlasData } from '../../src/render/gen/kit.ts';
import { ELEMENT_MARGIN, ELEMENT_SPECS, KIT_CATEGORIES } from '../../src/render/gen/kitElements.ts';
import { generateParticleAtlas, PARTICLE_FRAMES } from '../../src/render/gen/particleAtlas.ts';
import { packRects } from '../../src/render/gen/pack.ts';
import { forestKit, forestKitMs } from './kitFixture.ts';

const SMALL = ELEMENT_SPECS.filter((s) => ['grass', 'flower', 'shroom', 'bramble', 'rock', 'solid'].includes(s.category));

function inAnyRect(kit: KitAtlasData, x: number, y: number): boolean {
  for (const el of kit.elements) if (x >= el.x && x < el.x + el.w && y >= el.y && y < el.y + el.h) return true;
  return false;
}

describe('procedural kit', () => {
  test('small atlas is deterministic per seed and differs across seeds', () => {
    const a = generateKit(123, 512, 512, SMALL);
    const b = generateKit(123, 512, 512, SMALL);
    const c = generateKit(124, 512, 512, SMALL);
    expect(Buffer.from(a.pixels).equals(Buffer.from(b.pixels))).toBe(true);
    expect(a.elements.map((e) => [e.x, e.y, e.core, e.soft])).toEqual(b.elements.map((e) => [e.x, e.y, e.core, e.soft]));
    expect(Buffer.from(a.pixels).equals(Buffer.from(c.pixels))).toBe(false);
  });

  test('channel sanity on a small atlas', () => {
    const kit = generateKit(7, 512, 512, SMALL);
    const W = kit.width;
    let lumSum = 0;
    let lumN = 0;
    for (let y = 0; y < kit.height; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        const [r, g, b, a] = [kit.pixels[o], kit.pixels[o + 1], kit.pixels[o + 2], kit.pixels[o + 3]] as number[];
        if (!inAnyRect(kit, x, y)) {
          // Gutters are fully transparent.
          expect(a).toBe(0);
          continue;
        }
        if (a === 0) {
          expect(g).toBe(0);
          continue;
        }
        if (a === 255) {
          lumSum += r as number;
          lumN++;
        }
        expect(b).toBeGreaterThanOrEqual(0);
      }
    }
    // Luminance detail is centred on 0.5 (±0.15 on average).
    expect(Math.abs(lumSum / lumN / 255 - 0.5)).toBeLessThan(0.15);
    // Emissive only in elements flagged emissive; rim only in elements with a rim.
    for (const el of kit.elements) {
      let em = 0;
      let rim = 0;
      for (let y = el.y; y < el.y + el.h; y++) {
        for (let x = el.x; x < el.x + el.w; x++) {
          em = Math.max(em, kit.pixels[(y * W + x) * 4 + 2] as number);
          rim = Math.max(rim, kit.pixels[(y * W + x) * 4 + 1] as number);
        }
      }
      if (el.emissive) expect(em).toBeGreaterThan(200);
      else expect(em).toBe(0);
      if (el.category !== 'solid') expect(rim).toBeGreaterThan(40);
    }
  });

  test('element margins are transparent (mip fringes stay inside the rect)', () => {
    const kit = generateKit(9, 512, 512, SMALL);
    for (const el of kit.elements) {
      if (el.category === 'solid' || el.cut !== 'none') continue;
      for (let x = el.x; x < el.x + el.w; x++) {
        expect(kit.pixels[(el.y * kit.width + x) * 4 + 3]).toBe(0);
      }
      for (let y = el.y; y < el.y + el.h; y++) {
        expect(kit.pixels[(y * kit.width + el.x) * 4 + 3]).toBe(0);
        expect(kit.pixels[(y * kit.width + el.x + el.w - 1) * 4 + 3]).toBe(0);
      }
    }
    expect(ELEMENT_MARGIN).toBeGreaterThanOrEqual(KIT_HULL.pad as number);
  });

  test('full forest kit: every category present, hulls valid, generation time logged', () => {
    const kit = forestKit();
    const ms = forestKitMs();
    console.info(`[kit] ${kit.elements.length} elements in ${ms.toFixed(0)} ms (budget 400 ms on a laptop)`);
    expect(ms).toBeLessThan(4000);
    for (const c of KIT_CATEGORIES) expect(kit.byCategory[c].length).toBeGreaterThan(0);
    for (const el of kit.elements) {
      expect(el.x).toBeGreaterThanOrEqual(KIT_GUTTER);
      expect(el.x + el.w).toBeLessThanOrEqual(kit.width - KIT_GUTTER);
      expect(el.y + el.h).toBeLessThanOrEqual(kit.height - KIT_GUTTER);
      expect(el.core.length + el.soft.length).toBeGreaterThan(0);
      // Core rects sit on fully opaque texels.
      for (let i = 0; i < el.core.length; i += 4) {
        for (let y = el.core[i + 1] as number; y < (el.core[i + 3] as number); y += 3) {
          for (let x = el.core[i] as number; x < (el.core[i + 2] as number); x += 3) {
            expect(kit.pixels[((el.y + y) * kit.width + el.x + x) * 4 + 3]).toBeGreaterThanOrEqual(254);
          }
        }
      }
      // Swaying elements are split on the row grid.
      if (el.sway !== 'none') {
        for (let i = 0; i < el.soft.length; i += 4) {
          const y0 = el.soft[i + 1] as number;
          const y1 = el.soft[i + 3] as number;
          expect(Math.floor(y0 / SWAY_ROW_STEP)).toBe(Math.floor((y1 - 1) / SWAY_ROW_STEP));
        }
      }
    }
  });

  test('shelf packer keeps gutters and rejects overflow', () => {
    const items = [{ w: 10, h: 10 }, { w: 20, h: 5 }, { w: 30, h: 30 }];
    const used = packRects(items, 64, 64, 2);
    expect(used).toBeLessThanOrEqual(64);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i] as Required<(typeof items)[number]> & { x: number; y: number };
        const b = items[j] as Required<(typeof items)[number]> & { x: number; y: number };
        const sepX = a.x + a.w + 2 <= b.x || b.x + b.w + 2 <= a.x;
        const sepY = a.y + a.h + 2 <= b.y || b.y + b.h + 2 <= a.y;
        expect(sepX || sepY).toBe(true);
      }
    }
    expect(() => packRects([{ w: 50, h: 50 }, { w: 50, h: 50 }], 64, 64, 2)).toThrow();
  });
});

describe('particle atlas', () => {
  test('all frames present, inside the atlas, deterministic, with soft transparent borders', () => {
    const a = generateParticleAtlas();
    const b = generateParticleAtlas();
    expect(Buffer.from(a.pixels).equals(Buffer.from(b.pixels))).toBe(true);
    for (const name of PARTICLE_FRAMES) {
      const f = a.frames[name];
      expect(f.x + f.w).toBeLessThanOrEqual(a.width);
      expect(f.y + f.h).toBeLessThanOrEqual(a.height);
      let maxA = 0;
      for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) maxA = Math.max(maxA, a.pixels[(y * a.width + x) * 4 + 3] as number);
      expect(maxA).toBeGreaterThan(150);
      // Frame corners are transparent (no hard sprite edges).
      expect(a.pixels[(f.y * a.width + f.x) * 4 + 3]).toBeLessThan(8);
    }
  });
});
