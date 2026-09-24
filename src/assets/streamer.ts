import { todo } from '../core/todo.ts';
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

/**
 * Pure chunk-streaming policy (no Pixi, no fetch). Each frame: `update(visible)` marks chunks
 * intersecting visible+margin as wanted. `nextLoads()` yields wanted & unloaded chunks nearest the
 * visible centre first, respecting maxInFlight. When loaded bytes exceed the budget, `evictions()`
 * yields least-recently-wanted loaded chunks that are not currently visible. The caller reports
 * progress with markLoading/markLoaded/markUnloaded.
 */
export class ChunkStreamer {
  constructor(chunks: readonly StreamChunk[], options: StreamerOptions) {
    void chunks; void options;
    todo('WORLD', 'ChunkStreamer');
  }

  update(visible: Extent, frame: number): void {
    void visible; void frame;
    todo('WORLD', 'ChunkStreamer.update');
  }

  /** Fills `out` (cleared first) with chunks to start loading now; returns `out`. */
  nextLoads(out: StreamChunk[]): StreamChunk[] {
    void out;
    return todo('WORLD', 'ChunkStreamer.nextLoads');
  }

  /** Fills `out` (cleared first) with loaded chunks to evict now; returns `out`. */
  evictions(out: StreamChunk[]): StreamChunk[] {
    void out;
    return todo('WORLD', 'ChunkStreamer.evictions');
  }

  isVisible(key: string): boolean {
    void key;
    return todo('WORLD', 'ChunkStreamer.isVisible');
  }

  state(key: string): ChunkState {
    void key;
    return todo('WORLD', 'ChunkStreamer.state');
  }

  markLoading(key: string): void {
    void key;
    todo('WORLD', 'ChunkStreamer.markLoading');
  }

  markLoaded(key: string): void {
    void key;
    todo('WORLD', 'ChunkStreamer.markLoaded');
  }

  markUnloaded(key: string): void {
    void key;
    todo('WORLD', 'ChunkStreamer.markUnloaded');
  }

  get loadedBytes(): number {
    return todo('WORLD', 'ChunkStreamer.loadedBytes');
  }
}
