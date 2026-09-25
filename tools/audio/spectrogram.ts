import { writeFileSync } from 'node:fs';
import { encodePng } from '../preview/png.ts';
import { spectrogram } from './analyze.ts';

/**
 * Write a log-frequency spectrogram PNG (40 Hz … 20 kHz up the image, time left → right, −90 … 0 dB
 * relative to the loudest bin) with a waveform strip underneath, for inspecting renders as images.
 */
export function writeSpectrogramPng(path: string, x: Float32Array, sr: number, height = 256, maxWidth = 1200): void {
  const size = 2048;
  const hop = Math.max(128, Math.ceil(x.length / maxWidth / 128) * 128);
  const frames = spectrogram(x, size, hop);
  const w = Math.max(1, frames.length);
  const wave = 64;
  const h = height + wave;
  const rgba = new Uint8Array(w * h * 4);
  let ref = 1e-12;
  for (const f of frames) for (let k = 0; k < f.length; k++) ref = Math.max(ref, f[k] as number);
  const fLo = Math.log(40);
  const fHi = Math.log(20000);
  for (let col = 0; col < frames.length; col++) {
    const f = frames[col] as Float64Array;
    for (let row = 0; row < height; row++) {
      const hz = Math.exp(fLo + ((height - 1 - row) / (height - 1)) * (fHi - fLo));
      const k = Math.min(f.length - 1, Math.max(1, Math.round((hz * size) / sr)));
      const dB = 20 * Math.log10(Math.max((f[k] as number) / ref, 1e-9));
      const v = Math.max(0, Math.min(1, (dB + 90) / 90));
      const i = (row * w + col) * 4;
      // Night palette: deep blue → teal → pale spirit glow.
      rgba[i] = Math.round(255 * Math.pow(v, 2.2));
      rgba[i + 1] = Math.round(255 * Math.pow(v, 1.3));
      rgba[i + 2] = Math.round(40 + 215 * Math.pow(v, 0.8));
      rgba[i + 3] = 255;
    }
    let mx = 0;
    const s0 = col * hop;
    for (let s = s0; s < Math.min(x.length, s0 + hop); s++) mx = Math.max(mx, Math.abs(x[s] as number));
    const bar = Math.round(Math.min(1, mx) * (wave / 2));
    for (let row = 0; row < wave; row++) {
      const on = Math.abs(row - wave / 2) <= bar;
      const i = ((height + row) * w + col) * 4;
      rgba[i] = on ? 191 : 8;
      rgba[i + 1] = on ? 246 : 14;
      rgba[i + 2] = on ? 255 : 28;
      rgba[i + 3] = 255;
    }
  }
  writeFileSync(path, encodePng(rgba, w, h));
}
