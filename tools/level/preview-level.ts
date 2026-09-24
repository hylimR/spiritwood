/**
 * Browser-free level preview: renders the map (tiles, entities, zones, optional player trace) to a PNG.
 *
 *   node tools/level/preview-level.ts <out.png> [--scale 6] [--trace trace.json] [--crop x0,x1]
 *
 * `--trace` is a JSON array of [x, y] feet positions in world units (e.g. dumped by a playthrough).
 * `--crop` limits the output to tile columns x0..x1.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PALETTE } from '../../src/config.ts';
import { TileKind, type LevelData } from '../../src/contracts/level.ts';
import { tileAt } from '../../src/core/tiles.ts';
import { writePng } from '../preview/png.ts';
import { MAP_PATH } from './build-level.ts';
import { parseMapFile } from './mapfile.ts';

interface Canvas {
  w: number;
  h: number;
  px: Uint8ClampedArray;
}

function canvas(w: number, h: number): Canvas {
  return { w, h, px: new Uint8ClampedArray(w * h * 4) };
}

function blend(c: Canvas, x: number, y: number, color: number, alpha = 1): void {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (Math.floor(y) * c.w + Math.floor(x)) * 4;
  const r = (color >> 16) & 255;
  const g = (color >> 8) & 255;
  const b = color & 255;
  c.px[i] = (c.px[i] as number) * (1 - alpha) + r * alpha;
  c.px[i + 1] = (c.px[i + 1] as number) * (1 - alpha) + g * alpha;
  c.px[i + 2] = (c.px[i + 2] as number) * (1 - alpha) + b * alpha;
  c.px[i + 3] = 255;
}

function rect(c: Canvas, x0: number, y0: number, x1: number, y1: number, color: number, alpha = 1): void {
  for (let y = Math.max(0, Math.floor(y0)); y < Math.min(c.h, Math.ceil(y1)); y++) {
    for (let x = Math.max(0, Math.floor(x0)); x < Math.min(c.w, Math.ceil(x1)); x++) blend(c, x, y, color, alpha);
  }
}

function frame(c: Canvas, x0: number, y0: number, x1: number, y1: number, color: number, alpha = 1): void {
  rect(c, x0, y0, x1, y0 + 1, color, alpha);
  rect(c, x0, y1 - 1, x1, y1, color, alpha);
  rect(c, x0, y0, x0 + 1, y1, color, alpha);
  rect(c, x1 - 1, y0, x1, y1, color, alpha);
}

function disc(c: Canvas, cx: number, cy: number, r: number, color: number, alpha = 1): void {
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
    for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
      if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) blend(c, x, y, color, alpha);
    }
  }
}

const GRADE_TINT: Readonly<Record<string, number>> = {
  glade: 0x3fe0c5, gully: 0x8fa3b8, rootwell: 0x2f6fa0, canopy: 0xbff6ff, shrine: 0xffb45a,
};

export function renderLevel(level: LevelData, scale: number, trace: readonly (readonly [number, number])[] = [], cropCols?: [number, number]): Canvas {
  const T = level.tileSize;
  const [c0, c1] = cropCols ?? [0, level.widthTiles - 1];
  const s = scale / T;
  const ox = c0 * T;
  const c = canvas((c1 - c0 + 1) * scale, level.heightTiles * scale);
  const X = (x: number): number => (x - ox) * s;
  const Y = (y: number): number => y * s;

  for (let y = 0; y < c.h; y++) {
    const t = y / c.h;
    const col = ((PALETTE.skyTop >> 16) * (1 - t) + (PALETTE.fogFar >> 16) * t) << 16
      | (((PALETTE.skyTop >> 8) & 255) * (1 - t) + ((PALETTE.fogFar >> 8) & 255) * t) << 8
      | ((PALETTE.skyTop & 255) * (1 - t) + (PALETTE.fogFar & 255) * t);
    rect(c, 0, y, c.w, y + 1, col);
  }
  for (const z of level.gradeZones) rect(c, X(z.x), 0, X(z.x + z.w), 3, GRADE_TINT[z.grade] ?? 0xffffff);
  for (const z of level.gradeZones) rect(c, X(z.x), Y(z.y), X(z.x) + 1, Y(z.y + z.h), 0xffffff, 0.25);
  for (const sh of level.lightShafts) {
    const bottomCx = sh.x + sh.w / 2 + sh.h * Math.tan(sh.angle);
    for (let k = 0; k < sh.h; k += T / 4) {
      const f = k / sh.h;
      const w = sh.w * (1 + (sh.spread - 1) * f);
      const cx = sh.x + sh.w / 2 + (bottomCx - (sh.x + sh.w / 2)) * f;
      rect(c, X(cx - w / 2), Y(sh.y + k), X(cx + w / 2), Y(sh.y + k + T / 4), PALETTE.moonlight, 0.12 * sh.intensity * (1 - f * 0.6));
    }
  }
  for (let ty = 0; ty < level.heightTiles; ty++) {
    for (let tx = c0; tx <= c1; tx++) {
      const k = tileAt(level, tx, ty);
      const x0 = X(tx * T);
      const y0 = Y(ty * T);
      if (k === TileKind.Solid) {
        const top = tileAt(level, tx, ty - 1) !== TileKind.Solid;
        rect(c, x0, y0, x0 + scale, y0 + scale, 0x1b2735);
        if (top) rect(c, x0, y0, x0 + scale, y0 + Math.max(1, scale / 6), 0x3fe0c5, 0.8);
      } else if (k === TileKind.OneWay) {
        rect(c, x0, y0, x0 + scale, y0 + Math.max(1, scale / 4), 0x7de8d6);
      } else if (k === TileKind.Thorns) {
        rect(c, x0, y0 + scale / 3, x0 + scale, y0 + scale, PALETTE.thorns, 0.9);
      }
    }
  }
  for (const cp of level.checkpoints) frame(c, X(cp.x), Y(cp.y), X(cp.x + cp.w), Y(cp.y + cp.h), PALETTE.floraGlow);
  if (level.goal) rect(c, X(level.goal.x), Y(level.goal.y), X(level.goal.x + level.goal.w), Y(level.goal.y + level.goal.h), PALETTE.warmAccent, 0.8);
  for (const e of level.enemies) {
    rect(c, X(e.patrolMinX - 32), Y(e.y) - 2, X(e.patrolMaxX + 32), Y(e.y), PALETTE.thorns);
    rect(c, X(e.x - 32), Y(e.y - 44), X(e.x + 32), Y(e.y), PALETTE.thorns, 0.7);
  }
  for (const d of level.decorHints) {
    disc(c, X(d.x), Y(d.y) - scale / 2, Math.max(1.5, scale / 3), d.kind === 'lantern' ? PALETTE.warmAccent : PALETTE.floraGlow);
  }
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1] as readonly [number, number];
    const b = trace[i] as readonly [number, number];
    const steps = Math.max(1, Math.ceil(Math.hypot(X(b[0]) - X(a[0]), Y(b[1]) - Y(a[1]))));
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      blend(c, X(a[0] + (b[0] - a[0]) * f), Y(a[1] + (b[1] - a[1]) * f) - 1, 0xffffff, 0.9);
    }
  }
  for (const o of level.orbs) disc(c, X(o.x), Y(o.y), Math.max(1.5, scale / 4), PALETTE.spiritGlow);
  const p = level.playerStart;
  rect(c, X(p.x - 14), Y(p.y - 58), X(p.x + 14), Y(p.y), 0xffffff);
  return c;
}

function main(argv: readonly string[]): void {
  const out = argv[0];
  if (!out) {
    console.error('usage: node tools/level/preview-level.ts <out.png> [--scale 6] [--trace trace.json] [--crop x0,x1]');
    process.exitCode = 1;
    return;
  }
  const opt = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const scale = Number(opt('--scale') ?? 6);
  const tracePath = opt('--trace');
  const crop = opt('--crop')?.split(',').map(Number) as [number, number] | undefined;
  const trace = tracePath ? (JSON.parse(readFileSync(tracePath, 'utf8')) as [number, number][]) : [];
  const level = parseMapFile(readFileSync(MAP_PATH, 'utf8'));
  const img = renderLevel(level, scale, trace, crop);
  writePng(out, img.px, img.w, img.h);
  console.log(`wrote ${out} (${img.w}×${img.h})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
