import type { GameAction } from '../contracts/input.ts';
import { DEFAULT_KEYS, type KeyBindings } from './bindings.ts';

/** The subset of KeyboardEvent the source reads (tests dispatch plain Events with these fields). */
interface KeyEventLike extends Event {
  readonly code?: string;
  readonly repeat?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

/**
 * Keyboard state from DOM key events on `target` (window in the game, a plain EventTarget in tests —
 * tests dispatch `Object.assign(new Event('keydown'), { code: 'Space' })`).
 * Presses are counted between `takePresses` calls, so a tap shorter than a frame is never lost;
 * releases likewise between `takeReleases` calls. Auto-repeat keydowns (`repeat: true`) are not
 * presses. Game keys call preventDefault().
 * Clears held keys on `blur`.
 */
export class KeyboardSource {
  private readonly target: EventTarget;
  private readonly actions: readonly GameAction[];
  /** KeyboardEvent.code → indices into `actions`. */
  private readonly codeActions = new Map<string, readonly number[]>();
  private readonly downCodes = new Set<string>();
  /** Bound keys currently held, per action. */
  private readonly held: Uint8Array;
  private readonly presses: Uint16Array;
  /** Held → released transitions of an action (its last bound key went up, or blur). */
  private readonly releases: Uint16Array;
  private anyPress = false;
  private activity = false;

  constructor(target: EventTarget, bindings: KeyBindings = DEFAULT_KEYS) {
    this.target = target;
    this.actions = Object.keys(bindings) as GameAction[];
    this.held = new Uint8Array(this.actions.length);
    this.presses = new Uint16Array(this.actions.length);
    this.releases = new Uint16Array(this.actions.length);
    const byCode = new Map<string, number[]>();
    for (let i = 0; i < this.actions.length; i++) {
      for (const code of bindings[this.actions[i] as GameAction]) {
        const list = byCode.get(code) ?? [];
        if (!list.includes(i)) list.push(i);
        byCode.set(code, list);
      }
    }
    for (const [code, list] of byCode) this.codeActions.set(code, list);
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    target.addEventListener('blur', this.onBlur);
  }

  isDown(action: GameAction): boolean {
    const i = this.actions.indexOf(action);
    return i >= 0 && (this.held[i] as number) > 0;
  }

  /** Presses of `action` since the previous call for that action. */
  takePresses(action: GameAction): number {
    const i = this.actions.indexOf(action);
    if (i < 0) return 0;
    const n = this.presses[i] as number;
    this.presses[i] = 0;
    return n;
  }

  /**
   * Releases of `action` since the previous call for that action: transitions from held to not held
   * (the last of its bound keys went up, or the window lost focus while it was held).
   */
  takeReleases(action: GameAction): number {
    const i = this.actions.indexOf(action);
    if (i < 0) return 0;
    const n = this.releases[i] as number;
    this.releases[i] = 0;
    return n;
  }

  /** True if any key (bound or not) went down since the previous call. Auto-repeat does not count. */
  takeAnyPress(): boolean {
    const any = this.anyPress;
    this.anyPress = false;
    return any;
  }

  /** True if any key event arrived since the previous call. */
  takeActivity(): boolean {
    const a = this.activity;
    this.activity = false;
    return a;
  }

  reset(): void {
    this.downCodes.clear();
    this.held.fill(0);
    this.presses.fill(0);
    this.releases.fill(0);
    this.anyPress = false;
    this.activity = false;
  }

  destroy(): void {
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('blur', this.onBlur);
    this.reset();
  }

  private readonly onKeyDown = (event: Event): void => {
    const e = event as KeyEventLike;
    this.activity = true;
    // Browser/OS shortcuts (Ctrl+R, Cmd+W, Alt+Tab, …) are neither game input nor ours to cancel.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code;
    const bound = code ? this.codeActions.get(code) : undefined;
    if (bound && typeof e.preventDefault === 'function') e.preventDefault();
    if (e.repeat || !code) return;
    if (this.downCodes.has(code)) return;
    this.downCodes.add(code);
    this.anyPress = true;
    if (!bound) return;
    for (let k = 0; k < bound.length; k++) {
      const i = bound[k] as number;
      this.held[i] = (this.held[i] as number) + 1;
      if ((this.presses[i] as number) < 0xffff) this.presses[i] = (this.presses[i] as number) + 1;
    }
  };

  private readonly onKeyUp = (event: Event): void => {
    const e = event as KeyEventLike;
    this.activity = true;
    const code = e.code;
    if (!code || !this.downCodes.delete(code)) return;
    const bound = this.codeActions.get(code);
    if (!bound) return;
    for (let k = 0; k < bound.length; k++) {
      const i = bound[k] as number;
      const h = this.held[i] as number;
      if (h === 0) continue;
      this.held[i] = h - 1;
      if (h === 1) this.countRelease(i);
    }
  };

  private readonly onBlur = (): void => {
    this.downCodes.clear();
    for (let i = 0; i < this.held.length; i++) if ((this.held[i] as number) > 0) this.countRelease(i);
    this.held.fill(0);
  };

  private countRelease(i: number): void {
    if ((this.releases[i] as number) < 0xffff) this.releases[i] = (this.releases[i] as number) + 1;
  }
}
