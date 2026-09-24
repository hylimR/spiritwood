/**
 * Split hulls for alpha-mapped sprites (ARCHITECTURE.md §5.5): a column-strip decomposition of an
 * element's coverage into an opaque core (drawn in the depth pre-pass with blending off) and a soft
 * band (the remaining visible texels, drawn blended). Pure; works on a single-channel alpha map.
 */

export interface HullOptions {
  /** Column cell width in texels. */
  cell?: number;
  /** Max visible spans per column cell (the closest spans are merged beyond this). */
  maxSpans?: number;
  /**
   * Erosion radius (texels) applied to the α ≥ opaque region before it may become core. Use
   * ≥ 1 + 2^maxMip for mipmapped atlases so filtered edges never reach an opaque-pass texel.
   */
  coreInset?: number;
  /** Dilation (texels) of the visible region, so filtered (mip) fringes are not clipped. */
  pad?: number;
  /** A texel is visible when alpha > this byte value. */
  visibleThreshold?: number;
  /** A texel is opaque when alpha ≥ this byte value (254 ≈ 0.995). */
  opaqueThreshold?: number;
  /** Shortest core run worth splitting out, in texels. */
  minCore?: number;
  /** Visible spans separated by fewer rows than this are merged. */
  minGap?: number;
  /** Row quantum: visible spans snap outward and cores inward to multiples of it (more merging). */
  snap?: number;
}

/** Axis-aligned rects as flat [x0, y0, x1, y1, …] in element-local texels, half-open. */
export interface SplitHull {
  core: number[];
  soft: number[];
  coreArea: number;
  softArea: number;
}

const DEFAULTS: Required<HullOptions> = {
  cell: 8,
  maxSpans: 4,
  coreInset: 1,
  pad: 0,
  visibleThreshold: 1,
  opaqueThreshold: 254,
  minCore: 8,
  minGap: 4,
  snap: 2,
};

/**
 * One axis of a square morphology: a texel becomes `target` when a `target` texel lies within r
 * along the line (out-of-bounds counts as 0). Two linear sweeps track the distance to the nearest
 * `target` on either side, so the cost is O(n) regardless of r.
 */
function morphLine(src: Uint8Array, dst: Uint8Array, start: number, step: number, len: number, r: number, target: number): void {
  const far = r + 1;
  // Out-of-bounds is 0, so for erosion (target 0) the texel before the line is itself a target.
  let d = target === 0 ? 0 : far;
  for (let i = 0; i < len; i++) {
    const idx = start + i * step;
    d = src[idx] === target ? 0 : Math.min(far, d + 1);
    dst[idx] = d <= r ? target : 1 - target;
  }
  d = target === 0 ? 0 : far;
  for (let i = len - 1; i >= 0; i--) {
    const idx = start + i * step;
    d = src[idx] === target ? 0 : Math.min(far, d + 1);
    if (d <= r) dst[idx] = target;
  }
}

/** Separable square dilation (max) or erosion (min) of a 0/1 mask; out-of-bounds counts as 0. */
function morph(mask: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  if (r <= 0) return mask;
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const target = dilate ? 1 : 0;
  for (let y = 0; y < h; y++) morphLine(mask, tmp, y * w, 1, w, r, target);
  for (let x = 0; x < w; x++) morphLine(tmp, out, x, w, h, r, target);
  return out;
}

/** Rects of one column cell as flat [y0, y1, kind (0 soft, 1 core), x0]. */
function columnRects(
  vis: Uint8Array, core: Uint8Array, w: number, h: number, cx0: number, cx1: number, o: Required<HullOptions>, out: number[],
): void {
  const spans: number[] = [];
  let y = 0;
  while (y < h) {
    let any = false;
    for (let x = cx0; x < cx1; x++) if (vis[y * w + x] === 1) any = true;
    if (!any) {
      y++;
      continue;
    }
    const y0 = y;
    for (y++; y < h; y++) {
      let row = false;
      for (let x = cx0; x < cx1; x++) if (vis[y * w + x] === 1) row = true;
      if (!row) break;
    }
    const a = Math.max(0, Math.floor(y0 / o.snap) * o.snap);
    const b = Math.min(h, Math.ceil(y / o.snap) * o.snap);
    const n = spans.length;
    if (n > 0 && a - (spans[n - 1] as number) < o.minGap) spans[n - 1] = b;
    else spans.push(a, b);
  }
  while (spans.length > o.maxSpans * 2) {
    let best = 2;
    for (let i = 4; i < spans.length; i += 2) {
      if ((spans[i] as number) - (spans[i - 1] as number) < (spans[best] as number) - (spans[best - 1] as number)) best = i;
    }
    spans[best - 1] = spans[best + 1] as number;
    spans.splice(best, 2);
  }
  for (let s = 0; s < spans.length; s += 2) {
    const s0 = spans[s] as number;
    const s1 = spans[s + 1] as number;
    let bestA = 0;
    let bestB = 0;
    let yy = s0;
    while (yy < s1) {
      let full = true;
      for (let x = cx0; x < cx1; x++) if (core[yy * w + x] === 0) full = false;
      if (!full) {
        yy++;
        continue;
      }
      const a = yy;
      for (yy++; yy < s1; yy++) {
        let rowFull = true;
        for (let x = cx0; x < cx1; x++) if (core[yy * w + x] === 0) rowFull = false;
        if (!rowFull) break;
      }
      if (yy - a > bestB - bestA) {
        bestA = a;
        bestB = yy;
      }
    }
    bestA = Math.ceil(bestA / o.snap) * o.snap;
    bestB = Math.floor(bestB / o.snap) * o.snap;
    if (bestB - bestA >= o.minCore) {
      if (bestA > s0) out.push(s0, bestA, 0, cx0);
      out.push(bestA, bestB, 1, cx0);
      if (s1 > bestB) out.push(bestB, s1, 0, cx0);
    } else {
      out.push(s0, s1, 0, cx0);
    }
  }
}

function emit(out: SplitHull, x0: number, y0: number, x1: number, y1: number, kind: number): void {
  const area = (x1 - x0) * (y1 - y0);
  if (kind === 1) {
    out.core.push(x0, y0, x1, y1);
    out.coreArea += area;
  } else {
    out.soft.push(x0, y0, x1, y1);
    out.softArea += area;
  }
}

/**
 * Decompose `alpha` (w × h bytes, row-major) into core and soft rects. Invariants (tested): every
 * visible texel is covered by exactly one rect; core rects cover only eroded-opaque texels; rects
 * never overlap; equal rects in adjacent columns are merged horizontally.
 */
export function computeSplitHull(alpha: Uint8Array, w: number, h: number, options: HullOptions = {}): SplitHull {
  const o: Required<HullOptions> = { ...DEFAULTS, ...options };
  const n = w * h;
  const visible = new Uint8Array(n);
  const opaque = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = alpha[i] as number;
    visible[i] = a > o.visibleThreshold ? 1 : 0;
    opaque[i] = a >= o.opaqueThreshold ? 1 : 0;
  }
  const vis = morph(visible, w, h, o.pad, true);
  const core = morph(opaque, w, h, o.coreInset, false);

  const out: SplitHull = { core: [], soft: [], coreArea: 0, softArea: 0 };
  let open: number[] = [];
  const cols = Math.ceil(w / o.cell);
  for (let c = 0; c <= cols; c++) {
    const cx0 = Math.min(w, c * o.cell);
    const next: number[] = [];
    if (c < cols) columnRects(vis, core, w, h, cx0, Math.min(w, cx0 + o.cell), o, next);
    // Extend open rects whose (y0, y1, kind) reappear in this column; flush the rest at cx0.
    for (let i = 0; i < open.length; i += 4) {
      let continued = false;
      for (let j = 0; j < next.length; j += 4) {
        if (next[j] === open[i] && next[j + 1] === open[i + 1] && next[j + 2] === open[i + 2] && next[j + 3] === cx0) {
          next[j + 3] = open[i + 3] as number;
          continued = true;
          break;
        }
      }
      if (!continued) emit(out, open[i + 3] as number, open[i] as number, cx0, open[i + 1] as number, open[i + 2] as number);
    }
    open = next;
  }
  return out;
}

/** Split rects at a global row grid (multiples of `step`), so vertex sway bends them smoothly. */
export function subdivideRows(rects: readonly number[], step: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < rects.length; i += 4) {
    const x0 = rects[i] as number;
    const y1 = rects[i + 3] as number;
    const x1 = rects[i + 2] as number;
    let a = rects[i + 1] as number;
    while (a < y1) {
      const b = Math.min(y1, (Math.floor(a / step) + 1) * step);
      out.push(x0, a, x1, b);
      a = b;
    }
  }
  return out;
}

/** Split rects that straddle row `y` into the parts above and below it. */
export function splitRowsAt(rects: readonly number[], y: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < rects.length; i += 4) {
    const x0 = rects[i] as number;
    const y0 = rects[i + 1] as number;
    const x1 = rects[i + 2] as number;
    const y1 = rects[i + 3] as number;
    if (y0 < y && y1 > y) out.push(x0, y0, x1, y, x0, y, x1, y1);
    else out.push(x0, y0, x1, y1);
  }
  return out;
}

/**
 * computeSplitHull on a conservatively 2×-downsampled map (4× cheaper): a block is visible if any
 * texel is visible and opaque only if all are, so the invariants still hold at full resolution;
 * rect edges land on even texels. Insets and pads are rounded up to whole blocks.
 */
export function computeSplitHullHalf(alpha: Uint8Array, w: number, h: number, options: HullOptions = {}): SplitHull {
  const o: Required<HullOptions> = { ...DEFAULTS, ...options };
  const hw = Math.ceil(w / 2);
  const hh = Math.ceil(h / 2);
  const half = new Uint8Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      let vis = false;
      let opaque = true;
      for (let j = 0; j < 2; j++) {
        const yy = y * 2 + j;
        for (let i = 0; i < 2; i++) {
          const xx = x * 2 + i;
          const a = xx < w && yy < h ? (alpha[yy * w + xx] as number) : 0;
          if (a > o.visibleThreshold) vis = true;
          if (a < o.opaqueThreshold) opaque = false;
        }
      }
      half[y * hw + x] = opaque ? 255 : vis ? 128 : 0;
    }
  }
  const r = computeSplitHull(half, hw, hh, {
    cell: Math.max(1, Math.round(o.cell / 2)),
    maxSpans: o.maxSpans,
    coreInset: Math.ceil(o.coreInset / 2),
    pad: Math.ceil(o.pad / 2),
    visibleThreshold: 64,
    opaqueThreshold: 255,
    minCore: Math.max(1, Math.ceil(o.minCore / 2)),
    minGap: Math.max(1, Math.ceil(o.minGap / 2)),
    snap: Math.max(1, Math.round(o.snap / 2)),
  });
  const scale = (rects: number[]): number[] => rects.map((v, i) => Math.min(i % 2 === 0 ? w : h, v * 2));
  const core = scale(r.core);
  const soft = scale(r.soft);
  const area = (rects: number[]): number => {
    let a = 0;
    for (let i = 0; i < rects.length; i += 4) a += ((rects[i + 2] as number) - (rects[i] as number)) * ((rects[i + 3] as number) - (rects[i + 1] as number));
    return a;
  };
  return { core, soft, coreArea: area(core), softArea: area(soft) };
}
