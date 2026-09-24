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
  /** Probe distance for wall contact (wall jump legality / slide). */
  wallJumpProbe: number;
  /** |moveX| at or above this counts as holding a direction (wall hold, dash dir, facing). */
  dirThreshold: number;
  /** moveY at or above this counts as holding down (drop-through, fast fall). */
  downThreshold: number;
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
  wallJumpProbe: 6,
  dirThreshold: 0.3,
  downThreshold: 0.5,
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
  /** Extra apex height from apex hang on a held jump: apexThreshold²/(2g)·(1/apexGravityMult − 1). */
  apexHangExtra: number;
}

export function deriveTuning(t: PlayerTuning): DerivedTuning {
  const gravity = (2 * t.jumpHeight) / (t.jumpTimeToApex * t.jumpTimeToApex);
  return {
    gravity,
    jumpVelocity: (2 * t.jumpHeight) / t.jumpTimeToApex,
    airJumpVelocity: Math.sqrt(2 * gravity * t.airJumpHeight),
    wallJumpVelocity: Math.sqrt(2 * gravity * t.wallJumpHeight),
    apexHangExtra: ((t.apexThreshold * t.apexThreshold) / (2 * gravity)) * (1 / t.apexGravityMult - 1),
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
  /** While airborne, the vertical ground reference only rises once the feet are this far above it. */
  airRiseMargin: number;
  /** Ticks |vx| must exceed lookAheadMinSpeed in a new direction before the look-ahead flips. */
  lookAheadCommitTicks: number;
  /** Ticks of slow speed before the look-ahead decays to 0. */
  lookAheadHoldTicks: number;
  /** Look-down only once the feet are this far below the last grounded y. */
  lookDownMinDrop: number;
  /** Zoom while the player aims a Spirit Launch (§5.2). */
  aimZoom: number;
  /** smoothDamp time of the zoom toward `aimZoom` / `zoom` (s). */
  zoomSmoothTime: number;
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
  airRiseMargin: 200,
  lookAheadCommitTicks: 20,
  lookAheadHoldTicks: 45,
  lookDownMinDrop: 192,
  aimZoom: 1.08,
  zoomSmoothTime: 0.18,
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
  /** Stomp if the player's previous feet y ≤ enemy's previous top + this. */
  stompTolerance: number;
  stunTicks: number;
  /** Ticks after death during which the hero stays visible (plays `dead`). */
  deathHideTicks: number;
  /** Max speed of a magnetised orb. */
  orbMaxSpeed: number;
  enemyWidth: number;
  enemyHeight: number;
  enemyDefaultSpeed: number;
  /** Thorn Spitter defaults for LDtk fields left unset (§5.3). Range is muzzle → player centre, u. */
  spitterDefaultRange: number;
  spitterDefaultPeriod: number;
  spitterDefaultFlightTicks: number;
  /** Fixed-aim seed launch speed, u/s. */
  spitterDefaultSpeed: number;
  /** Thorn Spitter contact box (on its feet) and muzzle height above the feet. */
  spitterWidth: number;
  spitterHeight: number;
  spitterMuzzleHeight: number;
  /** Telegraph before every shot (SpitterWindup a). */
  spitterWindupTicks: number;
  /** Stun of a player-aimed spitter hit by a reflected seed or launched off. */
  spitterStunTicks: number;
  /** A player-aimed spitter fires only with its muzzle this far inside the camera view. */
  spitterViewInset: number;
  /** Seed collision radius (centre-based terrain test, circle against boxes). */
  seedRadius: number;
  /** Gravity of hostile seeds, u/s² (reflected seeds fly straight). */
  seedGravity: number;
  seedMaxSpeed: number;
  seedLifetimeTicks: number;
  reflectedLifetimeTicks: number;
  /** Seeds this far below the level's bottom edge expire. */
  seedOutMargin: number;
}

export const DEFAULT_WORLD_TUNING: Readonly<WorldTuning> = Object.freeze({
  orbMagnetRadius: 150,
  orbMagnetAccel: 3200,
  orbCollectRadius: 36,
  dyingTicks: 42,
  fadeOutTicks: 24,
  fadeInTicks: 30,
  stompBounceVelocity: 820,
  stompTolerance: 8,
  stunTicks: 180,
  deathHideTicks: 8,
  orbMaxSpeed: 1400,
  enemyWidth: 64,
  enemyHeight: 44,
  enemyDefaultSpeed: 90,
  spitterDefaultRange: 720,
  spitterDefaultPeriod: 150,
  spitterDefaultFlightTicks: 60,
  spitterDefaultSpeed: 900,
  spitterWidth: 44,
  spitterHeight: 60,
  spitterMuzzleHeight: 50,
  spitterWindupTicks: 36,
  spitterStunTicks: 300,
  spitterViewInset: 32,
  seedRadius: 12,
  seedGravity: 1400,
  seedMaxSpeed: 1300,
  seedLifetimeTicks: 300,
  reflectedLifetimeTicks: 150,
  seedOutMargin: 240,
});

/** Spirit Launch (§5.1.1). Ticks are 60 Hz sim ticks; the release tick R is flight tick 1. */
export interface LaunchTuning {
  /** Grab radius, player centre → target centre (inclusive), u. */
  range: number;
  /** Aiming auto-releases when aimTicks reaches this. */
  aimMaxTicks: number;
  /** Launch speed along the aim, u/s. */
  speed: number;
  /** Length of the `launched` phase. */
  flightTicks: number;
  /** Gravity multiplier of the `launched` phase (replaces the §5.1 table). */
  flightGravityMult: number;
  /** Ticks from the release in which enemy and seed contact can't kill. */
  graceTicks: number;
  /** Ticks after the release in which the last target can't be grabbed. */
  regrabTicks: number;
  /** Jump and dash presses on the first ticks from the release are dropped (not buffered). */
  inputLockTicks: number;
  /** A launch press stays live this long waiting for a candidate. */
  bufferTicks: number;
  /** Speed of a seed flung off (opposite the aim, straight, no gravity), u/s. */
  seedSpeed: number;
}

export const DEFAULT_LAUNCH_TUNING: Readonly<LaunchTuning> = Object.freeze({
  range: 170,
  aimMaxTicks: 120,
  speed: 1150,
  flightTicks: 12,
  flightGravityMult: 0.35,
  graceTicks: 8,
  regrabTicks: 20,
  inputLockTicks: 4,
  bufferTicks: 6,
  seedSpeed: 1000,
});
