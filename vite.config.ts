import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vitest/config';
import { spiritwoodArt } from './tools/art/vite-plugin.ts';

/** Self-host PixiJS's KTX2 (libktx) transcoder at transcoders/ktx/ for dev and build. */
function ktxTranscoder(): Plugin {
  const dir = fileURLToPath(new URL('./node_modules/pixi.js/transcoders/ktx', import.meta.url));
  const files = ['libktx.js', 'libktx.wasm'];
  return {
    name: 'spiritwood-ktx-transcoder',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = files.find((f) => req.url?.endsWith(`/transcoders/ktx/${f}`));
        if (!name) return next();
        res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(resolve(dir, name)));
      });
    },
    generateBundle() {
      for (const f of files) {
        this.emitFile({ type: 'asset', fileName: `transcoders/ktx/${f}`, source: readFileSync(resolve(dir, f)) });
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [ktxTranscoder(), spiritwoodArt()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    pool: 'threads',
    maxWorkers: 2,
  },
});
