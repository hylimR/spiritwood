import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { ManifestError, loadManifest, parseManifest } from '../../src/assets/manifest.ts';
import { MAX_LAYER_PARALLAX, MIN_LAYER_PARALLAX_GAP } from '../../src/config.ts';
import type { KitLayerDef, LayerDef, LayerManifest, PlateLayerDef } from '../../src/contracts/assets.ts';

const read = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../public/layers/${name}`, import.meta.url), 'utf8'));
/** The hand-edited base manifest (§5.8); the mutation cases below index its layer list. */
const forest = read('forest.base.manifest.json') as LayerManifest;
const clone = (): LayerManifest => structuredClone(forest);
/** Assign an arbitrary (possibly invalid) value to a field. */
const set = (o: object, key: string, value: unknown): void => {
  (o as Record<string, unknown>)[key] = value;
};
const layer = (m: LayerManifest, i: number): LayerDef => m.layers[i] as LayerDef;

function expectError(json: unknown, path: string): void {
  try {
    parseManifest(json);
  } catch (e) {
    expect(e).toBeInstanceOf(ManifestError);
    expect((e as Error).message.startsWith(`${path}:`)).toBe(true);
    return;
  }
  throw new Error(`expected ManifestError at ${path}`);
}

describe('parseManifest', () => {
  test('the base manifest is valid and matches the art direction', () => {
    const m = parseManifest(forest);
    expect(m.area).toBe('forest');
    expect(m.textureBudgetMB).toEqual({ high: 96, medium: 64, low: 48 });
    const kinds = m.layers.map((l) => l.kind);
    expect(kinds[0]).toBe('sky');
    expect(kinds.filter((k) => k === 'kit')).toHaveLength(10);
    expect(kinds.filter((k) => k === 'fog')).toHaveLength(2);
    // Foreground layers come last and are the only kit layers beyond parallax 1.
    const kits = m.layers.filter((l) => l.kind === 'kit');
    expect(kits.filter((l) => l.parallax[0] > 1)).toHaveLength(2);
    expect(m.layers.filter((l) => l.kind === 'plate')).toHaveLength(0);
  });

  test('the generated manifest is the base with plate layers inserted in parallax order', () => {
    const m = parseManifest(read('forest.manifest.json'));
    const base = parseManifest(forest);
    const replaced = Object.values(m.replaced ?? {});
    expect(m.layers.filter((l) => l.kind !== 'plate')).toEqual(base.layers.filter((l) => !replaced.some((r) => r.id === l.id)));
    for (let i = 1; i < m.layers.length; i++) expect((m.layers[i] as LayerDef).parallax[0]).toBeGreaterThanOrEqual((m.layers[i - 1] as LayerDef).parallax[0]);
    for (const l of m.layers) {
      if (l.kind !== 'plate') continue;
      for (const c of l.chunks) for (const f of ['ktx2', 'webp', 'png'] as const) expect(c.source[f]).toMatch(/\?v=[0-9a-f]{8}$/);
    }
  });

  test('the plates manifest (when baked) is valid and has exactly one plate layer', () => {
    let json: unknown;
    try {
      json = read('forest.plates.manifest.json');
    } catch {
      return;
    }
    const m = parseManifest(json);
    expect(m.layers.filter((l) => l.kind === 'plate')).toHaveLength(1);
  });

  const cases: [string, (m: LayerManifest) => void, string][] = [
    ['not an object', () => undefined, 'manifest'],
    ['version', (m) => set(m, 'version', 2), 'version'],
    ['area', (m) => set(m, 'area', ''), 'area'],
    ['budget', (m) => set(m.textureBudgetMB, 'low', 0), 'textureBudgetMB.low'],
    ['atlas id duplicate', (m) => { m.atlases.push({ ...(m.atlases[0] as LayerManifest['atlases'][number]) }); }, 'atlases[1].id'],
    ['atlas source empty', (m) => set(m.atlases[0] as object, 'source', {}), 'atlases[0].source'],
    ['atlas source extension', (m) => set(m.atlases[0] as object, 'source', { webp: 'a.png' }), 'atlases[0].source.webp'],
    ['atlas width', (m) => set(m.atlases[0] as object, 'width', 12.5), 'atlases[0].width'],
    ['layers not array', (m) => set(m, 'layers', {}), 'layers'],
    ['unknown kind', (m) => set(layer(m, 1), 'kind', 'mesh'), 'layers[1].kind'],
    ['duplicate id', (m) => set(layer(m, 2), 'id', layer(m, 1).id), 'layers[2].id'],
    ['parallax shape', (m) => set(layer(m, 1), 'parallax', [0.1]), 'layers[1].parallax'],
    ['parallax range', (m) => set(layer(m, 1), 'parallax', [-0.1, 0]), 'layers[1].parallax[0]'],
    ['minQuality', (m) => set(layer(m, 1), 'minQuality', 'ultra'), 'layers[1].minQuality'],
    ['colour', (m) => set(layer(m, 1), 'tint', 'blue'), 'layers[1].tint'],
    ['fog colour', (m) => set(layer(m, 1), 'fogColor', '#12345'), 'layers[1].fogColor'],
    ['fog range', (m) => set(layer(m, 1), 'fog', 1.5), 'layers[1].fog'],
    ['desaturate', (m) => set(layer(m, 1), 'desaturate', -1), 'layers[1].desaturate'],
    ['sky not first', (m) => { m.layers.splice(2, 0, m.layers.shift() as LayerDef); }, 'layers[2]'],
    ['sky parallax', (m) => set(layer(m, 0), 'parallax', [0.1, 0]), 'layers[0].parallax'],
    ['sky gradient order', (m) => set(layer(m, 0), 'gradient', [[0.5, '#000000'], [0.2, '#ffffff']]), 'layers[0].gradient[1][0]'],
    ['sky gradient short', (m) => set(layer(m, 0), 'gradient', [[0, '#000000']]), 'layers[0].gradient'],
    ['moon', (m) => set(layer(m, 0), 'moon', { x: 2, y: 0.2, radius: 40, color: '#ffffff', halo: 1 }), 'layers[0].moon.x'],
    ['kit atlas ref', (m) => set(layer(m, 1), 'atlas', 'nope'), 'layers[1].atlas'],
    ['kit recipe', (m) => set(layer(m, 1), 'recipe', 'jungle'), 'layers[1].recipe'],
    ['kit seed', (m) => set(layer(m, 1), 'seed', 1.5), 'layers[1].seed'],
    ['kit scale order', (m) => set(layer(m, 1), 'scale', [2, 1]), 'layers[1].scale'],
    ['kit chunk width', (m) => set(layer(m, 1), 'chunkWidth', 1024), 'layers[1].chunkWidth'],
    ['kit sway', (m) => set(layer(m, 1), 'sway', 2), 'layers[1].sway'],
    ['order far → near', (m) => { const a = layer(m, 1); m.layers[1] = layer(m, 2); m.layers[2] = a; }, 'layers[2].parallax'],
    ['depth-tested max parallax', (m) => set(layer(m, 8), 'parallax', [0.97, 0.97]), 'layers[8].parallax'],
    ['depth-tested gap', (m) => set(layer(m, 2), 'parallax', [layer(m, 1).parallax[0] + MIN_LAYER_PARALLAX_GAP / 2, 0.1]), 'layers[2].parallax'],
    ['fog height', (m) => set(layer(m, 9), 'height', 0), 'layers[9].height'],
    ['fog density', (m) => set(layer(m, 9), 'density', 3), 'layers[9].density'],
  ];
  for (const [name, mutate, path] of cases) {
    test(`rejects: ${name} → ${path}`, () => {
      if (name === 'not an object') {
        expectError(42, path);
        return;
      }
      const m = clone();
      mutate(m);
      expectError(m, path);
    });
  }

  test('the depth-tested parallax limit is the configured one', () => {
    const m = clone();
    set(layer(m, 8), 'parallax', [MAX_LAYER_PARALLAX, MAX_LAYER_PARALLAX]);
    expect(() => parseManifest(m)).not.toThrow();
  });

  describe('plate layers', () => {
    const plate = (): PlateLayerDef => ({
      id: 'P', kind: 'plate', parallax: [0.3, 0.3], minQuality: 'low', tint: '#ffffff', fog: 0.2, fogColor: '#1f4a63', desaturate: 0,
      origin: [0, 0], chunkSize: [64, 32], texelScale: 2,
      chunks: [
        { col: 0, row: 0, source: { webp: 'plates/a.webp', png: 'plates/a.png' }, hull: [0, 0, 64, 0, 64, 32, 0, 32], opaqueHull: [4, 20, 60, 20, 60, 30] },
        { col: 1, row: 0, source: { ktx2: 'plates/b.ktx2' } },
      ],
    });
    const chunk = (p: PlateLayerDef, i: number): PlateLayerDef['chunks'][number] => p.chunks[i] as PlateLayerDef['chunks'][number];
    const withPlate = (p: PlateLayerDef): LayerManifest => {
      const m = clone();
      m.layers.splice(4, 0, p);
      return m;
    };

    test('a valid plate layer parses', () => {
      const m = parseManifest(withPlate(plate()));
      const p = m.layers[4];
      expect(p?.kind).toBe('plate');
    });

    test('duplicate chunk', () => {
      const p = plate();
      chunk(p, 1).col = 0;
      expectError(withPlate(p), 'layers[4].chunks[1]');
    });

    test('procedural chunk source is rejected', () => {
      const p = plate();
      chunk(p, 1).source = { procedural: 'x' };
      expectError(withPlate(p), 'layers[4].chunks[1].source.procedural');
    });

    test('hull point outside the chunk', () => {
      const p = plate();
      (chunk(p, 0).hull as number[])[2] = 65;
      expectError(withPlate(p), 'layers[4].chunks[0].hull[2]');
    });

    test('odd hull length', () => {
      const p = plate();
      chunk(p, 0).opaqueHull = [1, 2, 3, 4, 5, 6, 7];
      expectError(withPlate(p), 'layers[4].chunks[0].opaqueHull');
    });

    test('empty chunk list', () => {
      const p = plate();
      p.chunks = [];
      expectError(withPlate(p), 'layers[4].chunks');
    });

    test('texture paths may carry a cache-buster: the extension is checked on the pathname', () => {
      const p = plate();
      chunk(p, 0).source = { webp: 'plates/a.webp?v=0123abcd', png: 'plates/a.png?v=0123abcd' };
      expect(() => parseManifest(withPlate(p))).not.toThrow();
      chunk(p, 0).source = { webp: 'plates/a.png?v=x.webp' };
      expectError(withPlate(p), 'layers[4].chunks[0].source.webp');
    });

    test('split-hull rects: integer [x, y, w, h] quadruples inside the chunk', () => {
      const p = plate();
      chunk(p, 0).core = [0, 0, 64, 16];
      chunk(p, 0).soft = [0, 16, 64, 16, 10, 0, 4, 4];
      expect(() => parseManifest(withPlate(p))).not.toThrow();
      chunk(p, 0).soft = [0, 16, 64];
      expectError(withPlate(p), 'layers[4].chunks[0].soft');
      chunk(p, 0).soft = [0, 16, 65, 16];
      expectError(withPlate(p), 'layers[4].chunks[0].soft[2]');
      chunk(p, 0).soft = [0, 16, 0, 16];
      expectError(withPlate(p), 'layers[4].chunks[0].soft[2]');
      chunk(p, 0).soft = [0.5, 16, 8, 8];
      expectError(withPlate(p), 'layers[4].chunks[0].soft[0]');
    });

    test('chunk hashes are lower-case hex', () => {
      const p = plate();
      chunk(p, 0).hash = '0123456789abcdef';
      expect(() => parseManifest(withPlate(p))).not.toThrow();
      chunk(p, 0).hash = 'XYZ';
      expectError(withPlate(p), 'layers[4].chunks[0].hash');
    });
  });

  describe('replaced layers (generated manifests)', () => {
    const plateAt = (id: string, fx: number): PlateLayerDef => ({
      id, kind: 'plate', parallax: [fx, fx], minQuality: 'low', tint: '#ffffff', fog: 0.2, fogColor: '#1f4a63', desaturate: 0,
      origin: [0, 0], chunkSize: [64, 32], texelScale: 2, chunks: [{ col: 0, row: 0, source: { webp: 'plates/a.webp' } }],
    });
    /** The base with L3 swapped for a plate at L3's parallax, and L3 recorded as replaced. */
    const swapped = (): LayerManifest & { replaced: Record<string, LayerDef> } => {
      const m = clone();
      const i = m.layers.findIndex((l) => l.id === 'L3-misty-trunks');
      const l3 = m.layers[i] as KitLayerDef;
      m.layers[i] = plateAt('P', l3.parallax[0]);
      return { ...m, replaced: { P: l3 } };
    };

    test('the replaced layer is available to the runtime by plate id, and copies of the manifest keep it', () => {
      const m = parseManifest(swapped());
      expect(m.replaced?.P?.id).toBe('L3-misty-trunks');
      expect({ ...m, layers: [...m.layers] }.replaced?.P?.id).toBe('L3-misty-trunks');
      expect(parseManifest(forest).replaced).toBeUndefined();
      expect(parseManifest({ ...swapped(), replaced: {} }).replaced).toBeUndefined();
    });

    test('rejects a replacement for an unknown plate, one still in the list, and one replaced twice', () => {
      const a = swapped();
      a.replaced = { Q: a.replaced.P as LayerDef };
      expectError(a, 'replaced.Q');
      const b = swapped();
      b.replaced = { P: b.layers[1] as LayerDef };
      expectError(b, 'replaced.P.id');
      const c = swapped();
      const i = c.layers.findIndex((l) => l.id === 'L4-mid-forest');
      c.layers.splice(i, 0, plateAt('P2', 0.34));
      c.replaced = { P: c.replaced.P as LayerDef, P2: c.replaced.P as LayerDef };
      expectError(c, 'replaced.P2.id');
    });

    test('rejects a restore that would break the depth gaps (any failed subset of plates must stay valid)', () => {
      const m = swapped();
      // A second plate 0.01 behind L3's slot: fine while P draws, too close once P fails and L3 returns.
      const i = m.layers.findIndex((l) => l.id === 'P');
      m.layers.splice(i, 0, plateAt('Q', 0.265));
      m.layers[i + 1] = { ...(m.layers[i + 1] as PlateLayerDef), parallax: [0.29, 0.29] };
      expectError(m, 'replaced.P');
    });
  });
});

describe('loadManifest', () => {
  test('fetches and parses', async () => {
    const fetchFn = (async () => new Response(JSON.stringify(forest), { status: 200 })) as typeof fetch;
    const m = await loadManifest('https://example.com/layers/forest.manifest.json', fetchFn);
    expect(m.layers.length).toBe(forest.layers.length);
  });

  test('HTTP errors become ManifestError', async () => {
    const fetchFn = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    await expect(loadManifest('https://example.com/x.json', fetchFn)).rejects.toBeInstanceOf(ManifestError);
  });
});
