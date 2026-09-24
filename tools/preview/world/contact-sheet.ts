/**
 * Tile PNGs (same size) into one contact sheet, `cols` per row, downscaled by an integer factor.
 * Usage: node tools/preview/world/contact-sheet.ts <out.png> <cols> <factor> <in.png…>
 */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { writePng } from '../png.ts';

/** Decode an 8-bit RGB/RGBA, non-interlaced PNG (any filter types) to RGBA. */
function readPng(path: string): { w: number; h: number; data: Uint8Array } {
  const buf = readFileSync(path);
  let pos = 8;
  let w = 0;
  let h = 0;
  let type = 6;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const kind = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (kind === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      type = body[9] as number;
      if (body[8] !== 8 || (type !== 2 && type !== 6) || body[12] !== 0) throw new Error(`${path}: unsupported PNG format`);
    } else if (kind === 'IDAT') idat.push(body);
    pos += 12 + len;
  }
  const bpp = type === 6 ? 4 : 3;
  const stride = w * bpp;
  const raw = inflateSync(Buffer.concat(idat));
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)] as number;
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x] as number;
      const a = x >= bpp ? (px[y * stride + x - bpp] as number) : 0;
      const b = y > 0 ? (px[(y - 1) * stride + x] as number) : 0;
      const c = x >= bpp && y > 0 ? (px[(y - 1) * stride + x - bpp] as number) : 0;
      let pred = 0;
      if (f === 1) pred = a;
      else if (f === 2) pred = b;
      else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) {
        const p0 = a + b - c;
        const pa = Math.abs(p0 - a);
        const pb = Math.abs(p0 - b);
        const pc = Math.abs(p0 - c);
        pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      px[y * stride + x] = (v + pred) & 255;
    }
  }
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    for (let c = 0; c < 3; c++) data[i * 4 + c] = px[i * bpp + c] as number;
    data[i * 4 + 3] = bpp === 4 ? (px[i * bpp + 3] as number) : 255;
  }
  return { w, h, data };
}

const [out, colsArg, factorArg, ...inputs] = process.argv.slice(2);
const cols = Number(colsArg);
const f = Number(factorArg);
const imgs = inputs.map(readPng);
const tw = Math.floor((imgs[0] as { w: number }).w / f);
const th = Math.floor((imgs[0] as { h: number }).h / f);
const rows = Math.ceil(imgs.length / cols);
const W = cols * tw;
const H = rows * th;
const sheet = new Uint8Array(W * H * 4);
imgs.forEach((img, k) => {
  const ox = (k % cols) * tw;
  const oy = Math.floor(k / cols) * th;
  for (let y = 0; y < th; y++) {
    for (let x = 0; x < tw; x++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) s += img.data[((y * f + j) * img.w + x * f + i) * 4 + c] as number;
        sheet[((oy + y) * W + ox + x) * 4 + c] = s / (f * f);
      }
    }
  }
});
writePng(out as string, sheet, W, H);
console.log(`wrote ${out} (${W}×${H})`);
