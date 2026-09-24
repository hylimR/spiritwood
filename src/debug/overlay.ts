import type { FrameStats, RenderStats } from '../contracts/debug.ts';
import type { SimView } from '../contracts/sim.ts';
import { todo } from '../core/todo.ts';

/**
 * F3 debug overlay as a DOM panel (no Pixi text): fps avg / 1% low, frame/sim/render ms, GPU ms,
 * draw calls, fill estimate, render scale + RT size, canvas size, particles, texture MB, quality level,
 * player mode/velocity/grounded/wall, camera, tick. Includes a small canvas-2D frame-time graph.
 * DOM text updates at most 4 Hz; the graph may update every frame from a ring buffer.
 */
export class DebugOverlay {
  constructor(parent: HTMLElement) {
    void parent;
    todo('PIPE', 'DebugOverlay');
  }

  get visible(): boolean {
    return todo('PIPE', 'DebugOverlay.visible');
  }

  setVisible(visible: boolean): void {
    void visible;
    todo('PIPE', 'DebugOverlay.setVisible');
  }

  update(frame: FrameStats, render: RenderStats, sim: SimView, qualityLabel: string, nowSec: number, frameMs: number): void {
    void frame; void render; void sim; void qualityLabel; void nowSec; void frameMs;
    todo('PIPE', 'DebugOverlay.update');
  }

  destroy(): void {
    todo('PIPE', 'DebugOverlay.destroy');
  }
}
