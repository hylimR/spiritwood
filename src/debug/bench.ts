import type { BenchResult } from '../contracts/debug.ts';
import type { LevelData } from '../contracts/level.ts';
import { VIEW_H } from '../config.ts';
import { clamp, clamp01 } from '../core/math.ts';
import { sortedPercentile, sortedWorstPercentMean } from './frameTimer.ts';

export interface BenchWaypoint {
  x: number;
  y: number;
}

/** Half the widest view the bench assumes (16:9), so the path starts and ends where the camera can. */
const HALF_VIEW_W = (VIEW_H * 16) / 9 / 2;
const HALF_VIEW_H = VIEW_H / 2;
/** Frames recorded per second of bench before the buffers grow (covers 240 Hz uncapped). */
const FRAMES_PER_SEC_CAPACITY = 250;

function camRange(size: number, half: number): [number, number] {
  return size > 2 * half ? [half, size - half] : [size / 2, size / 2];
}

/**
 * Waypoints for the flythrough: the level's left edge, every grade zone's centre (left → right) at a
 * comfortable height, then the right edge. Falls back to checkpoints / goal, then a straight line.
 */
export function benchWaypoints(level: LevelData): BenchWaypoint[] {
  const [x0, x1] = camRange(level.pxWidth, HALF_VIEW_W);
  const [y0, y1] = camRange(level.pxHeight, HALF_VIEW_H);
  const mids: BenchWaypoint[] = [];
  if (level.gradeZones.length > 0) {
    for (const z of level.gradeZones) mids.push({ x: z.x + z.w / 2, y: z.y + z.h / 2 });
  } else {
    for (const c of level.checkpoints) mids.push({ x: c.x + c.w / 2, y: c.y + c.h / 2 - VIEW_H / 4 });
    if (level.goal) mids.push({ x: level.goal.x + level.goal.w / 2, y: level.goal.y + level.goal.h / 2 - VIEW_H / 4 });
  }
  mids.sort((a, b) => a.x - b.x);
  const mid = (y0 + y1) / 2;
  const first = mids[0];
  const last = mids[mids.length - 1];
  const pts: BenchWaypoint[] = [{ x: x0, y: clamp(first ? first.y : mid, y0, y1) }];
  for (const p of mids) pts.push({ x: clamp(p.x, x0, x1), y: clamp(p.y, y0, y1) });
  pts.push({ x: x1, y: clamp(last ? last.y : mid, y0, y1) });

  const out: BenchWaypoint[] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (!prev || Math.hypot(p.x - prev.x, p.y - prev.y) > 1) out.push(p);
  }
  if (out.length === 1) out.push({ x: (out[0] as BenchWaypoint).x + 1, y: (out[0] as BenchWaypoint).y });
  return out;
}

/** Fritsch–Carlson monotone cubic tangents: no overshoot, so each segment stays within its endpoints. */
function monotoneTangents(t: Float64Array, v: Float64Array, out: Float64Array): void {
  const n = t.length;
  const d = new Float64Array(n - 1);
  for (let k = 0; k < n - 1; k++) d[k] = ((v[k + 1] as number) - (v[k] as number)) / ((t[k + 1] as number) - (t[k] as number));
  out[0] = d[0] as number;
  out[n - 1] = d[n - 2] as number;
  for (let k = 1; k < n - 1; k++) {
    const a = d[k - 1] as number;
    const b = d[k] as number;
    out[k] = a * b <= 0 ? 0 : (a + b) / 2;
  }
  for (let k = 0; k < n - 1; k++) {
    const dk = d[k] as number;
    if (dk === 0) {
      out[k] = 0;
      out[k + 1] = 0;
      continue;
    }
    const a = (out[k] as number) / dk;
    const b = (out[k + 1] as number) / dk;
    const h = a * a + b * b;
    if (h > 9) {
      const tau = 3 / Math.sqrt(h);
      out[k] = tau * a * dk;
      out[k + 1] = tau * b * dk;
    }
  }
}

/**
 * Scripted camera flythrough for `?bench` (ARCHITECTURE.md §6). Builds a smooth path through all
 * five areas from the level's grade zones / checkpoints, advances along it by sim time, and records
 * frame times. The orchestrator applies `position` via GameWorld.camera.setOverride each tick.
 *
 * The path is a monotone cubic through the waypoints, parameterised by chord length and eased
 * (smoothstep) over `durationSec`, so it starts and ends at rest and never leaves the level.
 */
export class BenchRunner {
  readonly durationSec: number;
  readonly waypoints: readonly BenchWaypoint[];

  private readonly knots: Float64Array;
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly mx: Float64Array;
  private readonly my: Float64Array;
  private readonly levelW: number;
  private readonly levelH: number;
  private maxT = 0;

  private frameMs: Float64Array;
  private scale: Float64Array;
  private gpu: Float64Array;
  private late: Uint8Array;
  private frames = 0;

  constructor(level: LevelData, durationSec = 30) {
    this.durationSec = durationSec > 0 ? durationSec : 30;
    this.levelW = level.pxWidth;
    this.levelH = level.pxHeight;
    const pts = benchWaypoints(level);
    this.waypoints = pts;
    const n = pts.length;
    this.knots = new Float64Array(n);
    this.px = new Float64Array(n);
    this.py = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const p = pts[i] as BenchWaypoint;
      this.px[i] = p.x;
      this.py[i] = p.y;
      if (i > 0) {
        const q = pts[i - 1] as BenchWaypoint;
        this.knots[i] = (this.knots[i - 1] as number) + Math.hypot(p.x - q.x, p.y - q.y);
      }
    }
    this.mx = new Float64Array(n);
    this.my = new Float64Array(n);
    monotoneTangents(this.knots, this.px, this.mx);
    monotoneTangents(this.knots, this.py, this.my);

    const capacity = Math.ceil(this.durationSec * FRAMES_PER_SEC_CAPACITY) + 64;
    this.frameMs = new Float64Array(capacity);
    this.scale = new Float64Array(capacity);
    this.gpu = new Float64Array(capacity);
    this.late = new Uint8Array(capacity);
  }

  /** Total path length in world units. */
  get length(): number {
    return this.knots[this.knots.length - 1] as number;
  }

  get done(): boolean {
    return this.maxT >= this.durationSec;
  }

  get framesRecorded(): number {
    return this.frames;
  }

  /** Camera centre for sim time `t` seconds into the run. */
  positionAt(t: number, out: BenchWaypoint): BenchWaypoint {
    if (t > this.maxT) this.maxT = t;
    const u = clamp01(t / this.durationSec);
    const s = u * u * (3 - 2 * u) * this.length;
    const knots = this.knots;
    const last = knots.length - 1;
    let k = 0;
    while (k < last - 1 && s > (knots[k + 1] as number)) k++;
    const t0 = knots[k] as number;
    const h = (knots[k + 1] as number) - t0;
    const f = h > 0 ? clamp01((s - t0) / h) : 0;
    const f2 = f * f;
    const f3 = f2 * f;
    const h00 = 2 * f3 - 3 * f2 + 1;
    const h10 = f3 - 2 * f2 + f;
    const h01 = -2 * f3 + 3 * f2;
    const h11 = f3 - f2;
    const x = h00 * (this.px[k] as number) + h10 * h * (this.mx[k] as number)
      + h01 * (this.px[k + 1] as number) + h11 * h * (this.mx[k + 1] as number);
    const y = h00 * (this.py[k] as number) + h10 * h * (this.my[k] as number)
      + h01 * (this.py[k + 1] as number) + h11 * h * (this.my[k + 1] as number);
    out.x = clamp(x, 0, this.levelW);
    out.y = clamp(y, 0, this.levelH);
    return out;
  }

  /** Record one rendered frame. */
  record(frameMs: number, lateFrames: number, renderScale: number, gpuMs: number): void {
    if (this.frames === this.frameMs.length) this.grow();
    const i = this.frames++;
    this.frameMs[i] = frameMs;
    this.late[i] = lateFrames > 0 ? 1 : 0;
    this.scale[i] = renderScale;
    this.gpu[i] = gpuMs;
  }

  result(preset: string, gpu: string, userAgent: string): BenchResult {
    const n = this.frames;
    let totalMs = 0;
    let late = 0;
    let scale = 0;
    let gpuSum = 0;
    let gpuN = 0;
    for (let i = 0; i < n; i++) {
      totalMs += this.frameMs[i] as number;
      late += this.late[i] as number;
      scale += this.scale[i] as number;
      const g = this.gpu[i] as number;
      if (g >= 0) {
        gpuSum += g;
        gpuN++;
      }
    }
    const sorted = this.frameMs.slice(0, n).sort();
    const worst = sortedWorstPercentMean(sorted, n);
    const seconds = totalMs / 1000;
    return {
      preset,
      seconds,
      frames: n,
      fpsAvg: seconds > 0 ? n / seconds : 0,
      fps1pLow: n > 0 && worst > 0 ? 1000 / worst : 0,
      frameMsP50: n > 0 ? sortedPercentile(sorted, n, 50) : 0,
      frameMsP95: n > 0 ? sortedPercentile(sorted, n, 95) : 0,
      frameMsP99: n > 0 ? sortedPercentile(sorted, n, 99) : 0,
      lateFramePct: n > 0 ? (100 * late) / n : 0,
      renderScaleAvg: n > 0 ? scale / n : 0,
      gpuMsAvg: gpuN > 0 ? gpuSum / gpuN : -1,
      userAgent,
      gpu,
    };
  }

  private grow(): void {
    const cap = this.frameMs.length * 2;
    const f = new Float64Array(cap);
    f.set(this.frameMs);
    this.frameMs = f;
    const s = new Float64Array(cap);
    s.set(this.scale);
    this.scale = s;
    const g = new Float64Array(cap);
    g.set(this.gpu);
    this.gpu = g;
    const l = new Uint8Array(cap);
    l.set(this.late);
    this.late = l;
  }
}
