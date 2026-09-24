import { Rng } from '../../src/core/rng.ts';
import { NoiseTable } from '../../src/render/gen/noiseTable.ts';
import { ElementRaster, Mat } from '../../src/render/gen/raster.ts';

/**
 * CPU painter for the demo plate: a painterly, misty treeline in straight-alpha RGBA. Two rows of
 * trees (a lighter, hazier back row and a darker front row) with brushy edges, moonlit upper-left
 * rims, soft vertical colour drift and a base that dissolves into mist.
 */
export interface PlateImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function hex(c: number): [number, number, number] {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

function crown(r: ElementRaster, rng: Rng, cx: number, cy: number, rx: number, ry: number, clumps: number): void {
  r.ellipse(cx, cy, rx * 0.62, ry * 0.62, Mat.Leaf, 8);
  for (let i = 0; i < clumps; i++) {
    const a = rng.range(0, Math.PI * 2);
    const d = Math.pow(rng.next(), 0.45) * 0.82;
    const s = rng.range(0.12, 0.24) * (rx + ry) * 0.5;
    r.ellipse(cx + Math.cos(a) * rx * d, cy + Math.sin(a) * ry * d, s, s * 0.85, Mat.Leaf, 4);
  }
}

/** Plant one row of trees on `base` into raster `r`. */
function treeRow(r: ElementRaster, rng: Rng, base: number, minH: number, maxH: number, spacing: number): void {
  let x = -rng.range(0, spacing);
  while (x < r.w + spacing) {
    const h = rng.range(minH, maxH);
    const kind = rng.next();
    if (kind < 0.45) {
      // Cloud-crowned tree.
      const cy = base - h * rng.range(0.62, 0.72);
      r.capsule(x, base + 30, x + rng.range(-8, 8), cy, h * 0.022, h * 0.01, Mat.Bark, 3);
      crown(r, rng, x, cy, h * rng.range(0.18, 0.26), h * rng.range(0.26, 0.34), 26);
    } else if (kind < 0.8) {
      // Spire.
      r.capsule(x, base + 30, x, base - h, h * 0.016, 1.5, Mat.Bark, 2);
      const tiers = 12;
      for (let i = 0; i < tiers; i++) {
        const t = (i + 0.5) / tiers;
        const y = base - h + t * h * 0.78;
        const hw = 4 + h * 0.13 * t;
        r.ellipse(x, y + 6, hw, 5 + 7 * t, Mat.Leaf, 5);
      }
    } else {
      // Low rounded mass (undergrowth / young trees).
      crown(r, rng, x, base - h * 0.28, h * rng.range(0.22, 0.3), h * rng.range(0.2, 0.26), 20);
    }
    x += spacing * rng.range(0.55, 1.35);
  }
}

/** A continuous, lumpy thicket along the base: the plate's solid band (its opaque core). */
function undergrowth(r: ElementRaster, rng: Rng, base: number): void {
  // Reaches below the start of the mist fade so the base dissolves instead of ending in an edge.
  r.capsule(-200, base + 150, r.w + 200, base + 150, 170, 170, Mat.Leaf, 6);
  for (let x = -30; x < r.w + 60; x += rng.range(26, 48)) {
    const s = rng.range(26, 58);
    r.ellipse(x, base - 20 - s * 0.4, s, s * 0.8, Mat.Leaf, 5);
  }
}

export function paintTreeline(width: number, height: number, seed: number): PlateImage {
  const noise = new NoiseTable(seed ^ 0x9a17, 5, 4);
  const rows = [
    { base: height * 0.6, minH: height * 0.26, maxH: height * 0.42, spacing: 70, top: 0x1c4058, low: 0x2a5872, rim: 0.22 },
    { base: height * 0.66, minH: height * 0.2, maxH: height * 0.36, spacing: 56, top: 0x10263a, low: 0x1d4660, rim: 0.34 },
  ];
  const out = new Float32Array(width * height * 4);
  const rimColor = hex(0x9fdcec);
  rows.forEach((row, ri) => {
    const r = new ElementRaster(width, height, noise, 11 + ri * 7);
    const rng = new Rng(seed + ri * 101);
    treeRow(r, rng, row.base, row.minH, row.maxH, row.spacing);
    if (ri === rows.length - 1) undergrowth(r, rng, row.base);
    const top = hex(row.top);
    const low = hex(row.low);
    const alpha = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      const fadeLow = 1 - smooth(row.base + 20, row.base + height * 0.26, y);
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const d0 = r.dist[i] as number;
        if (d0 > 14) continue;
        const d = d0 + r.n(x * 0.9, y * 0.9) * 4.5 + r.n(x * 3.1 + 40, y * 3.1) * 1.4;
        alpha[i] = smooth(2.2, -2.2, d) * fadeLow;
      }
    }
    for (let y = 0; y < height; y++) {
      const v = smooth(row.base - row.maxH, row.base + 40, y);
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const a = alpha[i] as number;
        if (a <= 0) continue;
        // Brushy tone variation: diagonal strokes of low-frequency noise.
        const stroke = r.n((x + y * 0.6) * 0.35, (y - x * 0.3) * 0.08) * 0.08 + r.n(x * 0.12, y * 0.12) * 0.05;
        const ay = y >= 3 ? (alpha[(y - 3) * width + Math.max(0, x - 2)] as number) : 0;
        const rim = a * (1 - ay) * row.rim;
        const o = i * 4;
        const k = 1 + stroke;
        const cr = (top[0] + (low[0] - top[0]) * v) * k + rimColor[0] * rim;
        const cg = (top[1] + (low[1] - top[1]) * v) * k + rimColor[1] * rim;
        const cb = (top[2] + (low[2] - top[2]) * v) * k + rimColor[2] * rim;
        // Straight-alpha "over" onto the previous row.
        const ba = out[o + 3] as number;
        const oa = a + ba * (1 - a);
        if (oa <= 0) continue;
        out[o] = (cr * a + (out[o] as number) * ba * (1 - a)) / oa;
        out[o + 1] = (cg * a + (out[o + 1] as number) * ba * (1 - a)) / oa;
        out[o + 2] = (cb * a + (out[o + 2] as number) * ba * (1 - a)) / oa;
        out[o + 3] = oa;
      }
    }
  });
  // Low mist glow across the base, and colour dilation for transparent texels (clean mip edges).
  const mist = hex(0x2a5872);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const glow = smooth(height * 0.5, height * 0.66, y) * (1 - smooth(height * 0.66, height * 0.86, y)) * 0.12;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const a = out[o + 3] as number;
      const lift = glow * (0.6 + 0.4 * noise.sample(x * 0.05, y * 0.2));
      for (let c = 0; c < 3; c++) {
        const col = a > 0 ? (out[o + c] as number) : (mist[c] as number);
        rgba[o + c] = Math.round(Math.min(1, col + lift * 0.5) * 255);
      }
      rgba[o + 3] = Math.round(Math.min(1, a) * 255);
    }
  }
  return { width, height, rgba };
}

/**
 * Conservative hull polygons of a chunk (chunk-local texels): `hull` encloses every texel with
 * alpha > 1/255; `opaqueHull` lies inside texels with alpha ≥ 254 inset by `inset`, or is null.
 * Columns are sampled in `band`-texel strips (min top / max bottom per strip; for the opaque hull,
 * the opaque run of each strip around a row that is opaque in every strip).
 */
export function chunkHulls(
  rgba: Uint8Array, stride: number, x0: number, y0: number, w: number, h: number, band = 16, inset = 5,
): { hull: number[] | null; opaqueHull: number[] | null } {
  const bands = Math.ceil(w / band);
  const vTop: number[] = [];
  const vBot: number[] = [];
  const oTop: number[] = [];
  const oBot: number[] = [];
  const alphaAt = (x: number, y: number): number => (x < 0 || y < 0 || x >= w || y >= h ? 0 : (rgba[((y0 + y) * stride + x0 + x) * 4 + 3] as number));
  for (let b = 0; b < bands; b++) {
    const bx0 = b * band;
    const bx1 = Math.min(w, bx0 + band);
    let top = h;
    let bot = -1;
    for (let x = bx0; x < bx1; x++) {
      for (let y = 0; y < h; y++) if (alphaAt(x, y) > 1) { top = Math.min(top, y); break; }
      for (let y = h - 1; y >= 0; y--) if (alphaAt(x, y) > 1) { bot = Math.max(bot, y + 1); break; }
    }
    vTop.push(top);
    vBot.push(bot);
  }
  const any = vBot.some((b) => b >= 0);
  let hull: number[] | null = null;
  if (any) {
    hull = [];
    for (let b = 0; b <= bands; b++) {
      const l = vTop[b - 1] ?? h;
      const r = vTop[b] ?? h;
      hull.push(Math.min(w, b * band), Math.min(l, r, h));
    }
    for (let b = bands; b >= 0; b--) {
      const l = vBot[b - 1] ?? -1;
      const r = vBot[b] ?? -1;
      hull.push(Math.min(w, b * band), Math.max(l, r, 0));
    }
    // A band with no visible texels would pinch the polygon; fall back to the bounding box then.
    if (vBot.some((v) => v < 0)) {
      const t = Math.min(...vTop);
      const bt = Math.max(...vBot);
      hull = [0, t, w, t, w, bt, 0, bt];
    }
  }
  let opaqueHull: number[] | null = null;
  // Every strip's opaque run must contain one shared row, so adjacent runs overlap and the
  // polygon cannot fold over itself.
  const rowOk = new Uint8Array(bands * h);
  for (let b = 0; b < bands; b++) {
    const bx0 = b * band - inset;
    const bx1 = Math.min(w, (b + 1) * band) + inset;
    for (let y = 0; y < h; y++) {
      let ok = 1;
      for (let x = bx0; x < bx1; x++) {
        // Chunks are sampled clamp-to-edge.
        if (alphaAt(Math.min(w - 1, Math.max(0, x)), y) < 254) {
          ok = 0;
          break;
        }
      }
      rowOk[b * h + y] = ok;
    }
  }
  const okAt = (b: number, y: number): boolean => {
    if (y < inset || y >= h - inset) return false;
    for (let yy = y - inset; yy <= y + inset; yy++) if (!rowOk[b * h + yy]) return false;
    return true;
  };
  let yRef = -1;
  for (let y = 0; y < h && yRef < 0; y++) {
    let all = true;
    for (let b = 0; all && b < bands; b++) all = okAt(b, y) && okAt(b, y + 2);
    if (all) yRef = y + 1;
  }
  if (yRef >= 0) {
    for (let b = 0; b < bands; b++) {
      let t = yRef;
      while (t > 0 && okAt(b, t - 1)) t--;
      let e = yRef;
      while (e < h - 1 && okAt(b, e + 1)) e++;
      oTop.push(t);
      oBot.push(e + 1);
    }
    opaqueHull = [];
    for (let b = 0; b <= bands; b++) {
      const l = oTop[b - 1] ?? 0;
      const r = oTop[b] ?? 0;
      opaqueHull.push(Math.min(w, b * band), Math.max(l, r));
    }
    for (let b = bands; b >= 0; b--) {
      const l = oBot[b - 1] ?? h;
      const r = oBot[b] ?? h;
      opaqueHull.push(Math.min(w, b * band), Math.min(l, r));
    }
  }
  return { hull, opaqueHull };
}
