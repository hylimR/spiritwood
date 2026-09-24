import type { GpuInfo } from '../../contracts/quality.ts';
import { classifyGpu } from '../../settings/quality.ts';

interface TimerQueryExt {
  readonly TIME_ELAPSED_EXT: number;
  readonly GPU_DISJOINT_EXT: number;
}

/** Read the GPU facts auto quality needs (unmasked renderer string when exposed). */
export function probeGpu(gl: WebGL2RenderingContext): GpuInfo {
  let renderer = '';
  let vendor = '';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  if (dbg) {
    renderer = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) ?? '');
    vendor = String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) ?? '');
  }
  if (!renderer) renderer = String(gl.getParameter(gl.RENDERER) ?? '');
  if (!vendor) vendor = String(gl.getParameter(gl.VENDOR) ?? '');
  return {
    renderer,
    vendor,
    tier: classifyGpu(renderer, vendor),
    maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096,
    timerQuery: gl.getExtension('EXT_disjoint_timer_query_webgl2') !== null,
  };
}

const RING = 4;

/**
 * GPU frame time from EXT_disjoint_timer_query_webgl2: one TIME_ELAPSED query around all of a frame's
 * passes, a ring of 4 queries polled without blocking; results are dropped on GPU_DISJOINT_EXT.
 * `ms` is the latest result, −1 when the extension is missing (Firefox, Safari, some drivers).
 */
export class GpuTimer {
  ms = -1;
  private readonly gl: WebGL2RenderingContext;
  private ext: TimerQueryExt | null = null;
  private readonly queries: (WebGLQuery | null)[] = [];
  private readonly pending = new Uint8Array(RING);
  private active = -1;
  private next = 0;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.restore();
  }

  get supported(): boolean {
    return this.ext !== null;
  }

  /** (Re)create the queries, e.g. after a context restore. */
  restore(): void {
    this.ext = this.gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExt | null;
    this.queries.length = 0;
    this.pending.fill(0);
    this.active = -1;
    this.next = 0;
    this.ms = -1;
    if (!this.ext) return;
    for (let i = 0; i < RING; i++) this.queries.push(this.gl.createQuery());
  }

  begin(): void {
    const ext = this.ext;
    if (!ext || this.active >= 0) return;
    this.poll();
    const i = this.next;
    const q = this.queries[i];
    if (!q || this.pending[i]) return;
    this.gl.beginQuery(ext.TIME_ELAPSED_EXT, q);
    this.active = i;
  }

  end(): void {
    const ext = this.ext;
    if (!ext || this.active < 0) return;
    this.gl.endQuery(ext.TIME_ELAPSED_EXT);
    this.pending[this.active] = 1;
    this.next = (this.active + 1) % RING;
    this.active = -1;
  }

  /** Collect finished queries oldest → newest (slot `next` is the oldest), so `ms` ends on the newest. */
  private poll(): void {
    const ext = this.ext;
    if (!ext) return;
    const gl = this.gl;
    for (let k = 0; k < RING; k++) {
      const i = (this.next + k) % RING;
      const q = this.queries[i];
      if (!q || !this.pending[i]) continue;
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) continue;
      this.pending[i] = 0;
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) continue;
      this.ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
    }
  }

  destroy(): void {
    for (const q of this.queries) if (q) this.gl.deleteQuery(q);
    this.queries.length = 0;
    this.ext = null;
  }
}

const DRAW_FUNCTIONS = ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced', 'drawRangeElements'] as const;

/**
 * Counts draw calls by wrapping the context's draw entry points once (fixed-arity wrappers installed on
 * the context instance, so they allocate nothing and survive a context restore). `reset` at frame
 * start, read `count` at the end.
 */
export class DrawCounter {
  count = 0;
  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const proto = Object.getPrototypeOf(gl) as WebGL2RenderingContext;
    const drawElements = proto.drawElements;
    const drawArrays = proto.drawArrays;
    const drawElementsInstanced = proto.drawElementsInstanced;
    const drawArraysInstanced = proto.drawArraysInstanced;
    const drawRangeElements = proto.drawRangeElements;
    gl.drawElements = (mode, count, type, offset) => {
      this.count++;
      drawElements.call(gl, mode, count, type, offset);
    };
    gl.drawArrays = (mode, first, count) => {
      this.count++;
      drawArrays.call(gl, mode, first, count);
    };
    gl.drawElementsInstanced = (mode, count, type, offset, instances) => {
      this.count++;
      drawElementsInstanced.call(gl, mode, count, type, offset, instances);
    };
    gl.drawArraysInstanced = (mode, first, count, instances) => {
      this.count++;
      drawArraysInstanced.call(gl, mode, first, count, instances);
    };
    gl.drawRangeElements = (mode, start, end, count, type, offset) => {
      this.count++;
      drawRangeElements.call(gl, mode, start, end, count, type, offset);
    };
  }

  reset(): void {
    this.count = 0;
  }

  /** Remove the wrappers (the prototype methods show through again). */
  destroy(): void {
    const target = this.gl as unknown as Record<string, unknown>;
    for (const name of DRAW_FUNCTIONS) delete target[name];
  }
}
