/**
 * Render selected kit elements, shaded with the kit shading model in a near (rim-lit silhouette) and
 * a far (fogged) style over a night backdrop, for close art review of shapes.
 * Usage: node tools/preview/world/element-gallery.ts [outDir] [--zoom 1] [--before] [--lum] [category or spec key…]
 *   --before  the elements without the painterly strokes (the pre-M2 atlas)
 *   --lum     the stroke structure instead: the R channel (× the element's stroke gain) stretched ×1.5
 *             around 0.5 (0.5 = mid grey)
 */
import { hexToRgb } from '../../../src/core/color.ts';
import { generateKit, kitSeed } from '../../../src/render/gen/kit.ts';
import { ELEMENT_SPECS, STROKE_GAIN } from '../../../src/render/gen/kitElements.ts';
import { KIT_MODE, KIT_RIM_COLOR, shadeKit, type KitShadeParams } from '../../../src/render/layers/kitShading.ts';
import { outDir, save } from './common.ts';

const dir = outDir();
const args = process.argv.slice(3);
const zi = args.indexOf('--zoom');
const zoom = zi >= 0 ? Number(args[zi + 1]) : 1;
if (zi >= 0) args.splice(zi, 2);
const before = args.includes('--before');
const lumView = args.includes('--lum');
const names = args.filter((a) => !a.startsWith('--'));
const specs = ELEMENT_SPECS
  .filter((s) => names.length === 0 || names.includes(s.category) || names.includes(s.key ?? ''))
  .map((s) => (before ? { ...s, finalize: { ...s.finalize, strokes: null } } : s));
const t0 = performance.now();
const kit = generateKit(kitSeed('forest-kit'), 2048, 2048, specs);
console.log(`${kit.elements.length} elements in ${(performance.now() - t0).toFixed(0)} ms`);

const styles: { name: string; p: KitShadeParams }[] = [
  {
    name: 'near', p: {
      tint: hexToRgb(0x0a1522), fogColor: hexToRgb(0x1a3d52), fog: 0.05, desaturate: 0, rim: 0.8, rimColor: KIT_RIM_COLOR, glow: 1,
      mistY: 1e9, mistDepth: 1, mist: 0,
    },
  },
  {
    name: 'far', p: {
      tint: hexToRgb(0x1a2f4a), fogColor: hexToRgb(0x2b5673), fog: 0.55, desaturate: 0.2, rim: 0.2, rimColor: KIT_RIM_COLOR, glow: 0,
      mistY: 1e9, mistDepth: 1, mist: 0,
    },
  },
];

const pad = 10;
let rowW = pad;
let rowH = 0;
for (const el of kit.elements) {
  rowW += el.w * zoom + pad;
  rowH = Math.max(rowH, el.h * zoom);
}
const W = Math.min(4000, rowW);
// Wrap elements into lines no wider than W.
const lines: (typeof kit.elements)[] = [[]];
let x = pad;
for (const el of kit.elements) {
  if (x + el.w * zoom + pad > W && (lines[lines.length - 1] as unknown[]).length > 0) {
    lines.push([]);
    x = pad;
  }
  (lines[lines.length - 1] as typeof kit.elements).push(el);
  x += el.w * zoom + pad;
}
const lineH = lines.map((l) => Math.max(...l.map((e) => e.h * zoom)) + pad);
const H = pad + styles.length * lineH.reduce((a, b) => a + b, 0);
const img = new Float32Array(W * H * 3);
const top = hexToRgb(0x06101e);
const bottom = hexToRgb(0x1d4460);
for (let y = 0; y < H; y++) {
  for (let xx = 0; xx < W; xx++) {
    const t = (y % 400) / 400;
    for (let c = 0; c < 3; c++) img[(y * W + xx) * 3 + c] = (top[c] as number) + ((bottom[c] as number) - (top[c] as number)) * t;
  }
}
const tex = new Float32Array(4);
const out = new Float32Array(4);
const glow = hexToRgb(0x3fe0c5);
let oy = pad;
for (const st of styles) {
  lines.forEach((line, li) => {
    let ox = pad;
    for (const el of line) {
      // The layers that show an element shade it with the stroke gain it was baked for.
      const gain = before ? 1 : STROKE_GAIN[el.category];
      const p = { ...st.p, strokeGain: gain };
      for (let y = 0; y < el.h * zoom; y++) {
        for (let xx = 0; xx < el.w * zoom; xx++) {
          const tx = el.x + Math.floor(xx / zoom);
          const ty = el.y + Math.floor(y / zoom);
          const o = (ty * kit.width + tx) * 4;
          for (let c = 0; c < 4; c++) tex[c] = (kit.pixels[o + c] as number) / 255;
          if ((tex[3] as number) <= 0) continue;
          if (lumView) {
            const g = Math.min(1, Math.max(0, 0.5 + ((tex[0] as number) - 0.5) * 1.5 * gain));
            out[0] = g * (tex[3] as number);
            out[1] = g * (tex[3] as number);
            out[2] = g * (tex[3] as number);
            out[3] = tex[3] as number;
          } else {
            shadeKit(out, tex, 0.5, glow, 0, p, KIT_MODE.Band);
          }
          const i = ((oy + y) * W + ox + xx) * 3;
          const a = out[3] as number;
          for (let c = 0; c < 3; c++) img[i + c] = (out[c] as number) + (img[i + c] as number) * (1 - a);
        }
      }
      ox += el.w * zoom + pad;
    }
    oy += lineH[li] as number;
  });
}
const rgba = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) {
  for (let c = 0; c < 3; c++) rgba[i * 4 + c] = Math.max(0, Math.min(255, Math.round((img[i * 3 + c] as number) * 255)));
  rgba[i * 4 + 3] = 255;
}
save(dir, `gallery-${names.join('-') || 'all'}${before ? '-before' : ''}${lumView ? '-lum' : ''}.png`, rgba, W, H);
