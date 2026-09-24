import { describe, expect, test } from 'vitest';
import { MAX_STEPS_PER_FRAME, SIM_DT, SIM_HZ, VSYNC_SNAP_EPSILON } from '../../src/config.ts';
import { FixedStepLoop, type LoopHooks, type LoopOptions } from '../../src/core/loop.ts';

interface Recorded {
  steps: number;
  renders: number;
  stepsPerRender: number[];
  alphas: number[];
  frameDts: number[];
  lates: number[];
  begins: number;
}

function harness(options: Partial<LoopOptions> = {}, onBegin?: (loop: FixedStepLoop) => void): { loop: FixedStepLoop; rec: Recorded } {
  const rec: Recorded = { steps: 0, renders: 0, stepsPerRender: [], alphas: [], frameDts: [], lates: [], begins: 0 };
  let stepsThisFrame = 0;
  let loopRef: FixedStepLoop | null = null;
  const hooks: LoopHooks = {
    beginFrame: () => {
      rec.begins++;
      stepsThisFrame = 0;
      if (onBegin && loopRef) onBegin(loopRef);
    },
    step: (dt) => {
      expect(dt).toBe(SIM_DT);
      rec.steps++;
      stepsThisFrame++;
    },
    render: (alpha, frameDt, _now, late) => {
      rec.renders++;
      rec.stepsPerRender.push(stepsThisFrame);
      rec.alphas.push(alpha);
      rec.frameDts.push(frameDt);
      rec.lates.push(late);
    },
  };
  const loop = new FixedStepLoop(hooks, options);
  loopRef = loop;
  return { loop, rec };
}

/** rAF timestamps at `hz`, optionally quantised to whole milliseconds like coarsened browser clocks. */
function rafTimes(hz: number, count: number, start = 1000, quantiseMs = false): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const t = start + (i * 1000) / hz;
    out.push(quantiseMs ? Math.round(t) : t);
  }
  return out;
}

describe('FixedStepLoop', () => {
  test('first frame only initialises the clock', () => {
    const { loop, rec } = harness({ fpsCap: 0 });
    expect(loop.frame(500)).toBe(false);
    expect(rec.begins).toBe(0);
    expect(rec.renders).toBe(0);
    expect(rec.steps).toBe(0);
    expect(loop.frame(500 + 1000 / 60)).toBe(true);
    expect(rec.steps).toBe(1);
  });

  test('1 ms-quantised 60 Hz timestamps run exactly one step per frame for 600 frames', () => {
    const { loop, rec } = harness({ fpsCap: 0 });
    const times = rafTimes(60, 601, 1000, true);
    for (const t of times) loop.frame(t);
    expect(rec.renders).toBe(600);
    expect(rec.stepsPerRender.every((n) => n === 1)).toBe(true);
    expect(rec.steps).toBe(600);
  });

  test('1 ms-quantised 60 Hz with the 60 fps cap renders every rAF with one step', () => {
    const { loop, rec } = harness({ fpsCap: 60 });
    for (const t of rafTimes(60, 601, 1000, true)) loop.frame(t);
    expect(rec.renders).toBe(600);
    expect(rec.stepsPerRender.every((n) => n === 1)).toBe(true);
    expect(loop.stats.lateFramesTotal).toBe(0);
  });

  test('vsync snap: deltas within epsilon of k ticks run exactly k steps', () => {
    const { loop, rec } = harness({ fpsCap: 0 });
    let t = 0;
    loop.frame(t);
    const eps = VSYNC_SNAP_EPSILON * 1000 * 0.9;
    const deltas = [1000 / 60 + eps, 1000 / 60 - eps, 2000 / 60 + eps, 2000 / 60 - eps, 3000 / 60 - eps];
    for (const d of deltas) {
      t += d;
      loop.frame(t);
    }
    expect(rec.stepsPerRender).toEqual([1, 1, 2, 2, 3]);
    for (const a of rec.alphas) expect(a).toBeCloseTo(0, 9);
  });

  test('120 and 144 Hz uncapped: steps average the sim rate, alpha interpolates', () => {
    for (const hz of [120, 144]) {
      const { loop, rec } = harness({ fpsCap: 0 });
      const frames = hz * 2;
      for (const t of rafTimes(hz, frames + 1)) loop.frame(t);
      expect(rec.renders).toBe(frames);
      expect(Math.abs(rec.steps - SIM_HZ * 2)).toBeLessThanOrEqual(1);
      expect(Math.max(...rec.stepsPerRender)).toBeLessThanOrEqual(1);
      expect(rec.alphas.some((a) => a > 0.2 && a < 0.8)).toBe(true);
    }
  });

  test('irregular timestamps (never near a tick multiple) conserve sim time exactly', () => {
    const { loop, rec } = harness({ fpsCap: 0 });
    const deltas = [7, 23, 11, 40, 3, 9.9, 25, 12.1, 29, 4.5];
    let t = 100;
    loop.frame(t);
    let total = 0;
    for (let i = 0; i < 50; i++) {
      const d = deltas[i % deltas.length] as number;
      t += d;
      total += d;
      loop.frame(t);
    }
    const expected = (total / 1000) * SIM_HZ;
    const alpha = rec.alphas[rec.alphas.length - 1] as number;
    expect(rec.steps + alpha).toBeCloseTo(expected, 6);
  });

  test('144 Hz with the 60 fps cap averages 59–61 renders/s with no late frames in steady state', () => {
    const { loop, rec } = harness({ fpsCap: 60 });
    for (const t of rafTimes(144, 144 * 4 + 1)) loop.frame(t);
    const steadyFrom = 60;
    const perSecond = rec.renders / 4;
    expect(perSecond).toBeGreaterThanOrEqual(59);
    expect(perSecond).toBeLessThanOrEqual(61);
    expect(rec.lates.slice(steadyFrom).every((l) => l === 0)).toBe(true);
    expect(loop.stats.framesSkipped).toBe(144 * 4 - rec.renders);
    expect(Math.abs(rec.steps - rec.renders)).toBeLessThanOrEqual(2);
  });

  test('144 Hz with the cap: the 1 ms-quantised cadence also stays at 60 fps', () => {
    const { loop, rec } = harness({ fpsCap: 60 });
    for (const t of rafTimes(144, 144 * 2 + 1, 1000, true)) loop.frame(t);
    expect(rec.renders / 2).toBeGreaterThanOrEqual(59);
    expect(rec.renders / 2).toBeLessThanOrEqual(61);
  });

  test('120 Hz with the 60 fps cap renders exactly every second rAF', () => {
    const { loop, rec } = harness({ fpsCap: 60 });
    const times = rafTimes(120, 241);
    const rendered: boolean[] = [];
    for (const t of times) rendered.push(loop.frame(t));
    const tail = rendered.slice(20);
    for (let i = 0; i < tail.length - 1; i++) expect(tail[i]).not.toBe(tail[i + 1]);
    expect(rec.renders).toBe(120);
    expect(rec.lates.every((l) => l === 0)).toBe(true);
  });

  test('a display slightly slower than the cap (59.94 Hz) renders every rAF and is almost never late', () => {
    for (const quantise of [false, true]) {
      const { loop, rec } = harness({ fpsCap: 60 });
      const frames = Math.round(59.94 * 60);
      for (const t of rafTimes(59.94, frames + 1, 1000, quantise)) loop.frame(t);
      expect(rec.renders).toBe(frames);
      expect(loop.stats.framesSkipped).toBe(0);
      // A 59.94 Hz display really misses one 60 Hz deadline every ~17 s; each miss is counted once.
      expect(loop.stats.lateFramesTotal).toBeLessThanOrEqual(frames * 0.01);
    }
  });

  test('a single missed vsync under the cap is reported on exactly one frame', () => {
    const { loop, rec } = harness({ fpsCap: 60 });
    const times = rafTimes(60, 241, 1000, true);
    times.splice(120, 1);
    for (const t of times) loop.frame(t);
    const late = rec.lates.map((l, i) => (l > 0 ? i : -1)).filter((i) => i >= 0);
    expect(late).toEqual([119]);
    expect(rec.lates[119]).toBe(1);
    expect(rec.stepsPerRender[119]).toBe(2);
  });

  test('a 2 s hitch runs max steps, drops the rest, then resyncs the cap deadline', () => {
    const { loop, rec } = harness({ fpsCap: 60 });
    let t = 0;
    for (let i = 0; i <= 144; i++) loop.frame((t = (i * 1000) / 144));
    const rendersBefore = rec.renders;
    const stepsBefore = rec.steps;
    t += 2000;
    expect(loop.frame(t)).toBe(true);
    expect(rec.steps - stepsBefore).toBe(MAX_STEPS_PER_FRAME);
    expect(loop.stats.stepsLastFrame).toBe(MAX_STEPS_PER_FRAME);
    expect(loop.stats.droppedSeconds).toBeGreaterThan(2 - MAX_STEPS_PER_FRAME * SIM_DT - 2 * SIM_DT);
    expect(loop.stats.lateFrames).toBeGreaterThan(100);
    expect(rec.frameDts[rec.frameDts.length - 1]).toBeGreaterThanOrEqual(2);
    for (let i = 1; i <= 10; i++) loop.frame(t + (i * 1000) / 144);
    expect(rec.renders - rendersBefore - 1).toBeLessThanOrEqual(5);
    expect(rec.renders - rendersBefore - 1).toBeGreaterThanOrEqual(3);
  });

  test('uncapped: a frame far longer than the rAF estimate counts as late', () => {
    const { loop, rec } = harness({ fpsCap: 0 });
    let t = 0;
    for (let i = 0; i <= 120; i++) loop.frame((t = (i * 1000) / 60));
    expect(loop.stats.lateFramesTotal).toBe(0);
    loop.frame(t + 50);
    expect(rec.lates[rec.lates.length - 1]).toBe(1);
    expect(loop.stats.lateFramesTotal).toBe(1);
  });

  test('paused: no steps, alpha 1, hooks still run; unpausing resumes from an empty accumulator', () => {
    const { loop, rec } = harness({ fpsCap: 0 });
    let t = 0;
    loop.frame(t);
    loop.frame((t += 25));
    loop.setPaused(true);
    const steps = rec.steps;
    for (let i = 0; i < 30; i++) loop.frame((t += 1000 / 60));
    expect(rec.steps).toBe(steps);
    expect(rec.alphas.slice(-30).every((a) => a === 1)).toBe(true);
    loop.setPaused(false);
    loop.frame((t += 1000 / 60));
    expect(rec.steps).toBe(steps + 1);
    expect(rec.alphas[rec.alphas.length - 1]).toBeCloseTo(0, 9);
  });

  test('pausing from inside beginFrame applies to that same frame', () => {
    let pauseNow = false;
    const { loop, rec } = harness({ fpsCap: 0 }, (l) => {
      if (pauseNow) l.setPaused(true);
    });
    let t = 0;
    loop.frame(t);
    loop.frame((t += 1000 / 60));
    pauseNow = true;
    loop.frame((t += 1000 / 60));
    expect(rec.stepsPerRender).toEqual([1, 0]);
    expect(rec.alphas[1]).toBe(1);
  });

  test('resetClock between frames: the next frame renders with no steps and owes nothing', () => {
    const { loop, rec } = harness({ fpsCap: 60 });
    let t = 0;
    loop.frame(t);
    loop.frame((t += 1000 / 60));
    loop.resetClock();
    t += 5000;
    expect(loop.frame(t)).toBe(true);
    expect(rec.stepsPerRender[rec.stepsPerRender.length - 1]).toBe(0);
    expect(rec.alphas[rec.alphas.length - 1]).toBe(1);
    expect(rec.lates[rec.lates.length - 1]).toBe(0);
    expect(loop.stats.droppedSeconds).toBe(0);
    // The forgotten 5 s gap is not reported as a frame time (it would spike FrameTimer / bench stats).
    expect(rec.frameDts[rec.frameDts.length - 1]).toBeCloseTo(1 / 60, 3);
    expect(loop.stats.lastFrameDt).toBeCloseTo(1 / 60, 3);
    expect(loop.frame((t += 1000 / 60))).toBe(true);
    expect(rec.stepsPerRender[rec.stepsPerRender.length - 1]).toBe(1);
    expect(rec.lates[rec.lates.length - 1]).toBe(0);
  });

  test('resetClock inside beginFrame applies to that frame; inside render to the next', () => {
    let resetIn: 'begin' | 'render' | null = null;
    const steps: number[] = [];
    let current = 0;
    let loopRef: FixedStepLoop | null = null;
    const loop = new FixedStepLoop({
      beginFrame: () => {
        current = 0;
        if (resetIn === 'begin') {
          resetIn = null;
          loopRef?.resetClock();
        }
      },
      step: () => {
        current++;
      },
      render: () => {
        steps.push(current);
        if (resetIn === 'render') {
          resetIn = null;
          loopRef?.resetClock();
        }
      },
    }, { fpsCap: 0 });
    loopRef = loop;
    let t = 0;
    loop.frame(t);
    loop.frame((t += 1000 / 60));
    resetIn = 'begin';
    loop.frame((t += 1000 / 60));
    loop.frame((t += 1000 / 60));
    resetIn = 'render';
    loop.frame((t += 1000 / 60));
    loop.frame((t += 1000 / 60));
    loop.frame((t += 1000 / 60));
    expect(steps).toEqual([1, 0, 1, 1, 0, 1]);
  });

  test('resetClock inside a step stops stepping for the frame', () => {
    let resetOnStep = false;
    let stepsRun = 0;
    let loopRef: FixedStepLoop | null = null;
    const loop = new FixedStepLoop({
      beginFrame: () => {},
      step: () => {
        stepsRun++;
        if (resetOnStep) {
          resetOnStep = false;
          loopRef?.resetClock();
        }
      },
      render: () => {},
    }, { fpsCap: 0 });
    loopRef = loop;
    loop.frame(0);
    resetOnStep = true;
    loop.frame(4 * (1000 / 60));
    expect(stepsRun).toBe(1);
    expect(loop.stats.droppedSeconds).toBe(0);
  });

  test('start() after stop() re-initialises like a first frame', () => {
    const { loop, rec } = harness({ fpsCap: 0 });
    const queue: FrameRequestCallback[] = [];
    const raf = (cb: FrameRequestCallback): number => queue.push(cb);
    loop.start(raf, () => {});
    (queue.shift() as FrameRequestCallback)(0);
    (queue.shift() as FrameRequestCallback)(1000 / 60);
    loop.stop();
    expect(rec.renders).toBe(1);
    loop.start(raf, () => {});
    queue.length = 0;
    loop.start(raf, () => {});
    expect(queue).toHaveLength(0);
    loop.frame(90000);
    expect(rec.renders).toBe(1);
  });

  test('setFpsCap switches between capped and uncapped cadence', () => {
    const { loop, rec } = harness({ fpsCap: 60 });
    const times = rafTimes(120, 121);
    for (const t of times) loop.frame(t);
    const capped = rec.renders;
    loop.setFpsCap(0);
    const last = times[times.length - 1] as number;
    for (let i = 1; i <= 120; i++) loop.frame(last + (i * 1000) / 120);
    expect(capped).toBe(60);
    expect(rec.renders - capped).toBe(120);
  });

  test('start/stop drive frames from requestAnimationFrame', () => {
    const { loop, rec } = harness({ fpsCap: 0 });
    const queue: FrameRequestCallback[] = [];
    let cancelled = -1;
    let nextId = 1;
    const raf = (cb: FrameRequestCallback): number => {
      queue.push(cb);
      return nextId++;
    };
    const caf = (id: number): void => {
      cancelled = id;
    };
    loop.start(raf, caf);
    expect(loop.running).toBe(true);
    for (let i = 0; i < 5; i++) (queue.shift() as FrameRequestCallback)((i * 1000) / 60);
    expect(rec.renders).toBe(4);
    loop.stop();
    expect(loop.running).toBe(false);
    expect(cancelled).toBe(nextId - 1);
  });
});
