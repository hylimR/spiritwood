import type { SimEvent, SimEventQueueView, SimEventType } from '../contracts/sim.ts';

/**
 * Fixed-capacity pool of SimEvent records. `push` fills the next preallocated record (no allocation);
 * when full, further pushes are dropped and counted. Drained and cleared once per render frame.
 */
export class SimEventQueue implements SimEventQueueView {
  readonly capacity: number;
  private readonly records: SimEvent[];
  private size = 0;
  private droppedCount = 0;

  constructor(capacity = 64) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.records = new Array<SimEvent>(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.records[i] = { type: 1, tick: 0, x: 0, y: 0, a: 0, b: 0, id: -1 };
    }
  }

  get count(): number {
    return this.size;
  }

  /** Events dropped since the last clear() because the queue was full. */
  get dropped(): number {
    return this.droppedCount;
  }

  push(type: SimEventType, tick: number, x: number, y: number, a = 0, b = 0, id = -1): void {
    if (this.size >= this.capacity) {
      this.droppedCount++;
      return;
    }
    const e = this.records[this.size++] as SimEvent;
    e.type = type;
    e.tick = tick;
    e.x = x;
    e.y = y;
    e.a = a;
    e.b = b;
    e.id = id;
  }

  get(index: number): SimEvent {
    if (index < 0 || index >= this.size) throw new RangeError(`SimEventQueue.get(${index}) out of range [0, ${this.size})`);
    return this.records[index] as SimEvent;
  }

  clear(): void {
    this.size = 0;
    this.droppedCount = 0;
  }
}
