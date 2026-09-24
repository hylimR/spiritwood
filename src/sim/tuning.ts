/**
 * Feel tuning. Distances in world units (TILE = 48), speeds u/s, accelerations u/s², durations in
 * 60 Hz ticks. Values here are the M1 baseline; tests assert behaviour derived from them, so tests
 * must read values from these objects rather than hard-coding numbers.
 */
export interface PlayerTuning {
  width: number;
  height: number;

  maxRunSpeed: number;
  groundAccel: number;
  groundDecel: number;
  /** Used instead of groundAccel when input opposes current velocity. */
  turnAccel: number;
  airAccel: number;
  airDecel: number;
  airTurnAccel: number;

  /** Apex height of a full (held) ground jump. */
  jumpHeight: number;
  /** Seconds from take-off to apex of a full jump (with apex hang excluded from the derivation). */
  jumpTimeToApex: number;
  /** Gravity multiplier while rising with jump released (variable height). */
  jumpCutGravityMult: number;
  /** |vy| below which apex hang applies while jump is held. */
  apexThreshold: number;
  apexGravityMult: number;
  fallGravityMult: number;
  maxFallSpeed: number;
  /** Max fall speed while holding down. */
  fastFallSpeed: number;

  coyoteTicks: number;
  jumpBufferTicks: number;

  airJumps: number;
  /** Apex height of the air (double) jump from a standstill vy = 0. */
  airJumpHeight: number;

  wallSlideMaxSpeed: number;
  /** Ticks the player stays stuck to a wall after input stops pointing into it. */
  wallStickTicks: number;
  wallCoyoteTicks: number;
  wallJumpVx: number;
  /** Apex height of a wall jump. */
  wallJumpHeight: number;
  /** Ticks over which horizontal control ramps from 0 back to 1 after a wall jump. */
  wallJumpLockTicks: number;

  dashSpeed: number;
  dashTicks: number;
  dashCooldownTicks: number;
  dashEndSpeed: number;
  airDashes: number;

  /** Max horizontal nudge when the head clips a ceiling corner while rising. */
  cornerCorrection: number;
  /** Max vertical pop-up onto a ledge when running/dashing into its top edge. */
  ledgeAssist: number;
  /** Ticks one-way platforms are ignored after a drop-through. */
  dropThroughTicks: number;
}

export const DEFAULT_TUNING: Readonly<PlayerTuning> = Object.freeze({
  width: 28,
  height: 58,

  maxRunSpeed: 440,
  groundAccel: 5200,
  groundDecel: 6400,
  turnAccel: 9000,
  airAccel: 3600,
  airDecel: 1400,
  airTurnAccel: 5200,

  jumpHeight: 172,
  jumpTimeToApex: 0.38,
  jumpCutGravityMult: 2.8,
  apexThreshold: 110,
  apexGravityMult: 0.55,
  fallGravityMult: 1.55,
  maxFallSpeed: 1020,
  fastFallSpeed: 1300,

  coyoteTicks: 7,
  jumpBufferTicks: 8,

  airJumps: 1,
  airJumpHeight: 120,

  wallSlideMaxSpeed: 190,
  wallStickTicks: 8,
  wallCoyoteTicks: 6,
  wallJumpVx: 520,
  wallJumpHeight: 140,
  wallJumpLockTicks: 12,

  dashSpeed: 1180,
  dashTicks: 10,
  dashCooldownTicks: 24,
  dashEndSpeed: 440,
  airDashes: 1,

  cornerCorrection: 10,
  ledgeAssist: 12,
  dropThroughTicks: 12,
});

export interface DerivedTuning {
  /** Base gravity (u/s²) = 2·jumpHeight / jumpTimeToApex². */
  gravity: number;
  /** = 2·jumpHeight / jumpTimeToApex. */
  jumpVelocity: number;
  /** sqrt(2·gravity·airJumpHeight). */
  airJumpVelocity: number;
  /** sqrt(2·gravity·wallJumpHeight). */
  wallJumpVelocity: number;
}

export function deriveTuning(t: PlayerTuning): DerivedTuning {
  const gravity = (2 * t.jumpHeight) / (t.jumpTimeToApex * t.jumpTimeToApex);
  return {
    gravity,
    jumpVelocity: (2 * t.jumpHeight) / t.jumpTimeToApex,
    airJumpVelocity: Math.sqrt(2 * gravity * t.airJumpHeight),
    wallJumpVelocity: Math.sqrt(2 * gravity * t.wallJumpHeight),
  };
}

export interface CameraTuning {
  /** Dead zone size in view units, centred on the framing point. */
  deadZoneW: number;
  deadZoneH: number;
  /** Framing point offset from the player's feet (view units, −y = camera looks higher). */
  targetOffsetY: number;
  lookAheadX: number;
  lookAheadMinSpeed: number;
  lookAheadSmoothTime: number;
  lookDownMax: number;
  lookDownFallSpeed: number;
  smoothTimeX: number;
  smoothTimeY: number;
  zoom: number;
}

export const DEFAULT_CAMERA_TUNING: Readonly<CameraTuning> = Object.freeze({
  deadZoneW: 140,
  deadZoneH: 110,
  targetOffsetY: -120,
  lookAheadX: 200,
  lookAheadMinSpeed: 120,
  lookAheadSmoothTime: 0.55,
  lookDownMax: 220,
  lookDownFallSpeed: 700,
  smoothTimeX: 0.18,
  smoothTimeY: 0.28,
  zoom: 1,
});

export interface WorldTuning {
  orbMagnetRadius: number;
  orbMagnetAccel: number;
  orbCollectRadius: number;
  /** Ticks between death and respawn. */
  dyingTicks: number;
  /** Ticks to fade out after death (≤ dyingTicks). */
  fadeOutTicks: number;
  /** Ticks to fade back in after respawn. */
  fadeInTicks: number;
  stompBounceVelocity: number;
  stunTicks: number;
  enemyWidth: number;
  enemyHeight: number;
  enemyDefaultSpeed: number;
}

export const DEFAULT_WORLD_TUNING: Readonly<WorldTuning> = Object.freeze({
  orbMagnetRadius: 150,
  orbMagnetAccel: 3200,
  orbCollectRadius: 36,
  dyingTicks: 42,
  fadeOutTicks: 24,
  fadeInTicks: 30,
  stompBounceVelocity: 820,
  stunTicks: 180,
  enemyWidth: 64,
  enemyHeight: 44,
  enemyDefaultSpeed: 90,
});
