import type { Sprite } from 'pixi.js';
import type { RenderStats } from '../../contracts/debug.ts';
import type { FrameInfo } from '../../contracts/render.ts';
import { SimEventType, type CheckpointView, type SimEvent } from '../../contracts/sim.ts';
import { PALETTE } from '../../config.ts';
import { mixHex } from '../../core/color.ts';
import { clamp, smoothstep } from '../../core/math.ts';
import { STONE_RUNE_Y } from './entityAtlas.ts';
import {
  idPhase, imageSprite, InstanceGroup, nearView, quadFill, radialSprite, setTint, tintStep, type EntityLayers, type EntityRenderer,
  type EntityTextures,
} from './kit.ts';

export const STONE = Object.freeze({
  dormantTint: 0x1e6f73,
  litTint: 0x5fe8d6,
  activeTint: 0xb8fff2,
  dormantAlpha: 0.5,
  /** Ever-activated, but not the current respawn point. */
  restAlpha: 0.62,
  flareTime: 0.35,
  beamRise: 0.4,
  beamFade: 1.3,
  beamHeight: 230,
  beamWidth: 30,
  haloRadius: 70,
  cullMargin: 160,
});

interface StoneSprites {
  group: InstanceGroup;
  stone: Sprite;
  rune: Sprite;
  runeTwin: Sprite;
  beam: Sprite;
  beamTwin: Sprite;
  halo: Sprite;
  phase: number;
}

/**
 * Lumen stones (checkpoints): a moss-covered standing stone with a carved spiral rune. Dormant runes
 * glow a dim teal; activation flares the rune, raises a brief column of light, then settles into a
 * slow pulse while the stone is the current respawn point. World clock: the flare is anchored to the
 * worldTime of the activation (its CheckpointActivated event, or the first frame that sees it).
 */
export class StoneRenderer implements EntityRenderer {
  private readonly items: StoneSprites[] = [];
  /** worldTime of each stone's latest activation (−1 = never) and the activatedTick it belongs to. */
  private readonly activatedAt: Float64Array;
  private readonly seenTick: Float64Array;
  private readonly runeScale: number;
  private readonly beamScaleX: number;
  private readonly beamScaleY: number;

  constructor(layers: EntityLayers, textures: EntityTextures, count: number) {
    const stone = textures.get('lumenStone');
    const rune = textures.get('rune');
    const beam = textures.get('beam');
    const glow = textures.get('glow');
    this.runeScale = 1 / rune.frame.density;
    this.beamScaleX = STONE.beamWidth / beam.frame.w;
    this.beamScaleY = STONE.beamHeight / beam.frame.h;
    this.activatedAt = new Float64Array(count).fill(-1);
    this.seenTick = new Float64Array(count).fill(-1);
    for (let i = 0; i < count; i++) {
      const group = new InstanceGroup(layers);
      const it: StoneSprites = {
        group,
        halo: radialSprite(glow, group.back, STONE.haloRadius, PALETTE.floraGlow, 0),
        beam: imageSprite(beam, group.back, STONE.activeTint, 0),
        stone: imageSprite(stone, group.body),
        rune: imageSprite(rune, group.front, STONE.dormantTint, STONE.dormantAlpha),
        runeTwin: imageSprite(rune, group.glow, STONE.dormantTint, 0.3),
        beamTwin: imageSprite(beam, group.glow, STONE.activeTint, 0),
        phase: idPhase(i, 3),
      };
      it.rune.position.set(0, STONE_RUNE_Y);
      it.runeTwin.position.set(0, STONE_RUNE_Y);
      it.halo.position.set(0, STONE_RUNE_Y);
      it.beam.position.set(0, -12);
      it.beamTwin.position.set(0, -12);
      this.items.push(it);
    }
  }

  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    if (e.type !== SimEventType.CheckpointActivated || e.id < 0 || e.id >= this.activatedAt.length) return;
    const c = frame.sim.checkpoints[e.id];
    this.activatedAt[e.id] = frame.worldTime;
    if (c) this.seenTick[e.id] = c.activatedTick;
  }

  update(frame: FrameInfo, stats: RenderStats | null): void {
    const cps = frame.sim.checkpoints;
    const cam = frame.camera;
    const t = frame.worldTime % 3600;
    for (let i = 0; i < this.items.length && i < cps.length; i++) {
      const it = this.items[i] as StoneSprites;
      const c = cps[i] as CheckpointView;
      if (c.activatedTick !== this.seenTick[i]) {
        this.seenTick[i] = c.activatedTick;
        this.activatedAt[i] = c.activatedTick >= 0 ? frame.worldTime : -1;
      }
      const x = c.x + c.w / 2;
      const y = c.y + c.h;
      const visible = nearView(cam, x, y - STONE.beamHeight / 2, STONE.beamHeight / 2, STONE.cullMargin);
      it.group.setVisible(visible);
      if (!visible) continue;
      it.group.place(x, y);

      const ever = c.activatedTick >= 0;
      const at = this.activatedAt[i] as number;
      const since = ever && at >= 0 ? frame.worldTime - at : Infinity;

      let runeAlpha: number;
      let runeTint: number;
      let runeScale = this.runeScale;
      let beamAlpha = 0;
      let beamGrow = 0;
      let haloAlpha = 0;
      if (c.active) {
        const flare = Math.exp(-Math.max(0, since) / STONE.flareTime);
        const pulse = 0.78 + 0.22 * Math.sin(t * 2.2 + it.phase);
        runeAlpha = Math.min(1, pulse + flare);
        runeTint = mixHex(STONE.litTint, STONE.activeTint, tintStep(clamp(flare * 1.5, 0, 1)));
        runeScale *= 1 + 0.3 * flare;
        beamGrow = 1 - Math.pow(1 - clamp(since / STONE.beamRise, 0, 1), 3);
        beamAlpha = since < STONE.beamRise ? 0.8 : 0.8 * Math.max(0, 1 - (since - STONE.beamRise) / STONE.beamFade);
        haloAlpha = 0.16 * pulse + 0.35 * flare;
      } else if (ever) {
        runeAlpha = STONE.restAlpha * (0.9 + 0.1 * Math.sin(t * 0.9 + it.phase));
        runeTint = mixHex(STONE.dormantTint, STONE.litTint, 0.45);
        haloAlpha = 0.05;
      } else {
        runeAlpha = STONE.dormantAlpha * (0.85 + 0.15 * smoothstep(-1, 1, Math.sin(t * 0.7 + it.phase)));
        runeTint = STONE.dormantTint;
      }
      it.rune.alpha = runeAlpha;
      setTint(it.rune, runeTint);
      it.rune.scale.set(runeScale);
      it.runeTwin.alpha = runeAlpha * (c.active ? 0.9 : 0.35);
      setTint(it.runeTwin, runeTint);
      it.runeTwin.scale.set(runeScale);
      it.halo.alpha = haloAlpha;
      it.beam.alpha = beamAlpha;
      it.beam.scale.set(this.beamScaleX * (1 + 0.4 * (1 - beamGrow)), this.beamScaleY * beamGrow);
      it.beamTwin.alpha = beamAlpha * 0.8;
      it.beamTwin.scale.copyFrom(it.beam.scale);
      if (stats) stats.fillScreens += quadFill(cam, 48, 80) + (beamAlpha > 0 ? quadFill(cam, STONE.beamWidth, STONE.beamHeight) : 0);
    }
  }
}
