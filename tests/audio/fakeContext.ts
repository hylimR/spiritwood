import type {
  AudioBufferPort, AudioContextPort, AudioNodePort, AudioParamPort, BiquadFilterNodePort, BufferSourcePort,
  ConvolverNodePort, DelayNodePort, DynamicsCompressorNodePort, FilterType, GainNodePort, OscillatorNodePort, OscType,
  PeriodicWavePort, StereoPannerNodePort, WaveShaperNodePort,
} from '../../src/audio/ports.ts';

/**
 * A strict fake Web Audio context behind the ports. It records the node graph and every parameter
 * automation event, and throws where browsers throw (or where browsers disagree), so a fake pass means a
 * browser pass: non-finite values, negative times, exponential ramps to 0, a ramp straight after a
 * setTargetAtTime (engines differ on its start point), start() twice, stop() before start(), a buffer set
 * twice, assigning oscillator type 'custom'.
 */

export type AutomationKind = 'value' | 'set' | 'lin' | 'exp' | 'target' | 'cancel';

export interface AutomationEvent {
  kind: AutomationKind;
  value: number;
  time: number;
  tau: number;
  /** Order of the call (global across params), for "who wrote when". */
  seq: number;
}

let SEQ = 0;

function finiteOrThrow(v: number, what: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new TypeError(`${what}: non-finite value ${v}`);
}

function timeOrThrow(t: number, what: string): void {
  finiteOrThrow(t, what);
  if (t < 0) throw new RangeError(`${what}: negative time ${t}`);
}

export class FakeParam implements AudioParamPort {
  readonly events: AutomationEvent[] = [];
  private v: number;
  readonly owner: FakeNode;
  readonly name: string;
  /** Nodes connected into this param (modulation). */
  readonly inputs: FakeNode[] = [];

  constructor(owner: FakeNode, name: string, value: number) {
    this.owner = owner;
    this.name = name;
    this.v = value;
  }

  get value(): number {
    return this.v;
  }

  set value(x: number) {
    finiteOrThrow(x, `${this.name}.value`);
    this.v = x;
    this.push('value', x, this.owner.ctx.currentTime, 0);
  }

  /** The value before any automation (what .value held at creation or first set). */
  initial = NaN;

  private push(kind: AutomationKind, value: number, time: number, tau: number): void {
    if (Number.isNaN(this.initial)) this.initial = kind === 'value' ? value : this.v;
    this.events.push({ kind, value, time, tau, seq: SEQ++ });
  }

  setValueAtTime(value: number, startTime: number): unknown {
    finiteOrThrow(value, `${this.name}.setValueAtTime value`);
    timeOrThrow(startTime, `${this.name}.setValueAtTime`);
    this.push('set', value, startTime, 0);
    return this;
  }

  linearRampToValueAtTime(value: number, endTime: number): unknown {
    finiteOrThrow(value, `${this.name}.linearRamp value`);
    timeOrThrow(endTime, `${this.name}.linearRamp`);
    this.guardAfterTarget(endTime, 'linearRamp');
    this.push('lin', value, endTime, 0);
    return this;
  }

  exponentialRampToValueAtTime(value: number, endTime: number): unknown {
    finiteOrThrow(value, `${this.name}.exponentialRamp value`);
    timeOrThrow(endTime, `${this.name}.exponentialRamp`);
    if (value === 0) throw new RangeError(`${this.name}.exponentialRamp to 0`);
    this.guardAfterTarget(endTime, 'exponentialRamp');
    this.push('exp', value, endTime, 0);
    return this;
  }

  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown {
    finiteOrThrow(target, `${this.name}.setTarget value`);
    timeOrThrow(startTime, `${this.name}.setTarget`);
    finiteOrThrow(timeConstant, `${this.name}.setTarget tau`);
    if (timeConstant < 0) throw new RangeError(`${this.name}.setTarget negative tau`);
    this.push('target', target, startTime, timeConstant);
    return this;
  }

  cancelScheduledValues(cancelTime: number): unknown {
    timeOrThrow(cancelTime, `${this.name}.cancelScheduledValues`);
    this.push('cancel', 0, cancelTime, 0);
    return this;
  }

  /** A ramp ending after a pending setTargetAtTime (with no set in between) is ambiguous across engines. */
  private guardAfterTarget(endTime: number, what: string): void {
    const live = this.timeline();
    let prev: AutomationEvent | undefined;
    for (const e of live) if (e.time <= endTime) prev = e;
    if (prev && prev.kind === 'target') throw new Error(`${this.name}.${what} directly after setTargetAtTime (anchor it with setValueAtTime)`);
  }

  /** Live timeline: timed events after applying cancels, sorted by time (stable). */
  timeline(): AutomationEvent[] {
    const out: AutomationEvent[] = [];
    for (const e of this.events) {
      if (e.kind === 'value') continue;
      if (e.kind === 'cancel') {
        for (let i = out.length - 1; i >= 0; i--) if ((out[i] as AutomationEvent).time >= e.time) out.splice(i, 1);
        continue;
      }
      out.push(e);
    }
    return out.sort((a, b) => a.time - b.time || a.seq - b.seq);
  }

  /** Automation value at time t (Web Audio semantics for the event kinds the engine uses). */
  valueAt(t: number): number {
    const tl = this.timeline();
    let v = Number.isNaN(this.initial) ? this.v : this.initial;
    // `.value` writes before the first timed event set the starting value.
    for (const e of this.events) if (e.kind === 'value' && (tl.length === 0 || e.seq < (tl[0] as AutomationEvent).seq)) v = e.value;
    let curT = 0;
    let target: AutomationEvent | null = null;
    for (let i = 0; i < tl.length; i++) {
      const e = tl[i] as AutomationEvent;
      if (e.kind === 'lin' || e.kind === 'exp') {
        if (target) {
          v = target.value + (v - target.value) * Math.exp(-(curT - target.time) / Math.max(target.tau, 1e-9));
          target = null;
        }
        if (t < e.time) {
          const f = (t - curT) / Math.max(e.time - curT, 1e-12);
          if (t < curT) return v;
          if (e.kind === 'lin') return v + (e.value - v) * f;
          return v === 0 || v * e.value < 0 ? v : v * Math.pow(e.value / v, f);
        }
        v = e.value;
        curT = e.time;
        continue;
      }
      if (e.time > t) break;
      if (target) {
        v = target.value + (v - target.value) * Math.exp(-(e.time - target.time) / Math.max(target.tau, 1e-9));
        target = null;
      }
      if (e.kind === 'set') {
        v = e.value;
        curT = e.time;
      } else {
        target = e;
        curT = e.time;
      }
    }
    if (target && t >= target.time) return target.value + (v - target.value) * Math.exp(-(t - target.time) / Math.max(target.tau, 1e-9));
    return v;
  }
}

export type FakeKind =
  | 'destination' | 'gain' | 'osc' | 'bufferSource' | 'biquad' | 'panner' | 'shaper' | 'compressor' | 'convolver' | 'delay';

export type Edge = { node: FakeNode } | { param: FakeParam };

export class FakeNode implements AudioNodePort {
  readonly id: number;
  readonly kind: FakeKind;
  readonly ctx: FakeContext;
  readonly outputs: Edge[] = [];
  readonly inputs: FakeNode[] = [];
  disconnected = false;
  readonly params: FakeParam[] = [];

  constructor(ctx: FakeContext, kind: FakeKind) {
    this.ctx = ctx;
    this.kind = kind;
    this.id = ctx.nodes.length;
    ctx.nodes.push(this);
    ctx.created[kind] = (ctx.created[kind] ?? 0) + 1;
  }

  protected param(name: string, value: number): FakeParam {
    const p = new FakeParam(this, `${this.kind}#${this.id}.${name}`, value);
    this.params.push(p);
    return p;
  }

  connect(destination: AudioNodePort): unknown;
  connect(destination: AudioParamPort): unknown;
  connect(destination: AudioNodePort | AudioParamPort): unknown {
    this.ctx.check('connect');
    if (destination instanceof FakeParam) {
      if (destination.owner.ctx !== this.ctx) throw new Error('connect across contexts');
      this.outputs.push({ param: destination });
      destination.inputs.push(this);
      return undefined;
    }
    if (!(destination instanceof FakeNode)) throw new TypeError('connect: not a node of this fake');
    if (destination.ctx !== this.ctx) throw new Error('connect across contexts');
    this.outputs.push({ node: destination });
    destination.inputs.push(this);
    return destination;
  }

  disconnect(): void {
    for (const e of this.outputs) {
      if ('node' in e) {
        const i = e.node.inputs.indexOf(this);
        if (i >= 0) e.node.inputs.splice(i, 1);
      } else {
        const i = e.param.inputs.indexOf(this);
        if (i >= 0) e.param.inputs.splice(i, 1);
      }
    }
    this.outputs.length = 0;
    this.disconnected = true;
  }

  /** Nodes this one feeds (audio connections only). */
  get targets(): FakeNode[] {
    const out: FakeNode[] = [];
    for (const e of this.outputs) if ('node' in e) out.push(e.node);
    return out;
  }
}

export class FakeGain extends FakeNode implements GainNodePort {
  readonly gain: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'gain');
    this.gain = this.param('gain', 1);
  }
}

export class FakeSource extends FakeNode {
  startTime: number | null = null;
  stopTime: number | null = null;
  stopCalls = 0;
  start(when = 0, offset = 0, duration?: number): void {
    this.ctx.check('start');
    timeOrThrow(when, 'start');
    finiteOrThrow(offset, 'start offset');
    if (duration !== undefined) finiteOrThrow(duration, 'start duration');
    if (this.startTime !== null) throw new Error('InvalidStateError: start() called twice');
    this.startTime = when;
  }
  stop(when = 0): void {
    timeOrThrow(when, 'stop');
    if (this.startTime === null) throw new Error('InvalidStateError: stop() before start()');
    this.stopTime = when;
    this.stopCalls++;
  }
}

export class FakeOscillator extends FakeSource implements OscillatorNodePort {
  private t: OscType = 'sine';
  readonly frequency: FakeParam;
  readonly detune: FakeParam;
  wave: PeriodicWavePort | null = null;
  constructor(ctx: FakeContext) {
    super(ctx, 'osc');
    this.frequency = this.param('frequency', 440);
    this.detune = this.param('detune', 0);
  }
  get type(): OscType {
    return this.t;
  }
  set type(v: OscType) {
    if (v === 'custom') throw new Error("InvalidStateError: type 'custom' needs setPeriodicWave");
    this.t = v;
  }
  setPeriodicWave(w: PeriodicWavePort): void {
    this.wave = w;
    this.t = 'custom';
  }
}

export class FakeBufferSource extends FakeSource implements BufferSourcePort {
  private b: AudioBufferPort | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'bufferSource');
    this.playbackRate = this.param('playbackRate', 1);
  }
  get buffer(): AudioBufferPort | null {
    return this.b;
  }
  set buffer(v: AudioBufferPort | null) {
    if (this.b && v) throw new Error('InvalidStateError: buffer set twice');
    this.b = v;
  }
}

export class FakeBiquad extends FakeNode implements BiquadFilterNodePort {
  type: FilterType = 'lowpass';
  readonly frequency: FakeParam;
  readonly detune: FakeParam;
  readonly Q: FakeParam;
  readonly gain: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'biquad');
    this.frequency = this.param('frequency', 350);
    this.detune = this.param('detune', 0);
    this.Q = this.param('Q', 1);
    this.gain = this.param('gain', 0);
  }
}

export class FakePanner extends FakeNode implements StereoPannerNodePort {
  readonly pan: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'panner');
    this.pan = this.param('pan', 0);
  }
}

export class FakeShaper extends FakeNode implements WaveShaperNodePort {
  private c: Float32Array<ArrayBuffer> | null = null;
  oversample: 'none' | '2x' | '4x' = 'none';
  constructor(ctx: FakeContext) {
    super(ctx, 'shaper');
  }
  get curve(): Float32Array<ArrayBuffer> | null {
    return this.c;
  }
  set curve(v: Float32Array<ArrayBuffer> | null) {
    if (v && v.length < 2) throw new Error('InvalidStateError: curve shorter than 2');
    if (v) for (let i = 0; i < v.length; i++) finiteOrThrow(v[i] as number, 'curve');
    this.c = v;
  }
}

export class FakeCompressor extends FakeNode implements DynamicsCompressorNodePort {
  readonly threshold: FakeParam;
  readonly knee: FakeParam;
  readonly ratio: FakeParam;
  readonly attack: FakeParam;
  readonly release: FakeParam;
  constructor(ctx: FakeContext) {
    super(ctx, 'compressor');
    this.threshold = this.param('threshold', -24);
    this.knee = this.param('knee', 30);
    this.ratio = this.param('ratio', 12);
    this.attack = this.param('attack', 0.003);
    this.release = this.param('release', 0.25);
  }
}

export class FakeConvolver extends FakeNode implements ConvolverNodePort {
  private b: AudioBufferPort | null = null;
  normalize = true;
  constructor(ctx: FakeContext) {
    super(ctx, 'convolver');
  }
  get buffer(): AudioBufferPort | null {
    return this.b;
  }
  set buffer(v: AudioBufferPort | null) {
    if (v && v.sampleRate !== this.ctx.sampleRate) throw new Error('NotSupportedError: impulse sample rate');
    if (v && v.numberOfChannels !== 1 && v.numberOfChannels !== 2 && v.numberOfChannels !== 4) throw new Error('NotSupportedError: impulse channels');
    this.b = v;
  }
}

export class FakeDelay extends FakeNode implements DelayNodePort {
  readonly delayTime: FakeParam;
  readonly max: number;
  constructor(ctx: FakeContext, max: number) {
    super(ctx, 'delay');
    if (!(max > 0 && max < 180)) throw new Error('NotSupportedError: maxDelayTime');
    this.max = max;
    this.delayTime = this.param('delayTime', 0);
  }
}

export class FakeBuffer implements AudioBufferPort {
  readonly length: number;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  private readonly data: Float32Array<ArrayBuffer>[] = [];
  constructor(ch: number, length: number, sampleRate: number) {
    if (!(ch >= 1 && ch <= 32) || !(length >= 1) || !(sampleRate >= 3000 && sampleRate <= 768000)) {
      throw new Error('NotSupportedError: createBuffer');
    }
    this.numberOfChannels = ch;
    this.length = length;
    this.sampleRate = sampleRate;
    for (let i = 0; i < ch; i++) this.data.push(new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array<ArrayBuffer> {
    const d = this.data[channel];
    if (!d) throw new Error('IndexSizeError');
    return d;
  }
}

export interface FakeOptions {
  state?: string;
  baseLatency?: number;
  outputLatency?: number;
  /** resume() moves the state to 'running' (and fires statechange) synchronously. */
  autoRun?: boolean;
  /** resume/suspend/close return rejected promises. */
  reject?: boolean;
}

export class FakeContext implements AudioContextPort {
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly nodes: FakeNode[] = [];
  readonly created: Partial<Record<FakeKind, number>> = {};
  readonly destination: FakeNode;
  state: string;
  baseLatency: number | undefined;
  outputLatency: number | undefined;
  onstatechange: ((ev: Event) => unknown) | null = null;
  resumeCalls = 0;
  suspendCalls = 0;
  closeCalls = 0;
  buffersCreated = 0;
  bufferBytes = 0;
  readonly autoRun: boolean;
  readonly reject: boolean;
  /** Throw from the named method on its next call (fail-closed tests). */
  failNext: string | null = null;

  constructor(opts: FakeOptions = {}) {
    this.state = opts.state ?? 'suspended';
    this.baseLatency = 'baseLatency' in opts ? opts.baseLatency : 0.01;
    this.outputLatency = 'outputLatency' in opts ? opts.outputLatency : 0.02;
    this.autoRun = opts.autoRun ?? false;
    this.reject = opts.reject ?? false;
    this.destination = new FakeNode(this, 'destination');
  }

  check(method: string): void {
    if (this.failNext === method) {
      this.failNext = null;
      throw new Error(`fake failure in ${method}`);
    }
  }

  /** Nodes created so far (the destination excluded). */
  get nodeCount(): number {
    return this.nodes.length - 1;
  }

  setState(s: string): void {
    this.state = s;
    this.onstatechange?.({} as Event);
  }

  private settle(): Promise<void> {
    return this.reject ? Promise.reject(new Error('fake rejection')) : Promise.resolve();
  }

  resume(): Promise<void> {
    this.check('resume');
    this.resumeCalls++;
    if (this.autoRun && this.state !== 'closed') this.setState('running');
    return this.settle();
  }
  suspend(): Promise<void> {
    this.suspendCalls++;
    return this.settle();
  }
  close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
    return this.settle();
  }

  createGain(): FakeGain {
    this.check('createGain');
    return new FakeGain(this);
  }
  createOscillator(): FakeOscillator {
    this.check('createOscillator');
    return new FakeOscillator(this);
  }
  createBufferSource(): FakeBufferSource {
    this.check('createBufferSource');
    return new FakeBufferSource(this);
  }
  createBiquadFilter(): FakeBiquad {
    return new FakeBiquad(this);
  }
  createStereoPanner(): FakePanner {
    return new FakePanner(this);
  }
  createWaveShaper(): FakeShaper {
    return new FakeShaper(this);
  }
  createDynamicsCompressor(): FakeCompressor {
    return new FakeCompressor(this);
  }
  createConvolver(): FakeConvolver {
    return new FakeConvolver(this);
  }
  createDelay(maxDelayTime = 1): FakeDelay {
    return new FakeDelay(this, maxDelayTime);
  }
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): FakeBuffer {
    const b = new FakeBuffer(numberOfChannels, length, sampleRate);
    this.buffersCreated++;
    this.bufferBytes += numberOfChannels * length * 4;
    return b;
  }
  createPeriodicWave(real: Float32Array<ArrayBuffer>, imag: Float32Array<ArrayBuffer>): PeriodicWavePort {
    if (real.length !== imag.length || real.length < 2) throw new Error('IndexSizeError: periodic wave');
    return {};
  }

  /** Every source node created so far. */
  sources(): FakeSource[] {
    return this.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
  }
}

/** A gesture target that records listeners and dispatches (trusted) events to them. */
export class FakeGestureTarget implements EventTarget {
  readonly listeners = new Map<string, { fn: EventListenerOrEventListenerObject; capture: boolean }[]>();
  addEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions): void {
    if (!fn) return;
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const list = this.listeners.get(type) ?? [];
    if (!list.some((l) => l.fn === fn && l.capture === capture)) list.push({ fn, capture });
    this.listeners.set(type, list);
  }
  removeEventListener(type: string, fn: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions): void {
    const capture = typeof opts === 'boolean' ? opts : !!opts?.capture;
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.findIndex((l) => l.fn === fn && l.capture === capture);
    if (i >= 0) list.splice(i, 1);
  }
  dispatchEvent(e: Event): boolean {
    for (const l of [...(this.listeners.get(e.type) ?? [])]) {
      if (typeof l.fn === 'function') l.fn(e);
      else l.fn.handleEvent(e);
    }
    return true;
  }
  /** Fire a synthetic event with the given trust. */
  fire(type: string, trusted = true): void {
    this.dispatchEvent({ type, isTrusted: trusted } as Event);
  }
  count(): number {
    let n = 0;
    for (const l of this.listeners.values()) n += l.length;
    return n;
  }
}
