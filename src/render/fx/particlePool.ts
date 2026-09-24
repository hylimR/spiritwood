import { ParticleContainer, type IParticle, type ParticleContainerOptions, type Texture } from 'pixi.js';

/**
 * A particle that is both the Pixi render record (IParticle) and its own simulation state, so a pool
 * is a flat array of these objects created once. `color` is Pixi's packed ABGR (alpha in the top byte).
 */
export class Mote implements IParticle {
  x = 0;
  y = 0;
  scaleX = 0;
  scaleY = 0;
  anchorX = 0.5;
  anchorY = 0.5;
  rotation = 0;
  color = 0;
  texture: Texture;
  vx = 0;
  vy = 0;
  /** Seconds left (bursts) or animation phase (ambient). */
  life = 0;
  ttl = 1;
  size = 1;
  alpha = 1;
  phase = 0;
  spin = 0;
  drag = 0;
  gravity = 0;
  /** Tint as 0xBBGGRR. */
  bgr = 0xffffff;
  /** Behaviour selector (burst envelope / ambient kind). */
  kind = 0;
  /** Auxiliary state (shaft index, shaft u/v, target…). */
  a = 0;
  b = 0;
  c = 0;
  d = 0;

  constructor(texture: Texture) {
    this.texture = texture;
  }
}

/** 0xRRGGBB → 0xBBGGRR (Pixi particle colour order). */
export function toBgr(rgb: number): number {
  return ((rgb & 0xff) << 16) | (rgb & 0xff00) | ((rgb >> 16) & 0xff);
}

/** Write a Mote's packed colour from its tint and an alpha 0..1. */
export function setColor(m: Mote, alpha: number): void {
  const a = alpha <= 0 ? 0 : alpha >= 1 ? 255 : (alpha * 255) | 0;
  m.color = (m.bgr | (a << 24)) >>> 0;
}

export function hide(m: Mote): void {
  m.scaleX = 0;
  m.scaleY = 0;
  m.color = 0;
  m.life = 0;
}

/**
 * A ring of motes sharing one texture frame, recycled oldest-first. `emit` never allocates; when
 * every slot is live the oldest particle is reused, which caps each burst type's footprint.
 */
export class MoteRing {
  readonly start: number;
  readonly count: number;
  private cursor = 0;

  constructor(start: number, count: number) {
    this.start = start;
    this.count = count;
  }

  next(pool: readonly Mote[]): Mote {
    const m = pool[this.start + this.cursor] as Mote;
    this.cursor = (this.cursor + 1) % this.count;
    return m;
  }

  clear(pool: readonly Mote[]): void {
    for (let i = 0; i < this.count; i++) hide(pool[this.start + i] as Mote);
    this.cursor = 0;
  }

  live(pool: readonly Mote[]): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) if ((pool[this.start + i] as Mote).life > 0) n++;
    return n;
  }
}

/** Build a pool whose index ranges use the given frames (ranges are contiguous, in order). */
export function buildPool(ranges: readonly { texture: Texture; count: number }[]): { pool: Mote[]; rings: MoteRing[] } {
  const pool: Mote[] = [];
  const rings: MoteRing[] = [];
  for (const r of ranges) {
    rings.push(new MoteRing(pool.length, r.count));
    for (let i = 0; i < r.count; i++) {
      const m = new Mote(r.texture);
      hide(m);
      pool.push(m);
    }
  }
  return { pool, rings };
}

/**
 * A ParticleContainer over a fixed particle array. Pixi 8.21 uploads the static (non-dynamic)
 * attributes — uvs at least — only while the container is flagged dirty, and a container constructed
 * with `particles` is not: its first GPU buffer is sized for the array but its static vertex buffer is
 * never filled, so the draw reads out of range and nothing shows. `update()` raises the flag once;
 * after that only the dynamic properties stream per frame.
 */
export function fixedParticleContainer<T extends IParticle>(options: ParticleContainerOptions<T> & { particles: T[] }): ParticleContainer<T> {
  const pc = new ParticleContainer<T>(options);
  pc.update();
  return pc;
}
