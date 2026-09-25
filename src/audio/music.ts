import type { AudioFrame } from '../contracts/audio.ts';
import { AREA_GRADES, type AreaGradeId } from '../contracts/level.ts';
import { Rng } from '../core/rng.ts';
import { areaWeights, createAreaWeights, type AreaWeights } from '../core/zones.ts';
import type { Engine } from './engine.ts';
import {
  DRONE_STYLES, fillArp, fillBell, fillDrip, fillDrone, fillHarmonics, fillPad, fillPianoAnswer, fillPianoPhrase,
  fillPulse, fillShimmer, LANES, LAST_RING_BELL, LAST_RING_PIANO, nearestChordTone, PAD_STYLES, SHRINE_BELL,
  type Lane, type PadStyle,
} from './fills.ts';
import type { Harmony } from './harmony.ts';
import type { PatchId } from './patches/index.ts';
import { setValue, targetAt, type GainNodePort, type StereoPannerNodePort } from './ports.ts';
import { AUDIO_TUNING } from './tuning.ts';
import { unit } from './util.ts';
import { release, Tail, type Voice } from './voices.ts';

const N = AREA_GRADES.length;
const GLADE = 0;
const GULLY = 1;
const ROOTWELL = 2;
const CANOPY = 3;
const VEIL = 4;
const SHRINE = 5;
/** Bus-level pan slots per layer: left, centre, right. */
const SLOT_PAN = [-0.3, 0, 0.3] as const;
const L = 0;
const C = 1;
const R = 2;
/**
 * Phrase rhythms: note onsets in steps (eighths) from the phrase start; the last note rings on. Glade:
 * sparse and lyrical; canopy: flowing, more notes; gully: short falling sighs.
 */
const RHYTHM_GLADE = [[0, 2, 4, 8], [0, 3, 4, 8], [0, 2, 3, 6], [0, 4, 6], [0, 2, 6], [1, 2, 4, 7]] as const;
const RHYTHM_CANOPY = [[0, 1, 2, 4, 6], [0, 2, 3, 4, 6], [0, 1, 3, 4, 7], [0, 2, 4, 5, 6], [0, 1, 2, 3, 5]] as const;
const RHYTHM_GULLY = [[0, 3], [1, 3, 6], [0, 4], [2, 3, 6]] as const;
/** Shrine arpeggio: bar patterns (step positions) over a rise-and-fall through the voicing. */
const ARP_PATTERNS = [[0, 1, 2, 3, 4, 5, 6, 7], [0, 2, 3, 4, 6], [0, 1, 2, 4, 5, 6], [0, 2, 4, 6]] as const;
const ARP_INDEX = [0, 1, 2, 3, 4, 3, 2, 1] as const;
/** Phrase lanes. */
const P_GLADE = 0;
const P_CANOPY = 1;
const P_GULLY = 2;

/** A planned melodic phrase: up to 8 notes at absolute steps, all from one harmony. */
class Phrase {
  readonly at = new Int32Array(8);
  readonly midi = new Float64Array(8);
  readonly gain = new Float64Array(8);
  n = 0;
  i = 0;
  /** Harmony version the phrase was written against (a change drops the rest). */
  version = -1;
  /** Last note played (MIDI), so the next phrase starts nearby. */
  last = 0;
}
/** Layer target changes smaller than this are not rewritten. */
const LAYER_EPS = 0.004;

/**
 * Generative music (§5.9 Music). One transport (tempo, bar grid, tonic) drives six area layers whose
 * gains follow areaWeights at the camera (the uncovered remainder goes to glade), smoothed with τ = 1.5 s.
 * The harmony (mode + chord) follows the dominant area and changes only on bar lines, and only when the
 * new area's weight beats the current one by 0.2; every layer takes its notes from it.
 *
 * The scheduler runs inside update() (no timers): it books steps in (now + lead, now + 0.25], lead =
 * max(0.03, 2·baseLatency); a step that is already late is dropped, never played late. The Rng (seeded
 * from level.seed) draws exactly once per step, booked or dropped, so the note sequence is a function
 * of the step index, not of the frame rate. Ornaments (a drip up to 0.2 s into its step, the shrine bell
 * 10 ms after its downbeat) are booked once, together with their step, and dropped with it: a stall can
 * never release a burst of them.
 *
 * Each layer's note density scales with its smoothed weight (the same τ as the layer gain, advanced once
 * per step), so a two-area blend plays about one area's worth of notes instead of two and does not force
 * steals. Each layer's first bed voice (its pad, or the rootwell drone and the veil harmonics) and the
 * gully's downbeat pulse always play while the layer is audible; a second bed voice thins like the notes.
 */
export class MusicEngine {
  /** Raw per-area weights at the camera this frame (remainder added to glade). */
  readonly weights: AreaWeights = createAreaWeights();
  readonly target = new Float64Array(N);
  /** Per-layer weight smoothed with layerTau, advanced once per step: scales the layer's note density. */
  readonly smooth = new Float64Array(N);
  readonly layers: GainNodePort[] = [];
  readonly slots: StereoPannerNodePort[][] = [];
  readonly stepDur: number;
  readonly stepsPerBar: number;
  readonly stepsPerChord: number;
  /** Next step to process, the transport origin, and bookkeeping for inspection. */
  step = 0;
  t0 = 0;
  started = false;
  harmonySet = false;
  /** Step of the latest chord change (a harmony change resets the chord cycle). */
  chordStep = 0;
  /** Steps at which the harmony area last changed, and counts of booked and dropped steps. */
  lastAreaChangeStep = -1;
  booked = 0;
  dropped = 0;

  private readonly e: Engine;
  private readonly rng: Rng;
  private readonly written = new Float64Array(N).fill(NaN);
  private readonly phrases = [new Phrase(), new Phrase(), new Phrase()];
  private arpPattern = 0;
  private alt = 0;
  private readonly smoothK: number;

  constructor(e: Engine, seed: number) {
    const t = AUDIO_TUNING;
    this.e = e;
    this.rng = new Rng(seed >>> 0);
    this.stepDur = 60 / t.tempoBpm / t.stepsPerBeat;
    this.stepsPerBar = t.stepsPerBeat * t.beatsPerBar;
    this.stepsPerChord = this.stepsPerBar * t.barsPerChord;
    this.smoothK = 1 - Math.exp(-this.stepDur / t.layerTau);
    const ctx = e.ctx;
    for (let a = 0; a < N; a++) {
      const g = ctx.createGain();
      setValue(g.gain, 0);
      g.connect(e.mixer.music);
      this.layers.push(g);
      const row: StereoPannerNodePort[] = [];
      for (let s = 0; s < 3; s++) {
        const p = ctx.createStereoPanner();
        setValue(p.pan, SLOT_PAN[s] as number);
        p.connect(g);
        row.push(p);
      }
      this.slots.push(row);
    }
  }

  get harmony(): Harmony {
    return this.e.harmony;
  }

  stepTime(i: number): number {
    return this.t0 + i * this.stepDur;
  }

  update(frame: AudioFrame): void {
    const e = this.e;
    const t = AUDIO_TUNING;
    const now = e.now;
    const w = this.weights;
    const rem = areaWeights(w, frame.sim.level.gradeZones, frame.camX, frame.camY);
    w.glade += rem;
    for (let a = 0; a < N; a++) {
      const tg = w[AREA_GRADES[a] as AreaGradeId];
      this.target[a] = tg;
      const last = this.written[a] as number;
      if (!(Math.abs(tg - last) <= LAYER_EPS)) {
        targetAt((this.layers[a] as GainNodePort).gain, tg, now, t.layerTau);
        this.written[a] = tg;
      }
    }

    if (!this.started) {
      this.started = true;
      this.t0 = now + e.lead + 0.1;
      this.step = 0;
    }
    const minT = now + e.lead;
    // The window is (now + lead, now + 0.25]; only when a huge baseLatency would squeeze it below a few
    // frames does the horizon stretch (lead + 0.05), so steps are never lost between two updates.
    const horizon = Math.max(now + t.horizon, minT + 0.05);
    if (this.stepTime(this.step) < now - t.maxCatchUpSteps * this.stepDur) {
      // A very long stall: re-anchor on the next bar line instead of drawing through every step.
      const next = Math.ceil((minT - this.t0) / this.stepDur);
      this.step = Math.ceil(next / this.stepsPerBar) * this.stepsPerBar;
    }
    const audible = e.mixer.volumeGain('music') > 0 && e.mixer.volumeGain('master') > 0;
    while (this.stepTime(this.step) <= horizon) {
      const u = this.rng.nextU32();
      const st = this.stepTime(this.step);
      for (let a = 0; a < N; a++) {
        const sm = this.smooth[a] as number;
        this.smooth[a] = sm + ((this.target[a] as number) - sm) * this.smoothK;
      }
      if (this.step % this.stepsPerBar === 0) this.barLine();
      if (st > minT) {
        if (audible) this.book(this.step, st, u);
        this.booked++;
      } else {
        this.dropped++;
      }
      this.step++;
    }
  }

  /** Bar line: switch the harmony area (with hysteresis) or advance the chord cycle. */
  private barLine(): void {
    const h = this.e.harmony;
    let best = 0;
    for (let a = 1; a < N; a++) if ((this.target[a] as number) > (this.target[best] as number)) best = a;
    const bestId = AREA_GRADES[best] as AreaGradeId;
    if (!this.harmonySet) {
      this.harmonySet = true;
      h.set(bestId, 0);
      this.chordStep = this.step;
      this.lastAreaChangeStep = this.step;
      return;
    }
    const cur = AREA_GRADES.indexOf(h.area);
    if (best !== cur && (this.target[best] as number) >= (this.target[cur] as number) + AUDIO_TUNING.harmonyHysteresis) {
      h.set(bestId, 0);
      this.chordStep = this.step;
      this.lastAreaChangeStep = this.step;
      this.releaseHarmony();
      return;
    }
    if ((this.step - this.chordStep) % this.stepsPerChord === 0 && this.step !== this.chordStep) {
      h.set(h.area, h.chord + 1);
      this.chordStep = this.step;
    }
  }

  /**
   * On an area change every voice of the old harmony fades (sustained ones over 1.5 s, bells and plucks
   * over 0.6 s), so two harmonies never overlap.
   */
  private releaseHarmony(): void {
    const e = this.e;
    const r = e.musicPool.records;
    for (let i = 0; i < r.length; i++) {
      const v = r[i] as Voice;
      if (v.active && v.sounding) release(v, e.now, v.priority >= 2 ? 1.5 : 0.6);
    }
  }

  private play(a: number, slot: number, id: PatchId, t: number): void {
    const e = this.e;
    e.start(e.musicPool, id, t, (this.slots[a] as StereoPannerNodePort[])[slot] as StereoPannerNodePort, Tail.Direct, 0);
  }

  private book(step: number, st: number, u: number): void {
    const t = AUDIO_TUNING;
    const inBar = step % this.stepsPerBar;
    const chordStart = step === this.chordStep;
    const chordBar = Math.floor((step - this.chordStep) / this.stepsPerBar);
    const chordLen = this.stepsPerChord * this.stepDur;
    const h = this.e.harmony;
    for (let a = 0; a < N; a++) {
      // The raw target, not the frame-smoothed level: bookings stay independent of the frame rate, and a
      // layer fading out just stops starting new notes.
      if ((this.target[a] as number) < t.layerAudible) continue;
      // Note density follows the step-smoothed weight.
      const w = this.smooth[a] as number;
      const salt = a * 32;
      const r0 = unit(u, salt);
      const r1 = unit(u, salt + 1);
      const r2 = unit(u, salt + 2);
      switch (a) {
        case GLADE: {
          if (chordStart) this.pad(a, st, chordLen, PAD_STYLES.glade);
          // A lyrical bell phrase most bars, answered less often in the chord's second bar.
          if (inBar === 0 && r0 < (chordBar === 0 ? 0.8 : 0.45) * w) {
            this.plan(P_GLADE, step, u, salt + 8, RHYTHM_GLADE, LANES.glade, false);
          }
          this.playPhrase(P_GLADE, a, step, st, 'bell', LANES.glade.ring + LANES.glade.spread * r1);
          break;
        }
        case GULLY: {
          if (chordStart) this.pad(a, st, chordLen, PAD_STYLES.gully);
          // A slow low pulse: beats 1 and 3, sometimes a soft pickup before the bar.
          if (inBar === 0 || (inBar === 4 && r0 < 0.8 * w) || (inBar === 7 && r0 < 0.3 * w)) {
            fillPulse(this.e.p(), h, inBar === 0 ? 1 : inBar === 4 ? 0.72 : 0.42);
            this.play(a, C, 'pulse', st);
          }
          // Now and then a falling sigh on the felt piano.
          if (chordStart && r1 < 0.4 * w) this.plan(P_GULLY, step + 4, u, salt + 8, RHYTHM_GULLY, LANES.gully, true);
          this.playPhrase(P_GULLY, a, step, st, 'piano', LANES.gully.ring);
          break;
        }
        case ROOTWELL: {
          if (chordStart) {
            fillDrone(this.e.p(), h, DRONE_STYLES.rootwell, chordLen);
            this.play(a, C, 'drone', st);
            // The dark pad under the drone is the layer's second bed voice: it thins with the weight.
            if (unit(u, salt + 5) < w) this.pad(a, st, chordLen, PAD_STYLES.rootwell);
          }
          if (r0 < 0.22 * w) {
            fillDrip(this.e.p(), h, Math.floor(r1 * 4), r2, unit(u, salt + 3));
            this.play(a, r2 < 0.33 ? L : r2 < 0.66 ? C : R, 'drip', st + 0.2 * unit(u, salt + 4));
          }
          break;
        }
        case CANOPY: {
          if (chordStart) this.pad(a, st, chordLen, PAD_STYLES.canopy);
          if (inBar === 0 && r0 < 0.9 * w) this.plan(P_CANOPY, step, u, salt + 8, RHYTHM_CANOPY, LANES.canopy, false);
          this.playPhrase(P_CANOPY, a, step, st, 'bell', LANES.canopy.ring + LANES.canopy.spread * r1);
          // A low felt-piano answer at the start of the chord's second bar.
          if (inBar === 0 && chordBar === 1 && r2 < 0.45 * w) {
            fillPianoAnswer(this.e.p(), h);
            this.play(a, C, 'piano', st);
          }
          break;
        }
        case VEIL: {
          if (chordStart) {
            fillHarmonics(this.e.p(), h, chordLen, r1);
            this.play(a, C, 'harmonics', st);
            // The quiet drone is the layer's second bed voice: it thins with the weight.
            if (unit(u, salt + 5) < w) {
              fillDrone(this.e.p(), h, DRONE_STYLES.veil, chordLen);
              this.play(a, C, 'drone', st);
            }
          }
          // Whole-tone shimmer: aimless on purpose.
          if (inBar % 2 === 0 && r0 < 0.3 * w) {
            fillShimmer(this.e.p(), h, Math.floor(r1 * 6), r2, unit(u, salt + 3));
            this.play(a, this.nextAlt(), 'shimmer', st);
          }
          break;
        }
        case SHRINE: {
          if (chordStart) this.pad(a, st, chordLen, PAD_STYLES.shrine);
          // Felt-piano arpeggio rising and falling through the chord, one pattern per bar; the downbeat
          // always sounds, the other notes thin out with the weight.
          if (inBar === 0) this.arpPattern = Math.floor(r0 * ARP_PATTERNS.length);
          const pat = ARP_PATTERNS[this.arpPattern] as readonly number[];
          if (pat.indexOf(inBar) >= 0 && (inBar === 0 || unit(u, salt + 5) < w)) {
            const k = ARP_INDEX[inBar] as number;
            fillArp(this.e.p(), h, k, inBar === 0, r1);
            this.play(a, k % 2 === 0 ? L : R, 'piano', st);
          }
          if (inBar === 0 && chordBar === 0 && r2 < 0.5 * w) this.bell(a, st + 0.01, h.voice(3, 1), SHRINE_BELL.ring, SHRINE_BELL.gain);
          break;
        }
        default:
          break;
      }
    }
  }

  /**
   * Write a phrase for `lane` from this step's draw: a rhythm from `rhythms`, an arch (or, `falling`, a
   * descending line) moving by scale steps and thirds inside the register, starting near the lane's last note
   * and ending on a chord tone. Notes are fixed now, from the current harmony.
   */
  private plan(lane: number, step: number, u: number, salt: number, rhythms: readonly (readonly number[])[], reg: Lane, falling: boolean): void {
    const h = this.e.harmony;
    const lo = reg.lo;
    const hi = reg.hi;
    const ph = this.phrases[lane] as Phrase;
    const rh = rhythms[Math.floor(unit(u, salt) * rhythms.length)] as readonly number[];
    // Keep the phrase inside the current chord (it is written against it).
    const nextChord = this.chordStep + this.stepsPerChord;
    let n = rh.length;
    while (n > 1 && step + (rh[n - 1] as number) >= nextChord) n--;
    const mid = falling ? lo + 0.7 * (hi - lo) : (lo + hi) / 2;
    const from = ph.last > 0 ? ph.last : mid;
    let d = h.degreeNear(from < lo ? lo : from > hi ? hi : from);
    let dir = falling ? -1 : unit(u, salt + 1) < 0.55 ? 1 : -1;
    // A falling line starts from the upper part of the range so it has room to fall.
    if (falling && h.note(d) < mid) d = h.degreeNear(mid);
    const turn = 1 + Math.floor(unit(u, salt + 2) * Math.max(1, n - 1));
    for (let i = 0; i < n; i++) {
      if (!falling && i === turn) dir = -dir;
      if (i > 0 || unit(u, salt + 3) < 0.6) {
        const size = unit(u, salt + 4 + i) < 0.7 ? 1 : 2;
        // Bounce off the register edges instead of sticking to them.
        if (h.note(d + dir * size) > hi || h.note(d + dir * size) < lo) dir = -dir;
        d += dir * size;
      }
      const m = h.note(d);
      ph.midi[i] = m;
      ph.at[i] = step + (rh[i] as number);
      ph.gain[i] = i === 0 ? 1 : i === n - 1 ? 0.8 : 0.9 - 0.05 * i;
    }
    ph.midi[n - 1] = nearestChordTone(h, ph.midi[n - 1] as number, lo, hi);
    ph.n = n;
    ph.i = 0;
    ph.version = h.version;
  }

  /** Play the notes of `lane`'s phrase that fall on this step (late ones are skipped, never played late). */
  private playPhrase(lane: number, a: number, step: number, st: number, id: 'bell' | 'piano', ring: number): void {
    const ph = this.phrases[lane] as Phrase;
    if (ph.version !== this.e.harmony.version) ph.n = 0;
    while (ph.i < ph.n && (ph.at[ph.i] as number) < step) ph.i++;
    while (ph.i < ph.n && ph.at[ph.i] === step) {
      const m = ph.midi[ph.i] as number;
      const g = ph.gain[ph.i] as number;
      const last = ph.i === ph.n - 1;
      if (id === 'bell') {
        this.bell(a, st, m, last ? ring * LAST_RING_BELL : ring, g);
      } else {
        fillPianoPhrase(this.e.p(), m, last ? ring * LAST_RING_PIANO : ring, g);
        this.play(a, C, 'piano', st);
      }
      ph.last = m;
      ph.i++;
    }
  }

  private pad(a: number, st: number, chordLen: number, style: PadStyle): void {
    fillPad(this.e.p(), this.e.harmony, style, chordLen, unit(this.step, a));
    this.play(a, C, 'pad', st);
  }

  private bell(a: number, st: number, midi: number, ring: number, gain: number): void {
    fillBell(this.e.p(), midi, ring, gain);
    this.play(a, this.nextAlt(), 'bell', st);
  }

  private nextAlt(): number {
    this.alt ^= 1;
    return this.alt === 0 ? L : R;
  }
}
