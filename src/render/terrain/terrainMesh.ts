import type { LevelData } from '../../contracts/level.ts';
import type { Extent } from '../util/camera.ts';
import { TerrainField, type TerrainFieldOptions } from './terrainField.ts';

/**
 * Terrain meshing (ARCHITECTURE.md §5.5), pure: marching squares over the terrain field on a
 * `cell`-unit grid offset by half a cell from the tile grid (tile corners fall on cell centres, so
 * rounded corners are sampled well), producing per-chunk core triangles with a depth-inside
 * attribute, closed contours with outward normals and an up-facing factor, and per-chunk edge strips
 * (AA feather + moss rim on up-facing edges).
 */
export interface TerrainMeshOptions {
  cell: number;
  /** Chunk size in tiles. */
  chunkTiles: number;
  /** Geometry extends this far beyond the level (u), for screen shake. */
  margin: number;
  /** Depth-inside attribute clamp (u): the core shading gradient spans this range. */
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
  shadeDepth: 60,
  mossIn: 9,
  mossOut: 3,
  mossMinUp: 0.3,
  field: {},
};

/** Edge vertex: aPosition (2), aNormal (2), aEdge (side −1..1, kind 0 AA / 1 moss, up 0..1, 0). */
export const EDGE_STRIDE_FLOATS = 8;
export const CORE_STRIDE_FLOATS = 3;
export const EDGE_KIND_AA = 0;
export const EDGE_KIND_MOSS = 1;

export interface TerrainChunk {
  col: number;
  row: number;
  bounds: Extent;
  /** Interleaved aPosition (2) + aDist (1: depth inside, u). */
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

class Growable {
  data: Float32Array;
  length = 0;
  constructor(cap: number) {
    this.data = new Float32Array(cap);
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Float32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
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
  level: Pick<LevelData, 'widthTiles' | 'heightTiles' | 'tiles' | 'tileSize' | 'pxWidth' | 'pxHeight' | 'seed'>,
  options: Partial<TerrainMeshOptions> = {},
): TerrainMesh {
  const o: TerrainMeshOptions = { ...DEFAULT_TERRAIN, ...options };
  const field = new TerrainField(level, { seed: level.seed, ...o.field });
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
      for (let k = 0; k < 4; k++) {
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

  const clampDepth = (v: number): number => Math.min(o.shadeDepth, Math.max(0, -v));
  // Vertex keys: corners 2·s (even), crossings 2·edgeId + 1 (odd).
  const coreVertex = (b: ChunkBuild, key: number, x: number, y: number, depth: number): number => {
    let v = b.coreMap.get(key);
    if (v === undefined) {
      v = b.core.length / CORE_STRIDE_FLOATS;
      b.core.push(x);
      b.core.push(y);
      b.core.push(depth);
      b.coreMap.set(key, v);
      grow(b.bounds, x, y);
    }
    return v;
  };
  const polyX: number[] = [];
  const polyY: number[] = [];
  const polyV: number[] = [];
  const emitPoly = (b: ChunkBuild): void => {
    const n = polyV.length;
    for (let k = 1; k < n - 1; k++) {
      b.coreIdx.push(polyV[0] as number, polyV[k] as number, polyV[k + 1] as number);
      const ax = polyX[0] as number;
      const ay = polyY[0] as number;
      b.coreArea += Math.abs(((polyX[k] as number) - ax) * ((polyY[k + 1] as number) - ay) - ((polyX[k + 1] as number) - ax) * ((polyY[k] as number) - ay)) / 2;
    }
    polyX.length = 0;
    polyY.length = 0;
    polyV.length = 0;
  };
  const addCorner = (b: ChunkBuild, i: number, j: number): void => {
    const s = j * nx + i;
    const x = gx0 + i * C;
    const y = gy0 + j * C;
    polyX.push(x);
    polyY.push(y);
    polyV.push(coreVertex(b, 2 * s, x, y, clampDepth(f[s] as number)));
  };
  const addCross = (b: ChunkBuild, id: number): void => {
    crossing(id);
    const x = crossX.get(id) as number;
    const y = crossY.get(id) as number;
    polyX.push(x);
    polyY.push(y);
    polyV.push(coreVertex(b, 2 * id + 1, x, y, 0));
  };

  // Directed contour segments: next[fromEdge] = toEdge.
  const next = new Map<number, number>();
  const segCell = new Map<number, number>();
  const cornerDI = [0, 1, 1, 0];
  const cornerDJ = [0, 0, 1, 1];

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const f00 = f[j * nx + i] as number;
      const f10 = f[j * nx + i + 1] as number;
      const f11 = f[(j + 1) * nx + i + 1] as number;
      const f01 = f[(j + 1) * nx + i] as number;
      const code = (f00 < 0 ? 1 : 0) | (f10 < 0 ? 2 : 0) | (f11 < 0 ? 4 : 0) | (f01 < 0 ? 8 : 0);
      if (code === 0) continue;
      const b = chunkOf(i, j);
      if (code === 15) {
        for (let c = 0; c < 4; c++) addCorner(b, i + (cornerDI[c] as number), j + (cornerDJ[c] as number));
        emitPoly(b);
        continue;
      }
      let segs = SEGMENTS[code] as readonly number[];
      let joined = false;
      if (code === 5 || code === 10) {
        // Saddle: resolve with the field at the cell centre.
        const centre = field.sample(gx0 + (i + 0.5) * C, gy0 + (j + 0.5) * C);
        joined = centre < 0;
        if (joined) segs = code === 5 ? [3, 2, 1, 0] : [0, 3, 2, 1];
      }
      for (let s = 0; s < segs.length; s += 2) {
        const a = edgeId(i, j, segs[s] as number);
        const z = edgeId(i, j, segs[s + 1] as number);
        next.set(a, z);
        segCell.set(a, j * nx + i);
      }
      // Inside polygon(s): walk corners 0..3 with the crossing on each edge after its start corner.
      if ((code === 5 || code === 10) && !joined) {
        for (let c = 0; c < 4; c++) {
          if (!(code & (1 << c))) continue;
          addCross(b, edgeId(i, j, (c + 3) % 4));
          addCorner(b, i + (cornerDI[c] as number), j + (cornerDJ[c] as number));
          addCross(b, edgeId(i, j, c));
          emitPoly(b);
        }
      } else {
        for (let c = 0; c < 4; c++) {
          const inside = (code & (1 << c)) !== 0;
          const nextInside = (code & (1 << ((c + 1) % 4))) !== 0;
          if (inside) addCorner(b, i + (cornerDI[c] as number), j + (cornerDJ[c] as number));
          if (inside !== nextInside) addCross(b, edgeId(i, j, c));
        }
        emitPoly(b);
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
  for (const loop of loops) {
    const n = loop.length;
    const points = new Float32Array(n * 2);
    const normals = new Float32Array(n * 2);
    const up = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const id = loop[k] as number;
      crossing(id);
      points[k * 2] = crossX.get(id) as number;
      points[k * 2 + 1] = crossY.get(id) as number;
    }
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
    contours.push({ points, normals, up });
    // Edge strips: each segment goes to the chunk of the cell that produced it.
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
      pushQuad(b, b.edgeIdx, null, x0, y0, n0x, n0y, x1, y1, n1x, n1y, EDGE_KIND_AA, u0, u1);
      if (Math.max(u0, u1) >= o.mossMinUp) {
        pushQuad(b, b.edgeIdx, b.mossIdx, x0, y0, n0x, n0y, x1, y1, n1x, n1y, EDGE_KIND_MOSS, u0, u1);
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

function pushQuad(
  b: ChunkBuild, idx: number[], moss: number[] | null,
  x0: number, y0: number, n0x: number, n0y: number, x1: number, y1: number, n1x: number, n1y: number,
  kind: number, u0: number, u1: number,
): void {
  const base = b.edge.length / EDGE_STRIDE_FLOATS;
  const e = b.edge;
  const vert = (x: number, y: number, nx: number, ny: number, side: number, up: number): void => {
    e.push(x);
    e.push(y);
    e.push(nx);
    e.push(ny);
    e.push(side);
    e.push(kind);
    e.push(up);
    e.push(0);
  };
  vert(x0, y0, n0x, n0y, -1, u0);
  vert(x0, y0, n0x, n0y, 1, u0);
  vert(x1, y1, n1x, n1y, 1, u1);
  vert(x1, y1, n1x, n1y, -1, u1);
  idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  if (moss) moss.push(base, base + 1, base + 2, base, base + 2, base + 3);
}
