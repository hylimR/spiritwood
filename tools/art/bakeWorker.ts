/**
 * Client of the art dev plugin's worker thread (tools/art/dev-worker.ts): requests are matched to replies
 * by sequence number. Every call has a deadline: a worker that hangs is terminated and every pending call
 * rejected, so the dev server's queue moves on (the next call starts a fresh worker). `close()` settles
 * everything still pending.
 */
import type { AtlasMeasure } from './budget.ts';
import type { Clock, DevBakeRequest, DevBakeResult } from './dev.ts';
import type { WorkerCall, WorkerReply, WorkerRequest } from './dev-worker.ts';

/** The part of a node:worker_threads Worker this client uses (tests pass a fake). */
export interface WorkerLike {
  postMessage(msg: WorkerRequest): void;
  on(event: 'message', fn: (msg: WorkerReply) => void): unknown;
  on(event: 'error', fn: (e: Error) => void): unknown;
  on(event: 'exit', fn: (code: number) => void): unknown;
  terminate(): unknown;
}

/** A re-bake of the largest plate (16384² source, 256 chunks) takes about a minute; this is well past it. */
export const BAKE_CALL_TIMEOUT_MS = 180_000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: unknown;
}

export class BakeWorkerClient {
  private worker: WorkerLike | null = null;
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly spawn: () => WorkerLike;
  private readonly clock: Clock;
  private readonly timeoutMs: number;

  constructor(spawn: () => WorkerLike, clock: Clock, timeoutMs = BAKE_CALL_TIMEOUT_MS) {
    this.spawn = spawn;
    this.clock = clock;
    this.timeoutMs = timeoutMs;
  }

  private ensure(): WorkerLike {
    if (this.worker) return this.worker;
    const w = this.spawn();
    w.on('message', (msg: WorkerReply) => {
      const p = this.pending.get(msg.seq);
      if (!p) return;
      this.pending.delete(msg.seq);
      this.clock.clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    w.on('error', (e: Error) => {
      if (this.worker === w) this.fail(e);
    });
    w.on('exit', (code: number) => {
      if (this.worker === w) this.fail(new Error(`the bake worker exited (${code})`));
    });
    this.worker = w;
    return w;
  }

  /** Reject every pending call and drop the worker (the next call starts a new one). */
  private fail(e: Error): void {
    const w = this.worker;
    this.worker = null;
    for (const p of this.pending.values()) {
      this.clock.clearTimeout(p.timer);
      p.reject(e);
    }
    this.pending.clear();
    if (w) void w.terminate();
  }

  private call(msg: WorkerCall): Promise<unknown> {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = this.clock.setTimeout(() => {
        if (!this.pending.has(seq)) return;
        this.fail(new Error(`the bake worker did not answer within ${Math.round(this.timeoutMs / 1000)} s; restarting it`));
      }, this.timeoutMs);
      this.pending.set(seq, { resolve, reject, timer });
      try {
        this.ensure().postMessage({ ...msg, seq });
      } catch (e) {
        this.fail(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  bake(req: DevBakeRequest): Promise<DevBakeResult> {
    return this.call({ type: 'bake', req }) as Promise<DevBakeResult>;
  }

  atlases(base: string): Promise<AtlasMeasure[]> {
    return this.call({ type: 'atlases', base }) as Promise<AtlasMeasure[]>;
  }

  /** Calls waiting for a reply (tests, debug). */
  get waiting(): number {
    return this.pending.size;
  }

  close(): void {
    this.fail(new Error('the bake worker was closed'));
  }
}
