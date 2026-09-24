import { Game } from './game/game.ts';

declare global {
  interface Window {
    /** Debug handle for the console and automated visual checks. */
    __spiritwood?: Game;
  }
}

async function main(): Promise<void> {
  const boot = document.getElementById('boot');
  try {
    const game = await Game.boot({
      gameRoot: document.getElementById('game') as HTMLElement,
      uiRoot: document.getElementById('ui') as HTMLElement,
      levelUrl: 'levels/forest.ldtk',
      manifestUrl: 'layers/forest.manifest.json',
      search: window.location.search,
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
