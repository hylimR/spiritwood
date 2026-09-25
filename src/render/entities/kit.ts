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

/**
 * Draw layers, back to front: additive halos → normal bodies → seeds, trails and the launch marks
 * (normal blend, premultiplied with emissive texels; it continues the bodies' batch) → additive
 * emissives. Glow slot: normal-blend occluders (dark bodies that block the moss glow behind them) →
 * additive twins → seed and launch twins (continuing the twins' batch).
 */
export interface EntityLayers {
  back: Container;
  body: Container;
  seeds: Container;
  front: Container;
  occluders: Container;
  glow: Container;
  seedGlow: Container;
}

/** Build the layer containers in draw order under `root` (scene) and `glowRoot` (glow slot). */
export function createEntityLayers(root: Container, glowRoot: Container): EntityLayers {
  const layers: EntityLayers = {
    back: new Container({ label: 'entities-back' }),
    body: new Container({ label: 'entities-body' }),
    seeds: new Container({ label: 'entities-seeds' }),
    front: new Container({ label: 'entities-front' }),
    occluders: new Container({ label: 'entities-occluders' }),
    glow: new Container({ label: 'entities-twins' }),
    seedGlow: new Container({ label: 'entities-seed-twins' }),
  };
  layers.back.blendMode = 'add';
  layers.front.blendMode = 'add';
  layers.glow.blendMode = 'add';
  layers.seedGlow.blendMode = 'add';
  root.addChild(layers.back, layers.body, layers.seeds, layers.front);
  glowRoot.addChild(layers.occluders, layers.glow, layers.seedGlow);
  return layers;
}

/** One instance's containers in every layer (positioned together, culled together). */
export class InstanceGroup {
  readonly back = new Container();
  readonly body = new Container();
  readonly front = new Container();
  readonly glow = new Container();
  /** Glow-slot occluder copy of the body (only for instances created with `occluder`). */
  readonly occluder: Container | null;
  private shown = true;
  private px = Number.NaN;
  private py = Number.NaN;
  private psx = Number.NaN;
  private psy = Number.NaN;

  constructor(layers: EntityLayers, occluder = false) {
    layers.back.addChild(this.back);
    layers.body.addChild(this.body);
    layers.front.addChild(this.front);
    layers.glow.addChild(this.glow);
    this.occluder = occluder ? layers.occluders.addChild(new Container()) : null;
  }

  setVisible(v: boolean): void {
    if (v === this.shown) return;
    this.shown = v;
    this.back.visible = v;
    this.body.visible = v;
    this.front.visible = v;
    this.glow.visible = v;
    if (this.occluder) this.occluder.visible = v;
  }

  get visible(): boolean {
    return this.shown;
  }

  /** Move every layer's container; unchanged values are not written (§6). */
  place(x: number, y: number, sx = 1, sy = 1): void {
    if (x !== this.px || y !== this.py) {
      this.px = x;
      this.py = y;
      this.back.position.set(x, y);
      this.body.position.set(x, y);
      this.front.position.set(x, y);
      this.glow.position.set(x, y);
      if (this.occluder) this.occluder.position.set(x, y);
    }
    if (sx !== this.psx || sy !== this.psy) {
      this.psx = sx;
      this.psy = sy;
      this.back.scale.set(sx, sy);
      this.body.scale.set(sx, sy);
      this.front.scale.set(sx, sy);
      this.glow.scale.set(sx, sy);
      if (this.occluder) this.occluder.scale.set(sx, sy);
    }
  }
}

/** Channels of a PoseBuffer slot. */
export const PX = 0;
export const PY = 1;
export const PROT = 2;
export const PSX = 3;
export const PSY = 4;
export const PALPHA = 5;
export const PTINT = 6;
export const POSE_STRIDE = 7;

/**
 * Change-only writes for a view's pooled display objects (ARCHITECTURE.md §6). V8 boxes a non-integer
 * number handed to a Pixi setter, and an unchanged value must not be written at all. Views stage each
 * object's wanted pose in `want` (typed-array stores: no boxing) and `flush` passes Pixi only the
 * channels that differ from what it last applied, so a settled or parked object is never touched.
 */
export class PoseBuffer {
  /** Wanted pose per slot, POSE_STRIDE channels (PX … PTINT). Re-read after `add` (it may grow). */
  want = new Float64Array(0);
  private have = new Float64Array(0);
  private readonly nodes: Container[] = [];

  get size(): number {
    return this.nodes.length;
  }

  /** Register `node` (init time); its current pose becomes both wanted and applied. Returns its slot. */
  add(node: Container): number {
    const slot = this.nodes.length;
    const need = (slot + 1) * POSE_STRIDE;
    if (need > this.want.length) {
      const size = Math.max(need, this.want.length * 2, 16 * POSE_STRIDE);
      const w = new Float64Array(size);
      w.set(this.want);
      this.want = w;
      const h = new Float64Array(size);
      h.set(this.have);
      this.have = h;
    }
    this.nodes.push(node);
    const o = slot * POSE_STRIDE;
    const w = this.want;
    const h = this.have;
    w[o + PX] = h[o + PX] = node.position.x;
    w[o + PY] = h[o + PY] = node.position.y;
    w[o + PROT] = h[o + PROT] = node.rotation;
    w[o + PSX] = h[o + PSX] = node.scale.x;
    w[o + PSY] = h[o + PSY] = node.scale.y;
    w[o + PALPHA] = h[o + PALPHA] = node.alpha;
    w[o + PTINT] = h[o + PTINT] = node.tint;
    return slot;
  }

  /** Apply the channels of slots `first` … `first + count − 1` that changed since their last flush. */
  flush(first: number, count: number): void {
    const w = this.want;
    const h = this.have;
    const end = first + count;
    for (let s = first; s < end; s++) {
      const node = this.nodes[s] as Container;
      const o = s * POSE_STRIDE;
      const x = w[o] as number;
      const y = w[o + 1] as number;
      if (x !== h[o] || y !== h[o + 1]) {
        h[o] = x;
        h[o + 1] = y;
        node.position.set(x, y);
      }
      const rot = w[o + 2] as number;
      if (rot !== h[o + 2]) {
        h[o + 2] = rot;
        node.rotation = rot;
      }
      const sx = w[o + 3] as number;
      const sy = w[o + 4] as number;
      if (sx !== h[o + 3] || sy !== h[o + 4]) {
        h[o + 3] = sx;
        h[o + 4] = sy;
        node.scale.set(sx, sy);
      }
      const alpha = w[o + 5] as number;
      if (alpha !== h[o + 5]) {
        h[o + 5] = alpha;
        node.alpha = alpha;
      }
      const tint = w[o + 6] as number;
      if (tint !== h[o + 6]) {
        h[o + 6] = tint;
        node.tint = tint;
      }
    }
  }

  /** Stage slot `from`'s position, rotation and scale onto slot `to`. */
  copyTransform(from: number, to: number): void {
    const w = this.want;
    const a = from * POSE_STRIDE;
    const b = to * POSE_STRIDE;
    w[b] = w[a] as number;
    w[b + 1] = w[a + 1] as number;
    w[b + 2] = w[a + 2] as number;
    w[b + 3] = w[a + 3] as number;
    w[b + 4] = w[a + 4] as number;
  }

  /** Stage a parked pose for slot `s`: alpha 0 and zero area (no fill, never `visible`). */
  park(s: number): void {
    const o = s * POSE_STRIDE;
    this.want[o + PSX] = 0;
    this.want[o + PSY] = 0;
    this.want[o + PALPHA] = 0;
  }
}

/**
 * Write a tint only when it changes: Pixi's tint setter allocates on every write (Color normalisation),
 * even an unchanged one. Animated tints should also be quantised (see `tintStep`).
 */
export function setTint(c: Container, rgb: number): void {
  if (c.tint !== rgb) c.tint = rgb;
}

/** Quantise a 0..1 tint mix to eighths, so a fading tint changes at most eight times. */
export function tintStep(k: number): number {
  return Math.round((k < 0 ? 0 : k > 1 ? 1 : k) * 8) / 8;
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

/** Wrap an angle to (−π, π]. */
export function wrapPi(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

/** Framerate-independent damping toward a target angle along the shortest arc. */
export function dampAngle(a: number, target: number, lambda: number, dt: number): number {
  return a + wrapPi(target - a) * (1 - Math.exp(-lambda * dt));
}

/** Deterministic per-id phase in [0, 2π). */
export function idPhase(id: number, salt = 0): number {
  const h = Math.sin((id + 1) * 12.9898 + salt * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * Math.PI * 2;
}
