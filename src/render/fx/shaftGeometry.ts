import type { LightShaftDef } from '../../contracts/level.ts';

/** A light shaft as a trapezoid in world space (LightShaftDef semantics, src/contracts/level.ts). */
export interface Trapezoid {
  y0: number;
  y1: number;
  /** Left edge and width at the top and bottom. */
  topX: number;
  topW: number;
  botX: number;
  botW: number;
  intensity: number;
}

export function shaftTrapezoid(s: LightShaftDef): Trapezoid {
  const botW = s.w * s.spread;
  const botCx = s.x + s.w / 2 + s.h * Math.tan(s.angle);
  return { y0: s.y, y1: s.y + s.h, topX: s.x, topW: s.w, botX: botCx - botW / 2, botW, intensity: s.intensity };
}

/** World position of shaft coordinates (u across 0..1, v down 0..1). */
export function shaftPoint(t: Trapezoid, u: number, v: number, out: { x: number; y: number }): void {
  const left = t.topX + (t.botX - t.topX) * v;
  const w = t.topW + (t.botW - t.topW) * v;
  out.x = left + u * w;
  out.y = t.y0 + (t.y1 - t.y0) * v;
}

function sm(x: number): number {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

/** Soft cross-section and length envelope of a shaft (0..1), shared by the shader and the dust. */
export function shaftEnvelope(u: number, v: number): number {
  return sm(u / 0.22) * sm((1 - u) / 0.22) * sm(v / 0.08) * (1 - sm((v - 0.55) / 0.45));
}

/** Axis-aligned bounds of a trapezoid. */
export function trapezoidBounds(t: Trapezoid): { x0: number; x1: number; y0: number; y1: number } {
  return {
    x0: Math.min(t.topX, t.botX),
    x1: Math.max(t.topX + t.topW, t.botX + t.botW),
    y0: t.y0,
    y1: t.y1,
  };
}
