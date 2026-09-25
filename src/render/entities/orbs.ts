import type { Sprite } from 'pixi.js';
import type { RenderStats } from '../../contracts/debug.ts';
import type { FrameInfo } from '../../contracts/render.ts';
import { SimEventType, type OrbView, type SimEvent } from '../../contracts/sim.ts';
import { PALETTE, SIM_DT } from '../../config.ts';
import { clamp, smoothstep } from '../../core/math.ts';
import {
  idPhase, imageSprite, InstanceGroup, nearView, quadFill, radialSprite, type EntityLayers, type EntityRenderer,
  type EntityTextures,
} from './kit.ts';

export const ORB = Object.freeze({
  haloRadius: 40,
  haloAlpha: 0.32,
  glowRadius: 22,
  bob: 3.5,
  sparkles: 3,
  sparkleRadius: 15,
  sparkleSize: 7,
  /** Speed (u/s) at which the magnetised stretch saturates. */
  stretchSpeed: 1400,
  maxStretch: 0.6,
  collectTime: 0.24,
  collectScale: 1.9,
  cullMargin: 120,
});

interface OrbSprites {
  group: InstanceGroup;
  halo: Sprite;
  core: Sprite;
  coreTwin: Sprite;
  glow: Sprite;
  sparkles: Sprite[];
  phase: number;
}

/**
 * Spirit-light orbs: warm core with a warm-white centre, soft additive halo, a slow ring of twinkling
 * sparkles and a gentle bob; magnetised orbs stretch along their motion; collection plays a quick
 * scale-up + fade (the burst particles are the particle view's). World clock: the collect animation is
 * anchored to the worldTime of its OrbCollected event (ticks keep counting while the world is frozen).
 */
export class OrbRenderer implements EntityRenderer {
  private readonly items: OrbSprites[] = [];
  private readonly coreScale: number;
  /** worldTime each orb was collected at (−1 = not collected). */
  private readonly collectAt: Float64Array;

  constructor(layers: EntityLayers, textures: EntityTextures, count: number) {
    const glow = textures.get('glow');
    const core = textures.get('orbCore');
    const sparkle = textures.get('sparkle');
    this.coreScale = 1 / core.frame.density;
    this.collectAt = new Float64Array(count).fill(-1);
    for (let i = 0; i < count; i++) {
      const group = new InstanceGroup(layers);
      const sparkles: Sprite[] = [];
      const item: OrbSprites = {
        group,
        halo: radialSprite(glow, group.back, ORB.haloRadius, PALETTE.warmAccent, ORB.haloAlpha),
        core: imageSprite(core, group.body),
        coreTwin: imageSprite(core, group.glow, 0xf2f2f2),
        glow: radialSprite(glow, group.glow, ORB.glowRadius, PALETTE.warmAccent, 0.55),
        sparkles,
        phase: idPhase(i),
      };
      for (let k = 0; k < ORB.sparkles; k++) {
        const s = radialSprite(sparkle, group.front, ORB.sparkleSize, 0xfff1d6, 0);
        sparkles.push(s);
      }
      this.items.push(item);
    }
  }

  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    if (e.type === SimEventType.OrbCollected && e.id >= 0 && e.id < this.collectAt.length) this.collectAt[e.id] = frame.worldTime;
  }

  update(frame: FrameInfo, stats: RenderStats | null): void {
    const orbs = frame.sim.orbs;
    const cam = frame.camera;
    const t = frame.worldTime % 3600;
    for (let i = 0; i < this.items.length && i < orbs.length; i++) {
      const it = this.items[i] as OrbSprites;
      const o = orbs[i] as OrbView;
      let collectT = 0;
      if (o.collected) {
        // An orb seen collected without its event (a view created mid-run) starts its animation now.
        if ((this.collectAt[i] as number) < 0) this.collectAt[i] = frame.worldTime;
        collectT = frame.worldTime - (this.collectAt[i] as number);
        if (collectT >= ORB.collectTime) {
          it.group.setVisible(false);
          continue;
        }
      } else {
        this.collectAt[i] = -1;
      }
      const x = o.prevX + (o.x - o.prevX) * frame.alpha;
      const y = o.prevY + (o.y - o.prevY) * frame.alpha;
      const visible = nearView(cam, x, y, ORB.haloRadius, ORB.cullMargin);
      it.group.setVisible(visible);
      if (!visible) continue;

      const dx = (o.x - o.prevX) / SIM_DT;
      const dy = (o.y - o.prevY) / SIM_DT;
      const speed = Math.sqrt(dx * dx + dy * dy);
      const moving = clamp(speed / 200, 0, 1);
      const bob = Math.sin(t * 2.1 + it.phase) * ORB.bob * (1 - moving);
      it.group.place(x, y + bob);

      const stretch = Math.min(ORB.maxStretch, (speed / ORB.stretchSpeed) * ORB.maxStretch);
      const angle = speed > 1 ? Math.atan2(dy, dx) : 0;
      const k = o.collected ? collectT / ORB.collectTime : 0;
      const grow = 1 + (ORB.collectScale - 1) * smoothstep(0, 1, k);
      const fade = 1 - k * k;
      const pulse = 1 + 0.06 * Math.sin(t * 3.3 + it.phase * 2);
      const sx = this.coreScale * (1 + stretch) * grow * pulse;
      const sy = (this.coreScale / (1 + stretch)) * grow * pulse;
      it.core.rotation = angle;
      it.core.scale.set(sx, sy);
      it.core.alpha = fade;
      it.coreTwin.rotation = angle;
      it.coreTwin.scale.set(sx, sy);
      it.coreTwin.alpha = fade;
      it.halo.alpha = ORB.haloAlpha * fade * (0.9 + 0.1 * Math.sin(t * 1.7 + it.phase));
      it.glow.alpha = 0.55 * fade;

      const spin = t * 0.9 + it.phase;
      for (let s = 0; s < it.sparkles.length; s++) {
        const sp = it.sparkles[s] as Sprite;
        const a = spin + (s * Math.PI * 2) / it.sparkles.length;
        const r = ORB.sparkleRadius * grow * (1 + 0.12 * Math.sin(t * 1.3 + s));
        sp.position.set(Math.cos(a) * r - dx * 0.02 * s, Math.sin(a) * r * 0.62 - dy * 0.02 * s);
        const tw = Math.max(0, Math.sin(t * 2.6 + it.phase + s * 2.1));
        sp.alpha = tw * tw * 0.9 * fade;
        sp.rotation = a * 0.5;
      }
      if (stats) stats.fillScreens += quadFill(cam, 2 * ORB.haloRadius, 2 * ORB.haloRadius);
    }
  }
}
