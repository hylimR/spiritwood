import { describe, expect, test } from 'vitest';
import { Container } from 'pixi.js';
import {
  applyParallax, computeCameraFrame, createCameraFrame, depthForParallax, layerExtent, visibleLayerRect, type Extent,
} from '../../src/render/util/camera.ts';
import type { CameraView } from '../../src/contracts/sim.ts';

function cam(x: number, y: number, zoom = 1): CameraView {
  return { x, y, prevX: x, prevY: y, zoom, prevZoom: zoom, snapTick: -1, viewW: 1920, viewH: 1080 };
}

describe('parallax maths', () => {
  test('applyParallax maps the visible rect to the view', () => {
    const frame = computeCameraFrame(createCameraFrame(), cam(3000, 900, 1.2), 1);
    for (const f of [0, 0.3, 1, 1.4]) {
      const c = new Container();
      applyParallax(c, frame, f, f * 0.8);
      const r = visibleLayerRect(frame, f, f * 0.8, { x0: 0, y0: 0, x1: 0, y1: 0 });
      expect(r.x0 * c.scale.x + c.position.x).toBeCloseTo(0, 6);
      expect(r.x1 * c.scale.x + c.position.x).toBeCloseTo(frame.viewW, 6);
      expect(r.y0 * c.scale.y + c.position.y).toBeCloseTo(0, 6);
      expect(r.y1 * c.scale.y + c.position.y).toBeCloseTo(frame.viewH, 6);
    }
  });

  test('layerExtent covers every visible rect along the clamped camera range', () => {
    const W = 9600;
    const H = 2400;
    for (const f of [0.1, 0.5, 1, 1.5]) {
      const ext = layerExtent(W, H, 1920, 1080, f, f);
      const r: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };
      for (let cx = 960; cx <= W - 960; cx += 240) {
        for (let cy = 540; cy <= H - 540; cy += 180) {
          visibleLayerRect(computeCameraFrame(createCameraFrame(), cam(cx, cy), 1), f, f, r);
          expect(r.x0).toBeGreaterThanOrEqual(ext.x0 - 1e-6);
          expect(r.x1).toBeLessThanOrEqual(ext.x1 + 1e-6);
          expect(r.y0).toBeGreaterThanOrEqual(ext.y0 - 1e-6);
          expect(r.y1).toBeLessThanOrEqual(ext.y1 + 1e-6);
        }
      }
      expect(ext.x1 - ext.x0).toBeCloseTo(f * W + (1 - f) * 1920, 6);
    }
  });

  test('camera frame interpolates prev → cur', () => {
    const c: CameraView = { ...cam(100, 100), prevX: 0, prevY: 0 };
    expect(computeCameraFrame(createCameraFrame(), c, 0.25).cx).toBeCloseTo(25);
    expect(computeCameraFrame(createCameraFrame(), cam(100, 100), 0.25).cx).toBe(100);
  });

  test('depth ordering', () => {
    expect(depthForParallax(1)).toBeCloseTo(0.05);
    expect(depthForParallax(0)).toBeCloseTo(0.95);
    expect(depthForParallax(2)).toBeCloseTo(0.05);
    expect(depthForParallax(0.2)).toBeGreaterThan(depthForParallax(0.8));
  });
});
