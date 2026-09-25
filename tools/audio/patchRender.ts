import type { AreaGradeId } from '../../src/contracts/level.ts';
import { BufferBuilder } from '../../src/audio/buffers.ts';
import * as F from '../../src/audio/fills.ts';
import { Harmony } from '../../src/audio/harmony.ts';
import { createParams, createWaves, resetParams, type PatchParams } from '../../src/audio/kit.ts';
import { PATCHES, type PatchId } from '../../src/audio/patches/index.ts';
import type { AudioNodePort, AudioParamPort, GraphPort, ScheduledSourcePort, VoiceSink } from '../../src/audio/ports.ts';
import { AUDIO_TUNING } from '../../src/audio/tuning.ts';

export const SR = AUDIO_TUNING.sampleRate;

/** The node-web-audio-api OfflineAudioContext constructor (loaded dynamically by callers). */
export type OfflineCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext;

/** Collects a patch's sources, like a voice record does. */
export class RecordingSink implements VoiceSink {
  readonly sources: ScheduledSourcePort[] = [];
  readonly nodes: AudioNodePort[] = [];
  readonly handles: (AudioParamPort | null)[] = [null, null, null, null];
  source(s: ScheduledSourcePort): void {
    this.sources.push(s);
  }
  node(n: AudioNodePort): void {
    this.nodes.push(n);
  }
  handle(slot: number, p: AudioParamPort): void {
    this.handles[slot] = p;
  }
}

/** How a patch reaches its bus in the engine (for per-channel headroom). */
export type Tail = 'centre' | 'spatial' | 'slot' | 'slotC' | 'ambient';

/**
 * Worst-case pan per tail: spatial SFX pan ≤ 0.6, music side slots ±0.3 (bells, piano, drips, shimmer),
 * the music centre slot (pads, drones, harmonics, pulse), ambient one-shots ≤ 0.5.
 */
export const TAIL_PAN: Record<Tail, number> = { centre: 0, spatial: AUDIO_TUNING.panScale, slot: 0.3, slotC: 0, ambient: 0.5 };

export interface PatchDemo {
  tail: Tail;
  /** Render length (s) after the start. */
  seconds: number;
  /** Fills the demo parameters from a harmony, with the engines' own fills (src/audio/fills.ts). */
  fill(p: PatchParams, h: Harmony): void;
  /** One-line description the analysis should match. */
  desc: string;
}

const leaseDur = 1.6;
/** Chord length (s) at the music tempo. */
const CHORD = (AUDIO_TUNING.barsPerChord * AUDIO_TUNING.beatsPerBar * 60) / AUDIO_TUNING.tempoBpm;

/**
 * One listening demo per patch (npm run audio:render writes them as WAV). Headroom across every mood,
 * chord, register and steered lease level is the sweep's job (tools/audio/sweep.ts).
 */
export const DEMOS: Record<PatchId, PatchDemo> = {
  jump: { tail: 'centre', seconds: 0.5, fill: () => {}, desc: 'soft airy lift' },
  airJump: { tail: 'centre', seconds: 0.8, fill: F.fillAirJump, desc: 'lift + two-note spirit sparkle' },
  wallJump: { tail: 'centre', seconds: 0.5, fill: () => {}, desc: 'wooden tok + push of air' },
  dash: { tail: 'centre', seconds: 0.6, fill: () => {}, desc: 'swift downward whoosh' },
  wallThud: { tail: 'centre', seconds: 0.5, fill: () => {}, desc: 'muffled low thud' },
  gripTick: { tail: 'centre', seconds: 0.3, fill: () => {}, desc: 'tiny grip tick' },
  rustle: { tail: 'centre', seconds: 0.5, fill: () => {}, desc: 'soft leafy rustle' },
  land: { tail: 'centre', seconds: 0.5, fill: (p) => { p.bright = 1; }, desc: 'soft footfall (max impact)' },
  orb: {
    tail: 'centre', seconds: 2.2, fill: (p, h) => F.fillOrb(p, h, AUDIO_TUNING.orbComboMaxSteps), desc: 'glass bell (top of the combo)',
  },
  checkpoint: { tail: 'centre', seconds: 3.8, fill: F.fillCheckpoint, desc: 'warm chord swell + bell' },
  goal: { tail: 'centre', seconds: 6.5, fill: F.fillGoal, desc: 'rising bell cadence onto the tonic + warm chord' },
  ability: { tail: 'centre', seconds: 6.5, fill: F.fillAbility, desc: 'grand bloom: arpeggio over a swelling chord' },
  died: { tail: 'centre', seconds: 1.0, fill: () => {}, desc: 'reverse swell into a low thud' },
  respawn: { tail: 'centre', seconds: 1.8, fill: F.fillRespawn, desc: 'soft rising shimmer' },
  stomp: { tail: 'spatial', seconds: 0.5, fill: () => {}, desc: 'squashy thump + small bounce' },
  reform: { tail: 'spatial', seconds: 1.0, fill: () => {}, desc: 'dark bubbling swell' },
  seedPop: { tail: 'spatial', seconds: 0.4, fill: () => {}, desc: 'wet pop' },
  seedCrackle: { tail: 'spatial', seconds: 0.4, fill: () => {}, desc: 'thorny crackle' },
  seedChime: { tail: 'spatial', seconds: 1.9, fill: F.fillSeedChime, desc: 'bright glass chime' },
  enemyHit: { tail: 'spatial', seconds: 0.7, fill: () => {}, desc: 'muffled thwack + dizzy falling tone' },
  launchAim: { tail: 'centre', seconds: 1.0, fill: F.fillLaunchAim, desc: 'time-freeze whoosh sinking two octaves' },
  launch: { tail: 'centre', seconds: 1.7, fill: F.fillLaunch, desc: 'rising whoosh + bright ping' },
  fizzle: { tail: 'centre', seconds: 0.4, fill: () => {}, desc: 'soft muted tick' },
  scrape: { tail: 'centre', seconds: 2.0, fill: (p) => { p.dur = leaseDur; }, desc: 'bark friction (lease, 1.6 s)' },
  aimSustain: {
    tail: 'centre', seconds: 2.2, desc: 'hushed ringing chord (lease, 1.6 s)',
    fill: (p, h) => {
      F.fillAim(p, h);
      p.dur = leaseDur;
    },
  },
  heartbeat: { tail: 'centre', seconds: 2.8, fill: (p) => { p.dur = 2; }, desc: 'soft low lub-dub, speeding up (lease, 2 s)' },
  rattle: { tail: 'spatial', seconds: 0.9, fill: (p) => { p.dur = 0.6; }, desc: 'rising thorny buzz (windup, 0.6 s)' },
  pad: {
    tail: 'slotC', seconds: 11, desc: 'breathy pad chord (glade: 2.2 s attack, 5.2 s hold, 3 s release)',
    fill: (p, h) => F.fillPad(p, h, F.PAD_STYLES.glade, CHORD, 0.37),
  },
  bell: {
    tail: 'slot', seconds: 6.5, desc: 'glass bell melody note',
    fill: (p, h) => F.fillBell(p, h.note(h.chordDegreeFrom(81)), 1.8, 1),
  },
  piano: { tail: 'slot', seconds: 3, fill: (p, h) => F.fillPianoPhrase(p, h.voice(2, 0), 1.4, 1), desc: 'felt piano note' },
  pulse: { tail: 'slotC', seconds: 1.3, fill: (p, h) => F.fillPulse(p, h, 1), desc: 'soft low pulse' },
  drone: {
    tail: 'slotC', seconds: 12.5, desc: 'dark reed drone (rootwell: 3.5 s attack, 4.3 s hold, 4 s release)',
    fill: (p, h) => F.fillDrone(p, h, F.DRONE_STYLES.rootwell, CHORD),
  },
  drip: { tail: 'slot', seconds: 1.5, fill: (p, h) => F.fillDrip(p, h, 3, 0.37, 1), desc: 'resonant pitched drip' },
  shimmer: { tail: 'slot', seconds: 3, fill: (p, h) => F.fillShimmer(p, h, 3, 0.37, 1), desc: 'whole-tone tremolo shimmer' },
  harmonics: {
    tail: 'slotC', seconds: 11, desc: 'quiet natural harmonics swelling (3 s attack, 4.5 s hold, 3 s release)',
    fill: (p, h) => F.fillHarmonics(p, h, CHORD, 0.37),
  },
  windBed: { tail: 'centre', seconds: 13.5, fill: (p) => { p.gain = 1; p.dur = 8; }, desc: 'wind bed (lease, 8 s)' },
  cricketBed: { tail: 'centre', seconds: 10.5, fill: (p) => { p.gain = 1; p.dur = 6; }, desc: 'cricket chorus (lease, 6 s)' },
  owl: {
    tail: 'ambient', seconds: 2.2, desc: 'distant owl, three hoots',
    fill: (p, h) => {
      F.fillOwl(p, h, true);
      p.variant = 0.9;
    },
  },
  creak: { tail: 'ambient', seconds: 1.5, fill: () => {}, desc: 'slow wood creak' },
  waterDrip: { tail: 'ambient', seconds: 0.6, fill: () => {}, desc: 'water drip plink' },
};

/** Which area's harmony a demo uses (the mood the patch mostly plays in). */
export const DEMO_AREA: Partial<Record<PatchId, AreaGradeId>> = {
  drip: 'rootwell', drone: 'rootwell', shimmer: 'veil', harmonics: 'veil', pulse: 'gully', goal: 'shrine',
};

export interface Rendered {
  channels: Float32Array[];
  /** Release end (s) returned by the patch, relative to the render start. */
  tEnd: number;
  start: number;
}

/**
 * Render one patch offline at 48 kHz through its engine tail (centre gain or panner at the worst-case
 * pan), with the engine's rule applied: every source stops 5 ms after the release end.
 */
export async function renderPatch(Offline: OfflineCtor, id: PatchId, seed = 1234, area?: AreaGradeId): Promise<Rendered> {
  const demo = DEMOS[id];
  const start = 0.05;
  const len = Math.round((start + demo.seconds) * SR);
  const ctx = new Offline(2, len, SR);
  const g = ctx as unknown as GraphPort;
  const buffers = new BufferBuilder(g, seed);
  buffers.finish();
  const params = createParams({ noise: buffers.noise, waves: createWaves(g) });
  resetParams(params);
  const h = new Harmony();
  h.set(area ?? DEMO_AREA[id] ?? 'glade', 0);
  params.variant = 0.37;
  demo.fill(params, h);
  const tail = tailNode(g, demo.tail);
  tail.connect(g.destination);
  const kill = g.createGain();
  kill.connect(tail);
  const sink = new RecordingSink();
  const tEnd = PATCHES[id].fn(g, kill, start, params, sink);
  if (tEnd > 0) for (const s of sink.sources) s.stop(tEnd + AUDIO_TUNING.stopPad);
  const out = await ctx.startRendering();
  return { channels: [out.getChannelData(0), out.getChannelData(1)], tEnd, start };
}

export function tailNode(g: GraphPort, tail: Tail): AudioNodePort {
  if (tail === 'centre') {
    const c = g.createGain();
    c.gain.value = AUDIO_TUNING.centreGain;
    return c;
  }
  const p = g.createStereoPanner();
  p.pan.value = TAIL_PAN[tail];
  return p;
}
