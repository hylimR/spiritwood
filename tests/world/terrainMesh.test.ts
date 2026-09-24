import { describe, expect, test } from 'vitest';
import { levelFromAscii } from '../shared/fixtures.ts';
import { buildTerrainMesh, CORE_STRIDE_FLOATS, DEFAULT_TERRAIN, EDGE_KIND_MOSS, EDGE_STRIDE_FLOATS } from '../../src/render/terrain/terrainMesh.ts';
import { TerrainField, DEFAULT_FIELD, FLOOR_TOLERANCE, WALL_TOLERANCE } from '../../src/render/terrain/terrainField.ts';
import { TERRAIN_LIGHTS } from '../../src/render/terrain/terrainLight.ts';
import { AA_MAX_UNITS, AA_PX, terrainAAWidth } from '../../src/render/terrain/terrainView.ts';

/** An island level: every border tile empty, so the whole solid area is inside the mesh domain. */
const ISLAND = [
  '..............................',
  '..............................',
  '....#####.............####....',
  '....#####.............####....',
  '......................####....',
  '..........########....####....',
  '..........########............',
  '..........###..###............',
  '..........###..###.....=====..',
  '...........^^^^^^.............',
  '..............................',
  '..............................',
];

function meshArea(mesh: ReturnType<typeof buildTerrainMesh>): number {
  let a = 0;
  for (const c of mesh.chunks) a += c.coreArea;
  return a;
}

describe('terrain field', () => {
  const level = levelFromAscii(ISLAND);
  const field = new TerrainField(level);
  const T = level.tileSize;

  test('sign: inside solid tiles negative, outside positive', () => {
    expect(field.base(4.5 * T, 2.5 * T)).toBeLessThan(0);
    expect(field.base(1.5 * T, 1.5 * T)).toBeGreaterThan(0);
    // One-way and thorn tiles are not terrain.
    expect(field.base(24.5 * T, 8.5 * T)).toBeGreaterThan(0);
    expect(field.base(12.5 * T, 9.5 * T)).toBeGreaterThan(0);
  });

  test('distance is exact along flat faces', () => {
    // Left face of the block at columns 4..8, rows 2..3: x = 4T.
    expect(field.base(4 * T - 5, 2.5 * T)).toBeCloseTo(5, 4);
    expect(field.base(4 * T + 7, 3 * T)).toBeCloseTo(-7, 4);
  });

  test('convex corners are rounded, concave corners stay sharp', () => {
    const r = field.cornerRadiusAt(4, 2, 1);
    expect(r).toBeGreaterThanOrEqual(DEFAULT_FIELD.cornerRadius);
    expect(r).toBeLessThanOrEqual(DEFAULT_FIELD.cornerRadius + DEFAULT_FIELD.cornerJitter);
    // Convex top-left corner of the block at (4T, 2T): the corner point is outside by (√2 − 1)·r.
    expect(field.base(4 * T, 2 * T)).toBeCloseTo((Math.SQRT2 - 1) * r, 3);
    // Concave corner inside the U at (13T, 7T) (solid left/right of the gap): exactly on the surface.
    expect(Math.abs(field.base(13 * T, 7 * T))).toBeLessThan(1e-6);
  });

  test('floor displacement stays within the flat-top tolerance', () => {
    for (let x = 10.2 * T; x < 17.8 * T; x += 3) {
      // Scan down to the zero crossing on the top face of the 8-wide block at row 5.
      let y = 5 * T - 12;
      while (field.sample(x, y) > 0 && y < 5 * T + 12) y += 0.25;
      expect(Math.abs(y - 5 * T)).toBeLessThanOrEqual(2);
    }
  });
});

describe('buildTerrainMesh', () => {
  const level = levelFromAscii(ISLAND);
  const mesh = buildTerrainMesh(level);
  const T = level.tileSize;

  test('no NaN anywhere (the packed spill slot is always a finite float)', () => {
    for (const c of mesh.chunks) {
      for (const v of c.core) expect(Number.isFinite(v)).toBe(true);
      for (const v of c.edge) expect(Number.isFinite(v)).toBe(true);
    }
    for (const c of mesh.contours) {
      for (const v of c.points) expect(Number.isFinite(v)).toBe(true);
      for (const v of c.normals) expect(Number.isFinite(v)).toBe(true);
    }
  });

  test('core area ≈ solid tile area (±3%)', () => {
    let solid = 0;
    for (const t of level.tiles) if (t === 1) solid++;
    const expected = solid * T * T;
    expect(Math.abs(meshArea(mesh) - expected) / expected).toBeLessThan(0.03);
  });

  test('contours are closed loops, one per island, with outward normals', () => {
    expect(mesh.contours.length).toBe(3);
    for (const c of mesh.contours) {
      const n = c.points.length / 2;
      expect(n).toBeGreaterThan(8);
      // Closed: consecutive points (including last → first) are one cell or less apart.
      for (let k = 0; k < n; k++) {
        const k1 = (k + 1) % n;
        const d = Math.hypot((c.points[k1 * 2] as number) - (c.points[k * 2] as number), (c.points[k1 * 2 + 1] as number) - (c.points[k * 2 + 1] as number));
        expect(d).toBeLessThanOrEqual(DEFAULT_TERRAIN.cell * Math.SQRT2 + 1e-3);
      }
      // Normals point outside: the field increases along them.
      for (let k = 0; k < n; k += 3) {
        const x = c.points[k * 2] as number;
        const y = c.points[k * 2 + 1] as number;
        const nx = c.normals[k * 2] as number;
        const ny = c.normals[k * 2 + 1] as number;
        const l = Math.hypot(nx, ny);
        expect(mesh.field.sample(x + (nx / l) * 3, y + (ny / l) * 3)).toBeGreaterThan(mesh.field.sample(x - (nx / l) * 3, y - (ny / l) * 3));
      }
    }
  });

  test('contour vertices lie on the surface (within the SDF band)', () => {
    for (const c of mesh.contours) {
      for (let k = 0; k < c.points.length / 2; k++) {
        expect(Math.abs(mesh.field.sample(c.points[k * 2] as number, c.points[k * 2 + 1] as number))).toBeLessThan(0.5);
      }
    }
  });

  test('core vertices are inside or on the surface; depth attribute matches the field', () => {
    for (const c of mesh.chunks) {
      for (let v = 0; v < c.core.length; v += CORE_STRIDE_FLOATS) {
        const f = mesh.field.sample(c.core[v] as number, c.core[v + 1] as number);
        expect(f).toBeLessThan(0.5);
        expect(c.core[v + 2]).toBeCloseTo(Math.min(DEFAULT_TERRAIN.shadeDepth, Math.max(0, -f)), 1);
      }
    }
  });

  test('moss grows only on up-facing edges', () => {
    let mossVerts = 0;
    for (const c of mesh.chunks) {
      for (let v = 0; v < c.edge.length; v += EDGE_STRIDE_FLOATS) {
        if (c.edge[v + 5] !== EDGE_KIND_MOSS) continue;
        mossVerts++;
        const ny = c.edge[v + 3] as number;
        const nx = c.edge[v + 2] as number;
        // At least one end of a moss quad faces up; individual corner vertices may bend away.
        expect(-ny / Math.hypot(nx, ny)).toBeGreaterThan(-0.5);
      }
      expect(c.mossIndices.length).toBeLessThanOrEqual(c.edgeIndices.length);
    }
    expect(mossVerts).toBeGreaterThan(0);
  });

  test('indices stay in range and fit Uint16', () => {
    for (const c of mesh.chunks) {
      const nCore = c.core.length / CORE_STRIDE_FLOATS;
      const nEdge = c.edge.length / EDGE_STRIDE_FLOATS;
      expect(nCore).toBeLessThanOrEqual(65535);
      for (const i of c.coreIndices) expect(i).toBeLessThan(nCore);
      for (const i of c.edgeIndices) expect(i).toBeLessThan(nEdge);
    }
  });

  test('is deterministic', () => {
    const again = buildTerrainMesh(level);
    expect(again.chunks.length).toBe(mesh.chunks.length);
    for (let i = 0; i < mesh.chunks.length; i++) {
      expect(again.chunks[i]?.core).toEqual(mesh.chunks[i]?.core);
      expect(again.chunks[i]?.edge).toEqual(mesh.chunks[i]?.edge);
    }
  });

  test('chunks follow the 16-tile grid and a full-size level stays within budgets', () => {
    const rows: string[] = [];
    for (let y = 0; y < 50; y++) {
      let r = '';
      for (let x = 0; x < 200; x++) r += y > 40 + Math.round(Math.sin(x * 0.2) * 2) || (x % 23 < 4 && y > 20 && y < 24) ? '#' : '.';
      rows.push(r);
    }
    const big = levelFromAscii(rows);
    const m = buildTerrainMesh(big);
    const chunkSize = DEFAULT_TERRAIN.chunkTiles * big.tileSize;
    for (const c of m.chunks) {
      expect(c.bounds.x0).toBeGreaterThanOrEqual(c.col * chunkSize - DEFAULT_TERRAIN.cell - DEFAULT_TERRAIN.mossIn - 1);
      expect(c.bounds.x1).toBeLessThanOrEqual((c.col + 1) * chunkSize + DEFAULT_TERRAIN.cell + DEFAULT_TERRAIN.mossIn + 1);
    }
  });
});

describe('terrainAAWidth', () => {
  test('about AA_PX device pixels in world units, tracking render scale and zoom', () => {
    expect(terrainAAWidth(1, 1)).toBeCloseTo(AA_PX, 9);
    expect(terrainAAWidth(0.5, 1)).toBeCloseTo(AA_PX * 2, 9);
    expect(terrainAAWidth(1, 2)).toBeCloseTo(AA_PX / 2, 9);
  });

  test('stays a thin strip for degenerate inputs (no full-screen smear before the first resize)', () => {
    for (const ppu of [0, -1, Number.NaN, 1e-6]) {
      const aa = terrainAAWidth(ppu, 1);
      expect(Number.isFinite(aa)).toBe(true);
      expect(aa).toBeLessThanOrEqual(AA_MAX_UNITS);
      expect(aa).toBeGreaterThan(0);
    }
  });
});

/** Every crossing of the meshed outline with the vertical line x = X (or horizontal line y = Y). */
function crossings(mesh: ReturnType<typeof buildTerrainMesh>, axis: 'x' | 'y', at: number): number[] {
  const out: number[] = [];
  for (const c of mesh.contours) {
    const n = c.points.length / 2;
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      const ax = c.points[k * 2] as number;
      const ay = c.points[k * 2 + 1] as number;
      const bx = c.points[k1 * 2] as number;
      const by = c.points[k1 * 2 + 1] as number;
      const [a0, a1, b0, b1] = axis === 'x' ? [ax, bx, ay, by] : [ay, by, ax, bx];
      if ((a0 <= at && a1 > at) || (a1 <= at && a0 > at)) out.push(b0 + ((at - a0) / (a1 - a0)) * (b1 - b0));
    }
  }
  return out;
}

describe('terrain outline stays honest to the collision', () => {
  // Rolling floors, a floating platform, a tall wall with a ledge, an overhang: every border tile empty.
  const ROWS = [
    '................................',
    '................................',
    '..........######................',
    '..........######.......###......',
    '.......................###......',
    '..###.................####......',
    '..###..........#########........',
    '..###..######..#########........',
    '..###..######..###..............',
    '..###..######..###..............',
    '..########################......',
    '..########################......',
    '................................',
  ];
  const level = levelFromAscii(ROWS);
  const mesh = buildTerrainMesh(level);
  const field = mesh.field;
  const T = level.tileSize;
  const solid = (tx: number, ty: number): boolean => field.isSolid(tx, ty);
  const nearest = (list: number[], v: number): number => list.reduce((b, c) => (Math.abs(c - v) < Math.abs(b - v) ? c : b), Infinity);

  test('walkable tops stay within ±FLOOR_TOLERANCE of the tile top away from convex corners', () => {
    let checked = 0;
    for (let ty = 1; ty < level.heightTiles; ty++) {
      for (let tx = 0; tx < level.widthTiles; tx++) {
        if (!solid(tx, ty) || solid(tx, ty - 1)) continue;
        const top = ty * T;
        // Convex corners round off over their radius; concave ones blend into the wall over a few units.
        const left = !solid(tx - 1, ty) ? field.cornerRadiusAt(tx, ty, 1) + 2 : solid(tx - 1, ty - 1) ? 6 : 0;
        const right = !solid(tx + 1, ty) ? field.cornerRadiusAt(tx, ty, 2) + 2 : solid(tx + 1, ty - 1) ? 6 : 0;
        for (let x = tx * T + left; x <= (tx + 1) * T - right; x += 2) {
          const y = nearest(crossings(mesh, 'x', x + 0.01), top);
          expect(Math.abs(y - top), `floor at x ${x}`).toBeLessThanOrEqual(FLOOR_TOLERANCE);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  test('walls stay within ±WALL_TOLERANCE of the tile face away from corners', () => {
    let checked = 0;
    for (let ty = 0; ty < level.heightTiles; ty++) {
      for (let tx = 0; tx < level.widthTiles; tx++) {
        if (!solid(tx, ty)) continue;
        for (const side of [-1, 1] as const) {
          if (solid(tx + side, ty)) continue;
          const face = side < 0 ? tx * T : (tx + 1) * T;
          const topBit = side < 0 ? 1 : 2;
          const botBit = side < 0 ? 4 : 8;
          const top = !solid(tx, ty - 1) ? field.cornerRadiusAt(tx, ty, topBit) + 2 : solid(tx + side, ty - 1) ? 6 : 0;
          const bot = !solid(tx, ty + 1) ? field.cornerRadiusAt(tx, ty, botBit) + 2 : solid(tx + side, ty + 1) ? 6 : 0;
          for (let y = ty * T + top; y <= (ty + 1) * T - bot; y += 3) {
            const x = nearest(crossings(mesh, 'y', y + 0.01), face);
            expect(Math.abs(x - face), `wall at y ${y}`).toBeLessThanOrEqual(WALL_TOLERANCE);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
  });

  test('undersides are free to hang lower (drips), but stay within their bounds', () => {
    let maxDrop = 0;
    for (let tx = 16; tx < 25; tx++) {
      for (let x = tx * T; x < (tx + 1) * T; x += 2) {
        // Underside of the overhang block (rows 6..7) at y = 8T.
        const y = nearest(crossings(mesh, 'x', x + 0.01), 8 * T);
        const corner = DEFAULT_FIELD.underRadius + DEFAULT_FIELD.underJitter + 4;
        if (!Number.isFinite(y) || x < 18 * T + 12 || x > 24 * T - corner) continue;
        maxDrop = Math.max(maxDrop, y - 8 * T);
        expect(y - 8 * T).toBeGreaterThan(-(DEFAULT_FIELD.underAmp + DEFAULT_FIELD.dispAmp + 1));
        expect(y - 8 * T).toBeLessThan(DEFAULT_FIELD.dripLen + DEFAULT_FIELD.underAmp + DEFAULT_FIELD.dispAmp + 1);
      }
    }
    expect(maxDrop).toBeGreaterThan(4);
  });
});

describe('terrain baked light', () => {
  test('core vertices carry a moon-facing factor and finite packed spill; lanterns warm nearby vertices', () => {
    const rows = ['......................', '......................', '......................', '..................#...', '######################', '######################'];
    const level = levelFromAscii(rows);
    level.decorHints.push({ id: 0, kind: 'lantern', x: 5 * 48, y: 4 * 48 });
    const mesh = buildTerrainMesh(level);
    let warmNear = 0;
    let warmFar = 0;
    let litTop = 0;
    for (const c of mesh.chunks) {
      const u32 = new Uint32Array(c.core.buffer, c.core.byteOffset, c.core.length);
      for (let v = 0; v < c.core.length; v += CORE_STRIDE_FLOATS) {
        for (let k = 0; k < CORE_STRIDE_FLOATS; k++) expect(Number.isFinite(c.core[v + k])).toBe(true);
        const lit = c.core[v + 3] as number;
        expect(lit).toBeGreaterThanOrEqual(0);
        expect(lit).toBeLessThanOrEqual(1);
        const x = c.core[v] as number;
        const y = c.core[v + 1] as number;
        if (Math.abs(y - 4 * 48) < 1 && x > 48 && x < 15 * 48) litTop = Math.max(litTop, lit);
        const warm = ((u32[v + 4] as number) & 255) / 255;
        const d = Math.hypot(x - 5 * 48, y - (4 * 48 + TERRAIN_LIGHTS.lantern.dy));
        if (d < 150) warmNear = Math.max(warmNear, warm);
        if (d > TERRAIN_LIGHTS.lantern.radius + 20) warmFar = Math.max(warmFar, warm);
      }
    }
    expect(litTop).toBeGreaterThan(0.7);
    expect(warmNear).toBeGreaterThan(0.2);
    expect(warmFar).toBe(0);
  });
});
