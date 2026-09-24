/** Small pure helpers shared by the audio modules (no Web Audio, no DOM). */

export function mtof(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** lowbias32: a well-mixed 32-bit integer hash. */
export function hash32(x: number): number {
  let h = x >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform [0, 1) from a hash of (a, salt). */
export function unit(a: number, salt: number): number {
  return hash32((a ^ Math.imul(salt + 1, 0x9e3779b9)) >>> 0) / 4294967296;
}

/**
 * Soft clip: identity up to ±linear, then linear + (1 − linear)·tanh((|x| − linear)/(1 − linear)), which
 * joins with slope 1 and approaches ±1. The WaveShaper maps inputs in [−1, 1] onto `points` samples.
 */
export function softClipCurve(points: number, linear: number): Float32Array<ArrayBuffer> {
  const c = new Float32Array(points);
  const knee = 1 - linear;
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= linear ? a : linear + knee * Math.tanh((a - linear) / knee);
    c[i] = x < 0 ? -y : y;
  }
  return c;
}

/** Output of softClipCurve's function for one input (tests and the render tool). */
export function softClip(x: number, linear: number): number {
  const a = Math.min(Math.abs(x), 1);
  const knee = 1 - linear;
  const y = a <= linear ? a : linear + knee * Math.tanh((a - linear) / knee);
  return x < 0 ? -y : y;
}
