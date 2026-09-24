import {
  setValue, targetAt, type AudioBufferPort, type BiquadFilterNodePort, type ConvolverNodePort,
  type DynamicsCompressorNodePort, type GainNodePort, type GraphPort, type WaveShaperNodePort,
} from './ports.ts';
import { AUDIO_TUNING, dbToGain } from './tuning.ts';
import { softClipCurve } from './util.ts';

/**
 * The mix graph (§5.9 Graph and levels). Per bus: volume Gain → duck Gain (+ the freeze low-pass on
 * music and ambience) → master Gain → compressor (−12 dB, 4:1, knee 6) → trim −4 dB (cancels the
 * compressor's makeup gain) → WaveShaper soft clip → destination. Post-fader sends feed one shared
 * convolver (and the music a damped echo), returning into the master Gain.
 *
 * One owner per AudioParam: the volume Gains belong to setVolumes (slider v → v², τ 0.05 s; ambience
 * follows `sfx`), the duck Gains to setPaused, the freeze filters' detune to setFrozen. The freeze filters'
 * frequency is fixed at 20 kHz and never automated. Every setter writes only when its target changes.
 */
export class Mixer {
  /** Bus inputs: voices and music layers connect here (the volume Gains). */
  readonly sfx: GainNodePort;
  readonly music: GainNodePort;
  readonly ambience: GainNodePort;

  readonly master: GainNodePort;
  readonly compressor: DynamicsCompressorNodePort;
  readonly trim: GainNodePort;
  readonly shaper: WaveShaperNodePort;
  readonly duckSfx: GainNodePort;
  readonly duckMusic: GainNodePort;
  readonly duckAmbience: GainNodePort;
  readonly freezeMusic: BiquadFilterNodePort;
  readonly freezeAmbience: BiquadFilterNodePort;
  readonly reverb: ConvolverNodePort;
  readonly reverbReturn: GainNodePort;

  private wMaster = NaN;
  private wMusic = NaN;
  private wSfx = NaN;
  private wPaused: boolean | null = null;
  private wFrozen: boolean | null = null;

  constructor(ctx: GraphPort, master: number, music: number, sfx: number) {
    const t = AUDIO_TUNING;
    this.master = ctx.createGain();
    this.compressor = ctx.createDynamicsCompressor();
    setValue(this.compressor.threshold, t.compressorThreshold);
    setValue(this.compressor.ratio, t.compressorRatio);
    setValue(this.compressor.knee, t.compressorKnee);
    this.trim = ctx.createGain();
    setValue(this.trim.gain, dbToGain(t.trimDb));
    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = softClipCurve(t.softClipPoints, t.softClipLinear);
    this.shaper.oversample = 'none';
    this.master.connect(this.compressor);
    this.compressor.connect(this.trim);
    this.trim.connect(this.shaper);
    this.shaper.connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.normalize = false;
    this.reverbReturn = ctx.createGain();
    setValue(this.reverbReturn.gain, t.reverbReturn);
    this.reverb.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    this.sfx = ctx.createGain();
    this.duckSfx = ctx.createGain();
    this.sfx.connect(this.duckSfx);
    this.duckSfx.connect(this.master);
    this.send(ctx, this.duckSfx, t.reverbSendSfx);

    this.music = ctx.createGain();
    this.duckMusic = ctx.createGain();
    this.freezeMusic = this.freezeFilter(ctx);
    this.music.connect(this.duckMusic);
    this.duckMusic.connect(this.freezeMusic);
    this.freezeMusic.connect(this.master);
    this.send(ctx, this.freezeMusic, t.reverbSendMusic);

    // Music echo: a damped delay line (dotted rhythm at the music tempo) returning into master and reverb.
    const echoIn = ctx.createGain();
    setValue(echoIn.gain, t.echoSend);
    const delay = ctx.createDelay(2);
    setValue(delay.delayTime, (t.echoBeats * 60) / t.tempoBpm);
    const damp = ctx.createBiquadFilter();
    damp.type = 'lowpass';
    setValue(damp.frequency, t.echoDamping);
    setValue(damp.Q, -3);
    const fb = ctx.createGain();
    setValue(fb.gain, t.echoFeedback);
    this.freezeMusic.connect(echoIn);
    echoIn.connect(delay);
    delay.connect(damp);
    damp.connect(fb);
    fb.connect(delay);
    damp.connect(this.master);
    this.send(ctx, damp, 0.35);

    this.ambience = ctx.createGain();
    this.duckAmbience = ctx.createGain();
    this.freezeAmbience = this.freezeFilter(ctx);
    this.ambience.connect(this.duckAmbience);
    this.duckAmbience.connect(this.freezeAmbience);
    this.freezeAmbience.connect(this.master);
    this.send(ctx, this.freezeAmbience, t.reverbSendAmbience);

    // Initial levels without ramps (nothing plays yet).
    this.wMaster = master * master;
    this.wMusic = music * music;
    this.wSfx = sfx * sfx;
    setValue(this.master.gain, this.wMaster);
    setValue(this.music.gain, this.wMusic);
    setValue(this.sfx.gain, this.wSfx);
    setValue(this.ambience.gain, this.wSfx);
  }

  private freezeFilter(ctx: GraphPort): BiquadFilterNodePort {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    setValue(f.frequency, AUDIO_TUNING.freezeFilterHz);
    setValue(f.Q, -3);
    return f;
  }

  private send(ctx: GraphPort, from: { connect(d: GainNodePort): unknown }, amount: number): void {
    const s = ctx.createGain();
    setValue(s.gain, amount);
    from.connect(s);
    s.connect(this.reverb);
  }

  /** Slider values 0..1 → gains v² (ambience follows sfx), smoothed; written only on change. */
  setVolumes(master: number, music: number, sfx: number, now: number): void {
    const tau = AUDIO_TUNING.volumeTau;
    const m = master * master;
    const mu = music * music;
    const s = sfx * sfx;
    if (m !== this.wMaster) {
      this.wMaster = m;
      targetAt(this.master.gain, m, now, tau);
    }
    if (mu !== this.wMusic) {
      this.wMusic = mu;
      targetAt(this.music.gain, mu, now, tau);
    }
    if (s !== this.wSfx) {
      this.wSfx = s;
      targetAt(this.sfx.gain, s, now, tau);
      targetAt(this.ambience.gain, s, now, tau);
    }
  }

  /** Pause: music ducks 12 dB and ambience holds low. */
  setPaused(paused: boolean, now: number): void {
    if (paused === this.wPaused) return;
    const first = this.wPaused === null;
    this.wPaused = paused;
    if (first && !paused) return;
    const t = AUDIO_TUNING;
    targetAt(this.duckMusic.gain, paused ? dbToGain(t.pauseMusicDb) : 1, now, t.pauseTau);
    targetAt(this.duckAmbience.gain, paused ? dbToGain(t.pauseAmbienceDb) : 1, now, t.pauseTau);
  }

  /** Freeze: sweep the music and ambience low-pass detune (≈ 900 Hz) in step with the visual freeze. */
  setFrozen(frozen: boolean, now: number): void {
    if (frozen === this.wFrozen) return;
    const first = this.wFrozen === null;
    this.wFrozen = frozen;
    if (first && !frozen) return;
    const t = AUDIO_TUNING;
    const target = frozen ? t.freezeDetuneCents : 0;
    const tau = frozen ? t.freezeTauIn : t.freezeTauOut;
    targetAt(this.freezeMusic.detune, target, now, tau);
    targetAt(this.freezeAmbience.detune, target, now, tau);
  }

  /** Hand the finished impulse to the convolver (once). */
  setImpulse(buf: AudioBufferPort): void {
    if (!this.reverb.buffer) this.reverb.buffer = buf;
  }

  /** Last written volume gains (inspection). */
  volumeGain(bus: 'master' | 'music' | 'sfx'): number {
    return bus === 'master' ? this.wMaster : bus === 'music' ? this.wMusic : this.wSfx;
  }
}
