import { Container, type ParticleContainer, type Texture } from 'pixi.js';
import { PALETTE } from '../../config.ts';
import type { QualitySettings } from '../../contracts/quality.ts';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import { SimEventType, type SimEvent } from '../../contracts/sim.ts';
import { Rng } from '../../core/rng.ts';
import type { ParticleFrame } from '../gen/particleAtlas.ts';
import type { WorldAssets } from '../layers/assets.ts';
import { buildPool, fixedParticleContainer, hide, Mote, setColor, toBgr, type MoteRing } from './particlePool.ts';
import { shaftEnvelope, shaftPoint, shaftTrapezoid, trapezoidBounds, type Trapezoid } from './shaftGeometry.ts';

/** Capacities at particle density 1 (pools are allocated once at these sizes). */
export const PARTICLE_CAPACITY = {
  motes: 150,
  fireflies: 40,
  dust: 96,
  leaves: 22,
  sparks: 96,
  dots: 160,
  stars: 48,
  puffs: 72,
  wisps: 40,
} as const;

/** Ambient particles live in the camera window grown by this margin (u). */
const WINDOW_MARGIN = 240;

const AMB_MOTE = 1;
const AMB_FIREFLY = 2;
const AMB_DUST = 3;
const B_PUFF = 10;
const B_WISP = 11;
const B_SPARK = 12;
const B_DOT = 13;
const B_STAR = 14;
const B_GATHER = 15;

const TEAL = toBgr(PALETTE.floraGlow);
const SPIRIT = toBgr(PALETTE.spiritGlow);
const WARM = toBgr(PALETTE.warmAccent);
const WARM_WHITE = toBgr(0xffe2b8);
const MOTE_PALE = toBgr(0x9fe8e0);
const DUST = toBgr(0x6d8fa0);
const DARK = toBgr(0x0a1220);
const LEAF = toBgr(0x122232);

function smooth(e0: number, e1: number, x: number): number {
  const t = x <= e0 ? 0 : x >= e1 ? 1 : (x - e0) / (e1 - e0);
  return t * t * (3 - 2 * t);
}

interface Window {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * World particles (ARCHITECTURE.md §5.5), slot `particles`: ambient motes, fireflies and shaft dust
 * (additive, twinned into glow `particles`), falling leaves (normal blend) and event bursts (additive
 * sparks/dots/stars twinned; normal-blend puffs and wisps). Every pool is filled before the first
 * render and never grows; dead particles are hidden with scale 0. Nothing here allocates per frame.
 */
export class ParticlesView implements RenderView {
  readonly name = 'particles';
  private readonly assets: WorldAssets;
  private ctx: RenderContext | null = null;
  private root: Container | null = null;
  private glowRoot: Container | null = null;
  private readonly rng = new Rng(0x9a871c1e);
  private ambient: Mote[] = [];
  private leaves: Mote[] = [];
  private burstAdd: Mote[] = [];
  private burstNormal: Mote[] = [];
  private sparkRing: MoteRing | null = null;
  private dotRing: MoteRing | null = null;
  private starRing: MoteRing | null = null;
  private puffRing: MoteRing | null = null;
  private wispRing: MoteRing | null = null;
  private traps: Trapezoid[] = [];
  private trapBounds: Window[] = [];
  private lanterns: { x: number; y: number }[] = [];
  private readonly win: Window = { x0: 0, y0: 0, x1: 0, y1: 0 };
  private readonly pt = { x: 0, y: 0 };
  private lastSnap = Number.NaN;
  private seeded = false;
  private density = 1;
  private nMotes = 0;
  private nFireflies = 0;
  private nDust = 0;
  private nLeaves = 0;
  private trailClock = 0;
  private slideClock = 0;
  /** Live burst particles after the last update (tests and stats). */
  liveBursts = 0;

  constructor(assets: WorldAssets) {
    this.assets = assets;
  }

  async init(ctx: RenderContext): Promise<void> {
    this.ctx = ctx;
    this.root = new Container({ label: 'particles' });
    this.glowRoot = new Container({ label: 'particles-glow' });
    ctx.scene.particles.addChild(this.root);
    ctx.glow.particles.addChild(this.glowRoot);
    await this.assets.ready;
    const frames = this.assets.particleFrames;
    if (!frames) throw new Error('ParticlesView: particle atlas missing');
    this.build(ctx, frames);
  }

  /** Create pools and containers (separate from init so tests can drive it synchronously). */
  build(ctx: RenderContext, frames: Readonly<Record<ParticleFrame, Texture>>): void {
    this.ctx = ctx;
    this.root ??= ctx.scene.particles.addChild(new Container({ label: 'particles' }));
    this.glowRoot ??= ctx.glow.particles.addChild(new Container({ label: 'particles-glow' }));
    const C = PARTICLE_CAPACITY;
    const amb = buildPool([
      { texture: frames.dot, count: C.motes },
      { texture: frames.core, count: C.fireflies },
      { texture: frames.dot, count: C.dust },
    ]);
    this.ambient = amb.pool;
    const lv = buildPool([
      { texture: frames.leaf0, count: Math.ceil(C.leaves / 3) },
      { texture: frames.leaf1, count: Math.ceil(C.leaves / 3) },
      { texture: frames.leaf2, count: C.leaves - 2 * Math.ceil(C.leaves / 3) },
    ]);
    this.leaves = lv.pool;
    const ba = buildPool([
      { texture: frames.spark, count: C.sparks },
      { texture: frames.dot, count: C.dots },
      { texture: frames.star, count: C.stars },
    ]);
    this.burstAdd = ba.pool;
    [this.sparkRing, this.dotRing, this.starRing] = ba.rings as [MoteRing, MoteRing, MoteRing];
    const bn = buildPool([
      { texture: frames.puff, count: C.puffs },
      { texture: frames.wisp, count: C.wisps },
    ]);
    this.burstNormal = bn.pool;
    [this.puffRing, this.wispRing] = bn.rings as [MoteRing, MoteRing];

    this.traps = ctx.level.lightShafts.map(shaftTrapezoid);
    this.trapBounds = this.traps.map(trapezoidBounds);
    this.lanterns = ctx.level.decorHints.filter((h) => h.kind === 'lantern').map((h) => ({ x: h.x, y: h.y }));

    const tex = frames.dot;
    const mk = (particles: Mote[], additive: boolean, rotation: boolean, parent: Container, alpha = 1): ParticleContainer<Mote> => {
      const pc = fixedParticleContainer({
        texture: tex, particles, dynamicProperties: { position: true, vertex: true, color: true, rotation, uvs: false },
      });
      if (additive) pc.blendMode = 'add';
      pc.alpha = alpha;
      parent.addChild(pc);
      return pc;
    };
    mk(this.ambient, true, false, this.root);
    mk(this.leaves, false, true, this.root);
    mk(this.burstNormal, false, true, this.root);
    mk(this.burstAdd, true, true, this.root);
    mk(this.ambient, true, false, this.glowRoot, 0.75);
    mk(this.burstAdd, true, true, this.glowRoot, 0.85);
    this.onQualityChanged(ctx.quality);
  }

  onQualityChanged(q: QualitySettings): void {
    const C = PARTICLE_CAPACITY;
    this.density = Math.max(0, Math.min(1, q.particleDensity));
    this.nMotes = Math.round(C.motes * this.density);
    this.nFireflies = Math.round(C.fireflies * this.density);
    this.nDust = q.lightShafts ? Math.round(C.dust * this.density) : 0;
    this.nLeaves = Math.round(C.leaves * this.density);
    for (let i = 0; i < this.ambient.length; i++) hide(this.ambient[i] as Mote);
    for (let i = 0; i < this.leaves.length; i++) hide(this.leaves[i] as Mote);
    this.seeded = false;
  }

  // ---- ambient ------------------------------------------------------------------------------

  private spawnMote(m: Mote): void {
    const w = this.win;
    const r = this.rng;
    m.kind = AMB_MOTE;
    m.x = r.range(w.x0, w.x1);
    m.y = r.range(w.y0, w.y1);
    m.vx = r.range(4, 13);
    m.vy = r.range(-6, 4);
    m.size = r.range(0.09, 0.24);
    m.alpha = r.range(0.22, 0.62);
    m.phase = r.range(0, 6.283);
    const pick = r.next();
    m.bgr = pick < 0.5 ? TEAL : pick < 0.8 ? MOTE_PALE : SPIRIT;
  }

  private spawnFirefly(m: Mote): void {
    const w = this.win;
    const r = this.rng;
    m.kind = AMB_FIREFLY;
    m.phase = r.range(0, 6.283);
    m.spin = r.range(0.7, 1.6);
    m.size = r.range(0.2, 0.36);
    m.d = r.range(16, 30);
    m.bgr = TEAL;
    let near = -1;
    if (this.lanterns.length > 0 && r.chance(0.35)) {
      const start = r.int(0, this.lanterns.length - 1);
      for (let k = 0; k < this.lanterns.length; k++) {
        const l = this.lanterns[(start + k) % this.lanterns.length] as { x: number; y: number };
        if (l.x > w.x0 && l.x < w.x1 && l.y > w.y0 && l.y < w.y1) {
          near = (start + k) % this.lanterns.length;
          break;
        }
      }
    }
    if (near >= 0) {
      const l = this.lanterns[near] as { x: number; y: number };
      m.x = l.x + r.range(-220, 220);
      m.y = l.y - r.range(20, 200);
      m.bgr = r.chance(0.7) ? WARM : WARM_WHITE;
    } else {
      m.x = r.range(w.x0, w.x1);
      m.y = r.range(w.y0 + (w.y1 - w.y0) * 0.3, w.y1);
    }
  }

  private spawnDust(m: Mote, spread: boolean): void {
    const w = this.win;
    const r = this.rng;
    m.kind = AMB_DUST;
    m.a = -1;
    const n = this.traps.length;
    if (n > 0) {
      const start = r.int(0, n - 1);
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        const b = this.trapBounds[i] as Window;
        if (b.x1 > w.x0 && b.x0 < w.x1 && b.y1 > w.y0 && b.y0 < w.y1) {
          m.a = i;
          break;
        }
      }
    }
    if (m.a < 0) {
      hide(m);
      return;
    }
    const t = this.traps[m.a] as Trapezoid;
    m.b = r.range(0.08, 0.92);
    m.c = spread ? r.range(0.02, 0.95) : r.range(0.02, 0.2);
    m.d = r.range(8, 18) / Math.max(1, t.y1 - t.y0);
    m.size = r.range(0.06, 0.13);
    m.alpha = r.range(0.5, 1) * Math.min(1, t.intensity * 1.4);
    m.phase = r.range(0, 6.283);
    m.bgr = r.chance(0.6) ? SPIRIT : MOTE_PALE;
    m.life = 1;
  }

  private spawnLeaf(m: Mote, top: boolean): void {
    const w = this.win;
    const r = this.rng;
    m.x = r.range(w.x0, w.x1);
    m.y = top ? w.y0 - r.range(0, 80) : r.range(w.y0, w.y1);
    m.vy = r.range(26, 52);
    m.size = r.range(0.9, 1.35);
    m.spin = r.range(-1.3, 1.3);
    m.a = r.range(1.1, 2.6);
    m.phase = r.range(0, 6.283);
    m.rotation = r.range(0, 6.283);
    m.bgr = LEAF;
    m.alpha = r.range(0.75, 0.95);
    m.life = 1;
  }

  private seedAmbient(): void {
    const C = PARTICLE_CAPACITY;
    for (let i = 0; i < this.ambient.length; i++) {
      const m = this.ambient[i] as Mote;
      hide(m);
      if (i < C.motes) {
        if (i < this.nMotes) this.spawnMote(m);
      } else if (i < C.motes + C.fireflies) {
        if (i - C.motes < this.nFireflies) this.spawnFirefly(m);
      } else if (i - C.motes - C.fireflies < this.nDust) {
        this.spawnDust(m, true);
      }
    }
    for (let i = 0; i < this.leaves.length; i++) {
      const m = this.leaves[i] as Mote;
      hide(m);
      if (i < this.nLeaves) this.spawnLeaf(m, false);
    }
    this.seeded = true;
  }

  /** Wrap a position into the window, keeping density uniform as the camera moves. */
  private wrap(m: Mote): void {
    const w = this.win;
    const ww = w.x1 - w.x0;
    const wh = w.y1 - w.y0;
    if (m.x < w.x0) m.x += ww * Math.ceil((w.x0 - m.x) / ww);
    else if (m.x > w.x1) m.x -= ww * Math.ceil((m.x - w.x1) / ww);
    if (m.y < w.y0) m.y += wh * Math.ceil((w.y0 - m.y) / wh);
    else if (m.y > w.y1) m.y -= wh * Math.ceil((m.y - w.y1) / wh);
  }

  private updateAmbient(dt: number, t: number): number {
    const C = PARTICLE_CAPACITY;
    let live = 0;
    for (let i = 0; i < this.nMotes; i++) {
      const m = this.ambient[i] as Mote;
      m.x += (m.vx + Math.sin(t * 0.6 + m.phase) * 6) * dt;
      m.y += (m.vy + Math.cos(t * 0.8 + m.phase * 1.3) * 5) * dt;
      this.wrap(m);
      m.scaleX = m.scaleY = m.size;
      setColor(m, m.alpha * (0.55 + 0.45 * Math.sin(t * 1.7 + m.phase * 3)));
      live++;
    }
    for (let k = 0; k < this.nFireflies; k++) {
      const m = this.ambient[C.motes + k] as Mote;
      const heading = m.phase + Math.sin(t * 0.5 + m.phase * 2) * 1.8 + Math.sin(t * 1.3 + m.phase) * 0.6;
      m.x += Math.cos(heading) * m.d * dt;
      m.y += Math.sin(heading) * m.d * 0.6 * dt;
      this.wrap(m);
      const blink = Math.pow(Math.max(0, Math.sin(t * m.spin + m.phase)), 4);
      m.scaleX = m.scaleY = m.size * (0.75 + 0.35 * blink);
      setColor(m, 0.1 + 0.9 * blink);
      live++;
    }
    const d0 = C.motes + C.fireflies;
    const w = this.win;
    for (let k = 0; k < this.nDust; k++) {
      const m = this.ambient[d0 + k] as Mote;
      if (m.a < 0) {
        // Retry occasionally: a shaft may scroll into the window.
        if (this.rng.chance(0.02)) this.spawnDust(m, true);
        continue;
      }
      const tr = this.traps[m.a] as Trapezoid;
      const b = this.trapBounds[m.a] as Window;
      m.c += m.d * dt;
      m.b += Math.sin(t * 0.37 + m.phase) * 0.012 * dt;
      if (m.c > 1 || m.b < 0 || m.b > 1 || b.x1 < w.x0 || b.x0 > w.x1 || b.y1 < w.y0 || b.y0 > w.y1) {
        this.spawnDust(m, false);
        if (m.a < 0) continue;
      }
      shaftPoint(this.traps[m.a] as Trapezoid, m.b, m.c, this.pt);
      m.x = this.pt.x + Math.sin(t * 0.9 + m.phase) * 4;
      m.y = this.pt.y;
      m.scaleX = m.scaleY = m.size;
      setColor(m, m.alpha * shaftEnvelope(m.b, m.c) * (0.5 + 0.5 * Math.sin(t * 2.3 + m.phase * 5)) * (tr.intensity > 0 ? 1 : 0));
      live++;
    }
    for (let i = 0; i < this.nLeaves; i++) {
      const m = this.leaves[i] as Mote;
      m.y += m.vy * dt;
      m.x += (Math.sin(t * 1.1 + m.phase) * 28 + 9) * dt;
      m.rotation += m.spin * dt;
      if (m.y > w.y1) this.spawnLeaf(m, true);
      else if (m.x < w.x0 || m.x > w.x1) this.wrap(m);
      m.scaleX = m.size * Math.cos(t * m.a + m.phase);
      m.scaleY = m.size;
      setColor(m, m.alpha);
      live++;
    }
    return live;
  }

  // ---- bursts -------------------------------------------------------------------------------

  private emit(
    ring: MoteRing | null, pool: Mote[], kind: number, x: number, y: number, vx: number, vy: number,
    ttl: number, size: number, bgr: number, alpha: number, drag: number, gravity: number,
  ): Mote | null {
    if (!ring) return null;
    const m = ring.next(pool);
    m.kind = kind;
    m.x = x;
    m.y = y;
    m.vx = vx;
    m.vy = vy;
    m.ttl = ttl;
    m.life = ttl;
    m.size = size;
    m.bgr = bgr;
    m.alpha = alpha;
    m.drag = drag;
    m.gravity = gravity;
    m.spin = this.rng.range(-3, 3);
    m.rotation = this.rng.range(0, 6.283);
    m.phase = this.rng.range(0, 6.283);
    return m;
  }

  private puff(x: number, y: number, n: number, spread: number, lift: number, size: number, alpha: number): void {
    const r = this.rng;
    for (let i = 0; i < n; i++) {
      const s = r.sign();
      this.emit(this.puffRing, this.burstNormal, B_PUFF, x + r.range(-8, 8), y - r.range(0, 6),
        s * r.range(0.25, 1) * spread, -r.range(0.2, 1) * lift, r.range(0.45, 0.8), size * r.range(0.7, 1.2), DUST, alpha, 3.2, -8);
    }
  }

  private sparks(x: number, y: number, n: number, speed: number, bgr: number, ring = false): void {
    const r = this.rng;
    for (let i = 0; i < n; i++) {
      const a = ring ? (i / n) * 6.283 + r.range(-0.1, 0.1) : r.range(0, 6.283);
      const v = speed * r.range(0.6, 1.1);
      this.emit(this.sparkRing, this.burstAdd, B_SPARK, x, y, Math.cos(a) * v, Math.sin(a) * v * (ring ? 0.45 : 1),
        r.range(0.3, 0.55), r.range(0.28, 0.42), bgr, 0.9, 2.6, 90);
    }
  }

  private dots(x: number, y: number, n: number, speed: number, bgr: number, rise: number, ttl: number, size: number): void {
    const r = this.rng;
    for (let i = 0; i < n; i++) {
      const a = r.range(0, 6.283);
      const v = speed * r.range(0.3, 1);
      this.emit(this.dotRing, this.burstAdd, B_DOT, x + r.range(-6, 6), y + r.range(-6, 6), Math.cos(a) * v, Math.sin(a) * v - rise,
        ttl * r.range(0.7, 1.3), size * r.range(0.7, 1.3), bgr, r.range(0.6, 1), 1.6, -rise * 0.3);
    }
  }

  /** Clear per-run render state (bursts and trails). */
  private resetBursts(): void {
    this.sparkRing?.clear(this.burstAdd);
    this.dotRing?.clear(this.burstAdd);
    this.starRing?.clear(this.burstAdd);
    this.puffRing?.clear(this.burstNormal);
    this.wispRing?.clear(this.burstNormal);
    this.trailClock = 0;
    this.slideClock = 0;
  }

  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    const r = this.rng;
    const p = frame.sim.player;
    switch (e.type) {
      case SimEventType.Land: {
        const k = Math.min(1, Math.max(0, (e.a - 150) / 900));
        if (k <= 0.02) break;
        this.puff(e.x, e.y, 2 + Math.round(k * 8), 60 + k * 120, 20 + k * 30, 0.45 + k * 0.4, 0.14 + k * 0.2);
        break;
      }
      case SimEventType.Jump:
        this.puff(e.x, e.y, 3, 50, 25, 0.4, 0.14);
        this.dots(e.x, e.y - 6, 3, 50, SPIRIT, 30, 0.5, 0.18);
        break;
      case SimEventType.AirJump:
        this.sparks(e.x, e.y - 4, 12, 220, SPIRIT, true);
        this.dots(e.x, e.y - 8, 5, 60, TEAL, 10, 0.5, 0.2);
        break;
      case SimEventType.WallJump: {
        const dir = e.a >= 0 ? 1 : -1;
        for (let i = 0; i < 5; i++) {
          this.emit(this.puffRing, this.burstNormal, B_PUFF, e.x, e.y - r.range(10, 50), dir * r.range(30, 110), r.range(-40, 10),
            r.range(0.4, 0.7), r.range(0.35, 0.6), DUST, 0.16, 3, -10);
        }
        this.sparks(e.x, e.y - 30, 4, 150, SPIRIT);
        break;
      }
      case SimEventType.Dash: {
        const dir = e.a >= 0 ? 1 : -1;
        for (let i = 0; i < 8; i++) {
          this.emit(this.dotRing, this.burstAdd, B_DOT, e.x, e.y - p.height * 0.5 + r.range(-12, 12), -dir * r.range(60, 180), r.range(-25, 25),
            r.range(0.3, 0.5), r.range(0.16, 0.26), SPIRIT, 0.9, 3, 0);
        }
        if (e.b === 0) this.puff(e.x, e.y, 3, 70, 15, 0.4, 0.12);
        break;
      }
      case SimEventType.DashEnd:
        if (e.b === 2) this.puff(e.x + (e.a >= 0 ? 1 : -1) * 14, e.y - 24, 4, 60, 30, 0.45, 0.16);
        break;
      case SimEventType.OrbCollected:
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * 6.283;
          const v = r.range(90, 190);
          this.emit(this.starRing, this.burstAdd, B_STAR, e.x, e.y, Math.cos(a) * v, Math.sin(a) * v, r.range(0.5, 0.85),
            r.range(0.28, 0.45), i % 3 === 0 ? WARM_WHITE : WARM, 1, 3.2, 0);
        }
        this.dots(e.x, e.y, 10, 120, WARM, 20, 0.8, 0.2);
        break;
      case SimEventType.Died:
        this.dots(e.x, e.y, 30, 240, SPIRIT, 60, 1.1, 0.26);
        this.sparks(e.x, e.y, 10, 280, SPIRIT);
        break;
      case SimEventType.Respawned:
      case SimEventType.Reset:
      case SimEventType.Teleported:
        this.resetBursts();
        if (e.type === SimEventType.Respawned) this.gather(e.x, e.y - 30);
        break;
      case SimEventType.EnemyStomped:
        for (let i = 0; i < 10; i++) {
          this.emit(this.wispRing, this.burstNormal, B_WISP, e.x + r.range(-20, 20), e.y + r.range(-6, 10), r.range(-50, 50),
            -r.range(30, 90), r.range(0.6, 1.1), r.range(0.4, 0.7), DARK, 0.7, 2.2, -30);
        }
        this.sparks(e.x, e.y, 4, 160, toBgr(PALETTE.thorns));
        break;
      case SimEventType.CheckpointActivated:
        for (let i = 0; i < 18; i++) {
          this.emit(this.dotRing, this.burstAdd, B_DOT, e.x + r.range(-34, 34), e.y - r.range(0, 30), r.range(-12, 12), -r.range(60, 140),
            r.range(1.2, 2), r.range(0.16, 0.28), TEAL, 1, 0.6, -10);
        }
        break;
      case SimEventType.GoalReached:
        this.dots(e.x, e.y - 40, 30, 90, SPIRIT, 90, 2, 0.24);
        this.dots(e.x, e.y - 40, 16, 70, WARM, 70, 2, 0.22);
        break;
      case SimEventType.DropThrough:
        this.puff(e.x, e.y + 4, 3, 40, 10, 0.35, 0.12);
        break;
      default:
        break;
    }
  }

  private gather(x: number, y: number): void {
    const r = this.rng;
    for (let i = 0; i < 22; i++) {
      const a = (i / 22) * 6.283 + r.range(-0.12, 0.12);
      const rad = r.range(110, 180);
      const m = this.emit(this.dotRing, this.burstAdd, B_GATHER, x + Math.cos(a) * rad, y + Math.sin(a) * rad * 0.8, 0, 0,
        r.range(0.55, 0.8), r.range(0.18, 0.3), i % 4 === 0 ? TEAL : SPIRIT, 1, 0, 0);
      if (!m) continue;
      m.a = x;
      m.b = y;
      m.c = m.x;
      m.d = m.y;
    }
  }

  private updateBursts(pool: Mote[], dt: number): number {
    let live = 0;
    for (let i = 0; i < pool.length; i++) {
      const m = pool[i] as Mote;
      if (m.life <= 0) continue;
      m.life -= dt;
      if (m.life <= 0) {
        hide(m);
        continue;
      }
      live++;
      const t = 1 - m.life / m.ttl;
      if (m.kind === B_GATHER) {
        const e = t * t * (3 - 2 * t);
        m.x = m.c + (m.a - m.c) * e;
        m.y = m.d + (m.b - m.d) * e;
        m.scaleX = m.scaleY = m.size * (0.6 + 0.6 * t);
        setColor(m, m.alpha * Math.sqrt(t) * (1 - smooth(0.85, 1, t)));
        continue;
      }
      const damp = Math.exp(-m.drag * dt);
      m.vx *= damp;
      m.vy = m.vy * damp + m.gravity * dt;
      m.x += m.vx * dt;
      m.y += m.vy * dt;
      const fadeIn = smooth(0, 0.08, t);
      switch (m.kind) {
        case B_PUFF:
          m.scaleX = m.scaleY = m.size * (0.6 + 0.7 * t);
          m.rotation += m.spin * 0.2 * dt;
          setColor(m, m.alpha * fadeIn * Math.pow(1 - t, 1.5));
          break;
        case B_WISP:
          m.scaleX = m.scaleY = m.size * (0.7 + 0.8 * t);
          m.rotation += m.spin * 0.3 * dt;
          setColor(m, m.alpha * fadeIn * (1 - t));
          break;
        case B_SPARK: {
          const speed = Math.sqrt(m.vx * m.vx + m.vy * m.vy);
          m.rotation = Math.atan2(m.vy, m.vx);
          m.scaleX = m.size * (0.6 + Math.min(1.4, speed / 220));
          m.scaleY = m.size * 0.7;
          setColor(m, m.alpha * Math.pow(1 - t, 1.2));
          break;
        }
        case B_STAR:
          m.rotation += m.spin * dt;
          m.scaleX = m.scaleY = m.size * (0.5 + 0.5 * Math.sin(Math.PI * Math.min(1, t * 1.4)) + 0.2);
          setColor(m, m.alpha * (1 - t));
          break;
        default:
          m.scaleX = m.scaleY = m.size * (1 - 0.5 * t);
          setColor(m, m.alpha * fadeIn * (1 - t));
          break;
      }
    }
    return live;
  }

  /** Continuous emitters driven by the player's state (dash trail, wall-slide dust). */
  private emitContinuous(frame: FrameInfo): void {
    const p = frame.sim.player;
    if (!p.alive || !p.visible) {
      this.trailClock = 0;
      this.slideClock = 0;
      return;
    }
    const a = frame.alpha;
    const x = p.prevX + (p.x - p.prevX) * a;
    const y = p.prevY + (p.y - p.prevY) * a;
    const r = this.rng;
    if (p.mode === 'dash') {
      this.trailClock += frame.dt * 90;
      const dir = p.dashDir === 0 ? p.facing : p.dashDir;
      while (this.trailClock >= 1) {
        this.trailClock -= 1;
        this.emit(this.dotRing, this.burstAdd, B_DOT, x - dir * r.range(0, 18), y - p.height * r.range(0.25, 0.75), -dir * r.range(20, 70),
          r.range(-12, 12), r.range(0.25, 0.45), r.range(0.14, 0.24), r.chance(0.3) ? TEAL : SPIRIT, 0.85, 2.5, -10);
      }
    } else {
      this.trailClock = 0;
    }
    if (p.mode === 'wallSlide' && p.wallDir !== 0) {
      this.slideClock += frame.dt * 9;
      while (this.slideClock >= 1) {
        this.slideClock -= 1;
        this.emit(this.puffRing, this.burstNormal, B_PUFF, x + p.wallDir * p.width * 0.5, y - r.range(4, 24), -p.wallDir * r.range(10, 40),
          r.range(-30, -5), r.range(0.35, 0.55), r.range(0.22, 0.34), DUST, 0.12, 2.5, 20);
      }
    } else {
      this.slideClock = 0;
    }
  }

  update(frame: FrameInfo): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const cam = frame.camera;
    const w = this.win;
    w.x0 = cam.left - WINDOW_MARGIN;
    w.x1 = cam.left + cam.width + WINDOW_MARGIN;
    w.y0 = cam.top - WINDOW_MARGIN;
    w.y1 = cam.top + cam.height + WINDOW_MARGIN;
    const snap = frame.sim.camera.snapTick;
    if (!this.seeded || snap !== this.lastSnap) {
      this.lastSnap = snap;
      this.seedAmbient();
    }
    const dt = frame.dt;
    const t = frame.time % 3600;
    this.emitContinuous(frame);
    let live = this.updateAmbient(dt, t);
    this.liveBursts = this.updateBursts(this.burstAdd, dt) + this.updateBursts(this.burstNormal, dt);
    live += this.liveBursts;
    ctx.stats.particles += live;
    // Particles are small; charge a flat per-particle fill estimate (≈ 24 × 24 u each).
    ctx.stats.fillScreens += (live * 576) / Math.max(1, cam.width * cam.height);
  }

  destroy(): void {
    this.root?.destroy({ children: true });
    this.glowRoot?.destroy({ children: true });
    this.root = null;
    this.glowRoot = null;
    this.ctx = null;
  }
}
