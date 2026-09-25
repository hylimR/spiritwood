/**
 * Render every synthesized patch (and stress mixes through the whole engine) to 16-bit WAV for
 * listening, and check the §5.9 headroom rules: each patch alone peaks ≤ −12 dBFS per channel on its bus
 * (the demos, then the sweep: every melodic patch in every mood × chord with the engines' own fills and
 * tails, and the leases at their steered maxima), and the worst-case stress mixes (the tour pile-up and
 * the veil pile-up over a held aim) peak ≤ −1 dBFS after the master chain. Also checks the live lease
 * fade path: when update() stops, the leases fade out click-free and are silent 0.35 s later.
 *
 *   npm run audio:render -- <outDir> [--only id,id] [--no-sweep] [--no-mix] [--moods] [--tour]
 *
 * --moods also renders 34 s of each area's music and ambience (mood-<area>.wav); --tour renders a 96 s
 * walk through all six areas (tour.wav), both at the default sliders.
 *
 * Uses node-web-audio-api's OfflineAudioContext only (never the realtime AudioContext).
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PATCH_IDS, type PatchId } from '../../src/audio/patches/index.ts';
import { AREA_GRADES } from '../../src/contracts/level.ts';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';
import { centroid, db, dominantHz, edgeSteps, envelopeStats, mono, peakOf, rmsOf } from './analyze.ts';
import { DEMOS, renderPatch, SR, type OfflineCtor } from './patchRender.ts';
import { writeSpectrogramPng } from './spectrogram.ts';
import { writeWav16 } from './wav.ts';

export interface PatchReport {
  id: PatchId;
  peakDb: number;
  rmsDb: number;
  centroidHz: number;
  dominantHz: number;
  attackMs: number;
  t20: number;
  t40: number;
  length: number;
  onsetStep: number;
  endStep: number;
  tailDb: number;
  ok: boolean;
}

export async function reportPatch(Offline: OfflineCtor, id: PatchId, outDir: string | null): Promise<PatchReport> {
  const r = await renderPatch(Offline, id);
  const [L, R] = r.channels as [Float32Array, Float32Array];
  const m = mono(r.channels);
  if (outDir) {
    writeWav16(join(outDir, `${id}.wav`), r.channels, SR);
    writeSpectrogramPng(join(outDir, `${id}.png`), m, SR);
  }
  const pk = Math.max(peakOf(L), peakOf(R));
  const env = envelopeStats(m, SR);
  // RMS over the sounding part (first to last sample within −60 dB of the peak envelope).
  const on = Math.round(r.start * SR);
  const off = Math.min(m.length, on + Math.max(1, Math.round(env.length * SR)));
  const rms = Math.max(rmsOf(L, on, off), rmsOf(R, on, off));
  const edges = edgeSteps(m, SR);
  const tail = peakOf(m, Math.max(0, m.length - Math.round(0.02 * SR)));
  const peakDb = db(pk);
  return {
    id, peakDb, rmsDb: db(rms), centroidHz: centroid(m, SR), dominantHz: dominantHz(m, SR), attackMs: env.attack * 1000,
    t20: env.t20, t40: env.t40, length: env.length, onsetStep: edges.onset, endStep: edges.end, tailDb: db(tail),
    ok: peakDb <= AUDIO_TUNING.patchPeakDb + 1e-9,
  };
}

function fmt(n: number, w: number, d = 1): string {
  return n.toFixed(d).padStart(w);
}

export function printReports(rows: readonly PatchReport[]): void {
  console.log(
    'patch'.padEnd(12) + 'peak dBFS'.padStart(10) + 'RMS dBFS'.padStart(10) + 'centroid'.padStart(10) + 'domHz'.padStart(9)
      + 'atk ms'.padStart(8) + 'T-20 s'.padStart(8) + 'T-40 s'.padStart(8) + 'len s'.padStart(7) + 'onset'.padStart(8)
      + 'end'.padStart(8) + 'tail dB'.padStart(9) + '  desc',
  );
  for (const r of rows) {
    console.log(
      r.id.padEnd(12) + fmt(r.peakDb, 10) + fmt(r.rmsDb, 10) + fmt(r.centroidHz, 10, 0) + fmt(r.dominantHz, 9, 0)
        + fmt(r.attackMs, 8) + fmt(r.t20, 8, 2) + fmt(r.t40, 8, 2) + fmt(r.length, 7, 2) + fmt(r.onsetStep, 8, 4)
        + fmt(r.endStep, 8, 5) + fmt(r.tailDb, 9, 0) + (r.ok ? '  ' : ' ✗ ') + DEMOS[r.id].desc,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const outArg = args.find((a) => !a.startsWith('--'));
  if (!outArg) throw new Error('usage: npm run audio:render -- <outDir> [--only id,id] [--no-mix]');
  const outDir = resolve(outArg);
  mkdirSync(outDir, { recursive: true });
  const onlyAt = args.indexOf('--only');
  const only = onlyAt >= 0 ? new Set((args[onlyAt + 1] ?? '').split(',')) : null;
  const { OfflineAudioContext } = (await import('node-web-audio-api')) as unknown as { OfflineAudioContext: OfflineCtor };

  const rows: PatchReport[] = [];
  for (const id of PATCH_IDS) {
    if (only && !only.has(id)) continue;
    rows.push(await reportPatch(OfflineAudioContext, id, outDir));
  }
  printReports(rows);
  const bad = rows.filter((r) => !r.ok);
  console.log(`\npatch headroom (≤ ${AUDIO_TUNING.patchPeakDb} dBFS per channel): ${bad.length === 0 ? 'PASS' : `FAIL (${bad.map((r) => r.id).join(', ')})`}`);
  if (!args.includes('--no-sweep') && !only) {
    const { formatWorst, runSweep, worstPerPatch } = await import('./sweep.ts');
    const t0 = performance.now();
    const res = await runSweep(OfflineAudioContext);
    const over = res.filter((r) => r.db > AUDIO_TUNING.patchPeakDb);
    console.log(`\nheadroom sweep (${res.length} renders in ${((performance.now() - t0) / 1000).toFixed(1)} s), loudest per patch:`);
    console.log(formatWorst(worstPerPatch(res)));
    console.log(`sweep ≤ ${AUDIO_TUNING.patchPeakDb} dBFS: ${over.length === 0 ? 'PASS' : `FAIL (${over.length} renders)`}`);
    for (const r of over.slice(0, 20)) console.log(`  ${r.id} ${r.label} ${r.area}/${r.chord}: ${fmt(r.db, 0, 2)} dBFS`);
    if (over.length) process.exitCode = 1;
  }
  if (!args.includes('--no-mix') && !only) {
    const { LEASE_STALL, renderStressMix, runScene, STRESS_VEIL } = await import('./stressMix.ts');
    const mix = await renderStressMix(OfflineAudioContext, outDir);
    console.log(
      `\nstress mix (${mix.seconds} s, ${mix.events} events, sliders at 1): pre-chain peak ${fmt(mix.preDb, 0, 2)} dBFS, `
        + `post-chain peak ${fmt(mix.postDb, 0, 2)} dBFS, RMS ${fmt(mix.rmsDb, 0, 1)} dBFS, max voices ${mix.maxVoices}; `
        + `render ${mix.renderMs.toFixed(0)} ms = ${mix.cpuPct.toFixed(1)} % of one core; `
        + `update() avg ${mix.updateAvgMs.toFixed(3)} ms, max ${mix.updateMaxMs.toFixed(3)} ms`,
    );
    const veil = await runScene(OfflineAudioContext, STRESS_VEIL);
    writeWav16(join(outDir, 'stress-veil.wav'), veil.post, SR);
    console.log(
      `veil stress (${veil.seconds} s, ${veil.events} events, held aim + two ability blooms + two windups): `
        + `pre-chain peak ${fmt(veil.preDb, 0, 2)} dBFS, post-chain peak ${fmt(veil.postDb, 0, 2)} dBFS, max voices ${veil.maxVoices}`,
    );
    const worst = Math.max(mix.postDb, veil.postDb);
    console.log(`post-chain ≤ ${AUDIO_TUNING.mixPeakDb} dBFS: ${worst <= AUDIO_TUNING.mixPeakDb ? 'PASS' : 'FAIL'}`);
    if (worst > AUDIO_TUNING.mixPeakDb) process.exitCode = 1;
    const stall = await runScene(OfflineAudioContext, LEASE_STALL);
    const x = stall.tap[0] as Float32Array;
    const last = stall.lastUpdate;
    const i = (t: number): number => Math.round(t * SR);
    let stepSteady = 0;
    let stepFade = 0;
    for (let k = i(last - 0.5); k < i(last); k++) stepSteady = Math.max(stepSteady, Math.abs((x[k] as number) - (x[k - 1] as number)));
    for (let k = i(last + AUDIO_TUNING.leaseFade); k < i(last + AUDIO_TUNING.leaseStop) + 256; k++) {
      stepFade = Math.max(stepFade, Math.abs((x[k] as number) - (x[k - 1] as number)));
    }
    const after = peakOf(x, i(last + AUDIO_TUNING.leaseStop - AUDIO_TUNING.stopPad) + 1);
    console.log(
      `lease stall (update() stops at ${last.toFixed(3)} s): largest sample step in the fade ${fmt(db(stepFade), 0, 1)} dB vs ${fmt(db(stepSteady), 0, 1)} dB `
        + `while held; peak after the fade ${after === 0 ? 'exactly 0' : `${fmt(db(after), 0, 1)} dBFS`}: `
        + `${stepFade <= stepSteady && after < 1e-6 ? 'PASS' : 'FAIL'}`,
    );
    if (!(stepFade <= stepSteady && after < 1e-6)) process.exitCode = 1;
  }
  if (args.includes('--moods')) {
    const { moodScene, runScene } = await import('./stressMix.ts');
    console.log('\nmoods (34 s each, default sliders, still camera):');
    for (let a = 0; a < AREA_GRADES.length; a++) {
      const r = await runScene(OfflineAudioContext, moodScene(a));
      const id = AREA_GRADES[a] as string;
      writeWav16(join(outDir, `mood-${id}.wav`), r.post, SR);
      writeSpectrogramPng(join(outDir, `mood-${id}.png`), r.post[0] as Float32Array, SR, 256, 1200);
      const [L, R] = r.post as [Float32Array, Float32Array];
      const from = Math.round(6 * SR);
      let lr = 0;
      let ll = 0;
      let rr = 0;
      for (let i = from; i < L.length; i++) {
        lr += (L[i] as number) * (R[i] as number);
        ll += (L[i] as number) * (L[i] as number);
        rr += (R[i] as number) * (R[i] as number);
      }
      const m = mono(r.post);
      console.log(
        `  ${id.padEnd(9)} RMS ${fmt(db(rmsOf(m, from)), 6)} dBFS  peak ${fmt(r.postDb, 6)}  centroid ${fmt(centroid(m.subarray(from), SR), 5, 0)} Hz`
          + `  L/R corr ${(lr / Math.sqrt(ll * rr)).toFixed(2)}  voices ≤ ${r.maxVoices}  notes ${JSON.stringify(r.started)}`,
      );
    }
  }
  if (args.includes('--tour')) {
    const { runScene, TOUR } = await import('./stressMix.ts');
    const r = await runScene(OfflineAudioContext, TOUR);
    writeWav16(join(outDir, 'tour.wav'), r.post, SR);
    writeSpectrogramPng(join(outDir, 'tour.png'), r.post[0] as Float32Array, SR, 256, 1600);
    console.log(`\ntour (${r.seconds} s, six areas): peak ${fmt(r.postDb, 0, 1)} dBFS, RMS ${fmt(r.rmsDb, 0, 1)} dBFS, max voices ${r.maxVoices}`);
  }
  if (bad.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
