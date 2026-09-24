import type { LayerDef, LayerManifest, PlateLayerDef } from '../contracts/assets.ts';
import { loadManifest } from './manifest.ts';

/** Sent by tools/art/vite-plugin.ts when only a plate's pixels or colour changed: `{ id }`. */
export const PLATE_UPDATED_EVENT = 'spiritwood:plate-updated';

/** The part of `import.meta.hot` this module uses (tests pass a fake). */
export interface HotChannel {
  on(event: string, cb: (data: unknown) => void): void;
}

/** A view that draws plate layers from a manifest (the parallax stack). */
export interface PlateHotTarget {
  /** Absolute URL the manifest was loaded from. */
  readonly manifestUrl: string;
  /** The manifest the target draws: as loaded, updated by every reloadPlate (never failure fallbacks). */
  currentManifest(): LayerManifest;
  /**
   * Evict, rebuild and re-stream one plate layer from its new definition, updating the target's own
   * copy of the manifest. False when it can't (the caller then reloads the page).
   */
  reloadPlate(def: PlateLayerDef, manifest: LayerManifest): boolean;
}

export interface PlateHotReloadDeps {
  /** Fetch and parse the manifest, bypassing caches. */
  fetchManifest(url: string): Promise<LayerManifest>;
  /** Full page reload. */
  reloadPage(): void;
  log?(message: string): void;
}

export type HotReloadOutcome = 'reloaded' | 'full-reload' | 'ignored';

function layerShape(l: LayerDef): string {
  return `${l.kind}:${l.id}@${l.parallax[0]}/${l.parallax[1]}:${l.minQuality}`;
}

/**
 * Differences a live layer reload can't absorb (§5.8: parallax, replaces, minQuality, a plate added or
 * deleted): the layer list's ids, kinds, order, parallax and quality gates, and the replaced layers.
 * Null when only per-layer content (pixels, colours, placement) differs.
 */
export function structuralDifference(a: LayerManifest, b: LayerManifest): string | null {
  if (a.layers.length !== b.layers.length) return `layer count ${a.layers.length} → ${b.layers.length}`;
  for (let i = 0; i < a.layers.length; i++) {
    const x = layerShape(a.layers[i] as LayerDef);
    const y = layerShape(b.layers[i] as LayerDef);
    if (x !== y) return `layer ${i}: ${x} → ${y}`;
    const la = a.layers[i] as LayerDef;
    const lb = b.layers[i] as LayerDef;
    // Only plate layers reload live; any other layer's content changing needs a rebuild of the stack.
    if (la.kind !== 'plate' && JSON.stringify(la) !== JSON.stringify(lb)) return `layer ${la.id} changed`;
  }
  const ra = a.replaced ?? {};
  const rb = b.replaced ?? {};
  const plates = Object.keys(ra);
  if (plates.length !== Object.keys(rb).length) return 'replaced layers';
  for (const plate of plates) if (rb[plate]?.id !== ra[plate]?.id) return `replaced layer of ${plate}`;
  if (JSON.stringify(a.textureBudgetMB) !== JSON.stringify(b.textureBudgetMB) || JSON.stringify(a.atlases) !== JSON.stringify(b.atlases)) {
    return 'budgets or atlases';
  }
  return null;
}

/**
 * Dev hot reload of painted plates (§5.8), fed by a Vite HMR channel: on `spiritwood:plate-updated
 * { id }` every registered target re-fetches its manifest; a structural difference (or an unknown id,
 * or a target that can't reload the layer) reloads the page, otherwise the target reloads that layer.
 */
export class PlateHotReload {
  private readonly targets = new Set<PlateHotTarget>();
  private readonly deps: PlateHotReloadDeps;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(channel: HotChannel, deps: PlateHotReloadDeps) {
    this.deps = deps;
    channel.on(PLATE_UPDATED_EVENT, (data) => {
      this.queue = this.queue.then(() => this.handle(data), () => this.handle(data));
    });
  }

  register(target: PlateHotTarget): () => void {
    this.targets.add(target);
    return () => {
      this.targets.delete(target);
    };
  }

  /** Handle one message (serialised through a queue when it comes from the channel). */
  async handle(data: unknown): Promise<HotReloadOutcome> {
    const id = typeof data === 'object' && data !== null && typeof (data as { id?: unknown }).id === 'string' ? (data as { id: string }).id : null;
    const log = (m: string): void => this.deps.log?.(`[plates] ${m}`);
    if (id === null) {
      log(`ignored a malformed ${PLATE_UPDATED_EVENT} message`);
      return 'ignored';
    }
    if (this.targets.size === 0) return 'ignored';
    for (const t of [...this.targets]) {
      let next: LayerManifest;
      try {
        next = await this.deps.fetchManifest(t.manifestUrl);
      } catch (e) {
        log(`could not re-fetch ${t.manifestUrl} (${e instanceof Error ? e.message : String(e)}); reloading the page`);
        this.deps.reloadPage();
        return 'full-reload';
      }
      const diff = structuralDifference(t.currentManifest(), next);
      const def = next.layers.find((l) => l.id === id);
      if (diff || !def || def.kind !== 'plate') {
        log(`${id}: ${diff ?? 'not a plate layer of the new manifest'}; reloading the page`);
        this.deps.reloadPage();
        return 'full-reload';
      }
      if (!t.reloadPlate(def, next)) {
        log(`${id}: the stack could not reload the layer; reloading the page`);
        this.deps.reloadPage();
        return 'full-reload';
      }
      log(`${id}: reloaded`);
    }
    return 'reloaded';
  }
}

let installed: PlateHotReload | null = null;

/**
 * Register a plate target for dev hot reload. Outside the Vite dev server `import.meta.hot` is
 * undefined (and the whole body is dropped from production builds), so this is a no-op there.
 */
export function registerPlateHotReload(target: PlateHotTarget): () => void {
  if (!import.meta.hot) return () => undefined;
  installed ??= new PlateHotReload(import.meta.hot, {
    fetchManifest: (url) => loadManifest(url, (input, init) => fetch(input, { ...init, cache: 'no-store' })),
    reloadPage: () => window.location.reload(),
    log: (m) => console.info(m),
  });
  return installed.register(target);
}
