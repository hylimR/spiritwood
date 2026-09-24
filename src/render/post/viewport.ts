import { MAX_ASPECT, MIN_ASPECT, VIEW_H } from '../../config.ts';
import { clamp } from '../../core/math.ts';

/** Letterboxed canvas geometry for a container of `cssWidth × cssHeight` CSS pixels. */
export interface CanvasFit {
  /** CSS size of the canvas (≤ the container, aspect in [MIN_ASPECT, MAX_ASPECT]). */
  cssWidth: number;
  cssHeight: number;
  /** Backbuffer pixels per CSS pixel: min(devicePixelRatio, pixelRatioCap). */
  pixelRatio: number;
  /** Backbuffer size in device pixels. */
  pixelWidth: number;
  pixelHeight: number;
  /** View size in view units: (VIEW_H × aspect, VIEW_H). */
  viewW: number;
  viewH: number;
  aspect: number;
}

export function createCanvasFit(): CanvasFit {
  return { cssWidth: 1, cssHeight: 1, pixelRatio: 1, pixelWidth: 1, pixelHeight: 1, viewW: VIEW_H, viewH: VIEW_H, aspect: 1 };
}

/**
 * The largest rect with aspect clamped to [MIN_ASPECT, MAX_ASPECT] inside the given CSS size
 * (pillar-box when too wide, letterbox when too tall); the parent centres it. The backbuffer is the
 * CSS size × min(dpr, pixelRatioCap), floored to whole pixels, and the CSS size is derived back from
 * it so one backbuffer pixel maps to exactly `pixelRatio` CSS pixels.
 */
export function fitCanvas(
  cssWidth: number, cssHeight: number, devicePixelRatio: number, pixelRatioCap: number, out: CanvasFit = createCanvasFit(),
): CanvasFit {
  const cw = cssWidth > 0 ? cssWidth : 1;
  const ch = cssHeight > 0 ? cssHeight : 1;
  const dpr = devicePixelRatio > 0 && Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1;
  const ratio = Math.min(dpr, pixelRatioCap > 0 ? pixelRatioCap : 1);
  const aspect = clamp(cw / ch, MIN_ASPECT, MAX_ASPECT);
  let w = cw;
  let h = ch;
  if (cw / ch > aspect) w = ch * aspect;
  else h = cw / aspect;
  const pw = Math.max(1, Math.floor(w * ratio + 1e-6));
  const ph = Math.max(1, Math.floor(h * ratio + 1e-6));
  out.pixelRatio = ratio;
  out.pixelWidth = pw;
  out.pixelHeight = ph;
  out.cssWidth = pw / ratio;
  out.cssHeight = ph / ratio;
  out.aspect = clamp(pw / ph, MIN_ASPECT, MAX_ASPECT);
  out.viewH = VIEW_H;
  out.viewW = VIEW_H * out.aspect;
  return out;
}

/** Largest render scale whose scene target stays within `maxRenderPixels` (≤ 1). */
export function renderScaleCap(pixelWidth: number, pixelHeight: number, maxRenderPixels: number): number {
  const px = pixelWidth * pixelHeight;
  return px > maxRenderPixels ? Math.sqrt(maxRenderPixels / px) : 1;
}

/** Max bloom chain depth the pipeline allocates targets for. */
export const MAX_BLOOM_PASSES = 6;

/**
 * Render-target sizes: allocated maxima (`alloc*`) and the current dynamic-resolution sub-rects
 * (`sub*`). Chain level 0 is the glow target itself; level k (1…passes) is ½ of level k−1.
 */
export interface TargetLayout {
  allocW: Int32Array;
  allocH: Int32Array;
  subW: Int32Array;
  subH: Int32Array;
  /** Scene target (allocated / current). */
  sceneAllocW: number;
  sceneAllocH: number;
  sceneW: number;
  sceneH: number;
  passes: number;
}

export function createTargetLayout(): TargetLayout {
  const n = MAX_BLOOM_PASSES + 1;
  return {
    allocW: new Int32Array(n), allocH: new Int32Array(n), subW: new Int32Array(n), subH: new Int32Array(n),
    sceneAllocW: 1, sceneAllocH: 1, sceneW: 1, sceneH: 1, passes: 0,
  };
}

/**
 * Allocation sizes for a canvas of `pixelWidth × pixelHeight`: scene = canvas × maxScale (ceil), glow =
 * scene × bloomScale, then `passes` halvings. Call on resize / quality change only.
 */
export function layoutTargets(
  out: TargetLayout, pixelWidth: number, pixelHeight: number, maxScale: number, bloomScale: number, passes: number,
): TargetLayout {
  const p = Math.max(0, Math.min(MAX_BLOOM_PASSES, Math.floor(passes)));
  out.passes = p;
  out.sceneAllocW = Math.max(1, Math.ceil(pixelWidth * maxScale - 1e-6));
  out.sceneAllocH = Math.max(1, Math.ceil(pixelHeight * maxScale - 1e-6));
  out.allocW[0] = Math.max(1, Math.ceil(out.sceneAllocW * bloomScale - 1e-6));
  out.allocH[0] = Math.max(1, Math.ceil(out.sceneAllocH * bloomScale - 1e-6));
  for (let k = 1; k <= MAX_BLOOM_PASSES; k++) {
    out.allocW[k] = Math.max(1, Math.ceil((out.allocW[k - 1] as number) / 2));
    out.allocH[k] = Math.max(1, Math.ceil((out.allocH[k - 1] as number) / 2));
  }
  return out;
}

/** Sub-rects for the current render scale (never exceed the allocation; no reallocation). */
export function layoutSubRects(out: TargetLayout, pixelWidth: number, pixelHeight: number, scale: number, bloomScale: number): TargetLayout {
  out.sceneW = Math.min(out.sceneAllocW, Math.max(1, Math.round(pixelWidth * scale)));
  out.sceneH = Math.min(out.sceneAllocH, Math.max(1, Math.round(pixelHeight * scale)));
  out.subW[0] = Math.min(out.allocW[0] as number, Math.max(1, Math.round(out.sceneW * bloomScale)));
  out.subH[0] = Math.min(out.allocH[0] as number, Math.max(1, Math.round(out.sceneH * bloomScale)));
  for (let k = 1; k <= MAX_BLOOM_PASSES; k++) {
    out.subW[k] = Math.max(1, Math.ceil((out.subW[k - 1] as number) / 2));
    out.subH[k] = Math.max(1, Math.ceil((out.subH[k - 1] as number) / 2));
  }
  return out;
}
