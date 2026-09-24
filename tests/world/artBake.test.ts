import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, test } from 'vitest';
import { parseManifest } from '../../src/assets/manifest.ts';
import { hash8, pathnameOf, PLATE_BORDER, PLATE_CONTENT, PLATE_TEXTURE } from '../../src/assets/plateLayout.ts';
import type { PlateLayerDef } from '../../src/contracts/assets.ts';
import { ART_TOOL_VERSION, ArtError, levelSize, measurePlate, readLock, runArt, scanPlates, type ArtOptions } from '../../tools/art/bake.ts';
import type { AtlasMeasure } from '../../tools/art/budget.ts';
import { chunkSource, pixelHash, PLATE_HULL, type ChunkResult } from '../../tools/art/chunks.ts';
import { CHUNK_FORMATS, type ChunkFormat, type Encoders } from '../../tools/art/encode.ts';
import { artPaths, type ArtPaths } from '../../tools/art/paths.ts';
import { inspectPng, memorySource, pngSource } from '../../tools/art/source.ts';
import { encodePng } from '../../tools/preview/png.ts';

const SLOW = 60_000;
const C = PLATE_CONTENT;
const T = PLATE_TEXTURE;
const LEVEL = levelSize(artPaths());
const ATLASES: AtlasMeasure[] = [{ id: 'forest-kit', width: 2048, height: 2048, bytes: 22_369_621 }];

async function chunksOf(width: number, height: number, rgba: Uint8Array): Promise<ChunkResult[]> {
  const out: ChunkResult[] = [];
  for await (const c of chunkSource(memorySource(width, height, rgba))) out.push(c);
  return out;
}

/** Every texel says where it came from: r, g = x, y low bytes; b = their high bits. */
function coordinateImage(w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      rgba[o] = x & 255;
      rgba[o + 1] = y & 255;
      rgba[o + 2] = ((x >> 8) & 15) | (((y >> 8) & 15) << 4);
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

/** Rolling hills: a soft top edge over an opaque body, a fading base and a round hole. `bump` repaints x ≥ bumpX. */
function hills(w: number, h: number, bump = 0, bumpX = 0): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let x = 0; x < w; x++) {
    const b = x >= bumpX ? bump : 0;
    const top = Math.round(h * 0.35 + 30 * Math.sin(x * 0.013) + 12 * Math.sin(x * 0.051 + b));
    for (let y = 0; y < h; y++) {
      const edge = Math.min(1, Math.max(0, (y - top) / 6));
      const base = Math.min(1, Math.max(0, (h - 4 - y) / 20));
      const hole = Math.min(1, Math.max(0, (Math.hypot(x - w * 0.3, y - h * 0.7) - 18) / 4));
      const o = (y * w + x) * 4;
      rgba[o] = 30 + (x % 50) + b * 20;
      rgba[o + 1] = 50 + (y % 40);
      rgba[o + 2] = 80;
      rgba[o + 3] = Math.round(edge * base * hole * 255);
    }
  }
  return rgba;
}

describe('chunking', () => {
  test(`${T}² chunks: ${C}² of content plus a ${PLATE_BORDER}-texel border duplicated from the neighbours, transparent outside the image`, async () => {
    const W = 2100;
    const H = 1100;
    const img = coordinateImage(W, H);
    const chunks = await chunksOf(W, H, img);
    expect(chunks.map((c) => [c.col, c.row])).toEqual([[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]]);
    const at = (col: number, row: number): ChunkResult => chunks.find((c) => c.col === col && c.row === row) as ChunkResult;
    const texel = (c: ChunkResult, tx: number, ty: number): number[] => [...c.rgba.subarray((ty * T + tx) * 4, (ty * T + tx) * 4 + 4)];
    const source = (x: number, y: number): number[] => (x < 0 || y < 0 || x >= W || y >= H ? [0, 0, 0, 0] : [...img.subarray((y * W + x) * 4, (y * W + x) * 4 + 4)]);
    for (const c of chunks) {
      expect(c.rgba.length).toBe(T * T * 4);
      // The border lines and the content lines next to them: texture (tx, ty) = source (col·C + tx − 1, row·C + ty − 1).
      for (let t = 0; t < T; t++) {
        for (const e of [0, 1, T - 2, T - 1]) {
          for (const [tx, ty] of [[t, e], [e, t]] as const) {
            const expected = source(c.col * C + tx - PLATE_BORDER, c.row * C + ty - PLATE_BORDER);
            // Outside the image the texel is transparent; its colour is dilated from the nearest content.
            if (expected[3] === 0) expect(texel(c, tx, ty)[3]).toBe(0);
            else expect(texel(c, tx, ty)).toEqual(expected);
          }
        }
      }
    }
    // Neighbours agree across every seam: the 2·border texels around it are the same in both chunks
    // (texel C + k of one is texel k of the next).
    for (let y = PLATE_BORDER; y < T - PLATE_BORDER; y++) {
      for (let k = 0; k < 2 * PLATE_BORDER; k++) {
        expect(texel(at(1, 0), k, y)).toEqual(texel(at(0, 0), C + k, y));
        expect(texel(at(0, 1), y, k)).toEqual(texel(at(0, 0), y, C + k));
      }
    }
    // The corner border texels come from the diagonal neighbour.
    for (let k = 0; k < 2 * PLATE_BORDER; k++) expect(texel(at(1, 1), k, k)).toEqual(texel(at(0, 0), C + k, C + k));
  }, SLOW);

  test('empty chunks are skipped; transparent texels carry nearby colour, alpha untouched', async () => {
    const W = 2100;
    const H = 300;
    const img = new Uint8Array(W * H * 4);
    // Content only in the first chunk: a 40 × 40 orange square.
    for (let y = 100; y < 140; y++) {
      for (let x = 100; x < 140; x++) img.set([230, 140, 40, 255], (y * W + x) * 4);
    }
    const chunks = await chunksOf(W, H, img);
    expect(chunks.map((c) => [c.col, c.row])).toEqual([[0, 0]]);
    const c = chunks[0] as ChunkResult;
    const at = (x: number, y: number): number[] => [...c.rgba.subarray(((y + 1) * T + x + 1) * 4, ((y + 1) * T + x + 1) * 4 + 4)];
    expect(at(98, 120)).toEqual([230, 140, 40, 0]);
    expect(at(600, 900)).toEqual([230, 140, 40, 0]);
    expect(c.visible).toBe(40 * 40);
  });
});

describe('split-hull rects', () => {
  /** Paint core and soft rects into a coverage map and check them against the chunk's alpha. */
  function checkRects(c: ChunkResult): { core: number; soft: number } {
    const cover = new Uint8Array(C * C);
    let overlap = 0;
    let coreTexels = 0;
    let softTexels = 0;
    for (const [rects, v] of [[c.core, 1], [c.soft, 2]] as const) {
      expect(rects.length % 4).toBe(0);
      for (let i = 0; i < rects.length; i += 4) {
        const [x, y, w, h] = rects.slice(i, i + 4) as [number, number, number, number];
        expect(Number.isInteger(x) && Number.isInteger(y) && w > 0 && h > 0).toBe(true);
        expect(x >= 0 && y >= 0 && x + w <= C && y + h <= C).toBe(true);
        for (let yy = y; yy < y + h; yy++) {
          for (let xx = x; xx < x + w; xx++) {
            if (cover[yy * C + xx]) overlap++;
            cover[yy * C + xx] = v;
            if (v === 1) {
              coreTexels++;
              // The depth pre-pass may only write texels that are (nearly) opaque.
              expect(c.rgba[((yy + PLATE_BORDER) * T + xx + PLATE_BORDER) * 4 + 3]).toBeGreaterThanOrEqual(PLATE_HULL.opaqueThreshold ?? 254);
            } else {
              softTexels++;
            }
          }
        }
      }
    }
    expect(overlap).toBe(0);
    let missed = 0;
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        // Visible: alpha above 1/255 (PLATE_HULL.visibleThreshold), less than one 8-bit step of blended colour.
        if ((c.rgba[((y + PLATE_BORDER) * T + x + PLATE_BORDER) * 4 + 3] as number) > (PLATE_HULL.visibleThreshold ?? 1) && !cover[y * C + x]) missed++;
      }
    }
    expect(missed).toBe(0);
    return { core: coreTexels, soft: softTexels };
  }

  test('core and soft rects are disjoint, inside the content, and cover every visible texel; cores are opaque', async () => {
    const chunks = await chunksOf(1400, 500, hills(1400, 500));
    expect(chunks).toHaveLength(2);
    for (const c of chunks) {
      const n = checkRects(c);
      expect(n.core).toBeGreaterThan(0);
      // The soft rects hug the edges: the opaque body is core, so they cover less than the visible texels.
      expect(n.soft).toBeLessThan(c.visible);
    }
  }, SLOW);

  test('the example plates hold the same invariants', async () => {
    for (const id of ['glade-landmark', 'glade-frame']) {
      const png = new URL(`../../art/plates/${id}.png`, import.meta.url).pathname;
      const info = await inspectPng(png, id);
      for await (const c of chunkSource(pngSource(png, info))) checkRects(c);
    }
  }, SLOW);
});

describe('hashes', () => {
  test('stable: the same pixels hash the same (from memory or PNG strips), one texel changed does not', async () => {
    const w = 1400;
    const h = 300;
    const img = hills(w, h);
    const a = await chunksOf(w, h, img);
    const b = await chunksOf(w, h, img.slice());
    expect(a.map((c) => c.hash)).toEqual(b.map((c) => c.hash));
    expect(a.every((c) => /^[0-9a-f]{16}$/.test(c.hash))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'spiritwood-hash-'));
    try {
      const png = join(dir, 'p.png');
      writeFileSync(png, encodePng(img, w, h));
      const fromPng: ChunkResult[] = [];
      for await (const c of chunkSource(pngSource(png, await inspectPng(png, 'p.png')))) fromPng.push(c);
      expect(fromPng.map((c) => c.hash)).toEqual(a.map((c) => c.hash));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // One opaque texel of chunk 1's content changes chunk 1 only.
    const edited = img.slice();
    expect(edited[(200 * w + 1300) * 4 + 3]).toBe(255);
    edited[(200 * w + 1300) * 4] = (edited[(200 * w + 1300) * 4] as number) ^ 1;
    const c = await chunksOf(w, h, edited);
    expect(c[0]?.hash).toBe(a[0]?.hash);
    expect(c[1]?.hash).not.toBe(a[1]?.hash);
    expect(pixelHash(new Uint8Array(16))).toBe(pixelHash(new Uint8Array(16)));
  }, SLOW);

  test('the committed plates re-hash to their bake record and manifest', async () => {
    const paths = artPaths();
    const lock = readLock(paths.lock);
    const manifest = parseManifest(JSON.parse(readFileSync(paths.generated, 'utf8')));
    const { plates, errors } = await scanPlates(paths);
    expect(errors).toEqual([]);
    expect(plates.map((p) => p.id)).toEqual(Object.keys(lock.plates).sort());
    for (const p of plates) {
      const measured = await measurePlate(p);
      const locked = lock.plates[p.id];
      expect(locked?.sourceHash).toBe(p.sourceHash);
      expect(measured.map((c) => [c.col, c.row, c.hash, c.core, c.soft])).toEqual(locked?.chunks.map((c) => [c.col, c.row, c.hash, c.core, c.soft]));
      const def = manifest.layers.find((l) => l.id === p.id) as PlateLayerDef;
      expect(def.chunks.map((c) => c.hash)).toEqual(measured.map((c) => c.hash));
      for (const c of def.chunks) {
        for (const f of CHUNK_FORMATS) expect(c.source[f]).toBe(`plates/${p.id}_${c.col}_${c.row}.${f}?v=${hash8(c.hash as string)}`);
      }
    }
  }, SLOW);
});

describe('npm run art (a scratch repository)', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });

  const SIDECAR = {
    parallax: [0.34, 0.34], origin: [2000, 300], texelScale: 2, minQuality: 'low', fog: 0.3, fogColor: '#25426c',
    desaturate: 0.1, tint: '#ffffff', area: 'glade',
  };

  function scratch(): ArtPaths {
    const root = mkdtempSync(join(tmpdir(), 'spiritwood-art-'));
    roots.push(root);
    const paths = artPaths(root);
    mkdirSync(paths.plates, { recursive: true });
    mkdirSync(paths.layers, { recursive: true });
    copyFileSync(new URL('../../public/layers/forest.base.manifest.json', import.meta.url), paths.base);
    return paths;
  }

  function writePlate(paths: ArtPaths, id: string, rgba: Uint8Array, w: number, h: number, sidecar: Record<string, unknown> = SIDECAR): void {
    writeFileSync(join(paths.plates, `${id}.png`), encodePng(rgba, w, h));
    writeFileSync(join(paths.plates, `${id}.json`), `${JSON.stringify(sidecar, null, 2)}\n`);
  }

  /** Encoders that record every call and return small deterministic bytes (the real ones take seconds). */
  function spyEncoders(): { calls: string[]; encoders: Encoders } {
    const calls: string[] = [];
    const make = (f: ChunkFormat) => (rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> => {
      calls.push(`${f}:${pixelHash(rgba)}`);
      return Promise.resolve(new TextEncoder().encode(`${f} ${w}×${h} ${pixelHash(rgba)}`));
    };
    return { calls, encoders: { ktx2: make('ktx2'), webp: make('webp'), png: make('png') } };
  }

  const opts = (encoders: Encoders, extra: ArtOptions = {}): ArtOptions => ({ encoders, atlases: ATLASES, level: LEVEL, ...extra });

  /** Everything the bake wrote: path → bytes. */
  function snapshot(paths: ArtPaths): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const n of readdirSync(dir).sort()) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else out.set(p, readFileSync(p).toString('base64'));
      }
    };
    walk(paths.layers);
    walk(join(paths.root, 'art'));
    return out;
  }

  test('bakes, splices and records; --check then passes without encoding or writing anything', async () => {
    const paths = scratch();
    writePlate(paths, 'hills', hills(1400, 300), 1400, 300);
    const bake = spyEncoders();
    const r = await runArt(paths, opts(bake.encoders));
    expect(r.encoded).toBe(2);
    expect(bake.calls.map((c) => c.split(':')[0])).toEqual(['ktx2', 'webp', 'png', 'ktx2', 'webp', 'png']);
    const manifest = parseManifest(JSON.parse(readFileSync(paths.generated, 'utf8')));
    const plate = manifest.layers.find((l) => l.id === 'hills') as PlateLayerDef;
    expect(plate.parallax).toEqual([0.34, 0.34]);
    expect(plate.chunks.map((c) => [c.col, c.row])).toEqual([[0, 0], [1, 0]]);
    for (const c of plate.chunks) {
      for (const f of CHUNK_FORMATS) expect(existsSync(join(paths.layers, pathnameOf(c.source[f] as string)))).toBe(true);
    }
    expect(readLock(paths.lock).plates.hills?.chunks).toHaveLength(2);

    const before = snapshot(paths);
    const check = spyEncoders();
    const c = await runArt(paths, opts(check.encoders, { check: true }));
    expect(c.problems).toEqual([]);
    expect(check.calls).toEqual([]);
    expect(snapshot(paths)).toEqual(before);
    expect(c.manifestText).toBe(readFileSync(paths.generated, 'utf8'));
  }, SLOW);

  test('--check reports every kind of staleness, never encoding or writing', async () => {
    const paths = scratch();
    writePlate(paths, 'hills', hills(1400, 300), 1400, 300);
    await runArt(paths, opts(spyEncoders().encoders));
    const check = spyEncoders();
    const problems = async (): Promise<string[]> => {
      const before = snapshot(paths);
      const r = await runArt(paths, opts(check.encoders, { check: true }));
      expect(snapshot(paths)).toEqual(before);
      return r.problems;
    };
    const png = join(paths.plates, 'hills.png');
    const json = join(paths.plates, 'hills.json');
    const pngBytes = readFileSync(png);
    const jsonText = readFileSync(json, 'utf8');

    writeFileSync(png, encodePng(hills(1400, 300, 1.3, 1100), 1400, 300));
    expect(await problems()).toEqual(['hills: the image or sidecar changed since the last bake']);
    writeFileSync(png, pngBytes);

    writeFileSync(json, JSON.stringify({ ...SIDECAR, fog: 0.4 }));
    expect(await problems()).toEqual([
      'hills: the image or sidecar changed since the last bake',
      'public/layers/forest.manifest.json is not the splice of public/layers/forest.base.manifest.json and the plates',
    ]);
    // A comment-only edit is not a change.
    writeFileSync(json, JSON.stringify({ _note: 'fine', ...SIDECAR }));
    expect(await problems()).toEqual([]);
    writeFileSync(json, jsonText);

    const webp = join(paths.chunks, 'hills_1_0.webp');
    const webpBytes = readFileSync(webp);
    writeFileSync(webp, 'edited');
    expect(await problems()).toEqual(['public/layers/plates/hills_1_0.webp does not match the bake record (edited, or left over from an interrupted bake)']);
    rmSync(webp);
    expect(await problems()).toEqual(['public/layers/plates/hills_1_0.webp is missing']);
    writeFileSync(webp, webpBytes);

    const generated = readFileSync(paths.generated, 'utf8');
    writeFileSync(paths.generated, generated.replace('"fog": 0.3', '"fog": 0.31'));
    expect(await problems()).toEqual(['public/layers/forest.manifest.json is not the splice of public/layers/forest.base.manifest.json and the plates']);
    writeFileSync(paths.generated, generated);

    writePlate(paths, 'crag', hills(600, 200), 600, 200, { ...SIDECAR, parallax: [0.46, 0.46] });
    expect(await problems()).toEqual([
      'crag: not baked yet',
      'public/layers/forest.manifest.json is not the splice of public/layers/forest.base.manifest.json and the plates',
    ]);
    rmSync(join(paths.plates, 'crag.png'));
    rmSync(join(paths.plates, 'crag.json'));
    rmSync(png);
    rmSync(json);
    expect(await problems()).toEqual([
      'hills: in art/bake.lock.json, but art/plates/hills.png is gone',
      'public/layers/forest.manifest.json is not the splice of public/layers/forest.base.manifest.json and the plates',
    ]);
    expect(check.calls).toEqual([]);
  }, SLOW);

  test('a re-bake encodes only the chunks whose pixels changed and removes stale chunk files', async () => {
    const paths = scratch();
    writePlate(paths, 'hills', hills(1400, 300), 1400, 300);
    const first = await runArt(paths, opts(spyEncoders().encoders));
    const locked = first.lock.plates.hills?.chunks ?? [];

    // Repaint x ≥ 1100: only chunk (1, 0) sees it (chunk 0 reads source x −border … C + border − 1).
    writeFileSync(join(paths.plates, 'hills.png'), encodePng(hills(1400, 300, 1.3, 1100), 1400, 300));
    const again = spyEncoders();
    const r = await runArt(paths, opts(again.encoders));
    expect([r.encoded, r.reused]).toEqual([1, 1]);
    const chunks = r.lock.plates.hills?.chunks ?? [];
    expect(chunks[0]?.hash).toBe(locked[0]?.hash);
    expect(chunks[1]?.hash).not.toBe(locked[1]?.hash);
    expect(again.calls).toEqual(CHUNK_FORMATS.map((f) => `${f}:${chunks[1]?.hash}`));
    const plate = r.manifest.layers.find((l) => l.id === 'hills') as PlateLayerDef;
    expect(plate.chunks[1]?.source.webp).toBe(`plates/hills_1_0.webp?v=${hash8(chunks[1]?.hash as string)}`);

    // Shrink the plate to one chunk: the second chunk's files go.
    writeFileSync(join(paths.plates, 'hills.png'), encodePng(hills(900, 300), 900, 300));
    const shrink = await runArt(paths, opts(spyEncoders().encoders));
    expect(shrink.lock.plates.hills?.chunks.map((c) => [c.col, c.row])).toEqual([[0, 0]]);
    expect(readdirSync(paths.chunks).sort()).toEqual(['hills_0_0.ktx2', 'hills_0_0.png', 'hills_0_0.webp']);

    // A plate that is gone takes its files with it.
    rmSync(join(paths.plates, 'hills.png'));
    rmSync(join(paths.plates, 'hills.json'));
    const gone = await runArt(paths, opts(spyEncoders().encoders));
    expect(gone.manifest.layers.some((l) => l.kind === 'plate')).toBe(false);
    expect(readdirSync(paths.chunks)).toEqual([]);
    expect(readLock(paths.lock).plates).toEqual({});
  }, SLOW);

  test('a new tool version re-encodes every chunk, even where the pixels are unchanged', async () => {
    const paths = scratch();
    writePlate(paths, 'hills', hills(1400, 300), 1400, 300);
    await runArt(paths, opts(spyEncoders().encoders));
    const lock = JSON.parse(readFileSync(paths.lock, 'utf8')) as Record<string, unknown>;
    writeFileSync(paths.lock, JSON.stringify({ ...lock, tool: 'spiritwood-art/0' }));
    const check = await runArt(paths, opts(spyEncoders().encoders, { check: true }));
    expect(check.problems).toEqual([`hills: baked by spiritwood-art/0, the tool is now ${ART_TOOL_VERSION}`]);
    const again = spyEncoders();
    const r = await runArt(paths, opts(again.encoders));
    expect([r.encoded, r.reused]).toEqual([2, 0]);
    expect(again.calls).toHaveLength(2 * CHUNK_FORMATS.length);
    expect(readLock(paths.lock).tool).toBe(ART_TOOL_VERSION);
  }, SLOW);

  test('an art plate can\'t take the id of a base layer or the demo plate, and never deletes the demo plate\'s files', async () => {
    const paths = scratch();
    // The demo plate (npm run plates) writes its chunks into the same folder.
    mkdirSync(paths.chunks, { recursive: true });
    const demo = CHUNK_FORMATS.map((f) => `L3-plate-treeline_0_0.${f}`).sort();
    for (const n of demo) writeFileSync(join(paths.chunks, n), 'demo');
    writePlate(paths, 'L3-plate-treeline', hills(600, 200), 600, 200);
    writePlate(paths, 'L4-mid-forest', hills(600, 200), 600, 200, { ...SIDECAR, parallax: [0.46, 0.46] });
    const e = await runArt(paths, opts(spyEncoders().encoders)).then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(ArtError);
    expect((e as Error).message).toContain('art/plates/L3-plate-treeline.png: the id "L3-plate-treeline" is taken by the demo plate of npm run plates');
    expect((e as Error).message).toContain('art/plates/L4-mid-forest.png: the id "L4-mid-forest" is taken by a layer of public/layers/forest.base.manifest.json');
    for (const n of ['L3-plate-treeline', 'L4-mid-forest']) {
      rmSync(join(paths.plates, `${n}.png`));
      rmSync(join(paths.plates, `${n}.json`));
    }
    // Even a bake record that names the demo plate (written before the rule) can't make a bake delete its files.
    writeFileSync(paths.lock, JSON.stringify({ version: 1, tool: ART_TOOL_VERSION, plates: { 'L3-plate-treeline': { sourceHash: 'x', width: 1, height: 1, chunks: [] } } }));
    await runArt(paths, opts(spyEncoders().encoders));
    expect(readdirSync(paths.chunks).sort()).toEqual(demo);
  }, SLOW);

  test('every problem is reported at once and nothing is written', async () => {
    const paths = scratch();
    writePlate(paths, 'good', hills(600, 200), 600, 200);
    writePlate(paths, 'fine', hills(600, 200), 600, 200, { ...SIDECAR, parallax: [0.46, 0.46] });
    const snapshotBefore = (): Map<string, string> => snapshot(paths);
    const fail = async (): Promise<string> => {
      const before = snapshotBefore();
      const spy = spyEncoders();
      const e = await runArt(paths, opts(spy.encoders)).then(() => null, (err: unknown) => err);
      expect(e).toBeInstanceOf(ArtError);
      expect(spy.calls).toEqual([]);
      expect(snapshot(paths)).toEqual(before);
      return (e as Error).message;
    };
    writeFileSync(join(paths.plates, 'bad.json'), JSON.stringify({ ...SIDECAR, texelScale: 1, fogColour: '#ffffff' }));
    writeFileSync(join(paths.plates, 'bad.png'), encodePng(hills(64, 64), 64, 64));
    writeFileSync(join(paths.plates, 'lonely.json'), JSON.stringify(SIDECAR));
    writeFileSync(join(paths.plates, 'notes.psd'), 'layers');
    writeFileSync(join(paths.plates, 'opaque.png'), await sharp({ create: { width: 64, height: 64, channels: 3, background: '#406080' } }).png().toBuffer());
    writeFileSync(join(paths.plates, 'opaque.json'), JSON.stringify({ ...SIDECAR, parallax: [0.58, 0.58] }));
    const message = await fail();
    expect(message).toMatch(/^art\/plates has 4 problems:/);
    expect(message).toContain('art/plates/notes.psd: unexpected file');
    expect(message).toContain('art/plates/bad.json: unknown key "fogColour" (did you mean "fogColor"?)');
    expect(message).toContain('art/plates/lonely.json: no image lonely.png next to it');
    expect(message).toContain('art/plates/opaque.png: has no alpha channel');
    for (const n of ['bad.json', 'bad.png', 'lonely.json', 'notes.psd', 'opaque.png', 'opaque.json']) rmSync(join(paths.plates, n));

    // A splice problem names the plate.
    writePlate(paths, 'tied', hills(600, 200), 600, 200, { ...SIDECAR, parallax: [0.4, 0.4] });
    expect(await fail()).toMatch(/splicing the plates into public\/layers\/forest\.base\.manifest\.json failed: plate "tied": parallax fx 0\.4 ties with base layer "L4-mid-forest"/);
    rmSync(join(paths.plates, 'tied.png'));
    rmSync(join(paths.plates, 'tied.json'));

    // Over budget: a plate the budget can't hold is refused with the report.
    writePlate(paths, 'vast', hills(3000, 1500), 3000, 1500, { ...SIDECAR, parallax: [0.58, 0.58], texelScale: 1.5, origin: [2500, -800] });
    const tight = { ...JSON.parse(readFileSync(paths.base, 'utf8')) as Record<string, unknown>, textureBudgetMB: { high: 32, medium: 30, low: 28 } };
    writeFileSync(paths.base, JSON.stringify(tight));
    const over = await fail();
    expect(over).toMatch(/the plates do not fit the texture budget \(nothing was written\)/);
    expect(over).toMatch(/ERROR: high: visible plates need .* over the 32 MB budget/);
  }, SLOW);
});
