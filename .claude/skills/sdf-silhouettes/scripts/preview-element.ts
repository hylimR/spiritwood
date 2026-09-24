/**
 * Browser-free look at kit elements: every variant of every spec matching a category or a spec key,
 * rasterised exactly as in the atlas (same seed key, rng, reach configuration and noise offset as
 * src/render/gen/kit.ts), written as PNGs you can open with the Read tool. One row per matching spec.
 *   <name>-near.png   shaded like tools/preview/world/kit-preview.ts, upscaled (near-layer reading)
 *   <name>-far.png    box-downsampled (far-layer / thumbnail reading: the squint test)
 *   <name>-alpha.png  coverage only, white on black (pure silhouette)
 * Usage: node .claude/skills/sdf-silhouettes/scripts/preview-element.ts <category|key> [outDir] [--up N] [--down N]
 *   e.g. farTree (all five far archetypes), farWillow (one spec), midTrunk, nearTrunk, fern
 */
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashString, Rng } from '../../../../src/core/rng.ts';
import { kitSeed } from '../../../../src/render/gen/kit.ts';
import { ELEMENT_MARGIN, ELEMENT_SPECS, type ElementSpec } from '../../../../src/render/gen/kitElements.ts';
import { NoiseTable } from '../../../../src/render/gen/noiseTable.ts';
import { ElementRaster, Scratch } from '../../../../src/render/gen/raster.ts';
import { canvas, downsample, save } from '../../../../tools/preview/world/common.ts';

const args = process.argv.slice(2);
const flag = (name: string, def: number): number => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const positional = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && (args[i - 1] as string).startsWith('--')));
const name = positional[0] ?? '';
const dir = positional[1] ?? join(tmpdir(), 'spiritwood-preview', 'elements');
const up = flag('--up', 2);
const down = flag('--down', 4);
const specs = ELEMENT_SPECS.filter((s) => s.category === name || s.key === name);
if (specs.length === 0) {
  const names = new Set<string>();
  for (const s of ELEMENT_SPECS) {
    names.add(s.category);
    if (s.key) names.add(s.key);
  }
  console.error(`unknown category or key '${name}'; one of: ${[...names].join(', ')}`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

// kit.ts numbers jobs across all specs in order; the element's noise offset is its job index + 1.
const firstJob = new Map<ElementSpec, number>();
let job = 0;
for (const s of ELEMENT_SPECS) {
  firstJob.set(s, job);
  job += s.variants;
}
const seed = kitSeed('forest-kit');
const noise = new NoiseTable(seed ^ 0x5eed);
const scratch = new Scratch();
const gap = 8;
const W = Math.max(...specs.map((s) => s.variants * (s.w + gap) - gap));
const H = specs.reduce((h, s) => h + s.h, 0) + gap * (specs.length - 1);
const raw = new Uint8Array(W * H * 4);
let rowY = 0;
for (const spec of specs) {
  const key = spec.key ?? spec.category;
  for (let v = 0; v < spec.variants; v++) {
    const t0 = performance.now();
    const rng = new Rng((hashString(`${key}:${v}`) ^ seed) >>> 0);
    const r = new ElementRaster(spec.w, spec.h, noise, (firstJob.get(spec) as number) + v + 1, scratch);
    r.configure(spec.finalize);
    spec.draw(r, rng, v);
    r.finalize(raw, W, v * (spec.w + gap), rowY, { edgeFade: ELEMENT_MARGIN, cut: spec.cut, ...spec.finalize });
    console.log(`${key}:${v} ${spec.w}×${spec.h} in ${(performance.now() - t0).toFixed(1)} ms`);
  }
  rowY += spec.h + gap;
}

// Approximation of the kit shader: dark tint × luminance detail + moonlit rim + teal emissive.
const comp = canvas(W, H, 0x1b2f45);
const alpha = canvas(W, H, 0x000000);
for (let i = 0; i < W * H; i++) {
  const r = (raw[i * 4] as number) / 255;
  const g = (raw[i * 4 + 1] as number) / 255;
  const b = (raw[i * 4 + 2] as number) / 255;
  const a = (raw[i * 4 + 3] as number) / 255;
  const k = 0.55 + 0.9 * r;
  const lit = [0.09 * k + g * 0.47, 0.13 * k + g * 0.52, 0.19 * k + g * 0.55];
  const glow = [0.4, 1.4, 1.23];
  for (let c = 0; c < 3; c++) {
    const src = (lit[c] as number) * (1 - b) + (glow[c] as number) * b;
    comp[i * 4 + c] = Math.min(255, (comp[i * 4 + c] as number) * (1 - a) + src * 255 * a);
    alpha[i * 4 + c] = Math.round(a * 255);
  }
}
const near = new Uint8Array(W * up * H * up * 4);
for (let y = 0; y < H * up; y++) {
  for (let x = 0; x < W * up; x++) {
    const s = (Math.floor(y / up) * W + Math.floor(x / up)) * 4;
    near.set(comp.subarray(s, s + 4), (y * W * up + x) * 4);
  }
}
save(dir, `${name}-near.png`, near, W * up, H * up);
const far = downsample(comp, W, H, down);
save(dir, `${name}-far.png`, far.data, far.w, far.h);
save(dir, `${name}-alpha.png`, alpha, W, H);
