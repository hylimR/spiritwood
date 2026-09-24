import type { PlayerMode } from '../../contracts/sim.ts';
import { HERO_CLIP, HERO_CLIP_DEFS } from './heroClips.ts';

/** Render-side inputs for picking the hero's clip (sim state plus event timers, seconds). */
export interface HeroAnimInput {
  mode: PlayerMode;
  alive: boolean;
  grounded: boolean;
  vx: number;
  vy: number;
  inputX: number;
  sinceLand: number;
  sinceWallJump: number;
  sinceRespawn: number;
  flipping: boolean;
}

export const HERO_ANIM = Object.freeze({
  /** |vx| (u/s) above which the ground clip is `run`. */
  runSpeed: 25,
  /** Rising faster than this (u/s, upward) plays `jump`; otherwise `fall`. */
  riseSpeed: 60,
  /** A landing interrupts runs faster than this. */
  landMaxSpeed: 260,
  wallJumpTime: 0.24,
  landTime: (HERO_CLIP_DEFS[HERO_CLIP.land] as { duration: number }).duration,
  respawnTime: (HERO_CLIP_DEFS[HERO_CLIP.respawn] as { duration: number }).duration,
  flipTime: (HERO_CLIP_DEFS[HERO_CLIP.doubleJump] as { duration: number }).duration,
});

/** The clip the hero should be playing (HERO_CLIP index). Pure. */
export function chooseHeroClip(s: HeroAnimInput): number {
  if (!s.alive || s.mode === 'dead') return HERO_CLIP.dead;
  const still = s.grounded && Math.abs(s.vx) < HERO_ANIM.runSpeed && Math.abs(s.inputX) < 0.3;
  if (s.sinceRespawn < HERO_ANIM.respawnTime && still) return HERO_CLIP.respawn;
  if (s.mode === 'dash') return HERO_CLIP.dash;
  if (s.mode === 'wallSlide') return HERO_CLIP.wallSlide;
  if (!s.grounded) {
    if (s.flipping) return HERO_CLIP.doubleJump;
    if (s.sinceWallJump < HERO_ANIM.wallJumpTime) return HERO_CLIP.wallJump;
    return s.vy < -HERO_ANIM.riseSpeed ? HERO_CLIP.jump : HERO_CLIP.fall;
  }
  if (s.sinceLand < HERO_ANIM.landTime && Math.abs(s.vx) < HERO_ANIM.landMaxSpeed) return HERO_CLIP.land;
  if (Math.abs(s.vx) > HERO_ANIM.runSpeed || Math.abs(s.inputX) >= 0.3) return HERO_CLIP.run;
  return HERO_CLIP.idle;
}

/** Cross-fade time (s) into a clip: quick for impacts and bursts, softer for idle/fall. */
export function fadeInto(clip: number): number {
  switch (clip) {
    case HERO_CLIP.land:
    case HERO_CLIP.dash:
    case HERO_CLIP.dead:
      return 0.06;
    case HERO_CLIP.jump:
    case HERO_CLIP.wallJump:
    case HERO_CLIP.doubleJump:
      return 0.07;
    case HERO_CLIP.fall:
      return 0.16;
    case HERO_CLIP.idle:
      return 0.12;
    default:
      return 0.09;
  }
}
