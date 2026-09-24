import { TIME_SCALE_EASE, TIME_SCALE_RELEASE } from '../config.ts';

/** Every audio constant in one place (ARCHITECTURE.md §5.9). Tests read these instead of literals. */
export const AUDIO_TUNING = Object.freeze({
  sampleRate: 48000,

  // Master chain.
  compressorThreshold: -12,
  compressorRatio: 4,
  compressorKnee: 6,
  /** Cancels the DynamicsCompressor's automatic makeup gain (+4.05 dB measured below threshold). */
  trimDb: -4,
  /** WaveShaper: linear up to ±softClipLinear, then a tanh knee toward ±1. */
  softClipLinear: 0.8,
  softClipPoints: 4096,

  /** Slider v → gain v², smoothed with this time constant (s). */
  volumeTau: 0.05,
  /** Pause: music ducks 12 dB, ambience holds low. */
  pauseMusicDb: -12,
  pauseAmbienceDb: -14,
  pauseTau: 0.08,
  /** Sustained SFX release within this on pause (s). */
  pauseReleaseSec: 0.05,

  /** Freeze low-pass (music and ambience): frequency fixed, detune swept (≈ 900 Hz at the bottom). */
  freezeFilterHz: 20000,
  freezeDetuneCents: -5370,
  freezeTauIn: TIME_SCALE_EASE,
  freezeTauOut: TIME_SCALE_RELEASE,

  /** Post-fader reverb sends per bus, and the music echo. */
  reverbSendSfx: 0.2,
  reverbSendMusic: 0.55,
  reverbSendAmbience: 0.3,
  reverbReturn: 0.75,
  echoSend: 0.2,
  echoFeedback: 0.36,
  echoDamping: 2400,
  /** Dotted eighth at the music tempo. */
  echoBeats: 0.75,

  // Voices.
  budgetSfx: 16,
  budgetMusic: 12,
  budgetAmbience: 6,
  /** Non-spatial voices replace the panner with this gain, matching the panner's centre level. */
  centreGain: Math.SQRT1_2,
  /** Sources stop this long after the release reaches 0. */
  stopPad: 0.005,
  stealFade: 0.01,
  stealStop: 0.015,
  /** Leases: each update() re-issues stop(now + leaseStop) and moves the kill fade to now + leaseFade. */
  leaseStop: 0.35,
  leaseFade: 0.2,
  /** A lease is renewed only while its fade is at least this far away; otherwise it is replaced. */
  leaseMargin: 0.05,
  /** Retired this long after the scheduled end (the audio thread runs ahead of currentTime). */
  retireGrace: 0.05,
  /** Control events (Reset, Teleported, Respawned) release SFX over this fade. */
  controlReleaseSec: 0.04,

  // Space (§5.9 Space).
  panScale: 0.6,

  // SFX rules.
  landMinSpeed: 150,
  landFullSpeed: 1150,
  landMinGap: 0.08,
  orbComboWindow: 1.5,
  orbComboMaxSteps: 7,
  orbStagger: 0.05,
  capSeedFired: 3,
  capSeedBurst: 4,
  capRattle: 2,

  /**
   * SFX start this far ahead of currentTime (§5.9 Scheduler): two render quanta at 48 kHz keep an attack's
   * first events ahead of the audio thread, so attacks stay intact and jumps feel instant. The music lead
   * below is the scheduler's alone.
   */
  sfxLead: 0.006,

  // Scheduler (§5.9 Music).
  leadMin: 0.03,
  horizon: 0.25,
  /** Past this many late steps the transport re-anchors instead of catching up. */
  maxCatchUpSteps: 256,

  // Music transport and mix.
  tempoBpm: 60,
  stepsPerBeat: 2,
  beatsPerBar: 4,
  barsPerChord: 2,
  /** D: MIDI 62 is D4. */
  tonicMidi: 62,
  layerTau: 1.5,
  harmonyHysteresis: 0.2,
  /** A layer books notes only while its target weight reaches this. */
  layerAudible: 0.06,

  // Ambience.
  bedFadeIn: 3,
  levelTau: 1.5,

  /**
   * Buffers (§5.9, §6): the JS-visible noise and impulse plus one copy of the impulse ≤ 1 MB at 48 kHz.
   * The convolver's internal FFT state (≈ 4 MB in Chromium for this 1 s stereo impulse) is accepted and
   * not counted here.
   */
  noiseSeconds: 1.3,
  impulseSeconds: 1.0,
  /** The one impulse copy the budget counts (the convolver's own copy of its buffer). */
  convolverCopies: 1,
  bufferBudgetBytes: 1024 * 1024,
  /**
   * Buffer building per update(), in samples of work (a fixed count, so slicing is deterministic),
   * calibrated to ≈ 2 ms: ≈ 1–1.5 ms per slice on a desktop before the JIT has warmed up, ≈ 0.1–0.2 ms
   * after. The whole build takes 32 slices; the noise is ready after 8.
   */
  buildSliceSamples: 8192,
  reverbRt60: 1.9,
  reverbPredelay: 0.012,

  // Headroom (render-patches and tests).
  patchPeakDb: -12,
  mixPeakDb: -1,
});

export const Category = { Sfx: 0, Music: 1, Ambience: 2 } as const;
export type Category = (typeof Category)[keyof typeof Category];

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

/** Bytes the budget counts at the fixed 48 kHz rate: noise, impulse and one impulse copy (§5.9). */
export function bufferBudgetUse(): number {
  const t = AUDIO_TUNING;
  const noise = Math.round(t.noiseSeconds * t.sampleRate) * 4;
  const impulse = Math.round(t.impulseSeconds * t.sampleRate) * 2 * 4;
  return noise + impulse * (1 + t.convolverCopies);
}
