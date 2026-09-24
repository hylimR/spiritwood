import { describe, expect, test } from 'vitest';
import { createInputFrame } from '../../src/contracts/input.ts';
import { DEFAULT_PAD, STICK_DEADZONE, STICK_DIGITAL_THRESHOLD } from '../../src/input/bindings.ts';
import { GamepadSource } from '../../src/input/gamepad.ts';
import { InputManager } from '../../src/input/input.ts';
import { KeyboardSource } from '../../src/input/keyboard.ts';
import { FakeKeys, FakePads } from './fakes.ts';

const A = DEFAULT_PAD.jump[0] as number;
const B = DEFAULT_PAD.back[0] as number;
const START = DEFAULT_PAD.pause[0] as number;
const DPAD_LEFT = DEFAULT_PAD.left[0] as number;
const DPAD_RIGHT = DEFAULT_PAD.right[0] as number;
const DPAD_DOWN = DEFAULT_PAD.down[0] as number;

function setup(): { keys: FakeKeys; pads: FakePads; input: InputManager } {
  const keys = new FakeKeys();
  const pads = new FakePads();
  const input = new InputManager({ target: keys.target, getGamepads: pads.get });
  return { keys, pads, input };
}

describe('KeyboardSource', () => {
  test('held state, press counting and auto-repeat', () => {
    const keys = new FakeKeys();
    const kb = new KeyboardSource(keys.target);
    keys.down('Space');
    keys.down('Space', { repeat: true });
    keys.down('Space', { repeat: true });
    expect(kb.isDown('jump')).toBe(true);
    expect(kb.takePresses('jump')).toBe(1);
    expect(kb.takePresses('jump')).toBe(0);
    keys.up('Space');
    expect(kb.isDown('jump')).toBe(false);
    keys.tap('KeyZ');
    keys.tap('KeyK');
    expect(kb.takePresses('jump')).toBe(2);
    expect(kb.isDown('jump')).toBe(false);
  });

  test('one key feeding several actions, and several keys for one action', () => {
    const keys = new FakeKeys();
    const kb = new KeyboardSource(keys.target);
    keys.down('Space');
    expect(kb.isDown('jump')).toBe(true);
    expect(kb.isDown('confirm')).toBe(true);
    keys.down('KeyZ');
    keys.up('Space');
    expect(kb.isDown('jump')).toBe(true);
    expect(kb.isDown('confirm')).toBe(false);
  });

  test('blur releases held keys but keeps counted presses', () => {
    const keys = new FakeKeys();
    const kb = new KeyboardSource(keys.target);
    keys.down('ArrowLeft');
    keys.blur();
    expect(kb.isDown('left')).toBe(false);
    expect(kb.takePresses('left')).toBe(1);
    keys.down('ArrowLeft');
    expect(kb.takePresses('left')).toBe(1);
  });

  test('game keys are prevented; unbound keys and browser shortcuts are not', () => {
    const keys = new FakeKeys();
    const kb = new KeyboardSource(keys.target);
    keys.down('Space');
    keys.down('Space', { repeat: true });
    expect(keys.prevented).toBe(2);
    keys.down('KeyQ');
    expect(keys.prevented).toBe(2);
    keys.down('KeyR', { ctrlKey: true });
    expect(keys.prevented).toBe(2);
    expect(kb.takePresses('respawn')).toBe(0);
    expect(kb.takeAnyPress()).toBe(true);
    expect(kb.takeAnyPress()).toBe(false);
  });

  test('activity, reset and destroy', () => {
    const keys = new FakeKeys();
    const kb = new KeyboardSource(keys.target);
    expect(kb.takeActivity()).toBe(false);
    keys.down('KeyX');
    expect(kb.takeActivity()).toBe(true);
    kb.reset();
    expect(kb.isDown('dash')).toBe(false);
    expect(kb.takePresses('dash')).toBe(0);
    kb.destroy();
    keys.down('KeyL');
    expect(kb.isDown('dash')).toBe(false);
    expect(kb.takeActivity()).toBe(false);
  });

  test('tolerates events without preventDefault or code', () => {
    const target = new EventTarget();
    const kb = new KeyboardSource(target);
    const bare = Object.assign(new Event('keydown'), { code: 'Space', preventDefault: undefined });
    expect(() => target.dispatchEvent(bare)).not.toThrow();
    expect(kb.isDown('jump')).toBe(true);
    expect(() => target.dispatchEvent(new Event('keydown'))).not.toThrow();
  });
});

describe('GamepadSource', () => {
  test('prefers a standard-mapping pad, falls back to the first connected one', () => {
    const pads = new FakePads();
    const src = new GamepadSource(pads.get);
    pads.set(null, { index: 1, mapping: '', pressed: [B] }, { index: 2, pressed: [A] });
    src.poll();
    expect(src.connected).toBe(true);
    expect(src.isDown('jump')).toBe(true);
    expect(src.isDown('back')).toBe(false);
    pads.set({ index: 1, mapping: '', pressed: [B] }, { index: 2, connected: false, pressed: [A] });
    src.poll();
    expect(src.isDown('back')).toBe(true);
    pads.set();
    src.poll();
    expect(src.connected).toBe(false);
    expect(src.isDown('back')).toBe(false);
  });

  test('pressed is a rising edge of the latest poll', () => {
    const pads = new FakePads();
    const src = new GamepadSource(pads.get);
    pads.set({ pressed: [A] });
    src.poll();
    expect(src.pressed('jump')).toBe(true);
    src.poll();
    expect(src.pressed('jump')).toBe(false);
    expect(src.isDown('jump')).toBe(true);
    pads.set({});
    src.poll();
    pads.set({ pressed: [A] });
    src.poll();
    expect(src.pressed('jump')).toBe(true);
  });

  test('radial deadzone with rescale; axis 1 is +down', () => {
    const pads = new FakePads();
    const src = new GamepadSource(pads.get);
    pads.set({ axes: [STICK_DEADZONE * 0.9, 0] });
    src.poll();
    expect(src.moveX).toBe(0);
    expect(src.active).toBe(false);
    pads.set({ axes: [1, 0] });
    src.poll();
    expect(src.moveX).toBeCloseTo(1, 9);
    expect(src.active).toBe(true);
    const mid = (1 + STICK_DEADZONE) / 2;
    pads.set({ axes: [0, mid] });
    src.poll();
    expect(src.moveY).toBeCloseTo(0.5, 9);
    expect(src.moveX).toBe(0);
    const diag = Math.SQRT1_2;
    pads.set({ axes: [diag, -diag] });
    src.poll();
    expect(Math.hypot(src.moveX, src.moveY)).toBeCloseTo(1, 9);
    expect(src.moveX).toBeCloseTo(-src.moveY, 9);
    pads.set({ axes: [1.2, 0] });
    src.poll();
    expect(src.moveX).toBeCloseTo(1, 9);
  });

  test('the d-pad overrides the stick', () => {
    const pads = new FakePads();
    const src = new GamepadSource(pads.get);
    pads.set({ axes: [0.9, 0.9], pressed: [DPAD_LEFT] });
    src.poll();
    expect(src.moveX).toBe(-1);
    expect(src.moveY).toBe(0);
    pads.set({ axes: [0.9, 0], pressed: [DPAD_DOWN] });
    src.poll();
    expect(src.moveX).toBe(0);
    expect(src.moveY).toBe(1);
  });

  test('hot-plugging a pad with a button held registers one press', () => {
    const pads = new FakePads();
    const src = new GamepadSource(pads.get);
    src.poll();
    expect(src.connected).toBe(false);
    pads.set({ index: 3, pressed: [START] });
    src.poll();
    expect(src.pressed('pause')).toBe(true);
    expect(src.anyPressed).toBe(true);
    src.poll();
    expect(src.pressed('pause')).toBe(false);
    expect(src.anyPressed).toBe(false);
  });
});

describe('InputManager latching', () => {
  test('a press is delivered to exactly one tick, and that tick reports held', () => {
    const { keys, input } = setup();
    const f = createInputFrame();
    keys.tap('Space');
    input.beginFrame();
    input.nextTick(f);
    expect(f.jumpPressed).toBe(true);
    expect(f.jumpHeld).toBe(true);
    input.nextTick(f);
    expect(f.jumpPressed).toBe(false);
    expect(f.jumpHeld).toBe(false);
  });

  test('a frame that runs zero ticks carries the press to the next frame', () => {
    const { keys, input } = setup();
    const f = createInputFrame();
    keys.down('KeyX');
    input.beginFrame();
    input.beginFrame();
    input.nextTick(f);
    expect(f.dashPressed).toBe(true);
    expect(f.dashHeld).toBe(true);
    input.beginFrame();
    input.nextTick(f);
    expect(f.dashPressed).toBe(false);
    expect(f.dashHeld).toBe(true);
  });

  test('two presses in one frame reach two ticks (capped at two)', () => {
    const { keys, input } = setup();
    const f = createInputFrame();
    keys.tap('Space');
    keys.tap('Space');
    keys.tap('Space');
    input.beginFrame();
    const delivered: boolean[] = [];
    for (let i = 0; i < 4; i++) delivered.push(input.nextTick(f).jumpPressed);
    expect(delivered).toEqual([true, true, false, false]);
  });

  test('presses left over after a frame carry into later frames', () => {
    const { keys, input } = setup();
    const f = createInputFrame();
    keys.tap('Space');
    keys.tap('Space');
    input.beginFrame();
    expect(input.nextTick(f).jumpPressed).toBe(true);
    input.beginFrame();
    expect(input.nextTick(f).jumpPressed).toBe(true);
    expect(input.nextTick(f).jumpPressed).toBe(false);
  });

  test('keyboard movement: opposite keys cancel; the larger magnitude device wins', () => {
    const { keys, pads, input } = setup();
    const f = createInputFrame();
    keys.down('ArrowLeft');
    keys.down('KeyD');
    input.beginFrame();
    expect(input.nextTick(f).moveX).toBe(0);
    keys.up('KeyD');
    pads.set({ axes: [0.5, 0] });
    input.beginFrame();
    expect(input.nextTick(f).moveX).toBe(-1);
    keys.up('ArrowLeft');
    input.beginFrame();
    expect(input.nextTick(f).moveX).toBeCloseTo((0.5 - STICK_DEADZONE) / (1 - STICK_DEADZONE), 9);
    pads.set({ axes: [0, 1] });
    keys.down('ArrowUp');
    input.beginFrame();
    expect(input.nextTick(f).moveY).toBe(-1);
    keys.up('ArrowUp');
    input.beginFrame();
    expect(input.nextTick(f).moveY).toBeCloseTo(1, 9);
  });

  test('gamepad buttons latch like keys', () => {
    const { pads, input } = setup();
    const f = createInputFrame();
    pads.set({ pressed: [A] });
    input.beginFrame();
    input.beginFrame();
    expect(input.nextTick(f).jumpPressed).toBe(true);
    expect(f.jumpHeld).toBe(true);
    expect(input.nextTick(f).jumpPressed).toBe(false);
    expect(f.jumpHeld).toBe(true);
  });

  test('clearEdges drops pending presses and meta', () => {
    const { keys, input } = setup();
    const f = createInputFrame();
    keys.tap('Enter');
    keys.tap('Space');
    input.beginFrame();
    expect(input.meta.confirmPressed).toBe(true);
    input.clearEdges();
    expect(input.meta.confirmPressed).toBe(false);
    expect(input.meta.anyPressed).toBe(false);
    expect(input.nextTick(f).jumpPressed).toBe(false);
  });
});

describe('InputManager meta and devices', () => {
  test('meta edges are per frame', () => {
    const { keys, input } = setup();
    keys.tap('Escape');
    keys.tap('F3');
    keys.tap('F4');
    keys.tap('KeyR');
    input.beginFrame();
    const m = input.meta;
    expect(m.pausePressed).toBe(true);
    expect(m.backPressed).toBe(true);
    expect(m.debugOverlayPressed).toBe(true);
    expect(m.debugDrawPressed).toBe(true);
    expect(m.respawnPressed).toBe(true);
    expect(m.anyPressed).toBe(true);
    input.beginFrame();
    expect(m.pausePressed || m.backPressed || m.debugOverlayPressed || m.debugDrawPressed || m.respawnPressed || m.anyPressed).toBe(false);
  });

  test('navigation edges from keys, d-pad and the stick crossing the digital threshold', () => {
    const { keys, pads, input } = setup();
    const m = input.meta;
    keys.tap('ArrowDown');
    input.beginFrame();
    expect(m.navDown).toBe(true);
    pads.set({ pressed: [DPAD_RIGHT] });
    input.beginFrame();
    expect(m.navRight).toBe(true);
    expect(m.navDown).toBe(false);
    input.beginFrame();
    expect(m.navRight).toBe(false);
    const belowThreshold = STICK_DEADZONE + STICK_DIGITAL_THRESHOLD * 0.8 * (1 - STICK_DEADZONE);
    pads.set({ axes: [0, -belowThreshold] });
    input.beginFrame();
    expect(m.navUp).toBe(false);
    pads.set({ axes: [0, -1] });
    input.beginFrame();
    expect(m.navUp).toBe(true);
    input.beginFrame();
    expect(m.navUp).toBe(false);
    pads.set({ axes: [-1, 0] });
    input.beginFrame();
    expect(m.navLeft).toBe(true);
    expect(m.navUp).toBe(false);
  });

  test('confirm and back from keys and pad buttons', () => {
    const { keys, pads, input } = setup();
    const m = input.meta;
    keys.tap('Enter');
    input.beginFrame();
    expect(m.confirmPressed).toBe(true);
    pads.set({ pressed: [B] });
    input.beginFrame();
    expect(m.backPressed).toBe(true);
    expect(m.confirmPressed).toBe(false);
    expect(m.anyPressed).toBe(true);
  });

  test('lastDevice follows activity', () => {
    const { keys, pads, input } = setup();
    expect(input.lastDevice).toBe('keyboard');
    pads.set({ axes: [1, 0] });
    input.beginFrame();
    expect(input.lastDevice).toBe('gamepad');
    input.beginFrame();
    expect(input.lastDevice).toBe('gamepad');
    // A stick resting past the deadzone (drift, or held) does not fight the keyboard.
    keys.tap('KeyA');
    input.beginFrame();
    expect(input.lastDevice).toBe('keyboard');
    pads.set({ axes: [0.6, 0] });
    input.beginFrame();
    expect(input.lastDevice).toBe('gamepad');
    pads.set({});
    keys.tap('KeyA');
    input.beginFrame();
    expect(input.lastDevice).toBe('keyboard');
    pads.set({ pressed: [A] });
    input.beginFrame();
    expect(input.lastDevice).toBe('gamepad');
  });

  test('destroy detaches the keyboard', () => {
    const { keys, input } = setup();
    input.destroy();
    keys.tap('Space');
    input.beginFrame();
    expect(input.nextTick(createInputFrame()).jumpPressed).toBe(false);
  });
});
