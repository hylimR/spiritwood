import { Game } from './game/game.ts';

declare global {
  interface Window {
    /** Debug handle for the console and automated visual checks. */
    __spiritwood?: Game;
  }
}

const HASH_FLAGS: Readonly<Record<string, string>> = {
  bench: 'bench',
  plates: 'manifest=plates',
  debug: 'debug=1',
  high: 'quality=high',
  medium: 'quality=medium',
  low: 'quality=low',
  uncapped: 'fps=0',
};

/**
 * Query flags, plus `#token[-token…]` equivalents for hosts that only pass a plain hash to the page
 * (e.g. Claude artifacts): `#bench`, `#plates`, `#debug`, `#low`, `#bench-low`.
 */
function effectiveSearch(): string {
  const params = new URLSearchParams(window.location.search);
  for (const token of window.location.hash.slice(1).split('-')) {
    const flag = HASH_FLAGS[token.toLowerCase()];
    if (!flag) continue;
    const [key, value = ''] = flag.split('=') as [string, string?];
    if (!params.has(key)) params.set(key, value);
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

/** PixiJS generates uniform/particle sync code with `new Function`; strict CSP hosts forbid it. */
async function ensureCspCompatible(): Promise<void> {
  try {
    new Function('');
  } catch {
    await import('pixi.js/unsafe-eval');
  }
}

async function main(): Promise<void> {
  const boot = document.getElementById('boot');
  try {
    await ensureCspCompatible();
    const search = effectiveSearch();
    const game = await Game.boot({
      gameRoot: document.getElementById('game') as HTMLElement,
      uiRoot: document.getElementById('ui') as HTMLElement,
      levelUrl: 'levels/forest.ldtk',
      manifestUrl: new URLSearchParams(search).get('manifest') === 'plates'
        ? 'layers/forest.plates.manifest.json'
        : 'layers/forest.manifest.json',
      search,
    });
    window.__spiritwood = game;
    boot?.classList.add('hidden');
  } catch (err) {
    console.error(err);
    if (boot) {
      boot.classList.add('error');
      boot.textContent = `Could not start.\n\n${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

void main();
