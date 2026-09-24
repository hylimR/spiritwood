import type { Sprite } from 'pixi.js';
import type { RenderStats } from '../../contracts/debug.ts';
import type { EnemyDef, SpitterDef } from '../../contracts/level.ts';
import type { FrameInfo } from '../../contracts/render.ts';
import { SimEventType, type EnemyMode, type EnemyView, type ProjectileView, type SimEvent } from '../../contracts/sim.ts';
import { PALETTE } from '../../config.ts';
import { mixHex } from '../../core/color.ts';
import { smoothstep } from '../../core/math.ts';
import {
  idPhase, imageSprite, InstanceGroup, nearView, PALPHA, POSE_STRIDE, PoseBuffer, PROT, PSX, PSY, PTINT, PX, PY, radialSprite,
  type EntityImage, type EntityLayers, type EntityRenderer, type EntityTextures,
} from './kit.ts';
import { ANCHOR_ART, ANCHOR_STALK_LENGTH, SPITTER_ART } from './spitterArt.ts';

/** Muzzle height above the feet: mirrors WorldTuning.spitterMuzzleHeight (§5.3); SimView has no muzzle field. */
export const SPITTER_MUZZLE_HEIGHT = -(SPITTER_ART.stemBaseY - SPITTER_ART.stemLength + SPITTER_ART.mouthY);

export const SPITTER = Object.freeze({
  /** Bulb light at rest, while stunned, and the flash right after a shot (decays over `flashTime` s). */
  idleGlow: 0.18,
  stunGlow: 0.03,
  flashGlow: 0.85,
  flashTime: 0.16,
  /** Bulb swelling at the end of the windup (scale +x, +y). */
  swellX: 0.17,
  swellY: 0.11,
  /** Re-form bloom length (s) and strength. */
  bloomTime: 0.6,
  /** Recoil spring (per s², per s) and its kick. */
  recoilStiffness: 190,
  recoilDamping: 11,
  recoilKick: 1,
  /** Stem bend (rad) and bulb hang (rad) at full droop; leaves sag this far. */
  droopStem: 0.95,
  droopBulb: 0.65,
  droopLeaf: 0.5,
  /** Lean toward the aim (rad, max). */
  maxLean: 0.2,
  /** Facing turns at this many scale units per second. */
  turnRate: 7,
  stunTint: 0x857f96,
  backLeafTint: 0x9a93a8,
  haloRadius: 44,
  cullMargin: 120,
  /** Fill estimate (u²) of the body and light quads (roots, stem, bulb and its light, leaves), halo aside. */
  bodyFill: 8200,
});

/** Render pose of one spitter (pure data, see spitterPose). */
export interface SpitterPose {
  /** 0..1: the bulb draws breath over the windup. */
  swell: number;
  /** 0..1+: light in the bulb's seams and mouth. */
  glow: number;
  /** 0..1: stunned droop target. */
  droop: number;
  /** 0..1: the re-form bloom pulse. */
  bloom: number;
  /** 0..1: the shiver right before a shot or a re-form. */
  shiver: number;
}

export function createSpitterPose(): SpitterPose {
  return { swell: 0, glow: SPITTER.idleGlow, droop: 0, bloom: 0, shiver: 0 };
}

/**
 * Inputs (and an anchor's charge) of a pose evaluation, kept in an object so the view passes no
 * fractional numbers through calls (§6).
 */
interface PoseInput {
  progress: number;
  sinceShot: number;
  sinceReform: number;
  charge: number;
}

const scratchInput: PoseInput = { progress: 0, sinceShot: -1, sinceReform: -1, charge: 0 };

/**
 * The pose a spitter's mode implies. `progress` = modeTicks / modeDuration (interpolated), `sinceShot`
 * and `sinceReform` are world seconds since the last SeedFired / re-form (< 0 = never). Pure.
 */
export function spitterPose(mode: EnemyMode, progress: number, sinceShot: number, sinceReform: number, out: SpitterPose): SpitterPose {
  scratchInput.progress = progress;
  scratchInput.sinceShot = sinceShot;
  scratchInput.sinceReform = sinceReform;
  return evalPose(mode, scratchInput, out);
}

/** The pose for `input` (smoothsteps inlined: no fractional number comes back through a call, §6). */
function evalPose(mode: EnemyMode, input: PoseInput, out: SpitterPose): SpitterPose {
  const p = input.progress < 0 ? 0 : input.progress > 1 ? 1 : input.progress;
  out.swell = 0;
  out.droop = 0;
  out.shiver = 0;
  out.glow = SPITTER.idleGlow;
  if (mode === 'windup') {
    out.swell = p * p;
    out.glow = SPITTER.idleGlow + (1 - SPITTER.idleGlow) * Math.pow(p, 1.25);
    const u = p < 0.72 ? 0 : (p - 0.72) / 0.28;
    out.shiver = u * u * (3 - 2 * u);
  } else if (mode === 'stunned') {
    const d = p > 0.1 ? 1 : p / 0.1;
    out.droop = d * d * (3 - 2 * d);
    out.glow = SPITTER.stunGlow;
    // It stirs as the stun runs out.
    const u = p < 0.82 ? 0 : (p - 0.82) / 0.18;
    out.shiver = u * u * (3 - 2 * u) * 0.6;
  }
  if (mode !== 'stunned' && input.sinceShot >= 0) out.glow += SPITTER.flashGlow * Math.exp(-input.sinceShot / SPITTER.flashTime);
  const sr = input.sinceReform;
  const b = sr >= 0 && sr < SPITTER.bloomTime ? sr / SPITTER.bloomTime : 1;
  out.bloom = b < 1 ? Math.sin(Math.PI * Math.min(1, b * 1.6)) * (1 - b) : 0;
  out.glow += out.bloom * 0.7;
  return out;
}

/**
 * Anchor (fixed-aim) spitters (§5.5): a seed-pod stalk whose ring grooves light in turn over its cycle,
 * base to tip — slowly through the cooldown, quickly through the windup — so the shot's rhythm reads
 * at a glance; the top ring lights just before the seed leaves the tip.
 */
export const ANCHOR = Object.freeze({
  /** Charge at rest (inactive), where the windup starts, and each ring's threshold (base → tip). */
  idleCharge: 0.12,
  windupFrom: 0.55,
  ringFrom: 0.08,
  ringStep: 0.19,
  /** Every ring keeps at least this glow, so an anchor's bands read even at rest. */
  ringEmber: 0.14,
  /** Shot flash decay (s), recoil squash along the pod, the halo's radius. */
  flashTime: 0.14,
  squash: 0.12,
  haloRadius: 34,
  /** The root mound is drawn this much narrower than the bulb spitter's. */
  rootsWidth: 0.78,
  /** Fill estimate (u²) of an anchor's body quads: roots, stalk, pod and leaves. */
  bodyFill: 3800,
});

/**
 * An anchor's charge over its cycle (0 … 1): it refills slowly through the cooldown and climbs through
 * the windup to 1 at the shot. `progress` = modeTicks / modeDuration. Pure.
 */
export function anchorCharge(mode: EnemyMode, progress: number): number {
  scratchInput.progress = progress;
  chargeInto(mode, scratchInput);
  return scratchInput.charge;
}

function chargeInto(mode: EnemyMode, io: PoseInput): void {
  const p = io.progress < 0 ? 0 : io.progress > 1 ? 1 : io.progress;
  if (mode === 'windup') {
    io.charge = ANCHOR.windupFrom + (1 - ANCHOR.windupFrom) * Math.pow(p, 1.3);
  } else if (mode === 'cooldown') {
    let u = (p - 0.15) / 0.85;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    io.charge = ANCHOR.windupFrom * u * u * (3 - 2 * u);
  } else {
    io.charge = ANCHOR.idleCharge;
  }
}

/**
 * Light of ring k (0 = base … 4 = tip) at `charge`: an ember that always marks the bands, then each ring
 * lights as the charge passes it, brighter as it climbs. Pure.
 */
export function anchorRingLevel(k: number, charge: number): number {
  scratchInput.charge = charge;
  ringLevelsInto(scratchInput, scratchRings);
  return scratchRings[k] as number;
}

const scratchRings = new Float64Array(8);

/** Every ring's light (see anchorRingLevel) at `io.charge`, into `out`. */
function ringLevelsInto(io: PoseInput, out: Float64Array): void {
  const c = io.charge;
  const bright = 0.45 + 0.55 * c;
  for (let k = 0; k < RINGS; k++) {
    let u = (c - (ANCHOR.ringFrom + ANCHOR.ringStep * k - 0.04)) / 0.16;
    u = u < 0 ? 0 : u > 1 ? 1 : u;
    out[k] = ANCHOR.ringEmber + (1 - ANCHOR.ringEmber) * u * u * (3 - 2 * u) * bright;
  }
}

interface LeafSlot {
  /** PoseBuffer slots of the leaf and its occluder copy. */
  slot: number;
  occ: number;
  x: number;
  y: number;
  angle: number;
  scale: number;
  /** +1 when the leaf points right (droops clockwise), −1 when it points left. */
  side: number;
  phase: number;
  /** Base tint, and the tint for the current stun mix. */
  tint: number;
  tintNow: number;
}

/** PoseBuffer slots of a spitter, from its first. */
const S_HALO = 0;
const S_STEM = 1;
const S_OCC_STEM = 2;
const S_BULB = 3;
const S_OCC_BULB = 4;
const S_ROOTS = 5;
const S_OCC_ROOTS = 6;
const S_GLOW = 7;
const S_TWIN = 8;
const S_MOUTH = 9;
/** Anchors (whose S_STEM is the stalk, S_BULB the pod, S_GLOW the mouth light, S_TWIN the pod's twin) add their rings. */
const S_RINGS = 10;
const RINGS = ANCHOR_ART.rings.length;

interface SpitterState {
  enemy: number;
  def: SpitterDef | null;
  /** A fixed-aim anchor (a pod on a stalk, pointing along aimX/aimY) rather than a player-aimed bulb. */
  anchor: boolean;
  aimX: number;
  aimY: number;
  /** Rotation that turns the pod (drawn pointing up) onto the aim. */
  aimAngle: number;
  group: InstanceGroup;
  first: number;
  count: number;
  leaves: LeafSlot[];
  facing: number;
  lean: number;
  droop: number;
  recoil: number;
  recoilVel: number;
  /** Local-space horizontal direction of the last shot (−1..1), for the recoil tilt. */
  recoilDir: number;
  shotAt: number;
  reformAt: number;
  hitAt: number;
  lastMode: EnemyMode;
  phase: number;
  /** Quantised stun tint mix (−1 = not yet set) and its body tint. */
  tintK: number;
  tint: number;
  initialised: boolean;
}

const NEVER = -1;
/** Below these a spring or a damped value has settled (snapped, so a still plant writes nothing). */
const SETTLED = 1e-5;

/**
 * Thorn Spitters (§5.5): a rooted bulb plant built from SDF parts in the entity atlas — roots, a thorned
 * stem, a bract-scaled bulb and a rosette of thorny leaves — drawn in the entity body batch, with its
 * rose light in the emissive layer and a dark occluder plus light twin in the glow slot. The bulb swells
 * and glows over the windup (modeTicks / modeDuration), recoils on SeedFired, droops and dims while
 * stunned and re-forms with a small bloom. The body faces `facing` and leans a little toward its aim.
 * Everything runs on the world clock; only changed values reach Pixi (PoseBuffer, §6).
 */
export class SpitterRenderer implements EntityRenderer {
  private readonly items: SpitterState[] = [];
  /** Enemy index → item index (−1 for other kinds). */
  private readonly byEnemy: Int32Array;
  private readonly pose = createSpitterPose();
  private readonly poseInput: PoseInput = { progress: 0, sinceShot: -1, sinceReform: -1, charge: 0 };
  private readonly poses = new PoseBuffer();
  private readonly stemScale: number;
  private readonly bulbScale: number;
  private readonly leafScale: number;
  private readonly stalkScale: number;
  private readonly podScale: number;
  private readonly rootsScale: number;
  private readonly glowImg: EntityImage;
  private readonly ringImg: EntityImage;
  /** World time (mod 3600) of the current update, for posePlant / posePod. */
  private t = 0;
  /** The current anchor's seconds since its shot and ring lights (for posePod). */
  private sinceShot = -1;
  private readonly ringLight = new Float64Array(8);
  private hitFlash = 0;

  /**
   * `enemies` in SimView order: the level's EnemyDefs (or anything with a `kind` for tests). A spitter
   * whose def aims `fixed` is an anchor; the ids match SimView.enemies.
   */
  constructor(layers: EntityLayers, textures: EntityTextures, enemies: readonly (EnemyDef | { kind: string })[]) {
    const roots = textures.get('spitterRoots');
    const stem = textures.get('spitterStem');
    const bulb = textures.get('spitterBulb');
    const bulbGlow = textures.get('spitterBulbGlow');
    const leaf = textures.get('spitterLeaf');
    const glow = textures.get('glow');
    const stalk = textures.get('anchorStalk');
    const pod = textures.get('anchorPod');
    const ring = textures.get('anchorRing');
    this.glowImg = glow;
    this.ringImg = ring;
    this.stemScale = 1 / stem.frame.density;
    this.bulbScale = 1 / bulb.frame.density;
    this.leafScale = 1 / leaf.frame.density;
    this.stalkScale = 1 / stalk.frame.density;
    this.podScale = 1 / pod.frame.density;
    this.rootsScale = 1 / roots.frame.density;
    this.byEnemy = new Int32Array(enemies.length).fill(-1);
    for (let i = 0; i < enemies.length; i++) {
      const enemy = enemies[i] as EnemyDef | { kind: string };
      if (enemy.kind !== 'thornSpitter') continue;
      const def = 'aim' in enemy ? (enemy as SpitterDef) : null;
      const anchor = def !== null && def.aim === 'fixed';
      const layout = anchor ? ANCHOR_ART.leaves : SPITTER_ART.leaves;
      const group = new InstanceGroup(layers, true);
      const occ = group.occluder as NonNullable<InstanceGroup['occluder']>;
      const halo = radialSprite(glow, group.back, anchor ? ANCHOR.haloRadius : SPITTER.haloRadius, PALETTE.thorns, 0);
      const leafSprites: [Sprite, Sprite, number][] = [];
      const addLeaf = (k: number): void => {
        const l = layout[k] as (typeof layout)[number];
        leafSprites.push([imageSprite(leaf, group.body, l.back ? SPITTER.backLeafTint : 0xffffff), imageSprite(leaf, occ, 0x000000, 0.92), k]);
      };
      for (let k = 0; k < layout.length; k++) if ((layout[k] as { back: boolean }).back) addLeaf(k);
      // Body, back to front: stem (anchor: stalk), bulb (anchor: pod), roots; each with its occluder copy.
      const occStem = imageSprite(anchor ? stalk : stem, occ, 0x000000, 0.92);
      const stemSprite = imageSprite(anchor ? stalk : stem, group.body);
      const occBulb = imageSprite(anchor ? pod : bulb, occ, 0x000000, 0.92);
      const bulbSprite = imageSprite(anchor ? pod : bulb, group.body);
      const occRoots = imageSprite(roots, occ, 0x000000, 0.92);
      const rootsSprite = imageSprite(roots, group.body);
      for (let k = 0; k < layout.length; k++) if (!(layout[k] as { back: boolean }).back) addLeaf(k);
      // Light: the bulb's seams (anchor: the mouth light), its twin (anchor: the pod's), the mouth's twin.
      const glowSprite = anchor ? radialSprite(glow, group.front, 8, PALETTE.thorns, 0) : imageSprite(bulbGlow, group.front, 0xffffff, 0);
      const twin = anchor ? radialSprite(glow, group.glow, 16, PALETTE.thorns, 0) : imageSprite(bulbGlow, group.glow, 0xffffff, 0);
      const mouthTwin = radialSprite(glow, group.glow, 16, PALETTE.thorns, 0);

      const poses = this.poses;
      const first = poses.add(halo);
      poses.add(stemSprite);
      poses.add(occStem);
      poses.add(bulbSprite);
      poses.add(occBulb);
      poses.add(rootsSprite);
      poses.add(occRoots);
      poses.add(glowSprite);
      poses.add(twin);
      poses.add(mouthTwin);
      if (anchor) for (let k = 0; k < RINGS; k++) poses.add(radialSprite(ring, group.front, 8, 0xffffff, 0));
      const leaves: LeafSlot[] = [];
      for (let j = 0; j < leafSprites.length; j++) {
        const [sprite, o, k] = leafSprites[j] as [Sprite, Sprite, number];
        const l = layout[k] as (typeof layout)[number];
        const tint = l.back ? SPITTER.backLeafTint : 0xffffff;
        leaves.push({
          slot: poses.add(sprite), occ: poses.add(o), x: l.x, y: l.y, angle: l.angle, scale: l.scale,
          side: Math.cos(l.angle) >= 0 ? 1 : -1, phase: idPhase(i, 11 + k), tint, tintNow: tint,
        });
      }
      let aimX = 0;
      let aimY = -1;
      if (anchor && def) {
        const len = Math.sqrt(def.fixedVx * def.fixedVx + def.fixedVy * def.fixedVy);
        if (len > 1e-6) {
          aimX = def.fixedVx / len;
          aimY = def.fixedVy / len;
        }
      }
      this.byEnemy[i] = this.items.length;
      this.items.push({
        enemy: i, def, anchor, aimX, aimY, aimAngle: Math.atan2(aimX, -aimY), group, first, count: poses.size - first, leaves,
        facing: 1, lean: 0, droop: 0, recoil: 0, recoilVel: 0, recoilDir: 0, shotAt: NEVER, reformAt: NEVER, hitAt: NEVER,
        lastMode: 'idle', phase: idPhase(i, 5), tintK: -1, tint: 0xffffff, initialised: false,
      });
    }
  }

  /** True when enemy `enemy` is drawn as an anchor (fixed aim: a pod on a stalk). */
  isAnchor(enemy: number): boolean {
    const it = this.items[this.itemFor(enemy)];
    return it !== undefined && it.anchor;
  }

  /** Item for an enemy index (tests and the debug draw). */
  itemFor(enemy: number): number {
    return enemy >= 0 && enemy < this.byEnemy.length ? (this.byEnemy[enemy] as number) : -1;
  }

  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    switch (e.type) {
      case SimEventType.SeedFired: {
        const it = this.shooter(e, frame);
        if (!it) return;
        it.shotAt = frame.worldTime;
        it.recoil = SPITTER.recoilKick;
        it.recoilVel = 0;
        const speed = Math.sqrt(e.a * e.a + e.b * e.b);
        it.recoilDir = speed > 1e-6 ? (e.a / speed) * it.facing : 0;
        break;
      }
      case SimEventType.EnemyReformed: {
        const it = this.items[this.itemFor(e.id)];
        if (it) it.reformAt = frame.worldTime;
        break;
      }
      case SimEventType.EnemyHit: {
        const it = this.items[this.itemFor(e.id)];
        if (it) it.hitAt = frame.worldTime;
        break;
      }
      case SimEventType.Respawned:
      case SimEventType.Reset:
      case SimEventType.Teleported:
        for (let i = 0; i < this.items.length; i++) (this.items[i] as SpitterState).initialised = false;
        break;
      default:
        break;
    }
  }

  /** The spitter that fired seed e.id: its sourceId, else the spitter whose muzzle is nearest the seed. */
  private shooter(e: SimEvent, frame: FrameInfo): SpitterState | null {
    const seed = frame.sim.projectiles[e.id] as ProjectileView | undefined;
    const bySource = seed ? this.items[this.itemFor(seed.sourceId)] : undefined;
    if (bySource) return bySource;
    let best: SpitterState | null = null;
    let bestD = 80;
    const enemies = frame.sim.enemies;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i] as SpitterState;
      const en = enemies[it.enemy] as EnemyView;
      const dx = en.x - e.x;
      const dy = en.y - SPITTER_MUZZLE_HEIGHT - e.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestD) {
        bestD = d;
        best = it;
      }
    }
    return best;
  }

  update(frame: FrameInfo, stats: RenderStats | null): void {
    if (this.items.length === 0) return;
    const enemies = frame.sim.enemies;
    const cam = frame.camera;
    const dt = frame.worldDt;
    this.t = frame.worldTime % 3600;
    const wt = frame.worldTime;
    const a = frame.sim.frozen ? 0 : frame.alpha;
    const p = frame.sim.player;
    let fill = 0;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i] as SpitterState;
      const en = enemies[it.enemy] as EnemyView | undefined;
      if (!en) continue;
      const x = en.prevX + (en.x - en.prevX) * frame.alpha;
      const y = en.prevY + (en.y - en.prevY) * frame.alpha;
      if (!it.initialised) {
        it.initialised = true;
        it.facing = en.facing;
        it.lean = 0;
        it.droop = en.mode === 'stunned' ? 1 : 0;
        it.recoil = 0;
        it.recoilVel = 0;
        it.shotAt = NEVER;
        it.reformAt = NEVER;
        it.hitAt = NEVER;
        it.lastMode = en.mode;
      }
      // A re-form seen without its event (e.g. the stun ran out between frames) still blooms.
      if (it.lastMode === 'stunned' && en.mode !== 'stunned' && (it.reformAt < 0 || wt - it.reformAt > SPITTER.bloomTime)) it.reformAt = wt;
      it.lastMode = en.mode;
      it.facing = en.facing > it.facing
        ? Math.min(en.facing, it.facing + SPITTER.turnRate * dt)
        : Math.max(en.facing, it.facing - SPITTER.turnRate * dt);
      if (it.recoil !== 0 || it.recoilVel !== 0) {
        const sdt = dt < 1 / 30 ? dt : 1 / 30;
        it.recoilVel += (-it.recoil * SPITTER.recoilStiffness - it.recoilVel * SPITTER.recoilDamping) * sdt;
        it.recoil += it.recoilVel * sdt;
        if (Math.abs(it.recoil) < SETTLED && Math.abs(it.recoilVel) < SETTLED * 10) {
          it.recoil = 0;
          it.recoilVel = 0;
        }
      }

      const visible = nearView(cam, x, y - 32, 48, SPITTER.cullMargin);
      it.group.setVisible(visible);
      if (!visible) continue;
      // An anchor never turns: its pod points along its fixed aim in world space.
      const turn = it.anchor ? 1 : (it.facing < 0 ? -1 : 1) * (0.35 + 0.65 * smoothstep(0, 1, Math.abs(it.facing)));
      it.group.place(x, y, turn, 1);

      const pin = this.poseInput;
      pin.progress = en.modeDuration > 0 ? (en.modeTicks + a) / en.modeDuration : 0;
      pin.sinceShot = it.shotAt < 0 ? -1 : wt - it.shotAt;
      this.sinceShot = pin.sinceShot;
      pin.sinceReform = it.reformAt < 0 ? -1 : wt - it.reformAt;
      const pose = evalPose(en.mode, pin, this.pose);
      this.hitFlash = it.hitAt >= 0 ? Math.exp(-(wt - it.hitAt) / 0.1) : 0;
      pose.glow += 0.9 * this.hitFlash;
      // Damped toward the pose (inline: no fractional numbers through calls, §6), snapped once settled.
      const droop = it.droop + (pose.droop - it.droop) * (1 - Math.exp(-(pose.droop > it.droop ? 9 : 5.5) * dt));
      it.droop = Math.abs(pose.droop - droop) < SETTLED ? pose.droop : droop;

      if (it.anchor) {
        chargeInto(en.mode, pin);
        this.posePod(it);
        // Body parts (roots, stalk, pod, leaves) plus the halo and mouth light quads as staged.
        const w = this.poses.want;
        const gw = this.glowImg.frame.w;
        const halo = (w[(it.first + S_HALO) * POSE_STRIDE + PSX] as number) * gw;
        const mouth = (w[(it.first + S_GLOW) * POSE_STRIDE + PSX] as number) * gw;
        fill += ANCHOR.bodyFill + halo * halo + mouth * mouth;
        continue;
      }
      // Lean toward the player while it cycles (a fixed-aim bulb, if a test builds one, leans along its aim).
      let leanTarget = 0;
      if (en.mode === 'windup' || en.mode === 'cooldown') {
        const def = it.def;
        let dx = 0;
        let dy = -1;
        if (def && def.aim === 'fixed') {
          dx = def.fixedVx;
          dy = def.fixedVy;
        } else if (p.alive) {
          dx = p.x - x;
          dy = p.y - p.height / 2 - (y - SPITTER_MUZZLE_HEIGHT);
        }
        leanTarget = Math.atan2(dx * (turn < 0 ? -1 : 1), -dy) * 0.3;
        leanTarget = leanTarget < -SPITTER.maxLean ? -SPITTER.maxLean : leanTarget > SPITTER.maxLean ? SPITTER.maxLean : leanTarget;
      }
      const lean = it.lean + (leanTarget - it.lean) * (1 - Math.exp(-4 * dt));
      it.lean = Math.abs(leanTarget - lean) < SETTLED ? leanTarget : lean;
      this.posePlant(it);
      const hw = (this.poses.want[(it.first + S_HALO) * POSE_STRIDE + PSX] as number) * this.glowImg.frame.w;
      fill += SPITTER.bodyFill + hw * hw;
    }
    if (stats && fill > 0) stats.fillScreens += fill / Math.max(1, cam.width * cam.height);
  }

  private posePlant(it: SpitterState): void {
    const pose = this.pose;
    const t = this.t;
    const w = this.poses.want;
    const f = it.first;
    const droop = it.droop;
    const r = it.recoil;
    const shiver = pose.shiver * (Math.sin(t * 61 + it.phase) * 0.6 + Math.sin(t * 37 + it.phase * 2) * 0.4);
    const breathe = Math.sin(t * 1.4 + it.phase) * 0.018;
    const stemRot = it.lean - r * 0.12 * it.recoilDir + droop * SPITTER.droopStem + shiver * 0.035 + breathe * 0.6;
    const stemY = SPITTER_ART.stemBaseY;
    // Stun tints are quantised to eighths: they change (and allocate a Pixi Color) at most eight times.
    const tintK = Math.round((droop < 0 ? 0 : droop > 1 ? 1 : droop) * 8) / 8;
    if (tintK !== it.tintK) {
      it.tintK = tintK;
      it.tint = mixHex(0xffffff, SPITTER.stunTint, tintK);
      for (let k = 0; k < it.leaves.length; k++) {
        const l = it.leaves[k] as LeafSlot;
        l.tintNow = mixHex(l.tint, SPITTER.stunTint, tintK);
      }
    }

    let o = (f + S_STEM) * POSE_STRIDE;
    w[o + PX] = 0;
    w[o + PY] = stemY;
    w[o + PROT] = stemRot;
    w[o + PSX] = this.stemScale * (1 + 0.06 * r);
    w[o + PSY] = this.stemScale * (1 - 0.08 * r);
    w[o + PTINT] = it.tint;
    const len = SPITTER_ART.stemLength * (1 - 0.08 * r);
    const bx = Math.sin(stemRot) * len;
    const by = stemY - Math.cos(stemRot) * len;
    const bulbRot = stemRot + droop * SPITTER.droopBulb - r * 0.1 * it.recoilDir + shiver * 0.05;
    const sx = 1 + SPITTER.swellX * pose.swell + 0.1 * pose.bloom + 0.12 * r + breathe;
    const sy = 1 + SPITTER.swellY * pose.swell + 0.08 * pose.bloom - 0.2 * r - breathe * 0.5;
    o = (f + S_BULB) * POSE_STRIDE;
    w[o + PX] = bx;
    w[o + PY] = by;
    w[o + PROT] = bulbRot;
    w[o + PSX] = this.bulbScale * sx;
    w[o + PSY] = this.bulbScale * sy;
    w[o + PTINT] = it.tint;
    this.poses.copyTransform(f + S_BULB, f + S_GLOW);
    this.poses.copyTransform(f + S_BULB, f + S_TWIN);
    const glow = pose.glow > 0 ? pose.glow : 0;
    const g1 = glow < 1 ? glow : 1;
    w[(f + S_GLOW) * POSE_STRIDE + PALPHA] = g1;
    w[(f + S_TWIN) * POSE_STRIDE + PALPHA] = glow * 0.9 < 1 ? glow * 0.9 : 1;
    // Mouth light and halo sit on the bulb, which is rotated about its neck.
    const mouth = -SPITTER_ART.mouthY * sy;
    const bs = Math.sin(bulbRot);
    const bc = Math.cos(bulbRot);
    o = (f + S_MOUTH) * POSE_STRIDE;
    w[o + PX] = bx + bs * mouth;
    w[o + PY] = by - bc * mouth;
    const mouthScale = (2 * (12 + 10 * g1)) / this.glowImg.frame.w;
    w[o + PSX] = mouthScale;
    w[o + PSY] = mouthScale;
    w[o + PALPHA] = glow * glow * 0.8 < 1 ? glow * glow * 0.8 : 1;
    o = (f + S_HALO) * POSE_STRIDE;
    w[o + PX] = bx + bs * 16 * sy;
    w[o + PY] = by - bc * 16 * sy;
    const haloScale = (2 * SPITTER.haloRadius * (0.75 + 0.45 * g1)) / this.glowImg.frame.w;
    w[o + PSX] = haloScale;
    w[o + PSY] = haloScale;
    w[o + PALPHA] = 0.34 * g1 * g1;
    w[(f + S_ROOTS) * POSE_STRIDE + PTINT] = it.tint;

    for (let k = 0; k < it.leaves.length; k++) {
      const l = it.leaves[k] as LeafSlot;
      const sway = Math.sin(t * 1.1 + l.phase) * 0.045 + Math.sin(t * 2.3 + l.phase * 1.7) * 0.015;
      // Windup tenses the leaves upward; a stun lets them sag; a shot shivers them.
      const tense = -l.side * 0.16 * pose.swell;
      const sag = l.side * SPITTER.droopLeaf * droop;
      o = l.slot * POSE_STRIDE;
      w[o + PX] = l.x;
      w[o + PY] = l.y;
      w[o + PROT] = l.angle + sway + tense + sag + shiver * 0.04 * l.side + r * 0.08 * l.side;
      w[o + PSX] = this.leafScale * l.scale * (1 + 0.05 * pose.bloom);
      w[o + PSY] = this.leafScale * l.scale;
      w[o + PTINT] = l.tintNow;
      this.poses.copyTransform(l.slot, l.occ);
    }
    this.poses.copyTransform(f + S_ROOTS, f + S_OCC_ROOTS);
    this.poses.copyTransform(f + S_STEM, f + S_OCC_STEM);
    this.poses.copyTransform(f + S_BULB, f + S_OCC_BULB);
    this.poses.flush(f, it.count);
  }

  /**
   * An anchor: the pod's tip (its mouth) on the muzzle, turned onto the fixed aim; the stalk reaches from
   * the root mound to the pod's neck. The rings light in turn with the cycle's charge, the pod squashes
   * toward its tip and the rings and mouth flash on the shot, then drain.
   */
  private posePod(it: SpitterState): void {
    const pose = this.pose;
    const t = this.t;
    const w = this.poses.want;
    const f = it.first;
    const r = it.recoil;
    const ax = it.aimX;
    const ay = it.aimY;
    const since = this.sinceShot;
    const flash = since >= 0 ? Math.exp(-since / ANCHOR.flashTime) : 0;
    // At rest (inactive) the pod breathes slowly; cycling, the charge carries the rhythm.
    const pin = this.poseInput;
    const breath = pin.charge === ANCHOR.idleCharge ? 0.05 * Math.sin(t * 1.1 + it.phase) : 0;
    const c = pin.charge + breath;
    pin.charge = c;
    ringLevelsInto(pin, this.ringLight);
    const ringLight = this.ringLight;
    const hit = this.hitFlash;
    const shiver = pose.shiver * (Math.sin(t * 61 + it.phase) * 0.6 + Math.sin(t * 37 + it.phase * 2) * 0.4);
    const podSx = this.podScale * (1 + 0.05 * c + 0.07 * r);
    const squash = 1 - ANCHOR.squash * r;
    const tipY = ANCHOR_ART.podTipY;

    let o = (f + S_BULB) * POSE_STRIDE;
    w[o + PX] = 0;
    w[o + PY] = tipY;
    w[o + PROT] = it.aimAngle + shiver * 0.03;
    w[o + PSX] = podSx;
    w[o + PSY] = this.podScale * squash;
    w[o + PTINT] = it.tint;
    // The stalk: from its base on the mound to the pod's neck (behind the tip, against the aim).
    const len = ANCHOR_ART.podLength * squash;
    const nx = -ax * len;
    const ny = tipY - ay * len;
    const dx = nx;
    const dy = ny - ANCHOR_ART.stalkBaseY;
    o = (f + S_STEM) * POSE_STRIDE;
    w[o + PX] = 0;
    w[o + PY] = ANCHOR_ART.stalkBaseY;
    w[o + PROT] = Math.atan2(dx, -dy);
    w[o + PSX] = this.stalkScale;
    w[o + PSY] = (this.stalkScale * Math.sqrt(dx * dx + dy * dy)) / ANCHOR_STALK_LENGTH;
    w[o + PTINT] = it.tint;
    // A narrower root mound under the upright stalk.
    o = (f + S_ROOTS) * POSE_STRIDE;
    w[o + PSX] = this.rootsScale * ANCHOR.rootsWidth;
    w[o + PTINT] = it.tint;
    // Rings in their grooves, down the pod from the tip.
    const rw = this.ringImg.frame.w;
    for (let k = 0; k < RINGS; k++) {
      const g = ANCHOR_ART.rings[k] as readonly [number, number];
      const d = g[0] * squash;
      o = (f + S_RINGS + k) * POSE_STRIDE;
      w[o + PX] = -ax * d;
      w[o + PY] = tipY - ay * d;
      w[o + PROT] = it.aimAngle;
      w[o + PSX] = (2.3 * g[1] * (1 + 0.05 * c + 0.07 * r)) / rw;
      w[o + PSY] = 3.4 / this.ringImg.frame.h;
      const lit = (ringLight[k] as number) + 0.8 * flash;
      w[o + PALPHA] = lit < 1 ? lit : 1;
    }
    // The mouth light at the tip, the pod's twin along it, the mouth's twin; the halo round the pod.
    const hot = 0.3 * (ringLight[RINGS - 1] as number) + flash + 0.6 * hit;
    o = (f + S_GLOW) * POSE_STRIDE;
    w[o + PX] = ax * 0.8;
    w[o + PY] = tipY + ay * 0.8;
    const mouthScale = (2 * (5 + 4 * c + 5 * flash)) / this.glowImg.frame.w;
    w[o + PSX] = mouthScale;
    w[o + PSY] = mouthScale;
    w[o + PALPHA] = hot < 1 ? hot : 1;
    o = (f + S_TWIN) * POSE_STRIDE;
    w[o + PX] = -ax * 13;
    w[o + PY] = tipY - ay * 13;
    w[o + PROT] = it.aimAngle;
    w[o + PSX] = (2 * 8) / this.glowImg.frame.w;
    w[o + PSY] = (2 * 18) / this.glowImg.frame.w;
    const twin = 0.55 * c + 0.4 * flash;
    w[o + PALPHA] = twin < 1 ? twin : 1;
    o = (f + S_MOUTH) * POSE_STRIDE;
    w[o + PX] = 0;
    w[o + PY] = tipY;
    const mouthTwin = (2 * (9 + 6 * c)) / this.glowImg.frame.w;
    w[o + PSX] = mouthTwin;
    w[o + PSY] = mouthTwin;
    const mt = 0.35 * c * c + 0.9 * flash + 0.6 * hit;
    w[o + PALPHA] = mt < 1 ? mt : 1;
    o = (f + S_HALO) * POSE_STRIDE;
    w[o + PX] = -ax * 14;
    w[o + PY] = tipY - ay * 14;
    const haloScale = (2 * ANCHOR.haloRadius * (0.8 + 0.3 * c)) / this.glowImg.frame.w;
    w[o + PSX] = haloScale;
    w[o + PSY] = haloScale;
    w[o + PALPHA] = 0.24 * c + 0.25 * flash;

    for (let k = 0; k < it.leaves.length; k++) {
      const l = it.leaves[k] as LeafSlot;
      const sway = Math.sin(t * 1.1 + l.phase) * 0.04 + Math.sin(t * 2.3 + l.phase * 1.7) * 0.012;
      // The rosette draws in a little as the pod charges and shivers with the shot.
      const tense = -l.side * 0.1 * c;
      o = l.slot * POSE_STRIDE;
      w[o + PX] = l.x;
      w[o + PY] = l.y;
      w[o + PROT] = l.angle + sway + tense + shiver * 0.04 * l.side + r * 0.07 * l.side;
      w[o + PSX] = this.leafScale * l.scale;
      w[o + PSY] = this.leafScale * l.scale;
      w[o + PTINT] = l.tintNow;
      this.poses.copyTransform(l.slot, l.occ);
    }
    this.poses.copyTransform(f + S_ROOTS, f + S_OCC_ROOTS);
    this.poses.copyTransform(f + S_STEM, f + S_OCC_STEM);
    this.poses.copyTransform(f + S_BULB, f + S_OCC_BULB);
    this.poses.flush(f, it.count);
  }
}
