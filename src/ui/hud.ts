import type { BenchResult } from '../contracts/debug.ts';
import type { SimView } from '../contracts/sim.ts';
import { GAME_TITLE } from '../config.ts';
import { el, ensureUiStyles, formatTime } from './styles.ts';

type Device = 'keyboard' | 'gamepad';

const CONTROLS: Record<Device, readonly (readonly [string, string])[]> = {
  keyboard: [['← →', 'Move'], ['Space', 'Jump'], ['Shift', 'Dash'], ['Esc', 'Menu']],
  gamepad: [['Stick', 'Move'], ['A', 'Jump'], ['X', 'Dash'], ['Start', 'Menu']],
};
/** Spirit Launch keys (§5.7): the first is the hint's, all of them are on the unlock toast. */
export const LAUNCH_KEYS: Readonly<Record<Device, readonly string[]>> = {
  keyboard: ['C', 'J', 'E'],
  gamepad: ['B', 'LB', 'LT'],
};
/** Seconds after the first movement before the controls hint fades. */
const CONTROLS_LINGER = 2.5;
/** Seconds the Spirit Launch toast stays up. */
export const TOAST_TIME = 6.5;
export const SOUND_HINT = 'Press a key or click to enable sound';

/** The controls hint for a device: Launch joins it (before Menu) once the ability is unlocked. */
export function controlsFor(device: Device, launchUnlocked: boolean): readonly (readonly [string, string])[] {
  const base = CONTROLS[device];
  if (!launchUnlocked) return base;
  const out = base.slice(0, base.length - 1);
  out.push([LAUNCH_KEYS[device][0] as string, 'Launch'], base[base.length - 1] as readonly [string, string]);
  return out;
}

/**
 * DOM HUD layered over the canvas: spirit-light orb counter (glowing, pulses on collect), title card
 * (GAME_TITLE + "press any key / button"), controls hint that fades after first movement (it gains
 * Launch once the ability is unlocked), the Spirit Launch toast on the `launch.unlocked` false → true
 * edge, the "enable sound" line while audio is locked, completion card (time, orbs), bench results card.
 * The DOM is touched only when a value changes.
 */
export class Hud {
  private readonly doc: Document;
  private readonly root: HTMLDivElement;
  private readonly orbs: HTMLDivElement;
  private readonly orbCount: HTMLSpanElement;
  private readonly title: HTMLDivElement;
  private readonly controls: HTMLDivElement;
  private readonly complete: HTMLDivElement;
  private readonly bench: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  private readonly sound: HTMLDivElement;
  private lastCollected = -1;
  private lastTotal = -1;
  private controlsActive = false;
  private movedAt = -1;
  private device: Device = 'keyboard';
  /** launch.unlocked last frame (null until the first update: the first value is not an edge). */
  private lastUnlocked: boolean | null = null;
  private toastAt = -1;
  private soundShown = false;

  constructor(parent: HTMLElement) {
    const doc = (this.doc = parent.ownerDocument);
    ensureUiStyles(doc);
    this.root = el(doc, 'div', 'sw-layer sw-hud');
    this.root.style.pointerEvents = 'none';

    this.orbs = el(doc, 'div', 'sw-orbs sw-caps sw-fade sw-hidden');
    this.orbs.setAttribute('aria-label', 'Spirit light collected');
    this.orbCount = el(doc, 'span', 'sw-orb-count');
    this.orbs.append(el(doc, 'span', 'sw-orb-icon'), this.orbCount);

    this.title = el(doc, 'div', 'sw-center sw-fade sw-hidden');
    const titleBox = el(doc, 'div', 'sw-title');
    titleBox.append(el(doc, 'h1', '', GAME_TITLE), el(doc, 'div', 'sw-hairline'), el(doc, 'div', 'sw-caps sw-breathe', 'Press any key or button'));
    this.title.append(titleBox);

    this.controls = el(doc, 'div', 'sw-controls sw-panel sw-caps sw-fade sw-hidden');
    this.complete = el(doc, 'div', 'sw-center sw-fade sw-hidden');
    this.bench = el(doc, 'div', 'sw-center sw-fade sw-hidden');
    this.sound = el(doc, 'div', 'sw-sound sw-caps sw-fade sw-hidden', SOUND_HINT);
    this.sound.setAttribute('role', 'status');
    this.toast = this.buildToast();
    this.root.append(this.orbs, this.sound, this.title, this.controls, this.toast, this.complete, this.bench);
    parent.appendChild(this.root);
  }

  /** "Spirit Launch" card: what it does and its keys on both devices. */
  private buildToast(): HTMLDivElement {
    const doc = this.doc;
    const toast = el(doc, 'div', 'sw-toast sw-panel sw-fade sw-hidden');
    toast.setAttribute('role', 'status');
    const keys = el(doc, 'div', 'sw-toast-keys sw-caps');
    for (const device of ['keyboard', 'gamepad'] as const) {
      const group = el(doc, 'span', 'sw-toast-group');
      for (const k of LAUNCH_KEYS[device]) group.append(el(doc, 'kbd', '', k));
      keys.append(group);
    }
    toast.append(
      el(doc, 'div', 'sw-toast-title', 'Spirit Launch'),
      el(doc, 'div', 'sw-hairline'),
      el(doc, 'div', 'sw-toast-body', 'Near a seed or a foe, hold to latch on and aim. Release to fly.'),
      keys,
    );
    return toast;
  }

  update(sim: SimView, nowSec: number): void {
    const unlocked = sim.launch.unlocked;
    if (unlocked !== this.lastUnlocked) {
      const edge = this.lastUnlocked === false && unlocked;
      this.lastUnlocked = unlocked;
      if (edge) {
        this.toastAt = nowSec;
        this.toast.classList.remove('sw-hidden');
      }
      if (this.controlsActive) this.renderControls();
    }
    if (this.toastAt >= 0 && (nowSec - this.toastAt > TOAST_TIME || nowSec < this.toastAt || !unlocked)) {
      this.toastAt = -1;
      this.toast.classList.add('sw-hidden');
    }
    if (sim.orbsCollected !== this.lastCollected || sim.orbsTotal !== this.lastTotal) {
      const gained = this.lastCollected >= 0 && sim.orbsCollected > this.lastCollected;
      this.lastCollected = sim.orbsCollected;
      this.lastTotal = sim.orbsTotal;
      this.orbCount.replaceChildren(el(this.doc, 'b', '', String(sim.orbsCollected)), ` / ${sim.orbsTotal}`);
      if (gained) {
        this.orbs.classList.remove('sw-pulse');
        void this.orbs.offsetWidth;
        this.orbs.classList.add('sw-pulse');
      }
    }
    if (this.controlsActive) {
      if (this.movedAt < 0 && sim.elapsed > 0) this.movedAt = nowSec;
      if (this.movedAt >= 0 && nowSec - this.movedAt > CONTROLS_LINGER) {
        this.controlsActive = false;
        this.controls.classList.add('sw-hidden');
      }
    }
  }

  showTitle(visible: boolean): void {
    this.title.classList.toggle('sw-hidden', !visible);
    this.orbs.classList.toggle('sw-hidden', visible);
  }

  showControls(device: 'keyboard' | 'gamepad'): void {
    this.device = device;
    this.renderControls();
    this.controls.classList.remove('sw-hidden');
    this.controlsActive = true;
    this.movedAt = -1;
  }

  /** Whether the Spirit Launch toast is up (tests, the orchestrator). */
  get toastVisible(): boolean {
    return this.toastAt >= 0;
  }

  private renderControls(): void {
    this.controls.replaceChildren();
    for (const [key, action] of controlsFor(this.device, this.lastUnlocked === true)) {
      const item = el(this.doc, 'span');
      item.append(el(this.doc, 'kbd', '', key), action);
      this.controls.append(item);
    }
  }

  showComplete(elapsedSec: number, orbs: number, total: number): void {
    const card = el(this.doc, 'div', 'sw-card sw-panel');
    card.setAttribute('role', 'status');
    const rows = el(this.doc, 'div', 'sw-rows');
    rows.append(
      el(this.doc, 'span', 'sw-caps sw-muted', 'Time'), el(this.doc, 'span', 'sw-v', formatTime(elapsedSec)),
      el(this.doc, 'span', 'sw-caps sw-muted', 'Spirit light'), el(this.doc, 'span', 'sw-v', `${orbs} / ${total}`),
    );
    card.append(el(this.doc, 'h2', '', 'The Moonwell stirs'), el(this.doc, 'div', 'sw-hairline'), rows,
      el(this.doc, 'div', 'sw-caps sw-muted', 'Esc — menu · restart'));
    this.complete.replaceChildren(card);
    this.complete.classList.remove('sw-hidden');
  }

  /** "Press a key or click to enable sound" while audio is still locked after play starts (DOM only on change). */
  showSoundHint(visible: boolean): void {
    if (visible === this.soundShown) return;
    this.soundShown = visible;
    this.sound.classList.toggle('sw-hidden', !visible);
  }

  hideComplete(): void {
    this.complete.classList.add('sw-hidden');
  }

  showBench(result: BenchResult): void {
    const card = el(this.doc, 'div', 'sw-card sw-panel');
    card.setAttribute('role', 'status');
    const rows = el(this.doc, 'div', 'sw-rows');
    const add = (k: string, v: string): void => {
      rows.append(el(this.doc, 'span', 'sw-caps sw-muted', k), el(this.doc, 'span', 'sw-v', v));
    };
    add('Preset', result.preset);
    add('Frames', `${result.frames} in ${result.seconds.toFixed(1)} s`);
    add('FPS avg', result.fpsAvg.toFixed(1));
    add('1% low', result.fps1pLow.toFixed(1));
    add('Frame p50 / p95 / p99', `${result.frameMsP50.toFixed(1)} / ${result.frameMsP95.toFixed(1)} / ${result.frameMsP99.toFixed(1)} ms`);
    add('Late frames', `${result.lateFramePct.toFixed(2)} %`);
    add('Render scale', result.renderScaleAvg.toFixed(2));
    add('GPU', result.gpuMsAvg >= 0 ? `${result.gpuMsAvg.toFixed(2)} ms` : 'n/a');
    const verdict = result.lateFramePct < 1 ? 'Pass — under 1 % late frames' : 'Over budget — 1 % late frames or more';
    card.append(el(this.doc, 'h2', '', 'Benchmark'), el(this.doc, 'div', 'sw-hairline'), rows,
      el(this.doc, 'div', 'sw-caps sw-muted', verdict), el(this.doc, 'div', 'sw-muted', result.gpu));
    this.bench.replaceChildren(card);
    this.bench.classList.remove('sw-hidden');
  }

  destroy(): void {
    this.root.remove();
  }
}
