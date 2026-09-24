import type { Extent } from '../render/util/camera.ts';

export interface StreamChunk {
  /** Stable key, e.g. `${layerId}:${col}:${row}`. */
  key: string;
  /** Layer-space rect. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
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
 * Pure chunk-streaming policy (no Pixi, no fetch). Each frame: `update(visible)` marks chunks
 * intersecting visible+margin as wanted. `nextLoads()` yields wanted & unloaded chunks nearest the
 * visible centre first, respecting maxInFlight. When loaded bytes exceed the budget, `evictions()`
 * yields least-recently-wanted loaded chunks that are not currently visible. The caller reports
 * progress with markLoading/markLoaded/markUnloaded. Per-frame calls allocate nothing.
 *
 * Prefetch never overruns the budget: a chunk that is wanted but not visible starts loading only if
 * the loaded + in-flight bytes stay within the budget. Otherwise a budget smaller than the wanted
 * set would evict a prefetched chunk right after it arrives and request it again the next frame,
 * forever. Visible chunks always load (evicting others as needed).
 */
export class ChunkStreamer {
  private readonly chunks: readonly StreamChunk[];
  private readonly index = new Map<string, number>();
  private readonly states: Uint8Array;
  private readonly wanted: Uint8Array;
  private readonly visible: Uint8Array;
  /** Chunks that failed to load for good: never offered by nextLoads again. */
  private readonly failed: Uint8Array;
  private readonly lastWanted: Float64Array;
  private readonly dist: Float64Array;
  private readonly sel: Int32Array;
  private readonly options: StreamerOptions;
  private loaded = 0;
  private inFlight = 0;
  private inFlightBytes = 0;

  constructor(chunks: readonly StreamChunk[], options: StreamerOptions) {
    this.chunks = chunks;
    this.options = { ...options };
    const n = chunks.length;
    this.states = new Uint8Array(n);
    this.wanted = new Uint8Array(n);
    this.visible = new Uint8Array(n);
    this.failed = new Uint8Array(n);
    this.lastWanted = new Float64Array(n).fill(-Infinity);
    this.dist = new Float64Array(n);
    this.sel = new Int32Array(Math.max(1, options.maxInFlight, n));
    for (let i = 0; i < n; i++) {
      const key = (chunks[i] as StreamChunk).key;
      if (this.index.has(key)) throw new Error(`ChunkStreamer: duplicate chunk key ${key}`);
      this.index.set(key, i);
    }
  }

  get budgetBytes(): number {
    return this.options.budgetBytes;
  }

  /** Change the byte budget (quality changes); evictions() applies it. */
  setBudget(bytes: number): void {
    this.options.budgetBytes = bytes;
  }

  update(visible: Extent, frame: number): void {
    const m = this.options.margin;
    const cx = (visible.x0 + visible.x1) * 0.5;
    const cy = (visible.y0 + visible.y1) * 0.5;
    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i] as StreamChunk;
      const vis = c.x1 > visible.x0 && c.x0 < visible.x1 && c.y1 > visible.y0 && c.y0 < visible.y1;
      const want = c.x1 > visible.x0 - m && c.x0 < visible.x1 + m && c.y1 > visible.y0 - m && c.y0 < visible.y1 + m;
      this.visible[i] = vis ? 1 : 0;
      this.wanted[i] = want ? 1 : 0;
      if (want) this.lastWanted[i] = frame;
      const dx = (c.x0 + c.x1) * 0.5 - cx;
      const dy = (c.y0 + c.y1) * 0.5 - cy;
      this.dist[i] = dx * dx + dy * dy;
    }
  }

  /** Fills `out` (cleared first) with chunks to start loading now; returns `out`. */
  nextLoads(out: StreamChunk[]): StreamChunk[] {
    out.length = 0;
    let slots = this.options.maxInFlight - this.inFlight;
    if (slots <= 0) return out;
    // Insertion-sort every wanted & unloaded chunk by distance (indices in `sel`).
    const sel = this.sel;
    let n = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.wanted[i] !== 1 || this.states[i] !== UNLOADED || this.failed[i] === 1) continue;
      const d = this.dist[i] as number;
      let at = n;
      while (at > 0 && d < (this.dist[sel[at - 1] as number] as number)) at--;
      for (let k = n; k > at; k--) sel[k] = sel[k - 1] as number;
      sel[at] = i;
      n++;
    }
    // Nearest first; prefetch-only chunks must fit in the budget left after loaded + in-flight bytes.
    let room = this.options.budgetBytes - this.loaded - this.inFlightBytes;
    for (let k = 0; k < n && slots > 0; k++) {
      const i = sel[k] as number;
      const c = this.chunks[i] as StreamChunk;
      if (this.visible[i] !== 1 && c.bytes > room) continue;
      out.push(c);
      room -= c.bytes;
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
      const c = this.chunks[best] as StreamChunk;
      out.push(c);
      excess -= c.bytes;
    }
    return out;
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
    const bytes = (this.chunks[i] as StreamChunk).bytes;
    if (this.states[i] === LOADED) this.loaded -= bytes;
    this.states[i] = LOADING;
    this.inFlight++;
    this.inFlightBytes += bytes;
  }

  markLoaded(key: string): void {
    const i = this.at(key);
    if (this.states[i] === LOADED) return;
    const bytes = (this.chunks[i] as StreamChunk).bytes;
    if (this.states[i] === LOADING) {
      this.inFlight--;
      this.inFlightBytes -= bytes;
    }
    this.states[i] = LOADED;
    this.loaded += bytes;
  }

  markUnloaded(key: string): void {
    const i = this.at(key);
    const bytes = (this.chunks[i] as StreamChunk).bytes;
    if (this.states[i] === LOADING) {
      this.inFlight--;
      this.inFlightBytes -= bytes;
    } else if (this.states[i] === LOADED) {
      this.loaded -= bytes;
    }
    this.states[i] = UNLOADED;
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
