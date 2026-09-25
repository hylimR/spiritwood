import type { AudioEngine, AudioFrame, AudioStats, AudioVolumes } from '../contracts/audio.ts';
import type { SimEvent } from '../contracts/sim.ts';
import { Engine } from './engine.ts';
import type { AudioBufferPort, AudioContextPort } from './ports.ts';
import { AUDIO_TUNING } from './tuning.ts';

export interface AudioSystemOptions {
  /** Context factory (tests inject a fake); null or a throw → 'unavailable'. Default: a 48 kHz AudioContext. */
  createContext?: () => AudioContextPort | null;
  /** Where the capture-phase unlock listeners go (default: window; null disables them). */
  gestureTarget?: EventTarget | null;
  /** false constructs a silent engine ('unavailable'), e.g. for ?bench. */
  enabled?: boolean;
  /** Music Rng seed (level.seed). */
  seed?: number;
}

/** Gestures that may grant user activation; listened to in the capture phase on the gesture target. */
export const UNLOCK_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'touchend', 'keydown', 'click', 'gamepadconnected'] as const;

const LISTEN: AddEventListenerOptions = { capture: true, passive: true };
const UNLISTEN: EventListenerOptions = { capture: true };

function ignore(): void {}

/** Every promise the engine gets from Web Audio is caught (never awaited). */
function settle(p: Promise<void> | undefined): void {
  if (p && typeof p.then === 'function') p.then(ignore, ignore);
}

/** The realtime context: interactive latency at a fixed 48 kHz. No webkitAudioContext (WebGL2 implies Safari 15). */
function defaultContext(): AudioContextPort | null {
  if (typeof AudioContext !== 'function') return null;
  return new AudioContext({ latencyHint: 'interactive', sampleRate: AUDIO_TUNING.sampleRate });
}

/**
 * Synthesized Web Audio engine (ARCHITECTURE.md §5.9). Fails closed: every public method catches, and the
 * first unexpected error logs once, closes the context and leaves `stats.state = 'unavailable'`.
 *
 * Lifecycle: the context is created only on a user activation — a trusted gesture caught in the capture
 * phase, or `unlock()` (game.ts calls it after polling the pad) — which also calls `resume()` (never
 * awaited, never gated on an earlier call) and starts a one-sample silent buffer (WebKit). The listeners
 * stay armed while the context is not running. Until it runs, update() books nothing and SFX events are
 * dropped. `setActive` suspends and resumes; every `statechange` reconciles the wanted state.
 */
export class AudioSystem implements AudioEngine {
  readonly stats: AudioStats = { state: 'locked', voices: 0, latency: -1, updateMs: 0 };

  private ctx: AudioContextPort | null = null;
  private engine: Engine | null = null;
  private readonly factory: (() => AudioContextPort | null) | null;
  private readonly target: EventTarget | null;
  private readonly seed: number;
  private readonly vol = { master: 1, music: 1, sfx: 1 };
  private silent: AudioBufferPort | null = null;
  /** 'unavailable' or 'closed': nothing happens any more. */
  private final = false;
  private armed = false;
  private everRan = false;
  private wantActive = true;
  private logged = false;

  constructor(options: AudioSystemOptions = {}) {
    this.seed = (options.seed ?? 0) >>> 0;
    this.target = options.gestureTarget !== undefined ? options.gestureTarget : typeof window !== 'undefined' ? window : null;
    this.factory = options.createContext ?? (typeof AudioContext === 'function' ? defaultContext : null);
    try {
      if (options.enabled === false || !this.factory) {
        this.final = true;
        this.stats.state = 'unavailable';
        return;
      }
      this.arm();
    } catch (err) {
      this.fail(err);
    }
  }

  /** The live engine (tests and tools inspect it). */
  get inspect(): Engine | null {
    return this.engine;
  }

  unlock(): void {
    try {
      this.activate();
    } catch (err) {
      this.fail(err);
    }
  }

  onSimEvent(e: SimEvent, frame: AudioFrame): void {
    try {
      const ctx = this.ctx;
      if (this.final || !this.engine || !ctx || ctx.state !== 'running') return;
      this.engine.onEvent(e, frame);
    } catch (err) {
      this.fail(err);
    }
  }

  update(frame: AudioFrame): void {
    const t0 = performance.now();
    try {
      const ctx = this.ctx;
      const engine = this.engine;
      if (!this.final && ctx && engine) {
        this.refresh();
        this.readLatency(ctx);
        if (ctx.state === 'running') engine.update(frame);
        if (this.engine) this.stats.voices = engine.voiceCount();
      }
    } catch (err) {
      this.fail(err);
    }
    this.stats.updateMs = performance.now() - t0;
  }

  setVolumes(v: AudioVolumes): void {
    try {
      this.vol.master = unit(v.master);
      this.vol.music = unit(v.music);
      this.vol.sfx = unit(v.sfx);
      if (!this.final && this.engine) this.engine.setVolumes(this.vol.master, this.vol.music, this.vol.sfx);
    } catch (err) {
      this.fail(err);
    }
  }

  setActive(active: boolean): void {
    try {
      this.wantActive = active;
      if (this.final) return;
      this.reconcile();
      this.refresh();
    } catch (err) {
      this.fail(err);
    }
  }

  destroy(): void {
    try {
      this.disarm();
    } catch {
      // Keep tearing down.
    }
    const ctx = this.ctx;
    this.final = true;
    this.stats.state = 'closed';
    this.stats.voices = 0;
    this.engine = null;
    this.ctx = null;
    if (ctx) this.close(ctx);
  }

  // ---- lifecycle ----

  private readonly onGesture = (e: Event): void => {
    if (!e.isTrusted) return;
    try {
      this.activate();
    } catch (err) {
      this.fail(err);
    }
  };

  private readonly onStateChange = (): void => {
    try {
      this.refresh();
      this.reconcile();
    } catch (err) {
      this.fail(err);
    }
  };

  /** Create the context if needed, resume it and play one silent sample; idempotent once running. */
  private activate(): void {
    if (this.final || !this.wantActive) return;
    let ctx = this.ctx;
    if (!ctx) {
      let made: AudioContextPort | null = null;
      try {
        made = this.factory ? this.factory() : null;
      } catch (err) {
        console.warn('[audio] no AudioContext:', err);
        made = null;
      }
      if (!made) {
        this.unavailable();
        return;
      }
      ctx = made;
      this.ctx = ctx;
      ctx.onstatechange = this.onStateChange;
      this.engine = new Engine(ctx, this.seed, this.vol.master, this.vol.music, this.vol.sfx);
    }
    if (ctx.state !== 'running') {
      settle(ctx.resume());
      if (!this.silent) this.silent = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource();
      s.buffer = this.silent;
      s.connect(ctx.destination);
      s.start(0);
    }
    this.refresh();
  }

  /** Map the context state onto the §5.9 table and keep the listeners armed while not running. */
  private refresh(): void {
    const ctx = this.ctx;
    if (this.final || !ctx) return;
    const s = ctx.state;
    if (s === 'running') {
      this.everRan = true;
      this.stats.state = 'running';
      this.disarm();
    } else if (s === 'closed') {
      this.fail(new Error('the AudioContext closed'));
    } else {
      this.stats.state = this.everRan ? 'suspended' : 'locked';
      if (this.wantActive) this.arm();
    }
  }

  /** Wanted vs actual: suspend while hidden, resume when visible again (only once it has ever run). */
  private reconcile(): void {
    const ctx = this.ctx;
    if (this.final || !ctx) return;
    const s = ctx.state;
    if (!this.wantActive && s === 'running') settle(ctx.suspend());
    else if (this.wantActive && this.everRan && s !== 'running' && s !== 'closed') settle(ctx.resume());
  }

  private readLatency(ctx: AudioContextPort): void {
    const b = ctx.baseLatency;
    const o = ctx.outputLatency;
    this.stats.latency = typeof b === 'number' && Number.isFinite(b) && typeof o === 'number' && Number.isFinite(o) ? b + o : -1;
  }

  private arm(): void {
    const t = this.target;
    if (this.armed || !t || this.final) return;
    for (let i = 0; i < UNLOCK_EVENTS.length; i++) t.addEventListener(UNLOCK_EVENTS[i] as string, this.onGesture, LISTEN);
    this.armed = true;
  }

  private disarm(): void {
    const t = this.target;
    if (!this.armed || !t) return;
    for (let i = 0; i < UNLOCK_EVENTS.length; i++) t.removeEventListener(UNLOCK_EVENTS[i] as string, this.onGesture, UNLISTEN);
    this.armed = false;
  }

  private close(ctx: AudioContextPort): void {
    try {
      ctx.onstatechange = null;
      settle(ctx.close());
    } catch {
      // Already failing or closed.
    }
  }

  /** The factory gave no context: final 'unavailable' (not an unexpected error). */
  private unavailable(): void {
    this.final = true;
    this.stats.state = 'unavailable';
    this.disarm();
  }

  /** Fail closed: log once, close the context, and stay 'unavailable'. */
  private fail(err: unknown): void {
    if (!this.logged) {
      this.logged = true;
      console.error('[audio] disabled after an error', err);
    }
    const ctx = this.ctx;
    this.final = true;
    this.stats.state = 'unavailable';
    this.stats.voices = 0;
    this.engine = null;
    this.ctx = null;
    try {
      this.disarm();
    } catch {
      // Nothing else to release.
    }
    if (ctx) this.close(ctx);
  }
}

function unit(v: number): number {
  return Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 1;
}
