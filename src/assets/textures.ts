import { Assets, detectWebp, setKTXTranscoderPath, type Texture, type WebGLRenderer } from 'pixi.js';
import 'pixi.js/ktx2';
import type { TextureSourceDef } from '../contracts/assets.ts';
import type { TextureBudget } from '../contracts/render.ts';

export interface TextureFormatSupport {
  /** GPU can sample a Basis/KTX2 transcode target (BC7/BC3/ETC2/ASTC). */
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

let supportPromise: Promise<TextureFormatSupport> | null = null;

/** Probe compressed-format and WebP support once (cached). */
export async function detectTextureSupport(renderer: WebGLRenderer): Promise<TextureFormatSupport> {
  supportPromise ??= (async () => {
    const ext = renderer.context.extensions;
    // Targets Pixi's KTX2 transcoder can produce: BC7 (bptc), BC3 (s3tc), ETC2 (etc), ASTC 4×4.
    const ktx2 = !!(ext.bptc || ext.s3tc || ext.etc || ext.astc);
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

/** Assets.load with a deadline; a result that arrives after the deadline is unloaded again. */
function loadWithTimeout(url: string, ms: number): Promise<Texture> {
  return new Promise<Texture>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    Assets.load<Texture>(url).then(
      (texture) => {
        if (settled) {
          void Assets.unload(url);
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(texture);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
 * Load a file-backed texture and register its bytes in `budget` under `key`. KTX2 goes through
 * `import 'pixi.js/ktx2'` with the transcoder served/emitted by the vite.config.ts plugin at
 * `transcoders/ktx/` (never copy it into public/). Call `setKTXTranscoderPath` once with ABSOLUTE urls
 * (`new URL('transcoders/ktx/libktx.js', document.baseURI).href`, same for .wasm): Pixi's worker
 * resolves relative paths against location.origin. On a KTX2 failure, fall back to WebP/PNG for that
 * chunk and disable KTX2 for the session. Returns the resolved URL (needed to unload).
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
  const texture = await Assets.load<Texture>(url);
  budget.set(key, textureBytes(texture));
  return { texture, url };
}

/** Release via `Assets.unload(url)` (clears Pixi's loader cache too) and remove from the budget. */
export async function unloadTextureSource(url: string, budget: TextureBudget, key: string): Promise<void> {
  budget.remove(key);
  await Assets.unload(url);
}
