import { Container, Graphics } from 'pixi.js';
import { TileKind } from '../contracts/level.ts';
import type { FrameInfo, RenderContext, RenderView } from '../contracts/render.ts';
import { tileAt } from '../core/tiles.ts';
import { hasOverlay } from '../render/post/context.ts';
import { applyParallax } from '../render/util/camera.ts';
import { DEFAULT_CAMERA_TUNING } from '../sim/tuning.ts';

const COLORS = Object.freeze({
  solid: 0x3fe0c5,
  oneWay: 0xffb45a,
  thorns: 0xff4d6d,
  player: 0xbff6ff,
  enemy: 0xff4d6d,
  stunned: 0x8a6d7a,
  orb: 0xffb45a,
  checkpoint: 0x3fe0c5,
  goal: 0xd8f3ff,
  deadZone: 0xffffff,
});
const LINE = 1.5;

/**
 * F4 collision / hitbox debug draw. Lives in the pipeline's overlay (drawn after the composite, so
 * grading, bloom and the death fade never touch it; falls back to slot `front` without one). Tiles are
 * tessellated once, on the first enable; hitboxes are redrawn each frame only while enabled.
 */
export class DebugDrawView implements RenderView {
  readonly name = 'debug-draw';

  private readonly root = new Container({ label: 'debug-draw' });
  private readonly tiles = new Graphics();
  private readonly boxes = new Graphics();
  private ctx: RenderContext | null = null;
  private enabled = false;
  private tilesBuilt = false;

  init(ctx: RenderContext): void {
    this.ctx = ctx;
    const parent = hasOverlay(ctx) ? ctx.overlay : ctx.scene.front;
    this.root.visible = false;
    this.root.addChild(this.tiles, this.boxes);
    parent.addChild(this.root);
  }

  onDebugDraw(enabled: boolean): void {
    this.enabled = enabled;
    this.root.visible = enabled;
    if (enabled && !this.tilesBuilt) this.buildTiles();
    if (!enabled) this.boxes.clear();
  }

  private buildTiles(): void {
    const level = this.ctx?.level;
    if (!level) return;
    this.tilesBuilt = true;
    const g = this.tiles;
    const T = level.tileSize;
    for (const kind of [TileKind.Solid, TileKind.Thorns, TileKind.OneWay]) {
      let any = false;
      for (let ty = 0; ty < level.heightTiles; ty++) {
        let tx = 0;
        while (tx < level.widthTiles) {
          if (tileAt(level, tx, ty) !== kind) {
            tx++;
            continue;
          }
          const start = tx;
          while (tx < level.widthTiles && tileAt(level, tx, ty) === kind) tx++;
          const h = kind === TileKind.OneWay ? T * 0.2 : T;
          g.rect(start * T, ty * T, (tx - start) * T, h);
          any = true;
        }
      }
      if (!any) continue;
      const color = kind === TileKind.Solid ? COLORS.solid : kind === TileKind.OneWay ? COLORS.oneWay : COLORS.thorns;
      g.fill({ color, alpha: kind === TileKind.Solid ? 0.14 : 0.3 }).stroke({ width: LINE, color, alpha: 0.55 });
    }
    g.rect(0, 0, level.pxWidth, level.pxHeight).stroke({ width: LINE * 2, color: COLORS.deadZone, alpha: 0.35 });
  }

  update(frame: FrameInfo): void {
    if (!this.enabled) return;
    applyParallax(this.root, frame.camera, 1, 1);
    const g = this.boxes;
    const sim = frame.sim;
    const a = frame.alpha;
    g.clear();

    const p = sim.player;
    const px = p.prevX + (p.x - p.prevX) * a;
    const py = p.prevY + (p.y - p.prevY) * a;
    g.rect(px - p.width / 2, py - p.height, p.width, p.height).stroke({ width: LINE, color: COLORS.player, alpha: p.alive ? 0.9 : 0.35 });
    g.circle(px, py, 2.5).fill({ color: COLORS.player, alpha: 0.9 });

    for (let i = 0; i < sim.enemies.length; i++) {
      const e = sim.enemies[i];
      if (!e) continue;
      const ex = e.prevX + (e.x - e.prevX) * a;
      const ey = e.prevY + (e.y - e.prevY) * a;
      const color = e.mode === 'stunned' ? COLORS.stunned : COLORS.enemy;
      g.rect(ex - e.width / 2, ey - e.height, e.width, e.height).stroke({ width: LINE, color, alpha: 0.9 });
    }
    for (let i = 0; i < sim.orbs.length; i++) {
      const o = sim.orbs[i];
      if (!o || o.collected) continue;
      g.circle(o.prevX + (o.x - o.prevX) * a, o.prevY + (o.y - o.prevY) * a, o.radius).stroke({ width: LINE, color: COLORS.orb, alpha: 0.8 });
    }
    for (let i = 0; i < sim.checkpoints.length; i++) {
      const c = sim.checkpoints[i];
      if (!c) continue;
      g.rect(c.x, c.y, c.w, c.h).stroke({ width: LINE, color: COLORS.checkpoint, alpha: c.active ? 1 : 0.5 });
    }
    const goal = sim.goal;
    if (goal) g.rect(goal.x, goal.y, goal.w, goal.h).stroke({ width: LINE, color: COLORS.goal, alpha: goal.reached ? 1 : 0.6 });

    const cam = frame.camera;
    const dzW = DEFAULT_CAMERA_TUNING.deadZoneW / cam.zoom;
    const dzH = DEFAULT_CAMERA_TUNING.deadZoneH / cam.zoom;
    g.rect(cam.cx - dzW / 2, cam.cy - dzH / 2, dzW, dzH).stroke({ width: LINE, color: COLORS.deadZone, alpha: 0.4 });
  }

  destroy(): void {
    this.root.destroy({ children: true });
    this.ctx = null;
  }
}
