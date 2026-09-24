import type { SimEvent, SimEventQueueView, SimEventType } from '../contracts/sim.ts';
import { todo } from './todo.ts';

/**
 * Fixed-capacity pool of SimEvent records. `push` fills the next preallocated record (no allocation);
 * when full, further pushes are dropped and counted. Drained and cleared once per render frame.
 */
export class SimEventQueue implements SimEventQueueView {
  readonly capacity: number;

  constructor(capacity = 64) {
    this.capacity = capacity;
    todo('SIM', 'SimEventQueue');
  }

  get count(): number {
    return todo('SIM', 'SimEventQueue.count');
  }

  /** Events dropped since the last clear() because the queue was full. */
  get dropped(): number {
    return todo('SIM', 'SimEventQueue.dropped');
  }

  push(type: SimEventType, tick: number, x: number, y: number, a = 0, b = 0, id = -1): void {
    void type; void tick; void x; void y; void a; void b; void id;
    todo('SIM', 'SimEventQueue.push');
  }

  get(index: number): SimEvent {
    void index;
    return todo('SIM', 'SimEventQueue.get');
  }

  clear(): void {
    todo('SIM', 'SimEventQueue.clear');
  }
}
