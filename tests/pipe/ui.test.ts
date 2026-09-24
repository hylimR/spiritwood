import { describe, expect, test } from 'vitest';
import type { AudioStats } from '../../src/contracts/audio.ts';
import type { FrameStats, RenderStats } from '../../src/contracts/debug.ts';
import { createMetaInput, type MetaInput } from '../../src/contracts/input.ts';
import type { UserSettings } from '../../src/contracts/quality.ts';
import { DebugOverlay, formatAudioStats, formatLaunchStats } from '../../src/debug/overlay.ts';
import { DEFAULT_SETTINGS } from '../../src/settings/store.ts';
import { controlsFor, Hud, LAUNCH_KEYS, SOUND_HINT, TOAST_TIME } from '../../src/ui/hud.ts';
import { formatVolume, SettingsMenu, stepVolume, VOLUME_STEP } from '../../src/ui/menu.ts';
import { createFakeSimView, levelFromAscii } from '../shared/fixtures.ts';
import { fakeUiRoot, hasClass, type FakeElement } from './fakeDom.ts';
import { createStats } from './helpers.ts';

const level = levelFromAscii(['..........', '....P.....', '##########']);

describe('volume stepping', () => {
  test('steps by 0.1, clamps at 0 and 1 without wrapping', () => {
    expect(VOLUME_STEP).toBe(0.1);
    expect(stepVolume(0.8, 1)).toBe(0.9);
    expect(stepVolume(0.9, 1)).toBe(1);
    expect(stepVolume(1, 1)).toBe(1);
    expect(stepVolume(0.1, -1)).toBe(0);
    expect(stepVolume(0, -1)).toBe(0);
    expect(stepVolume(0.3, 1)).toBe(0.4);
    // Off-grid values (hand-edited storage) step to the next grid value in that direction.
    expect(stepVolume(0.75, 1)).toBe(0.8);
    expect(stepVolume(0.75, -1)).toBe(0.7);
    // Repeated steps land exactly on the grid (no float drift).
    let v = 0;
    for (let i = 0; i < 10; i++) v = stepVolume(v, 1);
    expect(v).toBe(1);
  });

  test('shows percentages', () => {
    expect(formatVolume(0.8)).toBe('80%');
    expect(formatVolume(0)).toBe('0%');
    expect(formatVolume(1)).toBe('100%');
    expect(formatVolume(0.30000000000000004)).toBe('30%');
  });
});

function meta(over: Partial<MetaInput>): MetaInput {
  return { ...createMetaInput(), ...over };
}

function menuRig(settings: UserSettings = { ...DEFAULT_SETTINGS }) {
  const { root, parent } = fakeUiRoot();
  const changes: UserSettings[] = [];
  let resumed = 0;
  const menu = new SettingsMenu(parent, settings, (s) => changes.push(s), () => { resumed++; }, () => {});
  const row = (label: string): FakeElement => {
    const b = root.find((e) => e.tagName === 'BUTTON' && e.textContent.startsWith(label));
    if (!b) throw new Error(`no row ${label}`);
    return b;
  };
  return { menu, changes, row, resumed: () => resumed };
}

describe('SettingsMenu volume rows', () => {
  test('Master, Music and Effects rows show percentages', () => {
    const { row } = menuRig();
    expect(row('Master volume').textContent).toContain('80%');
    expect(row('Music').textContent).toContain('60%');
    expect(row('Effects').textContent).toContain('80%');
    expect(row('Master volume').getAttribute('aria-label')).toBe('Master volume: 80%');
  });

  test('left/right step by 0.1 and clamp at 0 and 1 (no wrap); confirm does nothing', () => {
    const { menu, changes, row } = menuRig();
    menu.open();
    menu.navigate(meta({ navDown: true }));
    menu.navigate(meta({ navRight: true }));
    expect(changes.at(-1)?.masterVolume).toBe(0.9);
    menu.navigate(meta({ navRight: true }));
    expect(changes.at(-1)?.masterVolume).toBe(1);
    const n = changes.length;
    menu.navigate(meta({ navRight: true }));
    expect(changes).toHaveLength(n);
    expect(row('Master volume').textContent).toContain('100%');
    for (let i = 0; i < 15; i++) menu.navigate(meta({ navLeft: true }));
    expect(changes.at(-1)?.masterVolume).toBe(0);
    expect(changes).toHaveLength(n + 10);
    expect(row('Master volume').textContent).toContain('0%');
    // Confirm on a volume row neither changes nor wraps it.
    menu.navigate(meta({ confirmPressed: true }));
    expect(changes).toHaveLength(n + 10);
    // Only the focused row's field changes.
    expect(changes.at(-1)?.musicVolume).toBe(DEFAULT_SETTINGS.musicVolume);
  });

  test('music and effects rows change their own fields; other rows still cycle', () => {
    const { menu, changes } = menuRig();
    menu.open();
    menu.navigate(meta({ navDown: true }));
    menu.navigate(meta({ navDown: true }));
    menu.navigate(meta({ navLeft: true }));
    expect(changes.at(-1)).toMatchObject({ musicVolume: 0.5, masterVolume: DEFAULT_SETTINGS.masterVolume });
    menu.navigate(meta({ navDown: true }));
    menu.navigate(meta({ navRight: true }));
    expect(changes.at(-1)).toMatchObject({ sfxVolume: 0.9 });
    menu.navigate(meta({ navDown: true }));
    menu.navigate(meta({ confirmPressed: true }));
    expect(changes.at(-1)?.preset).toBe('high');
  });

  test('pointer clicks on the arrows step; a click on the row itself does nothing', () => {
    const { changes, row } = menuRig();
    const master = row('Master volume');
    const arrows = master.findAll((e) => hasClass(e, 'sw-arrow'));
    expect(arrows).toHaveLength(2);
    arrows[0]?.click();
    expect(changes.at(-1)?.masterVolume).toBe(0.7);
    const n = changes.length;
    master.click();
    expect(changes).toHaveLength(n);
  });
});

describe('Hud', () => {
  function hudRig() {
    const { root, parent } = fakeUiRoot();
    const hud = new Hud(parent);
    const sim = createFakeSimView(level);
    const toast = root.find((e) => hasClass(e, 'sw-toast'));
    const sound = root.find((e) => hasClass(e, 'sw-sound'));
    const controls = root.find((e) => hasClass(e, 'sw-controls'));
    if (!toast || !sound || !controls) throw new Error('HUD parts missing');
    return { hud, sim, toast, sound, controls };
  }

  test('the Spirit Launch toast shows on the unlocked false → true edge only, with the launch keys', () => {
    const { hud, sim, toast } = hudRig();
    hud.update(sim, 1);
    expect(hasClass(toast, 'sw-hidden')).toBe(true);
    sim.launch.unlocked = true;
    hud.update(sim, 2);
    expect(hasClass(toast, 'sw-hidden')).toBe(false);
    expect(hud.toastVisible).toBe(true);
    for (const k of [...LAUNCH_KEYS.keyboard, ...LAUNCH_KEYS.gamepad]) {
      expect(toast.findAll((e) => e.tagName === 'KBD').map((e) => e.textContent)).toContain(k);
    }
    expect(LAUNCH_KEYS.keyboard).toEqual(['C', 'J', 'E']);
    expect(LAUNCH_KEYS.gamepad).toEqual(['B', 'LB', 'LT']);
    hud.update(sim, 2 + TOAST_TIME / 2);
    expect(hasClass(toast, 'sw-hidden')).toBe(false);
    hud.update(sim, 2 + TOAST_TIME + 0.01);
    expect(hasClass(toast, 'sw-hidden')).toBe(true);
    // Staying unlocked never re-shows it.
    hud.update(sim, 20);
    expect(hasClass(toast, 'sw-hidden')).toBe(true);
    // A new run (reset clears the unlock) toasts again on the next edge.
    sim.launch.unlocked = false;
    hud.update(sim, 21);
    sim.launch.unlocked = true;
    hud.update(sim, 22);
    expect(hasClass(toast, 'sw-hidden')).toBe(false);
  });

  test('an already-unlocked first frame is not an edge', () => {
    const { hud, sim, toast } = hudRig();
    sim.launch.unlocked = true;
    hud.update(sim, 1);
    expect(hasClass(toast, 'sw-hidden')).toBe(true);
  });

  test('the controls hint gains Launch once unlocked', () => {
    expect(controlsFor('keyboard', false).map(([, a]) => a)).not.toContain('Launch');
    expect(controlsFor('keyboard', true)).toContainEqual(['C', 'Launch']);
    expect(controlsFor('gamepad', true)).toContainEqual(['B', 'Launch']);
    expect(controlsFor('gamepad', true).at(-1)?.[1]).toBe('Menu');
    const { hud, sim, controls } = hudRig();
    hud.update(sim, 0);
    hud.showControls('keyboard');
    expect(controls.textContent).not.toContain('Launch');
    sim.launch.unlocked = true;
    hud.update(sim, 1);
    expect(controls.textContent).toContain('Launch');
  });

  test('the sound hint says what to do and touches the DOM only when the value changes', () => {
    const { hud, sound } = hudRig();
    expect(sound.textContent).toBe(SOUND_HINT);
    expect(SOUND_HINT).toBe('Press a key or click to enable sound');
    expect(hasClass(sound, 'sw-caps')).toBe(true);
    const w0 = sound.classList.writes;
    hud.showSoundHint(false);
    expect(sound.classList.writes).toBe(w0);
    hud.showSoundHint(true);
    hud.showSoundHint(true);
    hud.showSoundHint(true);
    expect(sound.classList.writes).toBe(w0 + 1);
    expect(hasClass(sound, 'sw-hidden')).toBe(false);
    hud.showSoundHint(false);
    hud.showSoundHint(false);
    expect(sound.classList.writes).toBe(w0 + 2);
    expect(hasClass(sound, 'sw-hidden')).toBe(true);
  });
});

describe('DebugOverlay', () => {
  const frame: FrameStats = { fps: 60, frameMsAvg: 16.7, frameMs1pLow: 20, simStepsLastFrame: 1, simMs: 0.2, renderCpuMs: 2, lateFramePct: 0 };

  test('audio stats formatting', () => {
    const a: AudioStats = { state: 'running', voices: 7, latency: 0.0234, updateMs: 0.123 };
    expect(formatAudioStats(a)).toBe('audio running  voices 7  update 0.12 ms  latency 23.4 ms');
    expect(formatAudioStats({ state: 'locked', voices: 0, latency: -1, updateMs: 0 })).toBe('audio locked  voices 0  update 0.00 ms  latency n/a');
    expect(formatAudioStats(undefined)).toBe('audio n/a');
  });

  test('the panel shows the audio line and the Spirit Launch state (at most 4 Hz)', () => {
    const { root, parent } = fakeUiRoot();
    const overlay = new DebugOverlay(parent);
    overlay.setVisible(true);
    const sim = createFakeSimView(level);
    const stats: RenderStats = createStats();
    overlay.update(frame, stats, sim, 'high', 1, 16.7, { state: 'suspended', voices: 3, latency: 0.05, updateMs: 0.2 });
    const text = root.find((e) => e.tagName === 'PRE');
    expect(text?.textContent).toContain('audio suspended  voices 3  update 0.20 ms  latency 50.0 ms');
    expect(text?.textContent).toContain('launch locked  seeds 0');
    sim.launch.unlocked = true;
    Object.assign(sim.projectiles[2] as object, { active: true });
    sim.frozen = true;
    overlay.update(frame, stats, sim, 'high', 1.1, 16.7, { state: 'running', voices: 1, latency: -1, updateMs: 0 });
    expect(text?.textContent).toContain('audio suspended');
    overlay.update(frame, stats, sim, 'high', 1.3, 16.7, { state: 'running', voices: 1, latency: -1, updateMs: 0 });
    expect(text?.textContent).toContain('audio running');
    expect(formatLaunchStats(sim)).toBe('launch on  seeds 1  frozen');
  });
});
