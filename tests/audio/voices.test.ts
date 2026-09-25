import { describe, expect, test } from 'vitest';
import { Harmony } from '../../src/audio/harmony.ts';
import { PATCH_IDS, PATCHES, type PatchId } from '../../src/audio/patches/index.ts';
import { EXP_FLOOR } from '../../src/audio/ports.ts';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';
import { retire, steal, Tail, VoiceRef, type Voice } from '../../src/audio/voices.ts';
import { SeedBurstCause, SimEventType } from '../../src/contracts/sim.ts';
import { DEMO_AREA, DEMOS } from '../../tools/audio/patchRender.ts';
import { FakeGain, FakeNode, FakeSource, type AutomationEvent } from './fakeContext.ts';
import { rig, type Rig } from './helpers.ts';

const T = AUDIO_TUNING;

function timed(events: AutomationEvent[]): AutomationEvent[] {
  return events.filter((e) => e.kind !== 'value');
}

function startDemo(r: Rig, id: PatchId, lease: boolean): { v: Voice; t0: number; now: number } {
  const e = r.engine();
  const p = e.p();
  const h = new Harmony();
  h.set(DEMO_AREA[id] ?? 'glade', 0);
  DEMOS[id].fill(p, h);
  if (lease) p.dur = 0;
  const now = r.fake.currentTime;
  e.now = now;
  const t0 = now + e.lead;
  const def = PATCHES[id];
  const pool = def.category === 0 ? e.sfxPool : def.category === 1 ? e.musicPool : lease ? e.bedPool : e.ambiencePool;
  const v = e.start(pool, id, t0, e.mixer.sfx, Tail.Centre, 0);
  if (!v) throw new Error(`${id} did not start`);
  return { v, t0, now };
}

describe('envelope rules (§5.9 Voices) — every patch', () => {
  for (const id of PATCH_IDS) {
    test(id, () => {
      const r = rig();
      const lease = PATCHES[id].lease;
      const { v, t0, now } = startDemo(r, id, lease);
      const kill = v.kill as unknown as FakeGain;
      // sources → envelope → kill: exactly one node feeds the kill Gain.
      expect(kill.inputs).toHaveLength(1);
      const env = kill.inputs[0] as FakeNode;
      expect(env).toBeInstanceOf(FakeGain);
      const ev = timed((env as FakeGain).gain.events);
      // Attack: setValueAtTime(0, t0) then a linear ramp up.
      expect(ev[0]).toMatchObject({ kind: 'set', value: 0 });
      expect(ev[0]?.time).toBeGreaterThanOrEqual(t0 - 1e-12);
      expect(ev[1]?.kind).toBe('lin');
      expect(ev[1]?.value).toBeGreaterThan(0);
      expect(ev[1]?.time).toBeGreaterThan(ev[0]?.time ?? 0);
      // Decays: exponential ramps never below 1e-4 (a ramp to 0 throws).
      for (const e of ev) if (e.kind === 'exp') expect(e.value).toBeGreaterThanOrEqual(EXP_FLOOR);
      const sources = (v.sources.slice(0, v.nSources) as unknown as FakeSource[]);
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) expect(s.startTime).toBeGreaterThanOrEqual(t0 - 1e-12);
      if (!lease) {
        // Release: ends with linearRampToValueAtTime(0, tEnd); sources stop at tEnd + 5 ms.
        const last = ev.at(-1) as AutomationEvent;
        expect(last).toMatchObject({ kind: 'lin', value: 0 });
        for (const s of sources) expect(s.stopTime).toBeCloseTo(last.time + T.stopPad, 9);
        expect(timed(kill.gain.events)).toHaveLength(0);
        expect((env as FakeGain).gain.valueAt(last.time + 1e-6)).toBe(0);
      } else {
        // Leases end through the kill Gain: held at 1 until now + 0.2, then a linear ramp to 0; stop at now + 0.35.
        const k = timed(kill.gain.events);
        expect(k).toHaveLength(2);
        expect(k[0]).toMatchObject({ kind: 'set', value: 1 });
        expect(k[0]?.time).toBeCloseTo(now + T.leaseFade, 12);
        expect(k[1]).toMatchObject({ kind: 'lin', value: 0 });
        expect(k[1]?.time).toBeCloseTo(now + T.leaseStop - T.stopPad, 12);
        for (const s of sources) expect(s.stopTime).toBeCloseTo(now + T.leaseStop, 12);
      }
      // Every automated gain in the audio path starts from silence (components never step in).
      for (let i = 0; i < v.nNodes; i++) {
        const n = v.nodes[i] as unknown as FakeNode;
        if (!(n instanceof FakeGain) || n === kill || n === env) continue;
        if (n.outputs.some((o) => 'param' in o)) continue;
        const g = timed(n.gain.events);
        if (g.length === 0) continue;
        expect(g[0], `${id} gain #${n.id}`).toMatchObject({ kind: 'set', value: 0 });
      }
    });
  }
});

describe('budgets, caps and steals', () => {
  test('SFX never exceed 16 sounding voices; steals fade the kill Gain 1 → 0 over 10 ms and stop at 15 ms', () => {
    const r = rig();
    const e = r.engine();
    const events = [];
    for (let i = 0; i < 12; i++) events.push({ type: SimEventType.OrbCollected, a: 1, id: i });
    for (let i = 0; i < 6; i++) events.push({ type: SimEventType.CheckpointActivated, id: i });
    for (let i = 0; i < 6; i++) events.push({ type: SimEventType.Jump });
    r.emit(...events);
    const now = r.fake.currentTime;
    expect(e.sfxPool.sounding(now)).toBeLessThanOrEqual(T.budgetSfx);
    const stolen = e.sfxPool.records.filter((v) => v.active && !v.sounding);
    expect(stolen.length).toBeGreaterThanOrEqual(24 - T.budgetSfx);
    for (const v of stolen) {
      const k = timed((v.kill as unknown as FakeGain).gain.events);
      expect(k.map((x) => x.kind)).toEqual(['cancel', 'set', 'lin']);
      expect(k[1]).toMatchObject({ value: 1, time: now });
      expect(k[2]).toMatchObject({ value: 0 });
      expect(k[2]?.time).toBeCloseTo(now + T.stealFade, 12);
      for (let i = 0; i < v.nSources; i++) expect((v.sources[i] as unknown as FakeSource).stopTime).toBeCloseTo(now + T.stealStop, 12);
    }
    r.step();
    expect(r.audio.stats.voices).toBeLessThanOrEqual(T.budgetSfx + T.budgetMusic + T.budgetAmbience);
  });

  test('the victim is the lowest priority first, then the oldest', () => {
    const r = rig();
    const e = r.engine();
    const now = r.fake.currentTime;
    e.now = now;
    const started: Voice[] = [];
    // Fill the budget: one priority-0 tick late in time, the rest priority-1 jumps at increasing times.
    for (let i = 0; i < T.budgetSfx - 1; i++) started.push(e.start(e.sfxPool, 'jump', now + 0.05 + i * 0.001, e.mixer.sfx, Tail.Centre, 0) as Voice);
    const tick = e.start(e.sfxPool, 'gripTick', now + 0.2, e.mixer.sfx, Tail.Centre, 0) as Voice;
    expect(e.sfxPool.sounding(now)).toBe(T.budgetSfx);
    e.start(e.sfxPool, 'orb', now + 0.3, e.mixer.sfx, Tail.Centre, 0);
    expect(tick.sounding).toBe(false);
    e.start(e.sfxPool, 'orb', now + 0.3, e.mixer.sfx, Tail.Centre, 0);
    expect(started[0]?.sounding).toBe(false);
    expect(started[1]?.sounding).toBe(true);
  });

  test('caps: SeedFired plays at most 3 at once, SeedBurst at most 4; a burst on the player is silent', () => {
    const r = rig();
    const e = r.engine();
    const x = r.frame.camX;
    const y = r.frame.camY;
    for (let i = 0; i < 6; i++) r.emit({ type: SimEventType.SeedFired, x: x + i * 20, y, id: i });
    for (let i = 0; i < 7; i++) r.emit({ type: SimEventType.SeedBurst, x: x - i * 20, y, a: SeedBurstCause.Terrain, id: i });
    const before = e.started.seedCrackle;
    r.emit({ type: SimEventType.SeedBurst, x, y, a: SeedBurstCause.Player, id: 9 });
    expect(e.started.seedCrackle).toBe(before);
    const now = r.fake.currentTime;
    expect(e.sfxPool.soundingOf('seedPop', now)).toBe(T.capSeedFired);
    expect(e.sfxPool.soundingOf('seedCrackle', now)).toBe(T.capSeedBurst);
    expect(e.started.seedPop).toBe(6);
  });

  test('music is capped at 12 voices and ambience at 6; stats.voices sums the three budgets (beds excluded)', () => {
    const r = rig();
    const e = r.engine();
    const now = r.fake.currentTime;
    e.now = now;
    for (let i = 0; i < 20; i++) {
      const p = e.p();
      p.midi = 74 + (i % 5);
      p.dur = 2;
      e.start(e.musicPool, 'bell', now + 0.05, e.mixer.music, Tail.Direct, 0);
    }
    for (let i = 0; i < 9; i++) {
      e.p();
      e.start(e.ambiencePool, 'waterDrip', now + 0.05, e.mixer.ambience, Tail.Pan, 0.2);
    }
    expect(e.musicPool.sounding(now)).toBe(T.budgetMusic);
    expect(e.ambiencePool.sounding(now)).toBe(T.budgetAmbience);
    r.step(0);
    const n = r.fake.currentTime;
    expect(r.audio.stats.voices).toBe(e.sfxPool.sounding(n) + e.musicPool.sounding(n) + e.ambiencePool.sounding(n));
    expect(e.bedPool.sounding(n)).toBe(2);
  });

  test('a VoiceRef resolves only while its allocation (seq) is active and sounding', () => {
    const r = rig();
    const e = r.engine();
    const now = r.fake.currentTime;
    e.now = now;
    const v = e.start(e.sfxPool, 'jump', now + 0.01, e.mixer.sfx, Tail.Centre, 0) as Voice;
    const ref = new VoiceRef();
    ref.set(v);
    expect(ref.live()).toBe(v);
    steal(v, now);
    expect(ref.live()).toBeNull();
    // The record retires and a new allocation reuses it: the old reference stays empty.
    ref.set(v);
    const old = v.seq;
    e.now = now + 1;
    retire(e.sfxPool, e.now);
    const w = e.start(e.sfxPool, 'land', e.now + 0.01, e.mixer.sfx, Tail.Centre, 0) as Voice;
    expect(w).toBe(v);
    expect(w.seq).not.toBe(old);
    expect(ref.live()).toBeNull();
    ref.set(w);
    expect(ref.live()).toBe(w);
    ref.clear();
    expect(ref.live()).toBeNull();
  });

  test('voices retire by their scheduled end time and are disconnected (no onended closures)', () => {
    const r = rig();
    const e = r.engine();
    r.emit({ type: SimEventType.Jump });
    const v = e.sfxPool.records.find((x) => x.active && x.patch === 'jump') as Voice;
    const nodes = v.nodes.slice(0, v.nNodes) as unknown as FakeNode[];
    const end = v.end;
    while (r.fake.currentTime < end) r.step(0.05);
    r.step(T.retireGrace + 0.01);
    expect(v.active).toBe(false);
    for (const n of nodes) {
      expect(n.disconnected).toBe(true);
      expect('onended' in n).toBe(false);
    }
  });
});
