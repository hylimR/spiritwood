import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import type { RenderStats } from '../../contracts/debug.ts';
import type { CameraFrame, FrameInfo } from '../../contracts/render.ts';
import type { SimEvent } from '../../contracts/sim.ts';
import type { Atlas, AtlasFrame } from '../hero/atlas.ts';

/**
 * Shared plumbing for the entity renderers: the atlas' sub-textures, the four draw layers and
 * per-instance layer groups that are shown/hidden only when an instance enters or leaves the view.
 */

export interface EntityImage {
  tex: Texture;
  frame: AtlasFrame;
}

export class EntityTextures {
  private readonly map = new Map<string, EntityImage>();
  private readonly atlas: Atlas;
  private readonly base: Texture;

  constructor(atlas: Atlas, base: Texture) {
    this.atlas = atlas;
    this.base = base;
  }

  get(name: string): EntityImage {
    let img = this.map.get(name);
    if (!img) {
      const f = this.atlas.frames[name];
      if (!f) throw new Error(`Entity atlas has no frame ${name}`);
      img = { frame: f, tex: new Texture({ source: this.base.source, frame: new Rectangle(f.x, f.y, f.w, f.h), label: `entity:${name}` }) };
      this.map.set(name, img);
    }
    return img;
  }

  destroy(): void {
    for (const img of this.map.values()) img.tex.destroy(false);
    this.map.clear();
  }
}

/** Draw layers, back to front: additive halos → normal bodies → additive emissives; plus the glow twin layer. */
export interface EntityLayers {
  back: Container;
  body: Container;
  front: Container;
  glow: Container;
}

/** One instance's containers in every layer (positioned together, culled together). */
export class InstanceGroup {
  readonly back = new Container();
  readonly body = new Container();
  readonly front = new Container();
  readonly glow = new Container();
  private shown = true;

  constructor(layers: EntityLayers) {
    layers.back.addChild(this.back);
    layers.body.addChild(this.body);
    layers.front.addChild(this.front);
    layers.glow.addChild(this.glow);
  }

  setVisible(v: boolean): void {
    if (v === this.shown) return;
    this.shown = v;
    this.back.visible = v;
    this.body.visible = v;
    this.front.visible = v;
    this.glow.visible = v;
  }

  get visible(): boolean {
    return this.shown;
  }

  place(x: number, y: number, sx = 1, sy = 1): void {
    this.back.position.set(x, y);
    this.body.position.set(x, y);
    this.front.position.set(x, y);
    this.glow.position.set(x, y);
    this.back.scale.set(sx, sy);
    this.body.scale.set(sx, sy);
    this.front.scale.set(sx, sy);
    this.glow.scale.set(sx, sy);
  }
}

/** Sprite anchored at the image pivot, scaled so 1 unit = 1 world unit. */
export function imageSprite(img: EntityImage, parent: Container, tint = 0xffffff, alpha = 1): Sprite {
  const s = new Sprite({ texture: img.tex, anchor: { x: img.frame.pivotX / img.frame.w, y: img.frame.pivotY / img.frame.h } });
  s.scale.set(1 / img.frame.density);
  s.tint = tint;
  s.alpha = alpha;
  parent.addChild(s);
  return s;
}

/** Centred radial sprite (glow, ring, wisp) sized by radius in world units. */
export function radialSprite(img: EntityImage, parent: Container, radius: number, tint = 0xffffff, alpha = 1): Sprite {
  const s = new Sprite({ texture: img.tex, anchor: 0.5 });
  setRadius(s, img, radius);
  s.tint = tint;
  s.alpha = alpha;
  parent.addChild(s);
  return s;
}

export function setRadius(s: Sprite, img: EntityImage, radius: number): void {
  s.scale.set((2 * radius) / img.frame.w);
}

/** True when a circle of `radius` around (x, y) is within `margin` of the visible world rect. */
export function nearView(cam: CameraFrame, x: number, y: number, radius: number, margin: number): boolean {
  const r = radius + margin;
  return x + r >= cam.left && x - r <= cam.left + cam.width && y + r >= cam.top && y - r <= cam.top + cam.height;
}

/** Fill (in full-screen equivalents) of a `w × h` world-unit quad for the stats. */
export function quadFill(cam: CameraFrame, w: number, h: number): number {
  return (w * h) / (cam.width * cam.height);
}

export interface EntityRenderer {
  update(frame: FrameInfo, stats: RenderStats | null): void;
  onSimEvent?(e: SimEvent, frame: FrameInfo): void;
}

/** Deterministic per-id phase in [0, 2π). */
export function idPhase(id: number, salt = 0): number {
  const h = Math.sin((id + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * Math.PI * 2;
}
