import { describe, expect, test } from 'vitest';
import { EVENT_PATCH, isSpatialEvent } from '../../src/audio/sfx.ts';
import { PATCHES } from '../../src/audio/patches/index.ts';
import { rattleTargets } from '../../src/audio/patches/sfx.ts';
import { createPlacement, place } from '../../src/audio/space.ts';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';
import type { Voice } from '../../src/audio/voices.ts';
import { smoothstep } from '../../src/audio/util.ts';
import { EnemyHitCause, SeedBurstCause, SimEventType } from '../../src/contracts/sim.ts';
import { FakeGain, FakePanner, FakeSource, type FakeParam } from './fakeContext.ts';
import { rig, type Rig } from './helpers.ts';

const T = AUDIO_TUNING;

function startedBy(r: Rig, patch: string): Voice[] {
  return r.engine().sfxPool.records.filter((v) => v.active && v.patch === patch);
}

function envPeak(v: Voice): number {
  const env = (v.kill as unknown as FakeGain).inputs[0] as FakeGain;
  return Math.max(...env.gain.events.filter((e) => e.kind === 'lin').map((e) => e.value));
}

describe('EVENT_PATCH (§5.9 SFX)', () => {
  test('maps every SimEventType to a known patch or null', () => {
    const types = Object.values(SimEventType);
    expect(Object.keys(EVENT_PATCH).map(Number).sort((a, b) => a - b)).toEqual([...types].sort((a, b) => a - b));
    for (const t of types) {
      const id = EVENT_PATCH[t];
      if (id !== null) expect(PATCHES[id]).toBeDefined();
    }
    expect(EVENT_PATCH[SimEventType.WallSlideEnd]).toBeNull();
    expect(EVENT_PATCH[SimEventType.Reset]).toBeNull();
    expect(EVENT_PATCH[SimEventType.Teleported]).toBeNull();
  });

  test('player-origin events are non-spatial; enemy-side events are spatial', () => {
    const spatial: SimEventType[] = [SimEventType.EnemyStomped, SimEventType.EnemyReformed, SimEventType.SeedFired,
      SimEventType.SeedBurst, SimEventType.SpitterWindup, SimEventType.EnemyHit];
    for (const t of Object.values(SimEventType)) expect(isSpatialEvent(t), String(t)).toBe(spatial.includes(t));
  });

  test('payload variants: DashEnd only into a wall; EnemyHit only from a seed; SeedBurst on an enemy chimes', () => {
    const r = rig();
    const e = r.engine();
    for (const b of [0, 1, 3]) r.emit({ type: SimEventType.DashEnd, b });
    expect(e.started.wallThud).toBe(0);
    r.emit({ type: SimEventType.DashEnd, b: 2 });
    expect(e.started.wallThud).toBe(1);
    const x = r.frame.camX;
    const y = r.frame.camY;
    r.emit({ type: SimEventType.EnemyHit, x, y, a: EnemyHitCause.Launch, id: 0 });
    expect(e.started.enemyHit).toBe(0);
    r.emit({ type: SimEventType.EnemyHit, x, y, a: EnemyHitCause.Seed, id: 0 });
    expect(e.started.enemyHit).toBe(1);
    r.emit({ type: SimEventType.SeedBurst, x, y, a: SeedBurstCause.Enemy, b: 1, id: 2 });
    expect(e.started.seedChime).toBe(1);
    expect(e.started.seedCrackle).toBe(0);
    r.emit({ type: SimEventType.WallSlideEnd });
    const total = Object.values(e.started).reduce((a, b) => a + b, 0);
    r.emit({ type: SimEventType.WallSlideEnd, b: 1 });
    expect(Object.values(e.started).reduce((a, b) => a + b, 0)).toBe(total);
  });

  test('Land: silent below 150 u/s, loudness proportional to impact speed, at least 80 ms apart', () => {
    const r = rig();
    const e = r.engine();
    r.emit({ type: SimEventType.Land, a: T.landMinSpeed - 1 });
    expect(e.started.land).toBe(0);
    r.emit({ type: SimEventType.Land, a: 400 });
    r.emit({ type: SimEventType.Land, a: 900 });
    expect(e.started.land).toBe(1);
    r.step(T.landMinGap - 0.01);
    r.emit({ type: SimEventType.Land, a: 900 });
    expect(e.started.land).toBe(1);
    r.step(0.02);
    r.emit({ type: SimEventType.Land, a: 800 });
    expect(e.started.land).toBe(2);
    const [soft, hard] = startedBy(r, 'land') as [Voice, Voice];
    expect(envPeak(hard) / envPeak(soft)).toBeCloseTo(800 / 400, 6);
  });

  test('orb combo: bell notes climb the harmony scale one step per pickup within 1.5 s, at most 7 steps', () => {
    const r = rig();
    const e = r.engine();
    const h = e.harmony;
    const base = h.comboBase();
    const pitches: number[] = [];
    for (let i = 0; i < 10; i++) {
      r.emit({ type: SimEventType.OrbCollected, a: 1, id: i });
      pitches.push(e.params.midi);
      r.step(0.3);
    }
    const expected = pitches.map((_, i) => h.note(base + Math.min(i, T.orbComboMaxSteps)));
    expect(pitches).toEqual(expected);
    for (const m of pitches) {
      const pc = (((m - T.tonicMidi) % 12) + 12) % 12;
      expect([0, 2, 4, 7, 9]).toContain(pc);
    }
    r.step(T.orbComboWindow + 0.1);
    r.emit({ type: SimEventType.OrbCollected, a: 1, id: 99 });
    expect(e.sfx.comboStep).toBe(0);
    expect(e.params.midi).toBe(h.note(base));
  });

  test('same-frame orb pickups are staggered 50 ms apart', () => {
    const r = rig();
    r.emit(...[0, 1, 2, 3].map((id) => ({ type: SimEventType.OrbCollected, a: 1, id })));
    const starts = startedBy(r, 'orb').map((v) => v.start).sort((a, b) => a - b);
    expect(starts).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect((starts[i] as number) - (starts[i - 1] as number)).toBeCloseTo(T.orbStagger, 9);
    // The next frame starts a new stagger group.
    r.step();
    r.emit({ type: SimEventType.OrbCollected, a: 1, id: 9 });
    const newest = startedBy(r, 'orb').sort((a, b) => a.seq - b.seq).at(-1) as Voice;
    expect(newest.start).toBeCloseTo(r.fake.currentTime + T.sfxLead, 9);
  });

  test('SFX start 6 ms ahead (two render quanta at 48 kHz), not after the music lead', () => {
    // A device with baseLatency 40 ms: the music books 80 ms ahead, the SFX still 6 ms.
    const r = rig({ fake: { baseLatency: 0.04 } });
    const e = r.engine();
    const quantum = 128 / T.sampleRate;
    const sp = r.sim.enemies.find((en) => en.kind === 'thornSpitter');
    if (!sp) throw new Error('no spitter');
    r.look(sp.x, sp.y - 200);
    r.step();
    const now = r.fake.currentTime;
    const x = r.frame.camX;
    const y = r.frame.camY;
    r.emit(
      { type: SimEventType.Jump }, { type: SimEventType.Land, a: 900 }, { type: SimEventType.OrbCollected, a: 1 },
      { type: SimEventType.LaunchAim, a: 1 }, { type: SimEventType.CheckpointActivated }, { type: SimEventType.SeedFired, x, y, id: 1 },
    );
    // State-driven leases start in update(): scrape, aim sustain, heartbeat and a windup rattle.
    r.sim.player.mode = 'wallSlide';
    r.sim.frozen = true;
    r.sim.launch.aimMaxTicks = 120;
    sp.mode = 'windup';
    sp.modeDuration = 36;
    r.step(0);
    const voices = e.sfxPool.records.filter((v) => v.active && v.start >= now);
    expect(voices.map((v) => v.patch).sort()).toEqual(
      ['aimSustain', 'checkpoint', 'heartbeat', 'jump', 'land', 'launchAim', 'orb', 'rattle', 'scrape', 'seedPop'],
    );
    expect(e.lead).toBeCloseTo(0.08, 12);
    for (const v of voices) {
      expect(v.start - now, v.patch).toBeGreaterThanOrEqual(2 * quantum);
      expect(v.start - now, v.patch).toBeLessThanOrEqual(0.01);
    }
    // The heartbeat's first lub-dub is on its start.
    const hb = voices.find((v) => v.patch === 'heartbeat') as Voice;
    const beat = (hb.handles[0] as unknown as FakeParam).events.find((ev) => ev.kind === 'set');
    expect(beat?.time).toBeCloseTo(hb.start, 12);
  });

  test('the rattle carries its distance gain once, on its level handle, and follows the camera through the windup', () => {
    const r = rig();
    const e = r.engine();
    const sp = r.sim.enemies.find((en) => en.kind === 'thornSpitter');
    if (!sp) throw new Error('no spitter');
    const hx = r.frame.viewW / (2 * r.sim.camera.zoom);
    const cy = sp.y - sp.height * 0.5;
    const tg = new Float64Array(4);
    let v: Voice | null = null;
    let peak = 0;
    // Envelope peak × level = 0.5733 · targets[0] · (1 − smoothstep(d)), whatever the camera does.
    const check = (camX: number, d: number, ticks: number, first = false): void => {
      r.look(camX, cy);
      sp.mode = 'windup';
      sp.modeDuration = 36;
      sp.modeTicks = ticks;
      r.step(1 / 60, first ? [{ type: SimEventType.SpitterWindup, x: sp.x, y: sp.y - 50, a: 36, id: sp.id }] : []);
      if (first) {
        v = e.sfx.lease('rattle0');
        if (!v) throw new Error('no rattle');
        const env = (v.kill as unknown as FakeGain).inputs[0] as FakeGain;
        peak = Math.max(...env.gain.events.filter((ev) => ev.kind === 'lin').map((ev) => ev.value));
        expect(peak).toBeCloseTo(0.5733, 12);
        // It starts at the windup's first level, already distance-scaled.
        rattleTargets(0, tg);
        expect((v.handles[0] as unknown as FakeParam).value).toBeCloseTo((tg[0] as number) * (1 - smoothstep(0, 1, d)), 12);
      }
      expect(e.sfx.lease('rattle0')).toBe(v);
      rattleTargets(ticks / 36, tg);
      const lvl = (v?.handles[0] as unknown as FakeParam).events.filter((ev) => ev.kind === 'target').at(-1)?.value ?? NaN;
      expect(peak * lvl).toBeCloseTo(0.5733 * (tg[0] as number) * (1 - smoothstep(0, 1, d)), 9);
      // The pan follows too (from the first frame on).
      const pan = (v?.panner as unknown as FakePanner).pan.events.filter((ev) => ev.kind === 'target').at(-1)?.value ?? NaN;
      expect(pan).toBeCloseTo(Math.max(-1, Math.min(1, (sp.x - camX) / hx)) * T.panScale, 9);
    };
    check(sp.x - hx * 1.5, 0.5, 6, true);
    // The camera moves onto the spitter mid-windup, then away again.
    check(sp.x, 0, 18);
    check(sp.x + hx * 1.8, 0.8, 30);
  });

  test('melodic SFX take their pitches from the current harmony', () => {
    const r = rig();
    const e = r.engine();
    e.harmony.set('gully', 1);
    r.emit({ type: SimEventType.CheckpointActivated, id: 0 });
    const cp = startedBy(r, 'checkpoint')[0] as Voice;
    const oscFreqs = (cp.sources.slice(0, cp.nSources) as unknown as FakeSource[])
      .filter((s): s is FakeSource & { frequency: { value: number } } => 'frequency' in s)
      .map((s) => s.frequency.value);
    for (let i = 0; i < 4; i++) {
      const f = 440 * Math.pow(2, (e.harmony.voice(i) - 69) / 12);
      expect(oscFreqs.some((x) => Math.abs(x / f - 1) < 0.01), `voice ${i}`).toBe(true);
    }
    r.emit({ type: SimEventType.GoalReached, a: 100 });
    const goal = e.params;
    for (let i = 0; i < 8; i++) expect(e.harmony.isChordTone(goal.notes[i] as number) || i < 4).toBe(true);
    for (let i = 0; i < 4; i++) {
      const pc = ((((goal.notes[i] as number) - T.tonicMidi) % 12) + 12) % 12;
      expect([0, 2, 3, 5, 7, 8, 10]).toContain(pc);
    }
  });
});

describe('space (§5.9)', () => {
  test('distance, gain, cull and pan follow the d-metric with sim.camera.zoom', () => {
    const r = rig();
    const f = r.frame;
    const out = createPlacement();
    const z = 1.25;
    r.sim.camera.zoom = z;
    const hx = f.viewW / (2 * z);
    const hy = f.viewH / (2 * z);
    place(f, f.camX + hx * 0.5, f.camY, out);
    expect(out.d).toBe(0);
    expect(out.gain).toBe(1);
    expect(out.pan).toBeCloseTo(0.5 * T.panScale, 12);
    place(f, f.camX - hx * 1.5, f.camY + hy * 1.4, out);
    const d = Math.hypot(0.5, 0.4);
    expect(out.d).toBeCloseTo(d, 12);
    expect(out.gain).toBeCloseTo(1 - smoothstep(0, 1, d), 12);
    expect(out.pan).toBeCloseTo(-T.panScale, 12);
    place(f, f.camX + hx * 2.01, f.camY, out);
    expect(out.d).toBeGreaterThanOrEqual(1);
  });

  test('spatial events are culled at d ≥ 1 before a voice is allocated; others pan by ×0.6', () => {
    const r = rig();
    const e = r.engine();
    const hx = r.frame.viewW / 2;
    const nodes = r.fake.nodeCount;
    r.emit({ type: SimEventType.SeedFired, x: r.frame.camX + hx * 2.5, y: r.frame.camY, id: 1 });
    expect(e.started.seedPop).toBe(0);
    expect(r.fake.nodeCount).toBe(nodes);
    r.emit({ type: SimEventType.SeedFired, x: r.frame.camX + hx * 0.5, y: r.frame.camY, id: 2 });
    const v = startedBy(r, 'seedPop')[0] as Voice;
    expect(v.panner).toBeInstanceOf(FakePanner);
    expect((v.panner as unknown as FakePanner).pan.value).toBeCloseTo(0.5 * T.panScale, 12);
  });

  test('non-spatial voices use the fixed 0.7071 centre gain instead of a panner, and are never culled', () => {
    const r = rig();
    r.emit({ type: SimEventType.Jump, x: 1e6, y: 1e6 });
    const v = startedBy(r, 'jump')[0] as Voice;
    expect(v).toBeDefined();
    expect(v.panner).toBeNull();
    const tail = (v.kill as unknown as FakeGain).targets[0] as FakeGain;
    expect(tail).toBeInstanceOf(FakeGain);
    expect(tail.gain.value).toBeCloseTo(Math.SQRT1_2, 12);
    expect(tail.targets).toEqual([r.engine().mixer.sfx]);
  });
});
