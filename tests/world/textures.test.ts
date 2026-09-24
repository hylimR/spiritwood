import { afterEach, describe, expect, test, vi } from 'vitest';
import { Assets, Texture, BufferImageSource } from 'pixi.js';
import {
  chooseTextureUrl, IMAGE_TIMEOUT_MS, ktx2Usable, KTX2_TIMEOUT_MS, loadTextureSource, textureBytes, textureUrlUse,
  trackedTextureUrls, unloadTextureSource, type TextureFormatSupport,
} from '../../src/assets/textures.ts';
import { PLATE_LOAD_TIMEOUT_MS } from '../../src/assets/plateLayout.ts';
import { SimpleTextureBudget } from '../../src/render/util/texture.ts';
import type { TextureSourceDef } from '../../src/contracts/assets.ts';

const BASE = 'https://example.com/game/layers/forest.manifest.json';
const ALL: TextureSourceDef = { ktx2: 'plates/c.ktx2', webp: 'plates/c.webp', png: 'plates/c.png' };

describe('ktx2Usable', () => {
  test('needs a transcode target the GPU samples', () => {
    expect(ktx2Usable({}, true)).toBe(false);
    for (const ext of ['bptc', 's3tc', 'etc', 'astc'] as const) expect(ktx2Usable({ [ext]: {} }, true)).toBe(true);
  });

  test('is off when the CSP forbids eval (the Emscripten transcoder cannot start)', () => {
    expect(ktx2Usable({ bptc: {}, s3tc: {}, etc: {}, astc: {} }, false)).toBe(false);
  });
});

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

describe('URL leases: an old owner never unloads a texture a newer owner uses', () => {
  const WEBP_ONLY: TextureFormatSupport = { ktx2: false, webp: true };
  const texture = (): Texture => new Texture({ source: new BufferImageSource({ resource: new Uint8Array(16 * 8 * 4), width: 16, height: 8 }) });
  const deferred = (): { promise: Promise<Texture>; resolve: (t: Texture) => void } => {
    let resolve!: (t: Texture) => void;
    const promise = new Promise<Texture>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('every image load has the plate deadline', () => {
    expect(IMAGE_TIMEOUT_MS).toBe(PLATE_LOAD_TIMEOUT_MS);
    expect(KTX2_TIMEOUT_MS).toBeLessThanOrEqual(IMAGE_TIMEOUT_MS);
  });

  test('two generations load one URL: the texture is unloaded when the last lease goes', async () => {
    const tex = texture();
    vi.spyOn(Assets, 'load').mockImplementation((() => Promise.resolve(tex)) as typeof Assets.load);
    const unload = vi.spyOn(Assets, 'unload').mockImplementation((() => Promise.resolve()) as typeof Assets.unload);
    const budget = new SimpleTextureBudget(1e9);
    const src: TextureSourceDef = { webp: 'plates/lease_0_0.webp?v=0123abcd' };
    const old = await loadTextureSource(src, BASE, WEBP_ONLY, budget, 'lease#1:0:0');
    const cur = await loadTextureSource(src, BASE, WEBP_ONLY, budget, 'lease#2:0:0');
    expect(cur.url).toBe(old.url);
    expect(textureUrlUse(old.url)).toEqual({ leases: 2, pending: 0 });
    // The old generation lets go (a hot reload): its budget entry goes, the texture stays.
    await unloadTextureSource(old.url, budget, 'lease#1:0:0');
    expect(unload).not.toHaveBeenCalled();
    expect(budget.totalBytes).toBe(16 * 8 * 4);
    await unloadTextureSource(cur.url, budget, 'lease#2:0:0');
    expect(unload.mock.calls.map((c) => String(c[0]))).toEqual([cur.url]);
    expect(budget.totalBytes).toBe(0);
    expect(textureUrlUse(cur.url)).toEqual({ leases: 0, pending: 0 });
    // Releasing twice can't take someone else's lease.
    await unloadTextureSource(cur.url, budget, 'lease#2:0:0');
    expect(unload).toHaveBeenCalledTimes(1);
  });

  test('a load past its deadline fails; landing late, it unloads only if nobody else holds or awaits the URL', async () => {
    vi.useFakeTimers();
    const pending = new Map<string, { promise: Promise<Texture>; resolve: (t: Texture) => void }>();
    vi.spyOn(Assets, 'load').mockImplementation(((url: string) => {
      let d = pending.get(url);
      if (!d) {
        d = deferred();
        pending.set(url, d);
      }
      return d.promise;
    }) as typeof Assets.load);
    const unload = vi.spyOn(Assets, 'unload').mockImplementation((() => Promise.resolve()) as typeof Assets.unload);
    const budget = new SimpleTextureBudget(1e9);
    const shared: TextureSourceDef = { webp: 'plates/late_0_0.webp?v=0123abcd' };
    const url = new URL(shared.webp as string, BASE).href;

    const first = loadTextureSource(shared, BASE, WEBP_ONLY, budget, 'late#1:0:0').then(() => 'loaded', (e: unknown) => String(e));
    await vi.advanceTimersByTimeAsync(IMAGE_TIMEOUT_MS - 1);
    expect(textureUrlUse(url)).toEqual({ leases: 0, pending: 1 });
    await vi.advanceTimersByTimeAsync(2);
    expect(await first).toContain(`timed out after ${IMAGE_TIMEOUT_MS} ms`);
    // A newer owner asks for the same URL; the old request then lands late.
    const second = loadTextureSource(shared, BASE, WEBP_ONLY, budget, 'late#2:0:0');
    pending.get(url)?.resolve(texture());
    const got = await second;
    expect(got.url).toBe(url);
    expect(unload).not.toHaveBeenCalled();
    expect(textureUrlUse(url)).toEqual({ leases: 1, pending: 0 });
    expect(budget.totalBytes).toBe(16 * 8 * 4);

    // Alone, a late arrival is unloaded straight away.
    const lone: TextureSourceDef = { webp: 'plates/lone_0_0.webp?v=0123abcd' };
    const loneUrl = new URL(lone.webp as string, BASE).href;
    const third = loadTextureSource(lone, BASE, WEBP_ONLY, budget, 'lone#1:0:0').then(() => 'loaded', (e: unknown) => String(e));
    await vi.advanceTimersByTimeAsync(IMAGE_TIMEOUT_MS + 1);
    expect(await third).toMatch(/timed out/);
    pending.get(loneUrl)?.resolve(texture());
    await vi.advanceTimersByTimeAsync(0);
    expect(unload.mock.calls.map((c) => String(c[0]))).toEqual([loneUrl]);
    expect(textureUrlUse(loneUrl)).toEqual({ leases: 0, pending: 0 });
    expect(budget.totalBytes).toBe(16 * 8 * 4);
  });

  test('a load that times out and never arrives leaves nothing tracked', async () => {
    vi.useFakeTimers();
    vi.spyOn(Assets, 'load').mockImplementation((() => new Promise<Texture>(() => undefined)) as typeof Assets.load);
    const before = trackedTextureUrls();
    const lost = loadTextureSource({ webp: 'plates/lost_0_0.webp?v=0123abcd' }, BASE, WEBP_ONLY, new SimpleTextureBudget(1e9), 'lost#1:0:0')
      .then(() => 'loaded', (e: unknown) => String(e));
    expect(trackedTextureUrls()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(IMAGE_TIMEOUT_MS + 1);
    expect(await lost).toMatch(/timed out/);
    expect(trackedTextureUrls()).toBe(before);
  });
});
