import { describe, expect, test } from 'vitest';
import { MOODS } from '../../src/audio/harmony.ts';
import type { Engine } from '../../src/audio/engine.ts';
import type { PatchId } from '../../src/audio/patches/index.ts';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';
import type { Voice } from '../../src/audio/voices.ts';
import { AREA_GRADES, type AreaGradeId } from '../../src/contracts/level.ts';
import { areaWeights, createAreaWeights } from '../../src/core/zones.ts';
import { FakeGain, type AutomationEvent } from './fakeContext.ts';
import { AREA_TILES, areaX, rig, TILE } from './helpers.ts';

const T = AUDIO_TUNING;

interface Booking {
  id: PatchId;
  t0: number;
  midi: number;
  note0: number;
  now: number;
}

/** Record every music voice the engine starts (patch, start, pitch, booking time). */
function recordMusic(e: Engine): Booking[] {
  const out: Booking[] = [];
  const start = e.start.bind(e);
  e.start = (pool, id, t0, dest, tail, pan): Voice | null => {
    if (pool === e.musicPool) out.push({ id, t0, midi: e.params.midi, note0: e.params.notes[0] as number, now: e.now });
    return start(pool, id, t0, dest, tail, pan);
  };
  return out;
}

function lastTarget(g: FakeGain): AutomationEvent | undefined {
  return g.gain.events.filter((e) => e.kind === 'target').at(-1);
}

describe('music (§5.9 Music)', () => {
  test('six moods share one tonic; each has a mode and a chord cycle', () => {
    for (const a of AREA_GRADES) {
      const m = MOODS[a];
      expect(m.scale[0], a).toBe(0);
      expect(m.chords.length, a).toBeGreaterThanOrEqual(4);
    }
    expect(MOODS.glade.scale).toEqual([0, 2, 4, 7, 9]);
    expect(MOODS.veil.scale).toEqual([0, 2, 4, 6, 8, 10]);
    expect(MOODS.gully.scale).toContain(3);
    expect(MOODS.shrine.scale).toContain(11);
  });

  test('layer gains follow areaWeights at the camera (remainder → glade), τ = 1.5 s, written only on change', () => {
    const r = rig();
    const e = r.engine();
    const w = createAreaWeights();
    const spots = [areaX(0), AREA_TILES * TILE + 100, areaX(2), 3 * AREA_TILES * TILE - 150, areaX(4), areaX(5)];
    for (const x of spots) {
      r.look(x);
      r.step();
      const rem = areaWeights(w, r.sim.level.gradeZones, r.frame.camX, r.frame.camY);
      w.glade += rem;
      for (let a = 0; a < AREA_GRADES.length; a++) {
        const ev = lastTarget(e.music.layers[a] as unknown as FakeGain);
        const want = w[AREA_GRADES[a] as AreaGradeId];
        expect(ev?.value, `${x} ${AREA_GRADES[a]}`).toBeCloseTo(want, 2);
        expect(ev?.tau).toBe(T.layerTau);
      }
    }
    const counts = e.music.layers.map((g) => (g as unknown as FakeGain).gain.events.length);
    for (let i = 0; i < 30; i++) r.step();
    expect(e.music.layers.map((g) => (g as unknown as FakeGain).gain.events.length)).toEqual(counts);
  });

  test('a camera outside every zone gives glade the remainder', () => {
    const r = rig();
    r.sim.level.gradeZones.length = 0;
    r.step();
    expect(r.engine().music.target[0]).toBe(1);
  });

  test('harmony changes only on bar lines, and only when the new area beats the current one by 0.2', () => {
    const r = rig();
    const e = r.engine();
    const m = e.music;
    for (let i = 0; i < 60; i++) r.step();
    expect(e.harmony.area).toBe('glade');
    // Just inside the gully: gully leads glade by less than 0.2 → no change, bar after bar.
    const edge = AREA_TILES * TILE;
    r.look(edge + 60);
    for (let i = 0; i < 60 * 9; i++) r.step();
    expect(m.target[1] - m.target[0]).toBeGreaterThan(0);
    expect(m.target[1] - m.target[0]).toBeLessThan(T.harmonyHysteresis);
    expect(e.harmony.area).toBe('glade');
    // Deeper in: the lead passes 0.2 → the switch lands on the next bar line.
    r.look(edge + 220);
    const from = m.step;
    let seen = -1;
    for (let i = 0; i < 60 * 9 && seen < 0; i++) {
      r.step();
      if (e.harmony.area === 'gully') seen = m.lastAreaChangeStep;
    }
    expect(seen).toBeGreaterThanOrEqual(from);
    expect(seen % m.stepsPerBar).toBe(0);
    expect(seen - from).toBeLessThanOrEqual(m.stepsPerBar);
  });

  test('chords advance every barsPerChord bars, and every harmony change happens while booking a bar line', () => {
    const r = rig();
    const e = r.engine();
    const m = e.music;
    let version = e.harmony.version;
    const changes: number[] = [];
    for (let i = 0; i < 60 * 40; i++) {
      const before = m.step;
      r.step();
      if (e.harmony.version !== version) {
        version = e.harmony.version;
        let bar = -1;
        for (let s = before; s < m.step; s++) if (s % m.stepsPerBar === 0) bar = s;
        expect(bar).toBeGreaterThanOrEqual(0);
        changes.push(bar);
      }
    }
    expect(changes.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < changes.length; i++) expect((changes[i] as number) - (changes[i - 1] as number)).toBe(m.stepsPerChord);
  });

  test('the scheduler books notes only inside (now + lead, now + 0.25], lead = max(0.03, 2·baseLatency)', () => {
    for (const base of [0.005, 0.04]) {
      const r = rig({ fake: { baseLatency: base } });
      const e = r.engine();
      const log = recordMusic(e);
      for (const x of [areaX(0), areaX(2), areaX(3), areaX(5)]) {
        r.look(x);
        for (let i = 0; i < 60 * 12; i++) r.step();
      }
      const lead = Math.max(T.leadMin, 2 * base);
      expect(e.lead).toBeCloseTo(lead, 12);
      expect(log.length).toBeGreaterThan(20);
      for (const b of log) {
        expect(b.t0 - b.now).toBeGreaterThan(lead);
        // Drips land up to 0.2 s inside their step, the shrine bell 10 ms after its step.
        expect(b.t0 - b.now).toBeLessThanOrEqual(T.horizon + (b.id === 'drip' ? 0.2 : b.id === 'bell' ? 0.01 : 0) + 1e-9);
      }
    }
  });

  test('a device with a huge baseLatency still gets its music (the window never closes)', () => {
    const r = rig({ fake: { baseLatency: 0.2 } });
    const e = r.engine();
    const log = recordMusic(e);
    // 20 s: the layers fade in with their weight, so the first bars are sparse.
    for (let i = 0; i < 60 * 20; i++) r.step();
    expect(e.lead).toBeCloseTo(0.4, 12);
    expect(log.length).toBeGreaterThan(3);
    for (const b of log) expect(b.t0 - b.now).toBeGreaterThan(0.4);
    expect(e.music.dropped).toBe(0);
  });

  test('no burst after a 2 s stall: late steps are dropped, never played late', () => {
    const r = rig();
    const e = r.engine();
    const m = e.music;
    for (let i = 0; i < 60 * 6; i++) r.step();
    const log = recordMusic(e);
    const dropped = m.dropped;
    r.step(2);
    const now = r.fake.currentTime;
    expect(m.dropped - dropped).toBeGreaterThanOrEqual(Math.floor(2 / m.stepDur) - 1);
    for (const b of log) {
      expect(b.t0).toBeGreaterThan(now + e.lead);
      expect(b.t0).toBeLessThanOrEqual(now + T.horizon + 0.21);
    }
    // At most one step's worth of notes (a chord change can bring the pad).
    expect(log.length).toBeLessThanOrEqual(3);
  });

  test('one Rng draw per step: the note sequence does not depend on the frame rate', () => {
    const run = (fps: number, x: number): string[] => {
      const r = rig({ seed: 777 });
      const log = recordMusic(r.engine());
      r.look(x);
      const frames = Math.round(30 * fps);
      for (let k = 0; k < frames; k++) r.step(1 / fps);
      return log.filter((b) => b.t0 < 29).map((b) => `${b.id}@${b.t0.toFixed(4)}:${b.midi}:${b.note0}`);
    };
    // Inside one area, and at a blend point where two layers (and their harmonies' contest) are live.
    for (const x of [areaX(3), 2 * AREA_TILES * TILE + 40]) {
      const a = run(30, x);
      const b = run(144, x);
      expect(a.length).toBeGreaterThan(20);
      expect(b).toEqual(a);
    }
  });

  test('at a two-area blend each layer thins its notes by its weight, so the music budget (12) rarely steals', () => {
    let starts = 0;
    let steals = 0;
    for (let b = 1; b < AREA_GRADES.length; b++) {
      const r = rig({ seed: 20260924 + b });
      const e = r.engine();
      const victim = e.musicPool.victim.bind(e.musicPool);
      let n = 0;
      let k = 0;
      e.musicPool.victim = (now, patch): Voice | null => {
        const v = victim(now, patch);
        if (v) k++;
        return v;
      };
      const start = e.start.bind(e);
      e.start = (pool, id, t0, dest, tail, pan): Voice | null => {
        if (pool === e.musicPool) n++;
        return start(pool, id, t0, dest, tail, pan);
      };
      // Standing on the boundary: both layers at 0.5, each harmony contest undecided.
      r.look(b * AREA_TILES * TILE);
      for (let i = 0; i < 30 * 60; i++) r.step(1 / 30);
      expect(e.music.target[b - 1]).toBeCloseTo(0.5, 6);
      expect(e.music.target[b]).toBeCloseTo(0.5, 6);
      expect(e.music.smooth[b]).toBeCloseTo(0.5, 3);
      expect(n, AREA_GRADES[b]).toBeGreaterThan(40);
      expect(k / n, `${AREA_GRADES[b - 1]}|${AREA_GRADES[b]}`).toBeLessThan(0.05);
      starts += n;
      steals += k;
    }
    console.info(`[audio music] boundary sweep: ${starts} music voices, ${steals} steals (${((100 * steals) / starts).toFixed(1)} %)`);
    expect(steals / starts).toBeLessThan(0.05);
  });

  test('area changes release the old chord\'s sustained voices, so two harmonies never overlap', () => {
    const r = rig();
    const e = r.engine();
    for (let i = 0; i < 60 * 3; i++) r.step();
    const pads = e.musicPool.records.filter((v) => v.active && v.sounding && v.patch === 'pad');
    expect(pads.length).toBeGreaterThan(0);
    r.look(areaX(2));
    for (let i = 0; i < 60 * 5 && e.harmony.area !== 'rootwell'; i++) r.step();
    expect(e.harmony.area).toBe('rootwell');
    for (const v of pads) expect(v.sounding).toBe(false);
  });
});
