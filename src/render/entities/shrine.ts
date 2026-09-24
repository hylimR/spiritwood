import type { Sprite } from 'pixi.js';
import type { RenderStats } from '../../contracts/debug.ts';
import type { FrameInfo } from '../../contracts/render.ts';
import { SimEventType, type GoalView, type SimEvent } from '../../contracts/sim.ts';
import { PALETTE } from '../../config.ts';
import { smoothstep } from '../../core/math.ts';
import {
  imageSprite, InstanceGroup, nearView, quadFill, radialSprite, setRadius, type EntityImage, type EntityLayers,
  type EntityRenderer, type EntityTextures,
} from './kit.ts';

export const SHRINE = Object.freeze({
  /** Width of the arch image in world units at scale 1 (the arch grows to frame wider goals). */
  archWidth: 116,
  /** Arch width relative to the goal rect. */
  frame: 1.3,
  lanterns: [[-25, -108], [25, -108]] as readonly (readonly [number, number])[],
  poolY: -4,
  poolWidth: 86,
  glowRadius: 95,
  rippleEvery: 2.6,
  surgeDecay: 1.6,
  /** Brightness after the surge settles. */
  reachedLevel: 1.35,
  beamHeight: 420,
  beamWidth: 60,
  cullMargin: 200,
  moonlight: 0xd8fbff,
});

/**
 * Moonwell shrine (goal): a mossy stone arch around a small pool of moonlight with two warm lanterns
 * swaying under it. On GoalReached the pool surges (brighter light, a rising column), then settles a
 * little brighter than before. World clock (the surge is anchored to the worldTime of its event).
 */
export class ShrineRenderer implements EntityRenderer {
  private readonly group: InstanceGroup;
  private readonly lanterns: Sprite[] = [];
  private readonly lanternGlows: Sprite[] = [];
  private readonly lanternTwins: Sprite[] = [];
  private readonly pool: Sprite;
  private readonly poolWide: Sprite;
  private readonly ripple: Sprite;
  private readonly poolTwin: Sprite;
  private readonly glow: Sprite;
  private readonly beam: Sprite;
  private readonly beamTwin: Sprite;
  private readonly ring: EntityImage;
  private readonly poolScale: number;
  private readonly beamSx: number;
  private readonly beamSy: number;
  private reachedAt = -1;
  private wasReached = false;

  constructor(layers: EntityLayers, textures: EntityTextures) {
    const g = (this.group = new InstanceGroup(layers));
    const glow = textures.get('glow');
    const pool = textures.get('pool');
    const beam = textures.get('beam');
    const lantern = textures.get('lantern');
    const arch = textures.get('moonArch');
    this.ring = textures.get('ring');
    this.poolScale = SHRINE.poolWidth / pool.frame.w;
    this.beamSx = SHRINE.beamWidth / beam.frame.w;
    this.beamSy = SHRINE.beamHeight / beam.frame.h;

    this.glow = radialSprite(glow, g.back, SHRINE.glowRadius, SHRINE.moonlight, 0.22);
    this.glow.position.set(0, -34);
    for (const [lx, ly] of SHRINE.lanterns) {
      const lg = radialSprite(glow, g.back, 34, PALETTE.warmAccent, 0.3);
      lg.position.set(lx, ly + 13.5);
      this.lanternGlows.push(lg);
    }
    this.beam = imageSprite(beam, g.back, SHRINE.moonlight, 0);
    this.beam.position.set(0, SHRINE.poolY);
    imageSprite(arch, g.body);
    for (const [lx, ly] of SHRINE.lanterns) {
      const l = imageSprite(lantern, g.body);
      l.position.set(lx, ly);
      this.lanterns.push(l);
      const tw = radialSprite(glow, g.glow, 9, PALETTE.warmAccent, 0.9);
      this.lanternTwins.push(tw);
    }
    this.poolWide = imageSprite(pool, g.front, SHRINE.moonlight, 0.5);
    this.pool = imageSprite(pool, g.front, 0xffffff, 0.95);
    this.ripple = radialSprite(this.ring, g.front, 20, SHRINE.moonlight, 0);
    this.poolTwin = imageSprite(pool, g.glow, 0xe8ffff, 0.9);
    this.beamTwin = imageSprite(beam, g.glow, SHRINE.moonlight, 0);
    this.beamTwin.position.set(0, SHRINE.poolY);
    for (const s of [this.pool, this.poolWide, this.poolTwin, this.ripple]) s.position.set(0, SHRINE.poolY);
  }

  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    if (e.type === SimEventType.GoalReached) this.reachedAt = frame.worldTime;
    else if (e.type === SimEventType.Reset) this.reachedAt = -1;
  }

  update(frame: FrameInfo, stats: RenderStats | null): void {
    const goal: GoalView | null = frame.sim.goal;
    if (!goal) {
      this.group.setVisible(false);
      return;
    }
    if (goal.reached && !this.wasReached && this.reachedAt < 0) this.reachedAt = frame.worldTime;
    if (!goal.reached) this.reachedAt = -1;
    this.wasReached = goal.reached;

    const scale = Math.max(1, (goal.w * SHRINE.frame) / SHRINE.archWidth);
    const x = goal.x + goal.w / 2;
    const y = goal.y + goal.h;
    const cam = frame.camera;
    const visible = nearView(cam, x, y - 70 * scale, 90 * scale, SHRINE.cullMargin);
    this.group.setVisible(visible);
    if (!visible) return;
    this.group.place(x, y, scale, scale);

    const t = frame.worldTime % 3600;
    const since = this.reachedAt >= 0 ? frame.worldTime - this.reachedAt : -1;
    const surge = since >= 0 ? Math.exp(-since * SHRINE.surgeDecay) : 0;
    const level = (since >= 0 ? SHRINE.reachedLevel : 1) + 1.6 * surge;

    const shimmer = 0.9 + 0.1 * Math.sin(t * 1.7) + 0.04 * Math.sin(t * 4.3);
    this.pool.alpha = Math.min(1, 0.82 * shimmer * level);
    this.pool.scale.set(this.poolScale * (1 + 0.08 * surge));
    this.poolWide.alpha = Math.min(1, 0.42 * shimmer * level);
    this.poolWide.scale.set(this.poolScale * 1.7, this.poolScale * 1.2);
    this.poolTwin.alpha = Math.min(1, 0.8 * level);
    this.poolTwin.scale.copyFrom(this.pool.scale);
    this.glow.alpha = 0.2 * level * shimmer;

    const rp = (t / SHRINE.rippleEvery) % 1;
    setRadius(this.ripple, this.ring, 8 + 34 * rp);
    this.ripple.scale.y *= 0.28;
    this.ripple.alpha = 0.45 * Math.sin(rp * Math.PI) * (1 - rp) * level;

    for (let i = 0; i < this.lanterns.length; i++) {
      const l = this.lanterns[i] as Sprite;
      const hang = SHRINE.lanterns[i] as readonly [number, number];
      const lx = hang[0];
      const ly = hang[1];
      const sway = Math.sin(t * 1.1 + i * 1.9) * 0.09 + Math.sin(t * 2.7 + i) * 0.02;
      l.rotation = sway;
      const gx = lx - Math.sin(sway) * 13.5;
      const gy = ly + Math.cos(sway) * 13.5;
      const flick = 0.85 + 0.1 * Math.sin(t * 7.3 + i * 2.2) + 0.05 * Math.sin(t * 13.1 + i);
      const lg = this.lanternGlows[i] as Sprite;
      lg.position.set(gx, gy);
      lg.alpha = 0.3 * flick * (1 + 0.4 * surge);
      const tw = this.lanternTwins[i] as Sprite;
      tw.position.set(gx, gy);
      tw.alpha = 0.85 * flick;
    }

    const beamGrow = since >= 0 ? 1 - Math.pow(1 - Math.min(1, since / 0.6), 3) : 0;
    const beamAlpha = since >= 0 ? 0.75 * surge + 0.12 * smoothstep(0, 1, since) : 0;
    this.beam.alpha = beamAlpha;
    this.beam.scale.set(this.beamSx, this.beamSy * beamGrow);
    this.beamTwin.alpha = beamAlpha * 0.8;
    this.beamTwin.scale.copyFrom(this.beam.scale);
    if (stats) stats.fillScreens += quadFill(cam, 2 * SHRINE.glowRadius * scale, 2 * SHRINE.glowRadius * scale) + quadFill(cam, 116 * scale, 142 * scale);
  }
}
