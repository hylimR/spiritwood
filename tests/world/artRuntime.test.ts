import { readFileSync } from 'node:fs';
import { Assets, BufferImageSource, Container, DOMAdapter, Texture, type WebGLRenderer } from 'pixi.js';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { PLATE_UPDATED_EVENT, PlateHotReload, type HotChannel } from '../../src/assets/hotReload.ts';
import { parseManifest } from '../../src/assets/manifest.ts';
import { spliceManifest } from '../../src/assets/splice.ts';
import { PLATE_CONTENT, PLATE_TEXTURE, plateChunkRect } from '../../src/assets/plateLayout.ts';
import { IMAGE_TIMEOUT_MS, textureUrlUse } from '../../src/assets/textures.ts';
import type { LayerManifest, PlateLayerDef, TextureSourceDef } from '../../src/contracts/assets.ts';
import {
  GLOW_SLOTS, SCENE_SLOTS, type FrameInfo, type GlowSlot, type RenderContext, type SceneSlot, type TextureBudget,
} from '../../src/contracts/render.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { WorldAssets } from '../../src/render/layers/assets.ts';
import { createKitLayerUniforms } from '../../src/render/layers/kitShader.ts';
import { plateShadeParams } from '../../src/render/layers/layerModel.ts';
import { ParallaxStackView } from '../../src/render/layers/parallaxStack.ts';
import { PlateLayer, PlateStreaming, type PlateEnv } from '../../src/render/layers/plates.ts';
import { computeCameraFrame, createCameraFrame, depthForParallax, type Extent } from '../../src/render/util/camera.ts';
import { createOpaqueState, createTransparentState } from '../../src/render/util/states.ts';
import { QUALITY_PRESETS } from '../../src/settings/quality.ts';
import { createFakeSimView, type FakeSim } from '../shared/fixtures.ts';
import { forestKit } from './kitFixture.ts';

const LAYERS = new URL('../../public/layers/', import.meta.url);
const MANIFEST_URL = 'http://localhost/layers/forest.manifest.json';
const level = parseLdtk(JSON.parse(readFileSync(new URL('../../public/levels/forest.ldtk', import.meta.url), 'utf8')));
const readManifest = (name: string): LayerManifest => parseManifest(JSON.parse(readFileSync(new URL(name, LAYERS), 'utf8')));
const CHUNK_BYTES = 4 * PLATE_TEXTURE * PLATE_TEXTURE;
const SLOW = 60_000;

/** The shared texture budget, with its keys visible. */
class KeyedBudget implements TextureBudget {
  readonly entries = new Map<string, number>();
  budgetBytes: number;

  constructor(budgetBytes: number) {
    this.budgetBytes = budgetBytes;
  }

  get totalBytes(): number {
    let t = 0;
    for (const b of this.entries.values()) t += b;
    return t;
  }

  set(key: string, bytes: number): void {
    this.entries.set(key, bytes);
  }

  remove(key: string): void {
    this.entries.delete(key);
  }

  /** Plate keys (`<id>#<generation>:<col>:<row>`), sorted. */
  plateKeys(prefix = ''): string[] {
    return [...this.entries.keys()].filter((k) => k.includes('#') && k.startsWith(prefix)).sort();
  }
}

const CHUNK_PIXELS = new Uint8Array(CHUNK_BYTES);
const chunkTexture = (): Texture => new Texture({ source: new BufferImageSource({ resource: CHUNK_PIXELS, width: PLATE_TEXTURE, height: PLATE_TEXTURE }) });
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Assets.load / unload stand-ins (no network, no GPU). */
function mockAssets(loader: (url: string) => Promise<Texture>): { loaded: () => string[]; unloaded: () => string[] } {
  const load = vi.spyOn(Assets, 'load').mockImplementation(((url: string) => loader(url)) as typeof Assets.load);
  const unload = vi.spyOn(Assets, 'unload').mockImplementation((() => Promise.resolve()) as typeof Assets.unload);
  return { loaded: () => load.mock.calls.map((c) => String(c[0])), unloaded: () => unload.mock.calls.map((c) => String(c[0])) };
}

interface Harness {
  stack: ParallaxStackView;
  ctx: RenderContext;
  textures: KeyedBudget;
  sim: FakeSim;
  frame: FrameInfo;
}

/** A ParallaxStackView initialised on a renderer-free context with the real forest level and kit. */
async function stackFor(manifest: LayerManifest): Promise<Harness> {
  const scene = {} as Record<SceneSlot, Container>;
  for (const s of SCENE_SLOTS) scene[s] = new Container({ label: s });
  const glow = {} as Record<GlowSlot, Container>;
  for (const s of GLOW_SLOTS) glow[s] = new Container({ label: s });
  const textures = new KeyedBudget(manifest.textureBudgetMB.high * 2 ** 20);
  const quality = { ...QUALITY_PRESETS.high };
  const ctx: RenderContext = {
    renderer: { context: { extensions: {} } } as unknown as WebGLRenderer,
    scene, glow, level, manifest, manifestUrl: MANIFEST_URL, quality, textures,
    stats: { drawCalls: 0, fillScreens: 0, rtWidth: 0, rtHeight: 0, renderScale: 1, canvasWidth: 0, canvasHeight: 0, particles: 0, textureMB: 0, gpuMs: -1 },
  };
  const assets = new WorldAssets();
  assets.kit = forestKit();
  assets.kitTexture = new Texture({ source: new BufferImageSource({ resource: new Uint8Array(4 * 4 * 4), width: 4, height: 4 }) });
  assets.settle();
  const stack = new ParallaxStackView(assets);
  await stack.init(ctx);
  const sim = createFakeSimView(level);
  const frame: FrameInfo = {
    time: 0, dt: 1 / 60, worldTime: 0, worldDt: 1 / 60, timeScale: 1, alpha: 1, frame: 0,
    camera: computeCameraFrame(createCameraFrame(), sim.camera, 1), sim, quality, renderScale: 1, pxPerUnit: 1,
  };
  return { stack, ctx, textures, sim, frame };
}

/** Park the camera where a plate's first chunk fills the view. */
function lookAt(h: Harness, def: PlateLayerDef): void {
  const c = def.chunks[0] as PlateLayerDef['chunks'][number];
  const r = plateChunkRect(def, c.col, c.row);
  const x = (r.x0 + r.x1) / 2 / def.parallax[0];
  const y = (r.y0 + r.y1) / 2 / def.parallax[1];
  Object.assign(h.sim.camera, { x, y, prevX: x, prevY: y });
}

function step(h: Harness): void {
  h.frame.frame++;
  computeCameraFrame(h.frame.camera, h.sim.camera, 1);
  h.stack.update(h.frame);
}

const plateOf = (m: LayerManifest, id?: string): PlateLayerDef =>
  m.layers.find((l): l is PlateLayerDef => l.kind === 'plate' && (id === undefined || l.id === id)) as PlateLayerDef;

/** The manifest after a repaint of plate `id`: new chunk hashes and `?v=`, plus any other edits. */
function repaint(m: LayerManifest, id: string, hash: string, patch: Partial<PlateLayerDef> = {}): LayerManifest {
  const json = JSON.parse(JSON.stringify(m)) as LayerManifest;
  const def = plateOf(json, id);
  for (const c of def.chunks) {
    c.hash = hash;
    for (const f of ['ktx2', 'webp', 'png'] as const) {
      const src: TextureSourceDef = c.source;
      if (src[f]) src[f] = (src[f] as string).replace(/\?v=[0-9a-f]+$/, `?v=${hash.slice(0, 8)}`);
    }
  }
  Object.assign(def, patch);
  return parseManifest(json);
}

// GlProgram probes the fragment precision on a canvas: without a DOM there is none to probe.
const adapter = DOMAdapter.get();
beforeAll(() => {
  DOMAdapter.set({ ...adapter, createCanvas: () => ({ getContext: () => null }) as unknown as HTMLCanvasElement });
});
afterAll(() => {
  DOMAdapter.set(adapter);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('plate failure: load deadlines and the base layer', () => {
  test('a chunk that never arrives fails its plate at the deadline, and the stack draws the kit layer it replaced', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const assets = mockAssets(() => new Promise<Texture>(() => undefined));
    const manifest = readManifest('forest.plates.manifest.json');
    const plate = plateOf(manifest);
    const base = manifest.replaced?.[plate.id];
    if (!base || base.kind !== 'kit') throw new Error('the demo plate replaces a kit layer');
    const h = await stackFor(manifest);
    const ids = (): string[] => h.stack.describeLayers().map((l) => l.id);
    expect(ids()).toContain(plate.id);
    expect(ids()).not.toContain(base.id);

    lookAt(h, plate);
    step(h);
    const requested = assets.loaded();
    expect(requested.length).toBeGreaterThan(0);
    expect(requested.every((u) => u.includes(`/layers/plates/${plate.id}_`))).toBe(true);
    await vi.advanceTimersByTimeAsync(IMAGE_TIMEOUT_MS - 1);
    step(h);
    expect(ids()).toContain(plate.id);
    await vi.advanceTimersByTimeAsync(2);

    const layers = h.stack.describeLayers();
    expect(layers.some((l) => l.id === plate.id)).toBe(false);
    expect(layers.find((l) => l.id === base.id)).toEqual({ id: base.id, kind: 'kit', active: true, standsFor: plate.id });
    expect(warn).toHaveBeenCalledWith(`[plates] ${plate.id}: drawing the base layer ${base.id} it replaced instead`);
    // The restored layer draws at its own depth: its core in the depth-tested root, its band behind.
    const cores = h.ctx.scene.opaque.children[0] as Container;
    const bands = h.ctx.scene.background.children[0] as Container;
    const core = cores.children.find((c) => c.label === `${base.id}:core`);
    const band = bands.children.find((c) => c.label === `${base.id}:band`);
    expect(core?.zIndex).toBe(Math.round(depthForParallax(base.parallax[0]) * 1e6));
    expect(band?.zIndex).toBe(-(core?.zIndex ?? 0));
    expect((core?.children.length ?? 0) + (band?.children.length ?? 0)).toBeGreaterThan(0);
    expect(cores.children.some((c) => c.label === `${plate.id}:core`)).toBe(false);
    // Nothing of the plate is left: no budget entries, no leases, and no retries.
    expect(h.textures.plateKeys()).toEqual([]);
    for (const u of requested) expect(textureUrlUse(u)).toEqual({ leases: 0, pending: 0 });
    step(h);
    step(h);
    expect(assets.loaded()).toEqual(requested);
    h.stack.destroy();
  }, SLOW);

  test('a plate that replaced nothing is dropped; the other plates keep streaming', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const assets = mockAssets((url) => (url.includes('glade-landmark') ? new Promise<Texture>(() => undefined) : Promise.resolve(chunkTexture())));
    const manifest = readManifest('forest.manifest.json');
    const h = await stackFor(manifest);
    const before = h.stack.describeLayers().map((l) => l.id);
    lookAt(h, plateOf(manifest, 'glade-landmark'));
    step(h);
    await vi.advanceTimersByTimeAsync(IMAGE_TIMEOUT_MS + 1);
    const after = h.stack.describeLayers();
    expect(after.map((l) => l.id)).toEqual(before.filter((id) => id !== 'glade-landmark'));
    expect(after.every((l) => l.standsFor === null)).toBe(true);
    lookAt(h, plateOf(manifest, 'glade-frame'));
    step(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.textures.plateKeys('glade-frame#')).toHaveLength(1);
    expect(assets.loaded().filter((u) => u.includes('glade-frame'))).toHaveLength(1);
    h.stack.destroy();
  }, SLOW);
});

describe('hot reload through the parallax stack', () => {
  test('a repaint reloads one layer: evict, rebuild the meshes and re-stream under a new generation', async () => {
    const assets = mockAssets(() => Promise.resolve(chunkTexture()));
    const manifest = readManifest('forest.manifest.json');
    const def = plateOf(manifest, 'glade-frame');
    const h = await stackFor(manifest);
    const shape = h.stack.describeLayers();
    lookAt(h, def);
    step(h);
    await flush();
    step(h);
    const first = h.textures.plateKeys('glade-frame#');
    expect(first).toHaveLength(def.chunks.length);
    const oldUrl = assets.loaded().find((u) => u.includes('glade-frame_0_0')) as string;
    expect(textureUrlUse(oldUrl).leases).toBe(1);

    const next = repaint(manifest, 'glade-frame', 'feedfacecafebeef', { fog: 0.5 });
    expect(h.stack.reloadPlate(plateOf(next, 'glade-frame'), next)).toBe(true);
    expect(h.stack.currentManifest()).toEqual(next);
    expect(h.textures.plateKeys('glade-frame#')).toEqual([]);
    expect(assets.unloaded()).toEqual([oldUrl]);
    step(h);
    await flush();
    step(h);
    const second = h.textures.plateKeys('glade-frame#');
    expect(second).toHaveLength(1);
    expect(second[0]).not.toBe(first[0]);
    expect(assets.loaded().at(-1)).toMatch(/glade-frame_0_0\.\w+\?v=feedface$/);
    expect(h.stack.describeLayers()).toEqual(shape);
    // Unknown ids and other layers' kinds can't reload in place (the page reloads instead).
    expect(h.stack.reloadPlate({ ...plateOf(next, 'glade-frame'), id: 'nope' }, next)).toBe(false);
    h.stack.destroy();
  }, SLOW);

  test('a plate that failed comes back on reload, and the base layer standing in for it goes', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let broken = true;
    mockAssets(() => (broken ? new Promise<Texture>(() => undefined) : Promise.resolve(chunkTexture())));
    const manifest = readManifest('forest.plates.manifest.json');
    const def = plateOf(manifest);
    const h = await stackFor(manifest);
    const shape = h.stack.describeLayers();
    lookAt(h, def);
    step(h);
    await vi.advanceTimersByTimeAsync(IMAGE_TIMEOUT_MS + 1);
    expect(h.stack.describeLayers().some((l) => l.standsFor === def.id)).toBe(true);

    broken = false;
    const next = repaint(manifest, def.id, 'feedfacecafebeef');
    expect(h.stack.reloadPlate(plateOf(next), next)).toBe(true);
    const layers = h.stack.describeLayers();
    expect(layers.some((l) => l.standsFor !== null)).toBe(false);
    expect(layers.map((l) => l.id).sort()).toEqual(shape.map((l) => l.id).sort());
    step(h);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.textures.plateKeys(`${def.id}#`).length).toBeGreaterThan(0);
    h.stack.destroy();
  }, SLOW);

  test('driven by the dev channel: plate-updated re-fetches the manifest and the stack reloads that layer', async () => {
    mockAssets(() => Promise.resolve(chunkTexture()));
    const manifest = readManifest('forest.manifest.json');
    const h = await stackFor(manifest);
    const handlers = new Map<string, (data: unknown) => void>();
    const channel: HotChannel = {
      on: (event, cb) => {
        handlers.set(event, cb);
      },
    };
    const next = repaint(manifest, 'glade-landmark', 'feedfacecafebeef', { fog: 0.6 });
    const fetchManifest = vi.fn((_url: string) => Promise.resolve(next));
    const reloadPage = vi.fn();
    const hot = new PlateHotReload(channel, { fetchManifest, reloadPage });
    const unregister = hot.register(h.stack);
    const reload = vi.spyOn(h.stack, 'reloadPlate');
    handlers.get(PLATE_UPDATED_EVENT)?.({ id: 'glade-landmark' });
    await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(1));
    expect(fetchManifest).toHaveBeenCalledWith(MANIFEST_URL);
    expect(reloadPage).not.toHaveBeenCalled();
    expect(plateOf(h.stack.currentManifest(), 'glade-landmark').fog).toBe(0.6);
    unregister();
    h.stack.destroy();
  }, SLOW);
});

describe('hot reload keeps the replaced layers (they live on the manifest, so copies keep them)', () => {
  const cases: [string, () => LayerManifest, string][] = [
    ['the demo plates manifest, whose plate replaces L3', () => readManifest('forest.plates.manifest.json'), 'L3-plate-treeline'],
    ['a generated manifest where glade-frame replaces L6', () => {
      const gen = readManifest('forest.manifest.json');
      const spliced = spliceManifest(readManifest('forest.base.manifest.json'), [
        { layer: plateOf(gen, 'glade-frame'), replaces: 'L6-mid-forest' }, { layer: plateOf(gen, 'glade-landmark') },
      ]);
      return parseManifest(JSON.parse(JSON.stringify(spliced)));
    }, 'glade-frame'],
  ];
  test.each(cases)('%s: a pixel-only repaint reloads that layer in place', async (_name, make, id) => {
    mockAssets(() => Promise.resolve(chunkTexture()));
    const manifest = make();
    const replacedId = manifest.replaced?.[id]?.id;
    expect(replacedId).toBeDefined();
    const h = await stackFor(manifest);
    expect(h.stack.currentManifest().replaced).toEqual(manifest.replaced);
    const handlers = new Map<string, (data: unknown) => void>();
    const channel: HotChannel = {
      on: (event, cb) => {
        handlers.set(event, cb);
      },
    };
    // What the dev channel re-fetches: the same file, repainted, parsed again.
    const next = repaint(manifest, id, 'feedfacecafebeef');
    const reloadPage = vi.fn();
    const hot = new PlateHotReload(channel, { fetchManifest: () => Promise.resolve(next), reloadPage });
    hot.register(h.stack);
    expect(await hot.handle({ id })).toBe('reloaded');
    expect(reloadPage).not.toHaveBeenCalled();
    // The stack's copy still knows what the plate replaced, so a later failure restores it.
    expect(h.stack.currentManifest().replaced?.[id]?.id).toBe(replacedId);
    expect(h.stack.describeLayers().some((l) => l.id === replacedId)).toBe(false);
    h.stack.destroy();
  }, SLOW);
});

describe('foreground layers', () => {
  test('a restored foreground layer draws in its place by fx, not on top of nearer ones', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAssets(() => Promise.reject(new Error('404')));
    const fg: PlateLayerDef = {
      id: 'fg-plate', kind: 'plate', parallax: [1.3, 0], minQuality: 'low', tint: '#ffffff', fog: 0, fogColor: '#000000', desaturate: 0,
      origin: [0, -300], chunkSize: [PLATE_CONTENT, PLATE_CONTENT], texelScale: 2,
      chunks: [{ col: 0, row: 0, source: { webp: 'plates/fg-plate_0_0.webp?v=0123abcd' }, core: [0, 0, 64, 64], soft: [64, 0, 64, 64], hash: '0123abcd0123abcd' }],
    };
    const manifest = parseManifest(JSON.parse(JSON.stringify(spliceManifest(readManifest('forest.base.manifest.json'), [{ layer: fg, replaces: 'F1-frame' }]))));
    const h = await stackFor(manifest);
    const fgRoot = h.ctx.scene.foreground.children[0] as Container;
    // What the renderer does with a sortable container before drawing it.
    const order = (): string[] => {
      fgRoot.sortChildren();
      return fgRoot.children.map((c) => c.label);
    };
    expect(order()).toEqual(['fg-plate:band', 'F2-frame:band']);
    Object.assign(h.sim.camera, { x: 1260, y: 1200, prevX: 1260, prevY: 1200 });
    step(h);
    await flush();
    await flush();
    expect(h.stack.describeLayers().find((l) => l.id === 'F1-frame')?.standsFor).toBe('fg-plate');
    // F1 (fx 1.25) draws before F2 (fx 1.55) although it was added last.
    expect(order()).toEqual(['F1-frame:band', 'F2-frame:band']);
    h.stack.destroy();
  }, SLOW);
});

describe('shared plate streaming', () => {
  function env(def: PlateLayerDef): PlateEnv {
    return {
      coreParent: new Container(), bandParent: new Container(), coreState: createOpaqueState(), bandState: createTransparentState(),
      uniforms: createKitLayerUniforms(plateShadeParams(def)), baseUrl: MANIFEST_URL, support: { ktx2: false, webp: true },
    };
  }

  /** A row of `cols` chunks at f 0.5 (PLATE_CONTENT · 1.5 u each), every chunk with a core rect and a soft rect. */
  function strip(id: string, cols: number, ktx2 = false): PlateLayerDef {
    const chunks = [];
    for (let col = 0; col < cols; col++) {
      const webp = `plates/${id}_${col}_0.webp?v=0123abcd`;
      const source: TextureSourceDef = ktx2 ? { ktx2: `plates/${id}_${col}_0.ktx2?v=0123abcd`, webp } : { webp };
      chunks.push({ col, row: 0, source, core: [100, 100, 800, 800], soft: [0, 0, PLATE_CONTENT, 100] });
    }
    return {
      id, kind: 'plate', parallax: [0.5, 0.5], minQuality: 'low', tint: '#ffffff', fog: 0, fogColor: '#000000', desaturate: 0,
      origin: [0, 0], chunkSize: [PLATE_CONTENT, PLATE_CONTENT], texelScale: 1.5, chunks,
    };
  }
  const CW = PLATE_CONTENT * 1.5;
  const span = (c0: number, c1: number): Extent => ({ x0: c0 * CW + 10, y0: 10, x1: (c1 + 1) * CW - 10, y1: 1000 });
  /** Loaded chunks as `<id>:<col>` (generation stripped). */
  const loadedOf = (t: KeyedBudget): string[] => t.plateKeys().map((k) => k.replace(/#\d+:(\d+):\d+$/, ':$1'));

  test('one budget across plate layers: the texture budget minus the atlases, re-read as atlases register', async () => {
    const assets = mockAssets(() => Promise.resolve(chunkTexture()));
    const textures = new KeyedBudget(10 * CHUNK_BYTES);
    textures.set('atlas:forest-kit', 6 * CHUNK_BYTES);
    const streaming = new PlateStreaming(textures, 0, 8);
    const a = new PlateLayer(strip('a', 3), env(strip('a', 3)));
    const b = new PlateLayer(strip('b', 3), env(strip('b', 3)));
    streaming.add(a);
    streaming.add(b);
    const frame = async (n: number, va: Extent | null, vb: Extent | null): Promise<void> => {
      streaming.setVisible(a, va, n);
      streaming.setVisible(b, vb, n);
      streaming.pump();
      await flush();
      streaming.pump();
    };

    await frame(1, span(0, 1), null);
    expect(loadedOf(textures)).toEqual(['a:0', 'a:1']);
    await frame(2, null, span(0, 1));
    expect(loadedOf(textures)).toEqual(['a:0', 'a:1', 'b:0', 'b:1']);
    // Over the 4-chunk plate budget: the chunk wanted longest ago goes, whichever layer it belongs to.
    await frame(3, null, span(1, 2));
    expect(loadedOf(textures)).toEqual(['a:1', 'b:0', 'b:1', 'b:2']);
    expect(assets.unloaded()).toEqual([new URL('plates/a_0_0.webp?v=0123abcd', MANIFEST_URL).href]);
    // An atlas registered later shrinks what plates may use.
    textures.set('atlas:hero', CHUNK_BYTES);
    await frame(4, null, span(1, 2));
    expect(loadedOf(textures)).toEqual(['b:0', 'b:1', 'b:2']);
    textures.set('atlas:entities', 2 * CHUNK_BYTES);
    await frame(5, null, span(1, 2));
    // Visible chunks stay even over budget (the bake keeps the visible set within it).
    expect(loadedOf(textures)).toEqual(['b:1', 'b:2']);
    // 2 draws per visible chunk: one opaque-core mesh and one soft mesh, shown only while visible.
    for (const c of b.chunks) {
      const loaded = c.meshes.length > 0;
      expect(c.meshes.length).toBe(loaded ? 2 : 0);
      for (const m of c.meshes) expect(m.visible).toBe(loaded);
    }
    expect(b.loadedChunks).toBe(2);
    streaming.destroy();
    expect(textures.plateKeys()).toEqual([]);
  });

  test('a reload mid-load: the old generation\'s late texture never unloads what the new generation uses', async () => {
    let resolveLoad: (t: Texture) => void = () => undefined;
    // Pixi's Assets cache hands every loader of one URL the same promise.
    const inflight = new Promise<Texture>((resolve) => {
      resolveLoad = resolve;
    });
    const assets = mockAssets(() => inflight);
    const textures = new KeyedBudget(64 * CHUNK_BYTES);
    const streaming = new PlateStreaming(textures, 0, 2);
    const def = strip('gen', 1);
    const layer = new PlateLayer(def, env(def));
    streaming.add(layer);
    streaming.setVisible(layer, span(0, 0), 1);
    streaming.pump();
    const g1 = layer.generation;
    // A colour-only edit keeps the pixels and so the URL; the layer reloads while the load is in flight.
    layer.reload({ ...def, fog: 0.4 });
    expect(layer.generation).toBeGreaterThan(g1);
    streaming.setVisible(layer, span(0, 0), 2);
    streaming.pump();
    const urls = assets.loaded();
    expect(urls).toHaveLength(2);
    expect(new Set(urls).size).toBe(1);
    const url = urls[0] as string;
    resolveLoad(chunkTexture());
    await flush();
    streaming.pump();
    expect(textures.plateKeys()).toEqual([`gen#${layer.generation}:0:0`]);
    expect(assets.unloaded()).toEqual([]);
    expect(textureUrlUse(url)).toEqual({ leases: 1, pending: 0 });
    expect(layer.loadedChunks).toBe(1);
    // Evicting the current generation finally unloads it.
    layer.evictAll();
    expect(assets.unloaded()).toEqual([url]);
    expect(textureUrlUse(url)).toEqual({ leases: 0, pending: 0 });
    streaming.destroy();
  });

  // Last in the file: the KTX2 fallback it triggers stays on for the session (module state).
  test('KTX2 failing at runtime: chunks that arrive as RGBA8 count at their real size, so the budget holds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockAssets((url) => (url.includes('.ktx2') ? Promise.reject(new Error('transcoder worker blocked')) : Promise.resolve(chunkTexture())));
    const textures = new KeyedBudget(3 * CHUNK_BYTES);
    const streaming = new PlateStreaming(textures, 0, 2);
    const def = strip('k', 12, true);
    // The GPU could sample KTX2 at init; the transcoder then fails for every chunk.
    const layer = new PlateLayer(def, { ...env(def), support: { ktx2: true, webp: true } });
    streaming.add(layer);
    // Walk the camera along the strip, one chunk in view at a time.
    for (let col = 0; col < 12; col++) {
      for (let i = 0; i < 3; i++) {
        streaming.setVisible(layer, span(col, col), col * 10 + i);
        streaming.pump();
        await flush();
        await flush();
        streaming.pump();
        expect(textures.totalBytes).toBeLessThanOrEqual(textures.budgetBytes);
        expect(streaming.streamer.loadedBytes).toBe(textures.totalBytes);
      }
    }
    expect(layer.loadedChunks).toBe(3);
    streaming.destroy();
  });
});
