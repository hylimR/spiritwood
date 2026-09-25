import { describe, expect, test } from 'vitest';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';
import type { Voice } from '../../src/audio/voices.ts';
import type { FakeParam } from './fakeContext.ts';
import { areaX, rig } from './helpers.ts';

const T = AUDIO_TUNING;

function chirps(bed: Voice): number {
  let n = 0;
  for (let i = 1; i <= 3; i++) {
    const g = bed.handles[i] as unknown as FakeParam | null;
    if (g) n += g.events.filter((e) => e.kind === 'set' && e.value === 0).length;
  }
  return n;
}

describe('ambience (§5.9)', () => {
  test('crickets are gain-gated FM on persistent oscillators: chirps add automation, never nodes', () => {
    const r = rig();
    const e = r.engine();
    // Music off (it books nothing then) and the glade (no drips; the first owl is ≥ 20 s away).
    r.audio.setVolumes({ master: 1, music: 0, sfx: 1 });
    for (let i = 0; i < 30; i++) r.step();
    const bed = e.bedPool.records.find((v) => v.active && v.patch === 'cricketBed') as Voice;
    expect(bed).toBeDefined();
    const nodes = r.fake.nodeCount;
    const before = chirps(bed);
    for (let i = 0; i < 60 * 4; i++) r.step();
    expect(chirps(bed)).toBeGreaterThan(before + 8);
    expect(r.fake.nodeCount).toBe(nodes);
    expect(e.bedPool.records.filter((v) => v.active && v.patch === 'cricketBed')).toEqual([bed]);
  });

  test('crickets hold still while the world is frozen', () => {
    const r = rig();
    const e = r.engine();
    for (let i = 0; i < 30; i++) r.step();
    const bed = e.bedPool.records.find((v) => v.active && v.patch === 'cricketBed') as Voice;
    r.sim.frozen = true;
    r.sim.launch.aimMaxTicks = 120;
    for (let i = 0; i < 20; i++) r.step();
    const frozenStart = chirps(bed);
    for (let i = 0; i < 60 * 2; i++) r.step();
    expect(chirps(bed)).toBe(frozenStart);
    r.sim.frozen = false;
    for (let i = 0; i < 60 * 3; i++) r.step();
    expect(chirps(bed)).toBeGreaterThan(frozenStart);
  });

  test('wind and cricket levels follow the area mix (written on change, τ = levelTau)', () => {
    const r = rig();
    const e = r.engine();
    for (let i = 0; i < 10; i++) r.step();
    const wind = e.bedPool.records.find((v) => v.active && v.patch === 'windBed') as Voice;
    const lvl = wind.handles[0] as unknown as FakeParam;
    const n = lvl.events.length;
    for (let i = 0; i < 10; i++) r.step();
    expect(lvl.events.length).toBe(n);
    r.look(areaX(3));
    r.step();
    const ev = lvl.events.at(-1);
    expect(ev).toMatchObject({ kind: 'target', tau: T.levelTau });
    expect(ev?.value).toBeGreaterThan(0.9);
  });

  test('water drips only in the Rootwell; a rare owl or creak comes by now and then', () => {
    const r = rig();
    const e = r.engine();
    for (let i = 0; i < 60 * 15; i++) r.step();
    expect(e.started.waterDrip).toBe(0);
    r.look(areaX(2));
    for (let i = 0; i < 60 * 15; i++) r.step();
    expect(e.started.waterDrip).toBeGreaterThan(3);
    for (let i = 0; i < 60 * 70; i++) r.step(1 / 30);
    expect(e.started.owl + e.started.creak).toBeGreaterThan(0);
    expect(e.ambiencePool.sounding(r.fake.currentTime)).toBeLessThanOrEqual(T.budgetAmbience);
  });
});
