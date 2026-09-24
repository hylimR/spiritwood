import type { LevelData } from '../../../src/contracts/level.ts';
import { levelFromAscii } from '../../../src/level/ascii.ts';

/**
 * A synthetic 200 × 50 forest level for previews (the real forest.ldtk belongs to SIM): rolling
 * ground, a thorn gully, a wall-jump shaft, high canopy platforms with one-way bridges, and a
 * lantern-lit clearing. Shafts and decor hints are added programmatically.
 */
export function previewLevel(): LevelData {
  const W = 200;
  const H = 50;
  const g: string[][] = [];
  for (let y = 0; y < H; y++) g.push(new Array<string>(W).fill('.'));
  const fill = (x0: number, y0: number, x1: number, y1: number, ch: string): void => {
    for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) (g[y] as string[])[x] = ch;
    }
  };
  // Borders.
  fill(0, 0, 1, H - 1, '#');
  fill(W - 2, 0, W - 1, H - 1, '#');
  // Hollow Glade: rolling ground.
  const ground = (x: number): number => 42 + Math.round(Math.sin(x * 0.11) * 1.2 + Math.sin(x * 0.037) * 1.5);
  for (let x = 2; x < 40; x++) fill(x, ground(x), x, H - 1, '#');
  fill(14, 38, 18, 38, '=');
  fill(26, 36, 29, 37, '#');
  // Thorn Gully.
  fill(40, 45, 70, H - 1, '#');
  fill(41, 44, 69, 44, '^');
  fill(46, 38, 48, 40, '#');
  fill(55, 36, 57, 38, '#');
  fill(63, 38, 65, 40, '#');
  fill(70, 40, 84, H - 1, '#');
  // Rootwell: tall shaft with walls.
  fill(84, 12, 86, H - 1, '#');
  fill(91, 8, 93, 40, '#');
  fill(86, 46, 91, H - 1, '#');
  fill(93, 40, 100, H - 1, '#');
  // Canopy Walk: high platforms and bridges.
  fill(93, 8, 104, 10, '#');
  fill(108, 12, 113, 12, '=');
  fill(118, 10, 126, 13, '#');
  fill(131, 14, 136, 14, '=');
  fill(140, 11, 158, 14, '#');
  fill(142, 15, 146, 18, '#');
  fill(163, 16, 167, 16, '=');
  fill(100, 44, 165, H - 1, '#');
  fill(120, 41, 124, 43, '#');
  // Moonwell: descent into the clearing.
  fill(165, 20, 170, 24, '#');
  fill(172, 28, 176, 28, '=');
  fill(165, 43, W - 3, H - 1, '#');
  fill(178, 34, 182, 34, '=');
  (g[41] as string[])[10] = 'P';
  const rows = g.map((r) => r.join(''));
  const level = levelFromAscii(rows, { id: 'preview', seed: 1234 });
  level.lightShafts.push(
    { id: 0, x: 20 * 48, y: 0, w: 260, h: 1900, angle: 0.18, spread: 1.7, intensity: 0.7 },
    { id: 1, x: 128 * 48, y: 0, w: 220, h: 1500, angle: 0.22, spread: 1.6, intensity: 0.6 },
    { id: 2, x: 150 * 48, y: 0, w: 180, h: 700, angle: 0.12, spread: 1.5, intensity: 0.5 },
  );
  level.decorHints.push(
    { id: 0, kind: 'flora', x: 22 * 48, y: ground(22) * 48 },
    { id: 1, kind: 'flora', x: 33 * 48, y: ground(33) * 48 },
    { id: 2, kind: 'flora', x: 150 * 48, y: 11 * 48 },
    { id: 0, kind: 'lantern', x: 180 * 48, y: 43 * 48 },
    { id: 1, kind: 'lantern', x: 186 * 48, y: 43 * 48 },
    { id: 2, kind: 'lantern', x: 192 * 48, y: 43 * 48 },
    { id: 3, kind: 'lantern', x: 175 * 48, y: 43 * 48 },
  );
  level.goal = { x: 190 * 48, y: 39 * 48, w: 144, h: 192 };
  return level;
}
