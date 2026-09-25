import { PALETTE } from '../../config.ts';
import { opIntersect, sdCircle, sdEllipse, sdRoundBox, sdTaperedCapsule, smin } from '../gen/sdf.ts';
import { createRaster, mix3, packAtlas, rgb, smoothstep, type Atlas, type AtlasImage } from '../hero/atlas.ts';
import { buildAbilityShrineImages } from './abilityShrineArt.ts';
import { bake, entityNoise, LIGHT, radial, stoneShade, type Sdf } from './entityBake.ts';
import { buildLaunchImages } from './launchArt.ts';
import { buildSeedImages } from './seedArt.ts';
import { buildSpitterImages } from './spitterArt.ts';

/**
 * CPU-generated atlas for the gameplay entities: spirit-light orbs, lumen stones (checkpoints), the
 * Gloomcrawler and the Moonwell shrine, plus shared glow/beam/sparkle/wisp images; M2 adds the Thorn
 * Spitter parts, seeds and their trail strip, the Spirit Launch ring and aim arrow, and the ability
 * shrine. Stone is shaded as a dark mass with a cool moonlight rim from the upper left, so it reads
 * against the night forest. The atlas is premultiplied: light images carry emissive texels (colour at
 * alpha 0) that add under the entity batches' premultiplied normal blending (§5.5).
 */

export const ENTITY_ATLAS_WIDTH = 512;
export const ENTITY_GUTTER = 6;

const noise = entityNoise;

/** Archimedean spiral line distance (a + b·θ, `turns` turns), for the carved rune. */
function sdSpiral(x: number, y: number, a: number, b: number, turns: number): number {
  const r = Math.hypot(x, y);
  let th = Math.atan2(y, x);
  if (th < 0) th += Math.PI * 2;
  let best = Infinity;
  for (let k = 0; k <= Math.ceil(turns); k++) {
    const t = th + k * Math.PI * 2;
    if (t > turns * Math.PI * 2) break;
    best = Math.min(best, Math.abs(r - (a + b * t)));
  }
  const endT = turns * Math.PI * 2;
  const ex = Math.cos(endT) * (a + b * endT);
  const ey = Math.sin(endT) * (a + b * endT);
  best = Math.min(best, Math.hypot(x - ex, y - ey));
  return best;
}

const RUNE = { a: 0.6, b: 0.95, turns: 2.1 };
/** Rune centre on the lumen stone (stone space: pivot at the bottom centre). */
export const STONE_RUNE_Y = -38;

function lumenStone(): AtlasImage {
  const H = 72;
  const sdf: Sdf = (x, y) => {
    const t = Math.min(1, Math.max(0, -y / H));
    const xs = (x + t * t * 3.5) / (1 - 0.3 * t);
    const body = sdRoundBox(xs, y, 0, -H / 2, 14.5, H / 2, 11) + noise.fbm(x * 0.12, y * 0.12, 3) * 1.8;
    const rubble = Math.min(sdEllipse(x, y, -13.5, -1.2, 5.5, 2.4), sdEllipse(x, y, 13, -0.8, 4.2, 2), sdEllipse(x, y, 18.5, -0.6, 2.4, 1.4));
    return smin(body, rubble, 1.5);
  };
  const moss = (x: number, y: number): number => {
    const cap = smoothstep(-50, -64, y) * 0.9 + smoothstep(-18, -8, y) * 0.5 * smoothstep(0.2, 0.5, noise.noise2(x * 0.3, 5) * 0.5 + 0.5);
    const drip = smoothstep(0.52, 0.6, noise.fbm(x * 0.14 + 7, y * 0.05, 3) * 0.5 + 0.5) * smoothstep(-20, -60, y);
    const left = smoothstep(4, -8, x) * smoothstep(-30, -55, y) * 0.6;
    return Math.min(1, Math.max(cap, drip, left) * smoothstep(0.35, 0.55, noise.fbm(x * 0.2, y * 0.2, 3) * 0.5 + 0.6));
  };
  const stone = stoneShade(9, moss);
  return bake({
    name: 'lumenStone', x0: -24, y0: -78, x1: 24, y1: 2, density: 2.5, sdf, normalBand: 9,
    shade: (x, y, d, nx, ny, out) => {
      const a = stone(x, y, d, nx, ny, out);
      const groove = 1 - smoothstep(0.35, 1.1, sdSpiral(x, y - STONE_RUNE_Y, RUNE.a, RUNE.b, RUNE.turns));
      const k = 1 - groove * 0.65;
      out[0] = (out[0] as number) * k;
      out[1] = (out[1] as number) * k;
      out[2] = (out[2] as number) * k;
      return a;
    },
  });
}

function rune(): AtlasImage {
  const r = RUNE.a + RUNE.b * RUNE.turns * Math.PI * 2 + 2;
  return bake({
    name: 'rune', x0: -r, y0: -r, x1: r, y1: r, density: 3, aa: 3, normalBand: 0,
    sdf: (x, y) => sdSpiral(x, y, RUNE.a, RUNE.b, RUNE.turns) - 1.2,
    shade: (_x, _y, d, _nx, _ny, out) => {
      const core = 1 - smoothstep(-1.2, -0.2, d);
      out[0] = 0.75 + 0.25 * core;
      out[1] = 1;
      out[2] = 0.95 + 0.05 * core;
      return 0.55 + 0.45 * core;
    },
  });
}

/** Back thorns as [angle along the back arc, length, lean]; leans sweep backward like brambles. */
const THORNS: readonly [number, number, number][] = [
  [-0.3, 6, -0.6], [0.0, 9, -0.55], [0.3, 7, -0.4], [0.55, 11, -0.45], [0.8, 8, -0.3], [1.05, 12, -0.35],
  [1.3, 9, -0.25], [1.55, 13, -0.3], [1.8, 10, -0.2], [2.05, 12, -0.25], [2.3, 8, -0.1], [2.55, 9, -0.15],
  [2.8, 6, 0], [0.15, 5, 0.3], [0.95, 6, 0.35], [1.7, 6, 0.3], [2.4, 5, 0.4],
];

function crawlerBody(): AtlasImage {
  const cx = -3;
  const cy = -18;
  const rx = 29;
  const ry = 14;
  const segs = THORNS.map(([t, len, lean]) => {
    const ang = Math.PI + t;
    const bx = cx + Math.cos(ang) * rx * 0.92;
    const by = cy + Math.sin(ang) * ry * 0.92;
    const dir = Math.atan2(by - cy, bx - cx) - 0.5 + lean;
    return [bx, by, bx + Math.cos(dir) * len, by + Math.sin(dir) * len] as const;
  });
  const thorn = (x: number, y: number): number => {
    if (y > cy + 13) return Infinity;
    let d = Infinity;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i] as readonly [number, number, number, number];
      const e = sdTaperedCapsule(x, y, s[0], s[1], s[2], s[3], 2.1, 0.25);
      if (e < d) d = e;
    }
    return d;
  };
  const sdf: Sdf = (x, y) => {
    const mound = opIntersect(sdEllipse(x, y, cx, cy, rx, ry), y + 7);
    const head = sdEllipse(x, y, 22, -12.5, 9.5, 7.5);
    return Math.min(smin(mound, head, 5), thorn(x, y) + 0.2) + noise.fbm(x * 0.2, y * 0.2, 3) * 0.7;
  };
  const base = rgb(PALETTE.silhouette);
  const rimC = [0.26, 0.4, 0.5];
  const tip = [0.62, 0.14, 0.22];
  return bake({
    name: 'crawlerBody', x0: -40, y0: -46, x1: 34, y1: -4, density: 3, sdf, normalBand: 3.5,
    shade: (x, y, d, nx, ny, out) => {
      const e = 1 - Math.min(1, Math.max(0, -d / 3.5));
      const facing = Math.max(0, nx * LIGHT.x + ny * LIGHT.y);
      const grain = noise.fbm(x * 0.5, y * 0.5, 3) * 0.5 + 0.5;
      let c = mix3(base, [0.06, 0.09, 0.13], grain * 0.8);
      c = mix3(c, rimC, smoothstep(0.55, 0.95, e) * Math.pow(facing, 1.2) * 0.75);
      const outer = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (thorn(x, y) < 0.3) c = mix3(c, tip, smoothstep(1.25, 1.75, outer) * 0.8);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      return 1;
    },
  });
}

function crawlerEye(): AtlasImage {
  const core = [1, 0.88, 0.9];
  const edge = rgb(PALETTE.thorns);
  return bake({
    name: 'crawlerEye', x0: -3.2, y0: -2.6, x1: 3.2, y1: 2.6, density: 4, normalBand: 0,
    sdf: (x, y) => sdEllipse(x, y, 0, 0, 2.6, 1.8),
    shade: (_x, _y, d, _nx, _ny, out) => {
      const k = smoothstep(0, 1.4, -d);
      const c = mix3(edge, core, k);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      return 1;
    },
  });
}

/** One leg segment, drawn along +x from the pivot; stretched to length at draw time. */
export const LEG_IMAGE_LENGTH = 10;

function leg(): AtlasImage {
  const rimC = [0.16, 0.26, 0.33];
  return bake({
    name: 'leg', x0: -1.8, y0: -1.8, x1: LEG_IMAGE_LENGTH + 1.8, y1: 1.8, density: 4, normalBand: 1,
    sdf: (x, y) => sdTaperedCapsule(x, y, 0, 0, LEG_IMAGE_LENGTH, 0, 1.25, 0.8),
    shade: (_x, _y, d, _nx, ny, out) => {
      const e = 1 - Math.min(1, Math.max(0, -d / 1));
      const c = mix3(rgb(PALETTE.silhouette), rimC, e * Math.max(0, -ny) * 0.8);
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      return 1;
    },
  });
}

function orbCore(): AtlasImage {
  const warm = rgb(PALETTE.warmAccent);
  const mid = [1, 0.84, 0.58];
  const core = [1, 0.98, 0.93];
  return bake({
    name: 'orbCore', x0: -11, y0: -11, x1: 11, y1: 11, density: 3, aa: 3, normalBand: 0,
    sdf: (x, y) => sdCircle(x, y, 0, 0, 9),
    shade: (_x, _y, d, _nx, _ny, out) => {
      const k = Math.min(1, -d / 9);
      let c = mix3(warm, mid, smoothstep(0, 0.45, k));
      c = mix3(c, core, smoothstep(0.4, 0.9, k));
      out[0] = c[0];
      out[1] = c[1];
      out[2] = c[2];
      return smoothstep(0, 0.4, k) * 0.9 + 0.1;
    },
  });
}

function sparkle(): AtlasImage {
  const size = 32;
  const raster = createRaster(size, size);
  const { data } = raster;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const x = ((px + 0.5) / size) * 2 - 1;
      const y = ((py + 0.5) / size) * 2 - 1;
      const r = Math.hypot(x, y);
      const star = Math.max(Math.exp(-Math.abs(x) * 22) * (1 - Math.abs(y)), Math.exp(-Math.abs(y) * 22) * (1 - Math.abs(x)));
      const a = Math.min(1, star * 1.2 + Math.exp(-r * r * 30)) * (1 - smoothstep(0.85, 1, r));
      const o = (py * size + px) * 4;
      data[o] = 1;
      data[o + 1] = 1;
      data[o + 2] = 1;
      data[o + 3] = a;
    }
  }
  return { name: 'sparkle', raster, pivotX: size / 2, pivotY: size / 2, density: size / 2 };
}

/** Vertical light column, pivot at the bottom centre (stretched to size at draw time). */
function beam(): AtlasImage {
  const w = 32;
  const h = 128;
  const raster = createRaster(w, h);
  const { data } = raster;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const u = ((px + 0.5) / w) * 2 - 1;
      const v = (py + 0.5) / h;
      const across = Math.exp(-u * u * 5) * (1 - smoothstep(0.8, 1, Math.abs(u)));
      const along = smoothstep(0, 0.55, v) * (1 - smoothstep(0.93, 1, v) * 0.4);
      const o = (py * w + px) * 4;
      data[o] = 1;
      data[o + 1] = 1;
      data[o + 2] = 1;
      data[o + 3] = across * along;
    }
  }
  return { name: 'beam', raster, pivotX: w / 2, pivotY: h, density: 1 };
}

function moonArch(): AtlasImage {
  const sdf: Sdf = (x, y) => {
    const pillarL = sdRoundBox(x, y, -42, -44, 9, 44, 3);
    const pillarR = sdRoundBox(x, y, 42, -44, 9, 44, 3);
    const ringD = Math.abs(Math.hypot(x, y + 84) - 42) - 7.5;
    const arch = opIntersect(ringD, y + 84);
    const key = sdRoundBox(x, y, 0, -128, 6.5, 8, 2);
    const plinthL = sdRoundBox(x, y, -42, -3, 13, 3.5, 1.5);
    const plinthR = sdRoundBox(x, y, 42, -3, 13, 3.5, 1.5);
    return Math.min(pillarL, pillarR, arch, key, plinthL, plinthR) + noise.fbm(x * 0.1, y * 0.1, 3) * 1.4;
  };
  const moss = (x: number, y: number): number => {
    const top = smoothstep(-108, -126, y) * smoothstep(0.3, 0.5, noise.fbm(x * 0.15, y * 0.15, 3) * 0.5 + 0.55);
    const hang = smoothstep(0.55, 0.62, noise.fbm(x * 0.2 + 3, y * 0.04, 3) * 0.5 + 0.5) * smoothstep(-60, -110, y);
    return Math.min(1, Math.max(top, hang));
  };
  return bake({ name: 'moonArch', x0: -58, y0: -140, x1: 58, y1: 2, density: 2, sdf, normalBand: 6, shade: stoneShade(6, moss) });
}

/** Hanging lantern; pivot at the hang point (top of the chain), body below. */
function lantern(): AtlasImage {
  const glass: Sdf = (x, y) => sdRoundBox(x, y, 0, 13.5, 3.6, 5, 1.8);
  const metal: Sdf = (x, y) => Math.min(
    sdRoundBox(x, y, 0, 0, 0.35, 6, 0.2),
    sdRoundBox(x, y, 0, 7.6, 4.6, 1.3, 0.8),
    sdRoundBox(x, y, 0, 19.3, 4.2, 1, 0.6),
    sdCircle(x, y, 0, 21.4, 1.1),
    sdRoundBox(x, y, -3.4, 13.5, 0.35, 4.6, 0.2),
    sdRoundBox(x, y, 3.4, 13.5, 0.35, 4.6, 0.2),
  );
  const warm = rgb(PALETTE.warmAccent);
  return bake({
    name: 'lantern', x0: -6, y0: -1, x1: 6, y1: 24, density: 4, normalBand: 0,
    sdf: (x, y) => Math.min(glass(x, y), metal(x, y)),
    shade: (x, y, _d, _nx, _ny, out) => {
      if (metal(x, y) > 0) {
        const k = smoothstep(0, 3, -glass(x, y));
        const c = mix3(warm, [1, 0.96, 0.84], k);
        out[0] = c[0];
        out[1] = c[1];
        out[2] = c[2];
      } else {
        const lit = smoothstep(2, -2, x) * 0.08;
        out[0] = 0.07 + lit;
        out[1] = 0.065 + lit;
        out[2] = 0.07 + lit;
      }
      return 1;
    },
  });
}

function pool(): AtlasImage {
  const w = 128;
  const h = 32;
  const raster = createRaster(w, h);
  const { data } = raster;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = ((px + 0.5) / w) * 2 - 1;
      const y = ((py + 0.5) / h) * 2 - 1;
      const r = Math.hypot(x, y);
      const a = Math.pow(Math.max(0, 1 - r), 1.4);
      const c = mix3([0.5, 0.88, 1], [0.95, 1, 1], smoothstep(0.2, 0.85, 1 - r));
      const o = (py * w + px) * 4;
      data[o] = c[0];
      data[o + 1] = c[1];
      data[o + 2] = c[2];
      data[o + 3] = a;
    }
  }
  return { name: 'pool', raster, pivotX: w / 2, pivotY: h / 2, density: w / 80 };
}

export function buildEntityImages(): AtlasImage[] {
  return [
    lumenStone(), rune(), crawlerBody(), crawlerEye(), leg(), orbCore(), sparkle(), beam(), moonArch(),
    lantern(), pool(),
    radial('glow', 64, (r) => Math.pow(1 - r, 2) * (1 - smoothstep(0.85, 1, r))),
    radial('wisp', 32, (r) => Math.pow(1 - r, 1.6) * 0.9, rgb(0x0a1420)),
    radial('ring', 64, (r) => Math.exp(-((r - 0.82) ** 2) * 180)),
    ...buildSpitterImages(), ...buildSeedImages(), ...buildLaunchImages(), ...buildAbilityShrineImages(),
  ];
}

/** The premultiplied entity atlas (upload with textureFromRgba `premultiply: false`). */
export function buildEntityAtlas(): Atlas {
  return packAtlas(buildEntityImages(), ENTITY_ATLAS_WIDTH, ENTITY_GUTTER, true);
}
