import { afterEach, describe, expect, test, vi } from 'vitest';
import { Assets, Texture, BufferImageSource } from 'pixi.js';
import {
  chooseTextureUrl, KTX2_TIMEOUT_MS, loadTextureSource, textureBytes, type TextureFormatSupport,
} from '../../src/assets/textures.ts';
import { SimpleTextureBudget } from '../../src/render/util/texture.ts';
import type { TextureSourceDef } from '../../src/contracts/assets.ts';

const BASE = 'https://example.com/game/layers/forest.manifest.json';
const ALL: TextureSourceDef = { ktx2: 'plates/c.ktx2', webp: 'plates/c.webp', png: 'plates/c.png' };

describe('chooseTextureUrl', () => {
  const support = (ktx2: boolean, webp: boolean): TextureFormatSupport => ({ ktx2, webp });
  const cases: [TextureSourceDef, TextureFormatSupport, string | null][] = [
    [ALL, support(true, true), 'plates/c.ktx2'],
    [ALL, support(true, false), 'plates/c.ktx2'],
    [ALL, support(false, true), 'plates/c.webp'],
    [ALL, support(false, false), 'plates/c.png'],
    [{ ktx2: 'a.ktx2', png: 'a.png' }, support(false, true), 'a.png'],
    [{ ktx2: 'a.ktx2', webp: 'a.webp' }, support(false, true), 'a.webp'],
    [{ ktx2: 'a.ktx2', webp: 'a.webp' }, support(false, false), null],
    [{ ktx2: 'a.ktx2' }, support(false, true), null],
    [{ ktx2: 'a.ktx2' }, support(true, false), 'a.ktx2'],
    [{ webp: 'a.webp' }, support(true, false), null],
    [{ png: 'a.png' }, support(true, true), 'a.png'],
    [{ procedural: 'forest-kit' }, support(true, true), null],
  ];
  for (const [src, sup, expected] of cases) {
    test(`${JSON.stringify(src)} with ${JSON.stringify(sup)} → ${expected}`, () => {
      const url = chooseTextureUrl(src, sup, BASE);
      expect(url).toBe(expected === null ? null : new URL(expected, BASE).href);
    });
  }

  test('paths resolve against the manifest URL, absolute URLs pass through', () => {
    expect(chooseTextureUrl({ png: '../x/y.png' }, support(false, false), BASE)).toBe('https://example.com/game/x/y.png');
    expect(chooseTextureUrl({ png: 'https://cdn.example.org/y.png' }, support(false, false), BASE)).toBe('https://cdn.example.org/y.png');
  });
});

describe('textureBytes', () => {
  test('RGBA8 without mips = 4 B/texel; compressed with mips = 1 B/texel + ⅓', () => {
    const rgba = new Texture({ source: new BufferImageSource({ resource: new Uint8Array(64 * 32 * 4), width: 64, height: 32 }) });
    expect(textureBytes(rgba)).toBe(64 * 32 * 4);
    const bc7 = new Texture({
      source: new BufferImageSource({ resource: new Uint8Array(16), width: 256, height: 256, format: 'bc7-rgba-unorm', mipLevelCount: 9 }),
    });
    expect(textureBytes(bc7)).toBe(Math.ceil((256 * 256 * 4) / 3));
  });
});

describe('loadTextureSource KTX2 fallback', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test('a KTX2 load that never settles (worker/WASM blocked) falls back to WebP and disables KTX2 for the session', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('document', { baseURI: 'https://example.com/game/' });
    const webp = new Texture({ source: new BufferImageSource({ resource: new Uint8Array(16 * 8 * 4), width: 16, height: 8 }) });
    const load = vi.spyOn(Assets, 'load').mockImplementation(((url: string) =>
      (url.endsWith('.ktx2') ? new Promise(() => undefined) : Promise.resolve(webp))) as typeof Assets.load);
    const budget = new SimpleTextureBudget(1e9);
    const support: TextureFormatSupport = { ktx2: true, webp: true };

    const pending = loadTextureSource(ALL, BASE, support, budget, 'chunk:a');
    await vi.advanceTimersByTimeAsync(KTX2_TIMEOUT_MS + 10);
    const first = await pending;
    expect(first.url).toBe(new URL('plates/c.webp', BASE).href);
    expect(first.texture).toBe(webp);
    expect(budget.totalBytes).toBe(16 * 8 * 4);

    // KTX2 is now off for the session: the next chunk goes straight to WebP.
    load.mockClear();
    const second = await loadTextureSource(ALL, BASE, support, budget, 'chunk:b');
    expect(second.url).toBe(new URL('plates/c.webp', BASE).href);
    expect(load.mock.calls.map((c) => String(c[0]))).toEqual([new URL('plates/c.webp', BASE).href]);
  });
});
