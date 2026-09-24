import type { UserSettings } from '../contracts/quality.ts';
import { STORAGE_KEY } from '../config.ts';
import { todo } from '../core/todo.ts';

export const DEFAULT_SETTINGS: Readonly<UserSettings> = Object.freeze({
  preset: 'auto',
  pixelRatioCap: null,
  fpsCap: 60,
  dynamicResolution: true,
  debugOverlay: false,
});

/**
 * Read settings from storage (default: window.localStorage). Any access error, missing key or invalid
 * field falls back to DEFAULT_SETTINGS field-by-field. Never throws.
 */
export function loadSettings(storage?: Storage | null, key: string = STORAGE_KEY): UserSettings {
  void storage; void key;
  return todo('PIPE', 'loadSettings');
}

/** Persist settings; swallows storage errors. */
export function saveSettings(settings: UserSettings, storage?: Storage | null, key: string = STORAGE_KEY): void {
  void settings; void storage; void key;
  todo('PIPE', 'saveSettings');
}

/** Apply URL overrides (?quality=low|medium|high|auto, ?fps=0|60, ?dpr=1.5, ?dynres=0|1, ?debug=1). */
export function applyUrlOverrides(settings: UserSettings, search: string): UserSettings {
  void settings; void search;
  return todo('PIPE', 'applyUrlOverrides');
}
