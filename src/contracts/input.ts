/**
 * One fixed-step's worth of player intent. Produced by InputManager.nextTick().
 * Edges (`*Pressed`) are delivered to exactly one tick (ARCHITECTURE.md §2.2).
 */
export interface InputFrame {
  /** -1..1, deadzoned and rescaled. Keyboard gives -1/0/1. */
  moveX: number;
  /** -1..1, +1 = down. */
  moveY: number;
  jumpHeld: boolean;
  jumpPressed: boolean;
  dashHeld: boolean;
  dashPressed: boolean;
}

export function createInputFrame(): InputFrame {
  return { moveX: 0, moveY: 0, jumpHeld: false, jumpPressed: false, dashHeld: false, dashPressed: false };
}

/** Per-render-frame UI/meta actions (not part of the deterministic sim). */
export interface MetaInput {
  pausePressed: boolean;
  debugOverlayPressed: boolean;
  debugDrawPressed: boolean;
  respawnPressed: boolean;
  /** Any key/button this frame — used by menus and to dismiss the title card. */
  anyPressed: boolean;
  /** Menu navigation edges (keyboard arrows/WASD, d-pad, or stick crossing STICK_DIGITAL_THRESHOLD). */
  navUp: boolean;
  navDown: boolean;
  navLeft: boolean;
  navRight: boolean;
  /** Enter/Space/A. */
  confirmPressed: boolean;
  /** Escape/Backspace/B. */
  backPressed: boolean;
}

export function createMetaInput(): MetaInput {
  return {
    pausePressed: false, debugOverlayPressed: false, debugDrawPressed: false, respawnPressed: false,
    anyPressed: false, navUp: false, navDown: false, navLeft: false, navRight: false,
    confirmPressed: false, backPressed: false,
  };
}

export type InputDevice = 'keyboard' | 'gamepad';

export const GameAction = {
  Left: 'left',
  Right: 'right',
  Up: 'up',
  Down: 'down',
  Jump: 'jump',
  Dash: 'dash',
  Pause: 'pause',
  DebugOverlay: 'debugOverlay',
  DebugDraw: 'debugDraw',
  Respawn: 'respawn',
  Confirm: 'confirm',
  Back: 'back',
} as const;
export type GameAction = (typeof GameAction)[keyof typeof GameAction];
