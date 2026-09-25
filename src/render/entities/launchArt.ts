import { createRaster, smoothstep, type AtlasImage } from '../hero/atlas.ts';

/**
 * Spirit Launch marks for the entity atlas (§5.5), white emissive (premultiplied, alpha 0) so they add
 * inside the seeds' normal-blend batch and take their colour from the sprite tint:
 * - `launchRing`: a thin ring with three brighter arcs and three small beads between them (radius 1 at
 *   scale 1 of its frame, the ring line at r ≈ 0.8), so its slow spin reads;
 * - `aimArrow`: a slim light beam with a chevron head, pivot at the hero end, pointing +x, 90 u long.
 */

export const RING_LINE = 0.8;
/** The frame leaves room for the chevron's glow (σ 4.5) and the tip spark (σ 3) to fall to 0. */
export const AIM_ARROW = Object.freeze({ length: 90, halfHeight: 22, tail: 14, density: 2 });

function launchRing(): AtlasImage {
  const n = 128;
  const raster = createRaster(n, n);
  const { data } = raster;
  const px = 2 / n;
  for (let py = 0; py < n; py++) {
    for (let qx = 0; qx < n; qx++) {
      const x = ((qx + 0.5) / n) * 2 - 1;
      const y = ((py + 0.5) / n) * 2 - 1;
      const r = Math.hypot(x, y);
      let a = Math.atan2(y, x);
      if (a < 0) a += Math.PI * 2;
      const sector = (a / (Math.PI * 2)) * 3;
      const f = sector - Math.floor(sector);
      // Three bright arcs (≈ 70° each) joined by a faint hairline; a bead in each gap.
      const arc = smoothstep(0.0, 0.1, f) * (1 - smoothstep(0.55, 0.66, f));
      const d = Math.abs(r - RING_LINE);
      const line = Math.exp(-(d * d) / (2 * (1.3 * px) ** 2));
      const halo = Math.exp(-(d * d) / (2 * (5 * px) ** 2));
      const beadA = (Math.floor(sector) + 0.83) * ((Math.PI * 2) / 3);
      const bx = Math.cos(beadA) * RING_LINE;
      const by = Math.sin(beadA) * RING_LINE;
      const bead = Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / (2 * (2.2 * px) ** 2));
      const inner = Math.exp(-((RING_LINE - r) > 0 ? (RING_LINE - r) : 1) * 7) * 0.08 * (r < RING_LINE ? 1 : 0);
      const e = Math.min(1, line * (0.3 + 0.7 * arc) + halo * (0.12 + 0.2 * arc) + bead * 0.9 + inner) * (1 - smoothstep(0.93, 1, r));
      const o = (py * n + qx) * 4;
      data[o] = e;
      data[o + 1] = e;
      data[o + 2] = e;
      data[o + 3] = 0;
    }
  }
  return { name: 'launchRing', raster, pivotX: n / 2, pivotY: n / 2, density: n / 2, premultiplied: true };
}

/** Distance from (x, y) to the segment a→b. */
function segDist(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const h = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - ax - dx * h, y - ay - dy * h);
}

function aimArrow(): AtlasImage {
  const { length: L, halfHeight: H, tail, density } = AIM_ARROW;
  const x0 = -2;
  const x1 = L + tail;
  const w = Math.ceil((x1 - x0) * density);
  const h = Math.ceil(2 * H * density);
  const raster = createRaster(w, h);
  const { data } = raster;
  const headX = L - 11;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const x = x0 + (px + 0.5) / density;
      const y = -H + (py + 0.5) / density;
      // The beam fades in away from the hero and swells toward the head.
      const beamD = x < headX + 2 ? Math.abs(y) : Infinity;
      const beamK = smoothstep(2, 30, x) * (1 - smoothstep(headX - 1, headX + 2, x));
      const beamW = 1.3 + 0.7 * smoothstep(10, headX, x);
      const beam = Math.exp(-(beamD * beamD) / (2 * beamW * beamW)) * beamK;
      const beamGlow = Math.exp(-(beamD * beamD) / (2 * 4.5 * 4.5)) * beamK * 0.3;
      // Chevron head: two strokes swept back from the tip.
      const tip = L - 0.5;
      const cd = Math.min(segDist(x, y, tip, 0, tip - 11, -8.5), segDist(x, y, tip, 0, tip - 11, 8.5));
      const chevron = Math.exp(-(cd * cd) / (2 * 1.45 * 1.45));
      const chevronGlow = Math.exp(-(cd * cd) / (2 * 4.5 * 4.5)) * 0.35;
      const spark = Math.exp(-((x - tip) ** 2 + y * y) / (2 * 3 * 3)) * 0.7;
      const e = Math.min(1, beam * 0.9 + beamGlow + chevron + chevronGlow + spark);
      const o = (py * w + px) * 4;
      data[o] = e;
      data[o + 1] = e;
      data[o + 2] = e;
      data[o + 3] = 0;
    }
  }
  return { name: 'aimArrow', raster, pivotX: -x0 * density, pivotY: h / 2, density, premultiplied: true };
}

export function buildLaunchImages(): AtlasImage[] {
  return [launchRing(), aimArrow()];
}
