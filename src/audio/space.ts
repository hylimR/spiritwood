import type { AudioFrame } from '../contracts/audio.ts';
import { AUDIO_TUNING } from './tuning.ts';
import { smoothstep } from './util.ts';

/** Result of placing a world point relative to the listener (§5.9 Space). */
export interface Placement {
  /** Normalised distance outside the view: 0 on screen, ≥ 1 culled. */
  d: number;
  gain: number;
  pan: number;
}

/**
 * With zoom = sim.camera.zoom: hx = viewW / (2·zoom), hy = viewH / (2·zoom); ex = max(0, |x − camX| − hx)
 * / hx (ey likewise); d = √(ex² + ey²); gain × (1 − smoothstep(0, 1, d)); pan = clamp((x − camX) / hx,
 * −1, 1) · 0.6. Writes `out` (no allocation).
 */
export function place(frame: AudioFrame, x: number, y: number, out: Placement): Placement {
  const z = frame.sim.camera.zoom > 0 ? frame.sim.camera.zoom : 1;
  const hx = Math.max(1, frame.viewW / (2 * z));
  const hy = Math.max(1, frame.viewH / (2 * z));
  const dx = x - frame.camX;
  const dy = y - frame.camY;
  const ex = Math.max(0, Math.abs(dx) - hx) / hx;
  const ey = Math.max(0, Math.abs(dy) - hy) / hy;
  const d = Math.sqrt(ex * ex + ey * ey);
  out.d = d;
  out.gain = 1 - smoothstep(0, 1, d);
  const p = dx / hx;
  out.pan = (p < -1 ? -1 : p > 1 ? 1 : p) * AUDIO_TUNING.panScale;
  return out;
}

export function createPlacement(): Placement {
  return { d: 0, gain: 1, pan: 0 };
}
