import { describe, expect, test } from 'vitest';
import { PATCH_IDS, type PatchId } from '../../src/audio/patches/index.ts';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';
import { db, edgeSteps, mono, peakOf, rmsOf } from '../../tools/audio/analyze.ts';
import { renderPatch, SR, type OfflineCtor } from '../../tools/audio/patchRender.ts';
import { LEASE_STALL, runScene, STRESS, STRESS_VEIL } from '../../tools/audio/stressMix.ts';
import { formatWorst, runSweep, worstPerPatch } from '../../tools/audio/sweep.ts';

/*
 * Offline renders through node-web-audio-api's OfflineAudioContext (never the realtime AudioContext).
 * The module has no musl binaries, so it is loaded dynamically and the suite skips without it. Checks
 * use tolerances, not hashes.
 */
const nwa = (await import('node-web-audio-api').catch(() => null)) as { OfflineAudioContext: OfflineCtor } | null;
const Offline = nwa?.OfflineAudioContext;
const T = AUDIO_TUNING;

/** Patches whose pitches come from the harmony: the sweep renders them in all 24 moods × chords. */
const MELODIC: PatchId[] = [
  'airJump', 'orb', 'checkpoint', 'goal', 'ability', 'respawn', 'launchAim', 'launch', 'seedChime', 'aimSustain', 'owl',
  'pad', 'bell', 'piano', 'pulse', 'drone', 'drip', 'shimmer', 'harmonics',
];

function maxStep(x: Float32Array, from: number, to: number): number {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs((x[i] as number) - (x[i - 1] as number)));
  return m;
}

describe.skipIf(!Offline)('offline renders (node-web-audio-api, 48 kHz)', () => {
  const O = Offline as OfflineCtor;

  for (const id of PATCH_IDS) {
    test(`${id}: ≤ −12 dBFS, audible, click-free edges, silent after its release`, async () => {
      const r = await renderPatch(O, id);
      const [L, R] = r.channels as [Float32Array, Float32Array];
      const peak = Math.max(peakOf(L), peakOf(R));
      expect(db(peak)).toBeLessThanOrEqual(T.patchPeakDb);
      const m = mono(r.channels);
      expect(db(rmsOf(m))).toBeGreaterThan(-75);
      const on = Math.round(r.start * SR);
      // Nothing before the start time.
      expect(peakOf(m, 0, on)).toBe(0);
      // Onset: the envelope rises from 0 (no step into the sound).
      const edges = edgeSteps(m, SR, 1);
      let first = on;
      while (first < m.length && Math.abs(m[first] as number) < 1e-6) first++;
      expect(Math.abs(m[first] as number)).toBeLessThan(0.02 * peak + 1e-4);
      expect(peakOf(m, first, first + Math.round(SR * 0.00025))).toBeLessThan(0.35 * peak + 1e-4);
      // End: the release reaches 0 before the sources stop (no step out of the sound).
      expect(edges.end).toBeLessThan(0.02 * peak + 1e-4);
      // Silence after the release (the render runs past it).
      if (r.tEnd > 0) {
        const after = Math.round((r.tEnd + 0.01) * SR);
        expect(after).toBeLessThan(m.length);
        expect(peakOf(m, after)).toBeLessThan(1e-4);
      }
    });
  }

  test('headroom sweep: melodic patches in every mood × chord and leases at their steered maxima ≤ −12 dBFS', async () => {
    const res = await runSweep(O, undefined, 4);
    console.info(`[audio headroom] ${res.length} renders, loudest per patch:\n${formatWorst(worstPerPatch(res))}`);
    const over = res.filter((r) => r.db > T.patchPeakDb).map((r) => `${r.id} ${r.label} ${r.area}/${r.chord}: ${r.db.toFixed(2)}`);
    expect(over).toEqual([]);
    for (const id of MELODIC) {
      const cells = new Set(res.filter((r) => r.id === id).map((r) => `${r.area}/${r.chord}`));
      expect(cells.size, id).toBe(24);
    }
    for (const id of ['scrape', 'rattle', 'windBed'] as const) expect(res.some((r) => r.id === id), id).toBe(true);
  }, 180000);

  test('stress mix through the whole chain (sliders at 1, a 40-event pile-up) peaks ≤ −1 dBFS after it', async () => {
    const r = await runScene(O, { ...STRESS, seconds: 7 });
    expect(r.events).toBeGreaterThan(40);
    expect(r.postDb).toBeLessThanOrEqual(T.mixPeakDb);
    expect(r.rmsDb).toBeGreaterThan(-50);
    expect(r.maxVoices).toBeLessThanOrEqual(T.budgetSfx + T.budgetMusic + T.budgetAmbience);
  }, 60000);

  test('the pile-up staged in the veil, over an aim held at its end and a second ability bloom, peaks ≤ −1 dBFS', async () => {
    const r = await runScene(O, STRESS_VEIL);
    console.info(`[audio stress] veil: pre-chain ${r.preDb.toFixed(2)} dBFS, post-chain ${r.postDb.toFixed(2)} dBFS, voices ≤ ${r.maxVoices}`);
    expect(r.events).toBeGreaterThan(40);
    expect(r.started.aimSustain).toBeGreaterThanOrEqual(1);
    expect(r.started.ability).toBeGreaterThanOrEqual(2);
    expect(r.started.rattle).toBeGreaterThanOrEqual(2);
    expect(r.postDb).toBeLessThanOrEqual(T.mixPeakDb);
  }, 60000);

  test('when update() stops, the leases fade out on their own: click-free, silent from last update + 0.35 s', async () => {
    const r = await runScene(O, LEASE_STALL);
    expect(r.started.scrape).toBe(1);
    expect(r.started.aimSustain).toBe(1);
    expect(r.started.heartbeat).toBe(1);
    const last = r.lastUpdate;
    expect(last).toBeGreaterThan(1.4);
    const i = (t: number): number => Math.round(t * SR);
    // The dry SFX bus is mono here (every lease is centred): the splitter's channel 0.
    const x = r.tap[0] as Float32Array;
    const steady = rmsOf(x, i(last - 0.5), i(last));
    expect(db(steady)).toBeGreaterThan(-45);
    // Still held until the lease fade begins (now + 0.2).
    expect(rmsOf(x, i(last + 0.02), i(last + T.leaseFade - 0.01))).toBeGreaterThan(0.5 * steady);
    // The fade and the stop add no step larger than the sound's own.
    expect(maxStep(x, i(last + T.leaseFade), i(last + T.leaseStop) + 256)).toBeLessThanOrEqual(maxStep(x, i(last - 0.5), i(last)));
    // The kill gain reaches 0 before the sources stop, and nothing sounds afterwards.
    expect(peakOf(x, i(last + T.leaseStop - T.stopPad) + 1, i(last + T.leaseStop))).toBeLessThan(1e-6);
    expect(peakOf(x, i(last + T.leaseStop) + 128)).toBeLessThan(1e-6);
  }, 60000);
});
