import { AREA_GRADES, type AreaGradeId } from '../contracts/level.ts';
import { Rng } from '../core/rng.ts';
import type { Engine } from './engine.ts';
import { fillOwl } from './fills.ts';
import { chirpLength, cricketChirp } from './patches/ambience.ts';
import { targetAt } from './ports.ts';
import { AUDIO_TUNING } from './tuning.ts';
import { release, renewLease, Tail, VoiceRef, type Voice } from './voices.ts';

/** Per-area wind level and cricket density (0..1). */
const WIND: Readonly<Record<AreaGradeId, number>> = { glade: 0.55, gully: 0.8, rootwell: 0.35, canopy: 0.95, veil: 0.7, shrine: 0.4 };
const CRICKETS: Readonly<Record<AreaGradeId, number>> = { glade: 0.9, gully: 0.55, rootwell: 0.1, canopy: 0.6, veil: 0.3, shrine: 1.0 };
/** Areas whose rare sound is an owl (the others creak). */
const OWL: Readonly<Record<AreaGradeId, boolean>> = { glade: true, gully: false, rootwell: false, canopy: true, veil: false, shrine: true };

/** A bed that lapsed, or comes back after the slider was at 0, returns over this (not the slow first fade-in). */
const BED_RETURN = 0.35;

/**
 * Ambience (§5.9): a wind bed (filtered noise on slow LFOs, with rare gusts) and a cricket bed (gain-gated
 * FM on persistent oscillators; chirps are gate automation, never new nodes), both long-lived leases
 * outside the budgets; a rare owl or wood creak; water drips in the Rootwell. Crickets hold still while
 * the world is frozen. Nothing plays into a zero SFX (ambience) or master slider: the beds release and
 * come back when the slider does. Its own Rng keeps the music's one-draw-per-step sequence intact.
 */
export class AmbienceEngine {
  readonly wind = new VoiceRef();
  readonly crickets = new VoiceRef();
  /** Next rare sound, drip, gust and per-cricket chirp times (context seconds). */
  nextRare = 0;
  nextDrip = 0;
  nextGust = 0;
  readonly nextChirp = new Float64Array(3);
  private readonly e: Engine;
  private readonly rng: Rng;
  private windLevel = NaN;
  private cricketLevel = NaN;
  private started = false;
  /** A bed of this kind has played before (restarts use BED_RETURN). */
  private windOnce = false;
  private cricketsOnce = false;

  constructor(e: Engine, seed: number) {
    this.e = e;
    this.rng = new Rng((seed ^ 0xa3b1_e2c4) >>> 0);
  }

  update(): void {
    const e = this.e;
    const now = e.now;
    const w = e.music.weights;
    if (!this.started) {
      this.started = true;
      this.nextRare = now + 20 + 25 * this.rng.next();
      this.nextDrip = now + 1;
      this.nextGust = now + 8 + 10 * this.rng.next();
      for (let i = 0; i < 3; i++) this.nextChirp[i] = now + 1 + i * 0.37;
    }
    let wind = 0;
    let crick = 0;
    let dom = 0;
    for (let a = 0; a < AREA_GRADES.length; a++) {
      const id = AREA_GRADES[a] as AreaGradeId;
      const wa = w[id];
      wind += wa * WIND[id];
      crick += wa * CRICKETS[id];
      if (wa > (w[AREA_GRADES[dom] as AreaGradeId] as number)) dom = a;
    }

    // Beds: long-lived leases (re-issued every update; a stalled update() lets them fade on their own).
    const audible = e.sfxAudible();
    const wv = this.bed(this.wind, 'windBed', wind, audible);
    const cv = this.bed(this.crickets, 'cricketBed', 0.3 + 0.7 * crick, audible);
    if (wv) {
      const lvl = wind;
      if (!(Math.abs(lvl - this.windLevel) <= 0.01)) {
        const h = wv.handles[0];
        if (h) targetAt(h, lvl, now, AUDIO_TUNING.levelTau);
        this.windLevel = lvl;
      }
      if (now >= this.nextGust) {
        const g = wv.handles[1];
        if (g) {
          // From now: the curve starts at the current value (no event before it to extrapolate from).
          const peak = 1.3 + 0.6 * this.rng.next();
          targetAt(g, peak, now, 1.1);
          targetAt(g, 1, now + 2.2 + this.rng.next(), 1.8);
        }
        this.nextGust = now + 9 + 14 * this.rng.next();
      }
    }
    if (cv) {
      const lvl = 0.3 + 0.7 * crick;
      if (!(Math.abs(lvl - this.cricketLevel) <= 0.01)) {
        const h = cv.handles[0];
        if (h) targetAt(h, lvl, now, AUDIO_TUNING.levelTau);
        this.cricketLevel = lvl;
      }
      this.chirps(cv, crick);
    }

    if (e.paused || !audible) return;
    // Rare owl or creak, placed somewhere off to a side.
    if (now >= this.nextRare) {
      const id = AREA_GRADES[dom] as AreaGradeId;
      const p = e.p();
      p.variant = this.rng.next();
      // Pitched from the harmony (a chord tone from E4 or G4), so it never clashes with the music.
      fillOwl(p, e.harmony, this.rng.next() >= 0.5);
      const pan = (this.rng.next() * 2 - 1) * 0.5;
      e.start(e.ambiencePool, OWL[id] ? 'owl' : 'creak', now + e.lead, e.mixer.ambience, Tail.Pan, pan);
      this.nextRare = now + 25 + 35 * this.rng.next();
    }
    // Rootwell drips, denser the deeper in.
    const root = w.rootwell;
    if (root > 0.1 && now >= this.nextDrip) {
      const p = e.p();
      p.variant = this.rng.next();
      p.gain = 0.5 + 0.5 * root;
      const pan = (this.rng.next() * 2 - 1) * 0.5;
      e.start(e.ambiencePool, 'waterDrip', now + e.lead + 0.1 * this.rng.next(), e.mixer.ambience, Tail.Pan, pan);
      this.nextDrip = now + (0.8 + 2.6 * this.rng.next()) / Math.max(0.3, root);
    } else if (root <= 0.1 && this.nextDrip < now) {
      this.nextDrip = now + 1;
    }
  }

  /**
   * Keep a bed lease alive (start it once its buffer exists). Into a zero slider it releases and does not
   * start; it comes back when the slider does. Returns the live voice.
   */
  private bed(ref: VoiceRef, id: 'windBed' | 'cricketBed', level: number, audible: boolean): Voice | null {
    const e = this.e;
    const v = ref.live();
    if (!audible) {
      if (v) release(v, e.now, AUDIO_TUNING.pauseReleaseSec);
      ref.clear();
      return null;
    }
    if (v && renewLease(v, e.now)) return v;
    const wind = id === 'windBed';
    const p = e.p();
    p.gain = level;
    // A bed that lapsed (update() stalled) or was muted comes back with a short cross-fade.
    if (wind ? this.windOnce : this.cricketsOnce) p.attack = BED_RETURN;
    p.variant = this.rng.next();
    const nv = e.start(e.bedPool, id, e.now + e.lead, e.mixer.ambience, Tail.Centre, 0);
    ref.set(nv);
    if (nv && wind) {
      this.windLevel = level;
      this.windOnce = true;
    }
    if (nv && !wind) {
      this.cricketLevel = level;
      this.cricketsOnce = true;
    }
    return nv;
  }

  /** Book chirps in the lookahead window on each cricket's gate; cricket i sings while density allows. */
  private chirps(v: Voice, density: number): void {
    const e = this.e;
    const horizon = e.now + AUDIO_TUNING.horizon;
    for (let i = 0; i < 3; i++) {
      const gate = v.handles[1 + i];
      if (!gate) continue;
      let next = this.nextChirp[i] as number;
      if (next < e.now + e.lead) next = e.now + e.lead;
      let guard = 0;
      while (next <= horizon && guard++ < 4) {
        const len = chirpLength(i);
        const sing = !e.frozen && this.rng.next() < density * (1 - 0.25 * i);
        if (sing) cricketChirp(gate, next, len, 0.8 + 0.2 * this.rng.next());
        // Crickets keep a steady pulse with occasional rests.
        const rest = this.rng.next() < 0.12 ? 0.8 + 1.4 * this.rng.next() : 0;
        next += len + 0.24 + 0.1 * i + 0.06 * this.rng.next() + rest;
      }
      this.nextChirp[i] = next;
    }
  }
}
