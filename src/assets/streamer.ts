import type { Extent } from '../render/util/camera.ts';

export interface StreamChunk {
  /** Stable key, e.g. `${layerId}#${generation}:${col}:${row}`. */
  key: string;
  /** Owning layer for `updateLayer` (default 0, for a streamer that serves one layer). */
  layer?: number;
  /** Layer-space rect. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Estimated bytes before the chunk loads; `markLoaded(key, bytes)` replaces it with the real size. */
  bytes: number;
}

export type ChunkState = 'unloaded' | 'loading' | 'loaded';

export interface StreamerOptions {
  /** Extra layer-space margin around the visible rect to prefetch. */
  margin: number;
  maxInFlight: number;
  budgetBytes: number;
}

const UNLOADED = 0;
const LOADING = 1;
const LOADED = 2;
const STATE_NAMES: readonly ChunkState[] = ['unloaded', 'loading', 'loaded'];

/**
 * Pure chunk-streaming policy (no Pixi, no fetch), shared by every plate layer (ARCHITECTURE.md §5.8):
 * one budget and one least-recently-wanted order across all layers. Each frame, `updateLayer(i,
 * visible)` marks layer i's chunks that intersect its visible rect (+ margin) as visible / wanted (null
 * = the layer is off: nothing wanted); `update(visible)` does it for every chunk at once. `nextLoads()`
 * yields wanted & unloaded chunks, visible ones first, each nearest its layer's visible centre first,
 * respecting maxInFlight. When loaded bytes exceed the budget, `evictions()` yields least-recently-wanted
 * loaded chunks that are not currently visible. The caller reports progress with
 * markLoading/markLoaded/markUnloaded; markLoaded can pass the loaded texture's real size (a KTX2 chunk
 * that arrives as RGBA8 after a transcoder failure is 3× its estimate), which replaces the estimate
 * until the chunk unloads. Per-frame calls allocate nothing.
 *
 * Prefetch never overruns the budget: a chunk that is wanted but not visible starts loading only if
 * the loaded + in-flight bytes stay within the budget. Otherwise a budget smaller than the wanted
 * set would evict a prefetched chunk right after it arrives and request it again the next frame,
 * forever. Visible chunks always load, evicting others as needed (the bake keeps them in budget).
 */
export class ChunkStreamer {
  private chunks: readonly StreamChunk[] = [];
  private index = new Map<string, number>();
  private layerOf = new Int32Array(0);
  private states = new Uint8Array(0);
  private wanted = new Uint8Array(0);
  private visible = new Uint8Array(0);
  /** Chunks that failed to load for good: never offered by nextLoads again. */
  private failed = new Uint8Array(0);
  private lastWanted = new Float64Array(0);
  /** Bytes each chunk counts for: its estimate, or its real size while loaded with one. */
  private size = new Float64Array(0);
  private dist = new Float64Array(0);
  private sel = new Int32Array(1);
  private readonly options: StreamerOptions;
  private loaded = 0;
  private inFlight = 0;
  private inFlightBytes = 0;

  constructor(chunks: readonly StreamChunk[], options: StreamerOptions) {
    this.options = { ...options };
    this.setChunks(chunks);
  }

  get budgetBytes(): number {
    return this.options.budgetBytes;
  }

  /** Change the byte budget (quality changes, atlases registered later); evictions() applies it. */
  setBudget(bytes: number): void {
    this.options.budgetBytes = bytes;
  }

  get chunkCount(): number {
    return this.chunks.length;
  }

  /**
   * Replace the chunk set (a layer added, rebuilt or removed). Chunks whose key stays keep their state;
   * dropped chunks are forgotten (their in-flight loads no longer count), so the caller releases
   * whatever it loaded for them.
   */
  setChunks(chunks: readonly StreamChunk[]): void {
    const n = chunks.length;
    const index = new Map<string, number>();
    for (let i = 0; i < n; i++) {
      const key = (chunks[i] as StreamChunk).key;
      if (index.has(key)) throw new Error(`ChunkStreamer: duplicate chunk key ${key}`);
      index.set(key, i);
    }
    const states = new Uint8Array(n);
    const wanted = new Uint8Array(n);
    const visible = new Uint8Array(n);
    const failed = new Uint8Array(n);
    const lastWanted = new Float64Array(n).fill(-Infinity);
    const layerOf = new Int32Array(n);
    const size = new Float64Array(n);
    this.loaded = 0;
    this.inFlight = 0;
    this.inFlightBytes = 0;
    for (let i = 0; i < n; i++) {
      const c = chunks[i] as StreamChunk;
      layerOf[i] = c.layer ?? 0;
      size[i] = c.bytes;
      const old = this.index.get(c.key);
      if (old === undefined) continue;
      states[i] = this.states[old] as number;
      wanted[i] = this.wanted[old] as number;
      visible[i] = this.visible[old] as number;
      failed[i] = this.failed[old] as number;
      lastWanted[i] = this.lastWanted[old] as number;
      if (states[i] !== UNLOADED) size[i] = this.size[old] as number;
      if (states[i] === LOADED) this.loaded += size[i] as number;
      else if (states[i] === LOADING) {
        this.inFlight++;
        this.inFlightBytes += size[i] as number;
      }
    }
    this.chunks = chunks;
    this.index = index;
    this.states = states;
    this.wanted = wanted;
    this.visible = visible;
    this.failed = failed;
    this.lastWanted = lastWanted;
    this.layerOf = layerOf;
    this.size = size;
    this.dist = new Float64Array(n);
    this.sel = new Int32Array(Math.max(1, this.options.maxInFlight, n));
  }

  /** Every chunk against one visible rect (a streamer serving one layer). */
  update(visible: Extent, frame: number): void {
    for (let i = 0; i < this.chunks.length; i++) this.mark(i, visible, frame);
  }

  /** Layer `layer`'s chunks against its visible rect; null switches the layer off (nothing wanted). */
  updateLayer(layer: number, visible: Extent | null, frame: number): void {
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.layerOf[i] !== layer) continue;
      if (visible) this.mark(i, visible, frame);
      else {
        this.visible[i] = 0;
        this.wanted[i] = 0;
      }
    }
  }

  private mark(i: number, visible: Extent, frame: number): void {
    const m = this.options.margin;
    const c = this.chunks[i] as StreamChunk;
    const vis = c.x1 > visible.x0 && c.x0 < visible.x1 && c.y1 > visible.y0 && c.y0 < visible.y1;
    const want = c.x1 > visible.x0 - m && c.x0 < visible.x1 + m && c.y1 > visible.y0 - m && c.y0 < visible.y1 + m;
    this.visible[i] = vis ? 1 : 0;
    this.wanted[i] = want ? 1 : 0;
    if (want) this.lastWanted[i] = frame;
    const dx = (c.x0 + c.x1 - visible.x0 - visible.x1) * 0.5;
    const dy = (c.y0 + c.y1 - visible.y0 - visible.y1) * 0.5;
    this.dist[i] = dx * dx + dy * dy;
  }

  /** Load order: visible before prefetch-only, then nearest first. */
  private before(i: number, j: number): boolean {
    const vi = this.visible[i] as number;
    const vj = this.visible[j] as number;
    return vi !== vj ? vi > vj : (this.dist[i] as number) < (this.dist[j] as number);
  }

  /** Fills `out` (cleared first) with chunks to start loading now; returns `out`. */
  nextLoads(out: StreamChunk[]): StreamChunk[] {
    out.length = 0;
    let slots = this.options.maxInFlight - this.inFlight;
    if (slots <= 0) return out;
    // Insertion-sort every wanted & unloaded chunk: visible first, then nearest (indices in `sel`).
    const sel = this.sel;
    let n = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.wanted[i] !== 1 || this.states[i] !== UNLOADED || this.failed[i] === 1) continue;
      let at = n;
      while (at > 0 && this.before(i, sel[at - 1] as number)) at--;
      for (let k = n; k > at; k--) sel[k] = sel[k - 1] as number;
      sel[at] = i;
      n++;
    }
    // Prefetch-only chunks must fit in the budget left after loaded + in-flight bytes.
    let room = this.options.budgetBytes - this.loaded - this.inFlightBytes;
    for (let k = 0; k < n && slots > 0; k++) {
      const i = sel[k] as number;
      const bytes = this.size[i] as number;
      if (this.visible[i] !== 1 && bytes > room) continue;
      out.push(this.chunks[i] as StreamChunk);
      room -= bytes;
      slots--;
    }
    return out;
  }

  /** Fills `out` (cleared first) with loaded chunks to evict now; returns `out`. */
  evictions(out: StreamChunk[]): StreamChunk[] {
    out.length = 0;
    let excess = this.loaded - this.options.budgetBytes;
    while (excess > 0) {
      let best = -1;
      for (let i = 0; i < this.chunks.length; i++) {
        if (this.states[i] !== LOADED || this.visible[i] === 1) continue;
        const c = this.chunks[i] as StreamChunk;
        if (out.includes(c)) continue;
        if (best < 0 || (this.lastWanted[i] as number) < (this.lastWanted[best] as number)) best = i;
      }
      if (best < 0) break;
      out.push(this.chunks[best] as StreamChunk);
      excess -= this.size[best] as number;
    }
    return out;
  }

  has(key: string): boolean {
    return this.index.has(key);
  }

  isVisible(key: string): boolean {
    return this.visible[this.at(key)] === 1;
  }

  isWanted(key: string): boolean {
    return this.wanted[this.at(key)] === 1;
  }

  state(key: string): ChunkState {
    return STATE_NAMES[this.states[this.at(key)] as number] as ChunkState;
  }

  markLoading(key: string): void {
    const i = this.at(key);
    if (this.states[i] === LOADING) return;
    if (this.states[i] === LOADED) this.loaded -= this.size[i] as number;
    this.size[i] = (this.chunks[i] as StreamChunk).bytes;
    this.states[i] = LOADING;
    this.inFlight++;
    this.inFlightBytes += this.size[i] as number;
  }

  /** The chunk arrived; `bytes` is its real size when known (it then counts instead of the estimate). */
  markLoaded(key: string, bytes?: number): void {
    const i = this.at(key);
    if (this.states[i] === LOADING) {
      this.inFlight--;
      this.inFlightBytes -= this.size[i] as number;
    } else if (this.states[i] === LOADED) {
      this.loaded -= this.size[i] as number;
    }
    if (bytes !== undefined) this.size[i] = bytes;
    this.states[i] = LOADED;
    this.loaded += this.size[i] as number;
  }

  markUnloaded(key: string): void {
    const i = this.at(key);
    if (this.states[i] === LOADING) {
      this.inFlight--;
      this.inFlightBytes -= this.size[i] as number;
    } else if (this.states[i] === LOADED) {
      this.loaded -= this.size[i] as number;
    }
    this.states[i] = UNLOADED;
    this.size[i] = (this.chunks[i] as StreamChunk).bytes;
  }

  /** Bytes a chunk counts for now: its real size while loaded with one, else its estimate. */
  bytesOf(key: string): number {
    return this.size[this.at(key)] as number;
  }

  /**
   * The chunk cannot be loaded (every encoding failed): it becomes 'unloaded' and nextLoads never
   * offers it again, so a broken chunk does not take a load slot every frame.
   */
  markFailed(key: string): void {
    this.markUnloaded(key);
    this.failed[this.at(key)] = 1;
  }

  get loadedBytes(): number {
    return this.loaded;
  }

  get loadingCount(): number {
    return this.inFlight;
  }

  private at(key: string): number {
    const i = this.index.get(key);
    if (i === undefined) throw new Error(`ChunkStreamer: unknown chunk ${key}`);
    return i;
  }
}
