import { describe, expect, test } from 'vitest';
import {
  Animator, bonesFromWorldRest, CH, CHANNELS, Clip, Skeleton, type ClipDef, type WorldBoneDef,
} from '../../src/render/hero/rig.ts';
import { createHeroClips, HERO_CLIP, HERO_CLIP_DEFS, RUN_STRIDE } from '../../src/render/hero/heroClips.ts';
import { createHeroSkeleton, HERO_BONES, HERO_PARTS } from '../../src/render/hero/heroRig.ts';
import { InertialSpring, landSquash, Ribbon, RIBBON, SQUASH, SquashStretch } from '../../src/render/hero/heroMotion.ts';
import { DEFAULT_TUNING } from '../../src/sim/tuning.ts';

const ARM: WorldBoneDef[] = [
  { name: 'root', parent: null, x: 10, y: 20, angle: 0, length: 0 },
  { name: 'upper', parent: 'root', x: 10, y: 20, angle: Math.PI / 2, length: 5 },
  { name: 'lower', parent: 'upper', x: 10, y: 25, angle: Math.PI / 2, length: 4 },
];

function armSkeleton(): Skeleton {
  return new Skeleton(bonesFromWorldRest(ARM));
}

function clip(def: Partial<ClipDef> & Pick<ClipDef, 'channels'>, s = armSkeleton()): Clip {
  return new Clip({ name: 'c', duration: 1, loop: false, ...def }, s);
}

describe('Skeleton', () => {
  test('world rest positions and angles round-trip through parent-relative bones', () => {
    const s = createHeroSkeleton();
    s.evaluate();
    HERO_BONES.forEach((b, i) => {
      expect(s.worldX(i)).toBeCloseTo(b.x, 5);
      expect(s.worldY(i)).toBeCloseTo(b.y, 5);
      const da = Math.atan2(Math.sin(s.worldAngle(i) - b.angle), Math.cos(s.worldAngle(i) - b.angle));
      expect(da).toBeCloseTo(0, 5);
    });
  });

  test('bone world transforms follow parent rotation and scale', () => {
    const s = armSkeleton();
    const upper = s.indexOf('upper');
    const lower = s.indexOf('lower');
    s.evaluate();
    expect(s.tipX(lower)).toBeCloseTo(10, 6);
    expect(s.tipY(lower)).toBeCloseTo(29, 6);
    s.pose[upper * CHANNELS + CH.rot] = (s.pose[upper * CHANNELS + CH.rot] as number) - Math.PI / 2;
    s.evaluate();
    expect(s.tipX(upper)).toBeCloseTo(15, 6);
    expect(s.tipY(upper)).toBeCloseTo(20, 6);
    expect(s.tipX(lower)).toBeCloseTo(19, 6);
    expect(s.tipY(lower)).toBeCloseTo(20, 6);
    s.pose[upper * CHANNELS + CH.sx] = 2;
    s.evaluate();
    expect(s.tipX(lower)).toBeCloseTo(10 + 10 + 8, 6);
  });

  test('root matrix (mirror + translate) is prepended', () => {
    const s = armSkeleton();
    s.evaluate([-1, 0, 0, 1, 100, 0]);
    expect(s.worldX(0)).toBeCloseTo(90, 6);
    expect(s.tipY(s.indexOf('lower'))).toBeCloseTo(29, 6);
    expect(s.pointX(s.indexOf('lower'), 0, 1)).toBeCloseTo(91, 6);
  });

  test('rejects bad hierarchies', () => {
    expect(() => new Skeleton([{ name: 'a', parent: 0, x: 0, y: 0, rotation: 0, length: 0 }])).toThrow();
    expect(() => bonesFromWorldRest([{ name: 'a', parent: 'b', x: 0, y: 0, angle: 0, length: 0 }])).toThrow();
    expect(() => armSkeleton().indexOf('nope')).toThrow();
  });
});

describe('Clip sampling', () => {
  test('linear, smooth, step and hermite interpolate through the keys', () => {
    const c = clip({
      channels: [
        { bone: 'upper', ch: 'rot', keys: [0, 0, 1, 1], ease: 'linear' },
        { bone: 'upper', ch: 'x', keys: [0, 0, 1, 1], ease: 'smooth' },
        { bone: 'upper', ch: 'y', keys: [0, 0, 0.5, 2, 1, 4], ease: 'step' },
        { bone: 'lower', ch: 'rot', keys: [0, 0, 0.5, 1, 1, 0] },
      ],
    });
    expect(c.valueAt(0, 0.25)).toBeCloseTo(0.25, 6);
    expect(c.valueAt(1, 0.25)).toBeCloseTo(0.15625, 6);
    expect(c.valueAt(1, 0.5)).toBeCloseTo(0.5, 6);
    expect(c.valueAt(2, 0.49)).toBe(0);
    expect(c.valueAt(2, 0.51)).toBe(2);
    expect(c.valueAt(3, 0.5)).toBeCloseTo(1, 6);
    expect(c.valueAt(3, 0)).toBeCloseTo(0, 6);
    expect(c.valueAt(3, 0.25)).toBeGreaterThan(0.25);
    expect(c.valueAt(3, 0.25)).toBeLessThan(1);
  });

  test('non-looping clips clamp; hermite ends are flat', () => {
    const c = clip({ channels: [{ bone: 'upper', ch: 'rot', keys: [0.2, 1, 0.8, 3] }] });
    expect(c.valueAt(0, 0)).toBe(1);
    expect(c.valueAt(0, 1.5)).toBe(3);
    expect(c.valueAt(0, 0.2 + 1e-4) - 1).toBeLessThan(1e-4);
  });

  test('looping clips wrap continuously, including across the last → first key', () => {
    const c = clip({ loop: true, channels: [{ bone: 'upper', ch: 'rot', keys: [0.1, 0, 0.4, 1, 0.7, -1] }] });
    const a = c.valueAt(0, 0.999999);
    const b = c.valueAt(0, 0);
    expect(Math.abs(a - b)).toBeLessThan(1e-3);
    expect(c.valueAt(0, 1.4)).toBeCloseTo(c.valueAt(0, 0.4), 6);
    expect(c.valueAt(0, -0.6)).toBeCloseTo(c.valueAt(0, 0.4), 6);
    let prev = c.valueAt(0, 0);
    for (let p = 0.001; p < 2; p += 0.001) {
      const v = c.valueAt(0, p);
      expect(Math.abs(v - prev)).toBeLessThan(0.02);
      prev = v;
    }
  });

  test('scale channels are authored as scales and blend around 1', () => {
    const s = armSkeleton();
    const c = clip({ channels: [{ bone: 'upper', ch: 'sy', keys: [0, 1.5] }] }, s);
    const a = new Animator(s, [c]);
    a.snap(0);
    a.apply(s);
    expect(s.pose[s.indexOf('upper') * CHANNELS + CH.sy]).toBeCloseTo(1.5, 6);
  });

  test('validates keys', () => {
    expect(() => clip({ channels: [{ bone: 'upper', ch: 'rot', keys: [0.5, 1, 0.2, 0] }] })).toThrow();
    expect(() => clip({ channels: [{ bone: 'upper', ch: 'rot', keys: [0.5] }] })).toThrow();
    expect(() => clip({ channels: [{ bone: 'nope', ch: 'rot', keys: [0, 1] }] })).toThrow();
  });
});

describe('Animator cross-fade', () => {
  const s = armSkeleton();
  const up = s.indexOf('upper');
  const a = clip({ loop: true, channels: [{ bone: 'upper', ch: 'rot', keys: [0, 1] }] }, s);
  const b = clip({ loop: true, channels: [{ bone: 'upper', ch: 'rot', keys: [0, -1] }] }, s);

  test('linear weights that sum to one', () => {
    const anim = new Animator(s, [a, b]);
    anim.snap(0);
    anim.play(1, 0.1);
    anim.update(0.05);
    expect(anim.weights[0]).toBeCloseTo(0.5, 6);
    expect(anim.weights[1]).toBeCloseTo(0.5, 6);
    anim.apply(s);
    expect(s.pose[up * CHANNELS + CH.rot]).toBeCloseTo(Math.PI / 2, 6);
    anim.update(0.025);
    expect((anim.weights[0] as number) + (anim.weights[1] as number)).toBeCloseTo(1, 6);
    anim.update(0.1);
    expect(anim.weights[0]).toBe(0);
    expect(anim.weights[1]).toBe(1);
    anim.apply(s);
    expect(s.pose[up * CHANNELS + CH.rot]).toBeCloseTo(Math.PI / 2 - 1, 6);
  });

  test('replaying the current clip is a no-op; restart resets its phase', () => {
    const anim = new Animator(s, [a, b]);
    anim.snap(0);
    anim.update(0.3);
    const p = anim.phases[0] as number;
    anim.play(0, 0.1);
    expect(anim.phases[0]).toBe(p);
    anim.play(0, 0.1, true);
    expect(anim.phases[0]).toBe(0);
  });

  test('non-looping clips finish; speed scales playback; zero fade snaps', () => {
    const once = clip({ duration: 0.2, channels: [{ bone: 'upper', ch: 'rot', keys: [0, 0, 1, 1] }] }, s);
    const anim = new Animator(s, [a, once]);
    anim.play(1, 0);
    anim.update(0.001);
    expect(anim.weights[1]).toBe(1);
    anim.setSpeed(1, 2);
    anim.update(0.09);
    expect(anim.finished(1)).toBe(false);
    anim.update(0.02);
    expect(anim.finished(1)).toBe(true);
    anim.update(1);
    expect(anim.phases[1]).toBe(1);
  });

  test('zero fade and zero-length frames never produce NaN weights', () => {
    const anim = new Animator(s, [a, b]);
    anim.snap(0);
    anim.update(0.4);
    anim.play(1, 0);
    expect(anim.phases[1]).toBe(0);
    expect(Array.from(anim.weights)).toEqual([0, 1]);
    anim.update(0);
    anim.play(0, 0.1);
    anim.update(0);
    anim.update(-1);
    for (const w of anim.weights) expect(Number.isFinite(w)).toBe(true);
    expect(Array.from(anim.weights)).toEqual([0, 1]);
    anim.update(0.05);
    expect(anim.weights[0]).toBeCloseTo(0.5, 6);
    anim.apply(s);
    expect(Number.isFinite(s.pose[up * CHANNELS + CH.rot] as number)).toBe(true);
  });

  test('no weight → rest pose', () => {
    const anim = new Animator(s, [a]);
    anim.apply(s);
    expect(s.pose[up * CHANNELS + CH.rot]).toBeCloseTo(Math.PI / 2, 6);
  });
});

describe('hero clips', () => {
  test('every clip compiles against the hero skeleton in index order', () => {
    const s = createHeroSkeleton();
    const clips = createHeroClips(s);
    expect(clips.map((c) => c.name)).toEqual(Object.keys(HERO_CLIP));
    expect(clips).toHaveLength(HERO_CLIP_DEFS.length);
  });

  test('all clips produce finite poses at every phase', () => {
    const s = createHeroSkeleton();
    const anim = new Animator(s, createHeroClips(s));
    for (let c = 0; c < HERO_CLIP_DEFS.length; c++) {
      for (let p = 0; p <= 1; p += 0.125) {
        anim.snap(c, p);
        anim.apply(s);
        s.evaluate();
        for (const v of s.world) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  test('run cycle: legs are half a cycle apart and the stride is sane', () => {
    const s = createHeroSkeleton();
    const clips = createHeroClips(s);
    const run = clips[HERO_CLIP.run] as Clip;
    const def = HERO_CLIP_DEFS[HERO_CLIP.run] as ClipDef;
    const f = def.channels.findIndex((c) => c.bone === 'thighF');
    const b = def.channels.findIndex((c) => c.bone === 'thighB');
    for (let p = 0; p < 1; p += 0.05) expect(run.valueAt(b, p)).toBeCloseTo(run.valueAt(f, p + 0.5), 5);
    expect(RUN_STRIDE).toBeGreaterThan(60);
  });

  test('every attachment references a real bone', () => {
    const s = createHeroSkeleton();
    for (const p of HERO_PARTS) expect(() => s.indexOf(p.bone)).not.toThrow();
    expect(new Set(HERO_PARTS.map((p) => p.id)).size).toBe(HERO_PARTS.length);
  });

  test('about 66 u tall at rest with the body inside the 28 × 58 collider', () => {
    const s = createHeroSkeleton();
    s.evaluate();
    const bud = s.tipY(s.indexOf('sproutB'));
    expect(bud).toBeLessThan(-62);
    expect(bud).toBeGreaterThan(-70);
    expect(s.worldY(s.indexOf('head')) - 22.6).toBeGreaterThan(-58.5);
  });
});

describe('squash & stretch', () => {
  test('volume preserving: sx · sy = 1 through a whole bounce', () => {
    const sq = new SquashStretch();
    sq.kick(landSquash(900));
    for (let i = 0; i < 120; i++) {
      sq.update(1 / 60);
      expect(sq.scaleX * sq.scaleY).toBeCloseTo(1, 12);
    }
    sq.update(1 / 60, SQUASH.dash);
    expect(sq.scaleX * sq.scaleY).toBeCloseTo(1, 12);
  });

  test('landing squash grows with impact and is capped', () => {
    expect(landSquash(SQUASH.landMinSpeed - 1)).toBe(0);
    let prev = 0;
    for (let v = 200; v <= 3000; v += 100) {
      const s = landSquash(v);
      expect(s).toBeLessThanOrEqual(prev);
      expect(s).toBeGreaterThanOrEqual(SQUASH.min);
      prev = s;
    }
    expect(landSquash(1e6)).toBe(SQUASH.min);
  });

  test('springs back to rest, overshooting once (a bounce), and holds a target', () => {
    const sq = new SquashStretch();
    sq.kick(-0.3);
    expect(sq.scaleY).toBeLessThan(1);
    expect(sq.scaleX).toBeGreaterThan(1);
    let overshoot = 0;
    for (let i = 0; i < 90; i++) {
      sq.update(1 / 60);
      overshoot = Math.max(overshoot, sq.value);
    }
    expect(overshoot).toBeGreaterThan(0.01);
    expect(Math.abs(sq.value)).toBeLessThan(1e-3);
    for (let i = 0; i < 60; i++) sq.update(1 / 60, SQUASH.dash);
    expect(sq.value).toBeCloseTo(SQUASH.dash, 3);
    expect(sq.scaleX).toBeGreaterThan(1);
    sq.kick(5);
    expect(sq.value).toBe(SQUASH.max);
    sq.reset();
    expect(sq.scaleX).toBe(1);
  });

  test('frame-rate independent (30 vs 144 Hz)', () => {
    const a = new SquashStretch();
    const b = new SquashStretch();
    a.kick(-0.3);
    b.kick(-0.3);
    for (let i = 0; i < 9; i++) a.update(1 / 30);
    for (let i = 0; i < 43; i++) b.update(1 / 144);
    b.update(0.3 - 43 / 144);
    expect(a.value).toBeCloseTo(b.value, 3);
  });
});

describe('inertial spring and scarf ribbon', () => {
  test('spring follows its drive and respects the limit', () => {
    const s = new InertialSpring(200, 12, 0.5);
    for (let i = 0; i < 120; i++) s.update(1 / 60, 0.3);
    expect(s.value).toBeCloseTo(0.3, 3);
    for (let i = 0; i < 120; i++) s.update(1 / 60, 5);
    expect(s.value).toBe(0.5);
  });

  test('ribbon keeps segment lengths, stays pinned and settles behind', () => {
    const r = new Ribbon();
    r.reset(0, 0, -1, 0);
    let t = 0;
    for (let i = 0; i < 240; i++) {
      t += 1 / 60;
      const ax = Math.sin(t * 3) * 40;
      r.update(1 / 60, ax, 0, -1, -0.2, t);
      expect(r.x[0]).toBeCloseTo(ax, 5);
      for (let k = 1; k < r.count; k++) {
        const d = Math.hypot((r.x[k] as number) - (r.x[k - 1] as number), (r.y[k] as number) - (r.y[k - 1] as number));
        expect(Math.abs(d - RIBBON.segment)).toBeLessThan(RIBBON.segment * 0.12);
      }
    }
    for (let i = 0; i < 240; i++) {
      t += 1 / 60;
      r.update(1 / 60, 0, 0, -1, -0.2, t);
    }
    expect(r.x[r.count - 1]).toBeLessThan(-RIBBON.segment * 3);
  });

  test('sudden anchor accelerations (run and dash starts) drag the scarf without kinking it', () => {
    const maxBend = (r: Ribbon): number => {
      let worst = 0;
      for (let i = 1; i < r.count - 1; i++) {
        const ax = (r.x[i] as number) - (r.x[i - 1] as number);
        const ay = (r.y[i] as number) - (r.y[i - 1] as number);
        const bx = (r.x[i + 1] as number) - (r.x[i] as number);
        const by = (r.y[i + 1] as number) - (r.y[i] as number);
        const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
        worst = Math.max(worst, Math.acos(Math.min(1, Math.max(-1, c))));
      }
      return worst;
    };
    const r = new Ribbon();
    r.reset(0, 0, -1, -0.15);
    let x = 0;
    let t = 0;
    // Standing start straight to run speed, then a dash: the anchor jumps ~7 then ~20 u per frame.
    for (let f = 0; f < 40; f++) {
      const v = f < 25 ? DEFAULT_TUNING.maxRunSpeed : DEFAULT_TUNING.dashSpeed;
      x += v / 60;
      t += 1 / 60;
      r.update(1 / 60, x, 0, -1, -0.18, t);
      expect(maxBend(r)).toBeLessThan((25 * Math.PI) / 180);
      for (let k = 1; k < r.count; k++) {
        const d = Math.hypot((r.x[k] as number) - (r.x[k - 1] as number), (r.y[k] as number) - (r.y[k - 1] as number));
        expect(d).toBeCloseTo(RIBBON.segment, 3);
      }
    }
  });

  test('stable for long frames and teleports; reset lays it straight', () => {
    const r = new Ribbon();
    r.reset(0, 0, -1, 0);
    r.update(0.05, 5000, -3000, -1, 0, 1);
    for (let i = 0; i < 30; i++) r.update(0.05, 5000, -3000, -1, 0, 1 + i * 0.05);
    for (let k = 0; k < r.count; k++) {
      expect(Number.isFinite(r.x[k] as number)).toBe(true);
      expect(Math.hypot((r.x[k] as number) - 5000, (r.y[k] as number) + 3000)).toBeLessThan(RIBBON.segment * r.count * 1.2);
    }
    r.reset(10, 10, 0, 1);
    expect(r.y[3]).toBeCloseTo(10 + 3 * RIBBON.segment, 5);
    r.update(0, 0, 0, 1, 0, 0);
    expect(r.y[3]).toBeCloseTo(10 + 3 * RIBBON.segment, 5);
  });
});
