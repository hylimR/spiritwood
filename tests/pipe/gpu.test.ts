import { describe, expect, test } from 'vitest';
import { DrawCounter, GpuTimer, probeGpu } from '../../src/render/post/gpu.ts';

const TIME_ELAPSED_EXT = 0x88bf;
const GPU_DISJOINT_EXT = 0x8fbb;

interface FakeQuery {
  id: number;
  available: boolean;
  result: number;
}

/** Just enough of WebGL2 + EXT_disjoint_timer_query_webgl2 for GpuTimer. */
class TimerGl {
  readonly QUERY_RESULT_AVAILABLE = 0x8867;
  readonly QUERY_RESULT = 0x8866;
  readonly queries: FakeQuery[] = [];
  readonly began: number[] = [];
  disjoint = false;
  hasExt = true;
  active: FakeQuery | null = null;

  getExtension(name: string): unknown {
    return name === 'EXT_disjoint_timer_query_webgl2' && this.hasExt ? { TIME_ELAPSED_EXT, GPU_DISJOINT_EXT } : null;
  }
  createQuery(): FakeQuery {
    const q = { id: this.queries.length, available: false, result: 0 };
    this.queries.push(q);
    return q;
  }
  deleteQuery(): void {}
  beginQuery(target: number, q: FakeQuery): void {
    expect(target).toBe(TIME_ELAPSED_EXT);
    expect(this.active).toBeNull();
    q.available = false;
    this.active = q;
    this.began.push(q.id);
  }
  endQuery(): void {
    this.active = null;
  }
  getQueryParameter(q: FakeQuery, p: number): unknown {
    return p === this.QUERY_RESULT_AVAILABLE ? q.available : q.result;
  }
  getParameter(p: number): unknown {
    if (p !== GPU_DISJOINT_EXT) return null;
    const d = this.disjoint;
    this.disjoint = false;
    return d;
  }
}

function frame(timer: GpuTimer): void {
  timer.begin();
  timer.end();
}

describe('GpuTimer', () => {
  test('reports the newest finished query, even when the ring has wrapped', () => {
    const gl = new TimerGl();
    const timer = new GpuTimer(gl as unknown as WebGL2RenderingContext);
    expect(timer.supported).toBe(true);
    // Four frames in flight (slots 0..3); the next frame's slot (0) is the oldest.
    for (let i = 0; i < 4; i++) frame(timer);
    expect(timer.ms).toBe(-1);
    gl.queries.forEach((q, i) => {
      q.available = true;
      q.result = (i + 1) * 1e6;
    });
    frame(timer);
    expect(timer.ms).toBe(4);
  });

  test('never reuses a pending query and discards disjoint results', () => {
    const gl = new TimerGl();
    const timer = new GpuTimer(gl as unknown as WebGL2RenderingContext);
    for (let i = 0; i < 6; i++) frame(timer);
    // Only four queries exist and none finished: frames 5 and 6 are not timed.
    expect(gl.began).toEqual([0, 1, 2, 3]);
    const q0 = gl.queries[0] as FakeQuery;
    q0.available = true;
    q0.result = 9e6;
    gl.disjoint = true;
    frame(timer);
    expect(timer.ms).toBe(-1);
    expect(gl.began.at(-1)).toBe(0);
  });

  test('−1 without the extension', () => {
    const gl = new TimerGl();
    gl.hasExt = false;
    const timer = new GpuTimer(gl as unknown as WebGL2RenderingContext);
    frame(timer);
    expect(timer.supported).toBe(false);
    expect(timer.ms).toBe(-1);
    expect(gl.began).toHaveLength(0);
  });
});

describe('DrawCounter', () => {
  test('counts every draw entry point and unwraps on destroy', () => {
    const calls: string[] = [];
    class Gl {
      drawElements(): void { calls.push('e'); }
      drawArrays(): void { calls.push('a'); }
      drawElementsInstanced(): void { calls.push('ei'); }
      drawArraysInstanced(): void { calls.push('ai'); }
      drawRangeElements(): void { calls.push('r'); }
    }
    const gl = new Gl() as unknown as WebGL2RenderingContext;
    const counter = new DrawCounter(gl);
    gl.drawElements(0, 3, 0, 0);
    gl.drawArrays(0, 0, 3);
    gl.drawElementsInstanced(0, 3, 0, 0, 2);
    gl.drawArraysInstanced(0, 0, 3, 2);
    gl.drawRangeElements(0, 0, 3, 3, 0, 0);
    expect(counter.count).toBe(5);
    expect(calls).toEqual(['e', 'a', 'ei', 'ai', 'r']);
    counter.reset();
    expect(counter.count).toBe(0);
    counter.destroy();
    gl.drawArrays(0, 0, 3);
    expect(counter.count).toBe(0);
    expect(calls).toHaveLength(6);
  });
});

describe('probeGpu', () => {
  test('prefers the unmasked renderer and classifies it', () => {
    const gl = {
      RENDERER: 1, VENDOR: 2, MAX_TEXTURE_SIZE: 3,
      getExtension: (n: string) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 10, UNMASKED_VENDOR_WEBGL: 11 } : null),
      getParameter: (p: number) => ({ 1: 'WebKit WebGL', 2: 'WebKit', 3: 8192, 10: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 11: 'Google Inc. (NVIDIA)' } as Record<number, unknown>)[p],
    };
    const info = probeGpu(gl as unknown as WebGL2RenderingContext);
    expect(info.renderer).toContain('RTX 3060');
    expect(info.tier).toBe('discrete');
    expect(info.maxTextureSize).toBe(8192);
    expect(info.timerQuery).toBe(false);
  });
});
