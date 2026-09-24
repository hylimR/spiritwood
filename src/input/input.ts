import { createMetaInput, type GameAction, type InputDevice, type InputFrame, type MetaInput } from '../contracts/input.ts';
import { STICK_DIGITAL_THRESHOLD, type KeyBindings, type PadBindings } from './bindings.ts';
import { GamepadSource, type GetGamepads } from './gamepad.ts';
import { KeyboardSource } from './keyboard.ts';

export interface InputManagerOptions {
  target?: EventTarget;
  getGamepads?: GetGamepads;
  keys?: KeyBindings;
  pad?: PadBindings;
}

/** Latched presses (and launch releases) per action never exceed this (ARCHITECTURE.md §2.2). */
const MAX_PENDING_PRESSES = 2;

/**
 * Merges keyboard + gamepad. Call `beginFrame()` once per render frame, then `nextTick()` once per sim
 * step. Jump/dash/launch presses are latched and delivered to exactly one tick (the first one after the
 * press); if no tick runs this frame they carry over. The launch release is latched the same way
 * (`launchReleased`), so a release and re-press inside one frame still releases (§5.1.1). `meta` holds
 * per-frame UI actions.
 * moveX/moveY: keyboard digital (opposite keys cancel → 0) or gamepad analog, whichever has the larger
 * magnitude this frame.
 */
export class InputManager {
  readonly meta: MetaInput = createMetaInput();

  private readonly keyboard: KeyboardSource;
  private readonly gamepad: GamepadSource;
  private device: InputDevice = 'keyboard';
  private moveX = 0;
  private moveY = 0;
  private jumpHeld = false;
  private dashHeld = false;
  private launchHeld = false;
  private pendingJump = 0;
  private pendingDash = 0;
  private pendingLaunch = 0;
  private pendingLaunchRelease = 0;
  private stickUp = false;
  private stickDown = false;
  private stickLeft = false;
  private stickRight = false;

  constructor(options: InputManagerOptions = {}) {
    const target = options.target ?? (typeof window !== 'undefined' ? window : new EventTarget());
    this.keyboard = new KeyboardSource(target, options.keys);
    this.gamepad = new GamepadSource(options.getGamepads, options.pad);
  }

  get lastDevice(): InputDevice {
    return this.device;
  }

  beginFrame(): void {
    const kb = this.keyboard;
    const pad = this.gamepad;
    pad.poll();

    const kbX = (kb.isDown('right') ? 1 : 0) - (kb.isDown('left') ? 1 : 0);
    const kbY = (kb.isDown('down') ? 1 : 0) - (kb.isDown('up') ? 1 : 0);
    this.moveX = Math.abs(pad.moveX) > Math.abs(kbX) ? pad.moveX : kbX;
    this.moveY = Math.abs(pad.moveY) > Math.abs(kbY) ? pad.moveY : kbY;
    this.jumpHeld = kb.isDown('jump') || pad.isDown('jump');
    this.dashHeld = kb.isDown('dash') || pad.isDown('dash');
    const kbLaunch = kb.isDown('launch');
    const padLaunch = pad.isDown('launch');
    this.launchHeld = kbLaunch || padLaunch;
    this.pendingJump = Math.min(MAX_PENDING_PRESSES, this.pendingJump + this.presses('jump'));
    this.pendingDash = Math.min(MAX_PENDING_PRESSES, this.pendingDash + this.presses('dash'));
    this.pendingLaunch = Math.min(MAX_PENDING_PRESSES, this.pendingLaunch + this.presses('launch'));
    // A device's release is the action's release only while the other device isn't holding it.
    const kbReleases = kb.takeReleases('launch');
    const releases = (padLaunch ? 0 : kbReleases) + (pad.released('launch') && !kbLaunch ? 1 : 0);
    this.pendingLaunchRelease = Math.min(MAX_PENDING_PRESSES, this.pendingLaunchRelease + releases);

    const m = this.meta;
    m.pausePressed = this.presses('pause') > 0;
    m.debugOverlayPressed = this.presses('debugOverlay') > 0;
    m.debugDrawPressed = this.presses('debugDraw') > 0;
    m.respawnPressed = this.presses('respawn') > 0;
    m.confirmPressed = this.presses('confirm') > 0;
    m.backPressed = this.presses('back') > 0;
    m.navUp = this.presses('up') > 0;
    m.navDown = this.presses('down') > 0;
    m.navLeft = this.presses('left') > 0;
    m.navRight = this.presses('right') > 0;

    const sx = pad.moveX;
    const sy = pad.moveY;
    const up = sy <= -STICK_DIGITAL_THRESHOLD;
    const down = sy >= STICK_DIGITAL_THRESHOLD;
    const left = sx <= -STICK_DIGITAL_THRESHOLD;
    const right = sx >= STICK_DIGITAL_THRESHOLD;
    if (up && !this.stickUp) m.navUp = true;
    if (down && !this.stickDown) m.navDown = true;
    if (left && !this.stickLeft) m.navLeft = true;
    if (right && !this.stickRight) m.navRight = true;
    this.stickUp = up;
    this.stickDown = down;
    this.stickLeft = left;
    this.stickRight = right;

    const kbPressed = kb.takeAnyPress();
    const padPressed = pad.anyPressed;
    m.anyPressed = kbPressed || padPressed;

    const kbActive = kb.takeActivity();
    const padActive = pad.active;
    if (kbActive && !padActive) this.device = 'keyboard';
    else if (padActive && !kbActive) this.device = 'gamepad';
  }

  nextTick(out: InputFrame): InputFrame {
    out.moveX = this.moveX;
    out.moveY = this.moveY;
    out.jumpPressed = this.pendingJump > 0;
    if (out.jumpPressed) this.pendingJump--;
    out.jumpHeld = this.jumpHeld || out.jumpPressed;
    out.dashPressed = this.pendingDash > 0;
    if (out.dashPressed) this.pendingDash--;
    out.dashHeld = this.dashHeld || out.dashPressed;
    out.launchPressed = this.pendingLaunch > 0;
    if (out.launchPressed) this.pendingLaunch--;
    out.launchHeld = this.launchHeld || out.launchPressed;
    out.launchReleased = this.pendingLaunchRelease > 0;
    if (out.launchReleased) this.pendingLaunchRelease--;
    return out;
  }

  /** Drop latched edges (e.g. when closing a menu so the confirm press does not jump). */
  clearEdges(): void {
    this.pendingJump = 0;
    this.pendingDash = 0;
    this.pendingLaunch = 0;
    this.pendingLaunchRelease = 0;
    const m = this.meta;
    m.pausePressed = false;
    m.debugOverlayPressed = false;
    m.debugDrawPressed = false;
    m.respawnPressed = false;
    m.anyPressed = false;
    m.navUp = false;
    m.navDown = false;
    m.navLeft = false;
    m.navRight = false;
    m.confirmPressed = false;
    m.backPressed = false;
  }

  destroy(): void {
    this.keyboard.destroy();
  }

  /** Keyboard presses since the last frame plus a gamepad rising edge for `action`. */
  private presses(action: GameAction): number {
    return this.keyboard.takePresses(action) + (this.gamepad.pressed(action) ? 1 : 0);
  }
}
