import { describe, expect, test } from 'vitest';
import { heartbeatInterval } from '../../src/audio/patches/sfx.ts';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';
import { steal, type Voice } from '../../src/audio/voices.ts';
import type { AudioVolumes } from '../../src/contracts/audio.ts';
import { SimEventType } from '../../src/contracts/sim.ts';
import { FakeGain, FakeSource, type AutomationEvent, type FakeParam } from './fakeContext.ts';
import { areaX, rig, type Rig } from './helpers.ts';

const T = AUDIO_TUNING;

function live(r: Rig, patch: string): Voice[] {
  const e = r.engine();
  return e.sfxPool.records.filter((v) => v.active && v.sounding && v.patch === patch);
}

function killEvents(v: Voice): AutomationEvent[] {
  return (v.kill as unknown as FakeGain).gain.events.filter((e) => e.kind !== 'value');
}

function stopTimes(v: Voice): number[] {
  const out: number[] = [];
  for (let i = 0; i < v.nSources; i++) out.push((v.sources[i] as unknown as FakeSource).stopTime as number);
  return out;
}

describe('leases (§5.9)', () => {
  test('scrape ⇔ wallSlide: each update re-issues stop(now + 0.35) and moves the kill fade to now + 0.2', () => {
    const r = rig();
    r.sim.player.mode = 'wallSlide';
    r.sim.player.vy = 150;
    r.step();
    const [v] = live(r, 'scrape');
    expect(v).toBeDefined();
    const voice = v as Voice;
    for (let i = 0; i < 5; i++) {
      r.step();
      const now = r.fake.currentTime;
      const k = killEvents(voice).slice(-3);
      expect(k.map((e) => e.kind)).toEqual(['cancel', 'set', 'lin']);
      expect(k[0]?.time).toBe(now);
      expect(k[1]).toMatchObject({ value: 1 });
      expect(k[1]?.time).toBeCloseTo(now + T.leaseFade, 12);
      expect(k[2]?.time).toBeCloseTo(now + T.leaseStop - T.stopPad, 12);
      for (const s of stopTimes(voice)) expect(s).toBeCloseTo(now + T.leaseStop, 12);
      // The renewal keeps the kill Gain at 1 now: nothing steps.
      expect((voice.kill as unknown as FakeGain).gain.valueAt(now)).toBe(1);
    }
    expect(live(r, 'scrape')).toHaveLength(1);
    // Leaving the wall releases it.
    r.sim.player.mode = 'air';
    r.step();
    expect(voice.sounding).toBe(false);
    const k = killEvents(voice).slice(-1)[0] as AutomationEvent;
    expect(k).toMatchObject({ kind: 'lin', value: 0 });
    expect(live(r, 'scrape')).toHaveLength(0);
  });

  test('when update() stops (hidden tab, throttled iframe) a lease fades out on its own', () => {
    const r = rig();
    r.sim.player.mode = 'wallSlide';
    for (let i = 0; i < 4; i++) r.step();
    const v = live(r, 'scrape')[0] as Voice;
    const last = r.fake.currentTime;
    const kill = (v.kill as unknown as FakeGain).gain;
    expect(kill.valueAt(last + 0.19)).toBe(1);
    expect(kill.valueAt(last + T.leaseStop - T.stopPad)).toBeCloseTo(0, 9);
    for (const s of stopTimes(v)) expect(s).toBeCloseTo(last + T.leaseStop, 12);
  });

  test('pause releases every sustained SFX within 50 ms, and they come back on resume while their state holds', () => {
    const r = rig();
    r.sim.player.mode = 'wallSlide';
    r.sim.frozen = true;
    r.sim.launch.aimMaxTicks = 120;
    r.step();
    const before = [...live(r, 'scrape'), ...live(r, 'aimSustain'), ...live(r, 'heartbeat')];
    expect(before).toHaveLength(3);
    r.frame.paused = true;
    r.step();
    const now = r.fake.currentTime;
    for (const v of before) {
      expect(v.sounding).toBe(false);
      const k = killEvents(v).slice(-1)[0] as AutomationEvent;
      expect(k.kind).toBe('lin');
      expect(k.time - now).toBeLessThanOrEqual(T.pauseReleaseSec + 1e-9);
      for (const s of stopTimes(v)) expect(s - now).toBeLessThanOrEqual(T.pauseReleaseSec + T.stopPad + 1e-9);
    }
    // No new SFX while paused.
    r.step(1 / 60, [{ type: SimEventType.Jump }, { type: SimEventType.OrbCollected, a: 1 }]);
    expect(live(r, 'jump')).toHaveLength(0);
    expect(live(r, 'scrape')).toHaveLength(0);
    r.frame.paused = false;
    r.step();
    expect(live(r, 'scrape')).toHaveLength(1);
    expect(live(r, 'aimSustain')).toHaveLength(1);
    expect(live(r, 'heartbeat')).toHaveLength(1);
  });

  test('aim sustain and heartbeat ⇔ frozen; the heartbeat speeds up with aimTicks / aimMaxTicks', () => {
    const r = rig();
    const L = r.sim.launch;
    L.aimMaxTicks = 120;
    r.sim.frozen = true;
    const beats: number[] = [];
    let hb: Voice | null = null;
    for (let tick = 0; tick < 118; tick += 1) {
      L.aimTicks = tick;
      r.step();
      hb ??= live(r, 'heartbeat')[0] ?? null;
    }
    expect(hb).not.toBeNull();
    const g = (hb as Voice).handles[0];
    // Beat onsets: setValueAtTime(0, tb) followed by a ramp up (lub and dub alternate).
    const ev = (g as unknown as { events: AutomationEvent[] }).events.filter((e) => e.kind === 'set' && e.value === 0);
    for (let i = 0; i < ev.length; i += 2) beats.push((ev[i] as AutomationEvent).time);
    expect(beats.length).toBeGreaterThanOrEqual(4);
    const first = (beats[1] as number) - (beats[0] as number);
    const lastGap = (beats.at(-1) as number) - (beats.at(-2) as number);
    expect(first).toBeCloseTo(heartbeatInterval(0), 1);
    expect(lastGap).toBeLessThan(first);
    expect(live(r, 'aimSustain')).toHaveLength(1);
    r.sim.frozen = false;
    r.step();
    expect(live(r, 'aimSustain')).toHaveLength(0);
    expect(live(r, 'heartbeat')).toHaveLength(0);
  });

  test('rattle ⇔ a spitter in windup: the two nearest play, pitch and level follow modeTicks / modeDuration', () => {
    const r = rig();
    const e = r.engine();
    const spitters = r.sim.enemies.filter((en) => en.kind === 'thornSpitter');
    expect(spitters).toHaveLength(3);
    // Stand between the first two; the third is farther.
    r.look(((spitters[0]?.x ?? 0) + (spitters[1]?.x ?? 0)) / 2, (spitters[0]?.y ?? 0) - 200);
    for (const s of spitters) {
      s.mode = 'windup';
      s.modeDuration = 36;
      s.modeTicks = 0;
    }
    r.step(1 / 60, spitters.map((s) => ({ type: SimEventType.SpitterWindup, x: s.x, y: s.y - 50, a: 36, id: s.id })));
    let rattles = live(r, 'rattle');
    expect(rattles).toHaveLength(2);
    expect([e.sfx.rattleOwner(0), e.sfx.rattleOwner(1)].sort()).toEqual([spitters[0]?.id, spitters[1]?.id].sort());
    const band0: number[] = [];
    for (let t = 1; t < 36; t++) {
      for (const s of spitters) s.modeTicks = t;
      r.step();
      rattles = live(r, 'rattle');
      expect(rattles).toHaveLength(2);
      band0.push((rattles[0] as Voice).written[1] as number);
    }
    expect(band0.at(-1) as number).toBeGreaterThan(band0[0] as number);
    // The spitter fires: the windup ends and the rattles release.
    for (const s of spitters) s.mode = 'cooldown';
    r.step();
    expect(live(r, 'rattle')).toHaveLength(0);
  });

  test('a lease reference never follows its record into a new allocation (stolen, retired, reused)', () => {
    const r = rig();
    const e = r.engine();
    const sp = r.sim.enemies.filter((en) => en.kind === 'thornSpitter');
    const [a, b] = sp as [(typeof sp)[number], (typeof sp)[number]];
    r.look((a.x + b.x) / 2, a.y - 200);
    for (const s of [a, b]) {
      s.mode = 'windup';
      s.modeDuration = 120;
      s.modeTicks = 10;
    }
    r.step(1 / 60, [a, b].map((s) => ({ type: SimEventType.SpitterWindup, x: s.x, y: s.y, id: s.id })));
    const rec = e.sfx.lease('rattle0') as Voice;
    expect(rec.patch).toBe('rattle');
    const seq = rec.seq;
    // A budget steal takes it after this frame's renewals; after a 100 ms hitch the record has retired, and
    // the wall slide that starts now reuses it for the scrape.
    steal(rec, r.fake.currentTime);
    r.sim.player.mode = 'wallSlide';
    r.sim.player.vy = 50;
    r.step(0.1);
    const scrape = e.sfx.lease('scrape') as Voice;
    expect(scrape).toBe(rec);
    expect(scrape.seq).not.toBe(seq);
    // The rattle slot let go of it: its spitter got a new voice, and the scrape is steered only as a scrape.
    expect(e.sfx.lease('rattle0')).not.toBe(scrape);
    expect(e.sfx.lease('rattle1')).not.toBe(scrape);
    expect(live(r, 'rattle')).toHaveLength(2);
    const band = (scrape.handles[1] as unknown as FakeParam).events.filter((ev) => ev.kind === 'target').map((ev) => ev.value);
    expect(band.length).toBeGreaterThan(0);
    for (const f of band) expect(f).toBeLessThanOrEqual(1500);
    const lvl = (scrape.handles[0] as unknown as FakeParam).events.filter((ev) => ev.kind === 'target');
    expect(lvl).toHaveLength(1);
  });

  test('no lease or bed plays into a zero SFX or master slider; they start when it comes back while their state holds', () => {
    const muted: AudioVolumes[] = [{ master: 1, music: 1, sfx: 0 }, { master: 0, music: 1, sfx: 1 }];
    for (const vol of muted) {
      const r = rig();
      const e = r.engine();
      const sp = r.sim.enemies.find((en) => en.kind === 'thornSpitter');
      if (!sp) throw new Error('no spitter');
      r.look(sp.x, sp.y - 200);
      r.step();
      // The beds run from the start; the slider goes to 0 and every sustained state begins.
      expect(e.bedPool.records.filter((v) => v.active && v.sounding)).toHaveLength(2);
      r.audio.setVolumes(vol);
      r.sim.player.mode = 'wallSlide';
      r.sim.frozen = true;
      r.sim.launch.aimMaxTicks = 120;
      sp.mode = 'windup';
      sp.modeDuration = 36;
      for (let i = 0; i < 30; i++) r.step();
      expect(e.sfxPool.records.filter((v) => v.active && v.sounding)).toHaveLength(0);
      expect(e.bedPool.records.filter((v) => v.active && v.sounding)).toHaveLength(0);
      // The slider comes back: everything whose state still holds starts again.
      r.audio.setVolumes({ master: 1, music: 1, sfx: 1 });
      r.step();
      for (const id of ['scrape', 'aimSustain', 'heartbeat', 'rattle']) expect(live(r, id), id).toHaveLength(1);
      expect(e.bedPool.records.filter((v) => v.active && v.sounding).map((v) => v.patch).sort()).toEqual(['cricketBed', 'windBed']);
      // A returning bed fades back in quickly, not over the first 3 s fade-in.
      for (const bed of e.bedPool.records.filter((v) => v.active && v.sounding)) {
        const env = (bed.kill as unknown as FakeGain).inputs[0] as FakeGain;
        const rise = env.gain.events.find((ev) => ev.kind === 'lin');
        expect((rise?.time ?? 0) - bed.start).toBeLessThan(0.5);
      }
    }
  });

  test('Reset, Teleported and Respawned release every SFX voice and clear the orb combo', () => {
    for (const type of [SimEventType.Reset, SimEventType.Teleported, SimEventType.Respawned]) {
      const r = rig();
      const e = r.engine();
      r.sim.player.mode = 'wallSlide';
      r.step(1 / 60, [{ type: SimEventType.OrbCollected, a: 1 }, { type: SimEventType.OrbCollected, a: 1 }, { type: SimEventType.Jump }]);
      expect(e.sfx.comboStep).toBe(1);
      const before = e.sfxPool.records.filter((v) => v.active && v.sounding);
      expect(before.length).toBeGreaterThanOrEqual(4);
      r.emit({ type });
      for (const v of before) expect(v.sounding).toBe(false);
      expect(e.sfx.comboStep).toBe(-1);
      const now = r.fake.currentTime;
      const remaining = e.sfxPool.records.filter((v) => v.active && v.sounding && v.end > now);
      expect(remaining.every((v) => v.patch === 'respawn')).toBe(true);
      expect(remaining).toHaveLength(type === SimEventType.Respawned ? 1 : 0);
    }
  });

  test('the ambience beds are leases too (renewed every update, outside the budgets)', () => {
    const r = rig();
    const e = r.engine();
    r.look(areaX(1));
    for (let i = 0; i < 3; i++) r.step();
    const beds = e.bedPool.records.filter((v) => v.active && v.sounding);
    expect(beds.map((v) => v.patch).sort()).toEqual(['cricketBed', 'windBed']);
    const now = r.fake.currentTime;
    for (const v of beds) for (const s of stopTimes(v)) expect(s).toBeCloseTo(now + T.leaseStop, 12);
    expect(r.audio.stats.voices).toBe(e.sfxPool.sounding(now) + e.musicPool.sounding(now) + e.ambiencePool.sounding(now));
  });
});
