import type { QualityPreset, UserSettings } from '../contracts/quality.ts';
import { STORAGE_KEY } from '../config.ts';

export const DEFAULT_SETTINGS: Readonly<UserSettings> = Object.freeze({
  preset: 'auto',
  pixelRatioCap: null,
  fpsCap: 60,
  dynamicResolution: true,
  debugOverlay: false,
  masterVolume: 0.8,
  musicVolume: 0.6,
  sfxVolume: 0.8,
});

const PRESETS: readonly QualityPreset[] = ['auto', 'high', 'medium', 'low'];
/** Accepted pixel-ratio caps (a user override outside this range is ignored). */
export const MIN_PIXEL_RATIO_CAP = 0.5;
export const MAX_PIXEL_RATIO_CAP = 4;

function isPreset(v: unknown): v is QualityPreset {
  return typeof v === 'string' && (PRESETS as readonly string[]).includes(v);
}

function isPixelRatioCap(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= MIN_PIXEL_RATIO_CAP && v <= MAX_PIXEL_RATIO_CAP;
}

function defaultStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Field-by-field validation of an unknown value (e.g. parsed JSON) against DEFAULT_SETTINGS. */
export function sanitizeSettings(raw: unknown): UserSettings {
  const out: UserSettings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const r = raw as Record<string, unknown>;
  if (isPreset(r.preset)) out.preset = r.preset;
  if (r.pixelRatioCap === null || isPixelRatioCap(r.pixelRatioCap)) out.pixelRatioCap = r.pixelRatioCap;
  if (r.fpsCap === 60 || r.fpsCap === 0) out.fpsCap = r.fpsCap;
  if (typeof r.dynamicResolution === 'boolean') out.dynamicResolution = r.dynamicResolution;
  if (typeof r.debugOverlay === 'boolean') out.debugOverlay = r.debugOverlay;
  if (isVolume(r.masterVolume)) out.masterVolume = r.masterVolume;
  if (isVolume(r.musicVolume)) out.musicVolume = r.musicVolume;
  if (isVolume(r.sfxVolume)) out.sfxVolume = r.sfxVolume;
  return out;
}

function isVolume(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Read settings from storage (default: window.localStorage). Any access error, missing key or invalid
 * field falls back to DEFAULT_SETTINGS field-by-field. Never throws.
 */
export function loadSettings(storage?: Storage | null, key: string = STORAGE_KEY): UserSettings {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return { ...DEFAULT_SETTINGS };
  try {
    const text = store.getItem(key);
    return text === null ? { ...DEFAULT_SETTINGS } : sanitizeSettings(JSON.parse(text));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist settings; swallows storage errors. */
export function saveSettings(settings: UserSettings, storage?: Storage | null, key: string = STORAGE_KEY): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  const clean = sanitizeSettings(settings);
  try {
    store.setItem(key, JSON.stringify(clean));
  } catch {
    // Quota exceeded, private mode or storage disabled: settings simply don't persist.
  }
}

/** Apply URL overrides (?quality=low|medium|high|auto, ?fps=0|60, ?dpr=1.5, ?dynres=0|1, ?debug=1). */
export function applyUrlOverrides(settings: UserSettings, search: string): UserSettings {
  const out: UserSettings = { ...settings };
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return out;
  }
  const quality = params.get('quality')?.toLowerCase();
  if (isPreset(quality)) out.preset = quality;

  const fps = params.get('fps');
  if (fps === '0') out.fpsCap = 0;
  else if (fps === '60') out.fpsCap = 60;

  const dpr = params.get('dpr');
  if (dpr !== null && dpr.trim() !== '') {
    const v = Number(dpr);
    if (isPixelRatioCap(v)) out.pixelRatioCap = v;
  }

  const dynres = params.get('dynres');
  if (dynres === '0' || dynres === 'false') out.dynamicResolution = false;
  else if (dynres === '1' || dynres === 'true') out.dynamicResolution = true;

  const debug = params.get('debug');
  if (debug === '' || debug === '1' || debug === 'true') out.debugOverlay = true;
  else if (debug === '0' || debug === 'false') out.debugOverlay = false;
  return out;
}
