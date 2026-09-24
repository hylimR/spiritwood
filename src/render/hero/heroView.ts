import { Container, Matrix, Mesh, MeshGeometry, Rectangle, Sprite, Texture } from 'pixi.js';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import { SimEventType, type PlayerView, type SimEvent } from '../../contracts/sim.ts';
import { PALETTE, SIM_DT } from '../../config.ts';
import { clamp, damp, smoothstep, TAU } from '../../core/math.ts';
import { Rng } from '../../core/rng.ts';
import { DEFAULT_TUNING, DEFAULT_WORLD_TUNING } from '../../sim/tuning.ts';
import { Noise } from '../gen/noise.ts';
import { estimateTextureBytes, textureFromRgba } from '../util/texture.ts';
import type { Atlas, AtlasFrame } from './atlas.ts';
import { buildHeroAssets, GHOST_DENSITY } from './heroAssets.ts';
import { partMatrix } from './heroBake.ts';
import { createHeroClips, HERO_CLIP, RUN_STRIDE } from './heroClips.ts';
import { InertialSpring, landSquash, Ribbon, RIBBON, SQUASH, SquashStretch } from './heroMotion.ts';
import { HALO_RADIUS, partImageName } from './heroParts.ts';
import { createHeroSkeleton, HERO_COLORS, HERO_PARTS, SCARF_ANCHOR, type PartAttachment } from './heroRig.ts';
import { chooseHeroClip, fadeInto, HERO_ANIM, type HeroAnimInput } from './heroState.ts';
import { Animator, CH, CHANNELS, type Skeleton } from './rig.ts';

const TEXTURE_KEY = 'pipe:hero-atlas';
const HALO_ALPHA = 0.11;
const HALO_Y = -30;
/** Bloom-twin brightness per unit of an attachment's `glow`. */
const GLOW_GAIN = 0.85;
const BUD_GLOW_RADIUS = 13;
const GHOSTS = 4;
const GHOST_INTERVAL = 0.034;
const GHOST_LIFE = 0.24;
const GHOST_ALPHA = 0.38;
/** Facing flips at this many scale units per second (a 0.11 s turn). */
const TURN_RATE = 18;
const FADE_IN_TIME = 0.35;
/** Stretch kick as the hero re-forms at a checkpoint. */
const RESPAWN_POP = 0.16;
const SCARF_WIDTH = 7;
const SCARF_TAPER = 0.85;
/** Rendered ribbon points: the verlet points, Catmull-Rom subdivided 3× for a smooth curve. */
const SCARF_POINTS = (RIBBON.points - 1) * 3 + 1;
const BLINK_TIME = 0.13;
const MAX_RUN = DEFAULT_TUNING.maxRunSpeed;

interface PartSlot {
  att: PartAttachment;
  sprite: Sprite;
  twin: Sprite | null;
  texR: Texture;
  texL: Texture;
  density: number;
  eye: boolean;
}

function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  return 0.5 * (2 * p1 + (p2 - p0) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (3 * p1 - p0 - 3 * p2 + p3) * t2 * t);
}

function grey(v: number): number {
  const c = Math.round(clamp(v, 0, 1) * 255);
  return (c << 16) | (c << 8) | c;
}

/**
 * The spirit child: rig-driven part sprites (one atlas, one batch), a verlet scarf of light, an additive
 * spirit-light halo that lifts the nearby world, dash afterimages, and a bloom twin in glow slot `hero`.
 * Driven only by `frame.sim.player` and sim events.
 */
export class HeroView implements RenderView {
  readonly name = 'hero';

  private ctx: RenderContext | null = null;
  private atlasTexture: Texture | null = null;
  private readonly textures: Texture[] = [];
  private readonly root = new Container({ label: 'hero' });
  private readonly glowRoot = new Container({ label: 'hero-glow' });
  private readonly ghostLayer = new Container({ label: 'hero-ghosts' });
  private readonly body = new Container({ label: 'hero-body' });
  private readonly glowBody = new Container({ label: 'hero-glow-body' });
  private readonly glowAdd = new Container({ label: 'hero-glow-add' });
  private readonly slots: PartSlot[] = [];
  private readonly ghosts: Sprite[] = [];
  private readonly ghostAge = new Float32Array(GHOSTS).fill(Infinity);
  private halo: Sprite | null = null;
  private budGlow: Sprite | null = null;
  private scarfGeometry: MeshGeometry | null = null;

  private readonly skeleton: Skeleton = createHeroSkeleton();
  private readonly animator: Animator = new Animator(this.skeleton, createHeroClips(this.skeleton));
  private readonly squash = new SquashStretch();
  private readonly sprout = new InertialSpring(170, 7.5, 0.75);
  private readonly ribbon = new Ribbon();
  private readonly noise = new Noise(0x5b1d);
  private readonly rng = new Rng(0x0b11);
  private readonly anim: HeroAnimInput = {
    mode: 'ground', alive: true, grounded: true, vx: 0, vy: 0, inputX: 0,
    sinceLand: 99, sinceWallJump: 99, sinceRespawn: 99, flipping: false,
  };
  private readonly curveX = new Float32Array(SCARF_POINTS);
  private readonly curveY = new Float32Array(SCARF_POINTS);
  private readonly rootMatrix = new Float32Array(6);
  private readonly scratch = new Float64Array(6);
  private readonly matrix = new Matrix();
  private readonly boneCore: number;
  private readonly boneRoot: number;
  private readonly boneHead: number;
  private readonly boneSproutA: number;
  private readonly boneSproutB: number;
  private readonly boneScarf: number;

  private lastWarp = Number.NaN;
  private shown = true;
  private facingScale = 1;
  private mirrored = false;
  private lean = 0;
  private headTilt = 0;
  private flipT = 0;
  private flipResidual = 0;
  private lastX = 0;
  private velX = 0;
  private accX = 0;
  private blinkIn = 2;
  private blinkT = BLINK_TIME;
  private dashing = false;
  private ghostTimer = 0;
  private ghostNext = 0;

  constructor() {
    this.boneCore = this.skeleton.indexOf('core');
    this.boneRoot = this.skeleton.indexOf('root');
    this.boneHead = this.skeleton.indexOf('head');
    this.boneSproutA = this.skeleton.indexOf('sproutA');
    this.boneSproutB = this.skeleton.indexOf('sproutB');
    this.boneScarf = this.skeleton.indexOf(SCARF_ANCHOR.bone);
  }

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.scene.hero.addChild(this.root);
    ctx.glow.hero.addChild(this.glowRoot);
    const atlas = buildHeroAssets();
    this.build(atlas);
    ctx.textures.set(TEXTURE_KEY, estimateTextureBytes(atlas.width, atlas.height, 4, true));
  }

  private build(atlas: Atlas): void {
    const base = textureFromRgba(atlas.pixels, atlas.width, atlas.height, { autoGenerateMipmaps: true, label: 'hero-atlas' });
    this.atlasTexture = base;
    const frame = (name: string): { f: AtlasFrame; tex: Texture } => {
      const f = atlas.frames[name];
      if (!f) throw new Error(`Hero atlas has no frame ${name}`);
      const tex = new Texture({ source: base.source, frame: new Rectangle(f.x, f.y, f.w, f.h), label: `hero:${name}` });
      this.textures.push(tex);
      return { f, tex };
    };

    this.ghostLayer.blendMode = 'add';
    const ghost = frame('ghost');
    for (let i = 0; i < GHOSTS; i++) {
      const s = new Sprite({ texture: ghost.tex, anchor: { x: ghost.f.pivotX / ghost.f.w, y: ghost.f.pivotY / ghost.f.h } });
      s.tint = PALETTE.spiritGlow;
      s.alpha = 0;
      this.ghosts.push(s);
      this.ghostLayer.addChild(s);
    }

    const halo = frame('halo');
    this.halo = new Sprite({ texture: halo.tex, anchor: 0.5 });
    this.halo.blendMode = 'add';
    this.halo.tint = HERO_COLORS.halo;
    this.halo.scale.set((2 * HALO_RADIUS) / halo.f.w);
    this.halo.position.set(0, HALO_Y);

    const scarf = frame('scarf');
    const n = SCARF_POINTS;
    const uvs = new Float32Array(n * 4);
    const indices = new Uint32Array((n - 1) * 6);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      uvs.set([u, 0, u, 1], i * 4);
      if (i < n - 1) indices.set([2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2], i * 6);
    }
    this.scarfGeometry = new MeshGeometry({ positions: new Float32Array(n * 4), uvs, indices });
    this.scarfGeometry.batchMode = 'batch';
    const scarfMesh = new Mesh({ geometry: this.scarfGeometry, texture: scarf.tex });
    const scarfTwin = new Mesh({ geometry: this.scarfGeometry, texture: scarf.tex });
    scarfTwin.tint = grey(0.7);

    this.body.addChild(this.halo, scarfMesh);
    const twins = new Container({ label: 'hero-glow-parts' });
    // Glow slots are additive (emissive twins sum; they never occlude other glow).
    twins.blendMode = 'add';
    for (const att of HERO_PARTS) {
      const r = frame(partImageName(att.image, att.lit, false));
      const l = att.lit ? frame(partImageName(att.image, att.lit, true)) : r;
      const anchor = { x: r.f.pivotX / r.f.w, y: r.f.pivotY / r.f.h };
      const sprite = new Sprite({ texture: r.tex, anchor });
      sprite.tint = att.tint;
      this.body.addChild(sprite);
      let twin: Sprite | null = null;
      if (att.glow > 0) {
        twin = new Sprite({ texture: r.tex, anchor });
        twin.tint = grey(att.glow * GLOW_GAIN);
        twins.addChild(twin);
      }
      this.slots.push({ att, sprite, twin, texR: r.tex, texL: l.tex, density: r.f.density, eye: att.image === 'eye' });
    }

    this.budGlow = new Sprite({ texture: halo.tex, anchor: 0.5 });
    this.budGlow.tint = PALETTE.floraGlow;
    this.budGlow.scale.set((2 * BUD_GLOW_RADIUS) / halo.f.w);
    this.glowAdd.blendMode = 'add';
    this.glowAdd.addChild(scarfTwin, this.budGlow);
    this.glowBody.addChild(twins, this.glowAdd);

    this.root.addChild(this.ghostLayer, this.body);
    this.glowRoot.addChild(this.glowBody);
    this.animator.snap(HERO_CLIP.idle);
  }

  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    const p = frame.sim.player;
    switch (e.type) {
      case SimEventType.Jump:
        this.squash.kick(SQUASH.jump);
        this.animator.play(HERO_CLIP.jump, fadeInto(HERO_CLIP.jump), true);
        break;
      case SimEventType.AirJump:
        this.squash.kick(SQUASH.airJump);
        this.flipT = 0;
        this.anim.flipping = true;
        this.animator.play(HERO_CLIP.doubleJump, fadeInto(HERO_CLIP.doubleJump), true);
        break;
      case SimEventType.WallJump:
        this.squash.kick(SQUASH.wallJump);
        this.anim.sinceWallJump = 0;
        this.animator.play(HERO_CLIP.wallJump, fadeInto(HERO_CLIP.wallJump), true);
        break;
      case SimEventType.Dash:
        this.dashing = true;
        this.ghostTimer = 0;
        this.ghostNext = 0;
        break;
      case SimEventType.DashEnd:
        this.dashing = false;
        break;
      case SimEventType.Land:
        this.squash.kick(landSquash(e.a));
        this.anim.sinceLand = 0;
        this.endFlip();
        if (Math.abs(p.vx) < HERO_ANIM.landMaxSpeed) this.animator.play(HERO_CLIP.land, fadeInto(HERO_CLIP.land), true);
        break;
      case SimEventType.EnemyStomped:
        this.squash.kick(SQUASH.stompBounce);
        this.animator.play(HERO_CLIP.jump, fadeInto(HERO_CLIP.jump), true);
        break;
      case SimEventType.Died:
        this.dashing = false;
        this.endFlip();
        this.animator.play(HERO_CLIP.dead, fadeInto(HERO_CLIP.dead), true);
        break;
      case SimEventType.Respawned:
        this.anim.sinceRespawn = 0;
        this.animator.snap(HERO_CLIP.respawn);
        this.lastWarp = Number.NaN;
        break;
      case SimEventType.Reset:
      case SimEventType.Teleported:
        this.lastWarp = Number.NaN;
        break;
      default:
        break;
    }
  }

  update(frame: FrameInfo): void {
    if (!this.atlasTexture) return;
    const p = frame.sim.player;
    const dt = frame.dt;
    const x = p.prevX + (p.x - p.prevX) * frame.alpha;
    const y = p.prevY + (p.y - p.prevY) * frame.alpha;
    if (p.warpTick !== this.lastWarp) {
      this.lastWarp = p.warpTick;
      this.resetMotion(p, x, y);
    }
    if (p.visible !== this.shown) {
      this.shown = p.visible;
      this.body.visible = p.visible;
      this.glowBody.visible = p.visible;
    }
    this.updateGhosts(dt, x, y, p.facing);
    if (!p.visible) return;

    this.trackMotion(dt, x, p);
    this.animate(dt, frame, p);
    this.pose(dt, p, frame.time);

    let alpha = smoothstep(0, FADE_IN_TIME, this.anim.sinceRespawn);
    let pop = 1;
    if (!p.alive && p.deadTicks >= 0) {
      const t = clamp((p.deadTicks + frame.alpha) / DEFAULT_WORLD_TUNING.deathHideTicks, 0, 1);
      alpha = Math.min(alpha, 1 - smoothstep(0, 1, t));
      pop = 1 + 0.14 * t;
    }
    const sx = this.squash.scaleX * pop;
    const sy = this.squash.scaleY * pop;
    const m = this.rootMatrix;
    m[0] = this.facingScale * sx;
    m[1] = 0;
    m[2] = 0;
    m[3] = sy;
    m[4] = 0;
    m[5] = 0;
    this.skeleton.evaluate(m);

    this.body.position.set(x, y);
    this.glowBody.position.set(x, y);
    this.body.alpha = alpha;
    this.glowBody.alpha = alpha;
    this.placeParts();
    this.updateScarf(dt, x, y, p.facing, frame.time);
    this.updateHalo(frame.time, sy);

    const stats = this.ctx?.stats;
    if (stats) {
      const cam = frame.camera;
      stats.fillScreens += ((2 * HALO_RADIUS) ** 2 + 70 * 80) / (cam.width * cam.height);
    }
  }

  private resetMotion(p: PlayerView, x: number, y: number): void {
    this.squash.reset();
    if (this.anim.sinceRespawn === 0) this.squash.kick(RESPAWN_POP);
    this.sprout.reset();
    this.facingScale = p.facing;
    this.lean = 0;
    this.headTilt = 0;
    this.lastX = x;
    this.velX = 0;
    this.accX = 0;
    this.dashing = false;
    this.endFlip();
    this.flipResidual = 0;
    this.ghostAge.fill(Infinity);
    for (let i = 0; i < this.ghosts.length; i++) (this.ghosts[i] as Sprite).alpha = 0;
    this.anim.sinceLand = 99;
    this.anim.sinceWallJump = 99;
    const m = this.rootMatrix;
    m[0] = p.facing;
    m[1] = 0;
    m[2] = 0;
    m[3] = 1;
    m[4] = 0;
    m[5] = 0;
    this.skeleton.evaluate(m);
    const ax = x + this.skeleton.pointX(this.boneScarf, SCARF_ANCHOR.x, SCARF_ANCHOR.y);
    const ay = y + this.skeleton.pointY(this.boneScarf, SCARF_ANCHOR.x, SCARF_ANCHOR.y);
    this.ribbon.reset(ax, ay, -p.facing, -0.15);
    if (p.alive && p.mode !== 'dead' && this.anim.sinceRespawn > 0) this.animator.snap(HERO_CLIP.idle);
  }

  private endFlip(): void {
    if (!this.anim.flipping) return;
    this.anim.flipping = false;
    const a = this.flipAngle();
    this.flipResidual = a - TAU * Math.round(a / TAU);
  }

  private flipAngle(): number {
    const t = clamp(this.flipT / HERO_ANIM.flipTime, 0, 1);
    return TAU * (1 - (1 - t) * (1 - t) * (1 - t));
  }

  private trackMotion(dt: number, x: number, p: PlayerView): void {
    if (dt > 0) {
      const v = (x - this.lastX) / dt;
      this.accX = damp(this.accX, (v - this.velX) / dt, 10, dt);
      this.velX = v;
    }
    this.lastX = x;
    const a = this.anim;
    a.sinceLand += dt;
    a.sinceWallJump += dt;
    a.sinceRespawn += dt;
    if (a.flipping) {
      this.flipT += dt;
      if (this.flipT >= HERO_ANIM.flipTime) a.flipping = false;
      else if (p.grounded || p.mode === 'wallSlide' || p.mode === 'dash' || !p.alive) this.endFlip();
    }
    this.flipResidual = damp(this.flipResidual, 0, 22, dt);
    this.facingScale = p.facing > this.facingScale
      ? Math.min(p.facing, this.facingScale + TURN_RATE * dt)
      : Math.max(p.facing, this.facingScale - TURN_RATE * dt);
  }

  private animate(dt: number, frame: FrameInfo, p: PlayerView): void {
    const a = this.anim;
    a.mode = p.mode;
    a.alive = p.alive;
    a.grounded = p.grounded;
    a.vx = p.vx;
    a.vy = p.vy;
    a.inputX = p.inputX;
    const clip = chooseHeroClip(a);
    if (clip !== this.animator.current) this.animator.play(clip, fadeInto(clip));
    this.animator.update(dt);
    if ((this.animator.weights[HERO_CLIP.run] as number) > 0) {
      const dist = p.runDistance + (p.grounded ? Math.abs(p.vx) * frame.alpha * SIM_DT : 0);
      this.animator.setPhase(HERO_CLIP.run, dist / RUN_STRIDE);
    }
    this.animator.apply(this.skeleton);
  }

  /** Procedural layers on top of the clip pose. */
  private pose(dt: number, p: PlayerView, time: number): void {
    const pose = this.skeleton.pose;
    const facing = p.facing;
    const forward = p.vx * facing;
    const airborne = !p.grounded;
    const leanTarget = p.mode === 'dash' || p.mode === 'wallSlide' || !p.alive
      ? 0
      : clamp((forward / MAX_RUN) * 0.07 + this.accX * facing * 0.000035, -0.1, 0.16) * (airborne ? 0.5 : 1);
    this.lean = damp(this.lean, leanTarget, 10, dt);
    pose[this.boneRoot * CHANNELS + CH.rot] = (pose[this.boneRoot * CHANNELS + CH.rot] as number) + this.lean;

    const tiltTarget = airborne && p.mode === 'air' ? clamp(p.vy * 0.00016, -0.2, 0.22) : 0;
    this.headTilt = damp(this.headTilt, tiltTarget, 8, dt);
    pose[this.boneHead * CHANNELS + CH.rot] = (pose[this.boneHead * CHANNELS + CH.rot] as number) + this.headTilt;

    const flip = (this.anim.flipping ? this.flipAngle() : 0) + this.flipResidual;
    pose[this.boneCore * CHANNELS + CH.rot] = (pose[this.boneCore * CHANNELS + CH.rot] as number) + flip;

    const sway = this.noise.noise2((time % 3600) * 0.6, 3.1) * 0.08;
    const drive = clamp(-this.accX * facing * 0.00042 - forward * 0.00022, -0.7, 0.7) + sway;
    this.sprout.update(dt, drive);
    pose[this.boneSproutA * CHANNELS + CH.rot] = (pose[this.boneSproutA * CHANNELS + CH.rot] as number) + this.sprout.value;
    pose[this.boneSproutB * CHANNELS + CH.rot] = (pose[this.boneSproutB * CHANNELS + CH.rot] as number) + this.sprout.value * 0.75;

    const dashEase = 1 - 0.55 * p.dashProgress * p.dashProgress;
    this.squash.update(dt, p.mode === 'dash' ? SQUASH.dash * dashEase : 0);

    this.blinkIn -= dt;
    this.blinkT += dt;
    if (this.blinkIn <= 0) {
      this.blinkT = 0;
      this.blinkIn = this.rng.chance(0.18) ? 0.28 : this.rng.range(2.2, 5.6);
    }
  }

  private placeParts(): void {
    const mirrored = this.facingScale < 0;
    const swap = mirrored !== this.mirrored;
    this.mirrored = mirrored;
    const blink = this.blinkT < BLINK_TIME ? 1 - 0.9 * Math.sin((this.blinkT / BLINK_TIME) * Math.PI) : 1;
    const w = this.skeleton.world;
    const hb = this.boneHead * 6;
    const lookY = clamp(this.velY() * 0.0012, -0.45, 0.45);
    const m = this.matrix;
    const s = this.scratch;
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i] as PartSlot;
      partMatrix(this.skeleton, slot.att, slot.density, 0, 0, s, 1, slot.eye ? blink : 1);
      if (slot.eye) {
        s[4] = (s[4] as number) + (w[hb + 2] as number) * lookY;
        s[5] = (s[5] as number) + (w[hb + 3] as number) * lookY;
      }
      m.a = s[0] as number;
      m.b = s[1] as number;
      m.c = s[2] as number;
      m.d = s[3] as number;
      m.tx = s[4] as number;
      m.ty = s[5] as number;
      slot.sprite.setFromMatrix(m);
      if (swap) slot.sprite.texture = mirrored ? slot.texL : slot.texR;
      if (slot.twin) {
        slot.twin.setFromMatrix(m);
        if (swap) slot.twin.texture = slot.sprite.texture;
      }
      if (slot.att.id === 'bud' && this.budGlow) this.budGlow.position.set(m.tx, m.ty);
    }
  }

  private velY(): number {
    return this.anim.grounded ? 0 : this.anim.vy;
  }

  private updateScarf(dt: number, x: number, y: number, facing: number, time: number): void {
    const geo = this.scarfGeometry;
    if (!geo) return;
    const sk = this.skeleton;
    const ax = x + sk.pointX(this.boneScarf, SCARF_ANCHOR.x, SCARF_ANCHOR.y);
    const ay = y + sk.pointY(this.boneScarf, SCARF_ANCHOR.x, SCARF_ANCHOR.y);
    this.ribbon.update(dt, ax, ay, -facing, -0.18, time);
    const r = this.ribbon;
    const cx = this.curveX;
    const cy = this.curveY;
    const last = r.count - 1;
    for (let k = 0; k < SCARF_POINTS; k++) {
      const s = (k / (SCARF_POINTS - 1)) * last;
      const i = Math.min(last - 1, Math.floor(s));
      const t = s - i;
      const i0 = i > 0 ? i - 1 : 0;
      const i3 = i + 2 <= last ? i + 2 : last;
      cx[k] = catmullRom(r.x[i0] as number, r.x[i] as number, r.x[i + 1] as number, r.x[i3] as number, t) - x;
      cy[k] = catmullRom(r.y[i0] as number, r.y[i] as number, r.y[i + 1] as number, r.y[i3] as number, t) - y;
    }
    const n = SCARF_POINTS;
    const pos = geo.positions;
    for (let i = 0; i < n; i++) {
      const i0 = i > 0 ? i - 1 : 0;
      const i1 = i < n - 1 ? i + 1 : n - 1;
      let tx = (cx[i1] as number) - (cx[i0] as number);
      let ty = (cy[i1] as number) - (cy[i0] as number);
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const u = i / (n - 1);
      const half = (SCARF_WIDTH * (1 - SCARF_TAPER * u) * (0.75 + 0.25 * Math.min(1, u * 6))) / 2;
      const px = cx[i] as number;
      const py = cy[i] as number;
      pos[i * 4] = px - ty * half;
      pos[i * 4 + 1] = py + tx * half;
      pos[i * 4 + 2] = px + ty * half;
      pos[i * 4 + 3] = py - tx * half;
    }
    geo.getBuffer('aPosition').update();
  }

  private updateHalo(time: number, sy: number): void {
    const halo = this.halo;
    if (!halo) return;
    const t = time % 3600;
    const flicker = 1 + 0.07 * this.noise.noise2(t * 2.2, 0.5) + 0.03 * this.noise.noise2(t * 7.1, 9.2);
    halo.alpha = HALO_ALPHA * flicker;
    halo.position.set(0, HALO_Y * sy);
    if (this.budGlow) this.budGlow.alpha = 0.75 + 0.2 * this.noise.noise2(t * 1.7, 4.4);
  }

  private updateGhosts(dt: number, x: number, y: number, facing: number): void {
    if (this.dashing) {
      this.ghostTimer += dt;
      if (this.ghostTimer >= this.ghostNext) {
        this.ghostNext = this.ghostTimer + GHOST_INTERVAL;
        let oldest = 0;
        for (let i = 1; i < GHOSTS; i++) if ((this.ghostAge[i] as number) > (this.ghostAge[oldest] as number)) oldest = i;
        this.ghostAge[oldest] = 0;
        const g = this.ghosts[oldest] as Sprite;
        g.position.set(x, y);
        g.scale.set(facing / GHOST_DENSITY, 1 / GHOST_DENSITY);
      }
    }
    for (let i = 0; i < GHOSTS; i++) {
      const age = (this.ghostAge[i] as number) + dt;
      this.ghostAge[i] = age;
      (this.ghosts[i] as Sprite).alpha = age < GHOST_LIFE ? GHOST_ALPHA * (1 - age / GHOST_LIFE) ** 1.5 : 0;
    }
  }

  destroy(): void {
    this.ctx?.textures.remove(TEXTURE_KEY);
    this.root.destroy({ children: true });
    this.glowRoot.destroy({ children: true });
    this.scarfGeometry?.destroy();
    for (const t of this.textures) t.destroy(false);
    this.atlasTexture?.destroy(true);
    this.atlasTexture = null;
    this.ctx = null;
  }
}
