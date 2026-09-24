/**
 * In-house 2D bone rig (ARCHITECTURE.md §5.6): skeleton with preallocated world matrices, keyframed
 * clips sampled with cubic Hermite / ease curves, and a cross-fading animator. Pure (no Pixi) and
 * allocation-free per frame.
 *
 * Conventions: y down, angles in radians (positive = clockwise on screen), a bone points along its
 * local +x axis, matrices are [a, b, c, d, tx, ty] (x' = a·x + c·y + tx, y' = b·x + d·y + ty).
 */

export interface BoneDef {
  name: string;
  /** Index of the parent bone (−1 = root); always lower than the bone's own index. */
  parent: number;
  /** Rest transform relative to the parent. */
  x: number;
  y: number;
  rotation: number;
  length: number;
}

/** A bone authored in world space at rest (unit scale), converted with `bonesFromWorldRest`. */
export interface WorldBoneDef {
  name: string;
  parent: string | null;
  x: number;
  y: number;
  angle: number;
  length: number;
}

/** Convert world-space rest bones (parents first) into parent-relative BoneDefs. */
export function bonesFromWorldRest(defs: readonly WorldBoneDef[]): BoneDef[] {
  const out: BoneDef[] = [];
  const index = new Map<string, number>();
  for (const d of defs) {
    if (index.has(d.name)) throw new Error(`Duplicate bone ${d.name}`);
    let parent = -1;
    let x = d.x;
    let y = d.y;
    let rotation = d.angle;
    if (d.parent !== null) {
      const pi = index.get(d.parent);
      if (pi === undefined) throw new Error(`Bone ${d.name}: parent ${d.parent} must come first`);
      const p = defs[pi] as WorldBoneDef;
      const dx = d.x - p.x;
      const dy = d.y - p.y;
      const cos = Math.cos(-p.angle);
      const sin = Math.sin(-p.angle);
      x = dx * cos - dy * sin;
      y = dx * sin + dy * cos;
      rotation = d.angle - p.angle;
      parent = pi;
    }
    index.set(d.name, out.length);
    out.push({ name: d.name, parent, x, y, rotation, length: d.length });
  }
  return out;
}

/** Pose channels per bone, in this order inside `Skeleton.pose`. */
export const CH = { x: 0, y: 1, rot: 2, sx: 3, sy: 4 } as const;
export type ChannelName = keyof typeof CH;
export const CHANNELS = 5;

export class Skeleton {
  readonly bones: readonly BoneDef[];
  readonly count: number;
  /** Local pose per bone: [x, y, rot, sx, sy]. */
  readonly pose: Float32Array;
  /** World matrix per bone: [a, b, c, d, tx, ty]. */
  readonly world: Float32Array;
  private readonly names = new Map<string, number>();

  constructor(bones: readonly BoneDef[]) {
    bones.forEach((b, i) => {
      if (b.parent >= i) throw new Error(`Bone ${b.name}: parent index ${b.parent} must be < ${i}`);
      this.names.set(b.name, i);
    });
    this.bones = bones;
    this.count = bones.length;
    this.pose = new Float32Array(this.count * CHANNELS);
    this.world = new Float32Array(this.count * 6);
    this.resetPose();
  }

  indexOf(name: string): number {
    const i = this.names.get(name);
    if (i === undefined) throw new Error(`Unknown bone ${name}`);
    return i;
  }

  resetPose(): void {
    const p = this.pose;
    for (let i = 0; i < this.count; i++) {
      const b = this.bones[i] as BoneDef;
      const o = i * CHANNELS;
      p[o] = b.x;
      p[o + 1] = b.y;
      p[o + 2] = b.rotation;
      p[o + 3] = 1;
      p[o + 4] = 1;
    }
  }

  /**
   * Add clip deltas (see Animator.apply: x/y/rot added, sx/sy stored as scale − 1) on top of the rest
   * pose: pose = rest + delta, scale = 1 + delta.
   */
  setPoseFromDeltas(deltas: Float32Array): void {
    const p = this.pose;
    for (let i = 0; i < this.count; i++) {
      const b = this.bones[i] as BoneDef;
      const o = i * CHANNELS;
      p[o] = b.x + (deltas[o] as number);
      p[o + 1] = b.y + (deltas[o + 1] as number);
      p[o + 2] = b.rotation + (deltas[o + 2] as number);
      p[o + 3] = 1 + (deltas[o + 3] as number);
      p[o + 4] = 1 + (deltas[o + 4] as number);
    }
  }

  /** Evaluate world matrices from the pose; `root` (6 numbers) is prepended to root bones. */
  evaluate(root?: ArrayLike<number>): void {
    const p = this.pose;
    const w = this.world;
    for (let i = 0; i < this.count; i++) {
      const o = i * CHANNELS;
      const cos = Math.cos(p[o + 2] as number);
      const sin = Math.sin(p[o + 2] as number);
      const sx = p[o + 3] as number;
      const sy = p[o + 4] as number;
      const la = cos * sx;
      const lb = sin * sx;
      const lc = -sin * sy;
      const ld = cos * sy;
      const lx = p[o] as number;
      const ly = p[o + 1] as number;
      const parent = (this.bones[i] as BoneDef).parent;
      const m = i * 6;
      let pa = 1;
      let pb = 0;
      let pc = 0;
      let pd = 1;
      let px = 0;
      let py = 0;
      if (parent >= 0) {
        const q = parent * 6;
        pa = w[q] as number; pb = w[q + 1] as number; pc = w[q + 2] as number; pd = w[q + 3] as number;
        px = w[q + 4] as number; py = w[q + 5] as number;
      } else if (root) {
        pa = root[0] as number; pb = root[1] as number; pc = root[2] as number; pd = root[3] as number;
        px = root[4] as number; py = root[5] as number;
      }
      w[m] = pa * la + pc * lb;
      w[m + 1] = pb * la + pd * lb;
      w[m + 2] = pa * lc + pc * ld;
      w[m + 3] = pb * lc + pd * ld;
      w[m + 4] = pa * lx + pc * ly + px;
      w[m + 5] = pb * lx + pd * ly + py;
    }
  }

  worldX(i: number): number {
    return this.world[i * 6 + 4] as number;
  }

  worldY(i: number): number {
    return this.world[i * 6 + 5] as number;
  }

  /** World angle of the bone's +x axis. */
  worldAngle(i: number): number {
    return Math.atan2(this.world[i * 6 + 1] as number, this.world[i * 6] as number);
  }

  /** World position of a point given in bone-local coordinates. */
  pointX(i: number, lx: number, ly: number): number {
    const m = i * 6;
    return (this.world[m] as number) * lx + (this.world[m + 2] as number) * ly + (this.world[m + 4] as number);
  }

  pointY(i: number, lx: number, ly: number): number {
    const m = i * 6;
    return (this.world[m + 1] as number) * lx + (this.world[m + 3] as number) * ly + (this.world[m + 5] as number);
  }

  tipX(i: number): number {
    return this.pointX(i, (this.bones[i] as BoneDef).length, 0);
  }

  tipY(i: number): number {
    return this.pointY(i, (this.bones[i] as BoneDef).length, 0);
  }
}

export const EASE = { linear: 0, smooth: 1, hermite: 2, step: 3 } as const;
export type EaseName = keyof typeof EASE;

export interface ChannelDef {
  bone: string;
  ch: ChannelName;
  /** Flat [phase, value, …] with phase in 0..1 of the clip, ascending. sx/sy values are scales. */
  keys: readonly number[];
  ease?: EaseName;
}

export interface ClipDef {
  name: string;
  /** Seconds per cycle (loop) or total length. */
  duration: number;
  loop: boolean;
  channels: readonly ChannelDef[];
}

/** Keyframed bone channels compiled to typed arrays. Values are deltas from the rest pose. */
export class Clip {
  readonly name: string;
  readonly duration: number;
  readonly loop: boolean;
  private readonly target: Int32Array;
  private readonly start: Int32Array;
  private readonly count: Int32Array;
  private readonly ease: Uint8Array;
  private readonly times: Float32Array;
  private readonly values: Float32Array;
  private readonly slopes: Float32Array;

  constructor(def: ClipDef, skeleton: Skeleton) {
    this.name = def.name;
    this.duration = def.duration;
    this.loop = def.loop;
    const n = def.channels.length;
    this.target = new Int32Array(n);
    this.start = new Int32Array(n);
    this.count = new Int32Array(n);
    this.ease = new Uint8Array(n);
    let total = 0;
    for (const c of def.channels) {
      if (c.keys.length < 2 || c.keys.length % 2 !== 0) throw new Error(`Clip ${def.name}: bad keys for ${c.bone}.${c.ch}`);
      total += c.keys.length / 2;
    }
    this.times = new Float32Array(total);
    this.values = new Float32Array(total);
    this.slopes = new Float32Array(total);
    let k = 0;
    def.channels.forEach((c, i) => {
      const isScale = c.ch === 'sx' || c.ch === 'sy';
      this.target[i] = skeleton.indexOf(c.bone) * CHANNELS + CH[c.ch];
      this.start[i] = k;
      this.count[i] = c.keys.length / 2;
      this.ease[i] = EASE[c.ease ?? 'hermite'];
      let prevT = -Infinity;
      for (let j = 0; j < c.keys.length; j += 2) {
        const t = c.keys[j] as number;
        if (t < prevT || t < 0 || t > 1) throw new Error(`Clip ${def.name}: key phases must ascend within 0..1`);
        prevT = t;
        this.times[k] = t;
        this.values[k] = (c.keys[j + 1] as number) - (isScale ? 1 : 0);
        k++;
      }
      this.computeSlopes(i);
    });
  }

  /** Catmull-Rom style finite-difference tangents (cyclic for loops, flat at the ends otherwise). */
  private computeSlopes(ch: number): void {
    const s = this.start[ch] as number;
    const n = this.count[ch] as number;
    const t = this.times;
    const v = this.values;
    for (let j = 0; j < n; j++) {
      const i = s + j;
      let prevT: number;
      let prevV: number;
      let nextT: number;
      let nextV: number;
      if (j > 0) {
        prevT = t[i - 1] as number;
        prevV = v[i - 1] as number;
      } else if (this.loop) {
        prevT = (t[s + n - 1] as number) - 1;
        prevV = v[s + n - 1] as number;
      } else {
        this.slopes[i] = 0;
        continue;
      }
      if (j < n - 1) {
        nextT = t[i + 1] as number;
        nextV = v[i + 1] as number;
      } else if (this.loop) {
        nextT = (t[s] as number) + 1;
        nextV = v[s] as number;
      } else {
        this.slopes[i] = 0;
        continue;
      }
      const ti = t[i] as number;
      const vi = v[i] as number;
      const a = ti - prevT > 1e-6 ? (vi - prevV) / (ti - prevT) : 0;
      const b = nextT - ti > 1e-6 ? (nextV - vi) / (nextT - ti) : 0;
      this.slopes[i] = (a + b) / 2;
    }
  }

  /** Value of channel `ch` at `phase` (0..1; wrapped for loops, clamped otherwise). */
  valueAt(ch: number, phase: number): number {
    const s = this.start[ch] as number;
    const n = this.count[ch] as number;
    const t = this.times;
    const v = this.values;
    let p = phase;
    if (this.loop) p -= Math.floor(p);
    else p = p < 0 ? 0 : p > 1 ? 1 : p;

    let i0: number;
    let i1: number;
    let t0: number;
    let t1: number;
    const first = t[s] as number;
    const last = t[s + n - 1] as number;
    if (p < first || p >= last) {
      if (!this.loop) return (p < first ? v[s] : v[s + n - 1]) as number;
      i0 = s + n - 1;
      i1 = s;
      t0 = last;
      t1 = first + 1;
      if (p < first) p += 1;
    } else {
      let j = s;
      while (j < s + n - 2 && p >= (t[j + 1] as number)) j++;
      i0 = j;
      i1 = j + 1;
      t0 = t[i0] as number;
      t1 = t[i1] as number;
    }
    const h = t1 - t0;
    const u = h > 1e-6 ? (p - t0) / h : 0;
    const v0 = v[i0] as number;
    const v1 = v[i1] as number;
    switch (this.ease[ch]) {
      case EASE.linear:
        return v0 + (v1 - v0) * u;
      case EASE.smooth:
        return v0 + (v1 - v0) * u * u * (3 - 2 * u);
      case EASE.step:
        return v0;
      default: {
        const u2 = u * u;
        const u3 = u2 * u;
        return (2 * u3 - 3 * u2 + 1) * v0 + (u3 - 2 * u2 + u) * h * (this.slopes[i0] as number)
          + (-2 * u3 + 3 * u2) * v1 + (u3 - u2) * h * (this.slopes[i1] as number);
      }
    }
  }

  get channelCount(): number {
    return this.target.length;
  }

  /** Add `weight` × this clip's deltas at `phase` into `out` (length bones × CHANNELS). */
  accumulate(out: Float32Array, phase: number, weight: number): void {
    for (let c = 0; c < this.target.length; c++) {
      const i = this.target[c] as number;
      out[i] = (out[i] as number) + this.valueAt(c, phase) * weight;
    }
  }
}

/**
 * State-driven clip blender. `play` cross-fades every weight linearly toward the new clip over
 * `fadeSec` (so two-clip fades always sum to 1); weights are normalised when sampling. Each clip keeps
 * its own phase (0..1), advanced by `update` or set directly (e.g. a run cycle driven by distance).
 */
export class Animator {
  readonly clips: readonly Clip[];
  readonly weights: Float32Array;
  readonly phases: Float64Array;
  private readonly targets: Float32Array;
  private readonly rates: Float32Array;
  private readonly speeds: Float32Array;
  private readonly deltas: Float32Array;
  private active = -1;

  constructor(skeleton: Skeleton, clips: readonly Clip[]) {
    this.clips = clips;
    const n = clips.length;
    this.weights = new Float32Array(n);
    this.targets = new Float32Array(n);
    this.rates = new Float32Array(n);
    this.speeds = new Float32Array(n).fill(1);
    this.phases = new Float64Array(n);
    this.deltas = new Float32Array(skeleton.count * CHANNELS);
  }

  get current(): number {
    return this.active;
  }

  /** Cross-fade to clip `index` over `fadeSec`. Restarts the clip if asked or if it was silent. */
  play(index: number, fadeSec = 0.1, restart = false): void {
    if (index === this.active && !restart) return;
    if (restart || (this.weights[index] as number) <= 0) this.phases[index] = 0;
    const snap = !(fadeSec > 0);
    const rate = snap ? 0 : 1 / fadeSec;
    for (let i = 0; i < this.clips.length; i++) {
      const target = i === index ? 1 : 0;
      this.targets[i] = target;
      this.rates[i] = rate;
      // A zero fade switches immediately (no Infinity × dt, which is NaN for a zero-length frame).
      if (snap) this.weights[i] = target;
    }
    this.active = index;
  }

  /** Snap to a clip with no fade (reset / respawn). */
  snap(index: number, phase = 0): void {
    this.weights.fill(0);
    this.targets.fill(0);
    this.weights[index] = 1;
    this.targets[index] = 1;
    this.phases[index] = phase;
    this.active = index;
  }

  /** Playback speed multiplier for a clip (1 = its authored duration). */
  setSpeed(index: number, speed: number): void {
    this.speeds[index] = speed;
  }

  setPhase(index: number, phase: number): void {
    this.phases[index] = phase;
  }

  /** True once a non-looping clip has played through. */
  finished(index: number): boolean {
    const c = this.clips[index] as Clip;
    return !c.loop && (this.phases[index] as number) >= 1;
  }

  update(dt: number): void {
    for (let i = 0; i < this.clips.length; i++) {
      const w = this.weights[i] as number;
      const target = this.targets[i] as number;
      if (w !== target && dt > 0) {
        const step = (this.rates[i] as number) * dt;
        this.weights[i] = w < target ? Math.min(target, w + step) : Math.max(target, w - step);
      }
      if ((this.weights[i] as number) > 0 || target > 0) {
        const c = this.clips[i] as Clip;
        const p = (this.phases[i] as number) + (dt * (this.speeds[i] as number)) / c.duration;
        this.phases[i] = c.loop ? p - Math.floor(p) : Math.min(1, p);
      }
    }
  }

  /** Blend all weighted clips into `skeleton.pose` (rest + normalised weighted deltas). */
  apply(skeleton: Skeleton): void {
    const d = this.deltas;
    d.fill(0);
    let total = 0;
    for (let i = 0; i < this.clips.length; i++) total += this.weights[i] as number;
    if (total > 0) {
      for (let i = 0; i < this.clips.length; i++) {
        const w = this.weights[i] as number;
        if (w > 0) (this.clips[i] as Clip).accumulate(d, this.phases[i] as number, w / total);
      }
    }
    skeleton.setPoseFromDeltas(d);
  }
}
