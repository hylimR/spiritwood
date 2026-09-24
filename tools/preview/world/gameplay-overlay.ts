import { Container, Rectangle, Texture, type ParticleContainer } from 'pixi.js';
import type { RenderStats } from '../../../src/contracts/debug.ts';
import { GLOW_SLOTS, SCENE_SLOTS, type FrameInfo, type GlowSlots, type RenderContext, type SceneSlots } from '../../../src/contracts/render.ts';
import { hexToRgb } from '../../../src/core/color.ts';
import { DECOR_GLOW, DECOR_SHADE } from '../../../src/render/fx/decor.ts';
import { placeDecor, type DecorInstance } from '../../../src/render/fx/decorPlacement.ts';
import { ParticlesView } from '../../../src/render/fx/particles.ts';
import type { Mote } from '../../../src/render/fx/particlePool.ts';
import { shaftTrapezoid } from '../../../src/render/fx/shaftGeometry.ts';
import { shadeShaft, SHAFT_COLOR } from '../../../src/render/fx/shaftShading.ts';
import { generateParticleAtlas, PARTICLE_FRAMES, type FrameRect, type ParticleFrame } from '../../../src/render/gen/particleAtlas.ts';
import { buildChunks } from '../../../src/render/layers/kitMesh.ts';
import type { KitInstance } from '../../../src/render/layers/placement.ts';
import { computeCameraFrame, createCameraFrame } from '../../../src/render/util/camera.ts';
import { SimpleTextureBudget } from '../../../src/render/util/texture.ts';
import { QUALITY_PRESETS } from '../../../src/settings/quality.ts';
import { createFakeSimView } from '../../../tests/shared/fixtures.ts';
import { drawKitChunks, type Frame, type Scene } from './compose.ts';
import { vnoise } from './glslNoise.ts';
import { rasterTri } from './terrain-overlay.ts';

/** Light shafts: additive trapezoids shaded with the shader's CPU mirror. */
export function shaftsOverlay(scene: Scene): (img: Frame) => void {
  const traps = scene.level.lightShafts.map(shaftTrapezoid);
  return (img) => {
    traps.forEach((t, s) => {
      const seed = s * 7.31 + 1.7;
      const a = img.toPx(t.topX, t.y0);
      const b = img.toPx(t.topX + t.topW, t.y0);
      const c = img.toPx(t.botX + t.botW, t.y1);
      const d = img.toPx(t.botX, t.y1);
      const shade = (i: number): void => {
        const px = img.worldX(i % img.w);
        const py = img.worldY(Math.floor(i / img.w));
        const v = (py - t.y0) / (t.y1 - t.y0);
        const left = t.topX + (t.botX - t.topX) * v;
        const w = t.topW + (t.botW - t.topW) * v;
        const k = shadeShaft((px - left) / w, v, seed, t.intensity, img.time, vnoise);
        img.add(i, SHAFT_COLOR[0] * k, SHAFT_COLOR[1] * k, SHAFT_COLOR[2] * k);
      };
      rasterTri(img, a[0], a[1], b[0], b[1], c[0], c[1], shade);
      rasterTri(img, a[0], a[1], c[0], c[1], d[0], d[1], shade);
    });
  };
}

/** Particle atlas frames as a CPU sampler (alpha × luminance). */
class ParticleSampler {
  readonly atlas = generateParticleAtlas();
  readonly textures = new Map<Texture, FrameRect>();
  readonly frames = {} as Record<ParticleFrame, Texture>;

  constructor() {
    for (const name of PARTICLE_FRAMES) {
      const r = this.atlas.frames[name];
      const t = new Texture({ frame: new Rectangle(0, 0, r.w, r.h), label: name });
      this.frames[name] = t;
      this.textures.set(t, r);
    }
  }

  /** Straight (lum, alpha) at frame-local texel coords. */
  sample(r: FrameRect, u: number, v: number): [number, number] {
    const fx = u - 0.5;
    const fy = v - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    let lum = 0;
    let al = 0;
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 2; i++) {
        const x = Math.min(r.w - 1, Math.max(0, x0 + i));
        const y = Math.min(r.h - 1, Math.max(0, y0 + j));
        const w = (i ? fx - x0 : 1 - (fx - x0)) * (j ? fy - y0 : 1 - (fy - y0));
        const o = ((r.y + y) * this.atlas.width + r.x + x) * 4;
        const a = ((this.atlas.pixels[o + 3] as number) / 255) * w;
        lum += ((this.atlas.pixels[o] as number) / 255) * a;
        al += a;
      }
    }
    return [al > 0 ? lum / al : 0, al];
  }
}

const sampler = new ParticleSampler();

/** Splat a textured, tinted, rotated quad centred at world (x, y) of world size (w, h). */
function splat(
  img: Frame, frame: FrameRect, x: number, y: number, sx: number, sy: number, rot: number, rgb: readonly number[], alpha: number,
  additive: boolean, glow: number,
): void {
  const w = frame.w * Math.abs(sx);
  const h = frame.h * Math.abs(sy);
  if (w <= 0 || h <= 0 || alpha <= 0) return;
  const [cx, cy] = img.toPx(x, y);
  const rad = Math.hypot(w, h) / 2 / img.scale + 1;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  for (let py = Math.max(0, Math.floor(cy - rad)); py < Math.min(img.h, Math.ceil(cy + rad)); py++) {
    for (let px = Math.max(0, Math.floor(cx - rad)); px < Math.min(img.w, Math.ceil(cx + rad)); px++) {
      const dx = (px + 0.5 - cx) * img.scale;
      const dy = (py + 0.5 - cy) * img.scale;
      const lx = (dx * cos + dy * sin) / w + 0.5;
      const ly = (-dx * sin + dy * cos) / h + 0.5;
      if (lx < 0 || ly < 0 || lx >= 1 || ly >= 1) continue;
      const [lum, a] = sampler.sample(frame, lx * frame.w, ly * frame.h);
      const k = a * alpha;
      if (k <= 0) continue;
      const i = py * img.w + px;
      const r = (rgb[0] as number) * lum * k;
      const g = (rgb[1] as number) * lum * k;
      const b = (rgb[2] as number) * lum * k;
      if (additive) img.add(i, r, g, b);
      else img.blend(i, r, g, b, k);
      if (glow > 0) img.addGlow(i, r * glow, g * glow, b * glow);
    }
  }
}

/** Decor back + front with their glow twins and light pools (the hero would sit between them). */
export function decorOverlay(scene: Scene): { back: (img: Frame) => void; front: (img: Frame) => void; count: number } {
  const placement = placeDecor(scene.level, scene.kit);
  const build = (list: DecorInstance[], emissiveOnly = false) => buildChunks(list, {
    split: false, depthF: null, glow: (i: KitInstance) => (i as DecorInstance).glow, chunkWidth: 1536, originX: -768, swayAmp: 0,
    atlasW: scene.kit.width, atlasH: scene.kit.height, emissiveOnly,
  });
  const back = build(placement.back);
  const front = build(placement.front);
  const glow = build([...placement.back, ...placement.front], true);
  const glowShade = { ...DECOR_SHADE, glow: DECOR_GLOW };
  const dot = sampler.atlas.frames.dot;
  return {
    back: (img) => {
      drawKitChunks(img, scene, back, DECOR_SHADE, 1, 1, false);
      drawKitChunks(img, scene, glow, glowShade, 1, 1, false, { glowOnly: true });
    },
    front: (img) => {
      drawKitChunks(img, scene, front, DECOR_SHADE, 1, 1, false);
      for (const h of placement.halos) {
        const s = (h.radius * 2) / dot.w;
        splat(img, dot, h.x, h.y, s, s, 0, hexToRgb(h.color), h.alpha, true, 0);
      }
    },
    count: placement.back.length + placement.front.length,
  };
}

/** The real ParticlesView (ambient motes, fireflies, shaft dust, leaves) stepped at each preview camera. */
export function particlesOverlay(scene: Scene, seconds = 6): (img: Frame) => void {
  return (img) => {
    const level = scene.level;
    const sceneSlots = Object.fromEntries(SCENE_SLOTS.map((s) => [s, new Container()])) as SceneSlots;
    const glowSlots = Object.fromEntries(GLOW_SLOTS.map((s) => [s, new Container()])) as GlowSlots;
    const stats: RenderStats = {
      drawCalls: 0, fillScreens: 0, rtWidth: 0, rtHeight: 0, renderScale: 1, canvasWidth: 1920, canvasHeight: 1080, particles: 0, textureMB: 0, gpuMs: -1,
    };
    const ctx = {
      renderer: null, scene: sceneSlots, glow: glowSlots, level, manifest: scene.manifest, manifestUrl: 'preview://', quality: { ...QUALITY_PRESETS.high },
      textures: new SimpleTextureBudget(1e9), stats,
    } as unknown as RenderContext;
    const view = new ParticlesView(null as never);
    view.build(ctx, sampler.frames);
    const sim = createFakeSimView(level, img.viewW, img.viewH);
    sim.camera.x = sim.camera.prevX = img.cam.cx;
    sim.camera.y = sim.camera.prevY = img.cam.cy;
    sim.player.visible = false;
    const frame: FrameInfo = {
      time: img.time, dt: 1 / 30, worldTime: img.time, worldDt: 1 / 30, timeScale: 1, alpha: 1, frame: 0,
      camera: computeCameraFrame(createCameraFrame(), sim.camera, 1), sim, quality: ctx.quality,
      renderScale: 1, pxPerUnit: 1,
    };
    for (let i = 0; i < seconds * 30; i++) {
      frame.time += frame.dt;
      frame.frame++;
      view.update(frame);
    }
    for (const pc of sceneSlots.particles.children[0]?.children ?? []) {
      const c = pc as ParticleContainer;
      const additive = c.blendMode === 'add';
      for (const p of c.particleChildren as Mote[]) {
        if (p.scaleX === 0 || p.color >>> 24 === 0) continue;
        const r = sampler.textures.get(p.texture);
        if (!r) continue;
        const a = (p.color >>> 24) / 255;
        const rgb = [(p.color & 255) / 255, ((p.color >> 8) & 255) / 255, ((p.color >> 16) & 255) / 255];
        const isAmbient = additive && p.kind <= 3;
        splat(img, r, p.x, p.y, p.scaleX, p.scaleY, p.rotation, rgb, a, additive, isAmbient ? 0.75 : 0);
      }
    }
  };
}
