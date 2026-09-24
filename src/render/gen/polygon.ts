/** Signed area of a polygon given as flat x,y pairs (positive = counter-clockwise in y-up axes). */
export function polygonArea(p: readonly number[]): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (p[j * 2] as number) * (p[i * 2 + 1] as number) - (p[i * 2] as number) * (p[j * 2 + 1] as number);
  }
  return a / 2;
}

function pointInTri(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Ear-clipping triangulation of a simple polygon (flat x,y pairs, either winding). Returns vertex
 * indices, three per triangle. Repeated points and collinear runs (common in traced hulls) are
 * tolerated: duplicates are skipped, points coincident with an ear's corners do not block it, and a
 * stalled pass drops a degenerate (zero-area) corner, so the triangles always cover the polygon.
 * O(n²), fine for hull polygons of a few hundred points.
 */
export function triangulate(p: readonly number[]): number[] {
  const n = p.length / 2;
  if (n < 3) return [];
  const ccw = polygonArea(p) > 0;
  const idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const i = ccw ? k : n - 1 - k;
    const last = idx[idx.length - 1];
    if (last !== undefined && p[last * 2] === p[i * 2] && p[last * 2 + 1] === p[i * 2 + 1]) continue;
    idx.push(i);
  }
  while (idx.length > 1) {
    const a = idx[0] as number;
    const z = idx[idx.length - 1] as number;
    if (p[a * 2] !== p[z * 2] || p[a * 2 + 1] !== p[z * 2 + 1]) break;
    idx.pop();
  }
  const out: number[] = [];
  const cross = (ia: number, ib: number, ic: number): number => {
    const ax = p[ia * 2] as number;
    const ay = p[ia * 2 + 1] as number;
    return ((p[ib * 2] as number) - ax) * ((p[ic * 2 + 1] as number) - ay) - ((p[ib * 2 + 1] as number) - ay) * ((p[ic * 2] as number) - ax);
  };
  const same = (i: number, j: number): boolean => p[i * 2] === p[j * 2] && p[i * 2 + 1] === p[j * 2 + 1];
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length] as number;
      const ib = idx[i] as number;
      const ic = idx[(i + 1) % idx.length] as number;
      if (cross(ia, ib, ic) <= 0) continue;
      const ax = p[ia * 2] as number;
      const ay = p[ia * 2 + 1] as number;
      const bx = p[ib * 2] as number;
      const by = p[ib * 2 + 1] as number;
      const cx = p[ic * 2] as number;
      const cy = p[ic * 2 + 1] as number;
      let inside = false;
      for (let k = 0; k < idx.length; k++) {
        const ik = idx[k] as number;
        if (ik === ia || ik === ib || ik === ic || same(ik, ia) || same(ik, ib) || same(ik, ic)) continue;
        if (pointInTri(p[ik * 2] as number, p[ik * 2 + 1] as number, ax, ay, bx, by, cx, cy)) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (clipped) continue;
    // Stalled: remove a degenerate corner (collinear or a zero-length spike) that no ear can take.
    let dropped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length] as number;
      const ib = idx[i] as number;
      const ic = idx[(i + 1) % idx.length] as number;
      if (cross(ia, ib, ic) === 0) {
        idx.splice(i, 1);
        dropped = true;
        break;
      }
    }
    if (!dropped) break;
  }
  if (idx.length === 3 && cross(idx[0] as number, idx[1] as number, idx[2] as number) !== 0) {
    out.push(idx[0] as number, idx[1] as number, idx[2] as number);
  }
  return out;
}
