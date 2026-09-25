import { Container, type Texture } from 'pixi.js';
import type { FrameInfo, RenderContext, RenderView } from '../../contracts/render.ts';
import type { SimEvent } from '../../contracts/sim.ts';
import { estimateTextureBytes, textureFromRgba } from '../util/texture.ts';
import { AbilityShrineRenderer } from './abilityShrines.ts';
import { CrawlerRenderer } from './crawlers.ts';
import { buildEntityAtlas } from './entityAtlas.ts';
import { createEntityLayers, EntityTextures, type EntityRenderer } from './kit.ts';
import { LaunchRenderer } from './launch.ts';
import { OrbRenderer } from './orbs.ts';
import { SeedRenderer } from './seeds.ts';
import { ShrineRenderer } from './shrine.ts';
import { SpitterRenderer } from './spitters.ts';
import { StoneRenderer } from './stones.ts';

const TEXTURE_KEY = 'pipe:entity-atlas';

/**
 * Orbs, lumen stones, Gloomcrawlers, the Moonwell shrine and (M2) ability shrines, Thorn Spitters, their
 * seeds and the Spirit Launch marks, drawn from one procedurally generated premultiplied atlas into slot
 * `entities`: three batches (additive halos; normal-blend bodies continued by the seeds, trails and launch
 * marks; additive emissives). Glow slot `entities`: the spitters' dark occluders, then the additive twins
 * continued by the seed and launch twins. Owns the entity atlas.
 */
export class EntitiesView implements RenderView {
  readonly name = 'entities';

  private ctx: RenderContext | null = null;
  private readonly root = new Container({ label: 'entities' });
  private readonly glowRoot = new Container({ label: 'entities-glow' });
  private readonly renderers: EntityRenderer[] = [];
  private textures: EntityTextures | null = null;
  private base: Texture | null = null;
  /** The atlas images (tests read frames and pivots). */
  get images(): EntityTextures | null {
    return this.textures;
  }

  /** The M2 renderers (tests and the debug draw read them). */
  seeds: SeedRenderer | null = null;
  launch: LaunchRenderer | null = null;
  spitters: SpitterRenderer | null = null;

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    ctx.scene.entities.addChild(this.root);
    ctx.glow.entities.addChild(this.glowRoot);

    const atlas = buildEntityAtlas();
    this.base = textureFromRgba(atlas.pixels, atlas.width, atlas.height, {
      autoGenerateMipmaps: true, premultiply: !atlas.premultiplied, label: 'entity-atlas',
    });
    ctx.textures.set(TEXTURE_KEY, estimateTextureBytes(atlas.width, atlas.height, 4, true));
    const textures = (this.textures = new EntityTextures(atlas, this.base));

    const layers = createEntityLayers(this.root, this.glowRoot);
    const level = ctx.level;
    // Construction order is draw order inside each layer: props first, then creatures, orbs, seeds, marks.
    this.renderers.push(
      new StoneRenderer(layers, textures, level.checkpoints.length),
      new ShrineRenderer(layers, textures),
      new AbilityShrineRenderer(layers, textures, level.abilityShrines),
      new CrawlerRenderer(layers, textures, level.enemies),
    );
    this.spitters = new SpitterRenderer(layers, textures, level.enemies);
    this.renderers.push(this.spitters, new OrbRenderer(layers, textures, level.orbs.length));
    this.seeds = new SeedRenderer(layers, textures);
    this.launch = new LaunchRenderer(layers, textures);
    this.renderers.push(this.seeds, this.launch);
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
    this.seeds = null;
    this.launch = null;
    this.spitters = null;
    this.ctx = null;
  }
}
