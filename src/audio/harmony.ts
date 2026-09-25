import type { AreaGradeId } from '../contracts/level.ts';
import { AUDIO_TUNING } from './tuning.ts';

/**
 * One chord of an area's cycle: four hand-voiced pad notes and a bass note, in semitones relative to
 * the shared tonic (D4). Consecutive chords are voiced for smooth, mostly stepwise voice leading.
 */
export interface ChordDef {
  readonly bass: number;
  readonly voicing: readonly [number, number, number, number];
}

/** An area's mood (§5.9 Music): its mode and chord cycle. All moods share the tonic D. */
export interface MoodDef {
  /** Pitch classes of the mode, ascending from the tonic (0). */
  readonly scale: readonly number[];
  readonly chords: readonly ChordDef[];
}

export const MOODS: Readonly<Record<AreaGradeId, MoodDef>> = Object.freeze({
  // Warm major pentatonic: D6/9 → Bm11 → G6/9 → A sus4(add9), stacked fifths and open thirds.
  glade: {
    scale: [0, 2, 4, 7, 9],
    chords: [
      { bass: -24, voicing: [-12, -5, 2, 4] },
      { bass: -27, voicing: [-8, -5, 0, 2] },
      { bass: -31, voicing: [-12, -3, 2, 7] },
      { bass: -29, voicing: [-12, -5, 2, 9] },
    ],
  },
  // Aeolian: Dm9 → B♭maj7 → Gm9 → A7sus4.
  gully: {
    scale: [0, 2, 3, 5, 7, 8, 10],
    chords: [
      { bass: -24, voicing: [-9, -2, 2, 7] },
      { bass: -28, voicing: [-9, -5, 0, 7] },
      { bass: -31, voicing: [-7, -4, 3, 7] },
      { bass: -29, voicing: [-7, 0, 2, 7] },
    ],
  },
  // Phrygian over a D pedal: Dm(add11) → E♭maj7/D → Dm → B♭/D.
  rootwell: {
    scale: [0, 1, 3, 5, 7, 8, 10],
    chords: [
      { bass: -24, voicing: [-12, -5, 3, 5] },
      { bass: -24, voicing: [-11, -4, 0, 5] },
      { bass: -24, voicing: [-12, -5, 0, 3] },
      { bass: -24, voicing: [-12, -4, 0, 3] },
    ],
  },
  // Lydian, airy: Dmaj9 → E/D → F♯m7 → Bm9.
  canopy: {
    scale: [0, 2, 4, 6, 7, 9, 11],
    chords: [
      { bass: -24, voicing: [-8, -1, 2, 7] },
      { bass: -24, voicing: [-6, -3, 2, 9] },
      { bass: -20, voicing: [-5, -1, 2, 7] },
      { bass: -27, voicing: [-5, 0, 4, 11] },
    ],
  },
  // Whole tone: augmented colours moving in parallel whole steps.
  veil: {
    scale: [0, 2, 4, 6, 8, 10],
    chords: [
      { bass: -24, voicing: [-8, -2, 4, 8] },
      { bass: -22, voicing: [-6, -2, 2, 6] },
      { bass: -28, voicing: [-4, 0, 4, 10] },
      { bass: -26, voicing: [-6, -2, 4, 8] },
    ],
  },
  // Ionian, warm major sevenths: Dmaj9 → Gmaj9 → Em9 → A9sus4.
  shrine: {
    scale: [0, 2, 4, 5, 7, 9, 11],
    chords: [
      { bass: -24, voicing: [-8, -1, 2, 7] },
      { bass: -31, voicing: [-8, -3, 0, 7] },
      { bass: -22, voicing: [-7, -3, 0, 4] },
      { bass: -29, voicing: [-7, -3, 0, 2] },
    ],
  },
});

function pc(semi: number): number {
  return ((semi % 12) + 12) % 12;
}

/**
 * The current harmony: the dominant area's mode and chord. Every sounding layer and every melodic SFX
 * takes its pitches from here, so two harmonic engines never clash (§5.9).
 */
export class Harmony {
  area: AreaGradeId = 'glade';
  chord = 0;
  /** Bumped on every change, so voices can tell a new chord from the old one. */
  version = 0;
  private mood: MoodDef = MOODS.glade;
  private readonly chordPcs = new Uint8Array(12);

  constructor() {
    this.set('glade', 0);
  }

  set(area: AreaGradeId, chord: number): void {
    this.area = area;
    this.mood = MOODS[area];
    const n = this.mood.chords.length;
    this.chord = ((chord % n) + n) % n;
    this.chordPcs.fill(0);
    const c = this.current();
    this.chordPcs[pc(c.bass)] = 1;
    for (let i = 0; i < 4; i++) this.chordPcs[pc(c.voicing[i] as number)] = 1;
    this.version++;
  }

  current(): ChordDef {
    return this.mood.chords[this.chord] as ChordDef;
  }

  get chordCount(): number {
    return this.mood.chords.length;
  }

  get scaleLength(): number {
    return this.mood.scale.length;
  }

  /** Absolute MIDI of pad voice i (0..3) of the current chord, shifted by `octaves`. */
  voice(i: number, octaves = 0): number {
    return AUDIO_TUNING.tonicMidi + (this.current().voicing[i] as number) + 12 * octaves;
  }

  bass(octaves = 0): number {
    return AUDIO_TUNING.tonicMidi + this.current().bass + 12 * octaves;
  }

  /** MIDI of absolute scale degree `d` (0 = D4, one scale length per octave). */
  note(d: number): number {
    const s = this.mood.scale;
    const n = s.length;
    const oct = Math.floor(d / n);
    return AUDIO_TUNING.tonicMidi + 12 * oct + (s[d - oct * n] as number);
  }

  /** The scale degree whose note is nearest `midi` (ties go down). */
  degreeNear(midi: number): number {
    const n = this.mood.scale.length;
    let d = Math.floor(((midi - AUDIO_TUNING.tonicMidi) / 12) * n) - n;
    let best = d;
    let bestDist = Infinity;
    for (let k = 0; k < 3 * n; k++, d++) {
      const dist = Math.abs(this.note(d) - midi);
      if (dist < bestDist) {
        bestDist = dist;
        best = d;
      }
    }
    return best;
  }

  isChordTone(midi: number): boolean {
    return this.chordPcs[pc(midi - AUDIO_TUNING.tonicMidi)] === 1;
  }

  /**
   * Where melodic SFX climbs start (the orb combo): the chord root placed nearest C5, or the first
   * chord tone above it when the root is not in the scale.
   */
  comboBase(): number {
    const b = this.bass(0);
    return this.chordDegreeFrom(b + 12 * Math.round((72 - b) / 12));
  }

  /** Lowest scale degree at or above `midi` whose note is a chord tone. */
  chordDegreeFrom(midi: number): number {
    let d = this.degreeNear(midi);
    if (this.note(d) < midi) d++;
    for (let k = 0; k < 12; k++, d++) if (this.isChordTone(this.note(d))) return d;
    return this.degreeNear(midi);
  }
}
