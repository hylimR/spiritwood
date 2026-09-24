import { PALETTE } from '../../config.ts';
import { TileKind, type LevelData } from '../../contracts/level.ts';
import { Rng } from '../../core/rng.ts';
import { tileAt } from '../../core/tiles.ts';
import type { KitElement, KitMeta } from '../gen/kit.ts';
import type { KitCategory } from '../gen/kitElements.ts';
import type { KitInstance } from '../layers/placement.ts';

/** A gameplay-plane decor instance: a kit element plus its emissive colour. */
export interface DecorInstance extends KitInstance {
  glow: number;
}

/** Soft additive light pool around a lantern or big glowing plant (drawn with the particle atlas). */
export interface DecorHalo {
  x: number;
  y: number;
  radius: number;
  color: number;
  alpha: number;
  /** Flicker phase (lanterns flicker, flora breathes). */
  phase: number;
  flicker: number;
}

export interface DecorPlacement {
  /** Behind the hero (slot `terrain`). */
  back: DecorInstance[];
  /** In front of the hero's feet (slot `front`). */
  front: DecorInstance[];
  halos: DecorHalo[];
}

/** Lantern body centre relative to the element anchor (texels = units at scale 1), per variant. */
const LANTERN_BODY: readonly (readonly [number, number])[] = [[34, -88], [0, -112]];

/** How far decor sinks into the surface it stands on (u), hiding the base under the moss rim. */
export const DECOR_SINK = 3;
/** Grounded decor on floor tiles next to a drop stays this far from the tile's open side (u). */
const EDGE_INSET = 12;

type Tiles = Pick<LevelData, 'widthTiles' | 'heightTiles' | 'tiles'>;

function solid(level: Tiles, tx: number, ty: number): boolean {
  return tileAt(level, tx, ty) === TileKind.Solid;
}

function isEmpty(level: Tiles, tx: number, ty: number): boolean {
  return tileAt(level, tx, ty) === TileKind.Empty;
}

/**
 * Seeded decor placement from the tile grid and decor hints: grass tufts, flowers and mushrooms on
 * floors, hanging root tendrils under ceilings, branch bridges over one-way runs, bramble clusters on
 * thorn tiles, big glowing plants at Flora hints and lanterns (with light pools) at Lantern hints.
 * Every grounded instance is anchored on a solid tile's top surface. Deterministic per level seed.
 */
export function placeDecor(level: LevelData, kit: Pick<KitMeta, 'byCategory'>): DecorPlacement {
  const rng = new Rng((level.seed ^ 0xdec0) >>> 0);
  const T = level.tileSize;
  const back: DecorInstance[] = [];
  const front: DecorInstance[] = [];
  const halos: DecorHalo[] = [];
  let k = 1;
  const add = (
    list: DecorInstance[], category: KitCategory, x: number, y: number, scale: number, glow: number, flip = rng.chance(0.5), sy = scale,
  ): KitElement | null => {
    const pool = kit.byCategory[category];
    if (pool.length === 0) return null;
    const el = rng.pick(pool);
    list.push({ el, x, y, sx: flip ? -scale : scale, sy, phase: rng.range(0, Math.PI * 2), shade: rng.range(0.4, 0.6), k: k++, glow });
    return el;
  };

  for (let ty = 0; ty < level.heightTiles; ty++) {
    for (let tx = 0; tx < level.widthTiles; tx++) {
      const kind = tileAt(level, tx, ty);
      if (kind === TileKind.Solid) {
        // Floor: solid with open air above.
        if (ty > 0 && isEmpty(level, tx, ty - 1)) {
          const top = ty * T + DECOR_SINK;
          const openL = !solid(level, tx - 1, ty) || solid(level, tx - 1, ty - 1);
          const openR = !solid(level, tx + 1, ty) || solid(level, tx + 1, ty - 1);
          const x0 = tx * T + (openL ? EDGE_INSET : 2);
          const x1 = (tx + 1) * T - (openR ? EDGE_INSET : 2);
          if (rng.chance(0.62)) add(back, 'grass', rng.range(x0, x1), top, rng.range(0.8, 1.25), PALETTE.floraGlow);
          if (rng.chance(0.3)) add(front, 'grass', rng.range(x0, x1), top + 2, rng.range(0.6, 0.95), PALETTE.floraGlow);
          const r = rng.next();
          if (r < 0.07) add(back, 'flower', rng.range(x0, x1), top, rng.range(0.85, 1.2), PALETTE.floraGlow);
          else if (r < 0.11) add(back, 'shroom', rng.range(x0, x1), top, rng.range(0.8, 1.1), PALETTE.floraGlow);
        }
        // Ceiling: solid with open air below; roots dangle from overhangs.
        if (ty < level.heightTiles - 1 && isEmpty(level, tx, ty + 1) && rng.chance(0.2)) {
          add(back, 'tendril', tx * T + rng.range(10, T - 10), (ty + 1) * T - DECOR_SINK, rng.range(0.7, 1.15), PALETTE.floraGlow);
        }
      } else if (kind === TileKind.Thorns) {
        const onFloor = solid(level, tx, ty + 1) || !solid(level, tx, ty - 1);
        const glow = PALETTE.thorns;
        if (onFloor) {
          const base = (ty + 1) * T + DECOR_SINK;
          add(back, 'bramble', tx * T + rng.range(8, T - 8), base, rng.range(0.75, 1.0), glow);
          if (rng.chance(0.55)) add(back, 'bramble', tx * T + rng.range(4, T - 4), base, rng.range(0.55, 0.8), glow);
          if (rng.chance(0.3)) add(front, 'bramble', tx * T + rng.range(8, T - 8), base + 2, rng.range(0.45, 0.62), glow);
        } else {
          // Hanging thorns: mirror vertically from the ceiling.
          const s = rng.range(0.7, 0.95);
          add(back, 'bramble', tx * T + rng.range(8, T - 8), ty * T - DECOR_SINK, s, glow, rng.chance(0.5), -s);
        }
      }
    }
    // One-way runs → one stretched branch bridge per run (top surface on the tile top).
    let tx = 0;
    while (tx < level.widthTiles) {
      if (tileAt(level, tx, ty) !== TileKind.OneWay) {
        tx++;
        continue;
      }
      const start = tx;
      while (tx < level.widthTiles && tileAt(level, tx, ty) === TileKind.OneWay) tx++;
      const pool = kit.byCategory.bridge;
      if (pool.length === 0) continue;
      const el = rng.pick(pool);
      const width = (tx - start) * T + 16;
      const s = width / ((el.w - 12) * el.unitsPerTexel);
      back.push({
        el, x: ((start + tx) / 2) * T, y: ty * T + 1, sx: rng.chance(0.5) ? -s : s, sy: rng.range(0.9, 1.05),
        phase: 0, shade: rng.range(0.4, 0.6), k: k++, glow: PALETTE.floraGlow,
      });
    }
  }

  for (const hint of level.decorHints) {
    if (hint.kind === 'flora') {
      add(back, 'floraBig', hint.x, hint.y + DECOR_SINK, rng.range(0.95, 1.2), PALETTE.floraGlow);
      halos.push({ x: hint.x, y: hint.y - 110, radius: 150, color: PALETTE.floraGlow, alpha: 0.2, phase: rng.range(0, 6.28), flicker: 0.12 });
    } else {
      const el = add(back, 'lantern', hint.x, hint.y + DECOR_SINK, 1, PALETTE.warmAccent);
      if (!el) continue;
      const inst = back[back.length - 1] as DecorInstance;
      // Light pool centred on the lantern body (see the 'lantern' element: arm or post-top variant).
      const body = LANTERN_BODY[el.variant] ?? LANTERN_BODY[0] as readonly [number, number];
      halos.push({
        x: hint.x + body[0] * inst.sx, y: hint.y + DECOR_SINK + body[1], radius: 190, color: PALETTE.warmAccent, alpha: 0.3,
        phase: rng.range(0, 6.28), flicker: 0.18,
      });
    }
  }
  return { back, front, halos };
}
