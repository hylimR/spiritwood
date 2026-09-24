/** Headless stand-ins for DOM key events and the Gamepad API. */

export interface KeyInit {
  repeat?: boolean;
  ctrlKey?: boolean;
}

export class FakeKeys {
  readonly target = new EventTarget();
  prevented = 0;

  down(code: string, init: KeyInit = {}): void {
    this.dispatch('keydown', code, init);
  }

  up(code: string): void {
    this.dispatch('keyup', code, {});
  }

  tap(code: string): void {
    this.down(code);
    this.up(code);
  }

  blur(): void {
    this.target.dispatchEvent(new Event('blur'));
  }

  private dispatch(type: string, code: string, init: KeyInit): void {
    const e = Object.assign(new Event(type, { cancelable: true }), { code, repeat: init.repeat ?? false, ctrlKey: init.ctrlKey ?? false });
    this.target.dispatchEvent(e);
    if (e.defaultPrevented) this.prevented++;
  }
}

export interface PadState {
  index?: number;
  mapping?: GamepadMappingType;
  connected?: boolean;
  pressed?: number[];
  axes?: [number, number];
}

export function fakePad(state: PadState): Gamepad {
  const pressed = new Set(state.pressed ?? []);
  const buttons: GamepadButton[] = [];
  for (let i = 0; i < 17; i++) {
    const on = pressed.has(i);
    buttons.push({ pressed: on, touched: on, value: on ? 1 : 0 });
  }
  const axes = state.axes ?? [0, 0];
  return {
    id: 'fake pad',
    index: state.index ?? 0,
    connected: state.connected ?? true,
    mapping: state.mapping ?? 'standard',
    timestamp: 0,
    axes: [axes[0], axes[1], 0, 0],
    buttons,
    vibrationActuator: null,
  } as unknown as Gamepad;
}

/** A mutable pad list the sources poll. */
export class FakePads {
  pads: (Gamepad | null)[] = [];
  readonly get = (): ArrayLike<Gamepad | null> => this.pads;

  set(...states: (PadState | null)[]): void {
    this.pads = states.map((s) => (s ? fakePad(s) : null));
  }
}
