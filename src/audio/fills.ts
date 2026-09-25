import type { Harmony } from './harmony.ts';
import type { PatchParams } from './kit.ts';

/*
 * What the engines ask each melodic patch to play: pitches from the harmony, plus the fixed styles of
 * the music layers. The offline headroom sweep (tools/audio/sweep.ts) renders these same fills in every
 * mood and chord, so it checks exactly what plays (§5.9: each patch alone ≤ −12 dBFS per channel).
 */

// ---- SFX ----

/** Air jump sparkle: two rising chord tones from D6. */
export function fillAirJump(p: PatchParams, h: Harmony): void {
  const d = h.chordDegreeFrom(86);
  p.notes[0] = h.note(d);
  p.notes[1] = h.note(h.chordDegreeFrom(h.note(d) + 1));
  p.noteCount = 2;
}

/** Orb combo step k: the harmony's scale climbing from comboBase(). */
export function fillOrb(p: PatchParams, h: Harmony, k: number): void {
  p.midi = h.note(h.comboBase() + k);
}

/** Checkpoint swell: the chord's four pad voices. */
export function fillCheckpoint(p: PatchParams, h: Harmony): void {
  for (let i = 0; i < 4; i++) p.notes[i] = h.voice(i, 0);
  p.noteCount = 4;
}

/** Goal: a four-note scale run up to the degree nearest D6, then the chord. */
export function fillGoal(p: PatchParams, h: Harmony): void {
  const top = h.degreeNear(86);
  for (let i = 0; i < 4; i++) p.notes[i] = h.note(top - 3 + i);
  for (let i = 0; i < 4; i++) p.notes[4 + i] = h.voice(i, 0);
  p.noteCount = 8;
}

/** Ability: the chord over two octaves (bell arpeggio) and its bass. */
export function fillAbility(p: PatchParams, h: Harmony): void {
  for (let i = 0; i < 8; i++) p.notes[i] = h.voice(i % 4, i < 4 ? 0 : 1);
  p.noteCount = 8;
  p.midi = h.bass(0);
}

/** Respawn: five scale steps up from the first chord tone at or above G5. */
export function fillRespawn(p: PatchParams, h: Harmony): void {
  const d = h.chordDegreeFrom(79);
  for (let i = 0; i < 5; i++) p.notes[i] = h.note(d + i);
  p.noteCount = 5;
}

export function fillLaunchAim(p: PatchParams, h: Harmony): void {
  p.midi = h.note(h.chordDegreeFrom(79));
}

export function fillLaunch(p: PatchParams, h: Harmony): void {
  p.midi = h.note(h.chordDegreeFrom(86));
}

export function fillSeedChime(p: PatchParams, h: Harmony): void {
  p.midi = h.note(h.chordDegreeFrom(84));
}

/** Aim sustain: three stacked chord tones from D5. */
export function fillAim(p: PatchParams, h: Harmony): void {
  p.notes[0] = h.note(h.chordDegreeFrom(74));
  p.notes[1] = h.note(h.chordDegreeFrom((p.notes[0] as number) + 1));
  p.notes[2] = h.note(h.chordDegreeFrom((p.notes[1] as number) + 1));
  p.noteCount = 3;
}

/** Owl: a chord tone from E4 (low) or G4 (high). */
export function fillOwl(p: PatchParams, h: Harmony, high: boolean): void {
  p.midi = h.note(h.chordDegreeFrom(high ? 67 : 64));
}

// ---- Music ----

/** A layer's pad: attack and release (s), brightness, level, octave shift and a sine sub on the bass. */
export interface PadStyle {
  readonly attack: number;
  readonly release: number;
  readonly bright: number;
  readonly gain: number;
  readonly octaves: number;
  readonly sub: boolean;
}

/** The layers that play a pad on every chord (the veil has harmonics and a drone instead). */
export const PAD_STYLES = {
  glade: { attack: 2.2, release: 3, bright: 0.42, gain: 1, octaves: 0, sub: true },
  gully: { attack: 3, release: 3.5, bright: 0.18, gain: 1, octaves: 0, sub: true },
  rootwell: { attack: 3.5, release: 4, bright: 0.08, gain: 0.6, octaves: 0, sub: false },
  canopy: { attack: 2.8, release: 3.5, bright: 0.85, gain: 0.8, octaves: 1, sub: false },
  shrine: { attack: 3.2, release: 4, bright: 0.5, gain: 1, octaves: 0, sub: true },
} as const satisfies Record<string, PadStyle>;

/** A pad on the current chord, held until 0.6 s before the chord ends. */
export function fillPad(p: PatchParams, h: Harmony, s: PadStyle, chordLen: number, variant: number): void {
  for (let i = 0; i < 4; i++) p.notes[i] = h.voice(i, s.octaves);
  p.noteCount = 4;
  p.midi = s.sub ? h.bass(0) : 0;
  p.attack = s.attack;
  p.dur = Math.max(0.5, chordLen - s.attack - 0.6);
  p.release = s.release;
  p.bright = s.bright;
  p.gain = s.gain;
  p.variant = variant;
}

/** Drones on the bass: attack, how much shorter than the chord the hold is, release, brightness, level. */
export interface DroneStyle {
  readonly attack: number;
  readonly shorter: number;
  readonly release: number;
  readonly bright: number;
  readonly gain: number;
}

export const DRONE_STYLES = {
  rootwell: { attack: 3.5, shorter: 3.7, release: 4, bright: 0.35, gain: 1 },
  veil: { attack: 3, shorter: 3.2, release: 3.5, bright: 0.15, gain: 0.5 },
} as const satisfies Record<string, DroneStyle>;

export function fillDrone(p: PatchParams, h: Harmony, s: DroneStyle, chordLen: number): void {
  p.midi = h.bass(0);
  p.attack = s.attack;
  p.dur = chordLen - s.shorter;
  p.release = s.release;
  p.bright = s.bright;
  p.gain = s.gain;
}

/** Veil: natural harmonics of the bass for the whole chord. */
export function fillHarmonics(p: PatchParams, h: Harmony, chordLen: number, variant: number): void {
  p.midi = h.bass(0);
  p.attack = 3;
  p.dur = chordLen - 3.5;
  p.release = 3;
  p.variant = variant;
}

/**
 * Melody lanes: register [lo, hi] (MIDI), and ring = base + spread · r (bells: tau; piano: hold), with
 * the phrase's last note ringing lastRing times longer.
 */
export interface Lane {
  readonly lo: number;
  readonly hi: number;
  readonly ring: number;
  readonly spread: number;
}

export const LANES = {
  glade: { lo: 74, hi: 88, ring: 1.4, spread: 0.6 },
  canopy: { lo: 76, hi: 93, ring: 1.2, spread: 0.7 },
  gully: { lo: 57, hi: 72, ring: 1.4, spread: 0 },
} as const satisfies Record<string, Lane>;

export const LAST_RING_BELL = 1.4;
export const LAST_RING_PIANO = 1.5;

/** A glass-bell melody note (phrase notes and the shrine bell). */
export function fillBell(p: PatchParams, midi: number, ring: number, gain: number): void {
  p.midi = midi;
  p.dur = ring;
  p.gain = gain;
  p.bright = 0.5;
}

/** The shrine's bell on the top voice, an octave up. */
export const SHRINE_BELL = { ring: 2.2, gain: 0.65 } as const;

/** A felt-piano phrase note (the gully's falling sighs); g is the phrase's note weight (≤ 1). */
export function fillPianoPhrase(p: PatchParams, midi: number, hold: number, g: number): void {
  p.midi = midi;
  p.dur = hold;
  p.bright = 0.35;
  p.gain = 0.8 * g;
}

/** The chord tone nearest `midi` inside [lo, hi] (or `midi` itself when none is). */
export function nearestChordTone(h: Harmony, midi: number, lo: number, hi: number): number {
  for (let k = 0; k <= 6; k++) {
    if (midi - k >= lo && h.isChordTone(midi - k)) return midi - k;
    if (midi + k <= hi && h.isChordTone(midi + k)) return midi + k;
  }
  return midi;
}

/** The canopy's low felt-piano answer: the chord tone nearest voice 1 in [57, 69]. */
export function fillPianoAnswer(p: PatchParams, h: Harmony): void {
  p.midi = nearestChordTone(h, h.voice(1, 0), 57, 69);
  p.dur = 1.6;
  p.bright = 0.5;
  p.gain = 0.7;
}

/** Shrine arpeggio note k (0..4 up the voicing): the downbeat at 0.85, the others 0.55..0.75. */
export function fillArp(p: PatchParams, h: Harmony, k: number, downbeat: boolean, r: number): void {
  p.midi = h.voice(k % 4, k >> 2);
  p.dur = 0.9;
  p.bright = 0.45;
  p.gain = downbeat ? 0.85 : 0.55 + 0.2 * r;
}

/** The gully's low pulse: 1 on the downbeat, 0.72 on beat 3, 0.42 for the pickup. */
export function fillPulse(p: PatchParams, h: Harmony, gain: number): void {
  p.midi = h.bass(0);
  p.gain = gain;
}

/** Rootwell drip on pad voice k two octaves up; r = the level draw (0.7..1). */
export function fillDrip(p: PatchParams, h: Harmony, k: number, variant: number, r: number): void {
  p.midi = h.voice(k, 2);
  p.variant = variant;
  p.gain = 0.7 + 0.3 * r;
}

/** Veil shimmer: one of six scale steps up from the degree nearest C6; r = the level draw (0.75..1). */
export function fillShimmer(p: PatchParams, h: Harmony, k: number, variant: number, r: number): void {
  p.midi = h.note(h.degreeNear(84) + k);
  p.variant = variant;
  p.gain = 0.75 + 0.25 * r;
}
