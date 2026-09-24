import { describe, expect, test } from 'vitest';
import { TIME_SCALE_EASE, TIME_SCALE_RELEASE } from '../../src/config.ts';
import { AUDIO_TUNING, bufferBudgetUse, dbToGain } from '../../src/audio/tuning.ts';
import { softClip } from '../../src/audio/util.ts';
import { FakeBiquad, FakeCompressor, FakeGain, FakeNode, FakeParam, FakeShaper, type AutomationEvent } from './fakeContext.ts';
import { rig, type Rig } from './helpers.ts';

const T = AUDIO_TUNING;

function only<N extends FakeNode>(nodes: FakeNode[], cls: new (...a: never[]) => N): N {
  expect(nodes).toHaveLength(1);
  const n = nodes[0];
  expect(n).toBeInstanceOf(cls);
  return n as N;
}

/** Automation calls (value writes excluded) on a param after `from` (a global sequence mark). */
function writes(p: FakeParam, from = -1): AutomationEvent[] {
  return p.events.filter((e) => e.kind !== 'value' && e.seq > from);
}

function mark(r: Rig): number {
  let m = -1;
  for (const n of r.fake.nodes) for (const p of n.params) for (const e of p.events) m = Math.max(m, e.seq);
  return m;
}

describe('the mix graph (§5.9 Graph and levels)', () => {
  test('per bus: volume → duck (+ freeze low-pass on music and ambience) → master → compressor → trim → soft clip → destination', () => {
    const r = rig();
    const m = r.engine().mixer;
    const sfx = m.sfx as FakeGain;
    const duckS = only(sfx.targets, FakeGain);
    expect(duckS).toBe(m.duckSfx);
    expect(duckS.targets).toContain(m.master);
    for (const [vol, duck, lp] of [[m.music, m.duckMusic, m.freezeMusic], [m.ambience, m.duckAmbience, m.freezeAmbience]] as const) {
      expect((vol as FakeGain).targets).toEqual([duck]);
      expect((duck as FakeGain).targets).toEqual([lp]);
      expect((lp as FakeBiquad).type).toBe('lowpass');
      expect((lp as FakeBiquad).targets).toContain(m.master);
    }
    const comp = only((m.master as FakeGain).targets, FakeCompressor);
    expect(comp.threshold.value).toBe(-12);
    expect(comp.ratio.value).toBe(4);
    expect(comp.knee.value).toBe(6);
    const trim = only(comp.targets, FakeGain);
    expect(trim.gain.value).toBeCloseTo(dbToGain(-4), 12);
    const shaper = only(trim.targets, FakeShaper);
    expect(shaper.targets).toEqual([r.fake.destination]);
    const c = shaper.curve as Float32Array;
    const at = (x: number): number => c[Math.round(((x + 1) / 2) * (c.length - 1))] as number;
    expect(at(0.5)).toBeCloseTo(0.5, 3);
    expect(at(-0.8)).toBeCloseTo(-0.8, 3);
    expect(at(1)).toBeCloseTo(softClip(1, T.softClipLinear), 4);
    expect(at(1)).toBeLessThan(1);
    for (let i = 1; i < c.length; i++) expect(c[i] as number).toBeGreaterThanOrEqual(c[i - 1] as number);
  });

  test('the freeze low-passes idle at 20 kHz; the convolver gets its impulse only once it is built', () => {
    const r = rig({ warm: false });
    const m = r.engine().mixer;
    expect((m.freezeMusic as FakeBiquad).frequency.value).toBe(T.freezeFilterHz);
    expect(m.reverb.buffer).toBeNull();
    for (let i = 0; i < 200 && !m.reverb.buffer; i++) r.step();
    expect(m.reverb.buffer).not.toBeNull();
    expect(m.reverb.normalize).toBe(false);
  });

  test('slider v → gain v², smoothed with τ 0.05 s; ambience follows sfx; written only on change', () => {
    const r = rig();
    const m = r.engine().mixer;
    const from = mark(r);
    r.audio.setVolumes({ master: 0.5, music: 0.8, sfx: 0.3 });
    const now = r.fake.currentTime;
    const expectTarget = (p: FakeParam, v: number): void => {
      const w = writes(p, from);
      expect(w).toHaveLength(1);
      expect(w[0]).toMatchObject({ kind: 'target', time: now, tau: T.volumeTau });
      expect(w[0]?.value).toBeCloseTo(v, 12);
    };
    expectTarget((m.master as FakeGain).gain, 0.25);
    expectTarget((m.music as FakeGain).gain, 0.64);
    expectTarget((m.sfx as FakeGain).gain, 0.09);
    expectTarget((m.ambience as FakeGain).gain, 0.09);
    const again = mark(r);
    r.audio.setVolumes({ master: 0.5, music: 0.8, sfx: 0.3 });
    for (let i = 0; i < 20; i++) r.step();
    for (const g of [m.master, m.music, m.sfx, m.ambience]) expect(writes((g as FakeGain).gain, again)).toHaveLength(0);
  });

  test('pause ducks music 12 dB and holds ambience low; resume restores both', () => {
    const r = rig();
    const m = r.engine().mixer;
    const from = mark(r);
    r.frame.paused = true;
    r.step();
    const dm = writes((m.duckMusic as FakeGain).gain, from);
    const da = writes((m.duckAmbience as FakeGain).gain, from);
    expect(dm).toHaveLength(1);
    expect(dm[0]?.value).toBeCloseTo(dbToGain(-12), 9);
    expect(da).toHaveLength(1);
    expect(da[0]?.value).toBeCloseTo(dbToGain(T.pauseAmbienceDb), 9);
    expect(da[0]?.value).toBeLessThan(dbToGain(-6));
    for (let i = 0; i < 10; i++) r.step();
    expect(writes((m.duckMusic as FakeGain).gain, from)).toHaveLength(1);
    r.frame.paused = false;
    r.step();
    expect(writes((m.duckMusic as FakeGain).gain, from).at(-1)?.value).toBe(1);
    expect(writes((m.duckAmbience as FakeGain).gain, from).at(-1)?.value).toBe(1);
  });

  test('freeze sweeps detune toward −5370 cents (≈ 900 Hz) with τ = TIME_SCALE_EASE; frequency is never automated', () => {
    const r = rig();
    const m = r.engine().mixer;
    const from = mark(r);
    r.sim.frozen = true;
    r.step();
    for (const lp of [m.freezeMusic, m.freezeAmbience] as FakeBiquad[]) {
      const d = writes(lp.detune, from);
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ kind: 'target', value: T.freezeDetuneCents, tau: TIME_SCALE_EASE });
      expect(T.freezeFilterHz * Math.pow(2, T.freezeDetuneCents / 1200)).toBeCloseTo(900, -1);
    }
    r.sim.frozen = false;
    r.step();
    for (const lp of [m.freezeMusic, m.freezeAmbience] as FakeBiquad[]) {
      expect(writes(lp.detune, from).at(-1)).toMatchObject({ kind: 'target', value: 0, tau: TIME_SCALE_RELEASE });
      expect(writes(lp.frequency)).toHaveLength(0);
    }
  });

  test('one owner per AudioParam: volume, pause and freeze never write each other\'s params', () => {
    const r = rig();
    const m = r.engine().mixer;
    const vol = [m.master, m.music, m.sfx, m.ambience].map((g) => (g as FakeGain).gain);
    const duck = [m.duckMusic, m.duckAmbience, m.duckSfx].map((g) => (g as FakeGain).gain);
    const det = [m.freezeMusic, m.freezeAmbience].map((f) => (f as FakeBiquad).detune);
    const count = (ps: FakeParam[]): number => ps.reduce((n, p) => n + writes(p).length, 0);
    const base = [count(vol), count(duck), count(det)];
    r.frame.paused = true;
    r.step();
    expect([count(vol), count(det)]).toEqual([base[0], base[2]]);
    r.frame.paused = false;
    r.sim.frozen = true;
    r.step();
    const afterFreeze = count(duck);
    expect(count(vol)).toBe(base[0]);
    r.audio.setVolumes({ master: 0.4, music: 0.4, sfx: 0.4 });
    expect(count(duck)).toBe(afterFreeze);
    const detAfter = count(det);
    r.sim.frozen = false;
    r.step();
    expect(count(det)).toBe(detAfter + 2);
    expect(count(vol)).toBe(base[0] + 4);
    // The SFX duck is not the pause's to use.
    expect(writes((m.duckSfx as FakeGain).gain)).toHaveLength(0);
  });

  test('noise, impulse and one impulse copy stay within 1 MB at 48 kHz (the convolver\'s FFT state is accepted); impulse ≤ 1.5 s', () => {
    expect(bufferBudgetUse()).toBeLessThanOrEqual(T.bufferBudgetBytes);
    expect(T.impulseSeconds).toBeLessThanOrEqual(1.5);
    const r = rig();
    const e = r.engine();
    const imp = e.buffers.impulse;
    const noise = e.buffers.noise;
    expect(imp?.sampleRate).toBe(48000);
    expect(noise?.sampleRate).toBe(48000);
    const bytes = (noise?.length ?? 0) * 4 + (imp?.length ?? 0) * (imp?.numberOfChannels ?? 0) * 4 * (1 + T.convolverCopies);
    expect(bytes).toBe(bufferBudgetUse());
    expect(r.fake.bufferBytes - 4 /* the one-sample unlock buffer */).toBe((noise?.length ?? 0) * 4 + (imp?.length ?? 0) * 2 * 4);
  });
});
