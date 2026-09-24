/**
 * Painted-plate hot reload, dev-server side (ARCHITECTURE.md §5.8). tools/art/vite-plugin.ts wires this
 * into Vite; everything here takes its file system, clock, bake and message channel as parameters, so
 * tests drive it with fakes and never start a server.
 *
 * - Watched `art/plates/<id>.png|json` writes are debounced until the files' sizes are stable for 200 ms.
 * - A re-bake runs off the dev-server thread (tools/art/dev-worker.ts): it hashes every chunk and
 *   WebP-encodes only chunks whose pixels differ from what is already served.
 * - The served manifest is the splice of the base manifest and the current plates; re-baked chunks list
 *   only their in-memory WebP (a stale KTX2 or PNG on disk can't win), and every texture URL carries
 *   `?v=<hash8>`. Plate files are served by the plugin's own middleware.
 * - A pixel, colour or placement change sends `spiritwood:plate-updated { id }`; a structural change
 *   (parallax, replaces, minQuality, a plate added or deleted) sends a full reload.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { parseManifest } from '../../src/assets/manifest.ts';
import { PLATE_UPDATED_EVENT } from '../../src/assets/hotReload.ts';
import { hash8, PLATE_TEXTURE } from '../../src/assets/plateLayout.ts';
import { spliceManifest } from '../../src/assets/splice.ts';
import type { LayerManifest, PlateChunkDef, PlateLayerDef } from '../../src/contracts/assets.ts';
import { ART_TOOL_VERSION, readLock, reservedPlateIds, sourceHash, type ArtLock, type LockChunk } from './bake.ts';
import { budgetLayer, defaultSweep, sweepBudget, type AtlasMeasure } from './budget.ts';
import { chunkSource } from './chunks.ts';
import { encodeWebp } from './encode.ts';
import { formatJson } from './json.ts';
import { chunkFile, type ArtPaths } from './paths.ts';
import { parseSidecar, plateLayerDef, PLATE_ID_RE, structuralChange, type Sidecar } from './sidecar.ts';
import { inspectPng, pngSource } from './source.ts';

/** Writes are processed once the files' sizes have not changed for this long. */
export const STABLE_MS = 200;
/** Debouncer key of the committed state (base manifest + lock); plate ids can't contain ':'. */
const COMMITTED = ':committed';
const POLL_MS = 50;

export type HotPayload = { type: 'full-reload' } | { type: 'custom'; event: string; data: { id: string } };

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** File size, or −1 when the file does not exist. */
export type StatFn = (path: string) => number;

/**
 * Fires `fire(id)` once every file of `id` has kept its size for STABLE_MS (a file being written by a
 * paint program grows in steps; a deleted file counts as size −1).
 */
export class StableDebouncer {
  private readonly pending = new Map<string, { files: string[]; sizes: number[]; since: number }>();
  private timer: unknown = null;
  private readonly clock: Clock;
  private readonly stat: StatFn;
  private readonly fire: (id: string) => void;

  constructor(clock: Clock, stat: StatFn, fire: (id: string) => void) {
    this.clock = clock;
    this.stat = stat;
    this.fire = fire;
  }

  touch(id: string, files: string[]): void {
    this.pending.set(id, { files, sizes: files.map(this.stat), since: this.clock.now() });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer !== null || this.pending.size === 0) return;
    this.timer = this.clock.setTimeout(() => {
      this.timer = null;
      this.poll();
    }, POLL_MS);
  }

  private poll(): void {
    const now = this.clock.now();
    for (const [id, p] of [...this.pending]) {
      const sizes = p.files.map(this.stat);
      if (sizes.some((s, i) => s !== p.sizes[i])) {
        p.sizes = sizes;
        p.since = now;
      } else if (now - p.since >= STABLE_MS) {
        this.pending.delete(id);
        this.fire(id);
      }
    }
    this.schedule();
  }

  get waiting(): number {
    return this.pending.size;
  }

  close(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }
}

/** A chunk as the dev server serves it: from the committed bake, or re-baked in memory (WebP only). */
export interface DevChunk extends Omit<LockChunk, 'files'> {
  dev: boolean;
}

export interface DevPlate {
  id: string;
  sidecar: Sidecar;
  sourceHash: string;
  width: number;
  height: number;
  chunks: DevChunk[];
}

export interface DevBakeRequest {
  id: string;
  png: string;
  width: number;
  height: number;
  /** Chunks whose pixels are already served: "col,row" → hash. Those are not re-encoded. */
  known: Record<string, string>;
}

export interface DevBakeResult {
  chunks: Omit<LockChunk, 'files'>[];
  /** WebP bytes of the chunks that were not known, by "col,row". */
  webp: Record<string, Uint8Array>;
}

/** The re-bake a worker runs: hash every chunk, WebP-encode the unknown ones. */
export async function devBakePlate(req: DevBakeRequest): Promise<DevBakeResult> {
  const out: DevBakeResult = { chunks: [], webp: {} };
  for await (const c of chunkSource(pngSource(req.png, { width: req.width, height: req.height }))) {
    const key = `${c.col},${c.row}`;
    out.chunks.push({ col: c.col, row: c.row, hash: c.hash, core: c.core, soft: c.soft });
    if (req.known[key] !== c.hash) out.webp[key] = await encodeWebp(c.rgba, PLATE_TEXTURE, PLATE_TEXTURE);
  }
  return out;
}

/** The plate layer the dev server serves: committed chunks keep all encodings, re-baked ones only WebP. */
export function devPlateLayer(p: DevPlate): PlateLayerDef {
  const def = plateLayerDef(p.id, p.sidecar);
  def.chunks = p.chunks.map((c): PlateChunkDef => {
    const v = `?v=${hash8(c.hash)}`;
    const webp = `${chunkFile(p.id, c.col, c.row, 'webp')}${v}`;
    const source = c.dev
      ? { webp }
      : { ktx2: `${chunkFile(p.id, c.col, c.row, 'ktx2')}${v}`, webp, png: `${chunkFile(p.id, c.col, c.row, 'png')}${v}` };
    return { col: c.col, row: c.row, source, core: [...c.core], soft: [...c.soft], hash: c.hash };
  });
  return def;
}

/** The manifest the dev server serves: the base with the current plates spliced in. Throws on a bad splice. */
export function devManifest(base: LayerManifest, plates: readonly DevPlate[]): LayerManifest {
  const m = spliceManifest(base, plates.map((p) => ({ layer: devPlateLayer(p), replaces: p.sidecar.replaces })));
  parseManifest(JSON.parse(JSON.stringify(m)));
  return m;
}

export interface DevLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface ArtDevDeps {
  paths: ArtPaths;
  clock: Clock;
  stat: StatFn;
  /** Runs devBakePlate off the dev-server thread (a worker) or in process (tests). */
  bake(req: DevBakeRequest): Promise<DevBakeResult>;
  /** Registered atlases for the dev budget warning (null = skip the warning). */
  atlases(): Promise<AtlasMeasure[] | null>;
  send(payload: HotPayload): void;
  log: DevLog;
  /** Level size for the budget sweep (null = skip the budget warning). */
  level: { width: number; height: number } | null;
}

export interface DevResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string | Uint8Array): void;
}

const TYPES: Readonly<Record<string, string>> = { webp: 'image/webp', png: 'image/png', ktx2: 'image/ktx2' };

/** The dev-server side of plate hot reload. */
export class ArtDevServer {
  private readonly deps: ArtDevDeps;
  private base: LayerManifest | null = null;
  private lock: ArtLock = { version: 1, tool: ART_TOOL_VERSION, plates: {} };
  /** Ids art plates can't take (base layers, the demo plate), re-read with the committed state. */
  private reserved: ReadonlyMap<string, string> = new Map();
  private readonly plates = new Map<string, DevPlate>();
  /** Re-baked WebP chunks by file name (`<id>_<col>_<row>.webp`). */
  private readonly webp = new Map<string, Uint8Array>();
  private manifestJson = '';
  private readonly debouncer: StableDebouncer;
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: ArtDevDeps) {
    this.deps = deps;
    this.debouncer = new StableDebouncer(deps.clock, deps.stat, (id) => {
      void this.enqueue(() => (id === COMMITTED ? this.reset() : this.rebake(id)));
    });
  }

  /**
   * Load the committed state, then re-bake (in the background) every plate whose source changed. Never
   * rejects: a half-saved base manifest or lock is reported, and until it parses the dev server serves
   * nothing of its own (Vite serves the committed files); saving it fixed reloads the page.
   */
  async start(): Promise<void> {
    try {
      this.loadCommitted();
    } catch (e) {
      this.deps.log.error(`[art] ${e instanceof Error ? e.message : String(e)}; serving the committed files until it is fixed`);
      return;
    }
    const ids = this.sourceIds();
    await this.enqueue(async () => {
      for (const id of ids) await this.rebake(id, true);
    });
  }

  /** Serialise work: bakes and resets never interleave. */
  private enqueue(job: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(job, job).catch((e: unknown) => this.deps.log.error(`[art] ${e instanceof Error ? e.stack ?? e.message : String(e)}`));
    return this.queue;
  }

  /** Wait for queued work (tests). */
  idle(): Promise<void> {
    return this.queue;
  }

  private sourceIds(): string[] {
    const dir = this.deps.paths.plates;
    const ids = new Set<string>();
    if (!existsSync(dir)) return [];
    for (const name of readdirSafe(dir)) {
      const m = /^(.+)\.(png|json)$/.exec(name);
      if (m && PLATE_ID_RE.test(m[1] as string)) ids.add(m[1] as string);
    }
    return [...ids].sort();
  }

  /**
   * Read the base manifest, the bake lock and the committed plates. Everything is parsed before any state
   * changes, so a half-saved file throws (with the file named) and leaves the served state as it was.
   */
  private loadCommitted(): void {
    const { paths, log } = this.deps;
    let base: LayerManifest;
    try {
      base = parseManifest(JSON.parse(readFileSync(paths.base, 'utf8')));
    } catch (e) {
      throw new Error(`${relative(paths.root, paths.base)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    let lock: ArtLock;
    try {
      lock = readLock(paths.lock);
    } catch (e) {
      throw new Error(`${relative(paths.root, paths.lock)}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const reserved = reservedPlateIds(paths);
    const plates = new Map<string, DevPlate>();
    for (const id of this.sourceIds()) {
      const locked = lock.plates[id];
      if (!locked || lock.tool !== ART_TOOL_VERSION || reserved.has(id)) continue;
      try {
        const sidecar = parseSidecar(JSON.parse(readFileSync(join(paths.plates, `${id}.json`), 'utf8')), `art/plates/${id}.json`);
        plates.set(id, {
          id, sidecar, sourceHash: locked.sourceHash, width: locked.width, height: locked.height,
          chunks: locked.chunks.map((c) => ({ col: c.col, row: c.row, hash: c.hash, core: c.core, soft: c.soft, dev: false })),
        });
      } catch (e) {
        log.warn(`[art] ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.base = base;
    this.lock = lock;
    this.reserved = reserved;
    this.plates.clear();
    for (const [id, p] of plates) this.plates.set(id, p);
    this.webp.clear();
    this.rebuildManifest();
  }

  private rebuildManifest(): boolean {
    if (!this.base) return false;
    try {
      this.manifestJson = formatJson(devManifest(this.base, [...this.plates.values()]));
      return true;
    } catch (e) {
      this.deps.log.error(`[art] ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /** The manifest JSON currently served at layers/forest.manifest.json. */
  get manifestText(): string {
    return this.manifestJson;
  }

  /** In-memory WebP of a re-baked chunk, by file name. */
  devFile(name: string): Uint8Array | undefined {
    return this.webp.get(name);
  }

  /** Watcher callback (chokidar event name and absolute path). */
  onFileEvent(event: string, file: string): void {
    const { paths } = this.deps;
    if (file === paths.base || file === paths.lock) {
      if (event === 'change' || event === 'add' || event === 'unlink') this.debouncer.touch(COMMITTED, [paths.base, paths.lock]);
      return;
    }
    const rel = relative(paths.plates, file);
    if (rel.startsWith('..') || rel.includes(sep)) return;
    const m = /^(.+)\.(png|json)$/.exec(rel);
    if (!m) return;
    const id = m[1] as string;
    this.debouncer.touch(id, [join(paths.plates, `${id}.png`), join(paths.plates, `${id}.json`)]);
  }

  /**
   * `npm run art` (or a hand edit of the base manifest) changed the committed state: reload it and the
   * page. A file that doesn't parse (half-saved) is reported and the served state kept until it does.
   */
  private async reset(): Promise<void> {
    const { log } = this.deps;
    try {
      this.loadCommitted();
    } catch (e) {
      log.error(`[art] ${e instanceof Error ? e.message : String(e)}; keeping the previous version until it is fixed`);
      return;
    }
    log.info('[art] the base manifest or the bake lock changed: reloaded the committed plates');
    for (const id of this.sourceIds()) await this.rebake(id, true);
    this.deps.send({ type: 'full-reload' });
  }

  /**
   * Re-read one plate. `quiet` (start-up, reset) updates the served state without messaging the page.
   * Invalid input is reported and the previous state kept, so a half-saved file never breaks the page.
   */
  async rebake(id: string, quiet = false): Promise<void> {
    const { paths, log } = this.deps;
    const png = join(paths.plates, `${id}.png`);
    const json = join(paths.plates, `${id}.json`);
    const hasPng = this.deps.stat(png) >= 0;
    const hasJson = this.deps.stat(json) >= 0;
    const prev = this.plates.get(id);
    if (!hasPng && !hasJson) {
      if (!prev) return;
      this.plates.delete(id);
      this.dropWebp(id, []);
      this.rebuildManifest();
      log.info(`[art] ${id}: removed; full reload`);
      if (!quiet) this.deps.send({ type: 'full-reload' });
      return;
    }
    if (!hasPng || !hasJson) {
      log.warn(`[art] ${id}: waiting for ${hasPng ? `${id}.json` : `${id}.png`} (a plate is a .png + .json pair)`);
      return;
    }
    if (!PLATE_ID_RE.test(id)) {
      log.error(`[art] "${id}" is not a valid plate id (letters, digits, - and _)`);
      return;
    }
    const owner = this.reserved.get(id);
    if (owner) {
      log.error(`[art] art/plates/${id}.png: the id "${id}" is taken by ${owner}; rename the plate`);
      return;
    }
    let sidecar: Sidecar;
    let info: { width: number; height: number };
    let hash: string;
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(json, 'utf8'));
      } catch (e) {
        throw new Error(`art/plates/${id}.json: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
      }
      sidecar = parseSidecar(raw, `art/plates/${id}.json`);
      info = await inspectPng(png, `art/plates/${id}.png`);
      hash = sourceHash(readFileSync(png), sidecar);
    } catch (e) {
      log.error(`[art] ${e instanceof Error ? e.message : String(e)} (keeping the previous version)`);
      return;
    }
    if (prev && prev.sourceHash === hash) return;
    const t0 = this.deps.clock.now();
    // Pixels already served (committed files or earlier re-bakes) are not re-encoded.
    const known: Record<string, string> = {};
    const committed = this.lock.plates[id];
    if (committed && this.lock.tool === ART_TOOL_VERSION) for (const c of committed.chunks) known[`${c.col},${c.row}`] = c.hash;
    if (prev) for (const c of prev.chunks) if (c.dev) known[`${c.col},${c.row}`] = c.hash;
    let result: DevBakeResult;
    try {
      result = await this.deps.bake({ id, png, width: info.width, height: info.height, known });
    } catch (e) {
      log.error(`[art] ${id}: re-bake failed (${e instanceof Error ? e.message : String(e)}); keeping the previous version`);
      return;
    }
    const committedHash = new Map((committed?.chunks ?? []).map((c) => [`${c.col},${c.row}`, c.hash]));
    const chunks: DevChunk[] = result.chunks.map((c) => ({ ...c, dev: committedHash.get(`${c.col},${c.row}`) !== c.hash }));
    const next: DevPlate = { id, sidecar, sourceHash: hash, width: info.width, height: info.height, chunks };
    this.plates.set(id, next);
    if (!this.rebuildManifest()) {
      if (prev) this.plates.set(id, prev);
      else this.plates.delete(id);
      this.rebuildManifest();
      return;
    }
    for (const [key, bytes] of Object.entries(result.webp)) {
      const [col, row] = key.split(',').map(Number) as [number, number];
      this.webp.set(basename(chunkFile(id, col, row, 'webp')), bytes);
    }
    this.dropWebp(id, chunks.filter((c) => c.dev));
    const encoded = Object.keys(result.webp).length;
    const structural = !prev ? 'a new plate' : structuralChange(prev.sidecar, sidecar);
    log.info(`[art] ${id}: ${chunks.length} chunk${chunks.length === 1 ? '' : 's'}, ${encoded} re-encoded (WebP) in ${(this.deps.clock.now() - t0).toFixed(0)} ms${structural ? `; ${structural} → full reload` : ''}`);
    await this.warnBudget();
    if (quiet) return;
    this.deps.send(structural ? { type: 'full-reload' } : { type: 'custom', event: PLATE_UPDATED_EVENT, data: { id } });
  }

  private dropWebp(id: string, keep: readonly DevChunk[]): void {
    const names = new Set(keep.map((c) => basename(chunkFile(id, c.col, c.row, 'webp'))));
    for (const name of [...this.webp.keys()]) if (name.startsWith(`${id}_`) && !names.has(name)) this.webp.delete(name);
  }

  private async warnBudget(): Promise<void> {
    const level = this.deps.level;
    if (!this.base || !level) return;
    const atlases = await this.deps.atlases();
    if (!atlases) return;
    const layers = [...this.plates.values()].map((p) => budgetLayer(devPlateLayer(p), p.sidecar.area));
    const r = sweepBudget(layers, this.base.textureBudgetMB, atlases, defaultSweep(level.width, level.height));
    for (const e of r.errors) this.deps.log.warn(`[art] budget: ${e} (\`npm run art\` will refuse this)`);
  }

  /**
   * Connect middleware: the dev manifest, and every plate file (re-baked ones from memory, the rest
   * from disk; Vite's own public-file index lags files created while it runs). Returns false to pass on.
   */
  handle(url: string | undefined, res: DevResponse): boolean {
    if (!url) return false;
    const path = decodeURIComponent(url.split(/[?#]/)[0] as string);
    if (path.endsWith('/layers/forest.manifest.json')) {
      if (!this.manifestJson) return false;
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(this.manifestJson);
      return true;
    }
    const at = path.lastIndexOf('/layers/plates/');
    if (at < 0) return false;
    const name = path.slice(at + '/layers/plates/'.length);
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return false;
    const ext = name.slice(name.lastIndexOf('.') + 1);
    const type = TYPES[ext];
    if (!type) return false;
    const mem = this.webp.get(name);
    const file = join(this.deps.paths.chunks, name);
    const bytes = mem ?? (existsSync(file) ? new Uint8Array(readFileSync(file)) : null);
    if (!bytes) return false;
    res.statusCode = 200;
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'no-cache');
    res.end(bytes);
    return true;
  }

  close(): void {
    this.debouncer.close();
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}
