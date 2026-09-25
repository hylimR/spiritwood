import type {
  AudioBufferPort, AudioContextPort, AudioNodePort, BiquadFilterNodePort, BufferSourcePort, ConvolverNodePort,
  DelayNodePort, DynamicsCompressorNodePort, GainNodePort, OscillatorNodePort, PeriodicWavePort, StereoPannerNodePort,
  WaveShaperNodePort,
} from '../../src/audio/ports.ts';

/**
 * Presents an OfflineAudioContext as the realtime AudioContextPort the engine expects, always
 * 'running', with its output routed into `out` (so tools can tap the chain). The offline clock only
 * advances while rendering, so a driver suspends it at frame times and calls update() in between.
 */
export class OfflineRealtime implements AudioContextPort {
  readonly state = 'running';
  readonly baseLatency = 0.01;
  readonly outputLatency = 0.02;
  onstatechange: ((ev: Event) => unknown) | null = null;
  private readonly off: OfflineAudioContext;
  private readonly out: AudioNodePort;

  constructor(off: OfflineAudioContext, out: AudioNodePort) {
    this.off = off;
    this.out = out;
  }

  get currentTime(): number {
    return this.off.currentTime;
  }
  get sampleRate(): number {
    return this.off.sampleRate;
  }
  get destination(): AudioNodePort {
    return this.out;
  }
  createGain(): GainNodePort {
    return this.off.createGain();
  }
  createOscillator(): OscillatorNodePort {
    return this.off.createOscillator();
  }
  createBufferSource(): BufferSourcePort {
    return this.off.createBufferSource();
  }
  createBiquadFilter(): BiquadFilterNodePort {
    return this.off.createBiquadFilter();
  }
  createStereoPanner(): StereoPannerNodePort {
    return this.off.createStereoPanner();
  }
  createWaveShaper(): WaveShaperNodePort {
    return this.off.createWaveShaper();
  }
  createDynamicsCompressor(): DynamicsCompressorNodePort {
    return this.off.createDynamicsCompressor();
  }
  createConvolver(): ConvolverNodePort {
    return this.off.createConvolver();
  }
  createDelay(maxDelayTime?: number): DelayNodePort {
    return this.off.createDelay(maxDelayTime);
  }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferPort {
    return this.off.createBuffer(numberOfChannels, length, sampleRate);
  }
  createPeriodicWave(real: Float32Array<ArrayBuffer>, imag: Float32Array<ArrayBuffer>, constraints?: { disableNormalization?: boolean }): PeriodicWavePort {
    return this.off.createPeriodicWave(real, imag, constraints);
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    return Promise.resolve();
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}
