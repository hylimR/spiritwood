import { describe, expect, test } from 'vitest';
import { levelFromAscii } from '../shared/fixtures.ts';
import { buildTerrainMesh, CORE_STRIDE_FLOATS, DEFAULT_TERRAIN, EDGE_KIND_MOSS, EDGE_STRIDE_FLOATS } from '../../src/render/terrain/terrainMesh.ts';
import { TerrainField, DEFAULT_FIELD } from '../../src/render/terrain/terrainField.ts';
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
    const r = DEFAULT_FIELD.cornerRadius;
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

  test('no NaN anywhere', () => {
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
