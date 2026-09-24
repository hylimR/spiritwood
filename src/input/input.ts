import { createMetaInput, type InputDevice, type InputFrame, type MetaInput } from '../contracts/input.ts';
import { todo } from '../core/todo.ts';
import type { KeyBindings, PadBindings } from './bindings.ts';
import type { GetGamepads } from './gamepad.ts';

export interface InputManagerOptions {
  target?: EventTarget;
  getGamepads?: GetGamepads;
  keys?: KeyBindings;
  pad?: PadBindings;
}

/**
 * Merges keyboard + gamepad. Call `beginFrame()` once per render frame, then `nextTick()` once per sim
 * step. Jump/dash presses are latched and delivered to exactly one tick (the first one after the press);
 * if no tick runs this frame they carry over. `meta` holds per-frame UI actions.
 * moveX/moveY: keyboard digital (opposite keys cancel → 0) or gamepad analog, whichever has the larger
 * magnitude this frame.
 */
export class InputManager {
  readonly meta: MetaInput = createMetaInput();

  constructor(options: InputManagerOptions = {}) {
    void options;
    todo('SIM', 'InputManager');
  }

  get lastDevice(): InputDevice {
    return todo('SIM', 'InputManager.lastDevice');
  }

  beginFrame(): void {
    todo('SIM', 'InputManager.beginFrame');
  }

  nextTick(out: InputFrame): InputFrame {
    void out;
    return todo('SIM', 'InputManager.nextTick');
  }

  /** Drop latched edges (e.g. when closing a menu so the confirm press does not jump). */
  clearEdges(): void {
    todo('SIM', 'InputManager.clearEdges');
  }

  destroy(): void {
    todo('SIM', 'InputManager.destroy');
  }
}
