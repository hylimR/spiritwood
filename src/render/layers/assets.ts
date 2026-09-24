import { Rectangle, Texture, type WebGLRenderer } from 'pixi.js';
import type { RenderContext, RenderView } from '../../contracts/render.ts';
import { generateKitAsync, KIT_HEIGHT, KIT_WIDTH, kitSeed, type KitMeta } from '../gen/kit.ts';
import { generateParticleAtlas, PARTICLE_FRAMES, type ParticleFrame } from '../gen/particleAtlas.ts';
import { estimateTextureBytes, textureFromRgba } from '../util/texture.ts';

/** The one procedural kit atlas M1 ships (manifest atlas source `{ procedural: 'forest-kit' }`). */
export const PROCEDURAL_KIT = 'forest-kit';

interface SharedKit {
  meta: KitMeta;
  texture: Texture;
  refs: number;
}

const kits = new WeakMap<WebGLRenderer, Promise<SharedKit>>();

/** Resolve on the next macrotask without setTimeout's nested-timer clamping. */
function macrotask(): Promise<void> {
  const s = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (s?.yield) return s.yield();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

/** Yield to the event loop at most every ~8 ms so the boot screen stays responsive. */
function pacedYield(): () => Promise<void> {
  let last = performance.now();
  return async () => {
    const now = performance.now();
    if (now - last < 8) return;
    await macrotask();
    last = performance.now();
  };
}

/** One kit per renderer, shared by every view that asks (parallax stack, decor). */
async function acquireKit(renderer: WebGLRenderer, width: number, height: number): Promise<SharedKit> {
  let p = kits.get(renderer);
  if (!p) {
    p = (async () => {
      const t0 = performance.now();
      const data = await generateKitAsync(kitSeed(PROCEDURAL_KIT), pacedYield(), width, height);
      const ms = performance.now() - t0;
      console.info(`[world] forest kit: ${data.elements.length} elements, ${width}×${height}, ${ms.toFixed(0)} ms`);
      // textureFromRgba premultiplies the buffer in place; only the metadata is kept afterwards.
      const texture = textureFromRgba(data.pixels, width, height, { autoGenerateMipmaps: true, label: PROCEDURAL_KIT });
      const meta: KitMeta = { width, height, elements: data.elements, byCategory: data.byCategory, ms };
      return { meta, texture, refs: 0 };
    })();
    kits.set(renderer, p);
  }
  const kit = await p;
  kit.refs++;
  return kit;
}

function releaseKit(renderer: WebGLRenderer, kit: SharedKit): void {
  kit.refs--;
  if (kit.refs > 0) return;
  kit.texture.destroy(true);
  kits.delete(renderer);
}

/**
 * Shared WORLD resources, created by createWorldViews() and filled by WorldAssetsView (added first,
 * so its init completes before any other world view's init).
 */
export class WorldAssets {
  kit: KitMeta | null = null;
  kitTexture: Texture | null = null;
  particleTexture: Texture | null = null;
  particleFrames: Record<ParticleFrame, Texture> | null = null;
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (e: unknown) => void;

  constructor() {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    // Views that await `ready` handle failures themselves; avoid an unhandled rejection here.
    this.ready.catch(() => undefined);
  }

  /** @internal */
  settle(error?: unknown): void {
    if (error === undefined) this.resolveReady();
    else this.rejectReady(error);
  }
}

/** Resource owner: generates, registers and finally destroys the shared kit and particle atlases. */
export class WorldAssetsView implements RenderView {
  readonly name = 'world-assets';
  private readonly assets: WorldAssets;
  private renderer: WebGLRenderer | null = null;
  private shared: SharedKit | null = null;
  private ctx: RenderContext | null = null;

  constructor(assets: WorldAssets) {
    this.assets = assets;
  }

  async init(ctx: RenderContext): Promise<void> {
    this.ctx = ctx;
    this.renderer = ctx.renderer;
    try {
      const def = ctx.manifest.atlases.find((a) => a.source.procedural === PROCEDURAL_KIT);
      const width = def?.width ?? KIT_WIDTH;
      const height = def?.height ?? KIT_HEIGHT;
      const shared = await acquireKit(ctx.renderer, width, height);
      this.shared = shared;
      this.assets.kit = shared.meta;
      this.assets.kitTexture = shared.texture;
      ctx.textures.set(`atlas:${PROCEDURAL_KIT}`, estimateTextureBytes(width, height, 4, true));

      const p = generateParticleAtlas();
      const tex = textureFromRgba(p.pixels, p.width, p.height, { autoGenerateMipmaps: true, label: 'world-particles' });
      const frames = {} as Record<ParticleFrame, Texture>;
      for (const name of PARTICLE_FRAMES) {
        const r = p.frames[name];
        frames[name] = new Texture({ source: tex.source, frame: new Rectangle(r.x, r.y, r.w, r.h), label: `particle:${name}` });
      }
      this.assets.particleTexture = tex;
      this.assets.particleFrames = frames;
      ctx.textures.set('atlas:world-particles', estimateTextureBytes(p.width, p.height, 4, true));
      this.assets.settle();
    } catch (e) {
      this.assets.settle(e);
      throw e;
    }
  }

  update(): void {}

  destroy(): void {
    const frames = this.assets.particleFrames;
    if (frames) for (const name of PARTICLE_FRAMES) frames[name].destroy(false);
    this.assets.particleTexture?.destroy(true);
    if (this.renderer && this.shared) releaseKit(this.renderer, this.shared);
    this.ctx?.textures.remove(`atlas:${PROCEDURAL_KIT}`);
    this.ctx?.textures.remove('atlas:world-particles');
    this.assets.kit = null;
    this.assets.kitTexture = null;
    this.assets.particleTexture = null;
    this.assets.particleFrames = null;
    this.shared = null;
  }
}
