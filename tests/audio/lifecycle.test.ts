import { afterEach, describe, expect, test, vi } from 'vitest';
import { AudioSystem, UNLOCK_EVENTS } from '../../src/audio/audio.ts';
import { SimEventType } from '../../src/contracts/sim.ts';
import { FakeBufferSource, FakeContext, FakeGestureTarget } from './fakeContext.ts';
import { areaX, rig } from './helpers.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

function system(factory: () => FakeContext | null, target = new FakeGestureTarget()): { audio: AudioSystem; target: FakeGestureTarget } {
  return { audio: new AudioSystem({ createContext: factory, gestureTarget: target, seed: 1 }), target };
}

describe('state table (§5.9)', () => {
  test('enabled: false is unavailable and arms nothing', () => {
    const target = new FakeGestureTarget();
    const factory = vi.fn(() => new FakeContext());
    const audio = new AudioSystem({ createContext: factory, gestureTarget: target, enabled: false });
    expect(audio.stats.state).toBe('unavailable');
    expect(target.count()).toBe(0);
    audio.unlock();
    target.fire('keydown');
    expect(factory).not.toHaveBeenCalled();
    expect(audio.stats.state).toBe('unavailable');
  });

  test('without Web Audio (no factory, no AudioContext global) it is unavailable', () => {
    expect(typeof (globalThis as { AudioContext?: unknown }).AudioContext).toBe('undefined');
    const audio = new AudioSystem({ gestureTarget: null });
    expect(audio.stats.state).toBe('unavailable');
    audio.unlock();
    expect(audio.stats.state).toBe('unavailable');
  });

  test('locked and armed in the capture phase until a user activation; no context before it', () => {
    const factory = vi.fn(() => new FakeContext());
    const { audio, target } = system(factory);
    expect(audio.stats.state).toBe('locked');
    expect(factory).not.toHaveBeenCalled();
    for (const type of UNLOCK_EVENTS) {
      const l = target.listeners.get(type);
      expect(l?.length, type).toBe(1);
      expect(l?.[0]?.capture, type).toBe(true);
    }
  });

  test('untrusted events are ignored', () => {
    const factory = vi.fn(() => new FakeContext());
    const { audio, target } = system(factory);
    target.fire('click', false);
    expect(factory).not.toHaveBeenCalled();
    expect(audio.stats.state).toBe('locked');
  });

  test('a trusted gesture creates the context, calls resume() and starts a one-sample silent buffer', () => {
    const fake = new FakeContext();
    const factory = vi.fn(() => fake);
    const { audio, target } = system(factory);
    target.fire('pointerdown');
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.resumeCalls).toBe(1);
    const silent = fake.sources().filter((s): s is FakeBufferSource => s instanceof FakeBufferSource);
    expect(silent).toHaveLength(1);
    expect(silent[0]?.buffer?.length).toBe(1);
    expect(silent[0]?.startTime).toBe(0);
    expect(silent[0]?.targets).toEqual([fake.destination]);
    expect(audio.stats.state).toBe('locked');
  });

  test('listeners stay armed while not running (resume is never gated on an earlier call), then disarm', () => {
    const fake = new FakeContext();
    const { audio, target } = system(() => fake);
    target.fire('keydown');
    target.fire('touchend');
    target.fire('gamepadconnected');
    expect(fake.resumeCalls).toBe(3);
    expect(target.count()).toBe(UNLOCK_EVENTS.length);
    fake.setState('running');
    expect(audio.stats.state).toBe('running');
    expect(target.count()).toBe(0);
    target.fire('keydown');
    expect(fake.resumeCalls).toBe(3);
  });

  test('unlock() twice makes one context; once running it is a no-op', () => {
    const fake = new FakeContext();
    const factory = vi.fn(() => fake);
    const { audio } = system(factory);
    audio.unlock();
    audio.unlock();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fake.resumeCalls).toBe(2);
    fake.setState('running');
    const nodes = fake.nodeCount;
    audio.unlock();
    expect(fake.resumeCalls).toBe(2);
    expect(fake.nodeCount).toBe(nodes);
    expect(audio.stats.state).toBe('running');
  });

  test('a factory returning null or throwing leaves it unavailable without throwing', () => {
    const a = system(() => null).audio;
    a.unlock();
    expect(a.stats.state).toBe('unavailable');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const b = system(() => {
      throw new Error('NotAllowedError');
    }).audio;
    expect(() => b.unlock()).not.toThrow();
    expect(b.stats.state).toBe('unavailable');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('suspended after running; setActive(false) suspends and setActive(true) resumes', () => {
    const r = rig();
    expect(r.audio.stats.state).toBe('running');
    r.audio.setActive(false);
    expect(r.fake.suspendCalls).toBe(1);
    r.fake.setState('suspended');
    expect(r.audio.stats.state).toBe('suspended');
    const resumes = r.fake.resumeCalls;
    r.audio.setActive(true);
    expect(r.fake.resumeCalls).toBe(resumes + 1);
    expect(r.audio.stats.state).toBe('running');
  });

  test('setActive(true) never resumes a context that has not run yet (that needs a gesture)', () => {
    const fake = new FakeContext();
    const { audio } = system(() => fake);
    audio.unlock();
    audio.setActive(false);
    audio.setActive(true);
    expect(fake.resumeCalls).toBe(1);
    expect(audio.stats.state).toBe('locked');
  });

  test('statechange reconciles: running while hidden is suspended again; interrupted counts as suspended', () => {
    const r = rig({ fake: { autoRun: false } });
    r.audio.setActive(false);
    r.fake.setState('suspended');
    const suspends = r.fake.suspendCalls;
    r.fake.setState('running');
    expect(r.fake.suspendCalls).toBe(suspends + 1);
    r.fake.setState('suspended');
    r.audio.setActive(true);
    r.fake.setState('running');
    const resumes = r.fake.resumeCalls;
    r.fake.setState('interrupted');
    expect(r.audio.stats.state).toBe('suspended');
    // The reconcile tries to resume, and a gesture may too: the listeners are armed again.
    expect(r.fake.resumeCalls).toBe(resumes + 1);
    expect(r.target.count()).toBe(UNLOCK_EVENTS.length);
  });

  test('every Web Audio promise is caught', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const r = rig({ fake: { reject: true } });
      r.audio.setActive(false);
      r.fake.setState('suspended');
      r.audio.setActive(true);
      r.audio.destroy();
      await new Promise((res) => setTimeout(res, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('destroy() closes the context, disarms and is final', () => {
    const fake = new FakeContext();
    const { audio, target } = system(() => fake);
    audio.unlock();
    audio.destroy();
    expect(audio.stats.state).toBe('closed');
    expect(fake.closeCalls).toBe(1);
    expect(target.count()).toBe(0);
    audio.unlock();
    audio.setActive(true);
    expect(audio.stats.state).toBe('closed');
    expect(fake.resumeCalls).toBe(1);
  });

  test('latency is baseLatency + outputLatency, or −1 when outputLatency is unknown', () => {
    const a = rig({ fake: { baseLatency: 0.01, outputLatency: 0.03 } });
    a.step();
    expect(a.audio.stats.latency).toBeCloseTo(0.04, 9);
    const b = rig({ fake: { baseLatency: 0.01, outputLatency: undefined } });
    b.step();
    expect(b.audio.stats.latency).toBe(-1);
  });

  test('until running, update() books nothing and SFX events are dropped', () => {
    const r = rig({ fake: { autoRun: false }, run: false });
    r.audio.unlock();
    expect(r.audio.stats.state).toBe('locked');
    const nodes = r.fake.nodeCount;
    for (let i = 0; i < 30; i++) r.step(1 / 60, [{ type: SimEventType.Jump }, { type: SimEventType.OrbCollected, a: 1 }]);
    expect(r.fake.nodeCount).toBe(nodes);
    expect(r.fake.sources()).toHaveLength(1);
  });
});

describe('fails closed', () => {
  test('the first unexpected error logs once, closes the context and leaves it unavailable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = rig();
    r.fake.failNext = 'createOscillator';
    expect(() => r.emit({ type: SimEventType.OrbCollected, a: 1 })).not.toThrow();
    expect(r.audio.stats.state).toBe('unavailable');
    expect(r.fake.closeCalls).toBe(1);
    expect(error).toHaveBeenCalledTimes(1);
    const nodes = r.fake.nodeCount;
    expect(() => {
      r.step();
      r.emit({ type: SimEventType.Jump });
      r.audio.setVolumes({ master: 0.5, music: 0.5, sfx: 0.5 });
      r.audio.setActive(false);
      r.audio.setActive(true);
      r.audio.unlock();
      r.look(areaX(3));
      r.step(1);
    }).not.toThrow();
    expect(r.fake.nodeCount).toBe(nodes);
    expect(r.audio.stats.state).toBe('unavailable');
    expect(error).toHaveBeenCalledTimes(1);
  });

  test('a throw inside update() fails closed the same way', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = rig();
    r.fake.failNext = 'connect';
    r.step(1);
    expect(r.audio.stats.state).toBe('unavailable');
    expect(error).toHaveBeenCalledTimes(1);
    expect(r.fake.closeCalls).toBe(1);
  });

  test('an AudioContext closed from outside ends in unavailable', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = rig();
    r.fake.setState('closed');
    expect(r.audio.stats.state).toBe('unavailable');
    expect(error).toHaveBeenCalledTimes(1);
  });
});
