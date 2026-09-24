/**
 * Paint-over templates (ARCHITECTURE.md §5.8, `npm run art:export`): each procedural layer of an area,
 * rendered by the CPU layer renderers of tools/preview/world/ into its own layer space at plate
 * resolution (1 px = one plate texel), with guides: the gameplay terrain silhouette and the camera frames
 * at 16:9, 4:3 and 21:9 for the area's reference camera, the camera sweep across the area, the moon, a
 * hero-sized marker and the parallax factor. A sidecar stub per template registers a painting made on
 * its canvas.
 */
import { MAX_ASPECT, MAX_LAYER_PARALLAX, MIN_ASPECT, MIN_LAYER_PARALLAX_GAP, PALETTE, TILE, VIEW_H } from '../../src/config.ts';
import type { KitLayerDef, LayerDef, LayerManifest, SkyLayerDef } from '../../src/contracts/assets.ts';
import { AREA_GRADES, TileKind, type AreaGradeId, type LevelData } from '../../src/contracts/level.ts';
import { tileAt } from '../../src/core/tiles.ts';
import type { KitAtlasData } from '../../src/render/gen/kit.ts';
import { clearingHints, prepareKitLayer, type PreparedKitLayer } from '../../src/render/layers/layerModel.ts';
import { DEFAULT_CAMERA_TUNING } from '../../src/sim/tuning.ts';
import { encodePng } from '../preview/png.ts';
import { buildScene, drawKitChunks, Frame, type Camera, type Scene } from '../preview/world/compose.ts';
import { drawText, GLYPH_H } from './font.ts';
import { formatJson } from './json.ts';

export interface TemplateArea {
  /** Directory name: an area grade id, or `x<x0>-<x1>`. */
  id: string;
  /** World x range the camera explores. */
  x0: number;
  x1: number;
  grade: AreaGradeId | null;
}

/** `glade` (an AreaGradeId: the union of its grade zones) or `x0,x1` (world units). */
export function resolveArea(level: LevelData, arg: string): TemplateArea {
  if ((AREA_GRADES as readonly string[]).includes(arg)) {
    const zones = level.gradeZones.filter((z) => z.grade === arg);
    if (zones.length === 0) throw new Error(`area "${arg}": the level has no ${arg} grade zone`);
    return { id: arg, x0: Math.min(...zones.map((z) => z.x)), x1: Math.max(...zones.map((z) => z.x + z.w)), grade: arg as AreaGradeId };
  }
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(arg);
  if (!m) throw new Error(`area "${arg}": expected one of ${AREA_GRADES.join(', ')} or "x0,x1" in world units`);
  const x0 = Number(m[1]);
  const x1 = Number(m[2]);
  if (!(x1 > x0)) throw new Error(`area "${arg}": x1 must be greater than x0`);
  return { id: `x${x0}-${x1}`, x0, x1, grade: null };
}

/** Camera centre clamped to the level along one axis (the sim clamps the same way). */
function clampCentre(v: number, half: number, size: number): number {
  return size <= 2 * half ? size / 2 : Math.min(size - half, Math.max(half, v));
}

export interface ReferenceCamera {
  cx: number;
  cy: number;
  /** Feet of a hero standing where the camera frames. */
  feet: [number, number];
}

/**
 * The area's reference camera: centred on the area in x at 16:9, framing the player's height the way
 * the sim camera does (feet + targetOffsetY) at the area's nearest spawn, checkpoint or orb.
 */
export function referenceCamera(level: LevelData, area: TemplateArea): ReferenceCamera {
  const mid = (area.x0 + area.x1) / 2;
  const spots: [number, number][] = [[level.playerStart.x, level.playerStart.y]];
  for (const c of level.checkpoints) spots.push([c.x + c.w / 2, c.y + c.h]);
  for (const o of level.orbs) spots.push([o.x, o.y + 40]);
  let best = spots[0] as [number, number];
  for (const s of spots) if (Math.abs(s[0] - mid) < Math.abs(best[0] - mid)) best = s;
  const cx = clampCentre(mid, (VIEW_H * 16) / 9 / 2, level.pxWidth);
  const cy = clampCentre(best[1] + DEFAULT_CAMERA_TUNING.targetOffsetY, VIEW_H / 2, level.pxHeight);
  return { cx, cy, feet: [Math.min(area.x1, Math.max(area.x0, best[0])), best[1]] };
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Layer-space region visible from any camera inside the area, at any supported aspect (zoom 1). */
export function areaExtent(level: LevelData, area: TemplateArea, fx: number, fy: number): Rect {
  const r: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  for (const a of [MIN_ASPECT, 16 / 9, MAX_ASPECT]) {
    const hw = (VIEW_H * a) / 2;
    const lo = clampCentre(area.x0, hw, level.pxWidth);
    const hi = clampCentre(area.x1, hw, level.pxWidth);
    r.x0 = Math.min(r.x0, lo * fx - hw);
    r.x1 = Math.max(r.x1, hi * fx + hw);
  }
  const hh = VIEW_H / 2;
  r.y0 = clampCentre(0, hh, level.pxHeight) * fy - hh;
  r.y1 = clampCentre(level.pxHeight, hh, level.pxHeight) * fy + hh;
  return r;
}

/** A compose.ts frame that also tracks coverage, so a layer renders to straight RGBA with alpha. */
class AlphaFrame extends Frame {
  readonly alpha: Float32Array;

  constructor(w: number, h: number, viewW: number, viewH: number, cam: Camera) {
    super(w, h, viewW, viewH, cam, 0);
    this.alpha = new Float32Array(w * h);
  }

  override blend(i: number, r: number, g: number, b: number, a: number): void {
    super.blend(i, r, g, b, a);
    this.alpha[i] = a + (this.alpha[i] as number) * (1 - a);
  }

  /** Straight RGBA8. */
  rgba(): Uint8Array {
    const out = new Uint8Array(this.w * this.h * 4);
    for (let i = 0; i < this.w * this.h; i++) {
      const a = this.alpha[i] as number;
      if (a <= 0) continue;
      for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(((this.rgb[i * 3 + c] as number) / a) * 255)));
      out[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
    }
    return out;
  }
}

export interface Canvas {
  /** Layer-space top-left (world units). */
  origin: [number, number];
  w: number;
  h: number;
  /** World units per pixel. */
  scale: number;
}

function canvasFor(r: Rect, scale: number): Canvas {
  const origin: [number, number] = [Math.floor(r.x0), Math.floor(r.y0)];
  return { origin, w: Math.ceil((r.x1 - origin[0]) / scale), h: Math.ceil((r.y1 - origin[1]) / scale), scale };
}

/**
 * Draw a prepared kit layer into `canvas` (layer space of parallax `f`) as the reference camera `cam`
 * sees it: its own space when `layerF` equals `f`, otherwise shifted by C·(f − layerF).
 */
function renderLayer(scene: Scene, L: PreparedKitLayer, canvas: Canvas, cam: ReferenceCamera, f: [number, number]): AlphaFrame {
  const viewW = canvas.w * canvas.scale;
  const viewH = canvas.h * canvas.scale;
  const [lfx, lfy] = L.def.parallax;
  const frameCam: Camera = {
    name: L.def.id,
    cx: canvas.origin[0] + viewW / 2 - cam.cx * (f[0] - lfx),
    cy: canvas.origin[1] + viewH / 2 - cam.cy * (f[1] - lfy),
  };
  const img = new AlphaFrame(canvas.w, canvas.h, viewW, viewH, frameCam);
  drawKitChunks(img, scene, L.chunks, L.params, 1, 1, L.depthTested);
  return img;
}

type RGB = readonly [number, number, number];
const WHITE: RGB = [240, 244, 250];
const AMBER: RGB = [255, 190, 90];
const CYAN: RGB = [110, 225, 255];
const GREY: RGB = [150, 160, 175];
const SPIRIT: RGB = [191, 246, 255];

/** Straight-alpha "over" of one colour into an RGBA8 overlay. */
function put(img: Uint8Array, c: Canvas, x: number, y: number, rgb: RGB, a: number): void {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h || a <= 0) return;
  const o = (y * c.w + x) * 4;
  const k = a / 255;
  const ba = (img[o + 3] as number) / 255;
  const oa = k + ba * (1 - k);
  for (let i = 0; i < 3; i++) img[o + i] = Math.round(((rgb[i] as number) * k + (img[o + i] as number) * ba * (1 - k)) / oa);
  img[o + 3] = Math.round(oa * 255);
}

function rectOutline(img: Uint8Array, c: Canvas, r: Rect, rgb: RGB, width: number, dash = 0): void {
  const px0 = Math.round((r.x0 - c.origin[0]) / c.scale);
  const py0 = Math.round((r.y0 - c.origin[1]) / c.scale);
  const px1 = Math.round((r.x1 - c.origin[0]) / c.scale);
  const py1 = Math.round((r.y1 - c.origin[1]) / c.scale);
  const on = (t: number): boolean => dash <= 0 || Math.floor(t / dash) % 2 === 0;
  for (let x = px0; x <= px1; x++) {
    if (!on(x - px0)) continue;
    for (let k = 0; k < width; k++) {
      put(img, c, x, py0 + k, rgb, 230);
      put(img, c, x, py1 - k, rgb, 230);
    }
  }
  for (let y = py0; y <= py1; y++) {
    if (!on(y - py0)) continue;
    for (let k = 0; k < width; k++) {
      put(img, c, px0 + k, y, rgb, 230);
      put(img, c, px1 - k, y, rgb, 230);
    }
  }
}

/** The gameplay terrain as the reference camera sees it from this depth: world = layer + C·(1 − f). */
function terrainGuide(img: Uint8Array, c: Canvas, level: LevelData, cam: ReferenceCamera, f: [number, number]): void {
  const kind = new Uint8Array(c.w * c.h);
  const dx = cam.cx * (1 - f[0]);
  const dy = cam.cy * (1 - f[1]);
  for (let py = 0; py < c.h; py++) {
    const wy = c.origin[1] + (py + 0.5) * c.scale + dy;
    const ty = Math.floor(wy / TILE);
    for (let px = 0; px < c.w; px++) {
      const wx = c.origin[0] + (px + 0.5) * c.scale + dx;
      const tx = Math.floor(wx / TILE);
      // Beyond the level there is nothing to draw (the sim's walls there are invisible).
      kind[py * c.w + px] = tx < 0 || ty < 0 || tx >= level.widthTiles || ty >= level.heightTiles ? TileKind.Empty : tileAt(level, tx, ty);
    }
  }
  const thorn: RGB = [255, 77, 109];
  const oneWay: RGB = [200, 215, 230];
  for (let py = 0; py < c.h; py++) {
    for (let px = 0; px < c.w; px++) {
      const k = kind[py * c.w + px] as number;
      if (k === TileKind.Solid) {
        const edge = (px > 0 && kind[py * c.w + px - 1] !== TileKind.Solid) || (px < c.w - 1 && kind[py * c.w + px + 1] !== TileKind.Solid)
          || (py > 0 && kind[(py - 1) * c.w + px] !== TileKind.Solid) || (py < c.h - 1 && kind[(py + 1) * c.w + px] !== TileKind.Solid);
        if (edge) put(img, c, px, py, [120, 200, 240], 235);
        else put(img, c, px, py, [6, 9, 16], 150);
      } else if (k === TileKind.Thorns) {
        put(img, c, px, py, thorn, 110);
      } else if (k === TileKind.OneWay && py > 0 && kind[(py - 1) * c.w + px] !== TileKind.OneWay) {
        for (let t = 0; t < 2; t++) put(img, c, px, py + t, oneWay, 220);
      }
    }
  }
}

export interface TemplateFile {
  name: string;
  data: Uint8Array;
}

export interface TemplateOptions {
  level: LevelData;
  manifest: LayerManifest;
  kit: KitAtlasData;
  area: TemplateArea;
  /** World units per template pixel (the plate texelScale the stub declares). */
  scale?: number;
  /** Only these layer ids (default: every kit layer). */
  layers?: readonly string[];
  /** Extra empty slots at these parallax factors (paint a new plate between the layers). */
  slots?: readonly number[];
  /** The plates already in art/plates/: stubs never take their depth. */
  plates?: readonly Pick<LayerDef, 'id' | 'parallax'>[];
}

/**
 * The nearest parallax to `f` a new plate can take, in front first, on f's side of the gameplay plane: a
 * depth-tested plate (fx ≤ MAX_LAYER_PARALLAX) keeps MIN_LAYER_PARALLAX_GAP from every depth-tested
 * layer and plate; a foreground plate (fx > 1) avoids their exact fx. `plates` are the art plates
 * already in art/plates/ (not in the base manifest).
 */
export function freeSlot(manifest: LayerManifest, f: number, plates: readonly Pick<LayerDef, 'parallax'>[] = []): number {
  const taken = [...manifest.layers.filter((l) => l.kind === 'kit' || l.kind === 'plate'), ...plates].map((l) => l.parallax[0]);
  const ok = (x: number): boolean => {
    if (f > 1) return x > 1 && x <= 4 && taken.every((t) => Math.abs(t - x) > 1e-9);
    return x > 0 && x <= MAX_LAYER_PARALLAX && taken.every((t) => t > 1 || Math.abs(t - x) >= MIN_LAYER_PARALLAX_GAP - 1e-9);
  };
  for (let k = 0; k <= 400; k++) {
    for (const x of k === 0 ? [f] : [f + k * 0.01, f - k * 0.01]) {
      const r = Math.round(x * 100) / 100;
      if (ok(r)) return r;
    }
  }
  return f;
}

function stub(
  manifest: LayerManifest, plates: readonly Pick<LayerDef, 'id' | 'parallax'>[], canvas: Canvas, cam: ReferenceCamera,
  area: TemplateArea, file: string, f: [number, number], look: LayerDef | null,
): string {
  const slot = freeSlot(manifest, f[0], plates);
  const slotY = f[1] === f[0] ? slot : f[1];
  // Keep the painting registered with the template at the reference camera: p' = p + C·(f' − f).
  const origin: [number, number] = [
    Math.round(canvas.origin[0] + cam.cx * (slot - f[0])),
    Math.round(canvas.origin[1] + cam.cy * (slotY - f[1])),
  ];
  const notes: Record<string, string> = {
    _template: `Paint on ${file} (1 px = ${canvas.scale} u), save the painting as art/plates/<id>.png and this file as art/plates/<id>.json, then run npm run art (or keep npm run dev open: it hot-reloads).`,
  };
  if (look && slot !== f[0]) {
    notes._parallax = `The template is ${look.id} at fx ${f[0]}; a new plate can't tie with it, so this stub puts the plate at the nearest free depth, fx ${slot}. Set "replaces": "${look.id}" and "parallax": [${f[0]}, ${f[1]}] only if the painting covers that layer's full width (it takes the layer out of the whole level).`;
  } else if (slot !== f[0]) {
    const holder = [...manifest.layers, ...plates].filter((l) => Math.abs(l.parallax[0] - f[0]) < MIN_LAYER_PARALLAX_GAP - 1e-9).map((l) => l.id);
    const why = holder.length > 0 ? `is too close to ${holder.join(', ')}` : `is not a depth a plate can take (fx ≤ ${MAX_LAYER_PARALLAX} or > 1)`;
    notes._parallax = `fx ${f[0]} ${why}, so this stub puts the plate at the nearest free depth, fx ${slot}; its origin keeps the painting registered with the template at the reference camera.`;
  }
  if (look) {
    notes._look = `The template shows ${look.id} as the game draws it, so the stub adds no fog (paint what you see). ${look.id} itself uses fog ${look.fog}, fogColor ${look.fogColor}, desaturate ${look.desaturate}, tint ${look.tint}.`;
  }
  return formatJson({
    ...notes,
    parallax: [slot, slotY],
    replaces: null,
    origin,
    texelScale: canvas.scale,
    minQuality: look?.minQuality ?? 'low',
    fog: 0,
    fogColor: look?.fogColor ?? '#1f4a63',
    desaturate: 0,
    tint: '#ffffff',
    area: area.grade,
  });
}

/** Guides for one template canvas at parallax `f` (straight RGBA8, transparent elsewhere). */
function guides(
  level: LevelData, manifest: LayerManifest, area: TemplateArea, cam: ReferenceCamera, canvas: Canvas, f: [number, number], label: string,
): Uint8Array {
  const img = new Uint8Array(canvas.w * canvas.h * 4);
  terrainGuide(img, canvas, level, cam, f);
  // Camera sweep across the area at 16:9 (dashed), then the reference frames.
  const hw169 = (VIEW_H * 16) / 9 / 2;
  for (const x of [area.x0, area.x1]) {
    const cx = clampCentre(x, hw169, level.pxWidth);
    rectOutline(img, canvas, { x0: cx * f[0] - hw169, y0: cam.cy * f[1] - VIEW_H / 2, x1: cx * f[0] + hw169, y1: cam.cy * f[1] + VIEW_H / 2 }, GREY, 2, 24);
  }
  const frames: [number, RGB, string][] = [[MAX_ASPECT, CYAN, '21:9'], [16 / 9, WHITE, '16:9'], [MIN_ASPECT, AMBER, '4:3']];
  for (const [a, rgb, name] of frames) {
    const hw = (VIEW_H * a) / 2;
    // Each aspect clamps the camera to the level on its own (a wide view stops further from the edge).
    const cx = clampCentre(cam.cx, hw, level.pxWidth);
    const r: Rect = { x0: cx * f[0] - hw, y0: cam.cy * f[1] - VIEW_H / 2, x1: cx * f[0] + hw, y1: cam.cy * f[1] + VIEW_H / 2 };
    rectOutline(img, canvas, r, rgb, 3);
    const px = Math.round((r.x0 - canvas.origin[0]) / canvas.scale) + 8;
    const py = Math.round((r.y1 - canvas.origin[1]) / canvas.scale) - (GLYPH_H * 2 + 8) * (a === MAX_ASPECT ? 1 : a === MIN_ASPECT ? 3 : 2);
    drawText(img, canvas.w, canvas.h, px, py, name, rgb, 2);
  }
  // The moon (view-space, parallax 0) in the 16:9 reference frame.
  const sky = manifest.layers.find((l): l is SkyLayerDef => l.kind === 'sky');
  if (sky) {
    const mx = cam.cx * f[0] - hw169 + sky.moon.x * hw169 * 2;
    const my = cam.cy * f[1] - VIEW_H / 2 + sky.moon.y * VIEW_H;
    const r = sky.moon.radius;
    for (let t = 0; t < 360; t++) {
      const a = (t / 360) * Math.PI * 2;
      put(img, canvas, Math.round((mx + Math.cos(a) * r - canvas.origin[0]) / canvas.scale), Math.round((my + Math.sin(a) * r - canvas.origin[1]) / canvas.scale), [255, 244, 200], 240);
    }
  }
  // A hero-sized marker (28 × 58 u) where the reference camera's feet are, as seen from this depth.
  const hx = cam.feet[0] - cam.cx * (1 - f[0]);
  const hy = cam.feet[1] - cam.cy * (1 - f[1]);
  rectOutline(img, canvas, { x0: hx - 14, y0: hy - 58, x1: hx + 14, y1: hy }, SPIRIT, 2);
  drawText(img, canvas.w, canvas.h, 12, 12, label, WHITE, 3);
  drawText(img, canvas.w, canvas.h, 12, 12 + GLYPH_H * 3 + 6, `CAMERA ${Math.round(cam.cx)},${Math.round(cam.cy)}: 16:9 WHITE, 4:3 AMBER, 21:9 CYAN, SWEEP GREY, TERRAIN BLUE`, GREY, 2);
  return img;
}

function over(base: Uint8Array, top: Uint8Array): Uint8Array {
  const out = base.slice();
  for (let i = 0; i < out.length; i += 4) {
    const ta = (top[i + 3] as number) / 255;
    if (ta <= 0) continue;
    const ba = (out[i + 3] as number) / 255;
    const oa = ta + ba * (1 - ta);
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(((top[i + c] as number) * ta + (out[i + c] as number) * ba * (1 - ta)) / oa);
    out[i + 3] = Math.round(oa * 255);
  }
  return out;
}

const two = (n: number): string => String(n).padStart(2, '0');

/**
 * Every template file for an area: per kit layer `NN-<id>.png` (layer + guides), `.layer.png`,
 * `.guides.png` and a sidecar stub `.json`; per extra slot `slot-f<f>.png` (the layers behind it, as the
 * reference camera sees them from that depth, + guides), `.guides.png` and `.json`. Deterministic.
 */
export function renderTemplates(opts: TemplateOptions): TemplateFile[] {
  const { level, manifest, kit, area } = opts;
  const plates = opts.plates ?? [];
  const scale = opts.scale ?? 1.5;
  const cam = referenceCamera(level, area);
  const scene = buildScene(level, { ...manifest, layers: [] }, kit);
  const clearings = clearingHints(level);
  const files: TemplateFile[] = [];
  const png = (rgba: Uint8Array, c: Canvas): Uint8Array => new Uint8Array(encodePng(rgba, c.w, c.h));
  const kits = manifest.layers.filter((l): l is KitLayerDef => l.kind === 'kit');
  const prepared = new Map<string, PreparedKitLayer>();
  const prep = (d: KitLayerDef): PreparedKitLayer => {
    let p = prepared.get(d.id);
    if (!p) {
      p = prepareKitLayer(d, kit, level.pxWidth, level.pxHeight, clearings);
      prepared.set(d.id, p);
    }
    return p;
  };
  kits.forEach((def, i) => {
    if (opts.layers && !opts.layers.includes(def.id)) return;
    const f: [number, number] = [def.parallax[0], def.parallax[1]];
    const canvas = canvasFor(areaExtent(level, area, f[0], f[1]), scale);
    const layer = renderLayer(scene, prep(def), canvas, cam, f).rgba();
    const label = `${def.id}  F ${f[0]}/${f[1]}  1 PX = ${scale} U  ORIGIN ${canvas.origin[0]},${canvas.origin[1]}  AREA ${area.id}`;
    const g = guides(level, manifest, area, cam, canvas, f, label);
    const name = `${two(i + 1)}-${def.id}`;
    files.push({ name: `${name}.png`, data: png(over(layer, g), canvas) });
    files.push({ name: `${name}.layer.png`, data: png(layer, canvas) });
    files.push({ name: `${name}.guides.png`, data: png(g, canvas) });
    files.push({ name: `${name}.json`, data: new TextEncoder().encode(stub(manifest, plates, canvas, cam, area, `${name}.png`, f, def)) });
  });
  for (const fx of opts.slots ?? []) {
    const f: [number, number] = [fx, fx];
    const canvas = canvasFor(areaExtent(level, area, fx, fx), scale);
    // Context: the procedural layers behind the slot, over the far fog colour.
    let ctx: Uint8Array = new Uint8Array(canvas.w * canvas.h * 4);
    const bg = [(PALETTE.fogDeep >> 16) & 255, (PALETTE.fogDeep >> 8) & 255, PALETTE.fogDeep & 255];
    for (let p = 0; p < canvas.w * canvas.h; p++) {
      ctx[p * 4] = bg[0] as number;
      ctx[p * 4 + 1] = bg[1] as number;
      ctx[p * 4 + 2] = bg[2] as number;
      ctx[p * 4 + 3] = 255;
    }
    for (const def of kits) if (def.parallax[0] < fx) ctx = over(ctx, renderLayer(scene, prep(def), canvas, cam, f).rgba());
    const label = `NEW PLATE  F ${fx}/${fx}  1 PX = ${scale} U  ORIGIN ${canvas.origin[0]},${canvas.origin[1]}  AREA ${area.id}  (BEHIND: THE LAYERS FARTHER THAN ${fx})`;
    const g = guides(level, manifest, area, cam, canvas, f, label);
    const name = `slot-f${fx}`;
    files.push({ name: `${name}.png`, data: png(over(ctx, g), canvas) });
    files.push({ name: `${name}.guides.png`, data: png(g, canvas) });
    files.push({ name: `${name}.json`, data: new TextEncoder().encode(stub(manifest, plates, canvas, cam, area, `${name}.png`, f, null)) });
  }
  return files;
}
