/**
 * Worker thread of the art dev plugin (tools/art/vite-plugin.ts): decoding, hashing and WebP encoding
 * of a repainted plate run here, off the dev-server thread, and so does measuring the atlases for the
 * budget warning.
 */
import { readFileSync } from 'node:fs';
import { parentPort } from 'node:worker_threads';
import { parseManifest } from '../../src/assets/manifest.ts';
import { measureAtlases } from './atlases.ts';
import { devBakePlate, type DevBakeRequest } from './dev.ts';

export type WorkerCall = { type: 'bake'; req: DevBakeRequest } | { type: 'atlases'; base: string };
export type WorkerRequest = WorkerCall & { seq: number };
export type WorkerReply = { seq: number; ok: true; result: unknown } | { seq: number; ok: false; error: string };

const port = parentPort;
port?.on('message', (msg: WorkerRequest) => {
  void (async () => {
    try {
      if (msg.type === 'bake') {
        const result = await devBakePlate(msg.req);
        const transfer = Object.values(result.webp).map((b) => b.buffer as ArrayBuffer);
        port.postMessage({ seq: msg.seq, ok: true, result } satisfies WorkerReply, transfer);
      } else {
        const base = parseManifest(JSON.parse(readFileSync(msg.base, 'utf8')));
        port.postMessage({ seq: msg.seq, ok: true, result: measureAtlases(base) } satisfies WorkerReply);
      }
    } catch (e) {
      port.postMessage({ seq: msg.seq, ok: false, error: e instanceof Error ? e.stack ?? e.message : String(e) } satisfies WorkerReply);
    }
  })();
});
