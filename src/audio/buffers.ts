import { Rng } from '../core/rng.ts';
import type { AudioBufferPort, GraphPort } from './ports.ts';
import { AUDIO_TUNING } from './tuning.ts';

/**
 * Builds the shared noise buffer and the reverb impulse in slices (§5.9 Performance): white noise (mono,
 * `noiseSeconds`) and a decorrelated stereo impulse (`impulseSeconds`) whose tail decays with RT60 =
 * reverbRt60 and darkens over time. Both are seeded, so every run sounds the same. Each step() does a
 * fixed amount of work (at most buildSliceSamples samples), never a wall-clock budget, so the slicing is
 * deterministic. Nothing is handed to a node before it is complete: patches needing noise are skipped
 * until `noise` is set, and the convolver gets its buffer only once the impulse is normalised.
 */
export class BufferBuilder {
  /** Complete noise buffer, or null while building. */
  noise: AudioBufferPort | null = null;
  /** Complete, normalised impulse, or null while building. */
  impulse: AudioBufferPort | null = null;

  private readonly noiseBuf: AudioBufferPort;
  private readonly irBuf: AudioBufferPort;
  private readonly noiseRng: Rng;
  private readonly irRng: [Rng, Rng];
  private stage = 0;
  private pos = 0;
  private ch = 0;
  private readonly energy = new Float64Array(2);
  private readonly lp = new Float64Array(2);
  private readonly env = new Float64Array(2);
  private coef = 0;
  private comp = 1;
  /** Samples of work done by the latest step() (inspection and tests). */
  lastSlice = 0;

  constructor(ctx: GraphPort, seed: number) {
    const t = AUDIO_TUNING;
    const sr = t.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, Math.round(t.noiseSeconds * sr), sr);
    this.irBuf = ctx.createBuffer(2, Math.round(t.impulseSeconds * sr), sr);
    const base = new Rng((seed ^ 0x5eed_a0d1) >>> 0);
    this.noiseRng = base.fork(1);
    this.irRng = [base.fork(2), base.fork(3)];
  }

  get done(): boolean {
    return this.stage >= 3;
  }

  /** One slice: at most buildSliceSamples samples of work. Returns true when both buffers are ready. */
  step(): boolean {
    let left = AUDIO_TUNING.buildSliceSamples;
    while (this.stage < 3 && left > 0) {
      if (this.stage === 0) left -= this.noiseChunk(left);
      else if (this.stage === 1) left -= this.impulseChunk(left);
      else left -= this.normaliseChunk(left);
    }
    this.lastSlice = AUDIO_TUNING.buildSliceSamples - left;
    return this.stage >= 3;
  }

  /** Build everything now (offline tools and tests). */
  finish(): void {
    while (!this.step());
  }

  private noiseChunk(max: number): number {
    const d = this.noiseBuf.getChannelData(0);
    const from = this.pos;
    const end = Math.min(d.length, from + max);
    const r = this.noiseRng;
    for (let i = from; i < end; i++) d[i] = r.next() * 2 - 1;
    this.pos = end;
    if (end >= d.length) {
      this.noise = this.noiseBuf;
      this.stage = 1;
      this.pos = 0;
      this.ch = 0;
      this.startChannel();
    }
    return end - from;
  }

  private startChannel(): void {
    this.lp[this.ch] = 0;
    this.env[this.ch] = 1;
    this.energy[this.ch] = 0;
  }

  private impulseChunk(max: number): number {
    const t = AUDIO_TUNING;
    const sr = t.sampleRate;
    const c = this.ch;
    const d = this.irBuf.getChannelData(c);
    const n = d.length;
    const pre = Math.round((t.reverbPredelay + c * 0.0037) * sr);
    const decay = Math.exp(-6.907755 / (t.reverbRt60 * sr));
    const fadeFrom = Math.floor(n * 0.72);
    const r = this.irRng[c] as Rng;
    const from = this.pos;
    const end = Math.min(n, from + max);
    let lp = this.lp[c] as number;
    let env = this.env[c] as number;
    let energy = this.energy[c] as number;
    for (let i = this.pos; i < end; i++) {
      if (i < pre) {
        d[i] = 0;
        continue;
      }
      const k = i - pre;
      if ((k & 31) === 0) {
        // The tail darkens: the damping cutoff falls from ~9 kHz toward ~1.2 kHz.
        const tt = k / sr;
        const fc = 7800 * Math.exp(-tt / 0.42) + 1200;
        this.coef = Math.exp((-2 * Math.PI * fc) / sr);
        this.comp = Math.sqrt((1 + this.coef) / (1 - this.coef));
      }
      lp += (1 - this.coef) * (r.next() * 2 - 1 - lp);
      let v = lp * this.comp * env;
      if (k < 144) v *= k / 144;
      if (i >= fadeFrom) v *= 0.5 + 0.5 * Math.cos((Math.PI * (i - fadeFrom)) / (n - fadeFrom));
      env *= decay;
      d[i] = v;
      energy += v * v;
    }
    this.lp[c] = lp;
    this.env[c] = env;
    this.energy[c] = energy;
    this.pos = end;
    if (end >= n) {
      this.pos = 0;
      if (c === 0) {
        this.ch = 1;
        this.startChannel();
      } else {
        this.ch = 0;
        this.stage = 2;
      }
    }
    return end - from;
  }

  /** Scale each impulse channel to unit energy (sliced like the rest). */
  private normaliseChunk(max: number): number {
    const c = this.ch;
    const d = this.irBuf.getChannelData(c);
    const s = 1 / Math.sqrt(Math.max(this.energy[c] as number, 1e-12));
    const from = this.pos;
    const end = Math.min(d.length, from + max);
    for (let i = from; i < end; i++) d[i] = (d[i] as number) * s;
    this.pos = end;
    if (end >= d.length) {
      this.pos = 0;
      if (c === 0) {
        this.ch = 1;
      } else {
        this.impulse = this.irBuf;
        this.stage = 3;
      }
    }
    return end - from;
  }
}
