import { PALETTE, TILE } from '../../config.ts';
import { coverage, opSubtract, sdCircle, sdCurve, sdEllipse, sdRoundBox, sdTaperedCapsule, smin } from '../gen/sdf.ts';
import { mix3, rgb, smoothstep, type AtlasImage } from '../hero/atlas.ts';
import { bake, bakeLight, entityNoise, LIGHT, stoneShade, type Sdf } from './entityBake.ts';

/**
 * AbilityShrine parts for the entity atlas (§5.5): a squat mossy stone pedestal with a shallow bowl and a
 * carved sprout glyph, and the lantern-seed that floats above it, a ribbed husk (five papery lobes like
 * a winter-cherry lantern) with a sprout curl on top. Its light is a separate emissive image (the glow
 * through the panels, a bright seed inside, a soft spill) so the view can dim it once the ability is
 * taken. The glyph's light is emissive too. Pivots: the pedestal's bottom centre; the seed's centre.
 */

const PEDESTAL_HEIGHT = 40;
const SEED_HOVER = TILE;

export const SHRINE_ART = Object.freeze({
  /** Pedestal height (u): the bowl's rim above its feet. */
  pedestalHeight: PEDESTAL_HEIGHT,
  /** The lantern-seed's centre floats this far above the rim (≈ 1 tile), whatever the shrine rect's height. */
  seedHover: SEED_HOVER,
  /** Its centre relative to the pedestal's feet (the shrine rect's bottom centre). */
  seedY: -(PEDESTAL_HEIGHT + SEED_HOVER),
});

const noise = entityNoise;
const SPIRIT = rgb(PALETTE.spiritGlow);

/** Sprout glyph: a stem, two leaves and a seed (distance to its strokes, pedestal space). */
function glyphDist(x: number, y: number): number {
  // Exact wherever the glyph's glow still shows (≥ 1/255), so its halo never takes the box's shape.
  if (Math.abs(x) > 16 || y > 3 || y < -40) return Math.max(Math.abs(x) - 7, y + 7, -30 - y);
  const stemD = sdTaperedCapsule(x, y, 0, -9, 0, -22, 0.9, 0.9);
  const leafL = sdCurve(x, y, 0, -15.5, -2.6, -16.5, -4.6, -20.5, 0.85, 0.4, 4);
  const leafR = sdCurve(x, y, 0, -15.5, 2.6, -16.5, 4.6, -20.5, 0.85, 0.4, 4);
  const seed = Math.abs(sdCircle(x, y, 0, -25.4, 2.2)) - 0.75;
  return Math.min(stemD, leafL, leafR, seed);
}

function pedestalSdf(x: number, y: number): number {
  const plinth = sdRoundBox(x, y, 0, -3.2, 21, 3.4, 1.6);
  const t = Math.min(1, Math.max(0, (-y - 6) / 25));
  const xs = x / (1 - 0.2 * t);
  const column = sdRoundBox(xs, y, 0, -18.5, 11, 12.5, 2.2);
  const cap = opSubtract(sdRoundBox(x, y, 0, -34.5, 18.5, 4.4, 2.2), sdEllipse(x, y, 0, -44.5, 15.5, 7.5));
  const collar = sdRoundBox(x, y, 0, -30.2, 13.5, 1.6, 0.8);
  let d = Math.min(plinth, column, cap, collar);
  d = smin(d, Math.min(plinth, column), 1);
  return d + noise.fbm(x * 0.14, y * 0.14, 3) * 1.1;
}

function pedestal(): AtlasImage {
  const moss = (x: number, y: number): number => {
    const top = smoothstep(-35, -39.5, y) * smoothstep(0.3, 0.55, noise.fbm(x * 0.2, y * 0.2, 3) * 0.5 + 0.6);
    const drip = smoothstep(0.55, 0.63, noise.fbm(x * 0.22 + 4, y * 0.05, 3) * 0.5 + 0.5) * smoothstep(-16, -32, y) * smoothstep(3, -8, x);
    const foot = smoothstep(-4, -7.5, y) * smoothstep(0.45, 0.6, noise.fbm(x * 0.3 + 9, 3, 2) * 0.5 + 0.5) * smoothstep(-1, -6, y);
    return Math.min(1, Math.max(top, drip, foot * 0.7));
  };
  const stone = stoneShade(6, moss);
  return bake({
    name: 'shrinePedestal', x0: -24, y0: -42, x1: 24, y1: 2, density: 2.5, sdf: pedestalSdf, normalBand: 6,
    shade: (x, y, d, nx, ny, out) => {
      const a = stone(x, y, d, nx, ny, out);
      // The carved glyph: a dark groove with a faint inner lip.
      const g = glyphDist(x, y);
      const groove = 1 - smoothstep(-0.2, 0.9, g);
      const k = 1 - groove * 0.7;
      out[0] = (out[0] as number) * k;
      out[1] = (out[1] as number) * k;
      out[2] = (out[2] as number) * k;
      return a;
    },
  });
}

/** The glyph's light (premultiplied emission, white; tinted at draw time). Pivot = the pedestal's feet. */
function glyphLight(): AtlasImage {
  return bakeLight({
    name: 'shrineGlyph', x0: -13, y0: -37, x1: 13, y1: -1, density: 3,
    texel: (x, y, out) => {
      const g = glyphDist(x, y);
      const e = coverage(g + 0.15, 0.4) * 0.95 + Math.exp(-Math.max(0, g) * 0.9) * 0.3;
      out[0] = e;
      out[1] = e;
      out[2] = e;
      out[3] = 0;
    },
  });
}

/** Lantern-seed husk: a teardrop of five papery lobes, a curled sprout on top and a small point below. */
function huskBody(x: number, y: number): number {
  const belly = sdEllipse(x, y, 0, 1.5, 9.6, 9.4);
  const cone = sdTaperedCapsule(x, y, 0, 0, 0, -11.5, 8.6, 1.4);
  const tipD = sdTaperedCapsule(x, y, 0, 8, 0, 12.2, 2.4, 0.4);
  return smin(smin(belly, cone, 3.2), tipD, 1.6);
}

function sprout(x: number, y: number): number {
  return Math.min(
    sdCurve(x, y, 0, -11, 0.4, -15.5, 3.6, -17.4, 0.9, 0.45, 5),
    sdCurve(x, y, 3.6, -17.4, 6.2, -18.8, 5.6, -15.6, 0.45, 0.25, 4),
  );
}

function seedSdf(x: number, y: number): number {
  return Math.min(huskBody(x, y), sprout(x, y));
}

/** Rib lines of the husk: foreshortened lobes around the vertical axis (0 on a rib). */
function ribDist(x: number, y: number): number {
  const hw = Math.max(1, 9.6 * Math.sqrt(Math.max(0, 1 - ((y - 1.5) / 9.4) ** 2)), 8.6 * (1 - (-y) / 12));
  const u = Math.asin(Math.max(-1, Math.min(1, x / hw))) / (Math.PI / 2);
  const lobes = 2.5;
  const f = (u + 1) * lobes;
  const nearest = Math.abs(f - Math.round(f)) / lobes;
  return nearest * hw * 1.4;
}

function lanternSeed(): AtlasImage {
  const sdf: Sdf = seedSdf;
  const L3 = Math.hypot(LIGHT.x * 0.8, LIGHT.y * 0.8, 0.6);
  return bake({
    name: 'lanternSeed', x0: -12, y0: -21, x1: 12, y1: 14, density: 3, sdf, normalBand: 4,
    shade: (x, y, d, nx, ny, out) => {
      const e = 1 - Math.min(1, Math.max(0, -d / 4));
      const nz = Math.sqrt(Math.max(0, 1 - e * e));
      const diff = Math.max(0, (nx * e * LIGHT.x * 0.8 + ny * e * LIGHT.y * 0.8 + nz * 0.6) / L3);
      let c = mix3([0.05, 0.08, 0.1], [0.22, 0.3, 0.34], Math.pow(diff, 1.8));
      const facing = Math.max(0, nx * LIGHT.x + ny * LIGHT.y);
      c = mix3(c, [0.6, 0.78, 0.84], smoothstep(0.65, 0.98, e) * Math.pow(facing, 1.4) * 0.8);
      if (sprout(x, y) < huskBody(x, y)) {
        c = mix3(c, [0.16, 0.32, 0.28], 0.6);
      } else {
        const rib = 1 - smoothstep(0.15, 0.9, ribDist(x, y));
        c = mix3(c, [0.02, 0.03, 0.04], rib * 0.75);
        // Papery veins.
        const vein = smoothstep(0.7, 0.95, noise.ridged(x * 0.5 + 2, y * 0.22, 2));
        c = mix3(c, [c[0] * 0.6, c[1] * 0.6, c[2] * 0.6], vein * 0.4);
      }
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      return 1;
    },
  });
}

/** The lantern-seed's light: through the panels between the ribs, a bright seed inside, a soft spill. */
function lanternSeedLight(): AtlasImage {
  const aa = 1 / 3;
  const deep = [0.3, 0.7, 0.95];
  return bakeLight({
    name: 'lanternSeedLight', x0: -18, y0: -24, x1: 18, y1: 20, density: 3,
    texel: (x, y, out) => {
      const inside = coverage(huskBody(x, y) + 0.6, aa);
      const rib = smoothstep(0.2, 1.4, ribDist(x, y));
      const r = Math.hypot(x, (y - 1.2) * 0.95);
      const seedCore = Math.exp(-r * r * 0.05);
      const panel = inside * (0.3 + 0.7 * rib) * (0.35 + 0.65 * Math.exp(-r * r * 0.012));
      const spill = Math.exp(-r * 0.24) * 0.3 * (1 - inside * 0.5);
      const e = panel * 0.75 + seedCore * 0.9 + spill;
      const c = mix3(deep, SPIRIT, smoothstep(0.2, 0.9, seedCore + panel * 0.3));
      const white = seedCore * 0.8;
      out[0] = c[0] * e + white * (1 - c[0]) * 0.7;
      out[1] = c[1] * e + white * (1 - c[1]) * 0.7;
      out[2] = c[2] * e + white * (1 - c[2]) * 0.7;
      out[3] = 0;
    },
  });
}

export function buildAbilityShrineImages(): AtlasImage[] {
  return [pedestal(), glyphLight(), lanternSeed(), lanternSeedLight()];
}
