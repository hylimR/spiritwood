import { PALETTE } from '../../config.ts';
import { coverage, opIntersect, sdCurve, sdEllipse, sdTaperedCapsule, smin } from '../gen/sdf.ts';
import { mix3, rgb, smoothstep, type AtlasImage } from '../hero/atlas.ts';
import { bake, bakeLight, entityNoise, LIGHT, type Sdf } from './entityBake.ts';

/**
 * Thorn Spitter parts for the entity atlas (§5.5): a rooted bulb plant about 1.3 tiles tall. A root
 * mound grips the ground, a short thorned stem carries an artichoke-like bulb of overlapping pointed
 * bracts crowned by four thorn petals around its mouth, and a rosette of serrated thorny leaves splays
 * from the base. The body is a cool plum-black with a moonlit rim; its light lives in a separate
 * emissive image (rose seams between the bracts and a hot mouth) so the view can swell and dim it.
 * Facing right, y down, the feet at the origin.
 */

/** Part layout in spitter space (facing right, feet at the origin). The muzzle is at (0, -50) (§5.3). */
export const SPITTER_ART = Object.freeze({
  /** Stem base (on the root mound) and length to the bulb's neck joint. */
  stemBaseY: -6,
  stemLength: 14,
  /** Mouth centre in bulb space (the neck joint is the bulb's origin). */
  mouthY: -30,
  /** Leaf bases, rest angles (rad, 0 = +x, clockwise positive), scales, and whether they sit behind the stem. */
  leaves: [
    { x: -3, y: -8, angle: -2.2, scale: 1.02, back: true },
    { x: 3, y: -8, angle: -0.98, scale: 0.96, back: true },
    { x: -4, y: -5, angle: -2.72, scale: 1.18, back: false },
    { x: 4.5, y: -5, angle: -0.4, scale: 1.22, back: false },
  ] as readonly { x: number; y: number; angle: number; scale: number; back: boolean }[],
});

const DENSITY = 3;
const noise = entityNoise;
const L3 = Math.hypot(LIGHT.x * 0.8, LIGHT.y * 0.8, 0.6);

const BODY_DARK = [0.03, 0.022, 0.04];
const BODY_BASE = [0.055, 0.04, 0.065];
const BODY_LIT = [0.2, 0.15, 0.24];
const RIM = [0.56, 0.54, 0.7];
const ROSE = rgb(PALETTE.thorns);
const ROSE_HOT = [1, 0.72, 0.78];

/** Pillow-lit plum-black bark: base → lit by the moon from the upper left, a cool rim on the lit edge. */
function barkColor(x: number, y: number, d: number, nx: number, ny: number, thickness: number, out: number[]): void {
  const e = 1 - Math.min(1, Math.max(0, -d / thickness));
  const nz = Math.sqrt(Math.max(0, 1 - e * e));
  const diff = Math.max(0, (nx * e * LIGHT.x * 0.8 + ny * e * LIGHT.y * 0.8 + nz * 0.6) / L3);
  const grain = noise.fbm(x * 0.55, y * 0.3, 3) * 0.5 + 0.5;
  let c = mix3(BODY_DARK, BODY_BASE, 0.4 + 0.6 * grain);
  c = mix3(c, BODY_LIT, Math.pow(diff, 2.2) * 0.8);
  const facing = Math.max(0, nx * LIGHT.x + ny * LIGHT.y);
  c = mix3(c, RIM, smoothstep(0.62, 0.97, e) * Math.pow(facing, 1.6) * 0.72);
  out[0] = c[0];
  out[1] = c[1];
  out[2] = c[2];
}

function rootsSdf(x: number, y: number): number {
  const mound = opIntersect(sdEllipse(x, y, 0, -4, 17, 10.5), y - 2.2);
  let d = mound;
  if (x < -2) d = smin(d, sdCurve(x, y, -8, -5, -20, -6.5, -30, 1.8, 2.7, 0.45, 4), 3);
  if (x > 2) d = smin(d, sdCurve(x, y, 9, -5, 19, -7.5, 29.5, 1.6, 2.5, 0.45, 4), 3);
  if (x < 3 && y > -8) d = smin(d, sdCurve(x, y, -3, -1, -10, 1, -17.5, 2.6, 1.8, 0.35, 3), 2);
  if (x > -3 && y > -8) d = smin(d, sdCurve(x, y, 4, -1.5, 11, 1.5, 17, 2.9, 1.6, 0.35, 3), 2);
  return d + noise.fbm(x * 0.35, y * 0.35, 3) * 0.7;
}

function roots(): AtlasImage {
  return bake({
    name: 'spitterRoots', x0: -33, y0: -17, x1: 33, y1: 4, density: DENSITY, sdf: rootsSdf, normalBand: 5,
    shade: (x, y, d, nx, ny, out) => {
      barkColor(x, y, d, nx, ny, 4, out);
      // Ground contact: the underside sinks into shadow.
      const k = 0.45 + 0.55 * smoothstep(2.5, -5, y);
      out[0] = (out[0] as number) * k;
      out[1] = (out[1] as number) * k;
      out[2] = (out[2] as number) * k;
      return 1;
    },
  });
}

const STEM_THORNS: readonly (readonly [number, number, number, number])[] = [
  [-4.2, -4.5, -9, -8.6],
  [4.3, -9.5, 9, -13.2],
];

function stemThorns(x: number, y: number): number {
  if (Math.abs(x) > 9) return Math.abs(x) - 8;
  let d = Infinity;
  for (let i = 0; i < STEM_THORNS.length; i++) {
    const t = STEM_THORNS[i] as readonly [number, number, number, number];
    const e = sdTaperedCapsule(x, y, t[0], t[1], t[2], t[3], 1.25, 0.12);
    if (e < d) d = e;
  }
  return d;
}

function stemSdf(x: number, y: number): number {
  const stalk = sdCurve(x, y, 0, 2.5, -1.6, -6, 0.3, -15.5, 5.6, 4.6, 6);
  return smin(stalk, stemThorns(x, y), 1.2) + noise.fbm(x * 0.5, y * 0.5, 2) * 0.35;
}

function stem(): AtlasImage {
  const tip = [0.4, 0.09, 0.15];
  return bake({
    name: 'spitterStem', x0: -11, y0: -19, x1: 11, y1: 4, density: DENSITY, sdf: stemSdf, normalBand: 3,
    shade: (x, y, d, nx, ny, out) => {
      barkColor(x, y, d, nx, ny, 3.2, out);
      // Stringy fibres along the stalk.
      const fibre = 0.82 + 0.18 * Math.sin(x * 2.3 + noise.noise2(x * 0.4, y * 0.12) * 3);
      let c = [(out[0] as number) * fibre, (out[1] as number) * fibre, (out[2] as number) * fibre];
      const th = stemThorns(x, y);
      if (th < 0.4) {
        let best = 0;
        for (let i = 0; i < STEM_THORNS.length; i++) {
          const t = STEM_THORNS[i] as readonly [number, number, number, number];
          const along = ((x - t[0]) * (t[2] - t[0]) + (y - t[1]) * (t[3] - t[1])) / ((t[2] - t[0]) ** 2 + (t[3] - t[1]) ** 2);
          best = Math.max(best, smoothstep(0.35, 1, along));
        }
        c = mix3(c, tip, best * 0.85);
      }
      out[0] = c[0] as number;
      out[1] = c[1] as number;
      out[2] = c[2] as number;
      return 1;
    },
  });
}

const MOUTH = { x: 0, y: SPITTER_ART.mouthY };
/** Crown petals around the mouth: [base angle, length]; the middle stays open for the seed. */
const PETALS: readonly (readonly [number, number])[] = [
  [-Math.PI / 2 - 1.15, 7],
  [-Math.PI / 2 - 0.47, 9.4],
  [-Math.PI / 2 + 0.45, 9.2],
  [-Math.PI / 2 + 1.13, 6.8],
];

function petals(x: number, y: number): number {
  // Bounding circle around the crown: far texels get a conservative distance without the curves.
  const bound = Math.hypot(x - MOUTH.x, y - MOUTH.y + 2.5) - 16;
  if (bound > 2) return bound;
  let d = Infinity;
  for (let i = 0; i < PETALS.length; i++) {
    const p = PETALS[i] as readonly [number, number];
    const a = p[0];
    const bx = MOUTH.x + Math.cos(a) * 4.2;
    const by = MOUTH.y + 2.4 + Math.sin(a) * 2.4;
    // Petals curl outward toward their tips.
    const tx = MOUTH.x + Math.cos(a) * (4.2 + p[1]) + Math.cos(a) * 1.8;
    const ty = MOUTH.y + 2.4 + Math.sin(a) * (2.4 + p[1]);
    const cx = (bx + tx) / 2 + Math.cos(a) * 2;
    const cy = (by + ty) / 2 + 0.7;
    const e = sdCurve(x, y, bx, by, cx, cy, tx, ty, 2.2, 0.2, 5);
    if (e < d) d = e;
  }
  return d;
}

const LOWER = { cy: -14, rx: 14.8, ry: 13.6 };
const UPPER = { cy: -23, rx: 10.6, ry: 9.6 };
/** Bract mapping: v = (1 − y) / BULB_H. */
const BULB_H = 33;

function bulbBody(x: number, y: number): number {
  const lower = sdEllipse(x, y, 0, LOWER.cy, LOWER.rx, LOWER.ry);
  const upper = sdEllipse(x, y, 0, UPPER.cy, UPPER.rx, UPPER.ry);
  const neck = sdTaperedCapsule(x, y, 0, 2.2, 0, -4, 4.4, 5.6);
  return smin(smin(lower, upper, 5.5), neck, 3.5);
}

function bulbSdf(x: number, y: number): number {
  return smin(bulbBody(x, y), petals(x, y), 1.4) + noise.fbm(x * 0.4, y * 0.4, 2) * 0.3;
}

/** Half-width of the bulb at height y (for the bract mapping), from the lower/upper ellipses. */
function bulbHalfWidth(y: number): number {
  const l = 1 - ((y - LOWER.cy) / LOWER.ry) ** 2;
  const u = 1 - ((y - UPPER.cy) / UPPER.ry) ** 2;
  return Math.max(1.5, LOWER.rx * Math.sqrt(Math.max(0, l)), UPPER.rx * Math.sqrt(Math.max(0, u)));
}

interface Bract {
  /** Distance (u) to the nearest seam: the visible scale's own outline or the edge of a scale in front. */
  inside: number;
  /** 0 at the scale's base … 1 at its tip. */
  t: number;
  /** Across the scale, −1 … 1. */
  s: number;
  /** 0 = on a bract, 1 = the neck below the scales, 2 = the crown above them. */
  region: number;
}

const BRACT_ROWS = [6, 6, 5, 5, 4] as const;
const ROW_V0 = 0.06;
const ROW_STEP = 0.155;
const ROW_H = 0.34;

/**
 * Overlapping pointed bracts: lower rows sit in front and their tips cover the bases above; a scale's
 * hidden base extends down behind the row in front, so the scales tile the pod without gaps. u is the
 * foreshortened angle around the bulb, v the height fraction.
 */
function bract(x: number, y: number, out: Bract): Bract {
  const hw = bulbHalfWidth(y);
  const u = Math.asin(Math.max(-1, Math.min(1, x / hw))) / (Math.PI / 2);
  const v = (-y + 1) / BULB_H;
  const toWorld = hw * 1.4;
  let front = Infinity;
  for (let j = 0; j < BRACT_ROWS.length; j++) {
    const t = (v - (ROW_V0 + j * ROW_STEP)) / ROW_H;
    if (t > 1) continue;
    if (t < 0 && j === 0) {
      out.inside = Infinity;
      out.t = 0;
      out.s = 0;
      out.region = 1;
      return out;
    }
    const count = BRACT_ROWS[j] as number;
    const w = 2 / count;
    const shift = (j % 2) * w * 0.5;
    const k = Math.round((u + 1 - shift) / w - 0.5);
    const uc = -1 + shift + (k + 0.5) * w;
    const half = (w / 2) * 1.06 * (t < 0 ? 1 : 1 - Math.pow(t, 1.6));
    const sd = (Math.abs(u - uc) - half) * toWorld;
    if (sd < 0) {
      out.inside = Math.min(-sd, front, t < 0 ? Infinity : (1 - t) * ROW_H * BULB_H * 0.6);
      out.t = Math.max(0, t);
      out.s = (u - uc) / (w / 2);
      out.region = 0;
      return out;
    }
    front = Math.min(front, sd);
  }
  out.inside = front;
  out.t = 1;
  out.s = 0;
  out.region = 2;
  return out;
}

function bulb(): AtlasImage {
  const b: Bract = { inside: 0, t: 0, s: 0, region: 0 };
  return bake({
    name: 'spitterBulb', x0: -19, y0: -45, x1: 19, y1: 4, density: DENSITY, sdf: bulbSdf, normalBand: 7,
    shade: (x, y, d, nx, ny, out) => {
      barkColor(x, y, d, nx, ny, 7, out);
      let c = [out[0] as number, out[1] as number, out[2] as number];
      if (petals(x, y) < bulbBody(x, y)) {
        // Petals: dark, rose-tipped.
        const along = Math.min(1, Math.hypot(x - MOUTH.x, y - MOUTH.y - 2) / 12);
        c = mix3(c, [0.42, 0.1, 0.17], smoothstep(0.55, 1, along) * 0.9);
      } else {
        bract(x, y, b);
        // Each bract bulges: lighter toward its middle and tip, a dark seam where it overlaps the next.
        const seam = 1 - smoothstep(0, 0.8, b.inside);
        const bulge = b.region === 0 ? (1 - b.s * b.s) * (0.3 + 0.7 * b.t) : 0.2;
        c = mix3(c, [c[0] * 1.9 + 0.03, c[1] * 1.75 + 0.02, c[2] * 1.9 + 0.035], bulge * 0.5);
        c = mix3(c, [0.012, 0.008, 0.016], seam * 0.85);
        // The mouth: a dark pucker.
        const mouth = 1 - smoothstep(0.6, 2.4, Math.hypot((x - MOUTH.x) / 1.6, y - MOUTH.y - 1.2));
        c = mix3(c, [0.02, 0.005, 0.012], mouth);
      }
      out[0] = c[0] as number;
      out[1] = c[1] as number;
      out[2] = c[2] as number;
      return 1;
    },
  });
}

/**
 * The bulb's light (premultiplied, pure emission): rose light seeping through the seams between the
 * bracts, stronger toward the top, and a hot mouth whose glow spills out past the petals.
 */
function bulbGlow(): AtlasImage {
  const b: Bract = { inside: 0, t: 0, s: 0, region: 0 };
  const aa = 1 / DENSITY;
  return bakeLight({
    name: 'spitterBulbGlow', x0: -19, y0: -45, x1: 19, y1: 4, density: DENSITY,
    texel: (x, y, out) => {
      const body = bulbBody(x, y);
      const cov = coverage(body + 0.4, aa);
      let e = 0;
      let hot = 0;
      if (cov > 0) {
        bract(x, y, b);
        const seam = 1 - smoothstep(0.05, 0.7, b.inside);
        const v = Math.min(1, Math.max(0, (-y + 1) / BULB_H));
        e += seam * (0.3 + 0.7 * v) * cov;
        // Faint translucency of the upper pod, brightest in the bracts' thin tips.
        if (b.region === 0) e += smoothstep(0.4, 1, v) * smoothstep(0.55, 1, b.t) * 0.22 * cov;
      }
      const m = Math.hypot((x - MOUTH.x) / 1.35, y - MOUTH.y - 0.6);
      hot = Math.exp(-m * m * 0.4);
      e += Math.exp(-m * 0.6) * 0.45;
      const r = ROSE[0] * e + ROSE_HOT[0] * hot;
      const g = ROSE[1] * e + ROSE_HOT[1] * hot;
      const bl = ROSE[2] * e + ROSE_HOT[2] * hot;
      out[0] = r;
      out[1] = g;
      out[2] = bl;
      out[3] = 0;
    },
  });
}

/** Leaf centreline samples (length 30 along +x, arching up then dipping to the tip). */
const LEAF_N = 24;
const LEAF_LEN = 30;
const LEAF_TIP_Y = -2.5;
const LEAF_PTS = (() => {
  const pts = new Float64Array((LEAF_N + 1) * 2);
  for (let i = 0; i <= LEAF_N; i++) {
    const t = i / LEAF_N;
    const it = 1 - t;
    pts[i * 2] = 2 * it * t * 13 + t * t * LEAF_LEN;
    pts[i * 2 + 1] = 2 * it * t * -8 + t * t * LEAF_TIP_Y;
  }
  return pts;
})();

/** Nearest centreline point: out = [t, signed offset (+ = below), distance]. */
function leafFrame(x: number, y: number, out: number[]): void {
  let best = Infinity;
  let bestT = 0;
  let bestSide = 0;
  for (let i = 0; i < LEAF_N; i++) {
    const ax = LEAF_PTS[i * 2] as number;
    const ay = LEAF_PTS[i * 2 + 1] as number;
    const bx = LEAF_PTS[i * 2 + 2] as number;
    const by = LEAF_PTS[i * 2 + 3] as number;
    const dx = bx - ax;
    const dy = by - ay;
    const h = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    const px = ax + dx * h;
    const py = ay + dy * h;
    const dist = Math.hypot(x - px, y - py);
    if (dist < best) {
      best = dist;
      bestT = (i + h) / LEAF_N;
      bestSide = (x - px) * -dy + (y - py) * dx;
    }
  }
  out[0] = bestT;
  out[1] = bestSide >= 0 ? best : -best;
  out[2] = best;
}

function leafWidth(t: number): number {
  return 3.1 * Math.sin(Math.PI * Math.pow(Math.min(1, t), 0.85)) * (1 - 0.3 * t) + 0.55 * (1 - t);
}

/** Forward-raked teeth along both edges (0 … 1.6 u). */
function leafTeeth(t: number, side: number): number {
  if (t < 0.14 || t > 0.93) return 0;
  const period = 0.1;
  const ph = (t + (side > 0 ? 0.05 : 0)) / period;
  const f = ph - Math.floor(ph);
  const tooth = f < 0.75 ? f / 0.75 : (1 - f) / 0.25;
  return 1.2 * Math.pow(tooth, 2.4) * smoothstep(0.14, 0.3, t);
}

function leafSdf(x: number, y: number, f: number[]): number {
  leafFrame(x, y, f);
  const t = f[0] as number;
  const off = f[1] as number;
  const edge = leafWidth(t) + leafTeeth(t, off);
  let d = Math.abs(off) - edge;
  // A sharp tip past the end of the centreline.
  const tipX = x - LEAF_LEN;
  if (tipX > 0) d = Math.max(d, Math.hypot(tipX, y - LEAF_TIP_Y) - 0.2);
  return d + noise.fbm(x * 0.6, y * 0.6, 2) * 0.12;
}

/** A serrated thorny leaf (premultiplied: dark blade, glowing rose tip and tooth points). */
function leaf(): AtlasImage {
  const f = [0, 0, 0];
  const g = [0, 0, 0];
  const aa = 1.1 / DENSITY;
  const eps = 0.5 / DENSITY;
  const sdf: Sdf = (x, y) => leafSdf(x, y, g);
  return bakeLight({
    name: 'spitterLeaf', x0: -2, y0: -11, x1: 38, y1: 4, density: DENSITY,
    texel: (x, y, out) => {
      const d = leafSdf(x, y, f);
      const t = f[0] as number;
      const off = f[1] as number;
      const cov = coverage(d, aa);
      let r = 0;
      let gg = 0;
      let b = 0;
      if (cov > 0) {
        let nx = 0;
        let ny = 0;
        if (d > -1.8) {
          nx = sdf(x + eps, y) - sdf(x - eps, y);
          ny = sdf(x, y + eps) - sdf(x, y - eps);
          const nl = Math.hypot(nx, ny) || 1;
          nx /= nl;
          ny /= nl;
        }
        const c = [0, 0, 0];
        barkColor(x, y, d, nx, ny, 1.6, c);
        // Lighter midrib and upper blade half catching the moon.
        const w = leafWidth(t);
        const rib = 1 - smoothstep(0.15, 0.7, Math.abs(off));
        let col = mix3(c, [c[0] * 2.2 + 0.03, c[1] * 1.9 + 0.02, c[2] * 2.2 + 0.04], rib * 0.6 * (1 - t * 0.5));
        col = mix3(col, [col[0] * 0.55, col[1] * 0.55, col[2] * 0.6], smoothstep(0, w, off) * 0.5);
        // Rose-tipped teeth and blade tip.
        const toothTip = smoothstep(w * 0.9, w + 1.2, Math.abs(off));
        col = mix3(col, [0.38, 0.08, 0.14], Math.max(toothTip * 0.8, smoothstep(0.8, 1, t) * 0.9));
        r = col[0] * cov;
        gg = col[1] * cov;
        b = col[2] * cov;
      }
      // Emissive thorn tips (the brambles' rose light).
      const tipGlow = Math.exp(-Math.hypot(x - LEAF_LEN, y - LEAF_TIP_Y) * 0.9) * 0.9;
      const tooth = cov > 0 ? smoothstep(leafWidth(t) + 0.5, leafWidth(t) + 1.5, Math.abs(off)) * 0.3 : 0;
      const e = tipGlow + tooth;
      out[0] = r + ROSE[0] * e;
      out[1] = gg + ROSE[1] * e;
      out[2] = b + ROSE[2] * e;
      out[3] = cov;
    },
  });
}

/** Anchor pod profile: ring grooves (s = distance from the tip down the axis), body length and girth. */
const POD_GROOVES = [22.7, 18.6, 14.2, 9.8, 5.4] as const;
const POD_BODY = 24;
const POD_GIRTH = 6.2;

/**
 * Half-width of the anchor's pod at s: a teardrop whose bulk sits toward the base, drawing out to the
 * closed point of its tip, telescoped into ring segments (a lip just below each groove, a pinch at it).
 */
function podRadius(s: number): number {
  if (s <= 0 || s >= POD_BODY) return 0;
  const t = s / POD_BODY;
  let r = (POD_GIRTH * Math.pow(t, 1.3) * Math.pow(1 - t, 0.4)) / 0.3955;
  for (let i = 1; i < POD_GROOVES.length; i++) {
    const g = POD_GROOVES[i] as number;
    const lip = (s - g - 0.75) / 0.6;
    const pinch = (s - g) / 0.38;
    r += 0.5 * Math.exp(-lip * lip) - 0.42 * Math.exp(-pinch * pinch);
  }
  return r;
}

/**
 * Anchor (fixed-aim) spitter layout (§5.5): a tall slender stalk carrying a closed seed pod of ring
 * segments that points along the fixed aim. The pod pivots at its tip, the mouth, which sits on the sim
 * muzzle for any aim; it is drawn pointing up (−y) and turned by the view. s = distance from the tip
 * down the pod's axis.
 */
export const ANCHOR_ART = Object.freeze({
  stalkBaseY: -6,
  /** The pod's tip (mouth) above the feet: the sim muzzle (§5.3). */
  podTipY: -50,
  /** Tip → the end of the pod's neck, where the stalk joins. */
  podLength: 26,
  /** Ring grooves, base → tip: [s, half-width of the pod there] (the lights sit in them). */
  rings: POD_GROOVES.map((g, i) => [g, i === 0 ? 3 : podRadius(g) + 0.25] as const) as readonly (readonly [number, number])[],
  /** Leaves: the thorny rosette, more upright than the bulb spitter's (a taller, narrower plant). */
  leaves: [
    { x: -2, y: -8, angle: -1.92, scale: 0.7, back: true },
    { x: 2, y: -8, angle: -1.22, scale: 0.68, back: true },
    { x: -3, y: -4.5, angle: -2.62, scale: 0.8, back: false },
    { x: 3.5, y: -4.5, angle: -0.55, scale: 0.82, back: false },
  ] as readonly { x: number; y: number; angle: number; scale: number; back: boolean }[],
});

/** Stalk length in the drawing (base → where it enters the pod's neck) for a straight-up aim. */
export const ANCHOR_STALK_LENGTH = -ANCHOR_ART.podTipY - ANCHOR_ART.podLength + ANCHOR_ART.stalkBaseY;

/** The coronet of thorns round the tip pore: [base x, base s, tip x, tip s] (mirrored). */
const POD_SPIKES: readonly (readonly [number, number, number, number])[] = [
  [1, 3.4, 2.3, -11.5],
  [2.2, 5.8, 6.4, -1.2],
];

function podBody(x: number, s: number): number {
  const r = podRadius(Math.min(POD_BODY - 1e-3, Math.max(1e-3, s)));
  // Distance to the profile (its slope stays small), capped at the tip and the base.
  const d = Math.max((Math.abs(x) - r) * 0.92, -s, s - POD_BODY);
  return smin(d, sdTaperedCapsule(x, s, 0, 21.8, 0, 26.3, 3.1, 2.4), 1.3);
}

function podThorns(x: number, s: number): number {
  if (Math.abs(x) > 9 || s > 8.5) return Math.max(Math.abs(x) - 8, s - 7.5);
  const ax = Math.abs(x);
  let d = Infinity;
  for (let i = 0; i < POD_SPIKES.length; i++) {
    const k = POD_SPIKES[i] as readonly [number, number, number, number];
    const e = sdTaperedCapsule(ax, s, k[0], k[1], k[2], k[3], 0.9, 0.08);
    if (e < d) d = e;
  }
  return d;
}

/** Distance (u, along the axis) from s to the nearest ring groove. */
function podGroove(s: number): number {
  let best = Infinity;
  for (let i = 0; i < POD_GROOVES.length; i++) best = Math.min(best, Math.abs(s - (POD_GROOVES[i] as number)));
  return best;
}

function podSdf(x: number, s: number): number {
  return smin(podBody(x, s), podThorns(x, s), 0.7) + noise.fbm(x * 0.5, s * 0.5, 2) * 0.2;
}

function anchorPod(): AtlasImage {
  return bake({
    name: 'anchorPod', x0: -9.5, y0: -13.5, x1: 9.5, y1: 27.5, density: DENSITY, sdf: podSdf, normalBand: 5,
    shade: (x, s, d, nx, ny, out) => {
      barkColor(x, s, d, nx, ny, 4.5, out);
      let c = [out[0] as number, out[1] as number, out[2] as number];
      if (podThorns(x, s) < podBody(x, s)) {
        // The coronet: dark thorns, rose toward their points.
        c = mix3(c, [0.44, 0.1, 0.18], Math.max(smoothstep(1, -9, s), smoothstep(0.35, 1, (Math.abs(x) - podRadius(Math.max(0.1, s)) + 0.4) / 3.8)) * 0.9);
      } else {
        // Telescoped rings: the lip under each groove catches the moon; the groove itself is a dark seam.
        let lip = 0;
        for (let i = 1; i < POD_GROOVES.length; i++) {
          const u = (s - (POD_GROOVES[i] as number) - 0.9) / 0.8;
          lip = Math.max(lip, Math.exp(-u * u));
        }
        const groove = 1 - smoothstep(0.15, 0.75, podGroove(s));
        c = mix3(c, [c[0] * 1.9 + 0.035, c[1] * 1.75 + 0.025, c[2] * 1.95 + 0.04], lip * 0.55);
        c = mix3(c, [0.012, 0.008, 0.016], groove * 0.9);
        const rib = 0.88 + 0.12 * Math.sin(x * 2.3 + noise.noise2(x * 0.3, s * 0.25) * 2.2);
        c = [c[0] * rib, c[1] * rib, c[2] * rib];
        // The closed pore at the tip.
        c = mix3(c, [0.02, 0.005, 0.012], 1 - smoothstep(0.35, 1.2, Math.hypot(x / 1.2, s - 0.9)));
      }
      out[0] = c[0] as number;
      out[1] = c[1] as number;
      out[2] = c[2] as number;
      return 1;
    },
  });
}

const STALK_SPURS: readonly (readonly [number, number, number, number])[] = [
  [-2.2, -6.8, -5.6, -11.2],
  [2.1, -12.6, 5.3, -16.6],
];

function stalkSpurs(x: number, y: number): number {
  if (Math.abs(x) > 8) return Math.abs(x) - 7;
  let d = Infinity;
  for (let i = 0; i < STALK_SPURS.length; i++) {
    const t = STALK_SPURS[i] as readonly [number, number, number, number];
    const e = sdTaperedCapsule(x, y, t[0], t[1], t[2], t[3], 1.0, 0.1);
    if (e < d) d = e;
  }
  return d;
}

function stalkSdf(x: number, y: number): number {
  const top = -ANCHOR_STALK_LENGTH - 1.5;
  let d = sdCurve(x, y, 0, 2.5, -0.9, top * 0.5, 0.2, top, 3.3, 2.5, 6);
  // Two knotted nodes, like a cane's joints.
  d = smin(d, sdEllipse(x, y, -0.35, -6.3, 3.3, 1.05), 0.8);
  d = smin(d, sdEllipse(x, y, -0.1, -12.3, 3.05, 1.0), 0.8);
  return smin(d, stalkSpurs(x, y), 1) + noise.fbm(x * 0.5, y * 0.5, 2) * 0.3;
}

function anchorStalk(): AtlasImage {
  const tip = [0.4, 0.09, 0.15];
  return bake({
    name: 'anchorStalk', x0: -8, y0: -ANCHOR_STALK_LENGTH - 5, x1: 8, y1: 4, density: DENSITY, sdf: stalkSdf, normalBand: 3,
    shade: (x, y, d, nx, ny, out) => {
      barkColor(x, y, d, nx, ny, 2.8, out);
      const fibre = 0.84 + 0.16 * Math.sin(x * 2.4 + noise.noise2(x * 0.4, y * 0.12) * 3);
      let c = [(out[0] as number) * fibre, (out[1] as number) * fibre, (out[2] as number) * fibre];
      if (stalkSpurs(x, y) < 0.4) c = mix3(c, tip, smoothstep(3.2, 5.4, Math.abs(x)) * 0.85);
      out[0] = c[0] as number;
      out[1] = c[1] as number;
      out[2] = c[2] as number;
      return 1;
    },
  });
}

/**
 * The light in one of the pod's ring grooves (premultiplied, pure emission): a thin band that wraps the
 * pod (curving slightly with it), rose with a hot core. One sprite per groove, scaled to the pod's width
 * there; the view lights them in turn over the anchor's cycle.
 */
function anchorRing(): AtlasImage {
  const w = 48;
  const h = 16;
  return bakeLight({
    name: 'anchorRing', x0: 0, y0: 0, x1: w, y1: h, density: 1,
    texel: (px, py, out) => {
      const x = (px / w) * 2 - 1;
      const y = (py / h) * 2 - 1;
      const across = 1 - x * x;
      const yc = y - 0.28 * across;
      const band = Math.exp(-(yc * yc) / (2 * 0.2 * 0.2)) * Math.pow(Math.max(0, across), 0.7);
      const hot = Math.exp(-(yc * yc) / (2 * 0.1 * 0.1)) * Math.pow(Math.max(0, across), 1.4);
      const edge = (1 - smoothstep(0.82, 1, Math.abs(x))) * (1 - smoothstep(0.7, 1, Math.abs(y)));
      const e = band * 0.8 * edge;
      const k = hot * 0.6 * edge;
      out[0] = ROSE[0] * e + ROSE_HOT[0] * k;
      out[1] = ROSE[1] * e + ROSE_HOT[1] * k;
      out[2] = ROSE[2] * e + ROSE_HOT[2] * k;
      out[3] = 0;
    },
  });
}

export function buildSpitterImages(): AtlasImage[] {
  return [roots(), stem(), bulb(), bulbGlow(), leaf(), anchorStalk(), anchorPod(), anchorRing()];
}
