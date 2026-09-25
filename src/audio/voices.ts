import type { PatchId } from './patches/index.ts';
import {
  cancelFrom, linTo, setAt, type AudioNodePort, type AudioParamPort, type GainNodePort, type ScheduledSourcePort,
  type StereoPannerNodePort, type VoiceSink,
} from './ports.ts';
import { AUDIO_TUNING, type Category } from './tuning.ts';

/** How a voice reaches its bus: a panner (spatial), the fixed 0.7071 centre Gain, or directly (music). */
export const Tail = { Pan: 0, Centre: 1, Direct: 2 } as const;
export type Tail = (typeof Tail)[keyof typeof Tail];

const MAX_SOURCES = 48;
const MAX_NODES = 128;

/**
 * One patch instance (§5.9 Voices): sources → envelope Gain → kill Gain → panner (or the fixed 0.7071
 * centre Gain, or nothing for music, which pans per bus) → bus. Records are preallocated and reused;
 * they retire by their scheduled end time (no `onended` closures) and are then disconnected.
 */
export class Voice implements VoiceSink {
  readonly sources: (ScheduledSourcePort | null)[] = new Array<ScheduledSourcePort | null>(MAX_SOURCES).fill(null);
  nSources = 0;
  readonly nodes: (AudioNodePort | null)[] = new Array<AudioNodePort | null>(MAX_NODES).fill(null);
  nNodes = 0;
  /** Continuous-control params the owner keeps steering (leases), and their last written values. */
  readonly handles: (AudioParamPort | null)[] = [null, null, null, null];
  /** NaN = never written, so the first steer always writes (even a target near 0). */
  readonly written = new Float64Array(6).fill(NaN);
  kill: GainNodePort | null = null;
  panner: StereoPannerNodePort | null = null;

  /** The record is in use (until retired). */
  active = false;
  /** Counts toward its category budget: not stolen, released or ended. */
  sounding = false;
  lease = false;
  category: Category = 0;
  patch: PatchId = 'jump';
  priority = 0;
  /** Scheduled start, and the time every source stops. */
  start = 0;
  end = 0;
  /** The kill-gain fade window currently scheduled (leases, releases and steals). */
  fadeStart = Infinity;
  fadeEnd = Infinity;
  /** Owner key (e.g. the enemy id of a rattle) and allocation order. */
  key = -1;
  seq = 0;
  /** Lease-specific scheduling state (heartbeat). */
  nextBeat = 0;

  source(s: ScheduledSourcePort): void {
    if (this.nSources >= MAX_SOURCES) throw new Error('voice source capacity exceeded');
    this.sources[this.nSources++] = s;
    this.node(s);
  }

  node(n: AudioNodePort): void {
    if (this.nNodes >= MAX_NODES) throw new Error('voice node capacity exceeded');
    this.nodes[this.nNodes++] = n;
  }

  handle(slot: number, p: AudioParamPort): void {
    this.handles[slot] = p;
  }

  stopSources(t: number): void {
    for (let i = 0; i < this.nSources; i++) (this.sources[i] as ScheduledSourcePort).stop(t);
  }

  /** Kill-gain level at `now` (1 unless inside a scheduled fade). */
  killLevel(now: number): number {
    if (now <= this.fadeStart) return 1;
    if (now >= this.fadeEnd) return 0;
    return 1 - (now - this.fadeStart) / (this.fadeEnd - this.fadeStart);
  }

  reset(): void {
    for (let i = 0; i < this.nNodes; i++) this.nodes[i] = null;
    for (let i = 0; i < this.nSources; i++) this.sources[i] = null;
    this.nNodes = 0;
    this.nSources = 0;
    for (let i = 0; i < 4; i++) this.handles[i] = null;
    this.written.fill(NaN);
    this.kill = null;
    this.panner = null;
    this.active = false;
    this.sounding = false;
    this.lease = false;
    this.fadeStart = Infinity;
    this.fadeEnd = Infinity;
    this.key = -1;
    this.nextBeat = 0;
  }
}

/**
 * A reference to one allocation of a voice. Records are stolen, retired and reused by other owners, so a
 * bare `Voice` reference can go stale and end up steering someone else's sound; this one only resolves
 * while the record still holds the same allocation (`seq`) and is sounding.
 */
export class VoiceRef {
  private v: Voice | null = null;
  private seq = -1;

  set(v: Voice | null): void {
    this.v = v;
    this.seq = v ? v.seq : -1;
  }

  /** The voice while it is still this allocation and sounding; otherwise the reference clears itself. */
  live(): Voice | null {
    const v = this.v;
    if (v && v.seq === this.seq && v.active && v.sounding) return v;
    this.v = null;
    this.seq = -1;
    return null;
  }

  clear(): void {
    this.v = null;
    this.seq = -1;
  }
}

/** A category's preallocated records and budget. Beds use an unbudgeted pool. */
export class VoicePool {
  readonly records: Voice[] = [];
  readonly category: Category;
  readonly budget: number;

  constructor(category: Category, budget: number, capacity: number) {
    this.category = category;
    this.budget = budget;
    for (let i = 0; i < capacity; i++) {
      const v = new Voice();
      v.category = category;
      this.records.push(v);
    }
  }

  /** Voices that count toward the budget at `now`. */
  sounding(now: number): number {
    let n = 0;
    const r = this.records;
    for (let i = 0; i < r.length; i++) {
      const v = r[i] as Voice;
      if (v.sounding && v.end > now) n++;
    }
    return n;
  }

  soundingOf(patch: PatchId, now: number): number {
    let n = 0;
    const r = this.records;
    for (let i = 0; i < r.length; i++) {
      const v = r[i] as Voice;
      if (v.sounding && v.end > now && v.patch === patch) n++;
    }
    return n;
  }

  /** The steal victim: lowest priority first, then oldest (optionally only of one patch). */
  victim(now: number, patch: PatchId | null): Voice | null {
    let best: Voice | null = null;
    const r = this.records;
    for (let i = 0; i < r.length; i++) {
      const v = r[i] as Voice;
      if (!v.sounding || v.end <= now) continue;
      if (patch !== null && v.patch !== patch) continue;
      if (
        !best || v.priority < best.priority
        || (v.priority === best.priority && (v.start < best.start || (v.start === best.start && v.seq < best.seq)))
      ) {
        best = v;
      }
    }
    return best;
  }

  free(): Voice | null {
    const r = this.records;
    for (let i = 0; i < r.length; i++) if (!(r[i] as Voice).active) return r[i] as Voice;
    return null;
  }
}

/**
 * Fade a voice's kill Gain from its current level to 0 over `fade` and stop its sources `pad` later
 * (§5.9: steal = 10 ms fade + stop at 15 ms; releases use longer fades). The voice stops counting at once.
 */
export function fadeOut(v: Voice, now: number, fade: number, pad: number): void {
  if (!v.kill) return;
  const level = v.killLevel(now);
  const k = v.kill.gain;
  cancelFrom(k, now);
  setAt(k, level, now);
  linTo(k, 0, now + fade);
  v.stopSources(now + fade + pad);
  v.fadeStart = now;
  v.fadeEnd = now + fade;
  v.end = now + fade + pad;
  v.sounding = false;
}

export function steal(v: Voice, now: number): void {
  const t = AUDIO_TUNING;
  fadeOut(v, now, t.stealFade, t.stealStop - t.stealFade);
}

export function release(v: Voice, now: number, fade: number): void {
  if (!v.sounding) return;
  fadeOut(v, now, fade, AUDIO_TUNING.stopPad);
}

/**
 * Re-issue a lease (§5.9 Leases): stop(now + 0.35) and a kill fade from now + 0.2, so a voice whose
 * update() stops fades out on its own. Returns false when the previous fade is too close to renew
 * click-free (the voice then fades out and the owner starts a new one).
 */
export function renewLease(v: Voice, now: number): boolean {
  if (!v.sounding || !v.kill) return false;
  const t = AUDIO_TUNING;
  if (now >= v.fadeStart - t.leaseMargin) {
    v.sounding = false;
    return false;
  }
  const k = v.kill.gain;
  cancelFrom(k, now);
  const fs = now + t.leaseFade;
  const fe = now + t.leaseStop - t.stopPad;
  setAt(k, 1, fs);
  linTo(k, 0, fe);
  v.stopSources(now + t.leaseStop);
  v.fadeStart = fs;
  v.fadeEnd = fe;
  v.end = now + t.leaseStop;
  return true;
}

/** Disconnect and free every record whose scheduled end has passed (plus the audio-thread grace). */
export function retire(pool: VoicePool, now: number): void {
  const grace = AUDIO_TUNING.retireGrace;
  const r = pool.records;
  for (let i = 0; i < r.length; i++) {
    const v = r[i] as Voice;
    if (!v.active || now < v.end + grace) continue;
    for (let j = 0; j < v.nNodes; j++) (v.nodes[j] as AudioNodePort).disconnect();
    v.reset();
  }
}
