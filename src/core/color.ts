export type RGB = [number, number, number];

/** 0xRRGGBB → [r, g, b] in 0..1, written into `out` when given. */
export function hexToRgb(hex: number, out: RGB = [0, 0, 0]): RGB {
  out[0] = ((hex >> 16) & 255) / 255;
  out[1] = ((hex >> 8) & 255) / 255;
  out[2] = (hex & 255) / 255;
  return out;
}

/** '#rrggbb' or 'rrggbb' → 0xRRGGBB. Throws on malformed input. */
export function parseHexColor(s: string): number {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(s.trim());
  if (!m) throw new Error(`Invalid colour: ${s}`);
  return parseInt(m[1] as string, 16);
}

export function rgbToHex(r: number, g: number, b: number): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (c(r) << 16) | (c(g) << 8) | c(b);
}

export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (
    (Math.round(ar + (br - ar) * t) << 16) |
    (Math.round(ag + (bg - ag) * t) << 8) |
    Math.round(ab + (bb - ab) * t)
  );
}

/** Rec. 709 luma of 0..1 components. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
