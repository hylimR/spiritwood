export interface PackItem {
  w: number;
  h: number;
  /** Filled by packRects. */
  x?: number;
  y?: number;
}

interface Segment {
  x: number;
  y: number;
  w: number;
}

/**
 * Skyline bottom-left packer: items (tallest first, then widest, stable) go where their top edge
 * ends lowest, then leftmost. `gutter` texels separate items from each other and from the atlas
 * border. Returns the used height; throws if the items do not fit in `width × maxHeight`.
 */
export function packRects(items: PackItem[], width: number, maxHeight: number, gutter: number): number {
  const order = items.map((_, i) => i).sort((a, b) => {
    const A = items[a] as PackItem;
    const B = items[b] as PackItem;
    return B.h - A.h || B.w - A.w || a - b;
  });
  const sky: Segment[] = [{ x: gutter, y: gutter, w: width - gutter }];
  let used = gutter;
  for (const idx of order) {
    const it = items[idx] as PackItem;
    const w = it.w + gutter;
    const h = it.h + gutter;
    if (it.w + 2 * gutter > width) throw new Error(`Atlas item ${it.w}×${it.h} is wider than the atlas (${width})`);
    let bestI = -1;
    let bestY = Infinity;
    let bestTop = Infinity;
    for (let i = 0; i < sky.length; i++) {
      const x = (sky[i] as Segment).x;
      if (x + w > width) break;
      // Highest skyline under [x, x + w).
      let y = 0;
      let covered = 0;
      for (let j = i; j < sky.length && covered < w; j++) {
        const s = sky[j] as Segment;
        y = Math.max(y, s.y);
        covered = s.x + s.w - x;
      }
      if (covered < w) continue;
      if (y + h < bestTop || (y + h === bestTop && x < ((sky[bestI] as Segment | undefined)?.x ?? Infinity))) {
        bestTop = y + h;
        bestY = y;
        bestI = i;
      }
    }
    if (bestI < 0 || bestTop > maxHeight) throw new Error(`Atlas overflow: ${it.w}×${it.h} does not fit in ${width}×${maxHeight}`);
    const x = (sky[bestI] as Segment).x;
    it.x = x;
    it.y = bestY;
    used = Math.max(used, bestTop);
    // Replace the covered skyline span with the new top segment.
    const end = x + w;
    const next: Segment[] = [];
    for (const s of sky) {
      if (s.x + s.w <= x || s.x >= end) {
        next.push(s);
        continue;
      }
      if (s.x < x) next.push({ x: s.x, y: s.y, w: x - s.x });
      if (s.x + s.w > end) next.push({ x: end, y: s.y, w: s.x + s.w - end });
    }
    next.push({ x, y: bestTop, w });
    next.sort((a, b) => a.x - b.x);
    sky.length = 0;
    for (const s of next) {
      const last = sky[sky.length - 1];
      if (last && last.y === s.y && last.x + last.w === s.x) last.w += s.w;
      else sky.push(s);
    }
  }
  return used;
}
