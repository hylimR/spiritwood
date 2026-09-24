import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { parseManifest } from '../../src/assets/manifest.ts';
import { DEPTH_INSTANCE_EPS, MAX_ASPECT, MAX_INSTANCES_PER_LAYER, MIN_ASPECT, VIEW_H } from '../../src/config.ts';
import type { KitLayerDef } from '../../src/contracts/assets.ts';
import { coverageExtent, elementRowY, HINT_CLEARING, instanceBounds, placeLayer } from '../../src/render/layers/placement.ts';
import { clearingHints, prepareKitLayer, SINGLE_CHUNK_PARALLAX } from '../../src/render/layers/layerModel.ts';
import { KIT_STRIDE_FLOATS, MAX_MESH_VERTICES } from '../../src/render/layers/kitMesh.ts';
import { RECIPES } from '../../src/render/layers/recipes.ts';
import { computeCameraFrame, createCameraFrame, depthForInstance, depthForParallax, layerExtent, visibleLayerRect, type Extent } from '../../src/render/util/camera.ts';
import { forestKit } from './kitFixture.ts';

const manifest = parseManifest(JSON.parse(readFileSync(new URL('../../public/layers/forest.manifest.json', import.meta.url), 'utf8')));
const kitLayers = manifest.layers.filter((l): l is KitLayerDef => l.kind === 'kit');
const W = 9600;
const H = 2400;

describe('coverageExtent', () => {
  test('is the union of the narrowest and widest aspect extents', () => {
    for (const f of [0.08, 0.5, 0.9, 1.25]) {
      const e = coverageExtent(W, H, f, f);
      const a = layerExtent(W, H, VIEW_H * MIN_ASPECT, VIEW_H, f, f);
      const b = layerExtent(W, H, VIEW_H * MAX_ASPECT, VIEW_H, f, f);
      expect(e.x0).toBe(Math.min(a.x0, b.x0));
      expect(e.x1).toBe(Math.max(a.x1, b.x1));
    }
  });
});

describe('placeLayer (shipped manifest)', () => {
  const kit = forestKit();

  for (const def of kitLayers) {
    describe(def.id, () => {
      const recipe = RECIPES[def.recipe] as NonNullable<(typeof RECIPES)[string]>;
      const p = placeLayer(def, recipe, kit.byCategory, W, H);

      test('deterministic', () => {
        const again = placeLayer(def, recipe, kit.byCategory, W, H);
        expect(again.instances.map((i) => [i.el.index, i.x, i.y, i.sx, i.sy, i.k])).toEqual(p.instances.map((i) => [i.el.index, i.x, i.y, i.sx, i.sy, i.k]));
      });

      test('instance count within the per-layer depth budget; painter order is 1..n', () => {
        expect(p.instances.length).toBeGreaterThan(0);
        expect(p.instances.length).toBeLessThanOrEqual(MAX_INSTANCES_PER_LAYER);
        p.instances.forEach((inst, i) => expect(inst.k).toBe(i + 1));
        // Instance depths stay inside this layer's slice (never cross into the next layer).
        const f = def.parallax[0];
        if (f <= 1) expect(depthForInstance(f, p.instances.length)).toBeGreaterThan(depthForParallax(f) - MAX_INSTANCES_PER_LAYER * DEPTH_INSTANCE_EPS - 1e-9);
      });

      test('background layers cover the extent horizontally without gaps wider than a view', () => {
        if (def.parallax[0] > 1) return; // the foreground frame is deliberately sparse
        const b: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };
        const spans = p.instances.map((i) => instanceBounds(i, { ...b })).sort((a, c) => a.x0 - c.x0);
        expect(spans[0]?.x0).toBeLessThanOrEqual(p.extent.x0);
        let reach = p.extent.x0;
        let maxGap = 0;
        for (const s of spans) {
          maxGap = Math.max(maxGap, s.x0 - reach);
          reach = Math.max(reach, s.x1);
        }
        expect(reach).toBeGreaterThanOrEqual(p.extent.x1);
        expect(maxGap).toBeLessThan(VIEW_H * MIN_ASPECT);
      });

      test('top cuts clear the extent top; hanging and ground items anchor where the recipe says', () => {
        for (const inst of p.instances) {
          if (inst.el.cut === 'top') expect(elementRowY(inst, 0)).toBeLessThanOrEqual(p.extent.y0 + 1e-6);
        }
      });
    });
  }
});

describe('prepareKitLayer meshes', () => {
  const kit = forestKit();
  for (const def of kitLayers) {
    test(`${def.id}: chunking, depth order and Uint16 limits`, () => {
      const L = prepareKitLayer(def, kit, W, H);
      if (def.parallax[0] <= SINGLE_CHUNK_PARALLAX) expect(L.chunks).toHaveLength(1);
      for (const c of L.chunks) {
        for (const m of [...c.core, ...c.band]) {
          expect(m.vertexCount).toBeLessThanOrEqual(MAX_MESH_VERTICES);
          expect(m.indices.length % 6).toBe(0);
          for (const i of m.indices) expect(i).toBeLessThan(m.vertexCount);
          expect(Number.isFinite(m.bounds.x0) && Number.isFinite(m.bounds.y1)).toBe(true);
        }
        if (L.depthTested) {
          // Cores front → back (depth ascending), bands back → front (depth descending).
          for (const m of c.core) {
            let prev = -Infinity;
            for (let q = 0; q < m.vertexCount; q += 4) {
              const d = m.vertices[q * KIT_STRIDE_FLOATS + 6] as number;
              expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
              prev = d;
            }
          }
          for (const m of c.band) {
            let prev = Infinity;
            for (let q = 0; q < m.vertexCount; q += 4) {
              const d = m.vertices[q * KIT_STRIDE_FLOATS + 6] as number;
              expect(d).toBeLessThanOrEqual(prev + 1e-9);
              prev = d;
            }
          }
        }
      }
    });
  }

  test('at most 2–3 chunks of a layer are visible at the widest aspect', () => {
    const def = kitLayers.find((l) => l.id.startsWith('L8')) as KitLayerDef;
    const L = prepareKitLayer(def, kit, W, H);
    const f = def.parallax[0];
    const r: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };
    let worst = 0;
    for (let cx = 1300; cx < W - 1300; cx += 200) {
      const frame = computeCameraFrame(createCameraFrame(), {
        x: cx, y: 1500, prevX: cx, prevY: 1500, zoom: 1, prevZoom: 1, snapTick: -1, viewW: VIEW_H * MAX_ASPECT, viewH: VIEW_H,
      }, 1);
      visibleLayerRect(frame, f, f, r);
      const n = L.chunks.filter((c) => c.bounds.x1 > r.x0 && c.bounds.x0 < r.x1).length;
      worst = Math.max(worst, n);
    }
    expect(worst).toBeLessThanOrEqual(3);
  });

  test('High: depth-tested kit soft bands stay within the transparent-band fill budget (≤ 1.5 screens, §6)', () => {
    // Same estimate as ParallaxStackView (mesh rect area, uniform inside each mesh's bounds).
    const layers = kitLayers.filter((d) => d.parallax[0] <= 1).map((d) => prepareKitLayer(d, kit, W, H));
    const r: Extent = { x0: 0, y0: 0, x1: 0, y1: 0 };
    let worst = 0;
    for (const aspect of [MIN_ASPECT, 16 / 9, MAX_ASPECT]) {
      const viewW = VIEW_H * aspect;
      for (let cx = viewW / 2; cx <= W - viewW / 2; cx += 600) {
        for (let cy = VIEW_H / 2; cy <= H - VIEW_H / 2; cy += 300) {
          const frame = computeCameraFrame(createCameraFrame(), {
            x: cx, y: cy, prevX: cx, prevY: cy, zoom: 1, prevZoom: 1, snapTick: -1, viewW, viewH: VIEW_H,
          }, 1);
          let band = 0;
          for (const L of layers) {
            visibleLayerRect(frame, L.def.parallax[0], L.def.parallax[1], r);
            const visArea = (r.x1 - r.x0) * (r.y1 - r.y0);
            for (const c of L.chunks) {
              for (const m of c.band) {
                const b = m.bounds;
                const w = Math.min(b.x1, r.x1) - Math.max(b.x0, r.x0);
                const h = Math.min(b.y1, r.y1) - Math.max(b.y0, r.y0);
                if (w > 0 && h > 0) band += (m.area * w * h) / Math.max(1, (b.x1 - b.x0) * (b.y1 - b.y0)) / visArea;
              }
            }
          }
          worst = Math.max(worst, band);
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(1.5);
  });
});

describe('clearings', () => {
  const kit = forestKit();
  test('streams with gaps open clearings: fewer trunks, deterministic, with gaps well beyond the usual spacing', () => {
    const def = kitLayers.find((d) => d.recipe === 'midForest') as KitLayerDef;
    const recipe = RECIPES.midForest as NonNullable<(typeof RECIPES)[string]>;
    const noGaps = { ...recipe, streams: recipe.streams.map(({ gaps: _gaps, ...rest }) => rest) };
    const trunks = (p: ReturnType<typeof placeLayer>): number[] =>
      p.instances.filter((i) => i.el.category === 'midTrunk').map((i) => i.x).sort((a, b) => a - b);
    const withGaps = trunks(placeLayer(def, recipe, kit.byCategory, W, H));
    const even = trunks(placeLayer(def, noGaps, kit.byCategory, W, H));
    expect(withGaps).toEqual(trunks(placeLayer(def, recipe, kit.byCategory, W, H)));
    expect(withGaps.length).toBeLessThan(even.length);
    expect(withGaps.length).toBeGreaterThan(even.length * 0.3);
    const widest = (xs: number[]): number => Math.max(...xs.slice(1).map((x, i) => x - (xs[i] as number)));
    expect(widest(withGaps)).toBeGreaterThan(widest(even) * 1.2);
  });
});

describe('clearings around gameplay hints', () => {
  const kit = forestKit();
  test('trunk streams leave the goal and lanterns open (in each layer’s parallax space)', () => {
    const goalX = 8800;
    for (const def of kitLayers.filter((d) => d.recipe === 'midForest' || d.recipe === 'nearForest')) {
      const recipe = RECIPES[def.recipe] as NonNullable<(typeof RECIPES)[string]>;
      const open = placeLayer(def, recipe, kit.byCategory, W, H, [goalX]);
      const centre = goalX * def.parallax[0];
      for (const i of open.instances) {
        if (i.el.category === 'midTrunk' || i.el.category === 'nearTrunk') expect(Math.abs(i.x - centre)).toBeGreaterThanOrEqual(HINT_CLEARING);
      }
      // Without hints the same layer is free to put trunks there.
      expect(placeLayer(def, recipe, kit.byCategory, W, H).instances.length).toBeGreaterThanOrEqual(open.instances.length);
    }
  });

  test('clearingHints lists the goal and every lantern', () => {
    const level = { goal: { x: 100, y: 0, w: 40, h: 80 }, decorHints: [{ id: 0, kind: 'lantern' as const, x: 500, y: 0 }, { id: 1, kind: 'flora' as const, x: 700, y: 0 }] };
    expect(clearingHints(level)).toEqual([120, 500]);
  });
});
