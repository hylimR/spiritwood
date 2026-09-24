/**
 * Vite dev plugin for painted plates (ARCHITECTURE.md §5.8), wired by main in vite.config.ts:
 *
 *   import { spiritwoodArt } from './tools/art/vite-plugin.ts';
 *   plugins: [ktxTranscoder(), spiritwoodArt()],
 *
 * `apply: 'serve'` (never in builds) and inert under Vitest. It watches art/plates/** through the dev
 * server's watcher, re-bakes changed plates in a worker thread (WebP only, changed chunks only), serves
 * the dev manifest and every plate file from its own middleware, and tells the page what to reload
 * (tools/art/dev.ts has the logic, src/assets/hotReload.ts the page side).
 */
import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Plugin, ViteDevServer } from 'vite';
import { BakeWorkerClient, type WorkerLike } from './bakeWorker.ts';
import type { AtlasMeasure } from './budget.ts';
import type { Clock } from './dev.ts';
import { artPaths } from './paths.ts';

function spawnWorker(): WorkerLike {
  const w = new Worker(new URL('./dev-worker.ts', import.meta.url));
  // An idle worker never keeps the dev server's process alive.
  w.unref();
  return w;
}

const realClock: Clock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function statSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

export interface ArtPluginOptions {
  /** Repository root (default: the Vite root). */
  root?: string;
}

/** The plugin; inert (applies to nothing) when `process.env.VITEST` is set. */
export function spiritwoodArt(options: ArtPluginOptions = {}): Plugin {
  if (process.env.VITEST) return { name: 'spiritwood-art', apply: () => false };
  return {
    name: 'spiritwood-art',
    apply: 'serve',
    async configureServer(server: ViteDevServer) {
      // Loaded here, not at config load: builds and Vitest never pay for sharp and the encoders.
      const { ArtDevServer } = await import('./dev.ts');
      const { levelSize } = await import('./bake.ts');
      const paths = artPaths(options.root ?? server.config.root);
      const worker = new BakeWorkerClient(spawnWorker, realClock);
      let atlases: Promise<AtlasMeasure[] | null> | null = null;
      const logger = server.config.logger;
      let level: { width: number; height: number } | null = null;
      try {
        level = levelSize(paths);
      } catch (e) {
        logger.warn(`[art] can't read the level (${e instanceof Error ? e.message : String(e)}); budget warnings are off`, { timestamp: true });
      }
      const dev = new ArtDevServer({
        paths,
        clock: realClock,
        stat: statSize,
        bake: (req) => worker.bake(req),
        atlases: () => (atlases ??= worker.atlases(paths.base).catch(() => null)),
        send: (payload) => server.ws.send(payload),
        log: {
          info: (m) => logger.info(m, { timestamp: true }),
          warn: (m) => logger.warn(m, { timestamp: true }),
          error: (m) => logger.error(m, { timestamp: true }),
        },
        level,
      });
      server.watcher.add([paths.plates, paths.base, paths.lock]);
      server.watcher.on('all', (event: string, file: string) => dev.onFileEvent(event, resolve(file)));
      server.middlewares.use((req, res, next) => {
        if (!dev.handle(req.url, res)) next();
      });
      dev.start().catch((e: unknown) => logger.error(`[art] ${e instanceof Error ? e.message : String(e)}`, { timestamp: true }));
      server.httpServer?.once('close', () => {
        dev.close();
        worker.close();
      });
    },
  };
}
