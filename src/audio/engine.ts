import type { AudioFrame } from '../contracts/audio.ts';
import type { SimEvent } from '../contracts/sim.ts';
import { AmbienceEngine } from './ambience.ts';
import { BufferBuilder } from './buffers.ts';
import { Harmony } from './harmony.ts';
import { createParams, createWaves, resetParams, type PatchKit, type PatchParams } from './kit.ts';
import { Mixer } from './mixer.ts';
import { MusicEngine } from './music.ts';
import { PATCH_IDS, PATCHES, type PatchId } from './patches/index.ts';
import { clampPan, linTo, setAt, setValue, type AudioContextPort, type AudioNodePort } from './ports.ts';
import { SfxEngine } from './sfx.ts';
import { AUDIO_TUNING, Category } from './tuning.ts';
import { retire, steal, Tail, VoicePool, type Voice } from './voices.ts';

/**
 * Everything that needs a live context: the mix graph, buffers, voice pools and the SFX, music and
 * ambience engines. Created on the first activation; `update` runs only while the context is running.
 */
export class Engine {
  readonly mixer: Mixer;
  readonly buffers: BufferBuilder;
  readonly kit: PatchKit;
  readonly params: PatchParams;
  readonly harmony = new Harmony();
  readonly sfxPool: VoicePool;
  readonly musicPool: VoicePool;
  readonly ambiencePool: VoicePool;
  /** Wind and cricket beds: long-lived, outside the budgets. */
  readonly bedPool: VoicePool;
  readonly sfx: SfxEngine;
  readonly music: MusicEngine;
  readonly ambience: AmbienceEngine;

  /** ctx.currentTime at the latest call, and the scheduling lead max(0.03, 2·baseLatency). */
  now = 0;
  lead: number = AUDIO_TUNING.leadMin;
  paused = false;
  frozen = false;
  /** Voices started per patch (inspection and tests). */
  readonly started = {} as Record<PatchId, number>;
  private seq = 0;
  private impulseSet = false;

  readonly ctx: AudioContextPort;

  constructor(ctx: AudioContextPort, seed: number, master: number, music: number, sfx: number) {
    const t = AUDIO_TUNING;
    this.ctx = ctx;
    this.mixer = new Mixer(ctx, master, music, sfx);
    this.buffers = new BufferBuilder(ctx, seed);
    this.kit = { noise: null, waves: createWaves(ctx) };
    this.params = createParams(this.kit);
    // Room for a pile-up: a frame can steal many voices, and stolen records stay allocated until they
    // retire (their 15 ms fade plus the retire grace).
    this.sfxPool = new VoicePool(Category.Sfx, t.budgetSfx, t.budgetSfx * 4);
    this.musicPool = new VoicePool(Category.Music, t.budgetMusic, t.budgetMusic * 2 + 4);
    this.ambiencePool = new VoicePool(Category.Ambience, t.budgetAmbience, t.budgetAmbience * 2 + 4);
    this.bedPool = new VoicePool(Category.Ambience, 1000, 6);
    for (let i = 0; i < PATCH_IDS.length; i++) this.started[PATCH_IDS[i] as PatchId] = 0;
    this.music = new MusicEngine(this, seed);
    this.sfx = new SfxEngine(this, seed);
    this.ambience = new AmbienceEngine(this, seed);
  }

  private clock(): void {
    this.now = this.ctx.currentTime;
    const b = this.ctx.baseLatency;
    this.lead = Math.max(AUDIO_TUNING.leadMin, typeof b === 'number' && Number.isFinite(b) ? 2 * b : 0);
  }

  update(frame: AudioFrame): void {
    this.clock();
    const now = this.now;
    let built = false;
    if (!this.buffers.done) {
      this.buffers.step();
      built = true;
    }
    if (!this.kit.noise && this.buffers.noise) this.kit.noise = this.buffers.noise;
    if (!built && !this.impulseSet && this.buffers.impulse) {
      // Its own update: assigning a convolver buffer prepares the FFT kernels on the main thread.
      this.mixer.setImpulse(this.buffers.impulse);
      this.impulseSet = true;
    }
    this.paused = frame.paused;
    this.frozen = frame.sim.frozen;
    this.mixer.setPaused(this.paused, now);
    this.mixer.setFrozen(this.frozen, now);
    retire(this.sfxPool, now);
    retire(this.musicPool, now);
    retire(this.ambiencePool, now);
    retire(this.bedPool, now);
    this.music.update(frame);
    this.sfx.update(frame);
    this.ambience.update();
    this.sfx.endFrame();
  }

  onEvent(e: SimEvent, frame: AudioFrame): void {
    this.clock();
    this.sfx.onEvent(e, frame);
  }

  setVolumes(master: number, music: number, sfx: number): void {
    this.mixer.setVolumes(master, music, sfx, this.ctx.currentTime);
  }

  /** The SFX slider (which the ambience follows) and the master are above 0. */
  sfxAudible(): boolean {
    return this.mixer.volumeGain('sfx') > 0 && this.mixer.volumeGain('master') > 0;
  }

  /** Sounding voices over the three budgets. */
  voiceCount(): number {
    const now = this.ctx.currentTime;
    return this.sfxPool.sounding(now) + this.musicPool.sounding(now) + this.ambiencePool.sounding(now);
  }

  /** Fresh, defaulted patch parameters (one shared object). */
  p(): PatchParams {
    return resetParams(this.params);
  }

  /**
   * Start `id` at t0 into `dest`. Enforces the patch cap (stealing its oldest instance) and the category
   * budget (stealing lowest priority, then oldest). Skips patches whose buffer is not built yet. A lease
   * patch gets its first lease window here.
   */
  start(pool: VoicePool, id: PatchId, t0: number, dest: AudioNodePort, tail: Tail, pan: number): Voice | null {
    const def = PATCHES[id];
    if (def.noise && !this.kit.noise) return null;
    const now = this.now;
    if (def.cap > 0 && pool.soundingOf(id, now) >= def.cap) {
      const old = pool.victim(now, id);
      if (old) steal(old, now);
    }
    if (pool.sounding(now) >= pool.budget) {
      const v = pool.victim(now, null);
      if (!v) return null;
      steal(v, now);
    }
    const v = pool.free();
    if (!v) return null;
    const ctx = this.ctx;
    v.active = true;
    v.sounding = true;
    v.lease = def.lease;
    v.patch = id;
    v.priority = def.priority;
    v.start = t0;
    v.seq = ++this.seq;
    const kill = ctx.createGain();
    v.kill = kill;
    v.node(kill);
    if (tail === Tail.Pan) {
      const p = ctx.createStereoPanner();
      setValue(p.pan, clampPan(pan));
      kill.connect(p);
      p.connect(dest);
      v.panner = p;
      v.node(p);
    } else if (tail === Tail.Centre) {
      const c = ctx.createGain();
      setValue(c.gain, AUDIO_TUNING.centreGain);
      kill.connect(c);
      c.connect(dest);
      v.node(c);
    } else {
      kill.connect(dest);
    }
    const tEnd = def.fn(ctx, kill, t0, this.params, v);
    this.started[id]++;
    if (tEnd >= 0) {
      v.end = tEnd + AUDIO_TUNING.stopPad;
      v.stopSources(v.end);
    } else {
      const t = AUDIO_TUNING;
      v.fadeStart = now + t.leaseFade;
      v.fadeEnd = now + t.leaseStop - t.stopPad;
      v.end = now + t.leaseStop;
      setAt(kill.gain, 1, v.fadeStart);
      linTo(kill.gain, 0, v.fadeEnd);
      v.stopSources(v.end);
    }
    return v;
  }
}
