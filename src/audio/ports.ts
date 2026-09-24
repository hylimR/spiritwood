/**
 * Narrow structural ports onto Web Audio (ARCHITECTURE.md §5.9). The real AudioContext and
 * OfflineAudioContext satisfy them structurally; tests supply a strict fake. Deliberately absent:
 * `cancelAndHoldAtTime` and `automationRate` (Firefox lacks them), AudioWorklet (its modules load under
 * script-src, which the artifact CSP restricts) and ScriptProcessor.
 *
 * Every value written to an AudioParam goes through the helpers below, which clamp it to a finite number
 * (NaN or Infinity throws) and keep times finite and non-negative.
 */

export interface AudioParamPort {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  cancelScheduledValues(cancelTime: number): unknown;
}

export interface AudioNodePort {
  connect(destination: AudioNodePort): unknown;
  connect(destination: AudioParamPort): unknown;
  disconnect(): void;
}

export interface GainNodePort extends AudioNodePort {
  readonly gain: AudioParamPort;
}

export interface ScheduledSourcePort extends AudioNodePort {
  start(when?: number): void;
  stop(when?: number): void;
}

/** Opaque handle (the DOM PeriodicWave has no members). */
export interface PeriodicWavePort {
  readonly __periodicWave?: never;
}

export type OscType = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'custom';

export interface OscillatorNodePort extends ScheduledSourcePort {
  type: OscType;
  readonly frequency: AudioParamPort;
  readonly detune: AudioParamPort;
  setPeriodicWave(periodicWave: PeriodicWavePort): void;
}

export interface AudioBufferPort {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array<ArrayBuffer>;
}

export interface BufferSourcePort extends ScheduledSourcePort {
  buffer: AudioBufferPort | null;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  readonly playbackRate: AudioParamPort;
  start(when?: number, offset?: number, duration?: number): void;
}

export type FilterType = 'lowpass' | 'highpass' | 'bandpass' | 'lowshelf' | 'highshelf' | 'peaking' | 'notch' | 'allpass';

export interface BiquadFilterNodePort extends AudioNodePort {
  type: FilterType;
  readonly frequency: AudioParamPort;
  readonly detune: AudioParamPort;
  readonly Q: AudioParamPort;
  readonly gain: AudioParamPort;
}

export interface StereoPannerNodePort extends AudioNodePort {
  readonly pan: AudioParamPort;
}

export interface WaveShaperNodePort extends AudioNodePort {
  curve: Float32Array<ArrayBuffer> | null;
  oversample: 'none' | '2x' | '4x';
}

export interface DynamicsCompressorNodePort extends AudioNodePort {
  readonly threshold: AudioParamPort;
  readonly knee: AudioParamPort;
  readonly ratio: AudioParamPort;
  readonly attack: AudioParamPort;
  readonly release: AudioParamPort;
}

export interface ConvolverNodePort extends AudioNodePort {
  buffer: AudioBufferPort | null;
  normalize: boolean;
}

export interface DelayNodePort extends AudioNodePort {
  readonly delayTime: AudioParamPort;
}

/** What patches and the graph builders need: a BaseAudioContext subset (offline or realtime). */
export interface GraphPort {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: AudioNodePort;
  createGain(): GainNodePort;
  createOscillator(): OscillatorNodePort;
  createBufferSource(): BufferSourcePort;
  createBiquadFilter(): BiquadFilterNodePort;
  createStereoPanner(): StereoPannerNodePort;
  createWaveShaper(): WaveShaperNodePort;
  createDynamicsCompressor(): DynamicsCompressorNodePort;
  createConvolver(): ConvolverNodePort;
  createDelay(maxDelayTime?: number): DelayNodePort;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBufferPort;
  createPeriodicWave(
    real: Float32Array<ArrayBuffer>,
    imag: Float32Array<ArrayBuffer>,
    constraints?: { disableNormalization?: boolean },
  ): PeriodicWavePort;
}

/** The realtime context: a GraphPort plus the lifecycle the engine drives (§5.9 state table). */
export interface AudioContextPort extends GraphPort {
  /** 'suspended' | 'running' | 'closed' | 'interrupted' (Safari). */
  readonly state: string;
  /** May be undefined (older engines); outputLatency too. */
  readonly baseLatency?: number;
  readonly outputLatency?: number;
  onstatechange: ((ev: Event) => unknown) | null;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
}

/** Collects what a patch creates, so the engine can stop, steal, retire and steer it. */
export interface VoiceSink {
  /** A source to start by the patch and stop by the engine (release end + 5 ms, steal, lease). */
  source(s: ScheduledSourcePort): void;
  /** Any other node the patch created (disconnected when the voice retires). */
  node(n: AudioNodePort): void;
  /** A continuous-control parameter a lease keeps steering (slot 0..3). */
  handle(slot: number, p: AudioParamPort): void;
}

/** Lowest value an exponential ramp may target (a ramp to 0 throws). */
export const EXP_FLOOR = 1e-4;
const MIN_TIME_CONSTANT = 1e-4;
const MAX_TIME = 1e7;

export function finite(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function time(t: number): number {
  if (!(t > 0)) return 0;
  return t < MAX_TIME ? t : MAX_TIME;
}

export function setAt(p: AudioParamPort, v: number, t: number): void {
  p.setValueAtTime(finite(v), time(t));
}

export function linTo(p: AudioParamPort, v: number, t: number): void {
  p.linearRampToValueAtTime(finite(v), time(t));
}

/** Exponential ramp; the target is kept at least EXP_FLOOR away from 0 (same sign). */
export function expTo(p: AudioParamPort, v: number, t: number): void {
  const x = finite(v, EXP_FLOOR);
  p.exponentialRampToValueAtTime(x >= 0 ? Math.max(x, EXP_FLOOR) : Math.min(x, -EXP_FLOOR), time(t));
}

export function targetAt(p: AudioParamPort, v: number, t: number, tau: number): void {
  p.setTargetAtTime(finite(v), time(t), Math.max(finite(tau, MIN_TIME_CONSTANT), MIN_TIME_CONSTANT));
}

export function cancelFrom(p: AudioParamPort, t: number): void {
  p.cancelScheduledValues(time(t));
}

export function setValue(p: AudioParamPort, v: number): void {
  p.value = finite(v);
}

/** Frequencies (LFOs included) stay inside the nominal range at 48 kHz (Chromium warns outside it). */
export function hz(f: number): number {
  const x = finite(f, 440);
  return x < 0 ? 0 : x > 23500 ? 23500 : x;
}

export function clampPan(p: number): number {
  const x = finite(p);
  return x < -1 ? -1 : x > 1 ? 1 : x;
}
