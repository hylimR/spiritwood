/**
 * Minimal software renderer for the Pixi display trees our views build (Sprites and batched Meshes,
 * tint, alpha, normal/add blending, premultiplied alpha). Used only by the browser-free previews.
 */
import { Container, Matrix, Mesh, Sprite, type Texture } from 'pixi.js';

/** Premultiplied RGBA float framebuffer. */
export interface Frame {
  w: number;
  h: number;
  data: Float32Array;
}

export function createFrame(w: number, h: number): Frame {
  return { w, h, data: new Float32Array(w * h * 4) };
}

interface TexView {
  data: Uint8Array;
  width: number;
  fx: number;
  fy: number;
  fw: number;
  fh: number;
}

function texView(t: Texture): TexView {
  const src = t.source as unknown as { resource: Uint8Array; pixelWidth: number };
  return { data: src.resource, width: src.pixelWidth, fx: t.frame.x, fy: t.frame.y, fw: t.frame.width, fh: t.frame.height };
}

/** Bilinear premultiplied sample at frame-local pixel coords (u, v). */
function sample(t: TexView, u: number, v: number, out: Float32Array): void {
  const x = u - 0.5;
  const y = v - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  out[0] = out[1] = out[2] = out[3] = 0;
  for (let j = 0; j < 2; j++) {
    for (let i = 0; i < 2; i++) {
      const xx = Math.min(t.fw - 1, Math.max(0, x0 + i));
      const yy = Math.min(t.fh - 1, Math.max(0, y0 + j));
      const w = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      const o = ((t.fy + yy) * t.width + t.fx + xx) * 4;
      for (let c = 0; c < 4; c++) out[c] = (out[c] as number) + ((t.data[o + c] as number) / 255) * w;
    }
  }
  if (u < 0 || v < 0 || u > t.fw || v > t.fh) out[0] = out[1] = out[2] = out[3] = 0;
}

interface Style {
  r: number;
  g: number;
  b: number;
  a: number;
  add: boolean;
}

function blend(f: Frame, px: number, py: number, s: Float32Array, st: Style): void {
  const o = (py * f.w + px) * 4;
  const sa = (s[3] as number) * st.a;
  if (sa <= 0 && !st.add) return;
  const r = (s[0] as number) * st.r * st.a;
  const g = (s[1] as number) * st.g * st.a;
  const b = (s[2] as number) * st.b * st.a;
  const k = st.add ? 1 : 1 - sa;
  f.data[o] = r + (f.data[o] as number) * k;
  f.data[o + 1] = g + (f.data[o + 1] as number) * k;
  f.data[o + 2] = b + (f.data[o + 2] as number) * k;
  f.data[o + 3] = (st.add ? 0 : sa) + (f.data[o + 3] as number) * k;
}

function drawSprite(f: Frame, s: Sprite, m: Matrix, st: Style): void {
  const t = texView(s.texture);
  const ax = s.anchor.x * t.fw;
  const ay = s.anchor.y * t.fh;
  const det = m.a * m.d - m.b * m.c;
  if (Math.abs(det) < 1e-12) return;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [lx, ly] of [[-ax, -ay], [t.fw - ax, -ay], [-ax, t.fh - ay], [t.fw - ax, t.fh - ay]] as const) {
    const X = m.a * lx + m.c * ly + m.tx;
    const Y = m.b * lx + m.d * ly + m.ty;
    minX = Math.min(minX, X);
    maxX = Math.max(maxX, X);
    minY = Math.min(minY, Y);
    maxY = Math.max(maxY, Y);
  }
  const px = new Float32Array(4);
  for (let y = Math.max(0, Math.floor(minY)); y < Math.min(f.h, Math.ceil(maxY)); y++) {
    for (let x = Math.max(0, Math.floor(minX)); x < Math.min(f.w, Math.ceil(maxX)); x++) {
      const rx = x + 0.5 - m.tx;
      const ry = y + 0.5 - m.ty;
      const u = (m.d * rx - m.c * ry) / det + ax;
      const v = (-m.b * rx + m.a * ry) / det + ay;
      if (u < -1 || v < -1 || u > t.fw + 1 || v > t.fh + 1) continue;
      sample(t, u, v, px);
      blend(f, x, y, px, st);
    }
  }
}

function drawMesh(f: Frame, mesh: Mesh, m: Matrix, st: Style): void {
  const t = texView(mesh.texture);
  const geo = mesh.geometry as unknown as { positions: Float32Array; uvs: Float32Array; indices: Uint32Array };
  const pos = geo.positions;
  const uv = geo.uvs;
  const idx = geo.indices;
  const px = new Float32Array(4);
  for (let i = 0; i < idx.length; i += 3) {
    const vs = [idx[i] as number, idx[i + 1] as number, idx[i + 2] as number];
    const X = vs.map((k) => m.a * (pos[k * 2] as number) + m.c * (pos[k * 2 + 1] as number) + m.tx);
    const Y = vs.map((k) => m.b * (pos[k * 2] as number) + m.d * (pos[k * 2 + 1] as number) + m.ty);
    const U = vs.map((k) => (uv[k * 2] as number) * t.fw);
    const V = vs.map((k) => (uv[k * 2 + 1] as number) * t.fh);
    const [x0, x1, x2] = X as [number, number, number];
    const [y0, y1, y2] = Y as [number, number, number];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (Math.abs(area) < 1e-9) continue;
    for (let y = Math.max(0, Math.floor(Math.min(y0, y1, y2))); y < Math.min(f.h, Math.ceil(Math.max(y0, y1, y2))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(x0, x1, x2))); x < Math.min(f.w, Math.ceil(Math.max(x0, x1, x2))); x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
        const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        sample(t, w0 * (U[0] as number) + w1 * (U[1] as number) + w2 * (U[2] as number), w0 * (V[0] as number) + w1 * (V[1] as number) + w2 * (V[2] as number), px);
        blend(f, x, y, px, st);
      }
    }
  }
}

/** Render `root` (and descendants) into `f` with `view` as the parent transform. */
export function renderTree(f: Frame, root: Container, view: Matrix): void {
  const visit = (c: Container, parent: Matrix, st: Style): void => {
    if (!c.visible) return;
    c.updateLocalTransform();
    const m = parent.clone().append(c.localTransform);
    const tint = c.tint;
    const next: Style = {
      r: st.r * (((tint >> 16) & 255) / 255),
      g: st.g * (((tint >> 8) & 255) / 255),
      b: st.b * ((tint & 255) / 255),
      a: st.a * c.alpha,
      add: c.blendMode === 'inherit' ? st.add : c.blendMode === 'add',
    };
    if (c instanceof Sprite) drawSprite(f, c, m, next);
    else if (c instanceof Mesh) drawMesh(f, c, m, next);
    for (const child of c.children) visit(child, m, next);
  };
  visit(root, view, { r: 1, g: 1, b: 1, a: 1, add: false });
}

/** Separable box blur (premultiplied), `passes` times. */
export function blurFrame(f: Frame, radius: number, passes = 3): Frame {
  const out = createFrame(f.w, f.h);
  out.data.set(f.data);
  const tmp = new Float32Array(f.data.length);
  const norm = 1 / (2 * radius + 1);
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < f.h; y++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += out.data[(y * f.w + Math.min(f.w - 1, Math.max(0, k))) * 4 + c] as number;
        for (let x = 0; x < f.w; x++) {
          tmp[(y * f.w + x) * 4 + c] = s * norm;
          const add = Math.min(f.w - 1, x + radius + 1);
          const sub = Math.max(0, x - radius);
          s += (out.data[(y * f.w + add) * 4 + c] as number) - (out.data[(y * f.w + sub) * 4 + c] as number);
        }
      }
    }
    for (let x = 0; x < f.w; x++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let k = -radius; k <= radius; k++) s += tmp[(Math.min(f.h - 1, Math.max(0, k)) * f.w + x) * 4 + c] as number;
        for (let y = 0; y < f.h; y++) {
          out.data[(y * f.w + x) * 4 + c] = s * norm;
          const add = Math.min(f.h - 1, y + radius + 1);
          const sub = Math.max(0, y - radius);
          s += (tmp[(add * f.w + x) * 4 + c] as number) - (tmp[(sub * f.w + x) * 4 + c] as number);
        }
      }
    }
  }
  return out;
}
