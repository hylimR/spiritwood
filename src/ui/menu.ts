import type { MetaInput } from '../contracts/input.ts';
import type { GpuInfo, UserSettings } from '../contracts/quality.ts';
import { classifyGpu, resolveQuality } from '../settings/quality.ts';
import { el, ensureUiStyles } from './styles.ts';

type Field = 'preset' | 'pixelRatioCap' | 'fpsCap' | 'dynamicResolution' | 'debugOverlay';
type VolumeField = 'masterVolume' | 'musicVolume' | 'sfxVolume';

interface OptionRow {
  kind: 'option';
  label: string;
  field: Field;
  values: readonly (UserSettings[Field])[];
  names: readonly string[];
}

/** A 0..1 slider stepped by VOLUME_STEP, clamped (no wrap), shown as a percentage; confirm does nothing. */
interface VolumeRow {
  kind: 'volume';
  label: string;
  field: VolumeField;
}

interface ActionRow {
  kind: 'action';
  label: string;
  action: 'resume' | 'restart';
}

type Row = OptionRow | VolumeRow | ActionRow;

export const VOLUME_STEP = 0.1;

const ROWS: readonly Row[] = [
  { kind: 'action', label: 'Resume', action: 'resume' },
  { kind: 'volume', label: 'Master volume', field: 'masterVolume' },
  { kind: 'volume', label: 'Music', field: 'musicVolume' },
  { kind: 'volume', label: 'Effects', field: 'sfxVolume' },
  { kind: 'option', label: 'Quality', field: 'preset', values: ['auto', 'high', 'medium', 'low'], names: ['Auto', 'High', 'Medium', 'Low'] },
  { kind: 'option', label: 'Pixel ratio', field: 'pixelRatioCap', values: [null, 1, 1.25, 1.5, 2], names: ['Auto', '1×', '1.25×', '1.5×', '2×'] },
  { kind: 'option', label: '60 fps cap', field: 'fpsCap', values: [60, 0], names: ['On', 'Off'] },
  { kind: 'option', label: 'Dynamic resolution', field: 'dynamicResolution', values: [true, false], names: ['On', 'Off'] },
  { kind: 'option', label: 'Debug overlay', field: 'debugOverlay', values: [false, true], names: ['Off', 'On'] },
  { kind: 'action', label: 'Restart level', action: 'restart' },
];

interface RowElements {
  row: Row;
  button: HTMLButtonElement;
  value: HTMLSpanElement | null;
}

/**
 * The option after (`dir` = 1) or before (−1) `current`, wrapping. An off-list number (a `?dpr=1.75`
 * override) steps to the nearest listed number in that direction (1.75 → 2 or 1.5), wrapping past the
 * ends like a listed value would.
 */
export function stepOption<T>(values: readonly T[], current: T, dir: 1 | -1): T {
  const n = values.length;
  const i = values.indexOf(current);
  if (i >= 0) return values[(i + dir + n) % n] as T;
  if (typeof current === 'number') {
    let best = -1;
    for (let k = 0; k < n; k++) {
      const v = values[k];
      if (typeof v !== 'number' || (dir > 0 ? v <= current : v >= current)) continue;
      const b = best >= 0 ? (values[best] as number) : Number.NaN;
      if (best < 0 || (dir > 0 ? v < b : v > b)) best = k;
    }
    if (best >= 0) return values[best] as T;
  }
  return values[dir > 0 ? 0 : n - 1] as T;
}

/**
 * The volume one VOLUME_STEP up (`dir` = 1) or down (−1), clamped to 0…1 — never wrapping. An off-grid
 * value (hand-edited storage) steps to the next grid value in that direction.
 */
export function stepVolume(current: number, dir: 1 | -1): number {
  const k = Math.max(0, Math.min(1, current)) / VOLUME_STEP;
  const next = dir > 0 ? Math.floor(k + 1e-6) + 1 : Math.ceil(k - 1e-6) - 1;
  const n = Math.round(1 / VOLUME_STEP);
  return Math.max(0, Math.min(n, next)) / n;
}

/** "80%". */
export function formatVolume(v: number): string {
  return `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;
}

/** Name for a (possibly off-list) value, e.g. a `?dpr=1.75` override. */
function valueName(row: OptionRow, v: UserSettings[Field]): string {
  const i = row.values.indexOf(v);
  if (i >= 0) return row.names[i] as string;
  return typeof v === 'number' ? `${v}×` : String(v);
}

/**
 * Pause / settings menu (DOM): Resume, Master / Music / Effects volume (0–100 % in 10 % steps, clamped,
 * confirm does nothing), Quality (auto/high/medium/low), Pixel ratio cap (auto/1/1.25/1.5/2), 60 fps cap
 * (on/off), Dynamic resolution (on/off), Debug overlay (on/off), Restart level. Works with mouse,
 * keyboard and gamepad (`navigate` reads MetaInput nav/confirm/back edges). Calls `onChange` with a new
 * settings object on every change (the orchestrator persists and applies it).
 *
 * Keyboard and gamepad both arrive through `navigate` (MetaInput), so keyboard-synthesised button
 * clicks (event.detail === 0) are ignored to avoid double actions; pointer clicks act directly.
 */
export class SettingsMenu {
  private readonly doc: Document;
  private readonly root: HTMLDivElement;
  private readonly gpuLine: HTMLDivElement;
  private readonly items: RowElements[] = [];
  private readonly onChange: (settings: UserSettings) => void;
  private readonly onResume: () => void;
  private readonly onRestart: () => void;
  private settings: UserSettings;
  private gpuLabel = '';
  private focusIndex = 0;
  private open_ = false;
  private returnFocus: HTMLElement | null = null;

  constructor(
    parent: HTMLElement,
    settings: UserSettings,
    onChange: (settings: UserSettings) => void,
    onResume: () => void,
    onRestart: () => void,
  ) {
    const doc = (this.doc = parent.ownerDocument);
    ensureUiStyles(doc);
    this.settings = { ...settings };
    this.onChange = onChange;
    this.onResume = onResume;
    this.onRestart = onRestart;

    this.root = el(doc, 'div', 'sw-layer sw-center sw-fade sw-hidden');
    this.root.style.pointerEvents = 'none';
    this.root.inert = true;
    const panel = el(doc, 'div', 'sw-menu sw-panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'sw-menu-title');
    const title = el(doc, 'h2', '', 'Paused');
    title.id = 'sw-menu-title';
    panel.append(title, el(doc, 'div', 'sw-hairline'));

    ROWS.forEach((row, index) => {
      const button = el(doc, 'button', 'sw-item');
      button.type = 'button';
      const label = el(doc, 'span', 'sw-caps', row.label);
      let value: HTMLSpanElement | null = null;
      button.append(label);
      if (row.kind !== 'action') {
        const box = el(doc, 'span', 'sw-value');
        const prev = el(doc, 'span', 'sw-arrow', '‹');
        const next = el(doc, 'span', 'sw-arrow', '›');
        value = el(doc, 'span');
        prev.setAttribute('aria-hidden', 'true');
        next.setAttribute('aria-hidden', 'true');
        prev.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.detail > 0) this.cycle(index, -1);
        });
        next.addEventListener('click', (e) => {
          e.stopPropagation();
          if (e.detail > 0) this.cycle(index, 1);
        });
        box.append(prev, value, next);
        button.append(box);
      }
      button.addEventListener('click', (e) => {
        if (e.detail > 0) this.activate(index);
      });
      button.addEventListener('focus', () => this.setFocus(index, false));
      button.addEventListener('pointerenter', () => {
        if (this.open_) this.setFocus(index, true);
      });
      panel.append(button);
      this.items.push({ row, button, value });
    });

    this.gpuLine = el(doc, 'div', 'sw-gpu sw-muted');
    panel.append(this.gpuLine);
    this.root.append(panel);
    parent.appendChild(this.root);
    this.refresh();
  }

  get isOpen(): boolean {
    return this.open_;
  }

  open(): void {
    if (this.open_) return;
    this.open_ = true;
    const active = this.doc.activeElement;
    this.returnFocus = active instanceof HTMLElement ? active : null;
    this.root.inert = false;
    this.root.classList.remove('sw-hidden');
    this.setFocus(0, true);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.root.classList.add('sw-hidden');
    this.root.inert = true;
    this.returnFocus?.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  /** Per-frame controller/keyboard navigation while open. */
  navigate(meta: MetaInput): void {
    if (!this.open_) return;
    const n = this.items.length;
    if (meta.navUp) this.setFocus((this.focusIndex + n - 1) % n, true);
    if (meta.navDown) this.setFocus((this.focusIndex + 1) % n, true);
    if (meta.navLeft) this.cycle(this.focusIndex, -1);
    if (meta.navRight) this.cycle(this.focusIndex, 1);
    if (meta.confirmPressed) this.activate(this.focusIndex);
  }

  /** Replace the menu's copy of the settings (changes made elsewhere, e.g. the F3 toggle). */
  setSettings(settings: UserSettings): void {
    this.settings = { ...settings };
    this.refresh();
  }

  setGpuLabel(label: string): void {
    this.gpuLabel = label;
    this.refresh();
  }

  destroy(): void {
    this.root.remove();
  }

  private setFocus(index: number, moveDom: boolean): void {
    this.focusIndex = index;
    for (let i = 0; i < this.items.length; i++) (this.items[i] as RowElements).button.classList.toggle('sw-focus', i === index);
    const b = (this.items[index] as RowElements).button;
    if (moveDom && this.doc.activeElement !== b) b.focus({ preventScroll: true });
  }

  private activate(index: number): void {
    const row = (this.items[index] as RowElements).row;
    if (row.kind === 'volume') return;
    if (row.kind === 'option') {
      this.cycle(index, 1);
      return;
    }
    if (row.action === 'resume') this.onResume();
    else this.onRestart();
  }

  private cycle(index: number, dir: 1 | -1): void {
    const row = (this.items[index] as RowElements).row;
    if (row.kind === 'action') return;
    let next: UserSettings;
    if (row.kind === 'volume') {
      const v = stepVolume(this.settings[row.field], dir);
      if (v === this.settings[row.field]) return;
      next = { ...this.settings, [row.field]: v };
    } else {
      next = { ...this.settings, [row.field]: stepOption(row.values, this.settings[row.field], dir) } as UserSettings;
    }
    this.settings = next;
    this.setFocus(index, false);
    this.refresh();
    this.onChange({ ...next });
  }

  private refresh(): void {
    for (const item of this.items) {
      const { row, button, value } = item;
      if (row.kind === 'action' || !value) continue;
      const name = row.kind === 'volume' ? formatVolume(this.settings[row.field]) : valueName(row, this.settings[row.field]);
      value.textContent = name;
      button.setAttribute('aria-label', `${row.label}: ${name}`);
    }
    const renderer = this.gpuLabel || 'unknown GPU';
    const gpu: GpuInfo = { renderer, vendor: '', tier: classifyGpu(this.gpuLabel, ''), maxTextureSize: 4096, timerQuery: false };
    const auto = resolveQuality({ ...this.settings, preset: 'auto' }, gpu);
    const dyn = auto.dynamicResolution ? ', dynamic resolution' : '';
    this.gpuLine.textContent = `${renderer} · ${gpu.tier} — auto resolves to ${auto.level}, ${auto.pixelRatioCap}× pixel ratio${dyn}`;
  }
}
