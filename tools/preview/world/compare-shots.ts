/**
 * Compare CPU scene previews with GPU screenshots of the same cameras (e.g. scene-preview.ts --shots
 * against the main session's shots/m2-base PNGs): mean luma of each, mean signed and absolute luma
 * difference (8-bit codes) over the frame and a grid of regions, and a side-by-side PNG (GPU left,
 * CPU right, |difference| ×4 below) for eyeballing.
 *
 *   node tools/preview/world/compare-shots.ts <gpuDir> <cpuDir> <outDir> [--suffix -before] [names…]
 *
 * Names default to every `<name>.png` in gpuDir that has a `scene-<name><suffix>.png` in cpuDir. The
 * HUD is masked out (the orb counter and the controls bar are only in the GPU shots).
 */
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { writePng } from '../png.ts';

const argv = process.argv.slice(2);
const si = argv.indexOf('--suffix');
const suffix = si >= 0 ? (argv[si + 1] as string) : '';
if (si >= 0) argv.splice(si, 2);
const [gpuDir, cpuDir, out, ...only] = argv;
if (!gpuDir || !cpuDir || !out) throw new Error('usage: compare-shots.ts <gpuDir> <cpuDir> <outDir> [names…]');
mkdirSync(out, { recursive: true });

async function rgba(path: string): Promise<{ data: Uint8Array; w: number; h: number }> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), w: info.width, h: info.height };
}

const luma = (d: Uint8Array, o: number): number => 0.2126 * (d[o] as number) + 0.7152 * (d[o + 1] as number) + 0.0722 * (d[o + 2] as number);

/** HUD rectangles in 1280×720 shots: the orb counter (top left) and the controls bar (bottom centre). */
function hud(x: number, y: number, w: number, h: number): boolean {
  const sx = x * (1280 / w);
  const sy = y * (720 / h);
  return (sx < 130 && sy < 50) || (sx > 390 && sx < 890 && sy > 645 && sy < 692);
}

const names = only.length
  ? only
  : readdirSync(gpuDir).filter((f) => f.endsWith('.png')).map((f) => f.slice(0, -4)).filter((n) => existsSync(join(cpuDir, `scene-${n}${suffix}.png`)));
const G = 4;
for (const name of names) {
  const a = await rgba(join(gpuDir, `${name}.png`));
  const b = await rgba(join(cpuDir, `scene-${name}${suffix}.png`));
  if (a.w !== b.w || a.h !== b.h) throw new Error(`${name}: size ${a.w}×${a.h} vs ${b.w}×${b.h}`);
  const { w, h } = a;
  let la = 0;
  let lb = 0;
  let sd = 0;
  let ad = 0;
  let n = 0;
  const cells = new Float64Array(G * G * 3);
  const side = new Uint8Array(w * 2 * h * 2 * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const ya = luma(a.data, o);
      const yb = luma(b.data, o);
      for (let c = 0; c < 4; c++) {
        side[(y * w * 2 + x) * 4 + c] = a.data[o + c] as number;
        side[(y * w * 2 + w + x) * 4 + c] = b.data[o + c] as number;
      }
      const dv = Math.min(255, Math.abs(ya - yb) * 4);
      const od = ((h + y) * w * 2 + x + (w >> 1)) * 4;
      side[od] = dv;
      side[od + 1] = dv;
      side[od + 2] = dv;
      side[od + 3] = 255;
      if (hud(x, y, w, h)) continue;
      la += ya;
      lb += yb;
      sd += yb - ya;
      ad += Math.abs(yb - ya);
      n++;
      const ci = (Math.min(G - 1, Math.floor((y / h) * G)) * G + Math.min(G - 1, Math.floor((x / w) * G))) * 3;
      cells[ci] = (cells[ci] as number) + (yb - ya);
      cells[ci + 1] = (cells[ci + 1] as number) + Math.abs(yb - ya);
      cells[ci + 2] = (cells[ci + 2] as number) + 1;
    }
  }
  for (let i = 0; i < w * 2 * h * 2; i++) if ((side[i * 4 + 3] as number) === 0) side[i * 4 + 3] = 255;
  writePng(join(out, `compare-${name}.png`), side, w * 2, h * 2);
  const grid: string[] = [];
  for (let gy = 0; gy < G; gy++) {
    const row: string[] = [];
    for (let gx = 0; gx < G; gx++) {
      const ci = (gy * G + gx) * 3;
      const k = Math.max(1, cells[ci + 2] as number);
      row.push(`${((cells[ci] as number) / k).toFixed(1).padStart(5)}`);
    }
    grid.push(row.join(' '));
  }
  console.log(
    `${name}: mean luma GPU ${(la / n).toFixed(1)} CPU ${(lb / n).toFixed(1)}; CPU−GPU mean ${(sd / n).toFixed(2)}, mean |Δ| ${(ad / n).toFixed(2)} codes`,
  );
  console.log(`  signed Δ by region (${G}×${G}):\n    ${grid.join('\n    ')}`);
}
