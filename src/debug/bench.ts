import type { BenchResult } from '../contracts/debug.ts';
import type { LevelData } from '../contracts/level.ts';
import { todo } from '../core/todo.ts';

export interface BenchWaypoint {
  x: number;
  y: number;
}

/**
 * Scripted camera flythrough for `?bench` (ARCHITECTURE.md §6). Builds a smooth path through all
 * five areas from the level's grade zones / checkpoints, advances along it by sim time, and records
 * frame times. The orchestrator applies `position` via GameWorld.camera.setOverride each tick.
 */
export class BenchRunner {
  readonly durationSec: number;

  constructor(level: LevelData, durationSec = 30) {
    this.durationSec = durationSec;
    void level;
    todo('PIPE', 'BenchRunner');
  }

  get done(): boolean {
    return todo('PIPE', 'BenchRunner.done');
  }

  /** Camera centre for sim time `t` seconds into the run. */
  positionAt(t: number, out: BenchWaypoint): BenchWaypoint {
    void t; void out;
    return todo('PIPE', 'BenchRunner.positionAt');
  }

  /** Record one rendered frame. */
  record(frameMs: number, lateFrames: number, renderScale: number, gpuMs: number): void {
    void frameMs; void lateFrames; void renderScale; void gpuMs;
    todo('PIPE', 'BenchRunner.record');
  }

  result(preset: string, gpu: string, userAgent: string): BenchResult {
    void preset; void gpu; void userAgent;
    return todo('PIPE', 'BenchRunner.result');
  }
}
