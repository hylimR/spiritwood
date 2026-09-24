/**
 * Shared DOM styling for the HUD, menu and debug overlay ("Moonlit Hush"): deep translucent navy
 * panels, thin teal hairlines, letter-spaced small caps and soft glows. System fonts only.
 */
const STYLE_ID = 'sw-ui-style';

const CSS = /* css */ `
.sw-layer {
  position: absolute; inset: 0; pointer-events: none; color: #d8f3ff;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased; user-select: none;
}
.sw-caps { text-transform: uppercase; letter-spacing: 0.28em; font-size: 11px; font-weight: 500; }
.sw-panel {
  background: linear-gradient(180deg, rgba(12, 30, 50, 0.78), rgba(6, 16, 30, 0.84));
  border: 1px solid rgba(63, 224, 197, 0.26); border-radius: 3px;
  box-shadow: inset 0 1px 0 rgba(191, 246, 255, 0.06), 0 18px 60px rgba(0, 4, 10, 0.55);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
}
.sw-hairline { height: 1px; background: linear-gradient(90deg, transparent, rgba(63, 224, 197, 0.55), transparent); }
.sw-hidden { opacity: 0 !important; visibility: hidden; }
.sw-fade { transition: opacity 0.9s ease, visibility 0s linear 0.9s; }
.sw-fade:not(.sw-hidden) { transition: opacity 0.6s ease, visibility 0s; }

.sw-orbs { position: absolute; top: 24px; left: 28px; display: flex; align-items: center; gap: 12px; }
.sw-orb-icon {
  width: 13px; height: 13px; border-radius: 50%;
  background: radial-gradient(circle at 42% 40%, #fffbe9 0%, #ffe0a8 32%, #ffb45a 62%, rgba(255, 180, 90, 0) 74%);
  box-shadow: 0 0 12px 3px rgba(255, 180, 90, 0.42);
}
.sw-orbs.sw-pulse .sw-orb-icon { animation: sw-pulse 0.55s cubic-bezier(0.2, 0.8, 0.3, 1); }
.sw-orb-count { font-variant-numeric: tabular-nums; text-shadow: 0 0 10px rgba(255, 196, 120, 0.35); }
.sw-orb-count b { font-weight: 600; color: #fff3dc; }
@keyframes sw-pulse {
  0% { transform: scale(1.9); box-shadow: 0 0 24px 9px rgba(255, 204, 130, 0.85); }
  100% { transform: scale(1); }
}

.sw-center { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; }
.sw-title { display: flex; flex-direction: column; align-items: center; gap: 22px; text-align: center; }
.sw-title h1 {
  margin: 0; font-weight: 200; font-size: clamp(36px, 6.2vw, 86px); letter-spacing: 0.42em; margin-right: -0.42em;
  color: #e9fbff; text-transform: uppercase;
  text-shadow: 0 0 18px rgba(191, 246, 255, 0.55), 0 0 60px rgba(63, 224, 197, 0.28);
}
.sw-title .sw-hairline { width: min(420px, 60vw); }
.sw-breathe { animation: sw-breathe 3.2s ease-in-out infinite; }
@keyframes sw-breathe { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }

.sw-controls {
  position: absolute; left: 50%; bottom: 34px; transform: translateX(-50%); display: flex; gap: 22px;
  padding: 10px 20px; white-space: nowrap;
}
.sw-controls span { opacity: 0.85; }
.sw-controls kbd {
  font-family: inherit; font-size: 10px; letter-spacing: 0.12em; padding: 2px 6px; margin-right: 8px;
  border: 1px solid rgba(63, 224, 197, 0.35); border-radius: 2px; color: #bff6ff;
}

.sw-card { min-width: 300px; padding: 28px 34px 26px; display: flex; flex-direction: column; gap: 16px; }
.sw-card h2 {
  margin: 0; font-weight: 300; font-size: 20px; letter-spacing: 0.3em; text-transform: uppercase; color: #eafcff;
  text-shadow: 0 0 14px rgba(191, 246, 255, 0.45);
}
.sw-rows { display: grid; grid-template-columns: auto auto; gap: 8px 28px; align-items: baseline; }
.sw-rows .sw-v { text-align: right; font-variant-numeric: tabular-nums; color: #fff; font-size: 14px; letter-spacing: 0.06em; }
.sw-muted { color: rgba(216, 243, 255, 0.55); }

.sw-menu { width: min(420px, 90vw); padding: 22px 0 16px; pointer-events: auto; }
.sw-menu h2 { margin: 0 28px 14px; font-weight: 300; font-size: 16px; letter-spacing: 0.34em; text-transform: uppercase; }
.sw-menu .sw-hairline { margin: 0 20px 8px; }
.sw-item {
  display: flex; width: 100%; align-items: center; justify-content: space-between; gap: 16px;
  padding: 11px 28px; border: 0; border-left: 2px solid transparent; background: transparent; color: inherit;
  font: inherit; text-align: left; cursor: pointer; outline: none;
  transition: background 0.18s ease, border-color 0.18s ease, text-shadow 0.18s ease;
}
.sw-item:focus-visible, .sw-item.sw-focus {
  background: linear-gradient(90deg, rgba(63, 224, 197, 0.14), rgba(63, 224, 197, 0.02));
  border-left-color: rgba(63, 224, 197, 0.9); text-shadow: 0 0 12px rgba(191, 246, 255, 0.7);
}
.sw-value { display: flex; align-items: center; gap: 10px; font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: #fff; }
.sw-arrow { opacity: 0; color: #3fe0c5; font-size: 14px; padding: 0 2px; transition: opacity 0.18s ease; }
.sw-item.sw-focus .sw-arrow, .sw-item:focus-visible .sw-arrow { opacity: 0.9; }
.sw-gpu { margin: 12px 28px 0; font-size: 10px; letter-spacing: 0.08em; line-height: 1.5; }

.sw-debug {
  position: absolute; top: 12px; right: 12px; padding: 10px 12px 8px; min-width: 260px;
  font: 11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #cdefff;
}
.sw-debug pre { margin: 0 0 6px; font: inherit; white-space: pre; }
.sw-debug canvas { display: block; width: 240px; height: 44px; }

@media (prefers-reduced-motion: reduce) {
  .sw-breathe, .sw-orbs.sw-pulse .sw-orb-icon { animation: none; }
  .sw-fade, .sw-fade:not(.sw-hidden), .sw-item { transition: none; }
}
`;

/** Inject the stylesheet once per document. */
export function ensureUiStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

/** `document.createElement` with a class list and optional text. */
export function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, className = '', text = ''): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** mm:ss.cc */
export function formatTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  const whole = Math.floor(rest);
  const cs = Math.floor((rest - whole) * 100);
  return `${m}:${String(whole).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
