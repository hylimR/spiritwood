/**
 * A small painting toolkit for CPU-painted plates (tools/art/paint-example.ts): a signed-distance field
 * that remembers which shape owns each texel (material, stroke coordinates, a part id), and a straight
 * alpha canvas with "over" compositing. Built on the frozen helpers only (src/render/gen/{sdf,noise}.ts),
 * so the stand-in paintings don't change when the kit generator does.
 */
import { clamp01 } from '../../src/core/math.ts';
import { Noise } from '../../src/render/gen/noise.ts';

export type RGB = [number, number, number];

const FAR = 1e9;

/** Straight-alpha float RGBA canvas. */
export class Paint {
  readonly w: number;
  readonly h: number;
  readonly rgb: Float32Array;
  readonly a: Float32Array;

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.rgb = new Float32Array(w * h * 3);
    this.a = new Float32Array(w * h);
  }

  /** Straight "over" of colour (r, g, b) at coverage `a` onto texel i. */
  over(i: number, r: number, g: number, b: number, a: number): void {
    if (a <= 0) return;
    const ba = this.a[i] as number;
    const k = ba * (1 - a);
    const oa = a + k;
    const o = i * 3;
    this.rgb[o] = (r * a + (this.rgb[o] as number) * k) / oa;
    this.rgb[o + 1] = (g * a + (this.rgb[o + 1] as number) * k) / oa;
    this.rgb[o + 2] = (b * a + (this.rgb[o + 2] as number) * k) / oa;
    this.a[i] = oa;
  }

  /** Composite another canvas of the same size over this one. */
  overPaint(top: Paint): void {
    for (let i = 0; i < this.w * this.h; i++) {
      const a = top.a[i] as number;
      if (a > 0) this.over(i, top.rgb[i * 3] as number, top.rgb[i * 3 + 1] as number, top.rgb[i * 3 + 2] as number, a);
    }
  }

  /** Straight RGBA8 (transparent texels black; the bake dilates colour into them). */
  toRgba8(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < this.w * this.h; i++) {
      const a = clamp01(this.a[i] as number);
      const a8 = Math.round(a * 255);
      if (a8 === 0) continue;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(clamp01(this.rgb[i * 3 + c] as number) * 255);
      out[i * 4 + 3] = a8;
    }
    return out;
  }
}

/** Polynomial smooth minimum; also returns the blend weight toward `b` (0 = a owns, 1 = b owns). */
function sminW(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}

/** Signed distance to a polygon (flat x,y pairs, any winding, may be concave). */
export function sdPolygon(px: number, py: number, pts: readonly number[]): number {
  const n = pts.length / 2;
  let d = Infinity;
  let s = 1;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const vix = pts[i * 2] as number;
    const viy = pts[i * 2 + 1] as number;
    const ex = (pts[j * 2] as number) - vix;
    const ey = (pts[j * 2 + 1] as number) - viy;
    const wx = px - vix;
    const wy = py - viy;
    const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
    const bx = wx - ex * t;
    const by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c1 = py >= viy;
    const c2 = py < (pts[j * 2 + 1] as number);
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * Math.sqrt(d);
}

/**
 * A signed-distance field over w × h texels (negative inside). Every shape writes only its bounds plus
 * `reach`; the nearer shape owns a texel's material, part id and stroke coordinates (u along the shape,
 * v across), which shading uses for form-following brush strokes.
 */
export class Field {
  readonly w: number;
  readonly h: number;
  readonly d: Float32Array;
  readonly mat: Uint8Array;
  readonly part: Uint16Array;
  readonly u: Float32Array;
  readonly v: Float32Array;
  /** Centre and radius of the owning round shape (ellipses), for per-lobe volume shading; radius 0 = none. */
  readonly ox: Float32Array;
  readonly oy: Float32Array;
  readonly or: Float32Array;
  /** Texels beyond a shape's surface that it still writes (for edge noise, rims and gradients). */
  reach = 24;
  private centre: [number, number, number] = [0, 0, 0];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.d = new Float32Array(w * h).fill(FAR);
    this.mat = new Uint8Array(w * h);
    this.part = new Uint16Array(w * h);
    this.u = new Float32Array(w * h);
    this.v = new Float32Array(w * h);
    this.ox = new Float32Array(w * h);
    this.oy = new Float32Array(w * h);
    this.or = new Float32Array(w * h);
  }

  /**
   * Union a shape: `sdf(x, y)` over the box [x0, x1) × [y0, y1) grown by `reach`, smooth-blended with
   * radius `k`; `uv(x, y, out)` gives its stroke coordinates.
   */
  shape(
    x0: number, y0: number, x1: number, y1: number, sdf: (x: number, y: number) => number, mat: number, part: number, k: number,
    uv: ((x: number, y: number, out: [number, number]) => void) | null = null,
  ): void {
    const r = this.reach + k;
    const xa = Math.max(0, Math.floor(x0 - r));
    const xb = Math.min(this.w, Math.ceil(x1 + r));
    const ya = Math.max(0, Math.floor(y0 - r));
    const yb = Math.min(this.h, Math.ceil(y1 + r));
    const st: [number, number] = [0, 0];
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const i = y * this.w + x;
        const s = sdf(x + 0.5, y + 0.5);
        if (s > this.reach) continue;
        const old = this.d[i] as number;
        if (s < old) {
          this.mat[i] = mat;
          this.part[i] = part;
          if (uv) {
            uv(x + 0.5, y + 0.5, st);
            this.u[i] = st[0];
            this.v[i] = st[1];
          } else {
            this.u[i] = x;
            this.v[i] = y;
          }
          this.ox[i] = this.centre[0];
          this.oy[i] = this.centre[1];
          this.or[i] = this.centre[2];
        }
        this.d[i] = old >= FAR ? s : sminW(old, s, k);
      }
    }
  }

  /** Tapered capsule a → b; strokes run along it. */
  capsule(ax: number, ay: number, bx: number, by: number, ra: number, rb: number, mat: number, part: number, k = 0): void {
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const tx = dx / len;
    const ty = dy / len;
    this.shape(
      Math.min(ax, bx) - Math.max(ra, rb), Math.min(ay, by) - Math.max(ra, rb), Math.max(ax, bx) + Math.max(ra, rb), Math.max(ay, by) + Math.max(ra, rb),
      (x, y) => {
        const px = x - ax;
        const py = y - ay;
        const h = Math.max(0, Math.min(1, (px * dx + py * dy) / (len * len)));
        return Math.hypot(px - dx * h, py - dy * h) - (ra + (rb - ra) * h);
      },
      mat, part, k,
      (x, y, out) => {
        out[0] = (x - ax) * tx + (y - ay) * ty;
        out[1] = -(x - ax) * ty + (y - ay) * tx;
      },
    );
  }

  /** A curved stroke (quadratic Bézier a–c–b) as `segments` tapered capsules; u runs along the curve. */
  curve(ax: number, ay: number, cx: number, cy: number, bx: number, by: number, ra: number, rb: number, mat: number, part: number, k = 0, segments = 8): void {
    let px = ax;
    let py = ay;
    let along = 0;
    for (let s = 1; s <= segments; s++) {
      const t = s / segments;
      const it = 1 - t;
      const qx = it * it * ax + 2 * it * t * cx + t * t * bx;
      const qy = it * it * ay + 2 * it * t * cy + t * t * by;
      const r0 = ra + (rb - ra) * ((s - 1) / segments);
      const r1 = ra + (rb - ra) * t;
      const base = along;
      const sx = px;
      const sy = py;
      const dx = qx - px;
      const dy = qy - py;
      const len = Math.hypot(dx, dy) || 1;
      this.shape(
        Math.min(px, qx) - Math.max(r0, r1), Math.min(py, qy) - Math.max(r0, r1), Math.max(px, qx) + Math.max(r0, r1), Math.max(py, qy) + Math.max(r0, r1),
        (x, y) => {
          const wx = x - sx;
          const wy = y - sy;
          const h = Math.max(0, Math.min(1, (wx * dx + wy * dy) / (len * len)));
          return Math.hypot(wx - dx * h, wy - dy * h) - (r0 + (r1 - r0) * h);
        },
        mat, part, s === 1 ? k : Math.max(k, 0.6 * Math.min(r0, r1)),
        (x, y, out) => {
          out[0] = base + ((x - sx) * dx + (y - sy) * dy) / len;
          out[1] = (-(x - sx) * dy + (y - sy) * dx) / len;
        },
      );
      along += len;
      px = qx;
      py = qy;
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, mat: number, part: number, k = 0): void {
    this.centre = [cx, cy, Math.max(rx, ry)];
    this.shape(cx - rx, cy - ry, cx + rx, cy + ry, (x, y) => {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      return (Math.hypot(dx, dy) - 1) * Math.min(rx, ry);
    }, mat, part, k, (x, y, out) => {
      out[0] = Math.atan2(y - cy, x - cx) * Math.min(rx, ry);
      out[1] = Math.hypot(x - cx, y - cy);
    });
    this.centre = [0, 0, 0];
  }

  /**
   * Lambert of the owning lobe's sphere normal at texel i (lit from `light`, x right, y down, z toward
   * the viewer), or −1 when the owner is not a round shape.
   */
  lobeLight(i: number, x: number, y: number, light: readonly [number, number, number]): number {
    const r = this.or[i] as number;
    if (r <= 0) return -1;
    const nx = (x - (this.ox[i] as number)) / r;
    const ny = (y - (this.oy[i] as number)) / r;
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)) + 0.15;
    const l = Math.hypot(nx, ny, nz);
    return Math.max(0, (nx * light[0] + ny * light[1] + nz * light[2]) / l);
  }

  polygon(pts: readonly number[], mat: number, part: number, k = 0): void {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i] as number);
      x1 = Math.max(x1, pts[i] as number);
      y0 = Math.min(y0, pts[i + 1] as number);
      y1 = Math.max(y1, pts[i + 1] as number);
    }
    this.shape(x0, y0, x1, y1, (x, y) => sdPolygon(x, y, pts), mat, part, k);
  }

  /** Carve a shape out of the field (d = max(d, −s)) within its box. */
  carve(x0: number, y0: number, x1: number, y1: number, sdf: (x: number, y: number) => number, k = 0): void {
    const xa = Math.max(0, Math.floor(x0 - this.reach - k));
    const xb = Math.min(this.w, Math.ceil(x1 + this.reach + k));
    const ya = Math.max(0, Math.floor(y0 - this.reach - k));
    const yb = Math.min(this.h, Math.ceil(y1 + this.reach + k));
    for (let y = ya; y < yb; y++) {
      for (let x = xa; x < xb; x++) {
        const i = y * this.w + x;
        const s = -sdf(x + 0.5, y + 0.5);
        const d = this.d[i] as number;
        if (d >= FAR) continue;
        this.d[i] = k > 0 ? -sminW(-d, -s, k) : Math.max(d, s);
      }
    }
  }

  /** Outward unit gradient of d at texel (x, y) by central differences (0,0 outside the field). */
  gradient(x: number, y: number, out: [number, number]): [number, number] {
    const w = this.w;
    const at = (xx: number, yy: number): number => {
      const cx = Math.min(w - 1, Math.max(0, xx));
      const cy = Math.min(this.h - 1, Math.max(0, yy));
      const v = this.d[cy * w + cx] as number;
      return v >= FAR ? (this.d[y * w + x] as number) + 1 : v;
    };
    const gx = at(x + 1, y) - at(x - 1, y);
    const gy = at(x, y + 1) - at(x, y - 1);
    const l = Math.hypot(gx, gy);
    out[0] = l > 1e-6 ? gx / l : 0;
    out[1] = l > 1e-6 ? gy / l : 0;
    return out;
  }
}

/** Anisotropic brush texture in stroke space: long along u, narrow across v (≈ −1 … 1). */
export function brush(noise: Noise, u: number, v: number, length: number, width: number, salt = 0): number {
  return noise.noise2(u / length + salt * 13.1, v / width - salt * 7.7) * 0.65
    + noise.noise2(u / (length * 0.45) + 41 + salt, v / (width * 0.5) + 17) * 0.35;
}

/** Smooth coverage across `soft` texels (1 inside). */
export function cover(d: number, soft: number): number {
  const t = 0.5 - d / Math.max(1e-6, soft);
  return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
}

export function mix3(a: RGB, b: RGB, t: number, out: RGB = [0, 0, 0]): RGB {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

export function hex(c: number): RGB {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

export function luma(c: Readonly<RGB>): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/** Branching style for `limbs`. */
export interface LimbStyle {
  /** Child / parent radius. */
  taper: number;
  /** Child / parent length range. */
  len: [number, number];
  /** Angle between siblings and its jitter (radians). */
  spread: number;
  jitter: number;
  /** Pull toward straight up (light-seeking), 0..1. */
  rise: number;
  /** Sag of long limbs. */
  droop: number;
  /** Stop below this radius (texels). */
  minRadius: number;
}

/**
 * A recursive limb system from (x, y) along `ang` (radians, −π/2 = up; y down): tapered, sagging
 * curves that fork in two (sometimes three) and call `tip(x, y, radius)` at every twig end, where
 * foliage goes. Deterministic in `rng`.
 */
export function limbs(
  f: Field, rng: { range(a: number, b: number): number; chance(p: number): boolean }, x: number, y: number, ang: number, len: number, r: number,
  s: LimbStyle, mat: number, part: number, tip: (x: number, y: number, r: number) => void, depth = 0,
): void {
  const ex0 = x + Math.cos(ang) * len;
  const ey0 = y + Math.sin(ang) * len;
  const sag = s.droop * len * len * 0.01 * Math.abs(Math.cos(ang));
  const cx = (x + ex0) / 2 + rng.range(-0.08, 0.08) * len;
  const cy = (y + ey0) / 2 + sag * 0.5;
  const ex = ex0;
  const ey = ey0 + sag;
  const r1 = r * s.taper;
  f.curve(x, y, cx, cy, ex, ey, r, r1, mat, part, Math.max(1.2, r * 0.5), Math.max(4, Math.round(len / 14)));
  if (r1 < s.minRadius || depth > 6) {
    tip(ex, ey, r1);
    return;
  }
  const n = rng.chance(0.28) ? 3 : 2;
  const endAng = Math.atan2(ey - cy, ex - cx);
  for (let i = 0; i < n; i++) {
    const off = (i - (n - 1) / 2) * s.spread + rng.range(-s.jitter, s.jitter);
    let a = endAng + off;
    // Light-seeking: bend toward straight up.
    const up = -Math.PI / 2;
    let da = up - a;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    a += da * s.rise;
    limbs(f, rng, ex, ey, a, len * rng.range(s.len[0], s.len[1]), r1, s, mat, part, tip, depth + 1);
  }
}

/**
 * A foliage clump: a body, lobes on an irregular envelope (heaped toward the light, thinner below) and
 * tufted rims, so the outline is fractal rather than a blob.
 */
export function foliage(
  f: Field, rng: { range(a: number, b: number): number; chance(p: number): boolean }, cx: number, cy: number, rx: number, ry: number,
  mat: number, part: number,
): void {
  const p1 = rng.range(0, 6.28);
  const p2 = rng.range(0, 6.28);
  f.ellipse(cx, cy + ry * 0.08, rx * 0.62, ry * 0.58, mat, part, 3);
  const n = 7;
  const a0 = rng.range(0, 6.28);
  const m = Math.min(rx, ry);
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2 + rng.range(-0.3, 0.3);
    const env = (1 + 0.2 * Math.sin(3 * a + p1) + 0.1 * Math.sin(5 * a + p2)) * rng.range(0.85, 1.05);
    const upness = Math.max(0, -Math.sin(a));
    const lr = m * rng.range(0.32, 0.46) * (0.85 + 0.3 * upness);
    const lx = cx + Math.cos(a) * rx * 0.56 * env;
    const ly = cy + Math.sin(a) * ry * 0.56 * env;
    f.ellipse(lx, ly, lr, lr * rng.range(0.78, 0.95), mat, part, 2.5);
    const tufts = 5;
    for (let t = 0; t < tufts; t++) {
      const ta = a + rng.range(-1.3, 1.3);
      const tr = lr * rng.range(0.2, 0.32);
      const d = lr * rng.range(0.78, 0.98);
      f.ellipse(lx + Math.cos(ta) * d, ly + Math.sin(ta) * d * 0.9, tr, tr * rng.range(0.7, 1), mat, part, 1.2);
    }
  }
}
