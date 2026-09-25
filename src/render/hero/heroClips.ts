import { Clip, type ChannelDef, type ChannelName, type ClipDef, type EaseName, type Skeleton } from './rig.ts';

/**
 * Keyframed clips for the spirit child. Values are deltas from the rest pose (radians / world units;
 * sx, sy as scales). Facing right, positive rotation is clockwise on screen, so for the downward limbs
 * a negative delta swings forward and a positive shin delta bends the knee; a positive spine delta
 * leans forward and a positive head delta tilts the face down.
 */

function ch(bone: string, channel: ChannelName, keys: readonly number[], ease?: EaseName): ChannelDef {
  return ease ? { bone, ch: channel, keys, ease } : { bone, ch: channel, keys };
}

/** Constant pose channel. */
function hold(bone: string, channel: ChannelName, value: number): ChannelDef {
  return { bone, ch: channel, keys: [0, value] };
}

/** Loop channel from [phase, value] pairs where the value at phase 1 repeats phase 0. */
function cyc(bone: string, channel: ChannelName, keys: readonly number[]): ChannelDef {
  return { bone, ch: channel, keys };
}

/** A run-cycle leg channel for the far leg: the near leg's keys shifted by half a cycle. */
function shifted(keys: readonly number[]): number[] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < keys.length; i += 2) pairs.push([((keys[i] as number) + 0.5) % 1, keys[i + 1] as number]);
  pairs.sort((a, b) => a[0] - b[0]);
  return pairs.flat();
}

const RUN_THIGH = [0, -0.95, 0.22, -0.2, 0.45, 0.72, 0.62, 0.35, 0.82, -0.7];
const RUN_SHIN = [0, 0.25, 0.2, 0.35, 0.45, 0.55, 0.64, 1.95, 0.84, 0.95];
const RUN_FOOT = [0, -0.25, 0.25, 0, 0.47, 0.55, 0.66, 0.2, 0.88, -0.35];
const RUN_ARM = [0, 0.75, 0.5, -0.85];
const RUN_FORE = [0, -0.55, 0.25, -1.1, 0.5, -1.25, 0.75, -0.8];

export const HERO_CLIP_DEFS: readonly ClipDef[] = [
  {
    name: 'idle', duration: 3.2, loop: true,
    channels: [
      cyc('spine', 'sx', [0, 1, 0.45, 1.032]),
      cyc('core', 'y', [0, 0, 0.45, 0.45]),
      cyc('head', 'rot', [0, 0, 0.5, 0.03]),
      cyc('armF', 'rot', [0, -0.1, 0.5, -0.17]),
      cyc('armB', 'rot', [0, 0.1, 0.5, 0.17]),
      hold('foreF', 'rot', -0.38),
      hold('foreB', 'rot', -0.3),
      hold('thighF', 'rot', -0.17),
      hold('thighB', 'rot', 0.15),
      hold('shinF', 'rot', 0.14),
      hold('shinB', 'rot', 0.03),
    ],
  },
  {
    name: 'run', duration: 0.34, loop: true,
    channels: [
      cyc('thighF', 'rot', RUN_THIGH),
      cyc('shinF', 'rot', RUN_SHIN),
      cyc('footF', 'rot', RUN_FOOT),
      cyc('thighB', 'rot', shifted(RUN_THIGH)),
      cyc('shinB', 'rot', shifted(RUN_SHIN)),
      cyc('footB', 'rot', shifted(RUN_FOOT)),
      cyc('armF', 'rot', RUN_ARM),
      cyc('armB', 'rot', shifted(RUN_ARM)),
      cyc('foreF', 'rot', RUN_FORE),
      cyc('foreB', 'rot', shifted(RUN_FORE)),
      cyc('core', 'y', [0.08, 1.3, 0.34, -1.1, 0.58, 1.3, 0.84, -1.1]),
      cyc('spine', 'rot', [0, 0.2, 0.25, 0.16, 0.5, 0.2, 0.75, 0.16]),
      cyc('head', 'rot', [0, -0.12, 0.25, -0.08, 0.5, -0.12, 0.75, -0.08]),
    ],
  },
  {
    name: 'jump', duration: 0.3, loop: false,
    channels: [
      ch('thighF', 'rot', [0, -0.4, 1, -1.05]),
      ch('shinF', 'rot', [0, 0.6, 1, 1.45]),
      ch('footF', 'rot', [0, 0.2, 1, 0.45]),
      ch('thighB', 'rot', [0, 0.2, 1, 0.38]),
      ch('shinB', 'rot', [0, 0.3, 1, 0.55]),
      ch('footB', 'rot', [0, 0.3, 1, 0.6]),
      ch('armF', 'rot', [0, -0.9, 1, -1.5]),
      ch('foreF', 'rot', [0, -0.5, 1, -0.4]),
      ch('armB', 'rot', [0, 0.6, 1, 0.95]),
      ch('foreB', 'rot', [0, -0.3, 1, -0.5]),
      ch('spine', 'rot', [0, 0.05, 1, -0.04]),
      ch('head', 'rot', [0, -0.05, 1, -0.16]),
    ],
  },
  {
    name: 'fall', duration: 0.7, loop: true,
    channels: [
      hold('thighF', 'rot', -0.35),
      cyc('shinF', 'rot', [0, 0.55, 0.5, 0.7]),
      hold('footF', 'rot', 0.35),
      hold('thighB', 'rot', 0.22),
      cyc('shinB', 'rot', [0, 0.75, 0.5, 0.6]),
      hold('footB', 'rot', 0.45),
      cyc('armF', 'rot', [0, -1.2, 0.5, -1.42]),
      cyc('foreF', 'rot', [0, -0.55, 0.5, -0.8]),
      cyc('armB', 'rot', [0, 1.25, 0.5, 1.45]),
      cyc('foreB', 'rot', [0, 0.5, 0.5, 0.75]),
      hold('spine', 'rot', -0.03),
      hold('head', 'rot', 0.14),
    ],
  },
  {
    name: 'land', duration: 0.26, loop: false,
    channels: [
      ch('core', 'y', [0, 3.4, 0.35, 2.6, 1, 0]),
      ch('thighF', 'rot', [0, -0.75, 0.35, -0.6, 1, -0.06]),
      ch('shinF', 'rot', [0, 1.2, 0.35, 1, 1, 0.08]),
      ch('footF', 'rot', [0, -0.35, 1, 0]),
      ch('thighB', 'rot', [0, -0.35, 0.35, -0.25, 1, 0.08]),
      ch('shinB', 'rot', [0, 0.95, 0.35, 0.8, 1, 0.05]),
      ch('footB', 'rot', [0, -0.5, 1, 0]),
      ch('armF', 'rot', [0, -0.55, 1, -0.02]),
      ch('armB', 'rot', [0, 0.45, 1, 0.03]),
      ch('foreF', 'rot', [0, -0.6, 1, -0.18]),
      ch('spine', 'rot', [0, 0.22, 1, 0]),
      ch('head', 'rot', [0, 0.14, 1, 0]),
    ],
  },
  {
    name: 'wallSlide', duration: 0.9, loop: true,
    channels: [
      hold('armB', 'rot', 1.95),
      hold('foreB', 'rot', 0.25),
      hold('handB', 'rot', -0.3),
      cyc('armF', 'rot', [0, -0.45, 0.5, -0.55]),
      hold('foreF', 'rot', -0.9),
      hold('thighF', 'rot', -0.7),
      hold('shinF', 'rot', 1.2),
      hold('thighB', 'rot', 0.45),
      hold('shinB', 'rot', 0.35),
      hold('footB', 'rot', -0.5),
      hold('spine', 'rot', 0.1),
      cyc('core', 'x', [0, 0.25, 0.25, -0.2, 0.5, 0.3, 0.75, -0.15]),
      hold('head', 'rot', 0.08),
    ],
  },
  {
    name: 'wallJump', duration: 0.3, loop: false,
    channels: [
      ch('thighF', 'rot', [0, -0.3, 1, -0.8]),
      ch('shinF', 'rot', [0, 0.3, 1, 0.9]),
      ch('thighB', 'rot', [0, 0.8, 1, 0.5]),
      ch('shinB', 'rot', [0, 0.15, 1, 0.4]),
      ch('armF', 'rot', [0, -1.9, 1, -1.5]),
      ch('foreF', 'rot', [0, -0.2, 1, -0.4]),
      ch('armB', 'rot', [0, 1.5, 1, 1.0]),
      ch('spine', 'rot', [0, 0.28, 1, 0.08]),
      ch('head', 'rot', [0, -0.18, 1, -0.1]),
    ],
  },
  {
    name: 'doubleJump', duration: 0.42, loop: false,
    channels: [
      ch('thighF', 'rot', [0, -0.6, 0.22, -1.7, 0.72, -1.7, 1, -0.5]),
      ch('shinF', 'rot', [0, 0.6, 0.22, 2.1, 0.72, 2.1, 1, 0.7]),
      ch('thighB', 'rot', [0, -0.3, 0.22, -1.5, 0.72, -1.5, 1, 0.1]),
      ch('shinB', 'rot', [0, 0.5, 0.22, 2.2, 0.72, 2.2, 1, 0.6]),
      ch('armF', 'rot', [0, -1.2, 0.22, -0.75, 0.72, -0.75, 1, -1.6]),
      ch('foreF', 'rot', [0, -0.3, 0.22, -1.7, 0.72, -1.7, 1, -0.3]),
      ch('armB', 'rot', [0, -0.9, 0.22, -0.6, 0.72, -0.6, 1, -1.3]),
      ch('foreB', 'rot', [0, -0.3, 0.22, -1.6, 0.72, -1.6, 1, -0.3]),
      ch('spine', 'rot', [0, 0.1, 0.22, 0.38, 0.72, 0.38, 1, 0.05]),
      ch('head', 'rot', [0, 0, 0.22, 0.25, 0.72, 0.25, 1, 0]),
    ],
  },
  {
    name: 'dash', duration: 0.3, loop: true,
    channels: [
      hold('spine', 'rot', 0.5),
      hold('head', 'rot', -0.38),
      cyc('armF', 'rot', [0, 1.35, 0.5, 1.5]),
      hold('foreF', 'rot', 0.35),
      cyc('armB', 'rot', [0, 1.6, 0.5, 1.45]),
      hold('foreB', 'rot', 0.3),
      hold('thighF', 'rot', 0.35),
      hold('shinF', 'rot', 0.55),
      hold('footF', 'rot', 0.7),
      hold('thighB', 'rot', 0.85),
      hold('shinB', 'rot', 0.4),
      hold('footB', 'rot', 0.8),
      hold('core', 'y', 2.5),
    ],
  },
  {
    name: 'dead', duration: 0.14, loop: false,
    channels: [
      ch('armF', 'rot', [0, -1, 1, -2.5], 'smooth'),
      ch('armB', 'rot', [0, -0.8, 1, -2.3], 'smooth'),
      ch('foreF', 'rot', [0, -0.3, 1, 0.3], 'smooth'),
      ch('foreB', 'rot', [0, -0.3, 1, 0.3], 'smooth'),
      ch('thighF', 'rot', [0, -0.3, 1, -0.7], 'smooth'),
      ch('thighB', 'rot', [0, 0.3, 1, 0.7], 'smooth'),
      ch('spine', 'rot', [0, -0.1, 1, -0.2], 'smooth'),
      ch('head', 'rot', [0, -0.2, 1, -0.4], 'smooth'),
      ch('core', 'y', [0, 0, 1, -3], 'smooth'),
    ],
  },
  {
    // Spirit Launch aim: a braced crouch facing the target, the front arm reaching for its light and the
    // back arm drawn in to the chest like a bowstring, trembling slightly while the world holds still.
    name: 'launchAim', duration: 0.62, loop: true,
    channels: [
      cyc('core', 'y', [0, 4.2, 0.5, 4.8]),
      cyc('spine', 'rot', [0, 0.2, 0.5, 0.24]),
      hold('head', 'rot', -0.12),
      cyc('armF', 'rot', [0, -1.95, 0.25, -1.9, 0.5, -1.98, 0.75, -1.92]),
      hold('foreF', 'rot', -0.12),
      hold('handF', 'rot', -0.2),
      cyc('armB', 'rot', [0, 0.95, 0.5, 1.02]),
      cyc('foreB', 'rot', [0, -2.25, 0.5, -2.35]),
      hold('thighF', 'rot', -0.95),
      hold('shinF', 'rot', 1.35),
      hold('footF', 'rot', -0.35),
      hold('thighB', 'rot', 0.4),
      hold('shinB', 'rot', 1.05),
      hold('footB', 'rot', -0.55),
    ],
  },
  {
    // The launch flight: a streamlined, head-first dive (the view turns the whole body onto the
    // velocity), both arms swept back along the body, the legs streaming together behind, the torso
    // stretched, a slight flutter.
    name: 'launched', duration: 0.36, loop: true,
    channels: [
      hold('core', 'y', -1.5),
      hold('spine', 'rot', 0.04),
      hold('spine', 'sx', 1.07),
      hold('head', 'rot', -0.2),
      cyc('armF', 'rot', [0, 0.62, 0.5, 0.7]),
      hold('foreF', 'rot', -0.25),
      cyc('armB', 'rot', [0, 0.82, 0.5, 0.9]),
      hold('foreB', 'rot', -0.3),
      cyc('thighF', 'rot', [0, 0.1, 0.5, 0.16]),
      hold('shinF', 'rot', 0.3),
      hold('footF', 'rot', 0.75),
      cyc('thighB', 'rot', [0, 0.3, 0.5, 0.38]),
      cyc('shinB', 'rot', [0, 0.62, 0.5, 0.7]),
      hold('footB', 'rot', 0.8),
    ],
  },
  {
    name: 'respawn', duration: 0.5, loop: false,
    channels: [
      ch('core', 'y', [0, 4, 0.55, -0.8, 1, 0]),
      ch('spine', 'rot', [0, 0.35, 0.6, -0.04, 1, 0]),
      ch('head', 'rot', [0, 0.35, 0.6, -0.06, 1, 0]),
      ch('armF', 'rot', [0, -0.4, 0.55, -1.1, 1, -0.02]),
      ch('foreF', 'rot', [0, -1.7, 0.55, -0.4, 1, -0.18]),
      ch('armB', 'rot', [0, -0.3, 0.55, -0.9, 1, 0.03]),
      ch('foreB', 'rot', [0, -1.6, 0.55, -0.3, 1, -0.12]),
      ch('thighF', 'rot', [0, -0.9, 0.6, -0.1, 1, -0.06]),
      ch('shinF', 'rot', [0, 1.4, 0.6, 0.1, 1, 0.08]),
      ch('thighB', 'rot', [0, -0.6, 0.6, 0.05, 1, 0.08]),
      ch('shinB', 'rot', [0, 1.2, 0.6, 0.05, 1, 0.05]),
    ],
  },
];

export const HERO_CLIP = {
  idle: 0, run: 1, jump: 2, fall: 3, land: 4, wallSlide: 5, wallJump: 6, doubleJump: 7, dash: 8, dead: 9, launchAim: 10,
  launched: 11, respawn: 12,
} as const;
export type HeroClipName = keyof typeof HERO_CLIP;

/** World units of travel per run cycle (two steps). */
export const RUN_STRIDE = 150;

export function createHeroClips(skeleton: Skeleton): Clip[] {
  const clips = HERO_CLIP_DEFS.map((d) => new Clip(d, skeleton));
  for (const [name, i] of Object.entries(HERO_CLIP)) {
    if (clips[i]?.name !== name) throw new Error(`Clip index mismatch for ${name}`);
  }
  return clips;
}
