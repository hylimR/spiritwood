import { TileKind, type LevelData } from '../../contracts/level.ts';
import { tileAt } from '../../core/tiles.ts';

/**
 * Static light baked into terrain vertices (pure): warm spill around lanterns, teal spill around
 * big glowing flora, rose spill near thorns, each 0..1. Positions are fixed, so this costs nothing
 * per frame; the flicker lives in the additive light pools drawn on top.
 */
export const TERRAIN_LIGHTS = Object.freeze({
  lantern: { dy: -100, radius: 330, strength: 1 },
  flora: { dy: -80, radius: 240, strength: 0.8 },
  thorn: { radius: 130, strength: 0.34, reach: 3 },
});

/** Direction toward the moon (upper left), normalised. */
export const MOON_DIR: readonly [number, number] = [-0.55, -0.83];

type LightLevel = Pick<LevelData, 'widthTiles' | 'heightTiles' | 'tiles' | 'tileSize'> & Partial<Pick<LevelData, 'decorHints'>>;

function falloff(d2: number, r: number): number {
  const t = 1 - Math.sqrt(d2) / r;
  return t <= 0 ? 0 : t * t;
}

export class TerrainLights {
  private readonly lanterns: number[] = [];
  private readonly flora: number[] = [];
  private readonly level: LightLevel;
  /** Per tile: 1 when a thorn tile lies within `thorn.reach` tiles (skips the neighbourhood scan). */
  private readonly nearThorn: Uint8Array;

  constructor(level: LightLevel) {
    this.level = level;
    const W = level.widthTiles;
    const H = level.heightTiles;
    const R = TERRAIN_LIGHTS.thorn.reach;
    this.nearThorn = new Uint8Array(W * H);
    for (let ty = 0; ty < H; ty++) {
      for (let tx = 0; tx < W; tx++) {
        if (tileAt(level, tx, ty) !== TileKind.Thorns) continue;
        for (let j = Math.max(0, ty - R); j <= Math.min(H - 1, ty + R); j++) {
          for (let i = Math.max(0, tx - R); i <= Math.min(W - 1, tx + R); i++) this.nearThorn[j * W + i] = 1;
        }
      }
    }
    for (const h of level.decorHints ?? []) {
      if (h.kind === 'lantern') this.lanterns.push(h.x, h.y + TERRAIN_LIGHTS.lantern.dy);
      else this.flora.push(h.x, h.y + TERRAIN_LIGHTS.flora.dy);
    }
  }

  /** Fills out = [warm, flora, thorn] (0..1) at world (x, y). */
  sample(x: number, y: number, out: number[]): number[] {
    const L = TERRAIN_LIGHTS;
    let warm = 0;
    const lr = L.lantern.radius;
    for (let i = 0; i < this.lanterns.length; i += 2) {
      const dx = x - (this.lanterns[i] as number);
      const dy = y - (this.lanterns[i + 1] as number);
      const d2 = dx * dx + dy * dy;
      if (d2 < lr * lr) warm += falloff(d2, lr) * L.lantern.strength;
    }
    let flora = 0;
    const fr = L.flora.radius;
    for (let i = 0; i < this.flora.length; i += 2) {
      const dx = x - (this.flora[i] as number);
      const dy = y - (this.flora[i + 1] as number);
      const d2 = dx * dx + dy * dy;
      if (d2 < fr * fr) flora += falloff(d2, fr) * L.flora.strength;
    }
    let thorn = 0;
    const T = this.level.tileSize;
    const tx = Math.floor(x / T);
    const ty = Math.floor(y / T);
    const W = this.level.widthTiles;
    const near = tx >= 0 && ty >= 0 && tx < W && ty < this.level.heightTiles && this.nearThorn[ty * W + tx] === 1;
    const R = near ? L.thorn.reach : -1;
    const tr = L.thorn.radius;
    for (let j = -R; j <= R; j++) {
      for (let i = -R; i <= R; i++) {
        const cx = tx + i;
        const cy = ty + j;
        if (cx < 0 || cy < 0 || cx >= this.level.widthTiles || cy >= this.level.heightTiles) continue;
        if (tileAt(this.level, cx, cy) !== TileKind.Thorns) continue;
        const dx = x - (cx + 0.5) * T;
        const dy = y - (cy + 0.6) * T;
        const d2 = dx * dx + dy * dy;
        if (d2 < tr * tr) thorn += falloff(d2, tr) * L.thorn.strength;
      }
    }
    out[0] = Math.min(1, warm);
    out[1] = Math.min(1, flora);
    out[2] = Math.min(1, thorn);
    return out;
  }
}

/**
 * Pack three 0..1 values into the low 24 bits of a uint32 (read by the shader as unorm8x4 .xyz; .w is
 * always 0, so the bit pattern is always a finite float in the interleaved Float32Array).
 */
export function packSpill(r: number, g: number, b: number): number {
  const q = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return (q(r) | (q(g) << 8) | (q(b) << 16)) >>> 0;
}
