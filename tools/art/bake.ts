/**
 * `npm run art` (ARCHITECTURE.md §5.8): validate every `art/plates/<id>.png` + `<id>.json`, cut each into
 * bordered 1024² chunks, encode WebP + PNG + KTX2 for chunks whose pixels changed, splice the plates
 * into the hand-edited base manifest, enforce the texture budgets, and write
 * `public/layers/forest.manifest.json` plus the bake record `art/bake.lock.json`.
 *
 * Nothing is written unless everything validates and fits the budgets. `check` recomputes the source
 * hashes, the chunk hashes and rects (decoding, never encoding), the file hashes and the splice, and
 * reports anything stale.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { MAX_ASPECT, MIN_ASPECT, MIN_CAMERA_ZOOM, VIEW_H } from '../../src/config.ts';
import type { LayerManifest, PlateChunkDef, PlateLayerDef } from '../../src/contracts/assets.ts';
import { parseManifest } from '../../src/assets/manifest.ts';
import { hash8, PLATE_TEXTURE, plateChunkRect } from '../../src/assets/plateLayout.ts';
import { spliceManifest, type PlateInsert } from '../../src/assets/splice.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { layerExtent } from '../../src/render/util/camera.ts';
import { measureAtlases } from './atlases.ts';
import { budgetLayer, defaultSweep, formatBudgetReport, sweepBudget, type AtlasMeasure, type BudgetReport } from './budget.ts';
import { chunkSource, type ChunkResult } from './chunks.ts';
import { CHUNK_FORMATS, ENCODERS, type ChunkFormat, type Encoders } from './encode.ts';
import { formatJson } from './json.ts';
import { chunkFile, parseChunkFile, type ArtPaths } from './paths.ts';
import { canonicalSidecar, parseSidecar, plateLayerDef, PLATE_ID_RE, SidecarError, type Sidecar } from './sidecar.ts';
import { inspectPng, pngSource, SourceError } from './source.ts';
import { PLATE_ID as DEMO_PLATE_ID } from '../plates/plan.ts';

/** Bumped when chunking, hulls or encoder settings change: every plate is then re-measured and re-encoded. */
export const ART_TOOL_VERSION = 'spiritwood-art/2';

export interface LockChunk {
  col: number;
  row: number;
  hash: string;
  core: number[];
  soft: number[];
  /** Content hashes of the encoded files. */
  files: Partial<Record<ChunkFormat, string>>;
}

export interface LockPlate {
  sourceHash: string;
  width: number;
  height: number;
  chunks: LockChunk[];
}

export interface ArtLock {
  version: 1;
  tool: string;
  plates: Record<string, LockPlate>;
}

export class ArtError extends Error {
  override name = 'ArtError';
}

export interface PlateSource {
  id: string;
  png: string;
  json: string;
  sidecar: Sidecar;
  sourceHash: string;
  width: number;
  height: number;
}

export function fileHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

export function sourceHash(png: Uint8Array, sidecar: Sidecar): string {
  return createHash('sha256').update(png).update('\0').update(canonicalSidecar(sidecar)).update('\0').update(ART_TOOL_VERSION).digest('hex').slice(0, 32);
}

export function readLock(path: string): ArtLock {
  if (!existsSync(path)) return { version: 1, tool: ART_TOOL_VERSION, plates: {} };
  const lock = JSON.parse(readFileSync(path, 'utf8')) as ArtLock;
  if (lock.version !== 1 || typeof lock.plates !== 'object') throw new ArtError(`${path}: unrecognised bake lock; delete it and run npm run art`);
  return lock;
}

/** A readable path for messages (relative to the repo root). */
function rel(paths: ArtPaths, p: string): string {
  return relative(paths.root, p) || p;
}

/** Layer ids of a manifest file, or none when it is missing or unreadable (the caller reports that). */
function manifestIds(file: string, plates: boolean): string[] {
  if (!existsSync(file)) return [];
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as { layers?: unknown };
    if (!Array.isArray(json.layers)) return [];
    const out: string[] = [];
    for (const l of json.layers as unknown[]) {
      if (typeof l !== 'object' || l === null) continue;
      const { id, kind } = l as { id?: unknown; kind?: unknown };
      if (typeof id === 'string' && (!plates || kind === 'plate')) out.push(id);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Ids an art plate can't take, with who holds them: every layer of the base manifest, and the plates
 * `npm run plates` writes into the same chunk folder (their files are named after their ids).
 */
export function reservedPlateIds(paths: ArtPaths): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of manifestIds(paths.base, false)) out.set(id, `a layer of ${rel(paths, paths.base)}`);
  out.set(DEMO_PLATE_ID, 'the demo plate of npm run plates');
  for (const id of manifestIds(paths.demo, true)) if (!out.has(id)) out.set(id, `a plate of ${rel(paths, paths.demo)}`);
  return out;
}

/**
 * Pair up `art/plates/<id>.png` and `<id>.json`, validate ids, sidecars and PNG headers. Every problem is
 * collected, so an artist sees them all at once.
 */
export async function scanPlates(paths: ArtPaths, reserved: ReadonlyMap<string, string> = reservedPlateIds(paths)): Promise<{ plates: PlateSource[]; errors: string[] }> {
  const errors: string[] = [];
  const plates: PlateSource[] = [];
  if (!existsSync(paths.plates)) return { plates, errors };
  const names = readdirSync(paths.plates).filter((n) => !n.startsWith('.')).sort();
  const pngs = new Set(names.filter((n) => n.toLowerCase().endsWith('.png')).map((n) => n.slice(0, -4)));
  const jsons = new Set(names.filter((n) => n.toLowerCase().endsWith('.json')).map((n) => n.slice(0, -5)));
  for (const n of names) {
    const lower = n.toLowerCase();
    if (!lower.endsWith('.png') && !lower.endsWith('.json') && !lower.endsWith('.md') && !lower.endsWith('.txt')) {
      errors.push(`${rel(paths, join(paths.plates, n))}: unexpected file; art/plates/ holds <id>.png + <id>.json pairs`);
    }
    if ((lower.endsWith('.png') && !n.endsWith('.png')) || (lower.endsWith('.json') && !n.endsWith('.json'))) {
      errors.push(`${rel(paths, join(paths.plates, n))}: use a lower-case extension (.png / .json)`);
    }
  }
  for (const id of [...new Set([...pngs, ...jsons])].sort()) {
    const png = join(paths.plates, `${id}.png`);
    const json = join(paths.plates, `${id}.json`);
    if (!pngs.has(id)) {
      errors.push(`${rel(paths, json)}: no image ${id}.png next to it`);
      continue;
    }
    if (!jsons.has(id)) {
      errors.push(`${rel(paths, png)}: no sidecar ${id}.json next to it (copy one from art/templates/<area>/ or another plate)`);
      continue;
    }
    if (!PLATE_ID_RE.test(id)) {
      errors.push(`${rel(paths, png)}: "${id}" is not a valid plate id (letters, digits, - and _, starting with a letter or digit, ≤ 64 characters)`);
      continue;
    }
    const owner = reserved.get(id);
    if (owner) {
      errors.push(`${rel(paths, png)}: the id "${id}" is taken by ${owner} (chunk files are named after it); rename the plate`);
      continue;
    }
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(json, 'utf8'));
      } catch (e) {
        throw new SidecarError(`${rel(paths, json)}: not valid JSON (${e instanceof Error ? e.message : String(e)})`);
      }
      const sidecar = parseSidecar(raw, rel(paths, json));
      const info = await inspectPng(png, rel(paths, png));
      plates.push({ id, png, json, sidecar, sourceHash: sourceHash(readFileSync(png), sidecar), width: info.width, height: info.height });
    } catch (e) {
      if (e instanceof SidecarError || e instanceof SourceError) errors.push(e.message);
      else throw e;
    }
  }
  return { plates, errors };
}

/** A lock chunk without its file hashes: what decoding the source reproduces. */
function pixelsOnly(c: LockChunk): Omit<LockChunk, 'files'> {
  return { col: c.col, row: c.row, hash: c.hash, core: c.core, soft: c.soft };
}

/** Chunk hashes and rects of a plate (decodes the image in strips; pixels are dropped). */
export async function measurePlate(src: PlateSource): Promise<LockChunk[]> {
  const out: LockChunk[] = [];
  for await (const c of chunkSource(pngSource(src.png, src))) out.push({ col: c.col, row: c.row, hash: c.hash, core: c.core, soft: c.soft, files: {} });
  return out;
}

/** The plate layer a baked plate contributes to the manifest. */
export function bakedPlateLayer(id: string, sidecar: Sidecar, chunks: readonly LockChunk[]): PlateLayerDef {
  const def = plateLayerDef(id, sidecar);
  def.chunks = chunks.map((c): PlateChunkDef => {
    const v = `?v=${hash8(c.hash)}`;
    return {
      col: c.col,
      row: c.row,
      source: { ktx2: `${chunkFile(id, c.col, c.row, 'ktx2')}${v}`, webp: `${chunkFile(id, c.col, c.row, 'webp')}${v}`, png: `${chunkFile(id, c.col, c.row, 'png')}${v}` },
      core: [...c.core],
      soft: [...c.soft],
      hash: c.hash,
    };
  });
  return def;
}

/** Union of the layer extents at the narrowest and widest aspect: where a layer can ever be seen. */
function coverage(levelW: number, levelH: number, fx: number, fy: number): { x0: number; y0: number; x1: number; y1: number } {
  const a = layerExtent(levelW, levelH, VIEW_H * MIN_ASPECT, VIEW_H, fx, fy, MIN_CAMERA_ZOOM);
  const b = layerExtent(levelW, levelH, VIEW_H * MAX_ASPECT, VIEW_H, fx, fy, MIN_CAMERA_ZOOM);
  return { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
}

export interface ArtOptions {
  /** Recompute and compare instead of baking; never encodes or writes. */
  check?: boolean;
  log?: (line: string) => void;
  encoders?: Encoders;
  /** Registered atlases (measured with measureAtlases when omitted). */
  atlases?: AtlasMeasure[];
  /** Level size (read from paths.ldtk when omitted). */
  level?: { width: number; height: number };
}

export interface ArtResult {
  /** The generated manifest text (written unless checking). */
  manifestText: string;
  manifest: LayerManifest;
  lock: ArtLock;
  report: BudgetReport;
  /** Staleness found by a check (empty = up to date). */
  problems: string[];
  warnings: string[];
  encoded: number;
  reused: number;
  ms: number;
}

export function levelSize(paths: ArtPaths): { width: number; height: number } {
  const level = parseLdtk(JSON.parse(readFileSync(paths.ldtk, 'utf8')));
  return { width: level.pxWidth, height: level.pxHeight };
}

function readBase(paths: ArtPaths): LayerManifest {
  if (!existsSync(paths.base)) throw new ArtError(`${rel(paths, paths.base)} is missing: it is the hand-edited base manifest the bake splices plates into`);
  try {
    return parseManifest(JSON.parse(readFileSync(paths.base, 'utf8')));
  } catch (e) {
    throw new ArtError(`${rel(paths, paths.base)}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Bake (or check) every plate. Throws ArtError with every validation or budget problem. */
export async function runArt(paths: ArtPaths, options: ArtOptions = {}): Promise<ArtResult> {
  const t0 = performance.now();
  const log = options.log ?? ((): void => undefined);
  const check = options.check === true;
  const encoders = options.encoders ?? ENCODERS;
  const base = readBase(paths);
  const lock = readLock(paths.lock);
  const { plates, errors } = await scanPlates(paths);
  if (errors.length) throw new ArtError(`art/plates has ${errors.length} problem${errors.length === 1 ? '' : 's'}:\n  ${errors.join('\n  ')}`);
  const level = options.level ?? levelSize(paths);
  const problems: string[] = [];
  const warnings: string[] = [];

  // Phase 1: chunk data for every plate (from the lock when the source is unchanged).
  const chunkData = new Map<string, LockChunk[]>();
  for (const p of plates) {
    const locked = lock.plates[p.id];
    const fresh = locked && locked.sourceHash === p.sourceHash && lock.tool === ART_TOOL_VERSION;
    if (fresh && !check) {
      chunkData.set(p.id, locked.chunks.map((c) => ({ ...c, files: { ...c.files } })));
      continue;
    }
    const t = performance.now();
    const measured = await measurePlate(p);
    log(`${p.id}: ${p.width}×${p.height} → ${measured.length} chunk${measured.length === 1 ? '' : 's'} (decoded and hashed in ${(performance.now() - t).toFixed(0)} ms)`);
    if (measured.length === 0) warnings.push(`${p.id}: the image is fully transparent; the plate draws nothing`);
    if (check) {
      if (!locked) problems.push(`${p.id}: not baked yet`);
      else if (!fresh) problems.push(`${p.id}: ${lock.tool !== ART_TOOL_VERSION ? `baked by ${lock.tool}, the tool is now ${ART_TOOL_VERSION}` : 'the image or sidecar changed since the last bake'}`);
      else if (JSON.stringify(measured.map(pixelsOnly)) !== JSON.stringify(locked.chunks.map(pixelsOnly))) {
        problems.push(`${p.id}: recomputed chunk hashes or rects differ from art/bake.lock.json`);
      }
      // Compare files against the recorded hashes (below) with the recorded entries.
      chunkData.set(p.id, locked ? locked.chunks : measured);
    } else {
      chunkData.set(p.id, measured);
    }
  }

  // Splice and validate.
  const inserts: PlateInsert[] = plates.map((p) => ({ layer: bakedPlateLayer(p.id, p.sidecar, chunkData.get(p.id) ?? []), replaces: p.sidecar.replaces }));
  let manifest: LayerManifest;
  try {
    manifest = spliceManifest(base, inserts);
    parseManifest(JSON.parse(JSON.stringify(manifest)));
  } catch (e) {
    throw new ArtError(`splicing the plates into ${rel(paths, paths.base)} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const p of plates) {
    const cov = coverage(level.width, level.height, p.sidecar.parallax[0], p.sidecar.parallax[1]);
    const x1 = p.sidecar.origin[0] + p.width * p.sidecar.texelScale;
    const y1 = p.sidecar.origin[1] + p.height * p.sidecar.texelScale;
    if (x1 <= cov.x0 || p.sidecar.origin[0] >= cov.x1 || y1 <= cov.y0 || p.sidecar.origin[1] >= cov.y1) {
      warnings.push(`${p.id}: lies outside what the camera can see at parallax ${p.sidecar.parallax.join('/')} (layer x ${cov.x0.toFixed(0)}…${cov.x1.toFixed(0)}, y ${cov.y0.toFixed(0)}…${cov.y1.toFixed(0)}); check "origin"`);
    }
  }

  // Budgets.
  const atlases = options.atlases ?? measureAtlases(base);
  const areaOf = new Map(plates.map((p) => [p.id, p.sidecar.area]));
  const layers = manifest.layers.filter((l): l is PlateLayerDef => l.kind === 'plate').map((l) => budgetLayer(l, areaOf.get(l.id) ?? null));
  const report = sweepBudget(layers, base.textureBudgetMB, atlases, defaultSweep(level.width, level.height));
  warnings.push(...report.warnings);
  if (report.errors.length) {
    throw new ArtError(`the plates do not fit the texture budget (nothing was written):\n${formatBudgetReport(report)}`);
  }

  const manifestText = formatJson(manifest);
  let encoded = 0;
  let reused = 0;
  const nextLock: ArtLock = { version: 1, tool: ART_TOOL_VERSION, plates: {} };

  if (check) {
    for (const p of plates) {
      const locked = lock.plates[p.id];
      if (!locked) continue;
      nextLock.plates[p.id] = locked;
      for (const c of locked.chunks) {
        for (const f of CHUNK_FORMATS) {
          const file = join(paths.layers, chunkFile(p.id, c.col, c.row, f));
          if (!existsSync(file)) problems.push(`${rel(paths, file)} is missing`);
          else if (fileHash(readFileSync(file)) !== c.files[f]) problems.push(`${rel(paths, file)} does not match the bake record (edited, or left over from an interrupted bake)`);
        }
      }
    }
    for (const id of Object.keys(lock.plates)) if (!plates.some((p) => p.id === id)) problems.push(`${id}: in art/bake.lock.json, but art/plates/${id}.png is gone`);
    const committed = existsSync(paths.generated) ? readFileSync(paths.generated, 'utf8') : '';
    if (committed !== manifestText) problems.push(`${rel(paths, paths.generated)} is not the splice of ${rel(paths, paths.base)} and the plates`);
    return { manifestText, manifest, lock: nextLock, report, problems, warnings, encoded, reused, ms: performance.now() - t0 };
  }

  // Phase 2: encode chunks whose pixels (or files) changed, one decode pass per plate that needs it.
  mkdirSync(paths.chunks, { recursive: true });
  // Files baked by another tool version are never reused (its chunking or encoder settings differ).
  const reusable = lock.tool === ART_TOOL_VERSION;
  for (const p of plates) {
    const chunks = chunkData.get(p.id) ?? [];
    const old = reusable ? lock.plates[p.id] : undefined;
    const need = new Set<string>();
    for (const c of chunks) {
      const prev = old?.chunks.find((o) => o.col === c.col && o.row === c.row && o.hash === c.hash);
      const ok = prev !== undefined && CHUNK_FORMATS.every((f) => {
        const file = join(paths.layers, chunkFile(p.id, c.col, c.row, f));
        return existsSync(file) && fileHash(readFileSync(file)) === prev.files[f];
      });
      if (ok && prev) {
        c.files = { ...prev.files };
        reused++;
      } else {
        need.add(`${c.col},${c.row}`);
      }
    }
    if (need.size > 0) {
      for await (const c of chunkSource(pngSource(p.png, p))) {
        if (!need.has(`${c.col},${c.row}`)) continue;
        const entry = chunks.find((x) => x.col === c.col && x.row === c.row) as LockChunk;
        entry.files = await encodeChunk(paths, p.id, c, encoders, log);
        encoded++;
      }
    }
    nextLock.plates[p.id] = { sourceHash: p.sourceHash, width: p.width, height: p.height, chunks };
  }
  removeStaleFiles(paths, lock, nextLock, reservedPlateIds(paths), log);
  mkdirSync(dirname(paths.lock), { recursive: true });
  writeFileSync(paths.lock, formatJson(nextLock));
  writeFileSync(paths.generated, manifestText);
  return { manifestText, manifest, lock: nextLock, report, problems, warnings, encoded, reused, ms: performance.now() - t0 };
}

async function encodeChunk(paths: ArtPaths, id: string, c: ChunkResult, encoders: Encoders, log: (s: string) => void): Promise<Partial<Record<ChunkFormat, string>>> {
  const files: Partial<Record<ChunkFormat, string>> = {};
  const sizes: string[] = [];
  const t = performance.now();
  for (const f of CHUNK_FORMATS) {
    const bytes = await encoders[f](c.rgba, PLATE_TEXTURE, PLATE_TEXTURE);
    writeFileSync(join(paths.layers, chunkFile(id, c.col, c.row, f)), bytes);
    files[f] = fileHash(bytes);
    sizes.push(`${f} ${(bytes.length / 1024).toFixed(0)} KB`);
  }
  log(`  ${id} chunk ${c.col},${c.row}: ${sizes.join(', ')}, ${c.core.length / 4} core + ${c.soft.length / 4} soft rects, encoded in ${((performance.now() - t) / 1000).toFixed(1)} s`);
  return files;
}

/**
 * Delete chunk files of art plates that are gone or no longer have that chunk. Only ids the art lock
 * records are touched, and never an id another source owns (the demo plate's files share the folder).
 */
function removeStaleFiles(paths: ArtPaths, oldLock: ArtLock, next: ArtLock, reserved: ReadonlyMap<string, string>, log: (s: string) => void): void {
  if (!existsSync(paths.chunks)) return;
  const managed = new Set([...Object.keys(oldLock.plates), ...Object.keys(next.plates)].filter((id) => !reserved.has(id)));
  for (const name of readdirSync(paths.chunks)) {
    const f = parseChunkFile(name);
    if (!f || !managed.has(f.id)) continue;
    const keep = next.plates[f.id]?.chunks.some((c) => c.col === f.col && c.row === f.row);
    if (keep) continue;
    rmSync(join(paths.chunks, name));
    log(`  removed stale ${rel(paths, join(paths.chunks, name))}`);
  }
}

/** Chunk rect helper for reports: layer-space extent of a plate's chunks. */
export function plateBounds(def: PlateLayerDef): { x0: number; y0: number; x1: number; y1: number } | null {
  if (def.chunks.length === 0) return null;
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const c of def.chunks) {
    const r = plateChunkRect(def, c.col, c.row);
    b.x0 = Math.min(b.x0, r.x0);
    b.y0 = Math.min(b.y0, r.y0);
    b.x1 = Math.max(b.x1, r.x1);
    b.y1 = Math.max(b.y1, r.y1);
  }
  return b;
}
