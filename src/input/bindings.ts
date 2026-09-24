import type { GameAction } from '../contracts/input.ts';

/** KeyboardEvent.code values per action (layout-independent). */
export type KeyBindings = Record<GameAction, readonly string[]>;

export const DEFAULT_KEYS: KeyBindings = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  up: ['ArrowUp', 'KeyW'],
  down: ['ArrowDown', 'KeyS'],
  jump: ['Space', 'KeyZ', 'KeyK'],
  dash: ['ShiftLeft', 'ShiftRight', 'KeyX', 'KeyL'],
  pause: ['Escape', 'KeyP'],
  debugOverlay: ['F3', 'Backquote'],
  debugDraw: ['F4'],
  respawn: ['KeyR'],
  confirm: ['Enter', 'NumpadEnter', 'Space'],
  back: ['Escape', 'Backspace'],
};

/** Standard-mapping gamepad button indices per action (https://w3c.github.io/gamepad/#remapping). */
export type PadBindings = Record<GameAction, readonly number[]>;

export const DEFAULT_PAD: PadBindings = {
  left: [14],
  right: [15],
  up: [12],
  down: [13],
  jump: [0],
  dash: [2, 5, 7],
  pause: [9],
  debugOverlay: [8],
  debugDraw: [],
  respawn: [3],
  confirm: [0],
  back: [1],
};

/** Radial deadzone for the left stick; magnitudes above it are rescaled to 0..1. */
export const STICK_DEADZONE = 0.22;
/** Stick magnitude along an axis that counts as a digital direction (for menus / drop-through). */
export const STICK_DIGITAL_THRESHOLD = 0.5;
