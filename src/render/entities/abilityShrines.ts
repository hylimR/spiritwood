import type { RenderStats } from '../../contracts/debug.ts';
import type { AbilityShrineDef } from '../../contracts/level.ts';
import type { FrameInfo } from '../../contracts/render.ts';
import { SimEventType, type SimEvent } from '../../contracts/sim.ts';
import { PALETTE } from '../../config.ts';
import { mixHex } from '../../core/color.ts';
import { smoothstep } from '../../core/math.ts';
import { SHRINE_ART } from './abilityShrineArt.ts';
import {
  idPhase, imageSprite, InstanceGroup, nearView, PALPHA, POSE_STRIDE, PoseBuffer, PROT, PSX, PSY, PTINT, PX, PY, radialSprite,
  type EntityImage, type EntityLayers, type EntityRenderer, type EntityTextures,
} from './kit.ts';

export const ABILITY_SHRINE = Object.freeze({
  /** Light of the lantern-seed while the ability waits, and the ember left once it is taken. */
  litLevel: 1,
  spentLevel: 0.12,
  /** Unlock flare: peak brightness, then it settles to `spentLevel` over `flareTime` s. */
  flarePeak: 2.4,
  flareTime: 1.4,
  bob: 4,
  haloRadius: 92,
  sparkles: 3,
  sparkleRadius: 21,
  cullMargin: 160,
  lightTint: 0xd6fbff,
  glyphTint: PALETTE.spiritGlow,
  spentGlyphTint: 0x3a7c86,
});

interface ShrineState {
  def: AbilityShrineDef;
  group: InstanceGroup;
  /** First PoseBuffer slot (see the S_ offsets) and slot count. */
  first: number;
  count: number;
  level: number;
  unlockAt: number;
  phase: number;
  /** Quantised light (−1 = not yet set) and the tints it implies. */
  litK: number;
  seedTint: number;
  glyphTint: number;
}

/** PoseBuffer slots of a shrine, from its first. */
const S_HALO = 0;
/** Slot 1 is the pedestal (it never moves once placed). */
const S_SEED = 2;
const S_GLYPH = 3;
const S_LIGHT = 4;
const S_GLYPH_TWIN = 5;
const S_LIGHT_TWIN = 6;
const S_HALO_TWIN = 7;
const S_SPARKLES = 8;

/**
 * Ability shrines (§5.5): a mossy stone pedestal with a carved sprout glyph, holding a floating
 * lantern-seed (a tile above the pedestal's rim) whose light (and the glyph's) waits until the Spirit
 * Launch is taken. On AbilityUnlocked the seed flares and blooms, then dims to an ember for the rest of
 * the run (`launch.unlocked`). Joins the entity batches: back halo, body stone and husk, emissive light,
 * glow twins. World clock; only changed values reach Pixi (PoseBuffer, §6).
 */
export class AbilityShrineRenderer implements EntityRenderer {
  private readonly items: ShrineState[] = [];
  private readonly poses = new PoseBuffer();
  private readonly glowImg: EntityImage;
  private readonly seedScale: number;

  constructor(layers: EntityLayers, textures: EntityTextures, shrines: readonly AbilityShrineDef[]) {
    const pedestal = textures.get('shrinePedestal');
    const glyph = textures.get('shrineGlyph');
    const seed = textures.get('lanternSeed');
    const light = textures.get('lanternSeedLight');
    const glow = textures.get('glow');
    const sparkle = textures.get('sparkle');
    this.glowImg = glow;
    this.seedScale = 1 / seed.frame.density;
    const poses = this.poses;
    for (let i = 0; i < shrines.length; i++) {
      const group = new InstanceGroup(layers);
      const halo = radialSprite(glow, group.back, ABILITY_SHRINE.haloRadius, PALETTE.spiritGlow, 0);
      const pedestalSprite = imageSprite(pedestal, group.body);
      const seedSprite = imageSprite(seed, group.body);
      const glyphSprite = imageSprite(glyph, group.front, ABILITY_SHRINE.glyphTint, 0);
      const lightSprite = imageSprite(light, group.front, ABILITY_SHRINE.lightTint, 0);
      const glyphTwin = imageSprite(glyph, group.glow, ABILITY_SHRINE.glyphTint, 0);
      const lightTwin = imageSprite(light, group.glow, ABILITY_SHRINE.lightTint, 0);
      const haloTwin = radialSprite(glow, group.glow, 30, PALETTE.spiritGlow, 0);
      const first = poses.add(halo);
      poses.add(pedestalSprite);
      poses.add(seedSprite);
      poses.add(glyphSprite);
      poses.add(lightSprite);
      poses.add(glyphTwin);
      poses.add(lightTwin);
      poses.add(haloTwin);
      for (let k = 0; k < ABILITY_SHRINE.sparkles; k++) poses.add(radialSprite(sparkle, group.front, 6, 0xe8fdff, 0));
      this.items.push({
        def: shrines[i] as AbilityShrineDef, group, first, count: poses.size - first, level: ABILITY_SHRINE.litLevel, unlockAt: -1,
        phase: idPhase(i, 17), litK: -1, seedTint: 0xffffff, glyphTint: ABILITY_SHRINE.glyphTint,
      });
    }
  }

  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    if (e.type === SimEventType.AbilityUnlocked) {
      const it = this.items[e.id];
      if (it) it.unlockAt = frame.worldTime;
    } else if (e.type === SimEventType.Reset) {
      for (let i = 0; i < this.items.length; i++) (this.items[i] as ShrineState).unlockAt = -1;
    }
  }

  update(frame: FrameInfo, stats: RenderStats | null): void {
    if (this.items.length === 0) return;
    const cam = frame.camera;
    const unlocked = frame.sim.launch.unlocked;
    const t = frame.worldTime % 3600;
    const dt = frame.worldDt;
    const w = this.poses.want;
    let fill = 0;
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i] as ShrineState;
      const d = it.def;
      const x = d.x + d.w / 2;
      const y = d.y + d.h;
      // The flare after an unlock seen here; an unlock taken elsewhere just dims.
      const since = it.unlockAt >= 0 ? frame.worldTime - it.unlockAt : -1;
      const target = unlocked ? ABILITY_SHRINE.spentLevel : ABILITY_SHRINE.litLevel;
      if (unlocked && since >= 0 && since < ABILITY_SHRINE.flareTime) {
        // Flare to the peak in ≈ 0.2 s, then give the light away and settle to an ember.
        const k = since / ABILITY_SHRINE.flareTime;
        const bump = k < 0.3 ? Math.sin((Math.PI * k) / 0.3) : 0;
        it.level = 1 + (ABILITY_SHRINE.spentLevel - 1) * smoothstep(0.15, 1, k) + (ABILITY_SHRINE.flarePeak - 1) * bump * bump;
      } else if (it.level !== target) {
        const next = it.level + (target - it.level) * (1 - Math.exp(-(unlocked ? 2.5 : 4) * dt));
        it.level = Math.abs(target - next) < 1e-5 ? target : next;
      }
      const visible = nearView(cam, x, y + SHRINE_ART.seedY, 110, ABILITY_SHRINE.cullMargin);
      it.group.setVisible(visible);
      if (!visible) continue;
      it.group.place(x, y);

      const lvl = it.level;
      const lit = lvl < 1 ? lvl : 1;
      // Tints follow the light in eighths: they change (and allocate a Pixi Color) at most eight times.
      const litK = Math.round((lit < 0 ? 0 : lit) * 8) / 8;
      if (litK !== it.litK) {
        it.litK = litK;
        it.seedTint = mixHex(0x9fb3bb, 0xffffff, litK);
        it.glyphTint = mixHex(ABILITY_SHRINE.spentGlyphTint, ABILITY_SHRINE.glyphTint, litK);
      }
      const f = it.first;
      const bob = Math.sin(t * 1.3 + it.phase) * ABILITY_SHRINE.bob * (0.35 + 0.65 * lit);
      const sy = SHRINE_ART.seedY + bob;
      let o = (f + S_SEED) * POSE_STRIDE;
      w[o + PX] = 0;
      w[o + PY] = sy;
      w[o + PROT] = Math.sin(t * 0.9 + it.phase * 2) * 0.07;
      const breathe = this.seedScale * (1 + 0.03 * Math.sin(t * 2.1 + it.phase) * lit);
      w[o + PSX] = breathe;
      w[o + PSY] = breathe;
      w[o + PTINT] = it.seedTint;
      this.poses.copyTransform(f + S_SEED, f + S_LIGHT);
      this.poses.copyTransform(f + S_SEED, f + S_LIGHT_TWIN);
      const flick = 0.93 + 0.05 * Math.sin(t * 5.3 + it.phase) + 0.02 * Math.sin(t * 11.7);
      w[(f + S_LIGHT) * POSE_STRIDE + PALPHA] = lvl * flick < 1 ? lvl * flick : 1;
      w[(f + S_LIGHT_TWIN) * POSE_STRIDE + PALPHA] = lvl * 0.85 * flick < 1 ? lvl * 0.85 * flick : 1;
      const glyphAlpha = 0.25 + 0.65 * lvl < 1 ? 0.25 + 0.65 * lvl : 1;
      o = (f + S_GLYPH) * POSE_STRIDE;
      w[o + PALPHA] = glyphAlpha;
      w[o + PTINT] = it.glyphTint;
      o = (f + S_GLYPH_TWIN) * POSE_STRIDE;
      w[o + PALPHA] = glyphAlpha * 0.6 * lit;
      w[o + PTINT] = it.glyphTint;
      o = (f + S_HALO) * POSE_STRIDE;
      w[o + PX] = 0;
      w[o + PY] = sy;
      const haloScale = (2 * ABILITY_SHRINE.haloRadius * (0.8 + 0.2 * (lvl < 2 ? lvl : 2))) / this.glowImg.frame.w;
      w[o + PSX] = haloScale;
      w[o + PSY] = haloScale;
      w[o + PALPHA] = 0.2 * (lvl < 1.6 ? lvl : 1.6) * flick;
      o = (f + S_HALO_TWIN) * POSE_STRIDE;
      w[o + PX] = 0;
      w[o + PY] = sy;
      const twinScale = (2 * (26 + 22 * (lvl < 1.5 ? lvl : 1.5))) / this.glowImg.frame.w;
      w[o + PSX] = twinScale;
      w[o + PSY] = twinScale;
      w[o + PALPHA] = 0.45 * lvl < 1 ? 0.45 * lvl : 1;
      for (let k = 0; k < ABILITY_SHRINE.sparkles; k++) {
        const a = t * 0.8 + it.phase + (k * Math.PI * 2) / ABILITY_SHRINE.sparkles;
        const r = ABILITY_SHRINE.sparkleRadius * (1 + 0.15 * Math.sin(t * 1.7 + k));
        o = (f + S_SPARKLES + k) * POSE_STRIDE;
        w[o + PX] = Math.cos(a) * r;
        w[o + PY] = sy + Math.sin(a) * r * 0.45;
        const tw = Math.sin(t * 2.4 + it.phase + k * 2.1);
        w[o + PALPHA] = tw > 0 ? tw * tw * 0.85 * lit : 0;
        w[o + PROT] = a * 0.5;
      }
      this.poses.flush(f, it.count);
      fill += (w[(f + S_HALO) * POSE_STRIDE + PALPHA] as number) > 0 ? 4 * ABILITY_SHRINE.haloRadius * ABILITY_SHRINE.haloRadius + 48 * 110 : 48 * 110;
    }
    if (stats && fill > 0) stats.fillScreens += fill / Math.max(1, cam.width * cam.height);
  }
}
