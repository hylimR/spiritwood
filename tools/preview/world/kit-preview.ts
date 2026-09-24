/**
 * Dump the procedural kit atlas (a shaded composite, each channel, the split-hull overlay) and the
 * particle atlas.
 * Usage: node tools/preview/world/kit-preview.ts [outDir]
 */
import { generateKit, kitSeed } from '../../../src/render/gen/kit.ts';
import { generateParticleAtlas } from '../../../src/render/gen/particleAtlas.ts';
import { canvas, downsample, outDir, save } from './common.ts';

const dir = outDir();
const t0 = performance.now();
const kit = generateKit(kitSeed('forest-kit'));
const ms = performance.now() - t0;
console.log(`kit: ${kit.elements.length} elements, ${kit.width}×${kit.height}, ${ms.toFixed(0)} ms`);

const { width: W, height: H, pixels } = kit;
const comp = canvas(W, H, 0x1b2f45);
const chans = [canvas(W, H, 0), canvas(W, H, 0), canvas(W, H, 0), canvas(W, H, 0)];
for (let i = 0; i < W * H; i++) {
  const r = (pixels[i * 4] as number) / 255;
  const g = (pixels[i * 4 + 1] as number) / 255;
  const b = (pixels[i * 4 + 2] as number) / 255;
  const a = (pixels[i * 4 + 3] as number) / 255;
  // Approximate the kit shader: dark tint × detail + moonlit rim + teal emissive.
  const k = 0.55 + 0.9 * r;
  let cr = 0.09 * k + g * 0.55 * 0.85;
  let cg = 0.13 * k + g * 0.55 * 0.95;
  let cb = 0.19 * k + g * 0.55;
  cr = cr * (1 - b) + 0.25 * b * 1.6;
  cg = cg * (1 - b) + 0.88 * b * 1.6;
  cb = cb * (1 - b) + 0.77 * b * 1.6;
  for (let c = 0; c < 3; c++) {
    const src = [cr, cg, cb][c] as number;
    comp[i * 4 + c] = Math.min(255, (comp[i * 4 + c] as number) * (1 - a) + src * 255 * a);
  }
  for (let c = 0; c < 4; c++) {
    const v = pixels[i * 4 + c] as number;
    const ch = chans[c] as Uint8Array;
    ch[i * 4] = v;
    ch[i * 4 + 1] = v;
    ch[i * 4 + 2] = v;
  }
}
const small = downsample(comp, W, H, 2);
save(dir, 'kit-composite.png', small.data, small.w, small.h);
const names = ['kit-R-luminance.png', 'kit-G-rim.png', 'kit-B-emissive.png', 'kit-A-coverage.png'];
for (let c = 0; c < 4; c++) {
  const s = downsample(chans[c] as Uint8Array, W, H, 2);
  save(dir, names[c] as string, s.data, s.w, s.h);
}

// Hull overlay: core in green, soft band in red, over the composite.
const hull = comp.slice();
let coreArea = 0;
let softArea = 0;
let rects = 0;
for (const el of kit.elements) {
  coreArea += el.coreArea;
  softArea += el.softArea;
  for (const [list, col] of [[el.soft, [255, 60, 60]], [el.core, [60, 255, 90]]] as const) {
    for (let i = 0; i < list.length; i += 4) {
      rects++;
      const x0 = el.x + (list[i] as number);
      const y0 = el.y + (list[i + 1] as number);
      const x1 = el.x + (list[i + 2] as number);
      const y1 = el.y + (list[i + 3] as number);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * W + x) * 4;
          const edge = x === x0 || y === y0 || x === x1 - 1 || y === y1 - 1;
          const t = edge ? 0.9 : 0.25;
          for (let c = 0; c < 3; c++) hull[o + c] = (hull[o + c] as number) * (1 - t) + (col[c] as number) * t;
        }
      }
    }
  }
}
const hs = downsample(hull, W, H, 2);
save(dir, 'kit-hulls.png', hs.data, hs.w, hs.h);
console.log(`hull rects ${rects}, core area ${(coreArea / 1e6).toFixed(2)} Mtexel, soft ${(softArea / 1e6).toFixed(2)} Mtexel`);

// Particle atlas at 2× over a dark background (straight alpha, white sprites).
const pa = generateParticleAtlas();
const pw = pa.width * 2;
const ph = pa.height * 2;
const pc = canvas(pw, ph, 0x0d1826);
for (let y = 0; y < ph; y++) {
  for (let x = 0; x < pw; x++) {
    const s = ((y >> 1) * pa.width + (x >> 1)) * 4;
    const a = (pa.pixels[s + 3] as number) / 255;
    const o = (y * pw + x) * 4;
    for (let c = 0; c < 3; c++) pc[o + c] = (pc[o + c] as number) * (1 - a) + (pa.pixels[s + c] as number) * a;
  }
}
save(dir, 'particle-atlas.png', pc, pw, ph);
