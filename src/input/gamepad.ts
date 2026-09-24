import type { GameAction } from '../contracts/input.ts';
import { DEFAULT_PAD, STICK_DEADZONE, type PadBindings } from './bindings.ts';

export type GetGamepads = () => ArrayLike<Gamepad | null>;

/** Buttons tracked for edges (the standard mapping has 17). */
const MAX_BUTTONS = 32;
/** Stick travel per poll that counts as activity (so a drifting, resting stick never claims the device). */
const STICK_ACTIVITY_DELTA = 0.05;

/**
 * Polls the Gamepad API once per frame. Uses the first connected pad with `mapping === 'standard'`
 * (falls back to the first connected pad). Left stick uses a radial deadzone with rescale; the d-pad
 * overrides the stick when pressed. Handles hot-plugging.
 */
export class GamepadSource {
  private readonly getGamepads: GetGamepads;
  private readonly actions: readonly GameAction[];
  private readonly actionButtons: readonly (readonly number[])[];
  private readonly buttons = new Uint8Array(MAX_BUTTONS);
  private readonly prevButtons = new Uint8Array(MAX_BUTTONS);
  private readonly down: Uint8Array;
  private readonly edge: Uint8Array;
  private padIndex = -1;
  private stickX = 0;
  private stickY = 0;
  private x = 0;
  private y = 0;
  private isActive = false;

  constructor(
    getGamepads: GetGamepads = () => (typeof navigator !== 'undefined' && navigator.getGamepads ? navigator.getGamepads() : []),
    bindings: PadBindings = DEFAULT_PAD,
  ) {
    this.getGamepads = getGamepads;
    this.actions = Object.keys(bindings) as GameAction[];
    this.actionButtons = this.actions.map((a) => bindings[a]);
    this.down = new Uint8Array(this.actions.length);
    this.edge = new Uint8Array(this.actions.length);
  }

  poll(): void {
    const pad = this.pickPad();
    this.prevButtons.set(this.buttons);
    this.buttons.fill(0);
    const prevStickX = this.stickX;
    const prevStickY = this.stickY;
    this.stickX = 0;
    this.stickY = 0;
    let anyEdge = false;

    if (pad) {
      if (pad.index !== this.padIndex) this.prevButtons.fill(0);
      this.padIndex = pad.index;
      const n = Math.min(pad.buttons.length, MAX_BUTTONS);
      for (let b = 0; b < n; b++) {
        if (pad.buttons[b]?.pressed) {
          this.buttons[b] = 1;
          if (!this.prevButtons[b]) anyEdge = true;
        }
      }
      this.readStick(pad.axes[0] ?? 0, pad.axes[1] ?? 0);
    } else {
      this.padIndex = -1;
    }

    for (let i = 0; i < this.actions.length; i++) {
      const list = this.actionButtons[i] as readonly number[];
      let isDown = 0;
      let wasDown = 0;
      for (let k = 0; k < list.length; k++) {
        const b = list[k] as number;
        if (b < 0 || b >= MAX_BUTTONS) continue;
        isDown |= this.buttons[b] as number;
        wasDown |= this.prevButtons[b] as number;
      }
      this.down[i] = isDown;
      this.edge[i] = isDown & (wasDown ^ 1);
    }

    const right = this.isDown('right') ? 1 : 0;
    const left = this.isDown('left') ? 1 : 0;
    const down = this.isDown('down') ? 1 : 0;
    const up = this.isDown('up') ? 1 : 0;
    if (right | left | down | up) {
      this.x = right - left;
      this.y = down - up;
    } else {
      this.x = this.stickX;
      this.y = this.stickY;
    }
    const stickOut = this.stickX !== 0 || this.stickY !== 0;
    const wasOut = prevStickX !== 0 || prevStickY !== 0;
    const moved = Math.abs(this.stickX - prevStickX) + Math.abs(this.stickY - prevStickY) > STICK_ACTIVITY_DELTA;
    this.isActive = anyEdge || (stickOut && (!wasOut || moved));
  }

  get connected(): boolean {
    return this.padIndex >= 0;
  }

  /** -1..1 after deadzone (d-pad gives -1/0/1). */
  get moveX(): number {
    return this.x;
  }

  /** -1..1, +1 = down. */
  get moveY(): number {
    return this.y;
  }

  isDown(action: GameAction): boolean {
    const i = this.actions.indexOf(action);
    return i >= 0 && this.down[i] === 1;
  }

  /** Became pressed during the latest poll. */
  pressed(action: GameAction): boolean {
    const i = this.actions.indexOf(action);
    return i >= 0 && this.edge[i] === 1;
  }

  /** Any button newly pressed during the latest poll (bound or not). */
  get anyPressed(): boolean {
    for (let b = 0; b < MAX_BUTTONS; b++) if (this.buttons[b] && !this.prevButtons[b]) return true;
    return false;
  }

  /** Any button pressed, or the stick pushed past the deadzone (or moving beyond it), during the latest poll. */
  get active(): boolean {
    return this.isActive;
  }

  private pickPad(): Gamepad | null {
    const pads = this.getGamepads();
    let fallback: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i];
      if (!p || !p.connected) continue;
      if (p.mapping === 'standard') return p;
      fallback ??= p;
    }
    return fallback;
  }

  /** Radial deadzone: magnitudes in [deadzone, 1] are rescaled to [0, 1], preserving direction. */
  private readStick(ax: number, ay: number): void {
    const mag = Math.hypot(ax, ay);
    if (!(mag > STICK_DEADZONE)) return;
    const scale = (Math.min(mag, 1) - STICK_DEADZONE) / (1 - STICK_DEADZONE) / mag;
    this.stickX = ax * scale;
    this.stickY = ay * scale;
  }
}
