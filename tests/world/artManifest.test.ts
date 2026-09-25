import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseManifest } from '../../src/assets/manifest.ts';
import { SpliceError, spliceManifest, type PlateInsert } from '../../src/assets/splice.ts';
import type { LayerManifest, PlateLayerDef } from '../../src/contracts/assets.ts';
import { sourceHash } from '../../tools/art/bake.ts';
import { formatJson } from '../../tools/art/json.ts';
import { parseSidecar, plateLayerDef, SidecarError, structuralChange, type Sidecar } from '../../tools/art/sidecar.ts';

/** The hand-edited base manifest every generated manifest is spliced from (§5.8). */
const base = parseManifest(JSON.parse(readFileSync(new URL('../../public/layers/forest.base.manifest.json', import.meta.url), 'utf8')));

const SIDECAR: Sidecar = {
  parallax: [0.34, 0.34], replaces: null, origin: [2000, 300], texelScale: 2, minQuality: 'low', fog: 0.3,
  fogColor: '#25426c', desaturate: 0.1, tint: '#ffffff', area: 'glade',
};

function plate(id: string, fx: number, fy = fx): PlateLayerDef {
  const def = plateLayerDef(id, { ...SIDECAR, parallax: [fx, fy] });
  def.chunks = [{
    col: 0, row: 0, source: { webp: `plates/${id}_0_0.webp?v=0123abcd`, png: `plates/${id}_0_0.png?v=0123abcd` },
    core: [8, 8, 32, 32], soft: [0, 0, 8, 64, 40, 0, 24, 64], hash: '0123abcd0123abcd',
  }];
  return def;
}

const ids = (m: LayerManifest): string[] => m.layers.map((l) => l.id);
const fxOf = (id: string): number => (base.layers.find((l) => l.id === id) as { parallax: [number, number] }).parallax[0];
const spliceError = (plates: PlateInsert[]): string => {
  try {
    spliceManifest(base, plates);
  } catch (e) {
    expect(e).toBeInstanceOf(SpliceError);
    return (e as Error).message;
  }
  throw new Error('expected the splice to fail');
};

describe('spliceManifest (base + plates → generated manifest)', () => {
  test('inserts each plate where its fx falls among the base layers, far to near (foreground plates too)', () => {
    const out = spliceManifest(base, [{ layer: plate('far', 0.12) }, { layer: plate('mid', 0.34) }, { layer: plate('front', 1.4, 0) }]);
    const order = ids(out);
    for (const [id, fx] of [['far', 0.12], ['mid', 0.34], ['front', 1.4]] as const) {
      const i = order.indexOf(id);
      const before = out.layers[i - 1] as { parallax: [number, number] };
      const after = out.layers[i + 1] as { parallax: [number, number] };
      expect(before.parallax[0]).toBeLessThan(fx);
      expect(after.parallax[0]).toBeGreaterThan(fx);
    }
    // The base layers keep their order; nothing is dropped without `replaces`.
    expect(order.filter((id) => !['far', 'mid', 'front'].includes(id))).toEqual(ids(base));
    expect(out.replaced).toBeUndefined();
    // The generated manifest is a valid manifest (depth gaps, ranges).
    expect(() => parseManifest(JSON.parse(JSON.stringify(out)))).not.toThrow();
  });

  test('is deterministic: the same plates in any order give byte-identical JSON (plates apply in id order)', () => {
    const plates: PlateInsert[] = [{ layer: plate('b-plate', 0.34) }, { layer: plate('a-plate', 0.12) }, { layer: plate('c-plate', 0.46) }];
    const texts = new Set<string>();
    for (const order of [[0, 1, 2], [2, 1, 0], [1, 2, 0], [0, 2, 1]]) {
      texts.add(formatJson(spliceManifest(base, order.map((i) => plates[i] as PlateInsert))));
    }
    expect(texts.size).toBe(1);
    // The input is not modified.
    expect(base).toEqual(parseManifest(JSON.parse(readFileSync(new URL('../../public/layers/forest.base.manifest.json', import.meta.url), 'utf8'))));
  });

  test('rejects a tie with a base layer, with another plate, and with a layer another plate replaced', () => {
    const l4 = fxOf('L4-mid-forest');
    expect(spliceError([{ layer: plate('tie', l4) }])).toMatch(/plate "tie": parallax fx 0\.4 ties with base layer "L4-mid-forest"/);
    expect(spliceError([{ layer: plate('one', 0.34) }, { layer: plate('two', 0.34) }])).toMatch(/plate "two": parallax fx 0\.34 ties with plate "one"/);
    // L3 comes back if its replacement fails, so a third plate can't take its depth either.
    const l3 = fxOf('L3-misty-trunks');
    expect(spliceError([{ layer: plate('swap', 0.3), replaces: 'L3-misty-trunks' }, { layer: plate('squat', l3) }]))
      .toMatch(/plate "squat": parallax fx 0\.28 ties with base layer "L3-misty-trunks"/);
  });

  test('replaces takes the base layer out of the list and records it; a plate may sit at that layer\'s depth', () => {
    const l3 = base.layers.find((l) => l.id === 'L3-misty-trunks');
    const out = spliceManifest(base, [{ layer: plate('painted-l3', fxOf('L3-misty-trunks')), replaces: 'L3-misty-trunks' }]);
    expect(ids(out)).not.toContain('L3-misty-trunks');
    expect(ids(out).indexOf('painted-l3')).toBe(ids(base).indexOf('L3-misty-trunks'));
    expect(out.replaced).toEqual({ 'painted-l3': l3 });
    // The runtime reads the replaced layer by plate id (drawn again if the plate fails to load).
    const parsed = parseManifest(JSON.parse(JSON.stringify(out)));
    expect(parsed.replaced?.['painted-l3']).toEqual(l3);
    expect(ids(parsed)).toEqual(ids(out));
  });

  test('rejects replacing an unknown layer, a non-kit layer or one layer twice, and a plate id a base layer has', () => {
    expect(spliceError([{ layer: plate('p', 0.34), replaces: 'L3-misty' }]))
      .toMatch(/replaces "L3-misty", which is not a base layer \(kit and plate layers: L1-farthest-treeline, .*L3-misty-trunks/);
    expect(spliceError([{ layer: plate('p', 0.34), replaces: 'fog-low' }])).toMatch(/"fog-low", a fog layer; only kit and plate layers can be replaced/);
    expect(spliceError([{ layer: plate('p1', 0.3), replaces: 'L3-misty-trunks' }, { layer: plate('p2', 0.26), replaces: 'L3-misty-trunks' }]))
      .toMatch(/plate "p2": "L3-misty-trunks" is already replaced by plate "p1"/);
    expect(spliceError([{ layer: plate('L4-mid-forest', 0.34) }])).toMatch(/already has a layer with this id; rename the plate/);
    expect(spliceError([{ layer: plate('twin', 0.34) }, { layer: plate('twin', 0.46) }])).toMatch(/two plates with this id/);
  });
});

describe('plate sidecars', () => {
  const FILE = 'art/plates/crag.json';
  const json = (patch: Record<string, unknown> = {}, drop: string[] = []): Record<string, unknown> => {
    const o: Record<string, unknown> = { ...SIDECAR, ...patch };
    for (const k of drop) delete o[k];
    return o;
  };
  const error = (value: unknown): string => {
    try {
      parseSidecar(value, FILE);
    } catch (e) {
      expect(e).toBeInstanceOf(SidecarError);
      return (e as Error).message;
    }
    throw new Error('expected the sidecar to be rejected');
  };

  test('a valid sidecar parses; comment keys are ignored, colours normalised, replaces and area optional', () => {
    const s = parseSidecar({ ...json({ fogColor: '#25426C', _note: 'painted over 04-L4', $schema: 'x' }, ['replaces', 'area']) }, FILE);
    expect(s).toEqual({ ...SIDECAR, fogColor: '#25426c', area: null });
  });

  test.each([
    ['a misspelt key', json({ paralax: [0.3, 0.3] }, ['parallax']), /unknown key "paralax" \(did you mean "parallax"\?\)/],
    ['a missing key', json({}, ['texelScale']), /"texelScale" is missing/],
    ['texels finer than 1.5 u', json({ texelScale: 1 }), /"texelScale" must be ≥ 1\.5 world units per texel.*no mipmaps/],
    ['a depth too close to the gameplay plane', json({ parallax: [0.97, 0.97] }), /fx 0\.97 is too close to the gameplay plane/],
    ['the sky depth', json({ parallax: [0, 0] }), /"parallax" fx must be > 0/],
    ['fog out of range', json({ fog: 1.5 }), /"fog" must be between 0 and 1, got 1\.5/],
    ['a named colour', json({ fogColor: 'blue' }), /"fogColor" must be a colour "#rrggbb", got "blue"/],
    ['an unknown quality', json({ minQuality: 'ultra' }), /"minQuality" must be one of low, medium, high/],
    ['an unknown area', json({ area: 'swamp' }), /"area" must be one of .*glade.* or null/],
    ['an origin that is not a pair', json({ origin: [1] }), /"origin" must be \[x, y\]/],
    ['an empty replaces', json({ replaces: '' }), /"replaces" must be a base layer id or null/],
    ['not an object', [1, 2], /expected a JSON object/],
  ])('rejects %s, naming the file and the key', (_name, value, message) => {
    const m = error(value);
    expect(m.startsWith(`${FILE}: `)).toBe(true);
    expect(m).toMatch(message);
  });

  test('structural changes (a full page reload in dev) are parallax, replaces and minQuality only', () => {
    const s = parseSidecar(json(), FILE);
    expect(structuralChange(s, { ...s, parallax: [0.36, 0.34] })).toBe('parallax');
    expect(structuralChange(s, { ...s, replaces: 'L4-mid-forest' })).toBe('replaces');
    expect(structuralChange(s, { ...s, minQuality: 'high' })).toBe('minQuality');
    expect(structuralChange(s, { ...s, fog: 0.5, origin: [0, 0], texelScale: 3, tint: '#ffeedd', area: null })).toBeNull();
  });

  test('the source hash covers the PNG bytes and the sidecar values, not comments or key order', () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const a = parseSidecar(json(), FILE);
    const b = parseSidecar({ _comment: 'moved it', ...Object.fromEntries(Object.entries(json()).reverse()) }, FILE);
    expect(sourceHash(png, a)).toBe(sourceHash(png, b));
    expect(sourceHash(png, a)).not.toBe(sourceHash(png, { ...a, fog: 0.31 }));
    expect(sourceHash(png, a)).not.toBe(sourceHash(new Uint8Array([137, 80, 78, 71, 1, 2, 4]), a));
    expect(sourceHash(png, a)).toMatch(/^[0-9a-f]{32}$/);
  });
});
