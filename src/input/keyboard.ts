import type { GameAction } from '../contracts/input.ts';
import { todo } from '../core/todo.ts';
import { DEFAULT_KEYS, type KeyBindings } from './bindings.ts';

/**
 * Keyboard state from DOM key events on `target` (window in the game, a plain EventTarget in tests —
 * tests dispatch `Object.assign(new Event('keydown'), { code: 'Space' })`).
 * Presses are counted between `takePresses` calls, so a tap shorter than a frame is never lost.
 * Auto-repeat keydowns (`repeat: true`) are not presses. Game keys call preventDefault().
 * Clears held keys on `blur`.
 */
export class KeyboardSource {
  constructor(target: EventTarget, bindings: KeyBindings = DEFAULT_KEYS) {
    void target;
    void bindings;
    todo('SIM', 'KeyboardSource');
  }

  isDown(action: GameAction): boolean {
    void action;
    return todo('SIM', 'KeyboardSource.isDown');
  }

  /** Presses of `action` since the previous call for that action. */
  takePresses(action: GameAction): number {
    void action;
    return todo('SIM', 'KeyboardSource.takePresses');
  }

  /** True if any key event arrived since the previous call. */
  takeActivity(): boolean {
    return todo('SIM', 'KeyboardSource.takeActivity');
  }

  reset(): void {
    todo('SIM', 'KeyboardSource.reset');
  }

  destroy(): void {
    todo('SIM', 'KeyboardSource.destroy');
  }
}
