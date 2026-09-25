import type { Sprite } from 'pixi.js';
import type { RenderStats } from '../../contracts/debug.ts';
import type { FrameInfo } from '../../contracts/render.ts';
import { SimEventType, type EnemyView, type LaunchTargetKind, type ProjectileView, type SimEvent, type SimView } from '../../contracts/sim.ts';
import { PALETTE } from '../../config.ts';
import { RING_LINE } from './launchArt.ts';
import {
  imageSprite, PALPHA, POSE_STRIDE, PoseBuffer, PROT, PSX, PSY, PX, PY, radialSprite, type EntityImage, type EntityLayers,
  type EntityRenderer, type EntityTextures,
} from './kit.ts';

export const LAUNCH_FX = Object.freeze({
  /** Ring line radius (u) = target size + this. */
  seedPad: 14,
  enemyPad: 10,
  /** Candidate pulse (Hz) and depth. */
  pulseHz: 1.6,
  pulse: 0.07,
  /** While aiming the ring tightens to this fraction, and further with the aim timer. */
  lockTighten: 0.78,
  timerTighten: 0.14,
  fadeIn: 0.08,
  fadeOut: 0.12,
  lockTime: 0.1,
  /** The aim arrow starts this far from the hero's centre. */
  arrowStart: 13,
  /** Release burst: the ring line grows from `burstFrom` to `burstTo` u (≈ 0.03 screens of fill at its widest). */
  burstTime: 0.42,
  burstFrom: 16,
  burstTo: 96,
  fizzleTime: 0.32,
  tint: PALETTE.spiritGlow,
});

/** A resolved launch target: interpolated centre and ring radius (radius < 0 = none). */
export interface LaunchMark {
  x: number;
  y: number;
  radius: number;
}

/**
 * The interpolated centre of a launch target, looked up by kind and id in the live pools (never the
 * LaunchView's tick-snapped candidateX/Y): a seed's centre, or an enemy's body centre. `at` is the frame
 * (its sim and interpolation alpha).
 */
export function launchTargetMark(
  at: { readonly sim: SimView; readonly alpha: number }, kind: LaunchTargetKind, id: number, out: LaunchMark,
): LaunchMark {
  out.radius = -1;
  const alpha = at.alpha;
  if (kind === 'seed') {
    const s = at.sim.projectiles[id] as ProjectileView | undefined;
    if (!s || !s.active) return out;
    out.x = s.prevX + (s.x - s.prevX) * alpha;
    out.y = s.prevY + (s.y - s.prevY) * alpha;
    out.radius = s.radius + LAUNCH_FX.seedPad;
  } else if (kind === 'enemy') {
    const e = at.sim.enemies[id] as EnemyView | undefined;
    if (!e) return out;
    out.x = e.prevX + (e.x - e.prevX) * alpha;
    out.y = e.prevY + (e.y - e.prevY) * alpha - e.height / 2;
    out.radius = (e.width > e.height ? e.width : e.height) / 2 + LAUNCH_FX.enemyPad;
  }
  return out;
}

/** PoseBuffer slots. */
const S_RING = 0;
const S_RING_TWIN = 1;
const S_ARROW = 2;
const S_ARROW_TWIN = 3;
const S_BURST = 4;
const S_BURST_TWIN = 5;
const S_FIZZLE = 6;
const SLOTS = 7;

/**
 * Spirit Launch marks (§5.5), on the real clock: a thin pulsing spirit-glow ring on the launch candidate
 * (only once unlocked) that follows the candidate's interpolated position; while aiming it locks and
 * tightens on the target (further as the aim timer runs out) and an aim arrow (≈ 90 u) leaves the hero
 * along the aim. On release a light ring bursts where the LaunchAim held (from the event, never the
 * LaunchView a later grab in the same frame overwrote); a LaunchFizzle flickers a small ring out.
 * Sprites live in the entity `seeds` layer (one batch with the seeds) with twins in the glow slot. With
 * nothing to show, every sprite is parked (alpha 0, zero area) and the update returns before touching
 * anything; otherwise only changed values reach Pixi (PoseBuffer, §6).
 */
export class LaunchRenderer implements EntityRenderer {
  readonly ring: Sprite;
  readonly ringTwin: Sprite;
  readonly arrow: Sprite;
  readonly arrowTwin: Sprite;
  readonly burst: Sprite;
  readonly burstTwin: Sprite;
  readonly fizzle: Sprite;
  private readonly poses = new PoseBuffer();
  private readonly ringImg: EntityImage;
  private readonly twinImg: EntityImage;
  private readonly arrowImg: EntityImage;
  private readonly mark: LaunchMark = { x: 0, y: 0, radius: -1 };
  private readonly arrowScale: number;
  private ringAlpha = 0;
  private ringRadius = 0;
  private ringSpin = 0;
  private lock = 0;
  private appear = 1;
  private kind: LaunchTargetKind = 'none';
  private id = -1;
  private arrowAlpha = 0;
  private arrowAngle = 0;
  private aimX = Number.NaN;
  private aimY = Number.NaN;
  private burstAt = -1;
  private fizzleAt = -1;
  /** A release burst / fizzle is playing (flags, so the idle check reads no fractional numbers). */
  private burstLive = false;
  private fizzleLive = false;
  /** True once every sprite is parked (nothing showing, nothing fading). */
  private parked = true;
  /** Centre of the last release burst (the preceding LaunchAim's target centre). */
  readonly burstCentre = { x: Number.NaN, y: Number.NaN };
  private fizzleX = 0;
  private fizzleY = 0;

  constructor(layers: EntityLayers, textures: EntityTextures) {
    const ring = textures.get('launchRing');
    const twin = textures.get('ring');
    const arrow = textures.get('aimArrow');
    this.ringImg = ring;
    this.twinImg = twin;
    this.arrowImg = arrow;
    this.arrowScale = 1 / arrow.frame.density;
    // Everything starts parked: alpha 0 and zero area (an alpha-0 quad still costs its fill).
    this.burst = radialSprite(ring, layers.seeds, 0, LAUNCH_FX.tint, 0);
    this.fizzle = radialSprite(ring, layers.seeds, 0, LAUNCH_FX.tint, 0);
    this.ring = radialSprite(ring, layers.seeds, 0, LAUNCH_FX.tint, 0);
    this.arrow = imageSprite(arrow, layers.seeds, LAUNCH_FX.tint, 0);
    this.ringTwin = radialSprite(twin, layers.seedGlow, 0, LAUNCH_FX.tint, 0);
    this.arrowTwin = imageSprite(arrow, layers.seedGlow, LAUNCH_FX.tint, 0);
    this.burstTwin = radialSprite(twin, layers.seedGlow, 0, LAUNCH_FX.tint, 0);
    this.arrow.scale.set(0);
    this.arrowTwin.scale.set(0);
    const poses = this.poses;
    poses.add(this.ring);
    poses.add(this.ringTwin);
    poses.add(this.arrow);
    poses.add(this.arrowTwin);
    poses.add(this.burst);
    poses.add(this.burstTwin);
    poses.add(this.fizzle);
  }

  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    switch (e.type) {
      case SimEventType.LaunchAim:
        this.aimX = e.x;
        this.aimY = e.y;
        break;
      case SimEventType.Launch:
        this.burstCentre.x = Number.isNaN(this.aimX) ? frame.sim.launch.targetX : this.aimX;
        this.burstCentre.y = Number.isNaN(this.aimY) ? frame.sim.launch.targetY : this.aimY;
        this.burstAt = frame.time;
        this.burstLive = true;
        this.parked = false;
        break;
      case SimEventType.LaunchFizzle:
        this.fizzleX = e.x;
        this.fizzleY = e.y;
        this.fizzleAt = frame.time;
        this.fizzleLive = true;
        this.parked = false;
        break;
      case SimEventType.Respawned:
      case SimEventType.Reset:
      case SimEventType.Teleported:
        this.aimX = Number.NaN;
        this.aimY = Number.NaN;
        this.ringAlpha = 0;
        this.arrowAlpha = 0;
        this.kind = 'none';
        break;
      default:
        break;
    }
  }

  update(frame: FrameInfo, stats: RenderStats | null): void {
    const sim = frame.sim;
    const L = sim.launch;
    const p = sim.player;
    const aiming = p.mode === 'launchAim' && L.targetKind !== 'none';
    let kind: LaunchTargetKind = 'none';
    let id = -1;
    if (aiming) {
      kind = L.targetKind;
      id = L.targetId;
    } else if (L.unlocked && p.alive && L.candidateKind !== 'none') {
      kind = L.candidateKind;
      id = L.candidateId;
    }
    // Nothing to mark and nothing fading: every sprite is parked, so touch nothing.
    if (this.parked && kind === 'none' && !this.burstLive && !this.fizzleLive) {
      this.kind = 'none';
      this.id = -1;
      return;
    }
    const time = frame.time;
    if (this.burstLive && time - this.burstAt >= LAUNCH_FX.burstTime) this.burstLive = false;
    if (this.fizzleLive && time - this.fizzleAt >= LAUNCH_FX.fizzleTime) this.fizzleLive = false;
    const burstLive = this.burstLive;
    const fizzleLive = this.fizzleLive;
    const dt = frame.dt;
    const t = time % 3600;
    const w = this.poses.want;
    const m = launchTargetMark(frame, kind, id, this.mark);
    const show = m.radius > 0;
    if (show && (kind !== this.kind || id !== this.id)) {
      // A new target: snap there and scale in, so the ring never slides between targets.
      this.kind = kind;
      this.id = id;
      this.appear = 0;
      this.ringRadius = m.radius;
    }
    if (!show) {
      this.kind = 'none';
      this.id = -1;
    }
    this.ringAlpha = show ? Math.min(1, this.ringAlpha + dt / LAUNCH_FX.fadeIn) : Math.max(0, this.ringAlpha - dt / LAUNCH_FX.fadeOut);
    this.appear = Math.min(1, this.appear + dt / 0.14);
    this.lock = aiming ? Math.min(1, this.lock + dt / LAUNCH_FX.lockTime) : Math.max(0, this.lock - dt / LAUNCH_FX.lockTime);
    const lock = this.lock * this.lock * (3 - 2 * this.lock);
    let timer = 0;
    if (aiming && L.aimMaxTicks > 0) {
      timer = (L.aimTicks + frame.alpha) / L.aimMaxTicks;
      timer = timer < 0 ? 0 : timer > 1 ? 1 : timer;
    }
    const pulse = Math.sin(t * Math.PI * 2 * LAUNCH_FX.pulseHz);

    // The ring (and its twin): locked and tightened while aiming, flickering as the auto-release nears.
    if (show) {
      const target = m.radius * (1 + LAUNCH_FX.pulse * pulse * (1 - lock)) * (1 - (1 - LAUNCH_FX.lockTighten) * lock - LAUNCH_FX.timerTighten * timer);
      const next = this.ringRadius + (target - this.ringRadius) * (1 - Math.exp(-24 * dt));
      this.ringRadius = Math.abs(target - next) < 1e-4 ? target : next;
    }
    const ro = S_RING * POSE_STRIDE;
    const rt = S_RING_TWIN * POSE_STRIDE;
    if (this.ringAlpha > 0) {
      const ap = this.appear;
      const appear = 1 + 0.35 * (1 - ap * ap * (3 - 2 * ap));
      const warn = timer > 0.7 ? 0.82 + 0.18 * Math.sin(t * (30 + 50 * timer)) : 1;
      const alpha = this.ringAlpha * (0.6 + 0.16 * pulse * (1 - lock) + 0.4 * lock) * warn;
      this.ringSpin = (this.ringSpin + dt * (0.9 + 2.6 * lock)) % (Math.PI * 2);
      const r = this.ringRadius * appear;
      w[ro + PX] = m.x;
      w[ro + PY] = m.y;
      w[ro + PROT] = this.ringSpin;
      w[ro + PSX] = (2 * r) / RING_LINE / this.ringImg.frame.w;
      w[ro + PSY] = w[ro + PSX] as number;
      w[ro + PALPHA] = alpha;
      w[rt + PX] = m.x;
      w[rt + PY] = m.y;
      w[rt + PROT] = this.ringSpin;
      w[rt + PSX] = (2 * r) / 0.82 / this.twinImg.frame.w;
      w[rt + PSY] = w[rt + PSX] as number;
      w[rt + PALPHA] = alpha * 0.75;
    } else {
      this.poses.park(S_RING);
      this.poses.park(S_RING_TWIN);
    }

    // Aim arrow from the hero's centre along the (smoothed) aim.
    const goal = Math.atan2(L.aimY, L.aimX);
    if (aiming && this.arrowAlpha <= 0) {
      this.arrowAngle = goal;
    } else if (aiming) {
      let d = goal - this.arrowAngle;
      d -= Math.PI * 2 * Math.round(d / (Math.PI * 2));
      this.arrowAngle = Math.abs(d) < 1e-5 ? goal : this.arrowAngle + d * (1 - Math.exp(-30 * dt));
    }
    this.arrowAlpha = aiming ? Math.min(1, this.arrowAlpha + dt / LAUNCH_FX.fadeIn) : Math.max(0, this.arrowAlpha - dt / 0.1);
    const ao = S_ARROW * POSE_STRIDE;
    const at = S_ARROW_TWIN * POSE_STRIDE;
    if (this.arrowAlpha > 0) {
      const px = p.prevX + (p.x - p.prevX) * frame.alpha;
      const py = p.prevY + (p.y - p.prevY) * frame.alpha - p.height / 2;
      const ca = Math.cos(this.arrowAngle);
      const sa = Math.sin(this.arrowAngle);
      const fa = this.arrowAlpha;
      const reach = 0.9 + 0.1 * fa * fa * (3 - 2 * fa) + 0.05 * timer;
      w[ao + PX] = px + ca * LAUNCH_FX.arrowStart;
      w[ao + PY] = py + sa * LAUNCH_FX.arrowStart;
      w[ao + PROT] = this.arrowAngle;
      w[ao + PSX] = this.arrowScale * reach;
      w[ao + PSY] = this.arrowScale;
      w[ao + PALPHA] = fa * (0.85 + 0.15 * Math.sin(t * 7));
      w[at + PX] = w[ao + PX] as number;
      w[at + PY] = w[ao + PY] as number;
      w[at + PROT] = this.arrowAngle;
      w[at + PSX] = this.arrowScale * reach;
      w[at + PSY] = this.arrowScale * 1.6;
      w[at + PALPHA] = (w[ao + PALPHA] as number) * 0.7;
    } else {
      this.poses.park(S_ARROW);
      this.poses.park(S_ARROW_TWIN);
    }

    // Release burst: a ring of light expanding from the aim target.
    const bo = S_BURST * POSE_STRIDE;
    const bt = S_BURST_TWIN * POSE_STRIDE;
    if (burstLive) {
      const k = (time - this.burstAt) / LAUNCH_FX.burstTime;
      const e = 1 - (1 - k) * (1 - k) * (1 - k);
      const r = LAUNCH_FX.burstFrom + (LAUNCH_FX.burstTo - LAUNCH_FX.burstFrom) * e;
      w[bo + PX] = this.burstCentre.x;
      w[bo + PY] = this.burstCentre.y;
      w[bo + PROT] = -k * 1.5;
      w[bo + PSX] = (2 * r) / RING_LINE / this.ringImg.frame.w;
      w[bo + PSY] = w[bo + PSX] as number;
      w[bo + PALPHA] = (1 - k) * (1 - k);
      w[bt + PX] = this.burstCentre.x;
      w[bt + PY] = this.burstCentre.y;
      w[bt + PSX] = (2 * r) / 0.82 / this.twinImg.frame.w;
      w[bt + PSY] = w[bt + PSX] as number;
      w[bt + PALPHA] = (1 - k) * (1 - k) * 0.9;
    } else {
      this.poses.park(S_BURST);
      this.poses.park(S_BURST_TWIN);
    }

    // Fizzle: a small ring gutters out at the hero's centre.
    const fo = S_FIZZLE * POSE_STRIDE;
    if (fizzleLive) {
      const k = (time - this.fizzleAt) / LAUNCH_FX.fizzleTime;
      w[fo + PX] = this.fizzleX;
      w[fo + PY] = this.fizzleY;
      w[fo + PSX] = (2 * (26 - 12 * k)) / RING_LINE / this.ringImg.frame.w;
      w[fo + PSY] = w[fo + PSX] as number;
      w[fo + PALPHA] = 0.55 * (1 - k) * (Math.sin(t * 70) > 0 ? 1 : 0.35);
    } else {
      this.poses.park(S_FIZZLE);
    }
    this.poses.flush(0, SLOTS);
    this.parked = this.ringAlpha <= 0 && this.arrowAlpha <= 0 && !burstLive && !fizzleLive;

    if (stats) {
      // Scene quads (parked ones have zero area; twins land in the smaller glow buffer).
      const ring = this.ringImg.frame;
      const arrow = this.arrowImg.frame;
      const area = (w[ro + PSX] as number) * (w[ro + PSY] as number) * ring.w * ring.h
        + (w[ao + PSX] as number) * (w[ao + PSY] as number) * arrow.w * arrow.h
        + (w[bo + PSX] as number) * (w[bo + PSY] as number) * ring.w * ring.h
        + (w[fo + PSX] as number) * (w[fo + PSY] as number) * ring.w * ring.h;
      stats.fillScreens += area / Math.max(1, frame.camera.width * frame.camera.height);
    }
  }
}
