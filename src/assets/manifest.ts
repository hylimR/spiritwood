import { MAX_LAYER_PARALLAX, MIN_LAYER_PARALLAX_GAP } from '../config.ts';
import type {
  AtlasDef, FogLayerDef, KitLayerDef, LayerDef, LayerManifest, PlateChunkDef, PlateLayerDef, SkyLayerDef, TextureSourceDef,
} from '../contracts/assets.ts';
import type { QualityLevel } from '../contracts/quality.ts';
import { RECIPE_IDS } from '../render/layers/recipes.ts';
import { pathnameOf } from './plateLayout.ts';

export class ManifestError extends Error {
  override name = 'ManifestError';
}

const QUALITY_LEVELS: readonly QualityLevel[] = ['high', 'medium', 'low'];
const LAYER_KINDS = ['sky', 'fog', 'kit', 'plate'] as const;
/** Kit/plate chunks narrower than this would exceed the per-layer draw budget (§6). */
const MIN_CHUNK_WIDTH = 2048;
const MAX_PARALLAX = 4;

type Obj = Record<string, unknown>;

function fail(path: string, msg: string): never {
  throw new ManifestError(`${path}: ${msg}`);
}

function obj(v: unknown, path: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'expected an object');
  return v as Obj;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected an array');
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(path, 'expected a non-empty string');
  return v;
}

function num(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'expected a finite number');
  if (v < min || v > max) fail(path, `expected a number in [${min}, ${max}], got ${v}`);
  return v;
}

function int(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  const n = num(v, path, min, max);
  if (!Number.isInteger(n)) fail(path, `expected an integer, got ${n}`);
  return n;
}

function colour(v: unknown, path: string): string {
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) fail(path, 'expected a colour "#rrggbb"');
  return v;
}

function pair(v: unknown, path: string, min: number, max: number): [number, number] {
  const a = arr(v, path);
  if (a.length !== 2) fail(path, 'expected [number, number]');
  return [num(a[0], `${path}[0]`, min, max), num(a[1], `${path}[1]`, min, max)];
}

function source(v: unknown, path: string, allowProcedural: boolean): TextureSourceDef {
  const o = obj(v, path);
  const out: TextureSourceDef = {};
  for (const key of ['ktx2', 'webp', 'png'] as const) {
    if (o[key] === undefined) continue;
    const p = str(o[key], `${path}.${key}`);
    // Texture URLs may carry a cache-buster (`?v=<hash8>`): the extension is the pathname's.
    if (!pathnameOf(p).toLowerCase().endsWith(`.${key}`)) fail(`${path}.${key}`, `expected a .${key} file, got "${p}"`);
    out[key] = p;
  }
  if (o.procedural !== undefined) {
    if (!allowProcedural) fail(`${path}.procedural`, 'procedural sources are not allowed here');
    out.procedural = str(o.procedural, `${path}.procedural`);
  }
  if (!out.ktx2 && !out.webp && !out.png && !out.procedural) fail(path, 'needs at least one of ktx2, webp, png or procedural');
  return out;
}

function polygon(v: unknown, path: string, w: number, h: number): number[] {
  const a = arr(v, path);
  if (a.length < 6 || a.length % 2 !== 0) fail(path, 'expected at least 3 points as flat x,y pairs');
  return a.map((p, i) => num(p, `${path}[${i}]`, 0, i % 2 === 0 ? w : h));
}

/** Split-hull rects [x, y, w, h, …] in chunk (content) texels: integers, non-empty, inside the chunk. */
function rects(v: unknown, path: string, cw: number, ch: number): number[] {
  const a = arr(v, path);
  if (a.length % 4 !== 0) fail(path, 'expected rects as flat [x, y, w, h, …]');
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 4) {
    const x = int(a[i], `${path}[${i}]`, 0, cw - 1);
    const y = int(a[i + 1], `${path}[${i + 1}]`, 0, ch - 1);
    const w = int(a[i + 2], `${path}[${i + 2}]`, 1, cw - x);
    const h = int(a[i + 3], `${path}[${i + 3}]`, 1, ch - y);
    out.push(x, y, w, h);
  }
  return out;
}

interface BaseFields {
  id: string;
  parallax: [number, number];
  minQuality: QualityLevel;
  tint: string;
  fog: number;
  fogColor: string;
  desaturate: number;
}

function base(o: Obj, path: string): BaseFields {
  const minQuality = o.minQuality;
  if (typeof minQuality !== 'string' || !QUALITY_LEVELS.includes(minQuality as QualityLevel)) {
    fail(`${path}.minQuality`, `expected one of ${QUALITY_LEVELS.join(', ')}`);
  }
  return {
    id: str(o.id, `${path}.id`),
    parallax: pair(o.parallax, `${path}.parallax`, 0, MAX_PARALLAX),
    minQuality: minQuality as QualityLevel,
    tint: colour(o.tint, `${path}.tint`),
    fog: num(o.fog, `${path}.fog`, 0, 1),
    fogColor: colour(o.fogColor, `${path}.fogColor`),
    desaturate: num(o.desaturate, `${path}.desaturate`, 0, 1),
  };
}

function sky(o: Obj, path: string): SkyLayerDef {
  const b = base(o, path);
  const stops = arr(o.gradient, `${path}.gradient`);
  if (stops.length < 2) fail(`${path}.gradient`, 'expected at least 2 stops');
  let prev = -Infinity;
  const gradient = stops.map((s, i): [number, string] => {
    const sp = `${path}.gradient[${i}]`;
    const a = arr(s, sp);
    if (a.length !== 2) fail(sp, 'expected [t, "#rrggbb"]');
    const t = num(a[0], `${sp}[0]`, 0, 1);
    if (t < prev) fail(`${sp}[0]`, 'stops must be in ascending order');
    prev = t;
    return [t, colour(a[1], `${sp}[1]`)];
  });
  const m = obj(o.moon, `${path}.moon`);
  return {
    ...b,
    kind: 'sky',
    gradient,
    moon: {
      x: num(m.x, `${path}.moon.x`, 0, 1),
      y: num(m.y, `${path}.moon.y`, 0, 1),
      radius: num(m.radius, `${path}.moon.radius`, 1, 1000),
      color: colour(m.color, `${path}.moon.color`),
      halo: num(m.halo, `${path}.moon.halo`, 0, 4),
    },
    starDensity: num(o.starDensity, `${path}.starDensity`, 0, 1),
  };
}

function fog(o: Obj, path: string): FogLayerDef {
  return {
    ...base(o, path),
    kind: 'fog',
    y: num(o.y, `${path}.y`),
    height: num(o.height, `${path}.height`, 1, 10000),
    density: num(o.density, `${path}.density`, 0, 1),
    speed: num(o.speed, `${path}.speed`, -1000, 1000),
  };
}

function kit(o: Obj, path: string, atlasIds: ReadonlySet<string>): KitLayerDef {
  const atlas = str(o.atlas, `${path}.atlas`);
  if (!atlasIds.has(atlas)) fail(`${path}.atlas`, `unknown atlas "${atlas}"`);
  const recipe = str(o.recipe, `${path}.recipe`);
  if (!RECIPE_IDS.includes(recipe)) fail(`${path}.recipe`, `unknown recipe "${recipe}" (known: ${RECIPE_IDS.join(', ')})`);
  const scale = pair(o.scale, `${path}.scale`, 0.01, 100);
  if (scale[0] > scale[1]) fail(`${path}.scale`, 'min must not exceed max');
  return {
    ...base(o, path),
    kind: 'kit',
    atlas,
    recipe,
    seed: int(o.seed, `${path}.seed`, 0, 0xffffffff),
    density: num(o.density, `${path}.density`, 0.001, 1000),
    scale,
    baseline: num(o.baseline, `${path}.baseline`, 0, 1),
    rim: num(o.rim, `${path}.rim`, 0, 1),
    glow: num(o.glow, `${path}.glow`, 0, 1),
    sway: num(o.sway, `${path}.sway`, 0, 1),
    chunkWidth: num(o.chunkWidth, `${path}.chunkWidth`, MIN_CHUNK_WIDTH, 1e6),
  };
}

function plate(o: Obj, path: string): PlateLayerDef {
  const chunkSize = pair(o.chunkSize, `${path}.chunkSize`, 1, 16384);
  const [cw, ch] = chunkSize;
  if (!Number.isInteger(cw) || !Number.isInteger(ch)) fail(`${path}.chunkSize`, 'expected integer texel sizes');
  const seen = new Set<string>();
  const chunks = arr(o.chunks, `${path}.chunks`).map((c, i): PlateChunkDef => {
    const cp = `${path}.chunks[${i}]`;
    const co = obj(c, cp);
    const col = int(co.col, `${cp}.col`, 0, 4096);
    const row = int(co.row, `${cp}.row`, 0, 4096);
    const key = `${col},${row}`;
    if (seen.has(key)) fail(cp, `duplicate chunk at col ${col}, row ${row}`);
    seen.add(key);
    const out: PlateChunkDef = { col, row, source: source(co.source, `${cp}.source`, false) };
    if (co.hull !== undefined) out.hull = polygon(co.hull, `${cp}.hull`, cw, ch);
    if (co.opaqueHull !== undefined) out.opaqueHull = polygon(co.opaqueHull, `${cp}.opaqueHull`, cw, ch);
    if (co.core !== undefined) out.core = rects(co.core, `${cp}.core`, cw, ch);
    if (co.soft !== undefined) out.soft = rects(co.soft, `${cp}.soft`, cw, ch);
    if (co.hash !== undefined) {
      const hash = str(co.hash, `${cp}.hash`);
      if (!/^[0-9a-f]{8,64}$/.test(hash)) fail(`${cp}.hash`, `expected 8–64 lowercase hex digits, got "${hash}"`);
      out.hash = hash;
    }
    return out;
  });
  if (chunks.length === 0) fail(`${path}.chunks`, 'expected at least one chunk');
  return {
    ...base(o, path),
    kind: 'plate',
    origin: pair(o.origin, `${path}.origin`, -1e7, 1e7),
    chunkSize,
    texelScale: num(o.texelScale, `${path}.texelScale`, 0.01, 100),
    chunks,
  };
}

/**
 * Validate an unknown JSON value against the LayerManifest schema (src/contracts/assets.ts) and
 * return it typed. Throws ManifestError naming the offending path (e.g. `layers[3].parallax`).
 * Checks: version, unique ids, known kinds and recipes, atlas references exist, parallax ranges,
 * colours, layers ordered far→near by parallax (foreground > 1 last), depth-tested layers within
 * MAX_LAYER_PARALLAX and at least MIN_LAYER_PARALLAX_GAP apart, plate chunk grid sanity (split-hull
 * rects inside the chunk, hex chunk hashes, texture paths checked by pathname so `?v=` is allowed) and,
 * in generated manifests, the `replaced` map (`LayerManifest.replaced`).
 */
export function parseManifest(json: unknown): LayerManifest {
  const root = obj(json, 'manifest');
  if (root.version !== 1) fail('version', `expected 1, got ${JSON.stringify(root.version)}`);
  const area = str(root.area, 'area');
  const budget = obj(root.textureBudgetMB, 'textureBudgetMB');
  const textureBudgetMB = {} as Record<QualityLevel, number>;
  for (const q of QUALITY_LEVELS) textureBudgetMB[q] = num(budget[q], `textureBudgetMB.${q}`, 1, 4096);

  const atlasIds = new Set<string>();
  const atlases = arr(root.atlases, 'atlases').map((a, i): AtlasDef => {
    const p = `atlases[${i}]`;
    const o = obj(a, p);
    const id = str(o.id, `${p}.id`);
    if (atlasIds.has(id)) fail(`${p}.id`, `duplicate atlas id "${id}"`);
    atlasIds.add(id);
    return {
      id,
      source: source(o.source, `${p}.source`, true),
      width: int(o.width, `${p}.width`, 1, 16384),
      height: int(o.height, `${p}.height`, 1, 16384),
    };
  });

  const ids = new Set<string>();
  let skyCount = 0;
  let prevFx = -Infinity;
  let prevDepthFx = -Infinity;
  const layers = arr(root.layers, 'layers').map((l, i): LayerDef => {
    const p = `layers[${i}]`;
    const o = obj(l, p);
    const kind = o.kind;
    if (typeof kind !== 'string' || !(LAYER_KINDS as readonly string[]).includes(kind)) {
      fail(`${p}.kind`, `expected one of ${LAYER_KINDS.join(', ')}`);
    }
    let def: LayerDef;
    if (kind === 'sky') def = sky(o, p);
    else if (kind === 'fog') def = fog(o, p);
    else if (kind === 'kit') def = kit(o, p, atlasIds);
    else def = plate(o, p);
    if (ids.has(def.id)) fail(`${p}.id`, `duplicate layer id "${def.id}"`);
    ids.add(def.id);
    const [fx, fy] = def.parallax;
    if (def.kind === 'sky') {
      skyCount++;
      if (skyCount > 1) fail(p, 'at most one sky layer');
      if (i !== 0) fail(p, 'the sky layer must be first');
      if (fx !== 0 || fy !== 0) fail(`${p}.parallax`, 'the sky is infinitely far: expected [0, 0]');
    }
    if (fx < prevFx) fail(`${p}.parallax`, `layers must be ordered far → near (fx ${fx} after ${prevFx})`);
    prevFx = fx;
    if (def.kind === 'kit' || def.kind === 'plate') {
      if (fx <= 1) {
        if (fx > MAX_LAYER_PARALLAX) fail(`${p}.parallax`, `depth-tested layers need fx ≤ ${MAX_LAYER_PARALLAX} (or > 1 for foreground)`);
        if (fx - prevDepthFx < MIN_LAYER_PARALLAX_GAP - 1e-9) {
          fail(`${p}.parallax`, `depth-tested layers need a parallax gap ≥ ${MIN_LAYER_PARALLAX_GAP} (fx ${fx} after ${prevDepthFx})`);
        }
        prevDepthFx = fx;
      }
    }
    return def;
  });
  const manifest: LayerManifest = { version: 1, area, textureBudgetMB, atlases, layers };
  if (root.replaced !== undefined) {
    const replaced = replacedLayers(root.replaced, layers, atlasIds);
    if (Object.keys(replaced).length > 0) manifest.replaced = replaced;
  }
  return manifest;
}

/**
 * Generated manifests (`npm run art`, §5.8) record, under `replaced`, the base layer each plate layer
 * took out of the draw list: `{ "<plate id>": <that base layer's def> }`. The runtime draws it again
 * when the plate fails to load. Validated here: the plates exist, the layers are kit or plate layers no
 * longer in the list, and restoring any subset keeps the depth gaps.
 */
function replacedLayers(v: unknown, layers: readonly LayerDef[], atlasIds: ReadonlySet<string>): Record<string, LayerDef> {
  const r = obj(v, 'replaced');
  const out: Record<string, LayerDef> = {};
  const ids = new Set(layers.map((l) => l.id));
  const taken = new Set<string>();
  for (const plateId of Object.keys(r).sort()) {
    const p = `replaced.${plateId}`;
    const plateDef = layers.find((l) => l.id === plateId);
    if (!plateDef || plateDef.kind !== 'plate') fail(p, `"${plateId}" is not a plate layer of this manifest`);
    const o = obj(r[plateId], p);
    if (o.kind !== 'kit' && o.kind !== 'plate') fail(`${p}.kind`, 'only kit and plate layers can be replaced by a plate');
    const def: LayerDef = o.kind === 'kit' ? kit(o, p, atlasIds) : plate(o, p);
    if (ids.has(def.id)) fail(`${p}.id`, `"${def.id}" is still in the layer list`);
    if (taken.has(def.id)) fail(`${p}.id`, `"${def.id}" is replaced by two plates`);
    taken.add(def.id);
    const fx = def.parallax[0];
    if (fx <= 1 && fx > MAX_LAYER_PARALLAX) fail(`${p}.parallax`, `depth-tested layers need fx ≤ ${MAX_LAYER_PARALLAX}`);
    out[plateId] = def;
  }
  // Any failed subset of plates must still keep the depth gaps: every two depth-tested layers that can
  // draw together (all but a plate and the layer it replaces) are MIN_LAYER_PARALLAX_GAP apart.
  const depth: { id: string; fx: number; pair: string | null }[] = [];
  for (const l of layers) {
    if ((l.kind === 'kit' || l.kind === 'plate') && l.parallax[0] <= 1) depth.push({ id: l.id, fx: l.parallax[0], pair: null });
  }
  for (const [plateId, def] of Object.entries(out)) {
    if (def.parallax[0] <= 1) depth.push({ id: def.id, fx: def.parallax[0], pair: plateId });
  }
  for (let i = 0; i < depth.length; i++) {
    for (let j = i + 1; j < depth.length; j++) {
      const a = depth[i] as (typeof depth)[number];
      const b = depth[j] as (typeof depth)[number];
      if (a.pair === b.id || b.pair === a.id) continue;
      if (Math.abs(a.fx - b.fx) < MIN_LAYER_PARALLAX_GAP - 1e-9) {
        const restored = a.pair ? a : b;
        const other = restored === a ? b : a;
        fail(`replaced.${restored.pair ?? restored.id}`, `restoring "${restored.id}" (fx ${restored.fx}) would draw it ${Math.abs(a.fx - b.fx).toFixed(3)} from "${other.id}" (fx ${other.fx}); depth-tested layers need a gap ≥ ${MIN_LAYER_PARALLAX_GAP}`);
      }
    }
  }
  return out;
}

export async function loadManifest(url: string, fetchFn: typeof fetch = fetch): Promise<LayerManifest> {
  const res = await fetchFn(url);
  if (!res.ok) throw new ManifestError(`Failed to load manifest ${url}: HTTP ${res.status}`);
  return parseManifest(await res.json());
}
