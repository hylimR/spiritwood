/**
 * Numerical listening aids for offline renders: level, spectrum and envelope measures, so patches can be
 * checked against their descriptions without playing them.
 */

export function db(x: number): number {
  return 20 * Math.log10(Math.max(x, 1e-12));
}

export function peakOf(ch: Float32Array, from = 0, to = ch.length): number {
  let p = 0;
  for (let i = from; i < to; i++) {
    const a = Math.abs(ch[i] as number);
    if (a > p) p = a;
  }
  return p;
}

export function rmsOf(ch: Float32Array, from = 0, to = ch.length): number {
  let s = 0;
  for (let i = from; i < to; i++) {
    const x = ch[i] as number;
    s += x * x;
  }
  return Math.sqrt(s / Math.max(1, to - from));
}

export function mono(chs: readonly Float32Array[]): Float32Array {
  const n = chs[0]?.length ?? 0;
  const out = new Float32Array(n);
  for (const c of chs) for (let i = 0; i < n; i++) out[i] = (out[i] as number) + (c[i] as number) / chs.length;
  return out;
}

/** In-place radix-2 FFT on (re, im). */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const xr = (re[b] as number) * cr - (im[b] as number) * ci;
        const xi = (re[b] as number) * ci + (im[b] as number) * cr;
        re[b] = (re[a] as number) - xr;
        im[b] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Magnitude spectrum frames (Hann, `size`, hop size/2). */
export function spectrogram(x: Float32Array, size = 2048, hop = 1024): Float64Array[] {
  const frames: Float64Array[] = [];
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let s = 0; s + size <= x.length; s += hop) {
    for (let i = 0; i < size; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));
      re[i] = (x[s + i] as number) * w;
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(size / 2);
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k] as number, im[k] as number);
    frames.push(mag);
  }
  return frames;
}

/** Energy-weighted mean spectral centroid (Hz) over the frames. */
export function centroid(x: Float32Array, sr: number): number {
  const frames = spectrogram(x);
  let num = 0;
  let den = 0;
  for (const m of frames) {
    for (let k = 1; k < m.length; k++) {
      const e = (m[k] as number) * (m[k] as number);
      num += e * ((k * sr) / (2 * m.length));
      den += e;
    }
  }
  return den > 0 ? num / den : 0;
}

/** Frequency (Hz) of the strongest spectral peak over the whole signal (parabolic interpolation). */
export function dominantHz(x: Float32Array, sr: number): number {
  const frames = spectrogram(x, 8192, 4096);
  if (frames.length === 0) return 0;
  const acc = new Float64Array((frames[0] as Float64Array).length);
  for (const m of frames) for (let k = 0; k < m.length; k++) acc[k] = (acc[k] as number) + (m[k] as number) * (m[k] as number);
  let best = 1;
  for (let k = 2; k < acc.length - 1; k++) if ((acc[k] as number) > (acc[best] as number)) best = k;
  const a = Math.sqrt(acc[best - 1] as number);
  const b = Math.sqrt(acc[best] as number);
  const c = Math.sqrt(acc[best + 1] as number);
  const off = (a - c) / (2 * (a - 2 * b + c) || 1);
  return ((best + off) * sr) / 8192;
}

/** RMS envelope in `win`-sample windows. */
export function envelopeOf(x: Float32Array, win: number): Float32Array {
  const n = Math.floor(x.length / win);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) e[i] = rmsOf(x, i * win, (i + 1) * win);
  return e;
}

export interface EnvelopeStats {
  /** Seconds from the first sound (−60 dB re peak) to 90 % of the envelope peak. */
  attack: number;
  /** Seconds from the envelope peak down to −20 dB and −40 dB re peak. */
  t20: number;
  t40: number;
  /** Seconds of sound (first to last sample within −60 dB of peak). */
  length: number;
}

export function envelopeStats(x: Float32Array, sr: number): EnvelopeStats {
  const win = Math.round(sr * 0.002);
  const e = envelopeOf(x, win);
  let pk = 0;
  let pkAt = 0;
  for (let i = 0; i < e.length; i++) {
    if ((e[i] as number) > pk) {
      pk = e[i] as number;
      pkAt = i;
    }
  }
  const floor = pk * 1e-3;
  let first = 0;
  while (first < e.length && (e[first] as number) < floor) first++;
  let last = e.length - 1;
  while (last > 0 && (e[last] as number) < floor) last--;
  let a90 = first;
  while (a90 < e.length && (e[a90] as number) < 0.9 * pk) a90++;
  let t20 = pkAt;
  while (t20 < e.length && (e[t20] as number) > pk * 0.1) t20++;
  let t40 = pkAt;
  while (t40 < e.length && (e[t40] as number) > pk * 0.01) t40++;
  const s = win / sr;
  return { attack: (a90 - first) * s, t20: (t20 - pkAt) * s, t40: (t40 - pkAt) * s, length: (last - first) * s };
}

/**
 * Click measure: the largest sample-to-sample step within the first `ms` after the onset (first sample
 * above 1e-5) and within the last `ms` before the sound ends, as absolute values.
 */
export function edgeSteps(x: Float32Array, sr: number, ms = 1): { onset: number; end: number; onsetAt: number; endAt: number } {
  let first = 0;
  while (first < x.length && Math.abs(x[first] as number) < 1e-5) first++;
  let last = x.length - 1;
  while (last > 0 && Math.abs(x[last] as number) < 1e-5) last--;
  const w = Math.round((sr * ms) / 1000);
  let onset = Math.abs(x[first] as number);
  for (let i = first + 1; i < Math.min(x.length, first + w); i++) onset = Math.max(onset, Math.abs((x[i] as number) - (x[i - 1] as number)));
  let end = Math.abs(x[last] as number);
  for (let i = Math.max(1, last - w); i <= last; i++) end = Math.max(end, Math.abs((x[i] as number) - (x[i - 1] as number)));
  return { onset, end, onsetAt: first / sr, endAt: last / sr };
}

/** Largest |x[n] − x[n−1]| anywhere, relative to the local RMS (a spike detector for steps). */
export function worstStep(x: Float32Array): number {
  let worst = 0;
  for (let i = 1; i < x.length; i++) worst = Math.max(worst, Math.abs((x[i] as number) - (x[i - 1] as number)));
  return worst;
}
