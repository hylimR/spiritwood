import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, test, vi } from 'vitest';
import {
  PLATE_UPDATED_EVENT, PlateHotReload, structuralDifference, type HotChannel, type PlateHotTarget,
} from '../../src/assets/hotReload.ts';
import { parseManifest } from '../../src/assets/manifest.ts';
import { hash8 } from '../../src/assets/plateLayout.ts';
import { spliceManifest } from '../../src/assets/splice.ts';
import type { LayerManifest, PlateLayerDef } from '../../src/contracts/assets.ts';
import { levelSize, runArt } from '../../tools/art/bake.ts';
import type { AtlasMeasure } from '../../tools/art/budget.ts';
import { pixelHash } from '../../tools/art/chunks.ts';
import {
  ArtDevServer, devBakePlate, STABLE_MS, StableDebouncer, type Clock, type DevBakeRequest, type DevResponse, type HotPayload,
} from '../../tools/art/dev.ts';
import type { Encoders } from '../../tools/art/encode.ts';
import { artPaths, type ArtPaths } from '../../tools/art/paths.ts';
import { BakeWorkerClient, type WorkerLike } from '../../tools/art/bakeWorker.ts';
import type { WorkerReply, WorkerRequest } from '../../tools/art/dev-worker.ts';
import { spiritwoodArt } from '../../tools/art/vite-plugin.ts';
import { encodePng } from '../../tools/preview/png.ts';

const SLOW = 60_000;
const LAYERS = new URL('../../public/layers/', import.meta.url);
const generated = parseManifest(JSON.parse(readFileSync(new URL('forest.manifest.json', LAYERS), 'utf8')));
const ATLASES: AtlasMeasure[] = [{ id: 'forest-kit', width: 2048, height: 2048, bytes: 22_369_621 }];
const LEVEL = levelSize(artPaths());

const plateOf = (m: LayerManifest, id: string): PlateLayerDef => m.layers.find((l) => l.id === id) as PlateLayerDef;

/** A copy of `m` with edits applied to its JSON (the replaced map carried over). */
function edit(m: LayerManifest, fn: (json: LayerManifest) => void): LayerManifest {
  const json = JSON.parse(JSON.stringify(m)) as LayerManifest;
  fn(json);
  return parseManifest(json);
}

function repainted(m: LayerManifest, id: string): LayerManifest {
  return edit(m, (j) => {
    for (const c of plateOf(j, id).chunks) {
      c.hash = 'feedfacecafebeef';
      c.source = { webp: c.source.webp?.replace(/\?v=.*$/, '?v=feedface') };
    }
  });
}

class FakeHot implements HotChannel {
  private readonly handlers = new Map<string, ((data: unknown) => void)[]>();

  on(event: string, cb: (data: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }

  emit(event: string, data: unknown): void {
    for (const cb of this.handlers.get(event) ?? []) cb(data);
  }
}

class FakeTarget implements PlateHotTarget {
  readonly manifestUrl = 'http://localhost/layers/forest.manifest.json';
  manifest: LayerManifest;
  readonly reloads: string[] = [];
  accept = true;

  constructor(manifest: LayerManifest) {
    this.manifest = manifest;
  }

  currentManifest(): LayerManifest {
    return this.manifest;
  }

  reloadPlate(def: PlateLayerDef, manifest: LayerManifest): boolean {
    this.reloads.push(def.id);
    if (this.accept) this.manifest = manifest;
    return this.accept;
  }
}

function setup(next: LayerManifest | (() => Promise<LayerManifest>)) {
  const hot = new FakeHot();
  const fetchManifest = vi.fn(typeof next === 'function' ? next : () => Promise.resolve(next));
  const reloadPage = vi.fn();
  const reloader = new PlateHotReload(hot, { fetchManifest, reloadPage });
  const target = new FakeTarget(generated);
  reloader.register(target);
  return { hot, target, reloadPage, fetchManifest, reloader };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('page side: spiritwood:plate-updated', () => {
  test('a pixel-only change reloads exactly that layer, once, and the target keeps the new manifest', async () => {
    const next = repainted(generated, 'glade-frame');
    const { hot, target, reloadPage, fetchManifest } = setup(next);
    hot.emit(PLATE_UPDATED_EVENT, { id: 'glade-frame' });
    await settle();
    expect(fetchManifest).toHaveBeenCalledWith(target.manifestUrl);
    expect(target.reloads).toEqual(['glade-frame']);
    expect(reloadPage).not.toHaveBeenCalled();
    expect(target.currentManifest()).toBe(next);
  });

  test('colour, origin and texel scale changes are not structural either', async () => {
    const next = edit(generated, (j) => Object.assign(plateOf(j, 'glade-landmark'), { fog: 0.7, tint: '#eeddcc', origin: [250, -30], texelScale: 1.75 }));
    expect(structuralDifference(generated, next)).toBeNull();
    const { hot, target, reloadPage } = setup(next);
    hot.emit(PLATE_UPDATED_EVENT, { id: 'glade-landmark' });
    await settle();
    expect([target.reloads, reloadPage.mock.calls.length]).toEqual([['glade-landmark'], 0]);
  });

  const L3 = generated.layers.find((l) => l.id === 'L3-misty-trunks');
  test.each([
    ['a parallax change', edit(generated, (j) => {
      plateOf(j, 'glade-frame').parallax = [0.62, 0.62];
    })],
    ['a minQuality change', edit(generated, (j) => {
      plateOf(j, 'glade-frame').minQuality = 'high';
    })],
    ['a plate added', parseManifest(JSON.parse(JSON.stringify(spliceManifest(generated, [{ layer: { ...plateOf(generated, 'glade-frame'), id: 'new-plate', parallax: [0.46, 0.46] } }]))))],
    ['a plate deleted', edit(generated, (j) => {
      j.layers = j.layers.filter((l) => l.id !== 'glade-landmark');
    })],
    ['a replaced layer (replaces)', edit(generated, (j) => {
      j.layers = j.layers.filter((l) => l.id !== 'L3-misty-trunks');
      j.replaced = { 'glade-landmark': L3 as NonNullable<typeof L3> };
    })],
    ['a kit layer edited in the base', edit(generated, (j) => {
      Object.assign(j.layers.find((l) => l.id === 'L4-mid-forest') as object, { fog: 0.9 });
    })],
  ])('%s reloads the page', async (_name, next) => {
    expect(structuralDifference(generated, next)).not.toBeNull();
    const { hot, target, reloadPage } = setup(next);
    hot.emit(PLATE_UPDATED_EVENT, { id: 'glade-frame' });
    await settle();
    expect(reloadPage).toHaveBeenCalledTimes(1);
    expect(target.reloads).toEqual([]);
    expect(target.currentManifest()).toBe(generated);
  });

  test('an unknown id, a failed fetch or a target that can\'t reload the layer reload the page; junk is ignored', async () => {
    const unknown = setup(generated);
    expect(await unknown.reloader.handle({ id: 'no-such-plate' })).toBe('full-reload');
    expect(await unknown.reloader.handle({ id: 'L4-mid-forest' })).toBe('full-reload');
    const offline = setup(() => Promise.reject(new Error('offline')));
    expect(await offline.reloader.handle({ id: 'glade-frame' })).toBe('full-reload');
    const stubborn = setup(repainted(generated, 'glade-frame'));
    stubborn.target.accept = false;
    expect(await stubborn.reloader.handle({ id: 'glade-frame' })).toBe('full-reload');
    const junk = setup(generated);
    for (const data of [null, 'glade-frame', { id: 7 }, {}]) expect(await junk.reloader.handle(data)).toBe('ignored');
    expect(junk.fetchManifest).not.toHaveBeenCalled();
  });

  test('structuralDifference names what a live reload can\'t absorb', () => {
    expect(structuralDifference(generated, edit(generated, () => undefined))).toBeNull();
    const frame = generated.layers.findIndex((l) => l.id === 'glade-frame');
    expect(structuralDifference(generated, edit(generated, (j) => {
      plateOf(j, 'glade-frame').parallax = [0.62, 0.62];
    }))).toBe(`layer ${frame}: plate:glade-frame@0.6/0.6:medium → plate:glade-frame@0.62/0.62:medium`);
    // The same layer list with a different replaced map (structuralDifference does not validate).
    const replaced: LayerManifest = { ...generated, replaced: { 'glade-landmark': L3 as NonNullable<typeof L3> } };
    expect(structuralDifference(generated, replaced)).toBe('replaced layers');
    expect(structuralDifference(replaced, { ...replaced, replaced: { 'glade-frame': L3 as NonNullable<typeof L3> } })).toBe('replaced layer of glade-landmark');
    expect(structuralDifference(generated, edit(generated, (j) => {
      j.textureBudgetMB = { ...j.textureBudgetMB, low: 40 };
    }))).toBe('budgets or atlases');
  });

  test('messages are handled one at a time, in order; an unregistered target hears nothing', async () => {
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = repainted(generated, 'glade-frame');
    const { hot, target, reloader } = setup(async () => {
      order.push(`fetch ${order.length}`);
      if (order.length === 1) await gate;
      return next;
    });
    const reload = target.reloadPlate.bind(target);
    target.reloadPlate = (def, m) => {
      order.push(`reload ${def.id}`);
      return reload(def, m);
    };
    hot.emit(PLATE_UPDATED_EVENT, { id: 'glade-frame' });
    hot.emit(PLATE_UPDATED_EVENT, { id: 'glade-frame' });
    await settle();
    expect(order).toEqual(['fetch 0']);
    release();
    await settle();
    expect(order).toEqual(['fetch 0', 'reload glade-frame', 'fetch 2', 'reload glade-frame']);
    const quiet = new FakeTarget(generated);
    const off = reloader.register(quiet);
    off();
    hot.emit(PLATE_UPDATED_EVENT, { id: 'glade-frame' });
    await settle();
    expect(quiet.reloads).toEqual([]);
  });
});

/** A clock the test advances by hand. */
class FakeClock implements Clock {
  t = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private seq = 0;

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    this.timers.push({ at: this.t + ms, fn, id: ++this.seq });
    return this.seq;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((x) => x.id !== handle);
  }

  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const next = this.timers[0];
      if (!next || next.at > end) break;
      this.timers.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
  }
}

describe('dev server side', () => {
  test('writes are processed once the files keep their size for 200 ms', () => {
    const clock = new FakeClock();
    const sizes = new Map<string, number>([['a.png', 10], ['a.json', 5]]);
    const fired: string[] = [];
    const d = new StableDebouncer(clock, (p) => sizes.get(p) ?? -1, (id) => fired.push(id));
    d.touch('a', ['a.png', 'a.json']);
    // A paint program writes in steps: the size keeps changing, so nothing fires.
    for (let i = 0; i < 10; i++) {
      clock.advance(50);
      sizes.set('a.png', 10 + i * 100);
    }
    expect(fired).toEqual([]);
    clock.advance(STABLE_MS - 1);
    expect(fired).toEqual([]);
    clock.advance(100);
    expect(fired).toEqual(['a']);
    expect(d.waiting).toBe(0);
    // A deleted file (size −1) is stable too.
    sizes.delete('a.png');
    d.touch('a', ['a.png', 'a.json']);
    clock.advance(STABLE_MS + 100);
    expect(fired).toEqual(['a', 'a']);
    d.close();
  });

  const roots: string[] = [];
  afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const SIDECAR = {
    parallax: [0.34, 0.34], origin: [2000, 300], texelScale: 2, minQuality: 'low', fog: 0.3, fogColor: '#25426c',
    desaturate: 0.1, tint: '#ffffff', area: 'glade',
  };

  function hills(w: number, h: number, bump = 0, bumpX = 0): Uint8Array {
    const rgba = new Uint8Array(w * h * 4);
    for (let x = 0; x < w; x++) {
      const b = x >= bumpX ? bump : 0;
      const top = Math.round(h * 0.35 + 30 * Math.sin(x * 0.013) + 12 * Math.sin(x * 0.051 + b));
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 4;
        rgba[o] = 30 + (x % 50) + b * 20;
        rgba[o + 1] = 50 + (y % 40);
        rgba[o + 2] = 80;
        rgba[o + 3] = Math.round(Math.min(1, Math.max(0, (y - top) / 6)) * 255);
      }
    }
    return rgba;
  }

  const fakeEncoders: Encoders = {
    ktx2: (rgba) => Promise.resolve(new TextEncoder().encode(`ktx2 ${pixelHash(rgba)}`)),
    webp: (rgba) => Promise.resolve(new TextEncoder().encode(`webp ${pixelHash(rgba)}`)),
    png: (rgba) => Promise.resolve(new TextEncoder().encode(`png ${pixelHash(rgba)}`)),
  };

  /** A scratch repository with one plate, `hills` (2 chunks), baked with stand-in encoders. */
  async function bakedRepo(): Promise<ArtPaths> {
    const root = mkdtempSync(join(tmpdir(), 'spiritwood-dev-'));
    roots.push(root);
    const paths = artPaths(root);
    mkdirSync(paths.plates, { recursive: true });
    mkdirSync(paths.layers, { recursive: true });
    copyFileSync(new URL('forest.base.manifest.json', LAYERS), paths.base);
    writeFileSync(join(paths.plates, 'hills.png'), encodePng(hills(1400, 300), 1400, 300));
    writeFileSync(join(paths.plates, 'hills.json'), JSON.stringify(SIDECAR));
    await runArt(paths, { encoders: fakeEncoders, atlases: ATLASES, level: LEVEL });
    return paths;
  }

  function devServer(paths: ArtPaths): {
    dev: ArtDevServer; clock: FakeClock; sent: HotPayload[]; bakes: DevBakeRequest[]; encoded: string[]; errors: string[];
  } {
    const clock = new FakeClock();
    const sent: HotPayload[] = [];
    const bakes: DevBakeRequest[] = [];
    const encoded: string[] = [];
    const errors: string[] = [];
    const dev = new ArtDevServer({
      paths,
      clock,
      stat: (p) => {
        try {
          return statSync(p).size;
        } catch {
          return -1;
        }
      },
      // In process here; the plugin runs the same function in a worker thread.
      bake: async (req) => {
        bakes.push(req);
        const r = await devBakePlate(req);
        encoded.push(...Object.keys(r.webp));
        return r;
      },
      atlases: () => Promise.resolve(ATLASES),
      send: (p) => sent.push(p),
      log: { info: () => undefined, warn: (m) => errors.push(m), error: (m) => errors.push(m) },
      level: LEVEL,
    });
    return { dev, clock, sent, bakes, encoded, errors };
  }

  function request(dev: ArtDevServer, url: string): { handled: boolean; status: number; headers: Record<string, string>; body: string | Uint8Array | undefined } {
    const res: DevResponse & { headers: Record<string, string>; body?: string | Uint8Array } = {
      statusCode: 0,
      headers: {},
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.body = body;
      },
    };
    const handled = dev.handle(url, res);
    return { handled, status: res.statusCode, headers: res.headers, body: res.body };
  }

  /** Save a file the way an editor does, then let the debouncer and the queued re-bake finish. */
  async function save(env: ReturnType<typeof devServer>, file: string, data: string | Uint8Array): Promise<void> {
    writeFileSync(file, data);
    env.dev.onFileEvent('change', file);
    env.clock.advance(STABLE_MS + 100);
    await env.dev.idle();
  }

  test('serves the committed bake as is, then re-bakes a repaint in memory: WebP only, changed chunks only', async () => {
    const paths = await bakedRepo();
    const env = devServer(paths);
    await env.dev.start();
    expect(env.bakes).toEqual([]);
    expect(env.dev.manifestText).toBe(readFileSync(paths.generated, 'utf8'));
    const committed = plateOf(parseManifest(JSON.parse(env.dev.manifestText)), 'hills');

    // Repaint x ≥ 1100: chunk (1, 0) only.
    await save(env, join(paths.plates, 'hills.png'), encodePng(hills(1400, 300, 1.3, 1100), 1400, 300));
    expect(env.bakes).toHaveLength(1);
    expect(env.bakes[0]?.known).toEqual({ '0,0': committed.chunks[0]?.hash, '1,0': committed.chunks[1]?.hash });
    expect(env.encoded).toEqual(['1,0']);
    expect(env.sent).toEqual([{ type: 'custom', event: PLATE_UPDATED_EVENT, data: { id: 'hills' } }]);
    const served = plateOf(parseManifest(JSON.parse(env.dev.manifestText)), 'hills');
    // The re-baked chunk lists only its in-memory WebP (a stale KTX2/PNG on disk can't win); ?v= follows the pixels.
    expect(served.chunks[0]).toEqual(committed.chunks[0]);
    expect(served.chunks[1]?.source).toEqual({ webp: `plates/hills_1_0.webp?v=${hash8(served.chunks[1]?.hash as string)}` });
    expect(served.chunks[1]?.hash).not.toBe(committed.chunks[1]?.hash);

    // The plugin's middleware serves the manifest, re-baked chunks from memory and the rest from disk.
    const m = request(env.dev, '/layers/forest.manifest.json?t=1');
    expect([m.handled, m.status, m.headers['Content-Type'], m.headers['Cache-Control'], m.body]).toEqual([true, 200, 'application/json', 'no-store', env.dev.manifestText]);
    const webp = request(env.dev, `/game/layers/plates/hills_1_0.webp?v=${hash8(served.chunks[1]?.hash as string)}`);
    expect([webp.handled, webp.headers['Content-Type']]).toEqual([true, 'image/webp']);
    expect(webp.body).toBe(env.dev.devFile('hills_1_0.webp'));
    const ktx2 = request(env.dev, '/layers/plates/hills_0_0.ktx2?v=1234');
    expect([ktx2.handled, ktx2.headers['Content-Type']]).toEqual([true, 'image/ktx2']);
    expect(Buffer.from(ktx2.body as Uint8Array).toString()).toBe(readFileSync(join(paths.chunks, 'hills_0_0.ktx2'), 'utf8'));
    expect(request(env.dev, '/layers/plates/..%2Fforest.manifest.json').handled).toBe(false);
    expect(request(env.dev, '/layers/plates/missing_0_0.webp').handled).toBe(false);
    expect(request(env.dev, '/src/main.ts').handled).toBe(false);

    // A colour change reloads the layer without re-encoding anything.
    await save(env, join(paths.plates, 'hills.json'), JSON.stringify({ ...SIDECAR, fog: 0.45 }));
    expect(env.encoded).toEqual(['1,0']);
    expect(env.sent.at(-1)).toEqual({ type: 'custom', event: PLATE_UPDATED_EVENT, data: { id: 'hills' } });
    expect(plateOf(parseManifest(JSON.parse(env.dev.manifestText)), 'hills').fog).toBe(0.45);

    // A new depth is structural: the page reloads.
    await save(env, join(paths.plates, 'hills.json'), JSON.stringify({ ...SIDECAR, parallax: [0.46, 0.46] }));
    expect(env.sent.at(-1)).toEqual({ type: 'full-reload' });
    expect(env.errors).toEqual([]);
    env.dev.close();
  }, SLOW);

  test('a broken save keeps the previous version and tells the artist; deleting a plate reloads the page', async () => {
    const paths = await bakedRepo();
    const env = devServer(paths);
    await env.dev.start();
    const before = env.dev.manifestText;
    await save(env, join(paths.plates, 'hills.json'), '{ "parallax": [0.34, 0.34], ');
    await save(env, join(paths.plates, 'hills.json'), JSON.stringify({ ...SIDECAR, texelScale: 1 }));
    await save(env, join(paths.plates, 'hills.json'), JSON.stringify({ ...SIDECAR, parallax: [0.4, 0.4] }));
    expect(env.dev.manifestText).toBe(before);
    expect(env.sent).toEqual([]);
    expect(env.errors).toEqual([
      expect.stringMatching(/art\/plates\/hills\.json: not valid JSON .*keeping the previous version/),
      expect.stringMatching(/"texelScale" must be ≥ 1\.5 .*keeping the previous version/),
      expect.stringMatching(/plate "hills": parallax fx 0\.4 ties with base layer "L4-mid-forest"/),
    ]);
    rmSync(join(paths.plates, 'hills.png'));
    rmSync(join(paths.plates, 'hills.json'));
    env.dev.onFileEvent('unlink', join(paths.plates, 'hills.png'));
    env.clock.advance(STABLE_MS + 100);
    await env.dev.idle();
    expect(env.sent).toEqual([{ type: 'full-reload' }]);
    expect(parseManifest(JSON.parse(env.dev.manifestText)).layers.some((l) => l.kind === 'plate')).toBe(false);
    env.dev.close();
  }, SLOW);

  test('a half-saved base manifest or lock never takes the dev server down; saving it fixed reloads the page', async () => {
    const paths = await bakedRepo();
    const baseText = readFileSync(paths.base, 'utf8');
    writeFileSync(paths.base, baseText.slice(0, 200));
    const env = devServer(paths);
    // start() never rejects (the plugin calls it without awaiting: a rejection would end the process).
    await expect(env.dev.start()).resolves.toBeUndefined();
    expect(env.errors).toEqual([expect.stringMatching(/^\[art\] public\/layers\/forest\.base\.manifest\.json: .*serving the committed files until it is fixed$/)]);
    // Nothing of its own is served: Vite serves the committed files meanwhile.
    expect(env.dev.manifestText).toBe('');
    expect(request(env.dev, '/layers/forest.manifest.json').handled).toBe(false);
    await save(env, paths.base, baseText);
    expect(env.sent).toEqual([{ type: 'full-reload' }]);
    expect(env.dev.manifestText).toBe(readFileSync(paths.generated, 'utf8'));
    // A lock caught mid-write by the watcher keeps the served state until it parses.
    const served = env.dev.manifestText;
    const lockText = readFileSync(paths.lock, 'utf8');
    await save(env, paths.lock, lockText.slice(0, 40));
    expect(env.dev.manifestText).toBe(served);
    expect(env.sent).toHaveLength(1);
    expect(env.errors.at(-1)).toMatch(/^\[art\] art\/bake\.lock\.json: .*keeping the previous version until it is fixed$/);
    await save(env, paths.lock, lockText);
    expect(env.sent).toHaveLength(2);
    env.dev.close();
  }, SLOW);

  test('a plate named like a base layer or the demo plate is refused (its chunk files would collide)', async () => {
    const paths = await bakedRepo();
    const env = devServer(paths);
    await env.dev.start();
    writeFileSync(join(paths.plates, 'L3-plate-treeline.json'), JSON.stringify({ ...SIDECAR, parallax: [0.46, 0.46] }));
    await save(env, join(paths.plates, 'L3-plate-treeline.png'), encodePng(hills(600, 200), 600, 200));
    expect(env.errors).toEqual([expect.stringContaining('the id "L3-plate-treeline" is taken by the demo plate of npm run plates; rename the plate')]);
    expect(env.sent).toEqual([]);
    expect(parseManifest(JSON.parse(env.dev.manifestText)).layers.some((l) => l.id === 'L3-plate-treeline')).toBe(false);
    env.dev.close();
  }, SLOW);
});

describe('bake worker client', () => {
  class FakeWorker implements WorkerLike {
    readonly posted: WorkerRequest[] = [];
    terminated = false;
    private readonly handlers = new Map<string, ((v: never) => void)[]>();

    postMessage(msg: WorkerRequest): void {
      this.posted.push(msg);
    }

    on(event: 'message' | 'error' | 'exit', fn: (v: never) => void): unknown {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), fn]);
      return this;
    }

    emit(event: 'message' | 'error' | 'exit', v: WorkerReply | Error | number): void {
      for (const fn of this.handlers.get(event) ?? []) (fn as (x: typeof v) => void)(v);
    }

    terminate(): unknown {
      this.terminated = true;
      return Promise.resolve(0);
    }
  }
  const outcome = (p: Promise<unknown>): Promise<string> => p.then(() => 'ok', (e: unknown) => (e instanceof Error ? e.message : String(e)));

  test('replies settle their own call; a call past its deadline restarts the worker; close() settles the rest', async () => {
    const clock = new FakeClock();
    const workers: FakeWorker[] = [];
    const client = new BakeWorkerClient(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, clock, 1000);
    const atlases = client.atlases('base.json');
    const failing = outcome(client.atlases('other.json'));
    expect(workers).toHaveLength(1);
    const w0 = workers[0] as FakeWorker;
    expect(w0.posted.map((m) => m.seq)).toEqual([1, 2]);
    w0.emit('message', { seq: 2, ok: false, error: 'no such file' });
    w0.emit('message', { seq: 1, ok: true, result: [{ id: 'kit', width: 1, height: 1, bytes: 4 }] });
    expect(await atlases).toEqual([{ id: 'kit', width: 1, height: 1, bytes: 4 }]);
    expect(await failing).toBe('no such file');
    // A hung worker: every waiting call fails at the deadline and the worker is replaced.
    const a = outcome(client.bake({ id: 'p', png: 'p.png', width: 1, height: 1, known: {} }));
    const b = outcome(client.atlases('base.json'));
    clock.advance(999);
    expect(client.waiting).toBe(2);
    clock.advance(2);
    expect(await a).toMatch(/did not answer within 1 s; restarting it/);
    expect(await b).toMatch(/did not answer within 1 s/);
    expect(w0.terminated).toBe(true);
    const c = outcome(client.atlases('base.json'));
    expect(workers).toHaveLength(2);
    client.close();
    expect(await c).toBe('the bake worker was closed');
    expect((workers[1] as FakeWorker).terminated).toBe(true);
    expect(client.waiting).toBe(0);
  });

  test('a worker that crashes fails what it was working on; the next call starts a new one', async () => {
    const clock = new FakeClock();
    const workers: FakeWorker[] = [];
    const client = new BakeWorkerClient(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, clock);
    const a = outcome(client.atlases('base.json'));
    (workers[0] as FakeWorker).emit('exit', 1);
    expect(await a).toBe('the bake worker exited (1)');
    const b = client.atlases('base.json');
    expect(workers).toHaveLength(2);
    (workers[1] as FakeWorker).emit('message', { seq: 2, ok: true, result: [] });
    expect(await b).toEqual([]);
    client.close();
  });
});

describe('vite plugin', () => {
  test('is inert under Vitest', () => {
    expect(process.env.VITEST).toBeTruthy();
    const p = spiritwoodArt();
    expect(p.name).toBe('spiritwood-art');
    expect(typeof p.apply).toBe('function');
    expect((p.apply as () => boolean)()).toBe(false);
    expect(p.configureServer).toBeUndefined();
  });

  test('outside Vitest: dev server only, watching art/plates, the base manifest and the lock, serving from its middleware', async () => {
    const saved = process.env.VITEST;
    delete process.env.VITEST;
    const plugin = ((): ReturnType<typeof spiritwoodArt> => {
      try {
        return spiritwoodArt();
      } finally {
        process.env.VITEST = saved;
      }
    })();
    expect(plugin.apply).toBe('serve');
    const paths = artPaths();
    const watched: string[] = [];
    const events: string[] = [];
    const middlewares: ((req: { url?: string }, res: DevResponse, next: () => void) => void)[] = [];
    let close: (() => void) | null = null;
    const noop = (): void => undefined;
    const server = {
      config: { root: paths.root, logger: { info: noop, warn: noop, error: noop } },
      watcher: { add: (p: string[]) => watched.push(...p), on: (e: string) => events.push(e) },
      middlewares: { use: (fn: (typeof middlewares)[number]) => middlewares.push(fn) },
      ws: { send: noop },
      httpServer: { once: (_e: string, fn: () => void) => { close = fn; } },
    };
    const hook = plugin.configureServer as unknown as (s: typeof server) => Promise<void>;
    await hook(server);
    expect(watched).toEqual([paths.plates, paths.base, paths.lock]);
    expect(events).toEqual(['all']);
    expect(middlewares).toHaveLength(1);
    let body: unknown = null;
    let passed = false;
    const res: DevResponse = { statusCode: 0, setHeader: noop, end: (b) => { body = b; } };
    (middlewares[0] as (typeof middlewares)[number])({ url: '/layers/forest.manifest.json' }, res, () => {
      passed = true;
    });
    expect(passed).toBe(false);
    expect(body).toBe(readFileSync(paths.generated, 'utf8'));
    (middlewares[0] as (typeof middlewares)[number])({ url: '/index.html' }, res, () => {
      passed = true;
    });
    expect(passed).toBe(true);
    (close as (() => void) | null)?.();
  }, SLOW);
});
