import type { PatchFn } from '../kit.ts';
import { Category } from '../tuning.ts';
import * as amb from './ambience.ts';
import * as mus from './music.ts';
import * as sfx from './sfx.ts';

export interface PatchDef {
  readonly fn: PatchFn;
  readonly category: Category;
  /** Steal order within the category: lowest priority first, then oldest. */
  readonly priority: number;
  /** Skipped until the noise buffer is built. */
  readonly noise: boolean;
  /** Open-ended: a lease re-issued by update(). */
  readonly lease: boolean;
  /** Longest concurrent instances (0 = only the category budget). */
  readonly cap: number;
}

function def(fn: PatchFn, category: Category, priority: number, noise: boolean, lease = false, cap = 0): PatchDef {
  return { fn, category, priority, noise, lease, cap };
}

const S = Category.Sfx;
const M = Category.Music;
const A = Category.Ambience;

/** Every patch, keyed by id. Tools and tests iterate this; the engine looks patches up by id. */
export const PATCHES = {
  jump: def(sfx.jump, S, 1, true),
  airJump: def(sfx.airJump, S, 1, true),
  wallJump: def(sfx.wallJump, S, 1, true),
  dash: def(sfx.dash, S, 1, true),
  wallThud: def(sfx.wallThud, S, 1, true),
  gripTick: def(sfx.gripTick, S, 0, true),
  rustle: def(sfx.rustle, S, 0, true),
  land: def(sfx.land, S, 1, true),
  orb: def(sfx.orb, S, 2, false),
  checkpoint: def(sfx.checkpoint, S, 3, false),
  goal: def(sfx.goal, S, 3, false),
  ability: def(sfx.ability, S, 3, false),
  died: def(sfx.died, S, 3, true),
  respawn: def(sfx.respawn, S, 3, true),
  stomp: def(sfx.stomp, S, 1, true),
  reform: def(sfx.reform, S, 1, false),
  seedPop: def(sfx.seedPop, S, 1, true, false, 3),
  seedCrackle: def(sfx.seedCrackle, S, 0, true, false, 4),
  seedChime: def(sfx.seedChime, S, 1, false),
  enemyHit: def(sfx.enemyHit, S, 2, true),
  launchAim: def(sfx.launchAim, S, 3, true),
  launch: def(sfx.launch, S, 3, true),
  fizzle: def(sfx.fizzle, S, 0, true),
  scrape: def(sfx.scrape, S, 2, true, true),
  aimSustain: def(sfx.aimSustain, S, 3, false, true),
  heartbeat: def(sfx.heartbeat, S, 3, false, true),
  rattle: def(sfx.rattle, S, 2, true, true, 2),

  pad: def(mus.pad, M, 3, false),
  bell: def(mus.bell, M, 1, false),
  piano: def(mus.piano, M, 1, false),
  pulse: def(mus.pulse, M, 2, false),
  drone: def(mus.drone, M, 3, false),
  drip: def(mus.drip, M, 0, true),
  shimmer: def(mus.shimmer, M, 1, false),
  harmonics: def(mus.harmonics, M, 2, false),

  windBed: def(amb.windBed, A, 9, true, true),
  cricketBed: def(amb.cricketBed, A, 9, false, true),
  owl: def(amb.owl, A, 2, true),
  creak: def(amb.creak, A, 2, false),
  waterDrip: def(amb.waterDrip, A, 1, true),
} as const satisfies Record<string, PatchDef>;

export type PatchId = keyof typeof PATCHES;

export const PATCH_IDS = Object.keys(PATCHES) as PatchId[];
