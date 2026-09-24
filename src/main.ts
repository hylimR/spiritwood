import { embeddedFetch, GAME_DATA, readEmbeddedFiles, shipsFile } from './assets/embedded.ts';
import { evalAllowed } from './core/csp.ts';
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
  if (!evalAllowed()) await import('pixi.js/unsafe-eval');
}

async function main(): Promise<void> {
  const boot = document.getElementById('boot');
  try {
    await ensureCspCompatible();
    const search = effectiveSearch();
    const embedded = readEmbeddedFiles(document);
    // The single-file build embeds only what it ships: without the plate manifest, #plates is ignored.
    const plates = new URLSearchParams(search).get('manifest') === 'plates'
      && shipsFile(embedded, GAME_DATA.platesManifest, document.baseURI);
    const game = await Game.boot({
      gameRoot: document.getElementById('game') as HTMLElement,
      uiRoot: document.getElementById('ui') as HTMLElement,
      levelUrl: GAME_DATA.level,
      manifestUrl: plates ? GAME_DATA.platesManifest : GAME_DATA.manifest,
      search,
      fetchFn: embedded ? embeddedFetch(embedded, document.baseURI, (input, init) => fetch(input, init)) : undefined,
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
