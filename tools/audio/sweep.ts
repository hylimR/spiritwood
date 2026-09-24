/**
 * Headroom sweep (§5.9: each patch alone peaks ≤ −12 dBFS per channel on its bus): every melodic patch
 * in every mood × chord, with the engines' own fills (src/audio/fills.ts) through the engines' own tails,
 * and the leases with their steered handles held at the maxima the engines reach. Short windows hold each
 * patch's peak; renders run concurrently (node-web-audio-api renders off the JS thread).
 */
import { BufferBuilder } from '../../src/audio/buffers.ts';
import * as F from '../../src/audio/fills.ts';
import { Harmony, MOODS } from '../../src/audio/harmony.ts';
import { createParams, createWaves, resetParams, type PatchParams } from '../../src/audio/kit.ts';
import { PATCHES, type PatchId } from '../../src/audio/patches/index.ts';
import { rattleTargets, scrapeTargets } from '../../src/audio/patches/sfx.ts';
import { setAt, type AudioBufferPort, type AudioNodePort, type AudioParamPort, type GraphPort } from '../../src/audio/ports.ts';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';
import { AREA_GRADES, type AreaGradeId } from '../../src/contracts/level.ts';
import { db } from './analyze.ts';
import { RecordingSink, SR, type OfflineCtor } from './patchRender.ts';

export interface SweepCase {
  id: PatchId;
  label: string;
  /** The engine tail: the 0.7071 centre gain, or a panner at this pan (the worst the engine uses). */
  pan: number | 'centre';
  /** Render window (s after the start): long enough to hold the patch's peak. */
  seconds: number;
  /** Rendered in every mood × chord (melodic), or once (harmony-free). */
  harmonic: boolean;
  /** Per-note cases: every note this returns in a harmony is rendered (passed to fill as `midi`). */
  notes?(h: Harmony): number[];
  fill(p: PatchParams, h: Harmony, midi: number): void;
  /** Lease handles held at their steered maxima from the start (setValueAtTime: nothing to extrapolate). */
  steer?(handles: readonly (AudioParamPort | null)[], t: number): void;
}

export interface SweepResult {
  id: PatchId;
  label: string;
  area: AreaGradeId | '-';
  chord: number;
  db: number;
}

const T = AUDIO_TUNING;
const START = 0.02;
/** Chord length (s) at the music tempo. */
export const CHORD_LEN = (T.barsPerChord * T.beatsPerBar * 60) / T.tempoBpm;
/** Worst side-slot pan of the music (bells, the shrine arpeggio, drips, shimmer). */
const SLOT = 0.3;
const SPATIAL = T.panScale;
const AMBIENT = 0.5;

function hold(hs: readonly (AudioParamPort | null)[], slot: number, v: number, t: number): void {
  const p = hs[slot];
  if (p) setAt(p, v, t);
}

/**
 * MIDI notes a melody lane can play in the current harmony: scale notes and chord tones in [lo, hi], plus
 * two semitones either side (a phrase starts from the scale degree nearest its register edge).
 */
function laneNotes(h: Harmony, lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = lo - 2; m <= hi + 2; m++) if (h.note(h.degreeNear(m)) === m || h.isChordTone(m)) out.push(m);
  return out;
}

export function sweepCases(): SweepCase[] {
  const c: SweepCase[] = [];
  type Pan = number | 'centre';
  const add = (id: PatchId, label: string, pan: Pan, seconds: number, fill: (p: PatchParams, h: Harmony) => void, steer?: SweepCase['steer']): void => {
    c.push({ id, label, pan, seconds, harmonic: true, fill: (p, h) => fill(p, h), ...(steer ? { steer } : {}) });
  };
  const once = (id: PatchId, label: string, pan: Pan, seconds: number, fill: (p: PatchParams) => void, steer: SweepCase['steer']): void => {
    c.push({ id, label, pan, seconds, harmonic: false, fill: (p) => fill(p), steer });
  };

  // SFX: the non-spatial ones through the centre gain, the seed chime spatial.
  add('airJump', 'sparkle', 'centre', 0.45, F.fillAirJump);
  for (let k = 0; k <= T.orbComboMaxSteps; k++) add('orb', `combo ${k}`, 'centre', 0.25, (p, h) => F.fillOrb(p, h, k));
  add('checkpoint', 'chord', 'centre', 1.0, F.fillCheckpoint);
  add('goal', 'cadence', 'centre', 1.6, F.fillGoal);
  add('ability', 'bloom', 'centre', 2.2, F.fillAbility);
  // The ones with a noise layer in several noise offsets (their peaks spread by 2–3 dB over the offsets).
  for (const v of [0.1, 0.37, 0.6, 0.9]) {
    add('respawn', `variant ${v}`, 'centre', 1.0, (p, h) => {
      F.fillRespawn(p, h);
      p.variant = v;
    });
    add('launchAim', `variant ${v}`, 'centre', 0.7, (p, h) => {
      F.fillLaunchAim(p, h);
      p.variant = v;
    });
    add('launch', `variant ${v}`, 'centre', 0.6, (p, h) => {
      F.fillLaunch(p, h);
      p.variant = v;
    });
  }
  add('seedChime', 'chime', SPATIAL, 0.4, F.fillSeedChime);
  // Aim sustain at the end of the aim (level 1), long enough for its beating pairs to line up.
  add('aimSustain', 'level 1', 'centre', 6, F.fillAim, (hs, t) => hold(hs, 0, 1, t));
  // Owl: both registers, three hoots.
  for (const high of [false, true]) {
    add('owl', high ? 'from G4' : 'from E4', AMBIENT, 1.7, (p, h) => {
      F.fillOwl(p, h, high);
      p.variant = 0.9;
    });
  }

  // Music. Pads per layer style over the whole attack and hold (the chorus beats slowly), drones likewise.
  for (const [layer, style] of Object.entries(F.PAD_STYLES)) {
    add('pad', layer, 0, style.attack + Math.max(0.5, CHORD_LEN - style.attack - 0.6), (p, h) => F.fillPad(p, h, style, CHORD_LEN, 0.37));
  }
  for (const [layer, style] of Object.entries(F.DRONE_STYLES)) {
    add('drone', layer, 0, style.attack + CHORD_LEN - style.shorter, (p, h) => F.fillDrone(p, h, style, CHORD_LEN));
  }
  for (const v of [0.1, 0.35, 0.6, 0.85]) add('harmonics', `variant ${v}`, 0, 6, (p, h) => F.fillHarmonics(p, h, CHORD_LEN, v));
  add('pulse', 'downbeat', 0, 0.3, (p, h) => F.fillPulse(p, h, 1));
  // Bells: every note either bell lane can play (a phrase's first note, the longest ring), and the shrine bell.
  const g = F.LANES.glade;
  const cn = F.LANES.canopy;
  const bellRing = Math.max(g.ring + g.spread, cn.ring + cn.spread) * F.LAST_RING_BELL;
  c.push({
    id: 'bell', label: 'lane', pan: SLOT, seconds: 0.3, harmonic: true,
    notes: (h) => laneNotes(h, Math.min(g.lo, cn.lo), Math.max(g.hi, cn.hi)),
    fill: (p, _h, m) => F.fillBell(p, m, bellRing, 1),
  });
  add('bell', 'shrine', SLOT, 0.3, (p, h) => F.fillBell(p, h.voice(3, 1), F.SHRINE_BELL.ring, F.SHRINE_BELL.gain));
  // Felt piano: the gully's sighs and the canopy's answer (centre), the shrine arpeggio (side slots).
  const gl = F.LANES.gully;
  c.push({
    id: 'piano', label: 'sigh', pan: 0, seconds: 0.3, harmonic: true,
    notes: (h) => laneNotes(h, gl.lo, gl.hi),
    fill: (p, _h, m) => F.fillPianoPhrase(p, m, gl.ring * F.LAST_RING_PIANO, 1),
  });
  add('piano', 'answer', 0, 0.3, F.fillPianoAnswer);
  for (let k = 0; k <= 4; k++) add('piano', `arpeggio ${k}`, SLOT, 0.3, (p, h) => F.fillArp(p, h, k, true, 1));
  // Rootwell drips on each pad voice, veil shimmer on each of its six steps (levels at their maximum).
  for (let k = 0; k < 4; k++) {
    for (const v of [0.1, 0.5, 0.9]) add('drip', `voice ${k} variant ${v}`, SLOT, 0.3, (p, h) => F.fillDrip(p, h, k, v, 1));
  }
  for (let k = 0; k < 6; k++) {
    for (const v of [0.2, 0.8]) add('shimmer', `step ${k} variant ${v}`, SLOT, 1.2, (p, h) => F.fillShimmer(p, h, k, v, 1));
  }

  // Harmony-free leases at their steered maxima.
  const scrapeMax = new Float64Array(2);
  scrapeTargets(1, scrapeMax);
  const rattleMax = new Float64Array(4);
  rattleTargets(1, rattleMax);
  for (const v of [0.1, 0.37, 0.6, 0.9]) {
    // Scrape at full slide speed, over several loops of the noise buffer.
    once('scrape', `variant ${v}, full speed`, 'centre', 4, (p) => {
      p.variant = v;
    }, (hs, t) => {
      hold(hs, 0, scrapeMax[0] as number, t);
      hold(hs, 1, scrapeMax[1] as number, t);
    });
    // Rattle at the end of the windup, on screen: every handle at its progress-1 target.
    once('rattle', `variant ${v}, windup end`, SPATIAL, 1.0, (p) => {
      p.variant = v;
      p.gain = 1;
    }, (hs, t) => {
      for (let i = 0; i < 4; i++) hold(hs, i, rattleMax[i] as number, t);
    });
  }
  for (const v of [0.37, 0.8]) {
    // Wind at the windiest area level (canopy, 0.95) under the strongest gust (1.9), from the start.
    once('windBed', `variant ${v}, 0.95 × gust 1.9`, 'centre', T.bedFadeIn + 5, (p) => {
      p.variant = v;
      p.gain = 0.95;
    }, (hs, t) => hold(hs, 1, 1.9, t));
  }
  return c;
}

let sharedNoise: AudioBufferPort | null = null;

/** Build the shared noise buffer once (AudioBuffers are not tied to a context). */
function noiseBuffer(Offline: OfflineCtor): AudioBufferPort {
  if (sharedNoise) return sharedNoise;
  const b = new BufferBuilder(new Offline(1, 128, SR) as unknown as GraphPort, 1234);
  b.finish();
  if (!b.noise) throw new Error('noise buffer not built');
  sharedNoise = b.noise;
  return sharedNoise;
}

/** Render one case in one harmony (and note, for per-note cases) and return its per-channel peak (dBFS). */
export async function renderCase(Offline: OfflineCtor, c: SweepCase, area: AreaGradeId, chord: number, midi = 0): Promise<number> {
  const noise = noiseBuffer(Offline);
  const ctx = new Offline(2, Math.round((START + c.seconds) * SR), SR);
  const g = ctx as unknown as GraphPort;
  const p = createParams({ noise, waves: createWaves(g) });
  resetParams(p);
  p.variant = 0.37;
  const h = new Harmony();
  h.set(area, chord);
  c.fill(p, h, midi);
  if (PATCHES[c.id].lease && c.steer) p.dur = 0;
  let tail: AudioNodePort;
  if (c.pan === 'centre') {
    const cg = g.createGain();
    cg.gain.value = T.centreGain;
    tail = cg;
  } else {
    const pn = g.createStereoPanner();
    pn.pan.value = c.pan;
    tail = pn;
  }
  tail.connect(g.destination);
  const kill = g.createGain();
  kill.connect(tail);
  const sink = new RecordingSink();
  const tEnd = PATCHES[c.id].fn(g, kill, START, p, sink);
  c.steer?.(sink.handles, START);
  if (tEnd > 0) for (const s of sink.sources) s.stop(tEnd + T.stopPad);
  const out = await ctx.startRendering();
  let pk = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = out.getChannelData(ch);
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i] as number);
      if (a > pk) pk = a;
    }
  }
  return db(pk);
}

/** Every case in every mood × chord (harmonic) or once, `concurrency` renders at a time. */
export async function runSweep(Offline: OfflineCtor, cases: readonly SweepCase[] = sweepCases(), concurrency = 6): Promise<SweepResult[]> {
  const jobs: (() => Promise<SweepResult>)[] = [];
  for (const c of cases) {
    if (!c.harmonic) {
      jobs.push(async () => ({ id: c.id, label: c.label, area: '-', chord: 0, db: await renderCase(Offline, c, 'glade', 0) }));
      continue;
    }
    for (const area of AREA_GRADES) {
      for (let chord = 0; chord < MOODS[area].chords.length; chord++) {
        const notes = c.notes;
        if (!notes) {
          jobs.push(async () => ({ id: c.id, label: c.label, area, chord, db: await renderCase(Offline, c, area, chord) }));
          continue;
        }
        const h = new Harmony();
        h.set(area, chord);
        for (const m of notes(h)) {
          jobs.push(async () => ({ id: c.id, label: `${c.label} ${m}`, area, chord, db: await renderCase(Offline, c, area, chord, m) }));
        }
      }
    }
  }
  const out = new Array<SweepResult>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await (jobs[i] as () => Promise<SweepResult>)();
    }
  };
  const workers: Promise<void>[] = [];
  for (let k = 0; k < concurrency; k++) workers.push(worker());
  await Promise.all(workers);
  return out;
}

/** The loudest result per patch, loudest first. */
export function worstPerPatch(results: readonly SweepResult[]): SweepResult[] {
  const worst = new Map<PatchId, SweepResult>();
  for (const r of results) {
    const w = worst.get(r.id);
    if (!w || r.db > w.db) worst.set(r.id, r);
  }
  return [...worst.values()].sort((a, b) => b.db - a.db);
}

export function formatWorst(rows: readonly SweepResult[]): string {
  return rows
    .map((r) => `${r.id.padEnd(11)} ${r.db.toFixed(2).padStart(7)} dBFS  (${r.label}${r.area === '-' ? '' : `, ${r.area} chord ${r.chord}`})`)
    .join('\n');
}
