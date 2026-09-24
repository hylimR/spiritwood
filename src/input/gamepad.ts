import type { GameAction } from '../contracts/input.ts';
import { todo } from '../core/todo.ts';
import { DEFAULT_PAD, type PadBindings } from './bindings.ts';

export type GetGamepads = () => ArrayLike<Gamepad | null>;

/**
 * Polls the Gamepad API once per frame. Uses the first connected pad with `mapping === 'standard'`
 * (falls back to the first connected pad). Left stick uses a radial deadzone with rescale; the d-pad
 * overrides the stick when pressed. Handles hot-plugging.
 */
export class GamepadSource {
  constructor(
    getGamepads: GetGamepads = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []),
    bindings: PadBindings = DEFAULT_PAD,
  ) {
    void getGamepads;
    void bindings;
    todo('SIM', 'GamepadSource');
  }

  poll(): void {
    todo('SIM', 'GamepadSource.poll');
  }

  get connected(): boolean {
    return todo('SIM', 'GamepadSource.connected');
  }

  /** -1..1 after deadzone (d-pad gives -1/0/1). */
  get moveX(): number {
    return todo('SIM', 'GamepadSource.moveX');
  }

  /** -1..1, +1 = down. */
  get moveY(): number {
    return todo('SIM', 'GamepadSource.moveY');
  }

  isDown(action: GameAction): boolean {
    void action;
    return todo('SIM', 'GamepadSource.isDown');
  }

  /** Became pressed during the latest poll. */
  pressed(action: GameAction): boolean {
    void action;
    return todo('SIM', 'GamepadSource.pressed');
  }

  /** Any button pressed or stick moved past the deadzone during the latest poll. */
  get active(): boolean {
    return todo('SIM', 'GamepadSource.active');
  }
}
