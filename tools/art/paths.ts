import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Where the painted-layer pipeline reads and writes (ARCHITECTURE.md §5.8). */
export interface ArtPaths {
  root: string;
  /** Artist sources: `<id>.png` + `<id>.json`. */
  plates: string;
  /** Paint-over templates (`npm run art:export`). */
  templates: string;
  /** Bake record: source hashes, chunk hashes and file hashes (lets `--check` run without encoding). */
  lock: string;
  /** public/layers/ (manifest paths are relative to it). */
  layers: string;
  /** Hand-edited base manifest. */
  base: string;
  /** Generated manifest: the base plus the plate layers. */
  generated: string;
  /** The demo plate's manifest (`npm run plates`); its chunk files share public/layers/plates/. */
  demo: string;
  /** Chunk files (public/layers/plates/). */
  chunks: string;
  /** The LDtk level: plate extents, templates and the budget sweep read its size from here. */
  ldtk: string;
}

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function artPaths(root: string = REPO_ROOT): ArtPaths {
  return {
    root,
    plates: join(root, 'art/plates'),
    templates: join(root, 'art/templates'),
    lock: join(root, 'art/bake.lock.json'),
    layers: join(root, 'public/layers'),
    base: join(root, 'public/layers/forest.base.manifest.json'),
    generated: join(root, 'public/layers/forest.manifest.json'),
    demo: join(root, 'public/layers/forest.plates.manifest.json'),
    chunks: join(root, 'public/layers/plates'),
    ldtk: join(root, 'public/levels/forest.ldtk'),
  };
}

/** Manifest-relative path of a chunk file (the manifest lives in public/layers/). */
export function chunkFile(id: string, col: number, row: number, ext: 'ktx2' | 'webp' | 'png'): string {
  return `plates/${id}_${col}_${row}.${ext}`;
}

/** Parse `<id>_<col>_<row>.<ext>` (a chunk file name), or null. */
export function parseChunkFile(name: string): { id: string; col: number; row: number; ext: string } | null {
  const m = /^(.+)_(\d+)_(\d+)\.(ktx2|webp|png)$/.exec(name);
  if (!m) return null;
  return { id: m[1] as string, col: Number(m[2]), row: Number(m[3]), ext: m[4] as string };
}
