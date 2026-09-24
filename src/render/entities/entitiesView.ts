import { Container, type Texture } from 'pixi.js';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import type { SimEvent } from '../../contracts/sim.ts';
import { estimateTextureBytes, textureFromRgba } from '../util/texture.ts';
import { CrawlerRenderer } from './crawlers.ts';
import { buildEntityAtlas } from './entityAtlas.ts';
import { EntityTextures, type EntityLayers, type EntityRenderer } from './kit.ts';
import { OrbRenderer } from './orbs.ts';
import { ShrineRenderer } from './shrine.ts';
import { StoneRenderer } from './stones.ts';

const TEXTURE_KEY = 'pipe:entity-atlas';

/**
 * Orbs, lumen stones, Gloomcrawlers and the Moonwell shrine, drawn from one procedurally generated
 * atlas into slot `entities` (three batches: additive halos, normal bodies, additive emissives) with
 * bloom twins in glow slot `entities`. Owns the entity atlas.
 */
export class EntitiesView implements RenderView {
  readonly name = 'entities';

  private ctx: RenderContext | null = null;
  private readonly root = new Container({ label: 'entities' });
  private readonly glowRoot = new Container({ label: 'entities-glow' });
  private readonly renderers: EntityRenderer[] = [];
  private textures: EntityTextures | null = null;
  private base: Texture | null = null;

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.scene.entities.addChild(this.root);
    ctx.glow.entities.addChild(this.glowRoot);

    const atlas = buildEntityAtlas();
    this.base = textureFromRgba(atlas.pixels, atlas.width, atlas.height, { autoGenerateMipmaps: true, label: 'entity-atlas' });
    ctx.textures.set(TEXTURE_KEY, estimateTextureBytes(atlas.width, atlas.height, 4, true));
    const textures = (this.textures = new EntityTextures(atlas, this.base));

    const layers: EntityLayers = {
      back: new Container({ label: 'entities-back' }),
      body: new Container({ label: 'entities-body' }),
      front: new Container({ label: 'entities-front' }),
      glow: new Container({ label: 'entities-twins' }),
    };
    layers.back.blendMode = 'add';
    layers.front.blendMode = 'add';
    layers.glow.blendMode = 'add';
    this.root.addChild(layers.back, layers.body, layers.front);
    this.glowRoot.addChild(layers.glow);

    const level = ctx.level;
    this.renderers.push(
      new StoneRenderer(layers, textures, level.checkpoints.length),
      new ShrineRenderer(layers, textures),
      new CrawlerRenderer(layers, textures, level.enemies.length),
      new OrbRenderer(layers, textures, level.orbs.length),
    );
  }

  onSimEvent(e: SimEvent, frame: FrameInfo): void {
    for (let i = 0; i < this.renderers.length; i++) this.renderers[i]?.onSimEvent?.(e, frame);
  }

  update(frame: FrameInfo): void {
    const stats = this.ctx ? this.ctx.stats : null;
    for (let i = 0; i < this.renderers.length; i++) (this.renderers[i] as EntityRenderer).update(frame, stats);
  }

  destroy(): void {
    this.ctx?.textures.remove(TEXTURE_KEY);
    this.root.destroy({ children: true });
    this.glowRoot.destroy({ children: true });
    this.textures?.destroy();
    this.base?.destroy(true);
    this.base = null;
    this.textures = null;
    this.renderers.length = 0;
    this.ctx = null;
  }
}
