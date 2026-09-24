import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { VIEW_H } from '../../src/config.ts';
import { parseManifest } from '../../src/assets/manifest.ts';
import type { SkyLayerDef } from '../../src/contracts/assets.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { scanPlates } from '../../tools/art/bake.ts';
import { areaCameraRange, cameraBounds, MOON_COVERAGE_LIMIT, moonCoverage, moonSweepBox, type PlateImage } from '../../tools/art/moon.ts';
import { artPaths } from '../../tools/art/paths.ts';
import { resolveArea } from '../../tools/art/templates.ts';

const paths = artPaths();
const level = parseLdtk(JSON.parse(readFileSync(paths.ldtk, 'utf8')));
const base = parseManifest(JSON.parse(readFileSync(paths.base, 'utf8')));
const sky = base.layers.find((l): l is SkyLayerDef => l.kind === 'sky') as SkyLayerDef;
const glade = resolveArea(level, 'glade');
const range = areaCameraRange(level, glade);

describe('the moon and the Glade plates', () => {
  test('the camera range covers every walkable height of the area and stays in the level', () => {
    for (const aspect of range.aspects) {
      const c = cameraBounds(range, aspect, 1);
      expect(c.cy0).toBeGreaterThanOrEqual(VIEW_H / 2);
      expect(c.cy1).toBeLessThanOrEqual(level.pxHeight - VIEW_H / 2);
      expect(c.cy0).toBeLessThan(c.cy1);
      expect(c.cx0).toBeLessThanOrEqual(c.cx1);
    }
    // The hero's start is inside: its camera height is in the range.
    const start = level.playerStart.y - 120;
    const c = cameraBounds(range, 16 / 9, 1);
    expect(start).toBeGreaterThanOrEqual(c.cy0);
  });

  test('a plate covering the moon\'s whole sweep hides it everywhere; one outside it never does', () => {
    const box = moonSweepBox(sky, range, 0.6, 0.6);
    const make = (x0: number, y0: number, x1: number, y1: number): PlateImage => {
      const w = Math.ceil((x1 - x0) / 4);
      const h = Math.ceil((y1 - y0) / 4);
      return { rgba: new Uint8Array(w * h * 4).fill(255), width: w, height: h, origin: [x0, y0], texelScale: 4, parallax: [0.6, 0.6] };
    };
    expect(moonCoverage(make(box.x0, box.y0, box.x1, box.y1), sky, range, 32).max).toBeCloseTo(1, 5);
    expect(moonCoverage(make(box.x0, box.y0 - 400, box.x1, box.y0 - 1), sky, range, 32).max).toBe(0);
    expect(moonCoverage(make(box.x1 + 1, box.y0, box.x1 + 400, box.y1), sky, range, 32).max).toBe(0);
  });

  test(`the art plates hide at most ${MOON_COVERAGE_LIMIT * 100} % of the moon at every Glade camera`, async () => {
    const { plates, errors } = await scanPlates(paths);
    expect(errors).toEqual([]);
    expect(plates.map((p) => p.id)).toContain('glade-frame');
    for (const p of plates) {
      const { data, info } = await sharp(join(paths.plates, `${p.id}.png`)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      const img: PlateImage = {
        rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height,
        origin: p.sidecar.origin, texelScale: p.sidecar.texelScale, parallax: p.sidecar.parallax,
      };
      const c = moonCoverage(img, sky, range);
      expect(c.max, `${p.id}: ${(c.max * 100).toFixed(1)} % at camera (${c.cx.toFixed(0)}, ${c.cy.toFixed(0)}), ${c.aspect.toFixed(2)}:1, zoom ${c.zoom}`).toBeLessThanOrEqual(MOON_COVERAGE_LIMIT);
    }
  }, 60_000);
});
