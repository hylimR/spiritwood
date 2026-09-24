import type { BenchResult } from '../contracts/debug.ts';
import type { SimView } from '../contracts/sim.ts';
import { todo } from '../core/todo.ts';

/**
 * DOM HUD layered over the canvas: spirit-light orb counter (glowing, pulses on collect), title card
 * (GAME_TITLE + "press any key / button"), controls hint that fades after first movement, completion
 * card (time, orbs), bench results card. Text changes only when values change.
 */
export class Hud {
  constructor(parent: HTMLElement) {
    void parent;
    todo('PIPE', 'Hud');
  }

  update(sim: SimView, nowSec: number): void {
    void sim; void nowSec;
    todo('PIPE', 'Hud.update');
  }

  showTitle(visible: boolean): void {
    void visible;
    todo('PIPE', 'Hud.showTitle');
  }

  showControls(device: 'keyboard' | 'gamepad'): void {
    void device;
    todo('PIPE', 'Hud.showControls');
  }

  showComplete(elapsedSec: number, orbs: number, total: number): void {
    void elapsedSec; void orbs; void total;
    todo('PIPE', 'Hud.showComplete');
  }

  showBench(result: BenchResult): void {
    void result;
    todo('PIPE', 'Hud.showBench');
  }

  destroy(): void {
    todo('PIPE', 'Hud.destroy');
  }
}
