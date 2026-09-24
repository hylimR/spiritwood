import { describe, expect, test } from 'vitest';
import { BufferBuilder } from '../../src/audio/buffers.ts';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';
import { SeedBurstCause, SimEventType, type SimEvent } from '../../src/contracts/sim.ts';
import { FakeContext } from './fakeContext.ts';
import { areaX, rig, type Rig } from './helpers.ts';

const T = AUDIO_TUNING;

/** A scripted 10 s scene at 60 fps: movement, orbs, seeds, a wall slide, a freeze, area changes. */
function scene(r: Rig, onFrame?: (k: number) => void): void {
  for (let k = 0; k < 600; k++) {
    const t = k / 60;
    r.look(areaX(Math.min(5, Math.floor(t / 1.8))));
    r.sim.player.mode = t > 3 && t < 4 ? 'wallSlide' : 'ground';
    r.sim.frozen = t > 6 && t < 7.5;
    r.sim.launch.aimMaxTicks = 120;
    r.sim.launch.aimTicks = r.sim.frozen ? Math.floor((t - 6) * 60) : 0;
    const ev: (Partial<SimEvent> & Pick<SimEvent, 'type'>)[] = [];
    if (k % 40 === 0) ev.push({ type: SimEventType.Jump });
    if (k % 40 === 25) ev.push({ type: SimEventType.Land, a: 700 });
    if (k % 90 === 10) ev.push({ type: SimEventType.OrbCollected, a: 1 }, { type: SimEventType.OrbCollected, a: 1 });
    if (k % 120 === 50) ev.push({ type: SimEventType.SeedFired, x: r.frame.camX + 100, y: r.frame.camY, id: 1 });
    if (k % 120 === 80) ev.push({ type: SimEventType.SeedBurst, x: r.frame.camX + 300, y: r.frame.camY, a: SeedBurstCause.Terrain, id: 1 });
    if (k === 360) ev.push({ type: SimEventType.LaunchAim, a: 1 });
    if (k === 450) ev.push({ type: SimEventType.Launch, a: -1, b: 1 });
    r.step(1 / 60, ev);
    onFrame?.(k);
  }
}

describe('performance (§5.9 Performance)', () => {
  test('update() averages ≤ 0.3 ms over a scripted 10 s scene (stats.updateMs)', () => {
    for (const warm of [false, true]) {
      const r = rig({ warm });
      const times: number[] = [];
      scene(r, () => times.push(r.audio.stats.updateMs));
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const max = Math.max(...times);
      const sorted = [...times].sort((a, b) => a - b);
      const p99 = sorted[Math.floor(sorted.length * 0.99)] as number;
      console.info(
        `[audio perf] update() over 10 s on the fake context (${warm ? 'buffers prebuilt' : 'cold start, buffers built in slices'}): `
          + `avg ${avg.toFixed(4)} ms, p99 ${p99.toFixed(3)} ms, max ${max.toFixed(3)} ms`,
      );
      expect(r.audio.stats.state).toBe('running');
      expect(avg).toBeLessThanOrEqual(0.3);
    }
  });

  test('an idle update() creates zero nodes', () => {
    const r = rig();
    const m = r.engine().music;
    for (let i = 0; i < 120; i++) r.step();
    // Step until the next music step is just booked, then idle inside the gap before the following one.
    const booked = m.booked;
    while (m.booked === booked) r.step(0.005);
    const nodes = r.fake.nodeCount;
    const gapEnd = m.stepTime(m.step) - T.horizon;
    let n = 0;
    while (r.fake.currentTime + 0.004 < gapEnd) {
      r.step(0.004);
      n++;
    }
    expect(n).toBeGreaterThan(20);
    expect(r.fake.nodeCount).toBe(nodes);
  });

  test('buffers are built in fixed slices of at most buildSliceSamples per update, and noise patches wait for them', () => {
    const fake = new FakeContext();
    const b = new BufferBuilder(fake, 1);
    const noise = Math.round(T.noiseSeconds * T.sampleRate);
    const impulse = Math.round(T.impulseSeconds * T.sampleRate) * 2;
    // Noise, the impulse, then its normalisation (one pass over the impulse again).
    const total = noise + 2 * impulse;
    let slices = 0;
    let work = 0;
    let noiseAt = -1;
    while (!b.done) {
      b.step();
      slices++;
      expect(b.lastSlice).toBeGreaterThan(0);
      expect(b.lastSlice).toBeLessThanOrEqual(T.buildSliceSamples);
      if (!b.done) expect(b.lastSlice).toBe(T.buildSliceSamples);
      work += b.lastSlice;
      if (noiseAt < 0 && b.noise) noiseAt = slices;
      if (slices > 500) throw new Error('builder stuck');
    }
    // A deterministic amount of work per slice: the counts, not the wall time.
    expect(work).toBe(total);
    expect(slices).toBe(Math.ceil(total / T.buildSliceSamples));
    expect(noiseAt).toBe(Math.ceil(noise / T.buildSliceSamples));
    expect(b.impulse).not.toBeNull();
    const r = rig({ warm: false });
    const e = r.engine();
    r.emit({ type: SimEventType.Jump }, { type: SimEventType.OrbCollected, a: 1 });
    expect(e.started.jump).toBe(0);
    expect(e.started.orb).toBe(1);
    for (let i = 0; i < 100 && !e.kit.noise; i++) r.step();
    r.emit({ type: SimEventType.Jump });
    expect(e.started.jump).toBe(1);
  });
});
