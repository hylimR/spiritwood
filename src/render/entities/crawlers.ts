import type { Sprite } from 'pixi.js';
import type { RenderStats } from '../../contracts/debug.ts';
import type { FrameInfo } from '../../contracts/render.ts';
import { SimEventType, type EnemyView, type SimEvent } from '../../contracts/sim.ts';
import { PALETTE } from '../../config.ts';
import { clamp, smoothstep, stepSpring, type Spring1D } from '../../core/math.ts';
import { LEG_IMAGE_LENGTH } from './entityAtlas.ts';
import {
  idPhase, imageSprite, InstanceGroup, nearView, quadFill, type EntityLayers, type EntityRenderer, type EntityTextures,
} from './kit.ts';
import { gaitFoot, solveTwoBone, type Point } from './legIk.ts';

export const CRAWLER = Object.freeze({
  /** World units per full gait cycle; foot reach = stride / 4 so feet never slide. */
  stride: 30,
  lift: 4.5,
  thigh: 11,
  shin: 12.5,
  hipY: -10,
  /**
   * Near-side hips, then far-side hips (x in facing-right local space) and foot offsets. |offset| >
   * stride / 4 keeps every foot on one side of its hip through the whole gait, so the knee (always
   * bent upward, away from the ground) never has to swap sides: the rear legs kneel back, the middle
   * and front legs forward.
   */
  nearHips: [-15, -5, 9] as readonly number[],
  farHips: [-11, -1, 13] as readonly number[],
  footOffset: [-9.5, 8.5, 10] as readonly number[],
  legThickness: 1,
  farTint: 0x6f7c88,
  /** Facing turns at this many scale units per second (≈ 0.5 s turn). */
  turnRate: 4,
  eyes: [[25, -14.5, 1], [21, -16, 0.78]] as readonly (readonly [number, number, number])[],
  wisps: 5,
  squashStiffness: 260,
  squashDamping: 13,
  reformTime: 0.35,
  cullMargin: 120,
});

interface CrawlerState {
  group: InstanceGroup;
  body: Sprite;
  legs: Sprite[];
  eyes: Sprite[];
  eyeTwins: Sprite[];
  wisps: Sprite[];
  phase: number;
  facing: number;
  dist: number;
  lastX: number;
  squash: Spring1D;
  reformT: number;
  lastMode: EnemyView['mode'];
  initialised: boolean;
}

/**
 * Gloomcrawler: a low, dark bramble-backed crawler with six thin procedurally animated legs (tripod
 * gait driven by distance travelled, two-bone IK) and two glowing thorn-red eyes. It turns smoothly;
 * when stunned it collapses into dark wisps with dimmed eyes, and pops back on EnemyReformed.
 */
export class CrawlerRenderer implements EntityRenderer {
  private readonly items: CrawlerState[] = [];
  private readonly bodyScale: number;
  private readonly legScale: number;
  private readonly eyeScale: number;
  private readonly wispScale: number;
  private readonly hip: Point = { x: 0, y: 0 };
  private readonly foot: Point = { x: 0, y: 0 };
  private readonly knee: Point = { x: 0, y: 0 };

  constructor(layers: EntityLayers, textures: EntityTextures, count: number) {
    const body = textures.get('crawlerBody');
    const leg = textures.get('leg');
    const eye = textures.get('crawlerEye');
    const wisp = textures.get('wisp');
    this.bodyScale = 1 / body.frame.density;
    this.legScale = 1 / leg.frame.density;
    this.eyeScale = 1 / eye.frame.density;
    this.wispScale = 16 / wisp.frame.w;
    for (let i = 0; i < count; i++) {
      const group = new InstanceGroup(layers);
      const legs: Sprite[] = [];
      for (let k = 0; k < 6; k++) legs.push(imageSprite(leg, group.body, CRAWLER.farTint));
      const bodySprite = imageSprite(body, group.body);
      for (let k = 0; k < 6; k++) legs.push(imageSprite(leg, group.body));
      const wisps: Sprite[] = [];
      for (let k = 0; k < CRAWLER.wisps; k++) {
        const w = imageSprite(wisp, group.body, 0xffffff, 0);
        w.anchor.set(0.5);
        wisps.push(w);
      }
      const eyes: Sprite[] = [];
      const eyeTwins: Sprite[] = [];
      for (const [ex, ey, es] of CRAWLER.eyes) {
        const e = imageSprite(eye, group.front);
        e.position.set(ex, ey);
        e.scale.set(this.eyeScale * es);
        eyes.push(e);
        const tw = imageSprite(eye, group.glow, PALETTE.thorns);
        tw.position.set(ex, ey);
        tw.scale.set(this.eyeScale * es * 1.3);
        eyeTwins.push(tw);
      }
      this.items.push({
        group, body: bodySprite, legs, eyes, eyeTwins, wisps, phase: idPhase(i, 7), facing: 1, dist: 0, lastX: 0,
        squash: { value: 0, velocity: 0 }, reformT: Infinity, lastMode: 'patrol', initialised: false,
      });
    }
  }

  onSimEvent(e: SimEvent): void {
    if (e.type === SimEventType.EnemyStomped || e.type === SimEventType.EnemyReformed) {
      const it = this.items[e.id];
      if (!it) return;
      if (e.type === SimEventType.EnemyStomped) it.squash.velocity -= 9;
      else it.reformT = 0;
    } else if (e.type === SimEventType.Respawned || e.type === SimEventType.Reset || e.type === SimEventType.Teleported) {
      for (let i = 0; i < this.items.length; i++) (this.items[i] as CrawlerState).initialised = false;
    }
  }

  update(frame: FrameInfo, stats: RenderStats | null): void {
    const enemies = frame.sim.enemies;
    const cam = frame.camera;
    const dt = frame.dt;
    const t = frame.time % 3600;
    for (let i = 0; i < this.items.length && i < enemies.length; i++) {
      const it = this.items[i] as CrawlerState;
      const en = enemies[i] as EnemyView;
      const x = en.prevX + (en.x - en.prevX) * frame.alpha;
      const y = en.prevY + (en.y - en.prevY) * frame.alpha;
      if (!it.initialised) {
        it.initialised = true;
        it.facing = en.facing;
        it.lastX = x;
        it.squash.value = 0;
        it.squash.velocity = 0;
        it.lastMode = en.mode;
      }
      it.dist += Math.abs(x - it.lastX);
      it.lastX = x;
      it.facing = en.facing > it.facing
        ? Math.min(en.facing, it.facing + CRAWLER.turnRate * dt)
        : Math.max(en.facing, it.facing - CRAWLER.turnRate * dt);
      if (it.lastMode === 'stunned' && en.mode === 'patrol' && it.reformT > CRAWLER.reformTime) it.reformT = 0;
      it.lastMode = en.mode;
      it.reformT += dt;
      stepSpring(it.squash, 0, CRAWLER.squashStiffness, CRAWLER.squashDamping, Math.min(dt, 1 / 30));

      const visible = nearView(cam, x, y - 20, 50, CRAWLER.cullMargin);
      it.group.setVisible(visible);
      if (!visible) continue;
      // Ease the turn so the crawler never renders paper-thin for long.
      const turn = Math.sign(it.facing) * (0.35 + 0.65 * smoothstep(0, 1, Math.abs(it.facing)));
      it.group.place(x, y, turn, 1);
      this.pose(it, en, t);
      if (stats) stats.fillScreens += quadFill(cam, 80, 55);
    }
  }

  private pose(it: CrawlerState, en: EnemyView, t: number): void {
    const stun = en.mode === 'stunned' && en.modeDuration > 0 ? clamp(en.modeTicks / en.modeDuration, 0, 1) : 0;
    const collapse = en.mode === 'stunned' ? smoothstep(0, 0.12, stun) * (1 - smoothstep(0.86, 1, stun)) : 0;
    const pop = it.reformT < CRAWLER.reformTime ? Math.sin((it.reformT / CRAWLER.reformTime) * Math.PI) * 0.16 : 0;
    const phase = (it.dist / CRAWLER.stride) * Math.PI * 2 + it.phase;
    const bob = Math.sin(phase * 2) * 0.7 * (1 - collapse);
    const sq = clamp(it.squash.value, -0.5, 0.4);
    const sy = (1 + sq) * (1 - 0.55 * collapse) * (1 + pop);
    const sx = (1 - sq * 0.5) * (1 + 0.14 * collapse) * (1 + pop * 0.5);
    it.body.scale.set(this.bodyScale * sx, this.bodyScale * sy);
    it.body.position.set(0, bob + 2 * collapse);
    it.body.alpha = 1 - 0.55 * collapse;

    const reach = CRAWLER.stride / 4;
    const hipY = CRAWLER.hipY * sy + bob;
    for (let side = 0; side < 2; side++) {
      const hips = side === 0 ? CRAWLER.farHips : CRAWLER.nearHips;
      for (let k = 0; k < 3; k++) {
        const legPhase = phase + (k % 2 === side ? 0 : Math.PI) + k * 0.35;
        const hx = (hips[k] as number) * sx;
        gaitFoot(legPhase, hx + (CRAWLER.footOffset[k] as number) * (1 + 0.5 * collapse), 0, reach * (1 - collapse), CRAWLER.lift * (1 - collapse), this.foot);
        this.hip.x = hx;
        this.hip.y = hipY;
        // Knee on the upper side of the hip→foot line, so it never dips through the ground.
        const bend = this.foot.x < this.hip.x ? 1 : -1;
        solveTwoBone(this.hip.x, this.hip.y, this.foot.x, this.foot.y, CRAWLER.thigh, CRAWLER.shin * (1 - 0.35 * collapse), bend, this.knee);
        const base = side * 6 + k * 2;
        this.segment(it.legs[base] as Sprite, this.hip.x, this.hip.y, this.knee.x, this.knee.y);
        this.segment(it.legs[base + 1] as Sprite, this.knee.x, this.knee.y, this.foot.x, this.foot.y);
      }
    }

    const blink = Math.sin(t * 0.7 + it.phase * 3) > 0.985 ? 0.2 : 1;
    const flicker = stun > 0.8 ? 0.5 + 0.5 * Math.sin(t * 40) : 1;
    const eyeAlpha = (1 - 0.88 * collapse) * (collapse > 0 ? flicker : 1);
    for (let e = 0; e < it.eyes.length; e++) {
      const spec = CRAWLER.eyes[e] as readonly [number, number, number];
      const ex = spec[0];
      const ey = spec[1];
      const es = spec[2];
      const eye = it.eyes[e] as Sprite;
      const twin = it.eyeTwins[e] as Sprite;
      eye.position.set(ex * sx, ey * sy + bob);
      twin.position.copyFrom(eye.position);
      eye.scale.set(this.eyeScale * es, this.eyeScale * es * blink);
      twin.scale.set(this.eyeScale * es * 1.3, this.eyeScale * es * 1.3 * blink);
      eye.alpha = eyeAlpha;
      twin.alpha = eyeAlpha * 0.9;
    }

    for (let w = 0; w < it.wisps.length; w++) {
      const wisp = it.wisps[w] as Sprite;
      if (collapse <= 0) {
        wisp.alpha = 0;
        continue;
      }
      const age = (t * 0.55 + w / it.wisps.length + it.phase) % 1;
      wisp.position.set(-18 + w * 9 + Math.sin(t * 1.3 + w) * 3, -12 - age * 30);
      wisp.scale.set(this.wispScale * (0.7 + age));
      wisp.alpha = collapse * Math.sin(age * Math.PI) * 0.85;
    }
  }

  private segment(s: Sprite, ax: number, ay: number, bx: number, by: number): void {
    const len = Math.hypot(bx - ax, by - ay);
    s.position.set(ax, ay);
    s.rotation = Math.atan2(by - ay, bx - ax);
    s.scale.set((len / LEG_IMAGE_LENGTH) * this.legScale, this.legScale * CRAWLER.legThickness);
  }
}
