import type { AudioFrame } from '../contracts/audio.ts';
import { EnemyHitCause, SeedBurstCause, SimEventType, type SimEvent } from '../contracts/sim.ts';
import { Rng } from '../core/rng.ts';
import type { Engine } from './engine.ts';
import {
  fillAbility, fillAim, fillAirJump, fillCheckpoint, fillGoal, fillLaunch, fillLaunchAim, fillOrb, fillRespawn,
  fillSeedChime,
} from './fills.ts';
import type { PatchId } from './patches/index.ts';
import { HEARTBEAT_BEAT_SEC, heartbeatBeat, heartbeatInterval, rattleTargets, scrapeTargets } from './patches/sfx.ts';
import { clampPan, targetAt } from './ports.ts';
import { createPlacement, place } from './space.ts';
import { AUDIO_TUNING } from './tuning.ts';
import { clamp01 } from './util.ts';
import { release, renewLease, Tail, VoiceRef, type Voice } from './voices.ts';

/**
 * Every SimEvent type → its patch (§5.9 SFX); null = silent or control-only. Payload variants:
 * DashEnd plays only for b = 2 (a wall thud); SeedBurst is a chime on an enemy and silent on the player
 * (Died covers it); EnemyHit plays only for cause Seed (Launch covers the other); SpitterWindup starts the
 * rattle lease; Reset, Teleported and Respawned also release every SFX voice and clear the orb combo.
 */
export const EVENT_PATCH = {
  [SimEventType.Jump]: 'jump',
  [SimEventType.AirJump]: 'airJump',
  [SimEventType.WallJump]: 'wallJump',
  [SimEventType.Dash]: 'dash',
  [SimEventType.DashEnd]: 'wallThud',
  [SimEventType.Land]: 'land',
  [SimEventType.WallSlideStart]: 'gripTick',
  [SimEventType.WallSlideEnd]: null,
  [SimEventType.OrbCollected]: 'orb',
  [SimEventType.CheckpointActivated]: 'checkpoint',
  [SimEventType.Died]: 'died',
  [SimEventType.Respawned]: 'respawn',
  [SimEventType.EnemyStomped]: 'stomp',
  [SimEventType.EnemyReformed]: 'reform',
  [SimEventType.GoalReached]: 'goal',
  [SimEventType.DropThrough]: 'rustle',
  [SimEventType.Reset]: null,
  [SimEventType.Teleported]: null,
  [SimEventType.AbilityUnlocked]: 'ability',
  [SimEventType.LaunchAim]: 'launchAim',
  [SimEventType.Launch]: 'launch',
  [SimEventType.LaunchFizzle]: 'fizzle',
  [SimEventType.SeedFired]: 'seedPop',
  [SimEventType.SeedBurst]: 'seedCrackle',
  [SimEventType.SpitterWindup]: 'rattle',
  [SimEventType.EnemyHit]: 'enemyHit',
} as const satisfies Record<SimEventType, PatchId | null>;

/**
 * Spatial events (distance gain, cull, pan): the enemy-side ones. Everything player-origin — movement,
 * launch, orbs, checkpoint, death and respawn, goal, ability, reset and teleport — is non-spatial.
 */
const SPATIAL = new Uint8Array(32);
SPATIAL[SimEventType.EnemyStomped] = 1;
SPATIAL[SimEventType.EnemyReformed] = 1;
SPATIAL[SimEventType.SeedFired] = 1;
SPATIAL[SimEventType.SeedBurst] = 1;
SPATIAL[SimEventType.SpitterWindup] = 1;
SPATIAL[SimEventType.EnemyHit] = 1;

export function isSpatialEvent(type: SimEventType): boolean {
  return SPATIAL[type] === 1;
}

/** Scrape and aim leases release over these when their state ends (pause uses pauseReleaseSec). */
const SCRAPE_RELEASE = 0.08;
const AIM_RELEASE = 0.15;
const HEART_RELEASE = 0.06;
const RATTLE_RELEASE = 0.05;
/** Relative change below which a steered parameter is not rewritten. */
const STEER_EPS = 0.01;

/**
 * Event-driven one-shots and state-driven leases on the SFX bus. Leases follow state read in update(),
 * never events: scrape ⇔ wallSlide; aim sustain and heartbeat ⇔ sim.frozen; rattle ⇔ a spitter in windup
 * (the two nearest, pitch and level from modeTicks / modeDuration). While paused, or while the SFX or
 * master slider is at 0, leases release and none start; they come back when that ends if their state
 * still holds. Everything starts AUDIO_TUNING.sfxLead ahead of currentTime (not the music lead).
 */
export class SfxEngine {
  private readonly e: Engine;
  private readonly rng: Rng;
  private readonly spot = createPlacement();
  private readonly targets = new Float64Array(4);
  private lastLand = -Infinity;
  private combo = -1;
  private lastOrb = -Infinity;
  private orbsThisFrame = 0;
  /** Lease references check the allocation (seq): a stolen, retired and reused record is never steered. */
  private readonly scrape = new VoiceRef();
  private readonly aim = new VoiceRef();
  private readonly heart = new VoiceRef();
  private readonly rattles = [new VoiceRef(), new VoiceRef()] as const;
  private readonly rattleIds = new Int32Array([-1, -1]);
  private readonly wanted = new Int32Array([-1, -1]);

  constructor(e: Engine, seed: number) {
    this.e = e;
    this.rng = new Rng((seed ^ 0x51f7_c0de) >>> 0);
  }

  /** Current orb combo step (−1 = none), for inspection. */
  get comboStep(): number {
    return this.combo;
  }

  /** Enemy id owning rattle slot k (−1 = none), for inspection. */
  rattleOwner(k: number): number {
    return this.rattle(k).live() ? (this.rattleIds[k] as number) : -1;
  }

  /** The live voice of a lease (inspection and tests). */
  lease(which: 'scrape' | 'aim' | 'heart' | 'rattle0' | 'rattle1'): Voice | null {
    const ref = which === 'scrape' ? this.scrape : which === 'aim' ? this.aim : which === 'heart' ? this.heart
      : this.rattle(which === 'rattle0' ? 0 : 1);
    return ref.live();
  }

  private rattle(k: number): VoiceRef {
    return k === 0 ? this.rattles[0] : this.rattles[1];
  }

  onEvent(ev: SimEvent, frame: AudioFrame): void {
    const e = this.e;
    const type = ev.type;
    if (type === SimEventType.Reset || type === SimEventType.Teleported) {
      this.releaseAll();
      return;
    }
    if (type === SimEventType.Respawned) this.releaseAll();
    // No new SFX while paused, or into a muted bus.
    if (e.paused || !e.sfxAudible()) return;
    if (type === SimEventType.SpitterWindup) {
      this.maintainRattles(frame, true);
      return;
    }
    let id: PatchId | null = EVENT_PATCH[type];
    if (id === null) return;
    const p = e.p();
    p.variant = this.rng.next();
    let t0 = e.now + AUDIO_TUNING.sfxLead;
    const h = e.harmony;
    switch (type) {
      case SimEventType.DashEnd:
        if (ev.b !== 2) return;
        break;
      case SimEventType.Land: {
        const t = AUDIO_TUNING;
        if (!(ev.a >= t.landMinSpeed) || e.now - this.lastLand < t.landMinGap) return;
        this.lastLand = e.now;
        p.gain = clamp01(ev.a / t.landFullSpeed);
        p.bright = clamp01((ev.a - t.landMinSpeed) / (t.landFullSpeed - t.landMinSpeed));
        break;
      }
      case SimEventType.OrbCollected: {
        const t = AUDIO_TUNING;
        t0 += t.orbStagger * this.orbsThisFrame++;
        this.combo = this.combo >= 0 && t0 - this.lastOrb <= t.orbComboWindow ? Math.min(this.combo + 1, t.orbComboMaxSteps) : 0;
        this.lastOrb = t0;
        fillOrb(p, h, this.combo);
        break;
      }
      case SimEventType.AirJump:
        fillAirJump(p, h);
        break;
      case SimEventType.CheckpointActivated:
        fillCheckpoint(p, h);
        break;
      case SimEventType.GoalReached:
        fillGoal(p, h);
        break;
      case SimEventType.AbilityUnlocked:
        fillAbility(p, h);
        break;
      case SimEventType.Respawned:
        fillRespawn(p, h);
        break;
      case SimEventType.LaunchAim:
        fillLaunchAim(p, h);
        break;
      case SimEventType.Launch:
        fillLaunch(p, h);
        break;
      case SimEventType.SeedBurst:
        if (ev.a === SeedBurstCause.Player) return;
        if (ev.a === SeedBurstCause.Enemy) {
          id = 'seedChime';
          fillSeedChime(p, h);
        }
        break;
      case SimEventType.EnemyHit:
        if (ev.a !== EnemyHitCause.Seed) return;
        break;
      default:
        break;
    }
    let tail: Tail = Tail.Centre;
    let pan = 0;
    if (SPATIAL[type] === 1) {
      place(frame, ev.x, ev.y, this.spot);
      if (this.spot.d >= 1) return;
      p.gain *= this.spot.gain;
      tail = Tail.Pan;
      pan = this.spot.pan;
    }
    e.start(e.sfxPool, id, t0, e.mixer.sfx, tail, pan);
  }

  /** Reset, Teleported, Respawned: release every SFX voice and clear the orb combo. */
  releaseAll(): void {
    const e = this.e;
    const r = e.sfxPool.records;
    for (let i = 0; i < r.length; i++) {
      const v = r[i] as Voice;
      if (v.active && v.sounding) release(v, e.now, AUDIO_TUNING.controlReleaseSec);
    }
    this.scrape.clear();
    this.aim.clear();
    this.heart.clear();
    this.rattles[0].clear();
    this.rattles[1].clear();
    this.rattleIds[0] = -1;
    this.rattleIds[1] = -1;
    this.combo = -1;
    this.lastOrb = -Infinity;
  }

  update(frame: AudioFrame): void {
    const e = this.e;
    const sim = frame.sim;
    const pl = sim.player;
    const on = !e.paused && e.sfxAudible();
    const off = AUDIO_TUNING.pauseReleaseSec;
    const t0 = e.now + AUDIO_TUNING.sfxLead;

    // Wall scrape ⇔ wallSlide.
    const scraping = on && pl.alive && pl.mode === 'wallSlide';
    let v = this.keep(this.scrape, scraping, on ? SCRAPE_RELEASE : off);
    if (scraping && !v) {
      e.p().variant = this.rng.next();
      v = e.start(e.sfxPool, 'scrape', t0, e.mixer.sfx, Tail.Centre, 0);
      this.scrape.set(v);
    }
    if (v) {
      scrapeTargets(pl.vy / 190, this.targets);
      this.steer(v, 0, this.targets[0] as number, 0.05);
      this.steer(v, 1, this.targets[1] as number, 0.05);
    }

    // Aim sustain and heartbeat ⇔ frozen.
    const aiming = on && sim.frozen;
    const launch = sim.launch;
    const prog = launch.aimMaxTicks > 0 ? clamp01(launch.aimTicks / launch.aimMaxTicks) : 0;
    v = this.keep(this.aim, aiming, on ? AIM_RELEASE : off);
    if (aiming && !v) {
      fillAim(e.p(), e.harmony);
      v = e.start(e.sfxPool, 'aimSustain', t0, e.mixer.sfx, Tail.Centre, 0);
      this.aim.set(v);
    }
    if (v) this.steer(v, 0, 0.75 + 0.25 * prog, 0.08);
    v = this.keep(this.heart, aiming, on ? HEART_RELEASE : off);
    if (aiming && !v) {
      e.p().gain = 1;
      v = e.start(e.sfxPool, 'heartbeat', t0, e.mixer.sfx, Tail.Centre, 0);
      if (v) v.nextBeat = t0 + heartbeatInterval(prog);
      this.heart.set(v);
    }
    if (v) this.beats(v, prog);

    this.maintainRattles(frame, on);
  }

  endFrame(): void {
    this.orbsThisFrame = 0;
  }

  /**
   * Renew a lease while wanted; release it when not. Returns the live voice (null = none: start anew).
   * A reference whose record was stolen, retired or reused resolves to null (VoiceRef checks seq).
   */
  private keep(ref: VoiceRef, want: boolean, fade: number): Voice | null {
    const v = ref.live();
    if (!v) return null;
    if (!want) {
      release(v, this.e.now, fade);
      ref.clear();
      return null;
    }
    if (renewLease(v, this.e.now)) return v;
    ref.clear();
    return null;
  }

  /** Book heartbeat lub-dubs inside the lookahead window, faster as the aim runs out. */
  private beats(v: Voice, prog: number): void {
    const e = this.e;
    const g = v.handles[0];
    if (!g) return;
    const horizon = e.now + AUDIO_TUNING.horizon;
    let guard = 0;
    while (v.nextBeat <= horizon && guard++ < 4) {
      const tb = Math.max(v.nextBeat, e.now + AUDIO_TUNING.sfxLead);
      heartbeatBeat(g, tb, 1);
      v.nextBeat = tb + Math.max(heartbeatInterval(prog), HEARTBEAT_BEAT_SEC + 0.01);
    }
  }

  /** Keep rattle leases on the two nearest spitters in windup (on screen or near it). */
  private maintainRattles(frame: AudioFrame, on: boolean): void {
    const e = this.e;
    const enemies = frame.sim.enemies;
    let id0 = -1;
    let id1 = -1;
    let d0 = Infinity;
    let d1 = Infinity;
    if (on) {
      for (let i = 0; i < enemies.length; i++) {
        const en = enemies[i];
        if (!en || en.kind !== 'thornSpitter' || en.mode !== 'windup') continue;
        const cy = en.y - en.height * 0.5;
        place(frame, en.x, cy, this.spot);
        if (this.spot.d >= 1) continue;
        const dx = en.x - frame.camX;
        const dy = cy - frame.camY;
        const dist = dx * dx + dy * dy;
        if (dist < d0) {
          d1 = d0;
          id1 = id0;
          d0 = dist;
          id0 = en.id;
        } else if (dist < d1) {
          d1 = dist;
          id1 = en.id;
        }
      }
    }
    this.wanted[0] = id0;
    this.wanted[1] = id1;
    // Release slots whose spitter is no longer wanted; renew the others.
    for (let k = 0; k < 2; k++) {
      const id = this.rattleIds[k] as number;
      const keepIt = id >= 0 && (id === id0 || id === id1);
      const kept = this.keep(this.rattle(k), keepIt, on ? RATTLE_RELEASE : AUDIO_TUNING.pauseReleaseSec);
      if (!kept) this.rattleIds[k] = keepIt ? id : -1;
    }
    // Start leases for wanted spitters without a live voice.
    for (let w = 0; w < 2; w++) {
      const id = this.wanted[w] as number;
      if (id < 0) continue;
      let slot = -1;
      for (let k = 0; k < 2; k++) if (this.rattleIds[k] === id) slot = k;
      if (slot >= 0 && this.rattle(slot).live()) continue;
      if (slot < 0) slot = this.rattleIds[0] === -1 ? 0 : this.rattleIds[1] === -1 ? 1 : -1;
      if (slot < 0) continue;
      const en = enemies[id];
      if (!en) continue;
      place(frame, en.x, en.y - en.height * 0.5, this.spot);
      const p = e.p();
      p.variant = this.rng.next();
      p.gain = this.spot.gain;
      const v = e.start(e.sfxPool, 'rattle', e.now + AUDIO_TUNING.sfxLead, e.mixer.sfx, Tail.Pan, this.spot.pan);
      this.rattle(slot).set(v);
      this.rattleIds[slot] = v ? id : -1;
    }
    // Steer each live rattle from its spitter's windup progress and position.
    for (let k = 0; k < 2; k++) {
      const v = this.rattle(k).live();
      const id = this.rattleIds[k] as number;
      const en = id >= 0 ? enemies[id] : undefined;
      if (!v || !en) continue;
      const prog = en.modeDuration > 0 ? clamp01(en.modeTicks / en.modeDuration) : 0;
      rattleTargets(prog, this.targets);
      place(frame, en.x, en.y - en.height * 0.5, this.spot);
      this.steer(v, 0, (this.targets[0] as number) * this.spot.gain, 0.04);
      this.steer(v, 1, this.targets[1] as number, 0.04);
      this.steer(v, 2, this.targets[2] as number, 0.04);
      this.steer(v, 3, this.targets[3] as number, 0.04);
      const pan = clampPan(this.spot.pan);
      // Written when it moves by more than 0.02 (or was never written: NaN).
      if (v.panner && !(Math.abs(pan - (v.written[4] as number)) <= 0.02)) {
        targetAt(v.panner.pan, pan, this.e.now, 0.05);
        v.written[4] = pan;
      }
    }
  }

  /** Write a lease's control parameter only when its target changes. */
  private steer(v: Voice, slot: number, value: number, tau: number): void {
    const p = v.handles[slot];
    if (!p) return;
    const last = v.written[slot] as number;
    // A NaN `last` (never written) fails the comparison, so the first steer always writes.
    if (Math.abs(value - last) <= STEER_EPS * Math.max(1, Math.abs(value))) return;
    targetAt(p, value, this.e.now, tau);
    v.written[slot] = value;
  }
}
