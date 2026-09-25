/**
 * The JSON sidecar of a painted plate, `art/plates/<id>.json` (ARCHITECTURE.md §5.8). Validation is
 * strict and names the file, the key and the fix, because artists edit these by hand.
 */
import { MAX_LAYER_PARALLAX } from '../../src/config.ts';
import type { PlateLayerDef } from '../../src/contracts/assets.ts';
import { AREA_GRADES, type AreaGradeId } from '../../src/contracts/level.ts';
import type { QualityLevel } from '../../src/contracts/quality.ts';
import { PLATE_CONTENT, PLATE_MIN_TEXEL_SCALE } from '../../src/assets/plateLayout.ts';

export interface Sidecar {
  /** [fx, fy]: where the plate draws among the base layers (ties are rejected by the splice). */
  parallax: [number, number];
  /** Base layer id the plate takes out of the draw list (restored if the plate fails to load). */
  replaces: string | null;
  /** Layer-space top-left of the image, world units. */
  origin: [number, number];
  /** World units per image texel (≥ 1.5). */
  texelScale: number;
  minQuality: QualityLevel;
  fog: number;
  fogColor: string;
  desaturate: number;
  tint: string;
  /** Area the plate belongs to (docs and budget reports). */
  area: AreaGradeId | null;
}

export class SidecarError extends Error {
  override name = 'SidecarError';
}

const QUALITY: readonly QualityLevel[] = ['low', 'medium', 'high'];
const KEYS = ['parallax', 'replaces', 'origin', 'texelScale', 'minQuality', 'fog', 'fogColor', 'desaturate', 'tint', 'area'] as const;
const REQUIRED: readonly string[] = ['parallax', 'origin', 'texelScale', 'minQuality', 'fog', 'fogColor', 'desaturate', 'tint'];
/** Plate ids are file stems and become layer ids and chunk file names. */
export const PLATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function distance(a: string, b: string): number {
  const d: number[] = [];
  for (let j = 0; j <= b.length; j++) d[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0] as number;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = d[j] as number;
      d[j] = Math.min((d[j] as number) + 1, (d[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return d[b.length] as number;
}

function suggest(key: string): string {
  let best = '';
  let bd = Infinity;
  for (const k of KEYS) {
    const dd = k.toLowerCase() === key.toLowerCase() ? 0 : distance(k, key);
    if (dd < bd) {
      bd = dd;
      best = k;
    }
  }
  return bd <= 3 ? ` (did you mean "${best}"?)` : '';
}

/**
 * Validate a parsed sidecar. `file` names it in every message. Keys starting with `_` or `$` are
 * comments and are ignored (they don't trigger a re-bake either).
 */
export function parseSidecar(json: unknown, file: string): Sidecar {
  const fail = (msg: string): never => {
    throw new SidecarError(`${file}: ${msg}`);
  };
  if (typeof json !== 'object' || json === null || Array.isArray(json)) fail('expected a JSON object');
  const o = json as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (k.startsWith('_') || k.startsWith('$')) continue;
    if (!(KEYS as readonly string[]).includes(k)) fail(`unknown key "${k}"${suggest(k)}; allowed: ${KEYS.join(', ')}`);
  }
  for (const k of REQUIRED) if (o[k] === undefined) fail(`"${k}" is missing (required: ${REQUIRED.join(', ')})`);
  const finite = (k: string, v: unknown): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(`"${k}" must be a number, got ${JSON.stringify(v)}`);
    return v as number;
  };
  const unit = (k: string): number => {
    const v = finite(k, o[k]);
    if (v < 0 || v > 1) fail(`"${k}" must be between 0 and 1, got ${v}`);
    return v;
  };
  const colour = (k: string): string => {
    const v = o[k];
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) fail(`"${k}" must be a colour "#rrggbb", got ${JSON.stringify(v)}`);
    return (v as string).toLowerCase();
  };
  const pair = (k: string): [number, number] => {
    const v = o[k];
    if (!Array.isArray(v) || v.length !== 2) fail(`"${k}" must be [x, y], got ${JSON.stringify(v)}`);
    const a = v as unknown[];
    return [finite(`${k}[0]`, a[0]), finite(`${k}[1]`, a[1])];
  };

  const parallax = pair('parallax');
  const [fx, fy] = parallax;
  if (fx <= 0) fail(`"parallax" fx must be > 0 (0 is the sky), got ${fx}`);
  if (fx > MAX_LAYER_PARALLAX && fx <= 1) {
    fail(`"parallax" fx ${fx} is too close to the gameplay plane: depth-tested layers need fx ≤ ${MAX_LAYER_PARALLAX}, foreground plates fx > 1`);
  }
  if (fx > 4) fail(`"parallax" fx must be ≤ 4, got ${fx}`);
  if (fy < 0 || fy > 4) fail(`"parallax" fy must be between 0 and 4, got ${fy}`);

  let replaces: string | null = null;
  if (o.replaces !== undefined && o.replaces !== null) {
    if (typeof o.replaces !== 'string' || o.replaces.length === 0) fail(`"replaces" must be a base layer id or null, got ${JSON.stringify(o.replaces)}`);
    replaces = o.replaces as string;
  }

  const origin = pair('origin');
  const texelScale = finite('texelScale', o.texelScale);
  if (texelScale < PLATE_MIN_TEXEL_SCALE) {
    fail(`"texelScale" must be ≥ ${PLATE_MIN_TEXEL_SCALE} world units per texel, got ${texelScale}: WebP/PNG chunks have no mipmaps, so finer texels alias at Low quality. Paint at a lower resolution or raise texelScale`);
  }
  if (texelScale > 64) fail(`"texelScale" must be ≤ 64, got ${texelScale}`);

  const mq = o.minQuality;
  if (typeof mq !== 'string' || !QUALITY.includes(mq as QualityLevel)) fail(`"minQuality" must be one of ${QUALITY.join(', ')}, got ${JSON.stringify(mq)}`);

  let area: AreaGradeId | null = null;
  if (o.area !== undefined && o.area !== null) {
    if (typeof o.area !== 'string' || !(AREA_GRADES as readonly string[]).includes(o.area)) {
      fail(`"area" must be one of ${AREA_GRADES.join(', ')} or null, got ${JSON.stringify(o.area)}`);
    }
    area = o.area as AreaGradeId;
  }

  return {
    parallax,
    replaces,
    origin,
    texelScale,
    minQuality: mq as QualityLevel,
    fog: unit('fog'),
    fogColor: colour('fogColor'),
    desaturate: unit('desaturate'),
    tint: colour('tint'),
    area,
  };
}

/** The sidecar in canonical form (known keys, fixed order): what the source hash covers. */
export function canonicalSidecar(s: Sidecar): string {
  return JSON.stringify({
    parallax: s.parallax, replaces: s.replaces, origin: s.origin, texelScale: s.texelScale, minQuality: s.minQuality,
    fog: s.fog, fogColor: s.fogColor, desaturate: s.desaturate, tint: s.tint, area: s.area,
  });
}

/** The plate layer a sidecar describes (chunks are filled by the bake). */
export function plateLayerDef(id: string, s: Sidecar): PlateLayerDef {
  return {
    id,
    kind: 'plate',
    parallax: [s.parallax[0], s.parallax[1]],
    minQuality: s.minQuality,
    tint: s.tint,
    fog: s.fog,
    fogColor: s.fogColor,
    desaturate: s.desaturate,
    origin: [s.origin[0], s.origin[1]],
    chunkSize: [PLATE_CONTENT, PLATE_CONTENT],
    texelScale: s.texelScale,
    chunks: [],
  };
}

/**
 * Sidecar changes the runtime can't apply to a live layer (a full page reload): the layer's position
 * in the stack, its replacement or its quality gate. Everything else (pixels, colour, origin, texel
 * scale) reloads just that layer.
 */
export function structuralChange(a: Sidecar, b: Sidecar): string | null {
  if (a.parallax[0] !== b.parallax[0] || a.parallax[1] !== b.parallax[1]) return 'parallax';
  if (a.replaces !== b.replaces) return 'replaces';
  if (a.minQuality !== b.minQuality) return 'minQuality';
  return null;
}
