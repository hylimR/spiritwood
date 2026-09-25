/**
 * How much of the moon a plate hides (ARCHITECTURE.md §5.8 art review): the sky's moon is screen-fixed
 * while a plate moves with its parallax, so a plate can cover it at some camera positions and not others.
 * The camera is swept over an area's range (every aspect, the area's x range, every height the sim camera
 * takes over the area's walkable surfaces, the aim zoom) and the plate's alpha is averaged over the moon
 * disc at each position.
 *
 *   node tools/art/moon.ts [area] [plate id …]     (default: glade, every art plate)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { MAX_ASPECT, MIN_ASPECT, TILE, VIEW_H } from '../../src/config.ts';
import { parseManifest } from '../../src/assets/manifest.ts';
import type { SkyLayerDef } from '../../src/contracts/assets.ts';
import { TileKind, type LevelData } from '../../src/contracts/level.ts';
import { tileAt } from '../../src/core/tiles.ts';
import { parseLdtk } from '../../src/level/loader.ts';
import { zoomForParallax } from '../../src/render/util/camera.ts';
import { DEFAULT_CAMERA_TUNING, DEFAULT_TUNING } from '../../src/sim/tuning.ts';
import { scanPlates } from './bake.ts';
import { artPaths } from './paths.ts';
import { resolveArea, type TemplateArea } from './templates.ts';

/** The art review's limit: a plate may hide at most this much of the moon disc anywhere in its area. */
export const MOON_COVERAGE_LIMIT = 0.2;

export interface CameraRange {
  /** The area's x range (world units): the camera centre follows the hero across it. */
  x0: number;
  x1: number;
  /** Camera centre y the sim camera aims for over the area, before clamping to the level. */
  top: number;
  bottom: number;
  levelW: number;
  levelH: number;
  aspects: number[];
  zooms: number[];
}

function clampCentre(v: number, half: number, size: number): number {
  return size <= 2 * half ? size / 2 : Math.min(size - half, Math.max(half, v));
}

/** Where the camera centre can be at one aspect and zoom (the sim clamps the view to the level). */
export function cameraBounds(r: CameraRange, aspect: number, zoom: number): { viewW: number; cx0: number; cx1: number; cy0: number; cy1: number } {
  const viewW = VIEW_H * aspect;
  const hw = viewW / (2 * zoom);
  const hh = VIEW_H / (2 * zoom);
  return {
    viewW,
    cx0: clampCentre(r.x0, hw, r.levelW),
    cx1: clampCentre(r.x1, hw, r.levelW),
    cy0: clampCentre(r.top, hh, r.levelH),
    cy1: clampCentre(r.bottom, hh, r.levelH),
  };
}

/**
 * Where the sim camera can be while the hero is in `area`: every aspect, x from the area's left to right
 * end, and y from the highest walkable surface (feet + targetOffsetY, less half the dead zone, less the
 * part of a double jump the camera follows past airRiseMargin) to the lowest (plus half the dead zone and
 * the look-down), clamped to the level; zoom 1 and the Spirit Launch aim zoom.
 */
export function areaCameraRange(level: LevelData, area: TemplateArea): CameraRange {
  const cam = DEFAULT_CAMERA_TUNING;
  let top = Infinity;
  let bottom = -Infinity;
  const tx0 = Math.max(0, Math.floor(area.x0 / TILE));
  const tx1 = Math.min(level.widthTiles, Math.ceil(area.x1 / TILE));
  for (let tx = tx0; tx < tx1; tx++) {
    for (let ty = 1; ty < level.heightTiles; ty++) {
      const k = tileAt(level, tx, ty);
      const above = tileAt(level, tx, ty - 1);
      const walkable = (k === TileKind.Solid || k === TileKind.OneWay) && above !== TileKind.Solid && above !== TileKind.OneWay;
      if (!walkable) continue;
      top = Math.min(top, ty * TILE);
      bottom = Math.max(bottom, ty * TILE);
    }
  }
  if (!Number.isFinite(top)) top = bottom = level.playerStart.y;
  const rise = Math.max(0, DEFAULT_TUNING.jumpHeight + DEFAULT_TUNING.airJumps * DEFAULT_TUNING.airJumpHeight - cam.airRiseMargin);
  return {
    x0: area.x0,
    x1: area.x1,
    top: top + cam.targetOffsetY - cam.deadZoneH / 2 - rise,
    bottom: bottom + cam.targetOffsetY + cam.deadZoneH / 2 + cam.lookDownMax,
    levelW: level.pxWidth,
    levelH: level.pxHeight,
    aspects: [MIN_ASPECT, 16 / 9, MAX_ASPECT],
    zooms: [1, Math.max(1, cam.aimZoom)],
  };
}

/** A plate image in its layer space. */
export interface PlateImage {
  rgba: Uint8Array;
  width: number;
  height: number;
  origin: [number, number];
  texelScale: number;
  parallax: [number, number];
}

export interface MoonCoverage {
  /** Largest fraction of the disc hidden (alpha-weighted), and the camera where it happens. */
  max: number;
  aspect: number;
  cx: number;
  cy: number;
  zoom: number;
  /** Fraction of the swept camera positions with any coverage above 1 %. */
  touched: number;
}

function alphaAt(p: PlateImage, lx: number, ly: number): number {
  const x = Math.floor((lx - p.origin[0]) / p.texelScale);
  const y = Math.floor((ly - p.origin[1]) / p.texelScale);
  if (x < 0 || y < 0 || x >= p.width || y >= p.height) return 0;
  return (p.rgba[(y * p.width + x) * 4 + 3] as number) / 255;
}

/** The moon's centre in a layer's space for a camera centre (cx, cy): view position unscaled by the layer's zoom. */
function moonInLayer(sky: SkyLayerDef, viewW: number, zoom: number, fx: number, fy: number): { mx: number; my: number; rx: number; ry: number } {
  const zx = zoomForParallax(zoom, fx);
  const zy = zoomForParallax(zoom, fy);
  return {
    mx: (sky.moon.x * viewW - viewW / 2) / zx,
    my: (sky.moon.y * VIEW_H - VIEW_H / 2) / zy,
    rx: sky.moon.radius / zx,
    ry: sky.moon.radius / zy,
  };
}

/**
 * The layer-space box the moon disc sweeps over the camera range, for a layer at parallax (fx, fy): what
 * a plate there must keep clear of (only sparse strands may cross it).
 */
export function moonSweepBox(sky: SkyLayerDef, range: CameraRange, fx: number, fy: number): { x0: number; y0: number; x1: number; y1: number } {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const zoom of range.zooms) {
    for (const aspect of range.aspects) {
      const c = cameraBounds(range, aspect, zoom);
      const m = moonInLayer(sky, c.viewW, zoom, fx, fy);
      b.x0 = Math.min(b.x0, m.mx + c.cx0 * fx - m.rx);
      b.x1 = Math.max(b.x1, m.mx + c.cx1 * fx + m.rx);
      b.y0 = Math.min(b.y0, m.my + c.cy0 * fy - m.ry);
      b.y1 = Math.max(b.y1, m.my + c.cy1 * fy + m.ry);
    }
  }
  return b;
}

/**
 * Sweep `range` in `step`-unit camera steps and return the worst coverage of the moon disc (sampled every
 * `sample` view units) by the plate.
 */
export function moonCoverage(p: PlateImage, sky: SkyLayerDef, range: CameraRange, step = 8, sample = 2): MoonCoverage {
  const [fx, fy] = p.parallax;
  const r = sky.moon.radius;
  const offsets: [number, number][] = [];
  for (let dy = -r + sample / 2; dy < r; dy += sample) {
    for (let dx = -r + sample / 2; dx < r; dx += sample) if (dx * dx + dy * dy <= r * r) offsets.push([dx, dy]);
  }
  const worst: MoonCoverage = { max: 0, aspect: 16 / 9, cx: 0, cy: 0, zoom: 1, touched: 0 };
  let n = 0;
  let touched = 0;
  for (const zoom of range.zooms) {
    const zx = zoomForParallax(zoom, fx);
    const zy = zoomForParallax(zoom, fy);
    for (const aspect of range.aspects) {
      const c = cameraBounds(range, aspect, zoom);
      const m = moonInLayer(sky, c.viewW, zoom, fx, fy);
      const xs: number[] = [];
      for (let cx = c.cx0; cx < c.cx1; cx += step) xs.push(cx);
      xs.push(c.cx1);
      const ys: number[] = [];
      for (let cy = c.cy0; cy < c.cy1; cy += step) ys.push(cy);
      ys.push(c.cy1);
      for (const cx of xs) {
        for (const cy of ys) {
          let a = 0;
          for (const [dx, dy] of offsets) a += alphaAt(p, m.mx + dx / zx + cx * fx, m.my + dy / zy + cy * fy);
          const cov = a / offsets.length;
          n++;
          if (cov > 0.01) touched++;
          if (cov > worst.max) Object.assign(worst, { max: cov, aspect, cx, cy, zoom });
        }
      }
    }
  }
  worst.touched = n > 0 ? touched / n : 0;
  return worst;
}

async function main(argv: string[]): Promise<number> {
  const paths = artPaths();
  const level = parseLdtk(JSON.parse(readFileSync(paths.ldtk, 'utf8')));
  const base = parseManifest(JSON.parse(readFileSync(paths.base, 'utf8')));
  const sky = base.layers.find((l): l is SkyLayerDef => l.kind === 'sky');
  if (!sky) throw new Error('the base manifest has no sky layer');
  const [areaArg, ...ids] = argv;
  const area = resolveArea(level, areaArg ?? 'glade');
  const range = areaCameraRange(level, area);
  const views = range.aspects.map((a) => {
    const c = cameraBounds(range, a, 1);
    return `${a.toFixed(2)}:1 x ${c.cx0.toFixed(0)}…${c.cx1.toFixed(0)}`;
  });
  const c1 = cameraBounds(range, 16 / 9, 1);
  console.log(`moon at (${sky.moon.x}, ${sky.moon.y}) of the view, radius ${sky.moon.radius}; ${area.id} cameras: ${views.join(', ')}; y ${c1.cy0.toFixed(0)}…${c1.cy1.toFixed(0)}; zoom ${range.zooms.join(', ')}`);
  const { plates, errors } = await scanPlates(paths);
  for (const e of errors) console.warn(`warning: ${e}`);
  let over = 0;
  for (const s of plates) {
    if (ids.length > 0 && !ids.includes(s.id)) continue;
    const { data, info } = await sharp(join(paths.plates, `${s.id}.png`), { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const img: PlateImage = {
      rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height,
      origin: s.sidecar.origin, texelScale: s.sidecar.texelScale, parallax: s.sidecar.parallax,
    };
    const c = moonCoverage(img, sky, range);
    const ok = c.max <= MOON_COVERAGE_LIMIT;
    if (!ok) over++;
    console.log(`${s.id}: hides at most ${(c.max * 100).toFixed(1)} % of the moon (camera ${c.cx.toFixed(0)}, ${c.cy.toFixed(0)} at ${c.aspect.toFixed(2)}:1, zoom ${c.zoom}); touches it at ${(c.touched * 100).toFixed(0)} % of the positions  ${ok ? 'ok' : `OVER ${MOON_COVERAGE_LIMIT * 100} %`}`);
  }
  return over > 0 ? 1 : 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = await main(process.argv.slice(2));
