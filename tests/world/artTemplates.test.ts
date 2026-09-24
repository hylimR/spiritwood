import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { describe, expect, test } from 'vitest';
import { parseManifest } from '../../src/assets/manifest.ts';
import { spliceManifest } from '../../src/assets/splice.ts';
import { MAX_LAYER_PARALLAX, MIN_LAYER_PARALLAX_GAP } from '../../src/config.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { freeSlot, referenceCamera, renderTemplates, resolveArea, type TemplateFile } from '../../tools/art/templates.ts';
import { parseSidecar, plateLayerDef } from '../../tools/art/sidecar.ts';
import { forestKit } from './kitFixture.ts';

const SLOW = 120_000;
const level = parseLdtk(JSON.parse(readFileSync(new URL('../../public/levels/forest.ldtk', import.meta.url), 'utf8')));
const base = parseManifest(JSON.parse(readFileSync(new URL('../../public/layers/forest.base.manifest.json', import.meta.url), 'utf8')));
const digest = (files: readonly TemplateFile[]): string[] => files.map((f) => `${f.name} ${createHash('sha256').update(f.data).digest('hex').slice(0, 16)}`);

describe('paint-over templates (npm run art:export)', () => {
  test('areas: a grade id is the union of its zones; "x0,x1" is a world range; anything else is explained', () => {
    const glade = resolveArea(level, 'glade');
    const zones = level.gradeZones.filter((z) => z.grade === 'glade');
    expect(glade).toEqual({ id: 'glade', x0: Math.min(...zones.map((z) => z.x)), x1: Math.max(...zones.map((z) => z.x + z.w)), grade: 'glade' });
    expect(resolveArea(level, '0,2016')).toEqual({ id: 'x0-2016', x0: 0, x1: 2016, grade: null });
    expect(() => resolveArea(level, 'swamp')).toThrow(/expected one of .*glade.* or "x0,x1"/);
    expect(() => resolveArea(level, '900,100')).toThrow(/x1 must be greater than x0/);
    // The reference camera frames the area like the sim camera: inside the level.
    const cam = referenceCamera(level, glade);
    expect(cam.cx).toBeGreaterThan(0);
    expect(cam.cx).toBeLessThan(level.pxWidth);
    expect(cam.cy).toBeGreaterThan(0);
    expect(cam.cy).toBeLessThan(level.pxHeight);
  });

  test('a new plate\'s depth keeps clear of the art plates already painted, and so do the slot stubs', async () => {
    const painted = [{ id: 'glade-landmark', parallax: [0.2, 0.2] as [number, number] }];
    const slot = freeSlot(base, 0.2, painted);
    expect(slot).not.toBe(0.2);
    for (const l of [...base.layers.filter((x) => x.kind === 'kit' && x.parallax[0] <= 1), ...painted]) {
      expect(Math.abs(slot - l.parallax[0])).toBeGreaterThanOrEqual(MIN_LAYER_PARALLAX_GAP - 1e-9);
    }
    // Foreground depths only avoid exact ties.
    const f1 = base.layers.find((l) => l.id === 'F1-frame');
    expect(freeSlot(base, f1?.parallax[0] ?? 1.25)).toBe(Math.round(((f1?.parallax[0] ?? 1.25) + 0.01) * 100) / 100);
    const files = renderTemplates({ level, manifest: base, kit: forestKit(), area: resolveArea(level, 'glade'), scale: 8, layers: [], slots: [0.2], plates: painted });
    const stub = JSON.parse(new TextDecoder().decode((files.find((f) => f.name === 'slot-f0.2.json') as TemplateFile).data)) as Record<string, unknown>;
    expect(stub.parallax).toEqual([slot, slot]);
    expect(String(stub._parallax)).toContain('glade-landmark');
  }, SLOW);

  test('a new plate\'s depth never ties with a layer and keeps the depth-tested gap', () => {
    const taken = base.layers.filter((l) => l.kind === 'kit' && l.parallax[0] <= 1).map((l) => l.parallax[0]);
    for (const f of [0.08, 0.16, 0.2, 0.28, 0.4, 0.6, 0.66, 0.9]) {
      const slot = freeSlot(base, f);
      expect(slot).toBeLessThanOrEqual(MAX_LAYER_PARALLAX);
      for (const t of taken) expect(Math.abs(slot - t)).toBeGreaterThanOrEqual(MIN_LAYER_PARALLAX_GAP - 1e-9);
      expect(Math.abs(slot - f)).toBeLessThanOrEqual(0.05);
    }
  });

  test('the export is deterministic, and every stub is a valid sidecar that splices into the base', async () => {
    const opts = { level, manifest: base, kit: forestKit(), area: resolveArea(level, 'glade'), scale: 6, layers: ['L4-mid-forest'], slots: [0.34] };
    const a = renderTemplates(opts);
    const b = renderTemplates(opts);
    expect(digest(a)).toEqual(digest(b));
    // Templates are numbered by their kit layer's place in the stack, far to near.
    const n = String(base.layers.filter((l) => l.kind === 'kit').findIndex((l) => l.id === 'L4-mid-forest') + 1).padStart(2, '0');
    expect(a.map((f) => f.name)).toEqual([
      `${n}-L4-mid-forest.png`, `${n}-L4-mid-forest.layer.png`, `${n}-L4-mid-forest.guides.png`, `${n}-L4-mid-forest.json`,
      'slot-f0.34.png', 'slot-f0.34.guides.png', 'slot-f0.34.json',
    ]);
    for (const f of a.filter((x) => x.name.endsWith('.png'))) {
      const m = await sharp(f.data).metadata();
      expect([m.format, m.channels, m.hasAlpha]).toEqual(['png', 4, true]);
    }
    // The layer render has coverage (the kit layer as the game draws it), the guides have lines.
    const alphaOf = async (name: string): Promise<number> => {
      const f = a.find((x) => x.name === name) as TemplateFile;
      const { data } = await sharp(f.data).raw().toBuffer({ resolveWithObject: true });
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if ((data[i] as number) > 0) n++;
      return n / (data.length / 4);
    };
    expect(await alphaOf(`${n}-L4-mid-forest.layer.png`)).toBeGreaterThan(0.05);
    expect(await alphaOf(`${n}-L4-mid-forest.guides.png`)).toBeGreaterThan(0.001);
    expect(await alphaOf('slot-f0.34.png')).toBe(1);
    for (const f of a.filter((x) => x.name.endsWith('.json'))) {
      const sidecar = parseSidecar(JSON.parse(new TextDecoder().decode(f.data)), f.name);
      expect(sidecar.texelScale).toBe(6);
      expect(sidecar.area).toBe('glade');
      const def = plateLayerDef('painted', sidecar);
      def.chunks = [{ col: 0, row: 0, source: { webp: 'plates/painted_0_0.webp' }, soft: [0, 0, 16, 16] }];
      expect(() => parseManifest(JSON.parse(JSON.stringify(spliceManifest(base, [{ layer: def, replaces: sidecar.replaces }]))))).not.toThrow();
    }
  }, SLOW);
});
