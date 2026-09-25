import type { LevelData } from '../../contracts/level.ts';
import type { Extent } from '../util/camera.ts';
import { TerrainField, type TerrainFieldOptions } from './terrainField.ts';
import { MOON_DIR, packSpill, TerrainLights } from './terrainLight.ts';
import { TERRAIN_DEEP_REACH, TERRAIN_STROKE_CONT_MAX, TERRAIN_STROKE_DEPTH, TERRAIN_STROKE_WRAP } from './terrainShading.ts';

/**
 * Terrain meshing (ARCHITECTURE.md §5.5), pure: marching squares over the terrain field on a
 * `cell`-unit grid offset by half a cell from the tile grid (tile corners fall on cell centres, so
 * rounded corners are sampled well), producing per-chunk core triangles with a depth-inside
 * attribute (the field distance near surfaces, a distance transform deeper in, up to
 * `shadeDepth + TERRAIN_DEEP_REACH`), closed contours with outward normals and an up-facing factor,
 * and per-chunk edge strips (AA feather + moss rim on up-facing edges). Vertices carry baked light: how squarely the nearest
 * surface faces the moon, and lantern / flora / thorn spill; and the painterly stroke coordinate (s, d): the
 * arc length at the nearest contour point (from each contour's lowest point, scaled so a long contour
 * closes on a whole number of wraps, wrapped mod TERRAIN_STROKE_WRAP) and the distance to it, with a
 * continuity weight (0 next to a jump of s) in the spill slot's 4th byte.
 */
export interface TerrainMeshOptions {
  cell: number;
  /** Chunk size in tiles. */
  chunkTiles: number;
  /** Geometry extends this far beyond the level (u), for screen shake. */
  margin: number;
  /** Rim-zone depth (u): the core ramps from the edge colour to the deep colour over this range. */
  shadeDepth: number;
  /** Moss strip reach into the ground and out of it (u). */
  mossIn: number;
  mossOut: number;
  /** Minimum up-facing factor for a segment to grow moss. */
  mossMinUp: number;
  field: Partial<TerrainFieldOptions>;
}

export const DEFAULT_TERRAIN: TerrainMeshOptions = {
  cell: 12,
  chunkTiles: 16,
  margin: 48,
  shadeDepth: 90,
  mossIn: 9,
  mossOut: 6,
  mossMinUp: 0.12,
  field: {},
};

/**
 * Edge vertex: aPosition (2), aNormal (2), aEdge (side −1..1, kind 0 AA / 1 moss, up 0..1, stroke s),
 * aSpill (unorm8x4 packed in one float slot: warm, flora, thorn, stroke continuity × CONT_MAX / 255).
 */
export const EDGE_STRIDE_FLOATS = 9;
/**
 * Core vertex: aPosition (2), aDist (depth inside, u, up to shadeDepth + TERRAIN_DEEP_REACH), aLit
 * (moon-facing 0..1), aSpill (packed, as above), aStroke (s, d: the stroke coordinate).
 */
export const CORE_STRIDE_FLOATS = 7;
/** Offset of aStroke in a core vertex (floats). */
export const CORE_STROKE_OFFSET = 5;
/** Largest change of s (u) per unit of distance between neighbouring grid corners that counts as continuous. */
export const STROKE_JUMP = 2.5;
export const EDGE_KIND_AA = 0;
export const EDGE_KIND_MOSS = 1;

export interface TerrainChunk {
  col: number;
  row: number;
  bounds: Extent;
  /** Interleaved core vertices (CORE_STRIDE_FLOATS). */
  core: Float32Array;
  coreIndices: Uint16Array;
  coreArea: number;
  edge: Float32Array;
  edgeIndices: Uint16Array;
  /** Indices of the moss quads only (glow twin shares the edge vertex buffer). */
  mossIndices: Uint16Array;
  /** Area of the edge strips at unit AA width (u²) + moss strips, for fill estimates. */
  edgeLength: number;
  mossArea: number;
}

export interface Contour {
  /** Flat x,y pairs, closed (last point connects to the first). */
  points: Float32Array;
  normals: Float32Array;
  up: Float32Array;
  /**
   * Stroke arc length at each point (u, unwrapped): the arc length from the contour's lowest point (0)
   * around the loop × arcScale.
   */
  arc: Float64Array;
  /**
   * round(P / W)·W / P for a contour of perimeter P ≥ W / 2 (W = TERRAIN_STROKE_WRAP), so s closes on a
   * whole number of wraps (no seam at the start point); 1 for shorter ones (their start point fades out).
   */
  arcScale: number;
}

export interface TerrainMesh {
  chunks: TerrainChunk[];
  contours: Contour[];
  field: TerrainField;
  /** Grid origin and sample counts (for tests and debug). */
  gx0: number;
  gy0: number;
  nx: number;
  ny: number;
}

// Marching squares: corners 0 TL, 1 TR, 2 BR, 3 BL (y down); edges 0 top, 1 right, 2 bottom, 3 left.
// Segments are oriented with the solid (inside) on their left when walking from → to (y down).
const SEGMENTS: readonly (readonly number[])[] = [
  [], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2],
  [2, 3], [2, 0], [0, 1, 2, 3], [2, 1], [1, 3], [1, 0], [0, 3], [],
];

/** Joined saddles (the cell centre is inside): the two segments pair up the other way. */
const JOINED_5: readonly number[] = [3, 2, 1, 0];
const JOINED_10: readonly number[] = [0, 3, 2, 1];

class Growable {
  data: Float32Array;
  bits: Uint32Array;
  length = 0;
  constructor(cap: number) {
    this.data = new Float32Array(cap);
    this.bits = new Uint32Array(this.data.buffer);
  }
  private grow(): void {
    const next = new Float32Array(this.data.length * 2);
    next.set(this.data);
    this.data = next;
    this.bits = new Uint32Array(next.buffer);
  }
  push(v: number): void {
    if (this.length === this.data.length) this.grow();
    this.data[this.length++] = v;
  }
  /** Push raw bits (packed unorm8x4) without a float round trip. */
  pushBits(v: number): void {
    if (this.length === this.data.length) this.grow();
    this.bits[this.length++] = v;
  }
  view(): Float32Array {
    return this.data.slice(0, this.length);
  }
}

interface ChunkBuild {
  core: Growable;
  coreIdx: number[];
  coreMap: Map<number, number>;
  coreArea: number;
  edge: Growable;
  edgeIdx: number[];
  mossIdx: number[];
  edgeLength: number;
  mossArea: number;
  bounds: Extent;
}

function grow(b: Extent, x: number, y: number): void {
  if (x < b.x0) b.x0 = x;
  if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y;
  if (y > b.y1) b.y1 = y;
}

/** Build the terrain mesh for a level. Deterministic for a given level and options. */
export function buildTerrainMesh(
  level: Pick<LevelData, 'widthTiles' | 'heightTiles' | 'tiles' | 'tileSize' | 'pxWidth' | 'pxHeight' | 'seed'> & Partial<Pick<LevelData, 'decorHints'>>,
  options: Partial<TerrainMeshOptions> = {},
): TerrainMesh {
  const o: TerrainMeshOptions = { ...DEFAULT_TERRAIN, ...options };
  const field = new TerrainField(level, { seed: level.seed, ...o.field });
  const lights = new TerrainLights(level);
  const spillOut = [0, 0, 0];
  const spillAt = (x: number, y: number): number => {
    lights.sample(x, y, spillOut);
    return packSpill(spillOut[0] as number, spillOut[1] as number, spillOut[2] as number);
  };
  /** Moon-facing factor of the nearest surface, from the (undisplaced) field gradient. */
  const litFrom = (gx: number, gy: number): number => {
    const l = Math.hypot(gx, gy);
    if (l < 1e-6) return 0;
    return Math.max(0, (gx * MOON_DIR[0] + gy * MOON_DIR[1]) / l);
  };
  const C = o.cell;
  const half = C / 2;
  // Sample points sit at half-cell offsets from tile lines: gx0 ≡ C/2 (mod C).
  const gx0 = Math.floor(-o.margin / C) * C + half;
  const gy0 = gx0;
  const nx = Math.ceil((level.pxWidth + o.margin - gx0) / C) + 1;
  const ny = Math.ceil((level.pxHeight + o.margin - gy0) / C) + 1;
  const maxD = field.opts.maxDist;

  const f = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      // The outer ring is forced outside so every contour closes.
      f[j * nx + i] = i === 0 || j === 0 || i === nx - 1 || j === ny - 1 ? maxD : field.sample(gx0 + i * C, gy0 + j * C);
    }
  }

  // Edge crossings: id = (horizontal ? 0 : 1) + 2 * (j * nx + i); horizontal edge from (i,j) to (i+1,j).
  const crossX = new Map<number, number>();
  const crossY = new Map<number, number>();
  const crossing = (id: number): void => {
    if (crossX.has(id)) return;
    const s = id >> 1;
    const i = s % nx;
    const j = (s - i) / nx;
    const horizontal = (id & 1) === 0;
    const i2 = horizontal ? i + 1 : i;
    const j2 = horizontal ? j : j + 1;
    const f0 = f[j * nx + i] as number;
    const f1 = f[j2 * nx + i2] as number;
    const ax = gx0 + i * C;
    const ay = gy0 + j * C;
    const bx = gx0 + i2 * C;
    const by = gy0 + j2 * C;
    let lo = 0;
    let hi = 1;
    let flo = f0;
    let t = f0 / (f0 - f1);
    // Refine on the edge line (regula falsi with a bisection guard) against the exact field.
    const onRing = i === 0 || j === 0 || i2 === nx - 1 || j2 === ny - 1;
    if (!onRing) {
      for (let k = 0; k < 8; k++) {
        const ft = field.sample(ax + (bx - ax) * t, ay + (by - ay) * t);
        if (Math.abs(ft) < 1e-3) break;
        if (ft < 0 === flo < 0) {
          lo = t;
          flo = ft;
        } else {
          hi = t;
        }
        const fhi = field.sample(ax + (bx - ax) * hi, ay + (by - ay) * hi);
        const next = lo + (hi - lo) * (flo / (flo - fhi));
        t = Number.isFinite(next) && next > lo && next < hi ? next : (lo + hi) / 2;
      }
    }
    crossX.set(id, ax + (bx - ax) * t);
    crossY.set(id, ay + (by - ay) * t);
  };
  const edgeId = (i: number, j: number, e: number): number => {
    if (e === 0) return 2 * (j * nx + i);
    if (e === 1) return 2 * (j * nx + i + 1) + 1;
    if (e === 2) return 2 * ((j + 1) * nx + i);
    return 2 * (j * nx + i) + 1;
  };

  const chunkSize = o.chunkTiles * level.tileSize;
  const chunkCols = Math.floor((gx0 + (nx - 1) * C - half) / chunkSize) - Math.floor((gx0 + half) / chunkSize) + 1;
  const col0 = Math.floor((gx0 + half) / chunkSize);
  const row0 = Math.floor((gy0 + half) / chunkSize);
  const builds = new Map<number, ChunkBuild>();
  const chunkOf = (i: number, j: number): ChunkBuild => {
    const cc = Math.floor((gx0 + (i + 0.5) * C) / chunkSize) - col0;
    const cr = Math.floor((gy0 + (j + 0.5) * C) / chunkSize) - row0;
    const key = cr * chunkCols + cc;
    let b = builds.get(key);
    if (!b) {
      b = {
        core: new Growable(4096), coreIdx: [], coreMap: new Map(), coreArea: 0,
        edge: new Growable(1024), edgeIdx: [], mossIdx: [], edgeLength: 0, mossArea: 0,
        bounds: { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
      };
      builds.set(key, b);
    }
    return b;
  };

  const depthCap = o.shadeDepth + TERRAIN_DEEP_REACH;
  const depthIn = interiorDepth(f, nx, ny, C, maxD, depthCap);

  // Pass 1: cell codes (saddles resolved once, bit 4 = joined) and directed contour segments:
  // next[fromEdge] = toEdge.
  const codes = new Uint8Array(nx * ny);
  const next = new Map<number, number>();
  const segCell = new Map<number, number>();
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const f00 = f[j * nx + i] as number;
      const f10 = f[j * nx + i + 1] as number;
      const f11 = f[(j + 1) * nx + i + 1] as number;
      const f01 = f[(j + 1) * nx + i] as number;
      const code = (f00 < 0 ? 1 : 0) | (f10 < 0 ? 2 : 0) | (f11 < 0 ? 4 : 0) | (f01 < 0 ? 8 : 0);
      if (code === 0) continue;
      let joined = false;
      if (code === 5 || code === 10) {
        // Saddle: resolve with the field at the cell centre.
        joined = field.sample(gx0 + (i + 0.5) * C, gy0 + (j + 0.5) * C) < 0;
      }
      codes[j * nx + i] = code | (joined ? 16 : 0);
      if (code === 15) continue;
      const segs = joined ? (code === 5 ? JOINED_5 : JOINED_10) : (SEGMENTS[code] as readonly number[]);
      for (let k = 0; k < segs.length; k += 2) {
        const a = edgeId(i, j, segs[k] as number);
        next.set(a, edgeId(i, j, segs[k + 1] as number));
        segCell.set(a, j * nx + i);
      }
    }
  }

  // Chain directed segments into closed contours.
  const contours: Contour[] = [];
  const visited = new Set<number>();
  const loops: number[][] = [];
  for (const startId of next.keys()) {
    if (visited.has(startId)) continue;
    const loop: number[] = [];
    let id = startId;
    while (!visited.has(id)) {
      visited.add(id);
      loop.push(id);
      const n = next.get(id);
      if (n === undefined) throw new Error('terrain contour is not closed');
      id = n;
    }
    if (id !== startId) throw new Error('terrain contour chain is inconsistent');
    loops.push(loop);
  }
  // Stroke s of every crossing on a contour (wrapped) and its continuity weight, for the core vertices
  // on the outline; the edge strips' weights per contour point.
  const crossS = new Map<number, number>();
  const crossC = new Map<number, number>();
  const edgeCont: Float32Array[] = [];
  for (const loop of loops) {
    const n = loop.length;
    const points = new Float32Array(n * 2);
    const normals = new Float32Array(n * 2);
    const up = new Float32Array(n);
    const arc = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const id = loop[k] as number;
      crossing(id);
      points[k * 2] = crossX.get(id) as number;
      points[k * 2 + 1] = crossY.get(id) as number;
    }
    // Arc length runs from the lowest point (usually below the level or an underside), where s restarts.
    let k0 = 0;
    for (let k = 1; k < n; k++) {
      const y = points[k * 2 + 1] as number;
      const y0 = points[k0 * 2 + 1] as number;
      if (y > y0 || (y === y0 && (points[k * 2] as number) < (points[k0 * 2] as number))) k0 = k;
    }
    let acc = 0;
    for (let m = 0; m < n; m++) {
      const k = (k0 + m) % n;
      arc[k] = acc;
      const k1 = (k + 1) % n;
      acc += Math.hypot((points[k1 * 2] as number) - (points[k * 2] as number), (points[k1 * 2 + 1] as number) - (points[k * 2 + 1] as number));
    }
    // A long contour closes on a whole number of wraps (the stroke texture is periodic over one): no
    // seam where s restarts. A short one keeps its length and fades its strokes out at the start point.
    const W0 = TERRAIN_STROKE_WRAP;
    const arcScale = acc >= W0 / 2 ? (Math.round(acc / W0) * W0) / acc : 1;
    const cont = new Float32Array(n).fill(1);
    if (arcScale === 1 && n > 2) {
      cont[k0] = 0;
      cont[(k0 + 1) % n] = 0.5;
      cont[(k0 + n - 1) % n] = 0.5;
    }
    for (let k = 0; k < n; k++) {
      arc[k] = (arc[k] as number) * arcScale;
      crossS.set(loop[k] as number, (arc[k] as number) % W0);
      crossC.set(loop[k] as number, cont[k] as number);
    }
    edgeCont.push(cont);
    for (let k = 0; k < n; k++) {
      // Outward normal = average of adjacent segment normals; inside is on the left (y down),
      // so for direction (dx, dy) the outward normal is (−dy, dx).
      const p0 = (k + n - 1) % n;
      const p1 = (k + 1) % n;
      let ax = (points[k * 2] as number) - (points[p0 * 2] as number);
      let ay = (points[k * 2 + 1] as number) - (points[p0 * 2 + 1] as number);
      let bx = (points[p1 * 2] as number) - (points[k * 2] as number);
      let by = (points[p1 * 2 + 1] as number) - (points[k * 2 + 1] as number);
      const la = Math.hypot(ax, ay) || 1;
      const lb = Math.hypot(bx, by) || 1;
      ax /= la;
      ay /= la;
      bx /= lb;
      by /= lb;
      let nxv = -(ay + by);
      let nyv = ax + bx;
      const ln = Math.hypot(nxv, nyv);
      if (ln < 1e-6) {
        nxv = -by;
        nyv = bx;
      } else {
        // Miter-length compensation keeps the strip width constant at corners (clamped).
        const cos = Math.max(0.35, (-nxv * by + nyv * bx) / ln);
        nxv = nxv / ln / cos;
        nyv = nyv / ln / cos;
      }
      normals[k * 2] = nxv;
      normals[k * 2 + 1] = nyv;
      up[k] = Math.min(1, Math.max(0, -nyv / Math.hypot(nxv, nyv)));
    }
    contours.push({ points, normals, up, arc, arcScale });
  }

  // Stroke coordinate (s wrapped, d) of the inside grid corners within reach of the outline; d < 0 = none.
  const cornerS = new Float32Array(nx * ny);
  const cornerD = new Float32Array(nx * ny);
  strokeCorners(contours, f, depthIn, nx, ny, gx0, gy0, C, TERRAIN_STROKE_DEPTH + C, cornerS, cornerD);
  const cornerC = new Float32Array(nx * ny);
  strokeContinuity(cornerS, cornerD, nx, ny, C, cornerC);
  const contByte = (c: number): number => Math.round(Math.min(1, Math.max(0, c)) * TERRAIN_STROKE_CONT_MAX) << 24;

  // Vertex keys: corners 2·s (even), crossings 2·edgeId + 1 (odd); ×2 (+1 for the copy shifted by one wrap).
  const coreVertex = (b: ChunkBuild, key: number, x: number, y: number, depth: number, ss: number, sd: number, sc: number): number => {
    let v = b.coreMap.get(key);
    if (v === undefined) {
      v = b.core.length / CORE_STRIDE_FLOATS;
      b.core.push(x);
      b.core.push(y);
      b.core.push(depth);
      const pos = key >> 1;
      if ((pos & 1) === 0) {
        // Grid corner: central differences on the sampled grid (cheap, and follows the displaced surface).
        const g = pos >> 1;
        const gi = g % nx;
        const gj = (g - gi) / nx;
        const l = f[gi > 0 ? g - 1 : g] as number;
        const rr = f[gi < nx - 1 ? g + 1 : g] as number;
        const u = f[gj > 0 ? g - nx : g] as number;
        const d = f[gj < ny - 1 ? g + nx : g] as number;
        b.core.push(litFrom(rr - l, d - u));
      } else {
        b.core.push(litFrom(field.base(x + 3, y) - field.base(x - 3, y), field.base(x, y + 3) - field.base(x, y - 3)));
      }
      b.core.pushBits((spillAt(x, y) | contByte(sc)) >>> 0);
      b.core.push(ss);
      b.core.push(sd);
      b.coreMap.set(key, v);
      grow(b.bounds, x, y);
    }
    return v;
  };
  // The polygon being emitted (at most 6 vertices): position key, x, y, depth, stroke s (−1 = none in
  // reach) and d, then the vertex indices. Preallocated: this runs for every cell.
  const polyK = new Float64Array(8);
  const polyX = new Float64Array(8);
  const polyY = new Float64Array(8);
  const polyZ = new Float64Array(8);
  const polyS = new Float64Array(8);
  const polyD = new Float64Array(8);
  const polyC = new Float64Array(8);
  const polyV = new Int32Array(8);
  let pn = 0;
  const W = TERRAIN_STROKE_WRAP;
  const emitPoly = (b: ChunkBuild): void => {
    const n = pn;
    // s is periodic: the polygon takes the shortest arc of the circle that holds its s values. It cuts
    // the circle at the widest gap between them, and the values below the cut use their vertex copies
    // shifted by one wrap (the stroke texture is periodic over it), so s interpolates the short way.
    let cut = -1;
    let widest = 0;
    // Most polygons hold a short span of s: then the widest gap is the one round the wrap (no cut).
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < n; k++) {
      const sk = polyS[k] as number;
      if (sk < 0) continue;
      if (sk < lo) lo = sk;
      if (sk > hi) hi = sk;
    }
    for (let k = 0; k < n && hi - lo >= W / 2; k++) {
      const sk = polyS[k] as number;
      if (sk < 0) continue;
      // The gap above sk: to the next value up, or round the wrap to the lowest.
      let nextUp = Infinity;
      let lowest = Infinity;
      for (let q = 0; q < n; q++) {
        const sq = polyS[q] as number;
        if (sq < 0) continue;
        if (sq > sk && sq < nextUp) nextUp = sq;
        if (sq < lowest) lowest = sq;
      }
      const gap = nextUp < Infinity ? nextUp - sk : lowest + W - sk;
      if (gap > widest) {
        widest = gap;
        cut = nextUp < Infinity ? sk : -1;
      }
    }
    for (let k = 0; k < n; k++) {
      const ss = polyS[k] as number;
      const shift = cut >= 0 && ss >= 0 && ss <= cut;
      polyV[k] = coreVertex(b, (polyK[k] as number) * 2 + (shift ? 1 : 0), polyX[k] as number, polyY[k] as number,
        polyZ[k] as number, ss < 0 ? 0 : shift ? ss + W : ss, polyD[k] as number, polyC[k] as number);
    }
    const ax = polyX[0] as number;
    const ay = polyY[0] as number;
    for (let k = 1; k < n - 1; k++) {
      b.coreIdx.push(polyV[0] as number, polyV[k] as number, polyV[k + 1] as number);
      b.coreArea += Math.abs(((polyX[k] as number) - ax) * ((polyY[k + 1] as number) - ay) - ((polyX[k + 1] as number) - ax) * ((polyY[k] as number) - ay)) / 2;
    }
    pn = 0;
  };
  const addCorner = (i: number, j: number): void => {
    const g = j * nx + i;
    polyK[pn] = 2 * g;
    polyX[pn] = gx0 + i * C;
    polyY[pn] = gy0 + j * C;
    const depth = depthIn[g] as number;
    polyZ[pn] = depth;
    const d = cornerD[g] as number;
    polyS[pn] = d < 0 ? -1 : (cornerS[g] as number);
    polyD[pn] = d < 0 ? depth : d;
    polyC[pn] = cornerC[g] as number;
    pn++;
  };
  const addCross = (id: number): void => {
    crossing(id);
    polyK[pn] = 2 * id + 1;
    polyX[pn] = crossX.get(id) as number;
    polyY[pn] = crossY.get(id) as number;
    polyZ[pn] = 0;
    polyS[pn] = crossS.get(id) ?? -1;
    polyD[pn] = 0;
    polyC[pn] = crossC.get(id) ?? 0;
    pn++;
  };

  // Pass 2: inside polygons per cell.
  const cornerDI = [0, 1, 1, 0];
  const cornerDJ = [0, 0, 1, 1];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const cj = codes[j * nx + i] as number;
      if (cj === 0) continue;
      const code = cj & 15;
      const joined = (cj & 16) !== 0;
      const b = chunkOf(i, j);
      if (code === 15) {
        for (let c = 0; c < 4; c++) addCorner(i + (cornerDI[c] as number), j + (cornerDJ[c] as number));
        emitPoly(b);
        continue;
      }
      // Inside polygon(s): walk corners 0..3 with the crossing on each edge after its start corner.
      if ((code === 5 || code === 10) && !joined) {
        for (let c = 0; c < 4; c++) {
          if (!(code & (1 << c))) continue;
          addCross(edgeId(i, j, (c + 3) % 4));
          addCorner(i + (cornerDI[c] as number), j + (cornerDJ[c] as number));
          addCross(edgeId(i, j, c));
          emitPoly(b);
        }
      } else {
        for (let c = 0; c < 4; c++) {
          const inside = (code & (1 << c)) !== 0;
          const nextInside = (code & (1 << ((c + 1) % 4))) !== 0;
          if (inside) addCorner(i + (cornerDI[c] as number), j + (cornerDJ[c] as number));
          if (inside !== nextInside) addCross(edgeId(i, j, c));
        }
        emitPoly(b);
      }
    }
  }

  // Edge strips: each segment goes to the chunk of the cell that produced it.
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li] as number[];
    const { points, normals, up, arc, arcScale } = contours[li] as Contour;
    const cont = edgeCont[li] as Float32Array;
    const n = loop.length;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const cell = segCell.get(loop[k] as number) as number;
      const ci = cell % nx;
      const b = chunkOf(ci, (cell - ci) / nx);
      const x0 = points[k * 2] as number;
      const y0 = points[k * 2 + 1] as number;
      const x1 = points[k1 * 2] as number;
      const y1 = points[k1 * 2 + 1] as number;
      const len = Math.hypot(x1 - x0, y1 - y0);
      b.edgeLength += len;
      const n0x = normals[k * 2] as number;
      const n0y = normals[k * 2 + 1] as number;
      const n1x = normals[k1 * 2] as number;
      const n1y = normals[k1 * 2 + 1] as number;
      const u0 = up[k] as number;
      const u1 = up[k1] as number;
      const s0 = (spillAt(x0, y0) | contByte(cont[k] as number)) >>> 0;
      const s1 = (spillAt(x1, y1) | contByte(cont[k1] as number)) >>> 0;
      // Stroke s along the segment, unwrapped within the quad (the texture is periodic over the wrap).
      const a0 = (arc[k] as number) % W;
      const a1 = a0 + len * arcScale;
      pushQuad(b, b.edgeIdx, null, x0, y0, n0x, n0y, x1, y1, n1x, n1y, EDGE_KIND_AA, u0, u1, s0, s1, a0, a1);
      if (Math.max(u0, u1) >= o.mossMinUp) {
        pushQuad(b, b.edgeIdx, b.mossIdx, x0, y0, n0x, n0y, x1, y1, n1x, n1y, EDGE_KIND_MOSS, u0, u1, s0, s1, a0, a1);
        b.mossArea += len * (o.mossIn + o.mossOut);
      }
      grow(b.bounds, x0 - o.mossIn, y0 - o.mossIn);
      grow(b.bounds, x0 + o.mossIn, y0 + o.mossIn);
    }
  }

  const chunks: TerrainChunk[] = [];
  const keys = [...builds.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    const b = builds.get(key) as ChunkBuild;
    if (b.core.length / CORE_STRIDE_FLOATS > 65535 || b.edge.length / EDGE_STRIDE_FLOATS > 65535) {
      throw new Error('terrain chunk exceeds 65535 vertices');
    }
    const cc = key % chunkCols;
    chunks.push({
      col: cc + col0,
      row: (key - cc) / chunkCols + row0,
      bounds: b.bounds,
      core: b.core.view(),
      coreIndices: Uint16Array.from(b.coreIdx),
      coreArea: b.coreArea,
      edge: b.edge.view(),
      edgeIndices: Uint16Array.from(b.edgeIdx),
      mossIndices: Uint16Array.from(b.mossIdx),
      edgeLength: b.edgeLength,
      mossArea: b.mossArea,
    });
  }
  return { chunks, contours, field, gx0, gy0, nx, ny };
}

/**
 * Stroke coordinate of the inside grid corners (f < 0) no deeper than `reach`: the nearest point on the
 * contours, as its arc length wrapped mod TERRAIN_STROKE_WRAP (`outS`) and the distance to it (`outD`,
 * −1 where no contour point is within reach). Each segment is splatted over the corners around it.
 */
export function strokeCorners(
  contours: readonly Contour[], f: Float32Array, depthIn: Float32Array, nx: number, ny: number, gx0: number, gy0: number, cell: number,
  reach: number, outS: Float32Array, outD: Float32Array,
): void {
  const W = TERRAIN_STROKE_WRAP;
  const n2 = nx * ny;
  const band = new Uint8Array(n2);
  const d2 = new Float32Array(n2);
  for (let g = 0; g < n2; g++) {
    band[g] = (f[g] as number) < 0 && (depthIn[g] as number) <= reach ? 1 : 0;
    d2[g] = Infinity;
  }
  for (let c = 0; c < contours.length; c++) {
    const pts = (contours[c] as Contour).points;
    const arc = (contours[c] as Contour).arc;
    const scale = (contours[c] as Contour).arcScale;
    const n = pts.length >> 1;
    for (let k = 0; k < n; k++) {
      const k1 = k + 1 === n ? 0 : k + 1;
      const ax = pts[k * 2] as number;
      const ay = pts[k * 2 + 1] as number;
      const dx = (pts[k1 * 2] as number) - ax;
      const dy = (pts[k1 * 2 + 1] as number) - ay;
      const len2 = dx * dx + dy * dy;
      const inv = len2 > 1e-12 ? 1 / len2 : 0;
      const len = Math.sqrt(len2) * scale;
      const s0 = (arc[k] as number) % W;
      const i0 = Math.max(1, Math.ceil((Math.min(ax, ax + dx) - reach - gx0) / cell));
      const i1 = Math.min(nx - 2, Math.floor((Math.max(ax, ax + dx) + reach - gx0) / cell));
      const j0 = Math.max(1, Math.ceil((Math.min(ay, ay + dy) - reach - gy0) / cell));
      const j1 = Math.min(ny - 2, Math.floor((Math.max(ay, ay + dy) + reach - gy0) / cell));
      for (let j = j0; j <= j1; j++) {
        const py = gy0 + j * cell - ay;
        const row = j * nx;
        for (let i = i0; i <= i1; i++) {
          const g = row + i;
          if (band[g] === 0) continue;
          const px = gx0 + i * cell - ax;
          let t = (px * dx + py * dy) * inv;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const ex = px - dx * t;
          const ey = py - dy * t;
          const e2 = ex * ex + ey * ey;
          if (e2 < (d2[g] as number)) {
            d2[g] = e2;
            outS[g] = s0 + t * len;
          }
        }
      }
    }
  }
  for (let g = 0; g < n2; g++) {
    const e2 = d2[g] as number;
    if (e2 === Infinity) {
      outD[g] = -1;
      continue;
    }
    outD[g] = Math.sqrt(e2);
    const sv = outS[g] as number;
    if (sv >= W) outS[g] = sv - W;
  }
}

/**
 * Continuity weight of each grid corner's stroke coordinate (`outC`): 0 where s jumps between it and a
 * neighbour (4-neighbours and diagonals, the edges of the mesh's triangles) by more than STROKE_JUMP
 * per unit of distance (the two sides of a thin mass's medial axis, a convex corner's mitre or its
 * focus) or where it has no s, 0.5 next to such a corner, 1 elsewhere. Interpolated across the
 * triangles, it fades the strokes smoothly into the plain strata around every discontinuity (the
 * per-triangle fwidth clamp would cut them in steps).
 */
export function strokeContinuity(sArr: Float32Array, dArr: Float32Array, nx: number, ny: number, cell: number, outC: Float32Array): void {
  const W = TERRAIN_STROKE_WRAP;
  const n2 = nx * ny;
  const bad = new Uint8Array(n2);
  const limit = STROKE_JUMP * cell;
  const jump = (g: number, h: number, dist: number): void => {
    if ((dArr[h] as number) < 0) return;
    let ds = Math.abs((sArr[h] as number) - (sArr[g] as number));
    if (ds > W / 2) ds = W - ds;
    if (ds > limit * dist) {
      bad[g] = 1;
      bad[h] = 1;
    }
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const g = j * nx + i;
      if ((dArr[g] as number) < 0) {
        bad[g] = 1;
        continue;
      }
      if (i + 1 < nx) jump(g, g + 1, 1);
      if (j + 1 < ny) {
        jump(g, g + nx, 1);
        if (i + 1 < nx) jump(g, g + nx + 1, Math.SQRT2);
        if (i > 0) jump(g, g + nx - 1, Math.SQRT2);
      }
    }
  }
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const g = j * nx + i;
      if (bad[g] === 1) {
        outC[g] = 0;
        continue;
      }
      let near = false;
      for (let dj = -1; dj <= 1 && !near; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= nx) continue;
          // (Out-of-band neighbours are deep: they don't mark a jump.)
          if (bad[jj * nx + ii] === 1 && (dArr[jj * nx + ii] as number) >= 0) {
            near = true;
            break;
          }
        }
      }
      outC[g] = near ? 0.5 : 1;
    }
  }
}

/**
 * Depth inside the terrain (u) on the sample grid, capped at `cap`: exactly −f where the field is
 * below its clamp (`maxD`), and beyond it a two-pass chamfer distance (3×3 plus knight moves, within a
 * few percent of Euclidean) seeded from that band. The forced outer ring seeds nothing, so ground
 * that continues past the level edge keeps deepening instead of meeting a phantom surface.
 */
export function interiorDepth(f: Float32Array, nx: number, ny: number, cell: number, maxD: number, cap: number): Float32Array {
  const d = new Float32Array(nx * ny);
  const free = new Uint8Array(nx * ny);
  const sat = maxD - 0.5;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const s = j * nx + i;
      const v = f[s] as number;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) {
        d[s] = Infinity;
        free[s] = 1;
      } else if (v >= 0) d[s] = 0;
      else if (-v < sat) d[s] = -v;
      else {
        d[s] = Infinity;
        free[s] = 1;
      }
    }
  }
  const a = cell;
  const b = cell * Math.SQRT2;
  const c = cell * Math.sqrt(5);
  // Forward mask (neighbours already visited in row-major order) and its mirror for the backward pass.
  const DI = [-1, -1, 0, 1, -2, 2, -1, 1];
  const DJ = [0, -1, -1, -1, -1, -1, -2, -2];
  const W = [a, b, a, b, c, c, c, c];
  const relax = (i: number, j: number, sign: number): void => {
    const s = j * nx + i;
    if (!free[s]) return;
    let best = d[s] as number;
    for (let k = 0; k < 8; k++) {
      const ii = i + sign * (DI[k] as number);
      const jj = j + sign * (DJ[k] as number);
      if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
      const v = (d[jj * nx + ii] as number) + (W[k] as number);
      if (v < best) best = v;
    }
    d[s] = best;
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) relax(i, j, 1);
  for (let j = ny - 1; j >= 0; j--) for (let i = nx - 1; i >= 0; i--) relax(i, j, -1);
  for (let s = 0; s < d.length; s++) d[s] = Math.min(cap, d[s] as number);
  return d;
}

function pushQuad(
  b: ChunkBuild, idx: number[], moss: number[] | null,
  x0: number, y0: number, n0x: number, n0y: number, x1: number, y1: number, n1x: number, n1y: number,
  kind: number, u0: number, u1: number, s0: number, s1: number, a0: number, a1: number,
): void {
  const base = b.edge.length / EDGE_STRIDE_FLOATS;
  const e = b.edge;
  edgeVertex(e, x0, y0, n0x, n0y, -1, kind, u0, a0, s0);
  edgeVertex(e, x0, y0, n0x, n0y, 1, kind, u0, a0, s0);
  edgeVertex(e, x1, y1, n1x, n1y, 1, kind, u1, a1, s1);
  edgeVertex(e, x1, y1, n1x, n1y, -1, kind, u1, a1, s1);
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  if (moss) moss.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/** One edge vertex: position, normal, aEdge (side, kind, up, stroke s), packed spill. */
function edgeVertex(
  e: Growable, x: number, y: number, nx: number, ny: number, side: number, kind: number, up: number, stroke: number, spill: number,
): void {
  e.push(x);
  e.push(y);
  e.push(nx);
  e.push(ny);
  e.push(side);
  e.push(kind);
  e.push(up);
  e.push(stroke);
  e.pushBits(spill);
}
