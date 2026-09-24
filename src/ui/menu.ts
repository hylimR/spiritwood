import type { MetaInput } from '../contracts/input.ts';
import type { UserSettings } from '../contracts/quality.ts';
import { todo } from '../core/todo.ts';

/**
 * Pause / settings menu (DOM): Resume, Quality (auto/high/medium/low), Pixel ratio cap
 * (auto/1/1.25/1.5/2), 60 fps cap (on/off), Dynamic resolution (on/off), Debug overlay (on/off),
 * Restart level. Works with mouse, keyboard and gamepad (`navigate` reads MetaInput nav/confirm/back edges). Calls `onChange` with a new
 * settings object on every change (the orchestrator persists and applies it).
 */
export class SettingsMenu {
  constructor(
    parent: HTMLElement,
    settings: UserSettings,
    onChange: (settings: UserSettings) => void,
    onResume: () => void,
    onRestart: () => void,
  ) {
    void parent; void settings; void onChange; void onResume; void onRestart;
    todo('PIPE', 'SettingsMenu');
  }

  get isOpen(): boolean {
    return todo('PIPE', 'SettingsMenu.isOpen');
  }

  open(): void {
    todo('PIPE', 'SettingsMenu.open');
  }

  close(): void {
    todo('PIPE', 'SettingsMenu.close');
  }

  /** Per-frame controller/keyboard navigation while open. */
  navigate(meta: MetaInput): void {
    void meta;
    todo('PIPE', 'SettingsMenu.navigate');
  }

  setGpuLabel(label: string): void {
    void label;
    todo('PIPE', 'SettingsMenu.setGpuLabel');
  }

  destroy(): void {
    todo('PIPE', 'SettingsMenu.destroy');
  }
}
