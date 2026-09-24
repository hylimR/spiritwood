import { PALETTE } from '../../../src/config.ts';
import { hexToRgb } from '../../../src/core/color.ts';
import { DECOR_SHADE } from '../../../src/render/fx/decor.ts';
import { placeDecor, type DecorInstance } from '../../../src/render/fx/decorPlacement.ts';
import { shaftEnvelope, shaftTrapezoid } from '../../../src/render/fx/shaftGeometry.ts';
import { SHAFT_STRENGTH } from '../../../src/render/fx/shafts.ts';
import { buildChunks } from '../../../src/render/layers/kitMesh.ts';
import type { KitInstance } from '../../../src/render/layers/placement.ts';
import { drawKitChunks, type Frame, type Scene } from './compose.ts';
import { rasterTri } from './terrain-overlay.ts';

/** Light shafts: additive trapezoids with the shader's envelope (no shimmer). */
export function shaftsOverlay(scene: Scene): (img: Frame) => void {
  const traps = scene.level.lightShafts.map(shaftTrapezoid);
  const col = hexToRgb(PALETTE.spiritGlow);
  return (img) => {
    const toPx = (x: number, y: number): [number, number] => [(x - img.cam.cx + img.viewW / 2) / img.scale, (y - img.cam.cy + img.viewH / 2) / img.scale];
    for (const t of traps) {
      const a = toPx(t.topX, t.y0);
      const b = toPx(t.topX + t.topW, t.y0);
      const c = toPx(t.botX + t.botW, t.y1);
      const d = toPx(t.botX, t.y1);
      const shade = (i: number): void => {
        const px = (i % img.w + 0.5) * img.scale + img.cam.cx - img.viewW / 2;
        const py = (Math.floor(i / img.w) + 0.5) * img.scale + img.cam.cy - img.viewH / 2;
        const v = (py - t.y0) / (t.y1 - t.y0);
        const left = t.topX + (t.botX - t.topX) * v;
        const w = t.topW + (t.botW - t.topW) * v;
        const u = (px - left) / w;
        const k = shaftEnvelope(u, v) * t.intensity * SHAFT_STRENGTH * (0.62 + 0.38 * (0.5 + 0.5 * scene.noise.sample(u * 60, v * 20)));
        const o = i * 3;
        img.rgb[o] = (img.rgb[o] as number) + col[0] * k;
        img.rgb[o + 1] = (img.rgb[o + 1] as number) + col[1] * k;
        img.rgb[o + 2] = (img.rgb[o + 2] as number) + col[2] * k;
      };
      rasterTri(img, a[0], a[1], b[0], b[1], c[0], c[1], shade);
      rasterTri(img, a[0], a[1], c[0], c[1], d[0], d[1], shade);
    }
  };
}

/** Decor back + front (the hero would sit between them). */
export function decorOverlay(scene: Scene): { back: (img: Frame) => void; front: (img: Frame) => void; count: number } {
  const placement = placeDecor(scene.level, scene.kit);
  const opts = (list: DecorInstance[]) => buildChunks(list, {
    split: false, depthF: null, glow: (i: KitInstance) => (i as DecorInstance).glow, chunkWidth: 1536, originX: -768, swayAmp: 0,
    atlasW: scene.kit.width, atlasH: scene.kit.height,
  });
  const back = opts(placement.back);
  const front = opts(placement.front);
  const halos = placement.halos;
  return {
    back: (img) => drawKitChunks(img, scene, back, DECOR_SHADE, 1, 1, false),
    front: (img) => {
      drawKitChunks(img, scene, front, DECOR_SHADE, 1, 1, false);
      for (const h of halos) {
        const col = hexToRgb(h.color);
        const cx = (h.x - img.cam.cx + img.viewW / 2) / img.scale;
        const cy = (h.y - img.cam.cy + img.viewH / 2) / img.scale;
        const r = h.radius / img.scale;
        for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(img.h, cy + r); y++) {
          for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(img.w, cx + r); x++) {
            const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
            if (d >= 1) continue;
            const k = Math.exp(-d * d * 4.5) * h.alpha;
            const o = (y * img.w + x) * 3;
            img.rgb[o] = (img.rgb[o] as number) + col[0] * k;
            img.rgb[o + 1] = (img.rgb[o + 1] as number) + col[1] * k;
            img.rgb[o + 2] = (img.rgb[o + 2] as number) + col[2] * k;
          }
        }
      }
    },
    count: placement.back.length + placement.front.length,
  };
}

/** A sprinkle of ambient motes and fireflies (approximation of the particle view's look). */
export function particlesOverlay(seed = 3): (img: Frame) => void {
  return (img) => {
    let s = seed;
    const rnd = (): number => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    const teal = hexToRgb(PALETTE.floraGlow);
    const pale = hexToRgb(0x9fe8e0);
    for (let i = 0; i < 110; i++) {
      const firefly = i < 26;
      const cx = rnd() * img.w;
      const cy = (firefly ? 0.35 + 0.65 * rnd() : rnd()) * img.h;
      const r = firefly ? 7 + rnd() * 5 : 2 + rnd() * 3;
      const a = firefly ? (rnd() < 0.4 ? 0.9 : 0.25) : 0.25 + rnd() * 0.4;
      const col = rnd() < 0.6 ? teal : pale;
      for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(img.h, cy + r); y++) {
        for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(img.w, cx + r); x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
          if (d >= 1) continue;
          const k = (firefly ? Math.min(1, Math.exp(-d * d * 22) * 1.2 + Math.exp(-d * d * 3.2) * 0.45) : Math.exp(-d * d * 4.5)) * a;
          const o = (y * img.w + x) * 3;
          img.rgb[o] = (img.rgb[o] as number) + col[0] * k;
          img.rgb[o + 1] = (img.rgb[o + 1] as number) + col[1] * k;
          img.rgb[o + 2] = (img.rgb[o + 2] as number) + col[2] * k;
        }
      }
    }
  };
}
