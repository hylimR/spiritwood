import { Assets, detectWebp, setKTXTranscoderPath, type Texture, type WebGLRenderer } from 'pixi.js';
import 'pixi.js/ktx2';
import type { TextureSourceDef } from '../contracts/assets.ts';
import { evalAllowed } from '../core/csp.ts';
import type { TextureBudget } from '../contracts/render.ts';
import { PLATE_LOAD_TIMEOUT_MS } from './plateLayout.ts';

export interface TextureFormatSupport {
  /** GPU can sample a Basis/KTX2 transcode target (BC7/BC3/ETC2/ASTC) and the CSP lets the transcoder run. */
  ktx2: boolean;
  webp: boolean;
}

/**
 * Pick the URL to load for a source: ktx2 (if supported) → webp (if supported) → png. Paths resolve
 * against `baseUrl` (the manifest URL). Returns null for procedural-only sources. Pure.
 */
export function chooseTextureUrl(src: TextureSourceDef, support: TextureFormatSupport, baseUrl: string): string | null {
  const path = (support.ktx2 && src.ktx2) || (support.webp && src.webp) || src.png || null;
  return path ? new URL(path, baseUrl).href : null;
}

/**
 * KTX2 needs a transcode target the GPU samples (BC7 bptc, BC3 s3tc, ETC2, ASTC 4×4) and eval: Pixi's
 * libktx transcoder is Emscripten code that calls `new Function`, so under a no-eval CSP its worker
 * fails during init (and Pixi's worker handler then throws on the URL-less error). Pure.
 */
export function ktx2Usable(ext: Readonly<Partial<Record<'bptc' | 's3tc' | 'etc' | 'astc', unknown>>>, canEval: boolean): boolean {
  return canEval && !!(ext.bptc || ext.s3tc || ext.etc || ext.astc);
}

let supportPromise: Promise<TextureFormatSupport> | null = null;

/** Probe compressed-format and WebP support once (cached). */
export async function detectTextureSupport(renderer: WebGLRenderer): Promise<TextureFormatSupport> {
  supportPromise ??= (async () => {
    const ktx2 = ktx2Usable(renderer.context.extensions, evalAllowed());
    let webp = false;
    try {
      webp = await detectWebp.test();
    } catch {
      webp = false;
    }
    return { ktx2, webp };
  })();
  return supportPromise;
}

let ktx2Configured = false;
let ktx2Disabled = false;

/** Point Pixi's KTX2 worker at the self-hosted transcoder (absolute URLs) before the first KTX2 load. */
function configureKtx2(): void {
  if (ktx2Configured) return;
  ktx2Configured = true;
  // Pixi's worker resolves relative paths against location.origin, so pass absolute URLs.
  setKTXTranscoderPath({
    jsUrl: new URL('transcoders/ktx/libktx.js', document.baseURI).href,
    wasmUrl: new URL('transcoders/ktx/libktx.wasm', document.baseURI).href,
  });
}

/**
 * A KTX2 load still pending after this long counts as a failure. When a host blocks blob workers or
 * WASM (ARCHITECTURE.md §5.8), Pixi's transcoder worker never answers, so without a deadline the
 * chunk would stay 'loading' forever and the WebP/PNG fallback would never run.
 */
export const KTX2_TIMEOUT_MS = 12000;
/** Every other image load has a deadline too (§5.8): a plate whose chunk never arrives fails. */
export const IMAGE_TIMEOUT_MS = PLATE_LOAD_TIMEOUT_MS;

/**
 * Who uses a URL. Pixi's Assets cache hands every loader of one URL the same Texture, and
 * `Assets.unload(url)` destroys it for all of them, so a URL is unloaded only when nobody holds it
 * (`leases`) and no load of it is still pending (`pending`): an old owner (an evicted chunk, a timed-out
 * load, a layer generation replaced by hot reload) can never unload a texture a newer owner uses.
 */
interface UrlUse {
  leases: number;
  pending: number;
}
const uses = new Map<string, UrlUse>();

function use(url: string): UrlUse {
  let u = uses.get(url);
  if (!u) {
    u = { leases: 0, pending: 0 };
    uses.set(url, u);
  }
  return u;
}

function unloadIfUnused(url: string): void {
  const u = uses.get(url);
  if (u && (u.leases > 0 || u.pending > 0)) return;
  uses.delete(url);
  void Assets.unload(url);
}

/** Leases and pending loads of a URL (tests, debug). */
export function textureUrlUse(url: string): { leases: number; pending: number } {
  const u = uses.get(url);
  return { leases: u?.leases ?? 0, pending: u?.pending ?? 0 };
}

/** URLs with a lease or a pending load (tests, debug): nothing else is tracked. */
export function trackedTextureUrls(): number {
  return uses.size;
}

/** Forget a URL nobody holds or awaits (its entry is recreated by the next load). */
function forgetIfIdle(url: string, u: UrlUse): void {
  if (u.leases === 0 && u.pending === 0 && uses.get(url) === u) uses.delete(url);
}

/**
 * Assets.load with a deadline; the result is a lease on the URL (release it with
 * unloadTextureSource). A texture that arrives after the deadline is unloaded unless someone else
 * holds or awaits the same URL.
 */
function loadWithTimeout(url: string, ms: number): Promise<Texture> {
  const u = use(url);
  u.pending++;
  return new Promise<Texture>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      u.pending--;
      forgetIfIdle(url, u);
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    Assets.load<Texture>(url).then(
      (texture) => {
        if (settled) {
          unloadIfUnused(url);
          return;
        }
        settled = true;
        clearTimeout(timer);
        u.pending--;
        u.leases++;
        resolve(texture);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        u.pending--;
        forgetIfIdle(url, u);
        reject(err);
      },
    );
  });
}

/** GPU bytes of a loaded texture: 1 B/texel for block-compressed formats, 4 B for RGBA8 (+⅓ for mips). */
export function textureBytes(texture: Texture): number {
  const s = texture.source;
  const compressed = /^(bc\d|etc|eac|astc)/.test(s.format);
  const base = s.pixelWidth * s.pixelHeight * (compressed ? 1 : 4);
  return s.mipLevelCount > 1 ? Math.ceil((base * 4) / 3) : base;
}

/**
 * Load a file-backed texture and register its bytes in `budget` under `key` (plates put their layer
 * generation in the key). KTX2 goes through `import 'pixi.js/ktx2'` with the transcoder served/emitted
 * by the vite.config.ts plugin at `transcoders/ktx/` (never copy it into public/). Call
 * `setKTXTranscoderPath` once with ABSOLUTE urls (`new URL('transcoders/ktx/libktx.js',
 * document.baseURI).href`, same for .wasm): Pixi's worker resolves relative paths against
 * location.origin. On a KTX2 failure, fall back to WebP/PNG for that chunk and disable KTX2 for the
 * session. Every load has a deadline. Returns the resolved URL: the caller holds a lease on it until
 * unloadTextureSource.
 */
export async function loadTextureSource(
  src: TextureSourceDef, baseUrl: string, support: TextureFormatSupport, budget: TextureBudget, key: string,
): Promise<{ texture: Texture; url: string }> {
  const effective = ktx2Disabled && support.ktx2 ? { ...support, ktx2: false } : support;
  const url = chooseTextureUrl(src, effective, baseUrl);
  if (!url) throw new Error(`No loadable texture for ${key}`);
  if (effective.ktx2 && src.ktx2) {
    try {
      configureKtx2();
      const texture = await loadWithTimeout(url, KTX2_TIMEOUT_MS);
      budget.set(key, textureBytes(texture));
      return { texture, url };
    } catch (err) {
      console.warn(`[assets] KTX2 failed for ${key}; using WebP/PNG for the rest of the session`, err);
      ktx2Disabled = true;
      return loadTextureSource(src, baseUrl, { ...support, ktx2: false }, budget, key);
    }
  }
  const texture = await loadWithTimeout(url, IMAGE_TIMEOUT_MS);
  budget.set(key, textureBytes(texture));
  return { texture, url };
}

/**
 * Remove `key` from the budget and give up this lease on `url`; the texture is unloaded (Assets.unload,
 * which clears Pixi's loader cache too) once no lease or pending load remains.
 */
export async function unloadTextureSource(url: string, budget: TextureBudget, key: string): Promise<void> {
  budget.remove(key);
  const u = uses.get(url);
  if (!u || u.leases <= 0) return;
  u.leases--;
  if (u.leases > 0 || u.pending > 0) return;
  uses.delete(url);
  await Assets.unload(url);
}
