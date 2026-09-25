import { Mesh, MeshGeometry, type Container, type Sprite, type Texture } from 'pixi.js';
import type { RenderStats } from '../../contracts/debug.ts';
import type { FrameInfo } from '../../contracts/render.ts';
import type { ProjectileView } from '../../contracts/sim.ts';
import { MAX_PROJECTILES, PALETTE, SIM_DT } from '../../config.ts';
import { clamp01 } from '../../core/math.ts';
import {
  idPhase, imageSprite, PALPHA, POSE_STRIDE, PoseBuffer, PROT, PSX, PSY, PTINT, PX, PY, radialSprite, type EntityImage,
  type EntityLayers, type EntityRenderer, type EntityTextures,
} from './kit.ts';

export const SEED = Object.freeze({
  /** Trail points: point 0 is the interpolated head, then up to `trailPoints − 1` tick samples (§5.5: ≤ 8). */
  trailPoints: 8,
  /** A seed fades out over its last this-many ticks of age (so an expiry never pops). */
  fadeTicks: 30,
  /** Ticks to scale in from the mouth. */
  spawnTicks: 3,
  /**
   * Trail width (u) at the head, and at the tail relative to it. The hostile ember wake starts at ≈ 60 %
   * of the seed's body and tapers to nothing; the reflected wisp's trail keeps a thin tail.
   */
  hostileTrailWidth: 18,
  hostileTailWidth: 0,
  reflectedTrailWidth: 15,
  reflectedTailWidth: 0.25,
  /** The ember wake carries its own colour (`seedEmber`); the reflected trail is white, tinted. */
  hostileTrailTint: 0xffffff,
  reflectedTrailTint: PALETTE.spiritGlow,
  hostileHaloTint: PALETTE.thorns,
  reflectedHaloTint: 0x8fdcff,
  hostileHalo: 24,
  reflectedHalo: 30,
  twinRadius: 20,
  /** Glow-buffer pixels a trail twin is at least this wide (thin twins vanish in the bloom's first downsample). */
  twinMinPx: 2.5,
  /** Hostile seeds spin (rad/s, world clock). */
  spin: 5.5,
});

const P = SEED.trailPoints;
const SAMPLES = P - 1;
const VERTS = P * 2;

/** PoseBuffer slots per seed: its scene trail, halo and body, then its twin trail and twin. */
const TRAIL = 0;
const HALO = 1;
const BODY = 2;
const TWIN_TRAIL = 3;
const TWIN = 4;
const NODES = 5;

/** A default-shader ribbon mesh of P points (2·P ≤ 100 vertices, so Pixi batches it with sprites). */
function trailMesh(texture: Texture, parent: Container): Mesh<MeshGeometry> {
  const uvs = new Float32Array(VERTS * 2);
  const indices = new Uint32Array((P - 1) * 6);
  for (let i = 0; i < P; i++) {
    const u = i / (P - 1);
    uvs[i * 4] = u;
    uvs[i * 4 + 1] = 0;
    uvs[i * 4 + 2] = u;
    uvs[i * 4 + 3] = 1;
    if (i < P - 1) {
      const o = i * 6;
      indices[o] = 2 * i;
      indices[o + 1] = 2 * i + 1;
      indices[o + 2] = 2 * i + 2;
      indices[o + 3] = 2 * i + 1;
      indices[o + 4] = 2 * i + 3;
      indices[o + 5] = 2 * i + 2;
    }
  }
  const geometry = new MeshGeometry({ positions: new Float32Array(VERTS * 2), uvs, indices });
  const mesh = new Mesh({ geometry, texture });
  mesh.alpha = 0;
  parent.addChild(mesh);
  return mesh;
}

/**
 * Thorn Spitter seeds (§5.5): a rose ember with small thorns and an ember wake (hostile), or a
 * spirit-blue wisp with a comet trail (reflected), each trail a ribbon of ≤ 8 points. Every seed, halo
 * and trail lives in the entity `seeds` layer as atlas sprites and default-shader meshes under one blend
 * mode, so they all share one draw (continuing the entity bodies' batch); their twins share one draw in
 * the glow slot. Pool slots are never added, removed or toggled `visible`: an inactive slot is alpha 0
 * and zero area (an alpha-0 quad still costs its fill), and is not touched again until it is reused.
 * Trails take one sample per tick in which the seed moved (point 0 is the interpolated head) and reset
 * when `spawnTick` changes. Only changed values reach Pixi (PoseBuffer, §6).
 */
export class SeedRenderer implements EntityRenderer {
  /** Scene: trails first (under every seed), then halos and bodies. */
  readonly trails: Mesh<MeshGeometry>[] = [];
  readonly halos: Sprite[] = [];
  readonly bodies: Sprite[] = [];
  readonly twinTrails: Mesh<MeshGeometry>[] = [];
  readonly twins: Sprite[] = [];
  /** Per slot: trail samples (x, y), newest first. */
  readonly samples = new Float32Array(MAX_PROJECTILES * SAMPLES * 2);
  readonly sampleCount = new Int32Array(MAX_PROJECTILES);
  private readonly poses = new PoseBuffer();
  private readonly spawnTick = new Float64Array(MAX_PROJECTILES).fill(Number.NaN);
  private readonly lastAge = new Int32Array(MAX_PROJECTILES);
  private readonly phase = new Float32Array(MAX_PROJECTILES);
  /** Owner each slot is dressed for (0 hostile, 1 reflected, −1 none): textures and tints change only with it. */
  private readonly dressed = new Int8Array(MAX_PROJECTILES).fill(-1);
  /** 1 while a slot draws (its quads have area). */
  private readonly shown = new Uint8Array(MAX_PROJECTILES);
  /** What each slot's ribbons were last written from (head x, y; sample count; twin minimum width). */
  private readonly trailKey = new Float64Array(MAX_PROJECTILES * 4).fill(Number.NaN);
  /** Scene ribbon length per slot (u), for the fill estimate. */
  private readonly trailLength = new Float64Array(MAX_PROJECTILES);
  /** Per-frame inputs of writeTrails (fields, so calls pass no fractional numbers). */
  private headX = 0;
  private headY = 0;
  private velX = 0;
  private velY = 0;
  private twinMin = 0;
  private ribbonLength = 0;
  private readonly hostile: EntityImage;
  private readonly wisp: EntityImage;
  private readonly emberTex: Texture;
  private readonly trailTex: Texture;
  private readonly hostileScale: number;
  private readonly wispScale: number;
  private readonly halo: EntityImage;
  private readonly glow: EntityImage;
  /** Visible seeds after the last update (tests, stats). */
  liveSeeds = 0;

  constructor(layers: EntityLayers, textures: EntityTextures) {
    const hostile = textures.get('seedHostile');
    const wisp = textures.get('seedWisp');
    this.hostile = hostile;
    this.wisp = wisp;
    this.emberTex = textures.get('seedEmber').tex;
    this.trailTex = textures.get('seedTrail').tex;
    this.halo = textures.get('glowLight');
    this.glow = textures.get('glow');
    this.hostileScale = 1 / hostile.frame.density;
    this.wispScale = 1 / wisp.frame.density;
    for (let i = 0; i < MAX_PROJECTILES; i++) this.trails.push(trailMesh(this.emberTex, layers.seeds));
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.halos.push(radialSprite(this.halo, layers.seeds, SEED.hostileHalo, SEED.hostileHaloTint, 0));
      this.bodies.push(imageSprite(hostile, layers.seeds, 0xffffff, 0));
      this.phase[i] = idPhase(i, 23);
    }
    for (let i = 0; i < MAX_PROJECTILES; i++) this.twinTrails.push(trailMesh(this.emberTex, layers.seedGlow));
    for (let i = 0; i < MAX_PROJECTILES; i++) this.twins.push(radialSprite(this.glow, layers.seedGlow, SEED.twinRadius, SEED.hostileHaloTint, 0));
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      this.poses.add(this.trails[i] as Mesh);
      this.poses.add(this.halos[i] as Sprite);
      this.poses.add(this.bodies[i] as Sprite);
      this.poses.add(this.twinTrails[i] as Mesh);
      this.poses.add(this.twins[i] as Sprite);
      this.hide(i);
    }
  }

  update(frame: FrameInfo, stats: RenderStats | null): void {
    const seeds = frame.sim.projectiles;
    const n = Math.min(MAX_PROJECTILES, seeds.length);
    // No seed in flight and none left to park: nothing to do.
    let busy = false;
    for (let i = 0; i < n && !busy; i++) busy = (seeds[i] as ProjectileView).active || this.shown[i] === 1;
    if (!busy) {
      this.liveSeeds = 0;
      return;
    }
    const a = frame.alpha;
    const t = frame.worldTime % 3600;
    const cam = frame.camera;
    // World units per glow-buffer pixel: a twin trail at least `twinMinPx` of them wide.
    const glowPx = frame.pxPerUnit * cam.zoom * frame.quality.bloomScale;
    this.twinMin = glowPx > 0 ? SEED.twinMinPx / glowPx : 0;
    const w = this.poses.want;
    let live = 0;
    let fill = 0;
    for (let i = 0; i < n; i++) {
      const s = seeds[i] as ProjectileView;
      if (!s.active) {
        if (this.shown[i] === 1) this.hide(i);
        continue;
      }
      if (s.spawnTick !== this.spawnTick[i]) {
        // A new flight (a fire or a reflection): the trail starts over from its first tick.
        this.spawnTick[i] = s.spawnTick;
        this.sampleCount[i] = 0;
        this.lastAge[i] = 0;
      }
      if (s.age > (this.lastAge[i] as number)) {
        this.pushSamples(i, s, s.age - (this.lastAge[i] as number));
        this.lastAge[i] = s.age;
      }
      const reflected = s.owner === 'reflected';
      if (this.dressed[i] !== (reflected ? 1 : 0)) this.dress(i, reflected);
      this.shown[i] = 1;
      live++;

      const hx = s.prevX + (s.x - s.prevX) * a;
      const hy = s.prevY + (s.y - s.prevY) * a;
      const moving = s.x !== s.prevX || s.y !== s.prevY;
      const age = s.age + (moving ? a : 0);
      let fade = (s.lifetime - age) / SEED.fadeTicks;
      fade = fade < 0 ? 0 : fade > 1 ? 1 : fade;
      let grow = age / SEED.spawnTicks;
      grow = 0.45 + 0.55 * (grow > 1 ? 1 : grow);
      const ph = this.phase[i] as number;
      const base = i * NODES;
      const ob = (base + BODY) * POSE_STRIDE;
      const oh = (base + HALO) * POSE_STRIDE;
      const ot = (base + TWIN) * POSE_STRIDE;
      let haloR: number;
      w[ob + PX] = hx;
      w[ob + PY] = hy;
      if (reflected) {
        const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
        if (speed > 1) w[ob + PROT] = Math.atan2(s.vy, s.vx);
        const flicker = 1 + 0.08 * Math.sin(t * 23 + ph) + 0.05 * Math.sin(t * 41 + ph * 2);
        w[ob + PSX] = this.wispScale * grow * (1 + Math.min(0.35, speed / 3000));
        w[ob + PSY] = this.wispScale * grow * flicker;
        haloR = SEED.reflectedHalo * grow * flicker;
      } else {
        w[ob + PROT] = t * SEED.spin + ph;
        w[ob + PSX] = this.hostileScale * grow;
        w[ob + PSY] = this.hostileScale * grow;
        haloR = SEED.hostileHalo * grow * (1 + 0.06 * Math.sin(t * 9 + ph));
      }
      w[ob + PALPHA] = fade;
      const haloScale = (2 * haloR) / this.halo.frame.w;
      w[oh + PX] = hx;
      w[oh + PY] = hy;
      w[oh + PSX] = haloScale;
      w[oh + PSY] = haloScale;
      w[oh + PALPHA] = fade * (reflected ? 0.75 : 0.6);
      const twinScale = (2 * SEED.twinRadius * grow) / this.glow.frame.w;
      w[ot + PX] = hx;
      w[ot + PY] = hy;
      w[ot + PSX] = twinScale;
      w[ot + PSY] = twinScale;
      w[ot + PALPHA] = fade * (reflected ? 0.9 : 0.75);
      w[(base + TRAIL) * POSE_STRIDE + PALPHA] = fade * (reflected ? 0.95 : 0.85);
      w[(base + TWIN_TRAIL) * POSE_STRIDE + PALPHA] = fade * 0.8;
      this.poses.flush(base, NODES);

      // Ribbons are rewritten only when their head, samples or minimum width changed.
      const k = i * 4;
      const key = this.trailKey;
      if (hx !== key[k] || hy !== key[k + 1] || this.sampleCount[i] !== key[k + 2] || this.twinMin !== key[k + 3]) {
        key[k] = hx;
        key[k + 1] = hy;
        key[k + 2] = this.sampleCount[i] as number;
        key[k + 3] = this.twinMin;
        this.headX = hx;
        this.headY = hy;
        this.velX = s.vx;
        this.velY = s.vy;
        this.writeTrails(i, reflected ? 1 : 0);
      }
      // Scene quads only (twins land in the smaller glow buffer): halo, body and the tapered ribbon.
      const img = reflected ? this.wisp : this.hostile;
      const width = reflected ? SEED.reflectedTrailWidth : SEED.hostileTrailWidth;
      const tail = reflected ? SEED.reflectedTailWidth : SEED.hostileTailWidth;
      fill += 4 * haloR * haloR + (w[ob + PSX] as number) * img.frame.w * (w[ob + PSY] as number) * img.frame.h
        + width * (1 + tail) * 0.5 * (this.trailLength[i] as number);
    }
    this.liveSeeds = live;
    if (stats) stats.fillScreens += fill / Math.max(1, cam.width * cam.height);
  }

  /** Swap a slot's images and tints to its owner: the ember and its wake, or the wisp and its trail. */
  private dress(i: number, reflected: boolean): void {
    this.dressed[i] = reflected ? 1 : 0;
    const body = this.bodies[i] as Sprite;
    const img = reflected ? this.wisp : this.hostile;
    body.texture = img.tex;
    // The images pivot at the seed's centre, which is not their frame centre (the wisp's tail trails).
    body.anchor.set(img.frame.pivotX / img.frame.w, img.frame.pivotY / img.frame.h);
    const ribbon = reflected ? this.trailTex : this.emberTex;
    (this.trails[i] as Mesh).texture = ribbon;
    (this.twinTrails[i] as Mesh).texture = ribbon;
    const w = this.poses.want;
    const base = i * NODES;
    const haloTint = reflected ? SEED.reflectedHaloTint : SEED.hostileHaloTint;
    const trailTint = reflected ? SEED.reflectedTrailTint : SEED.hostileTrailTint;
    w[(base + HALO) * POSE_STRIDE + PTINT] = haloTint;
    w[(base + TWIN) * POSE_STRIDE + PTINT] = haloTint;
    w[(base + TRAIL) * POSE_STRIDE + PTINT] = trailTint;
    w[(base + TWIN_TRAIL) * POSE_STRIDE + PTINT] = trailTint;
    // Its ribbons must be rewritten for the new widths.
    this.trailKey[i * 4] = Number.NaN;
  }

  /** Park a slot: alpha 0 and zero area (never `visible`), then leave it alone until it is reused. */
  private hide(i: number): void {
    this.shown[i] = 0;
    this.sampleCount[i] = 0;
    this.spawnTick[i] = Number.NaN;
    this.trailKey[i * 4] = Number.NaN;
    this.trailLength[i] = 0;
    const base = i * NODES;
    const poses = this.poses;
    poses.park(base + HALO);
    poses.park(base + BODY);
    poses.park(base + TWIN);
    poses.want[(base + TRAIL) * POSE_STRIDE + PALPHA] = 0;
    poses.want[(base + TWIN_TRAIL) * POSE_STRIDE + PALPHA] = 0;
    poses.flush(base, NODES);
    collapse(this.trails[i] as Mesh<MeshGeometry>);
    collapse(this.twinTrails[i] as Mesh<MeshGeometry>);
  }

  /**
   * Record the `n` ticks the seed moved since the last frame, oldest first: the start of each tick,
   * stepping back from the end of the last one. When the frame's last tick was frozen (prev = cur) the
   * step comes from the seed's velocity instead of prev → cur.
   */
  private pushSamples(i: number, s: ProjectileView, n: number): void {
    const base = i * SAMPLES * 2;
    const buf = this.samples;
    let dx = s.x - s.prevX;
    let dy = s.y - s.prevY;
    if (dx === 0 && dy === 0) {
      dx = s.vx * SIM_DT;
      dy = s.vy * SIM_DT;
    }
    const count = Math.min(n, SAMPLES);
    for (let k = count - 1; k >= 0; k--) {
      // Shift older samples back by one.
      for (let j = SAMPLES - 1; j > 0; j--) {
        buf[base + j * 2] = buf[base + (j - 1) * 2] as number;
        buf[base + j * 2 + 1] = buf[base + (j - 1) * 2 + 1] as number;
      }
      buf[base] = s.x - dx * (k + 1);
      buf[base + 1] = s.y - dy * (k + 1);
      this.sampleCount[i] = Math.min(SAMPLES, (this.sampleCount[i] as number) + 1);
    }
  }

  /** Both ribbons of slot i from `headX/headY` and its samples (owner 1 = reflected). */
  private writeTrails(i: number, owner: number): void {
    this.writeRibbon((this.trails[i] as Mesh<MeshGeometry>).geometry, i, owner, 0);
    this.trailLength[i] = this.ribbonLength;
    this.writeRibbon((this.twinTrails[i] as Mesh<MeshGeometry>).geometry, i, owner, 1);
  }

  /**
   * Ribbon vertices: point 0 = the head, then the samples; unused points collapse onto the last one.
   * The twin (`twin` = 1) is a little narrower but at least `twinMin` wide. Sets `ribbonLength` (u).
   */
  private writeRibbon(geo: MeshGeometry, i: number, owner: number, twin: number): void {
    const pos = geo.positions;
    const buf = this.samples;
    const base = i * SAMPLES * 2;
    const count = this.sampleCount[i] as number;
    const hx = this.headX;
    const hy = this.headY;
    const width = (owner === 1 ? SEED.reflectedTrailWidth : SEED.hostileTrailWidth) * (twin === 1 ? 0.9 : 1);
    const tail = owner === 1 ? SEED.reflectedTailWidth : SEED.hostileTailWidth;
    const minWidth = twin === 1 ? this.twinMin : 0;
    let length = 0;
    let lx = hx;
    let ly = hy;
    for (let k = 0; k < P; k++) {
      const kk = k <= count ? k : count;
      const px = kk === 0 ? hx : (buf[base + (kk - 1) * 2] as number);
      const py = kk === 0 ? hy : (buf[base + (kk - 1) * 2 + 1] as number);
      length += Math.sqrt((px - lx) * (px - lx) + (py - ly) * (py - ly));
      lx = px;
      ly = py;
      // Tangent from the neighbouring points (the velocity at the head of a fresh trail).
      const k0 = kk > 0 ? kk - 1 : 0;
      const k1 = kk < count ? kk + 1 : count;
      let tx = (k0 === 0 ? hx : (buf[base + (k0 - 1) * 2] as number)) - (k1 === 0 ? hx : (buf[base + (k1 - 1) * 2] as number));
      let ty = (k0 === 0 ? hy : (buf[base + (k0 - 1) * 2 + 1] as number)) - (k1 === 0 ? hy : (buf[base + (k1 - 1) * 2 + 1] as number));
      let len = Math.sqrt(tx * tx + ty * ty);
      if (len < 1e-4) {
        tx = this.velX;
        ty = this.velY;
        len = Math.sqrt(tx * tx + ty * ty);
        if (len < 1e-4) {
          tx = 1;
          ty = 0;
          len = 1;
        }
      }
      tx /= len;
      ty /= len;
      const u = k / (P - 1);
      const wk = width * (1 - (1 - tail) * u);
      const half = k === kk ? (wk > minWidth ? wk : minWidth) * 0.5 : 0;
      pos[k * 4] = px - ty * half;
      pos[k * 4 + 1] = py + tx * half;
      pos[k * 4 + 2] = px + ty * half;
      pos[k * 4 + 3] = py - tx * half;
    }
    geo.getBuffer('aPosition').update();
    this.ribbonLength = length;
  }
}

/** Every vertex on one point: a zero-area ribbon draws no fragments. */
function collapse(m: Mesh<MeshGeometry>): void {
  m.geometry.positions.fill(0);
  m.geometry.getBuffer('aPosition').update();
}

/** Opacity of a seed at (interpolated) `age`: 1, then down to 0 over its last SEED.fadeTicks ticks. */
export function seedFade(age: number, lifetime: number): number {
  return clamp01((lifetime - age) / SEED.fadeTicks);
}
