import type { Container } from 'pixi.js';
import type { CameraFrame } from '../../contracts/render.ts';
import type { CameraView } from '../../contracts/sim.ts';
import { DEPTH_INSTANCE_EPS } from '../../config.ts';
import { clamp } from '../../core/math.ts';

/** Depth for a parallax factor (ARCHITECTURE.md §2.4): terrain 0.05 … farthest ≈ 0.95. */
export function depthForParallax(f: number): number {
  return 0.05 + 0.9 * (1 - clamp(f, 0, 1));
}

/**
 * Depth of instance `k` (painter order, 0 = backmost) inside a layer, so overlapping instances in one
 * layer resolve front-over-back under depth test LESS.
 */
export function depthForInstance(f: number, k: number): number {
  return depthForParallax(f) - k * DEPTH_INSTANCE_EPS;
}

export function zoomForParallax(zoom: number, f: number): number {
  return 1 + (zoom - 1) * f;
}

/**
 * Place a parallax layer container: layer-space p maps to view = (p − C·f)·zoomF + V/2 (+ shake·min(f,1)).
 * Works for world-space slots too (f = 1).
 */
export function applyParallax(container: Container, cam: CameraFrame, fx: number, fy: number): void {
  const zx = zoomForParallax(cam.zoom, fx);
  const zy = zoomForParallax(cam.zoom, fy);
  const sx = cam.shakeX * Math.min(fx, 1);
  const sy = cam.shakeY * Math.min(fy, 1);
  container.scale.set(zx, zy);
  container.position.set(cam.viewW * 0.5 - cam.cx * fx * zx + sx, cam.viewH * 0.5 - cam.cy * fy * zy + sy);
}

export interface Extent {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Layer-space region a layer must cover so no gap shows anywhere the (level-clamped) camera can go.
 * `minZoom` is the smallest camera zoom used (zooming out shows more).
 */
export function layerExtent(
  levelW: number, levelH: number, viewW: number, viewH: number, fx: number, fy: number, minZoom = 1, out?: Extent,
): Extent {
  const e = out ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
  const halfWorldW = viewW / (2 * minZoom);
  const halfWorldH = viewH / (2 * minZoom);
  const cMinX = Math.min(halfWorldW, levelW / 2);
  const cMaxX = Math.max(levelW - halfWorldW, levelW / 2);
  const cMinY = Math.min(halfWorldH, levelH / 2);
  const cMaxY = Math.max(levelH - halfWorldH, levelH / 2);
  const hx = viewW / (2 * zoomForParallax(minZoom, fx));
  const hy = viewH / (2 * zoomForParallax(minZoom, fy));
  e.x0 = cMinX * fx - hx;
  e.x1 = cMaxX * fx + hx;
  e.y0 = cMinY * fy - hy;
  e.y1 = cMaxY * fy + hy;
  return e;
}

/** Layer-space rect currently visible for a parallax layer. */
export function visibleLayerRect(cam: CameraFrame, fx: number, fy: number, out: Extent): Extent {
  const zx = zoomForParallax(cam.zoom, fx);
  const zy = zoomForParallax(cam.zoom, fy);
  const hx = cam.viewW / (2 * zx);
  const hy = cam.viewH / (2 * zy);
  const sx = (cam.shakeX * Math.min(fx, 1)) / zx;
  const sy = (cam.shakeY * Math.min(fy, 1)) / zy;
  out.x0 = cam.cx * fx - hx - sx;
  out.x1 = cam.cx * fx + hx - sx;
  out.y0 = cam.cy * fy - hy - sy;
  out.y1 = cam.cy * fy + hy - sy;
  return out;
}

/** Fill `out` with the interpolated camera for this render frame (a snap already set prev = cur). */
export function computeCameraFrame(out: CameraFrame, cam: CameraView, alpha: number, shakeX = 0, shakeY = 0): CameraFrame {
  out.cx = cam.prevX + (cam.x - cam.prevX) * alpha;
  out.cy = cam.prevY + (cam.y - cam.prevY) * alpha;
  out.zoom = cam.prevZoom + (cam.zoom - cam.prevZoom) * alpha;
  out.viewW = cam.viewW;
  out.viewH = cam.viewH;
  out.width = cam.viewW / out.zoom;
  out.height = cam.viewH / out.zoom;
  out.left = out.cx - out.width / 2;
  out.top = out.cy - out.height / 2;
  out.shakeX = shakeX;
  out.shakeY = shakeY;
  return out;
}

export function createCameraFrame(): CameraFrame {
  return { cx: 0, cy: 0, zoom: 1, viewW: 0, viewH: 0, left: 0, top: 0, width: 0, height: 0, shakeX: 0, shakeY: 0 };
}

/** Linear interpolation helper for prev/cur pairs. */
export function interp(prev: number, cur: number, alpha: number): number {
  return prev + (cur - prev) * alpha;
}
