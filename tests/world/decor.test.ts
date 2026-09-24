import { describe, expect, test } from 'vitest';
import { Texture } from 'pixi.js';
import { createHaloContainer, type HaloRuntime } from '../../src/render/fx/decor.ts';
import { TileKind } from '../../src/contracts/level.ts';
import { tileAt } from '../../src/core/tiles.ts';
import { DECOR_SINK, placeDecor, type DecorInstance } from '../../src/render/fx/decorPlacement.ts';
import { PALETTE } from '../../src/config.ts';
import { levelFromAscii } from '../shared/fixtures.ts';
import { forestKit } from './kitFixture.ts';
import { firstRenderStaticUpload } from './particleUpload.ts';

const MAP = [
  '##############################',
  '#............................#',
  '#....######..........####....#',
  '#............................#',
  '#.........=====..............#',
  '#............................#',
  '#...P.....o..........C.......#',
  '######....^^^^^....###########',
  '######################.......#',
  '##############################',
];

describe('placeDecor', () => {
  const kit = forestKit();
  const level = levelFromAscii(MAP, { seed: 99 });
  level.decorHints.push({ id: 0, kind: 'flora', x: 3 * 48, y: 7 * 48 }, { id: 0, kind: 'lantern', x: 25 * 48, y: 7 * 48 });
  const d = placeDecor(level, kit);
  const T = level.tileSize;
  const all: DecorInstance[] = [...d.back, ...d.front];

  test('deterministic per level seed', () => {
    const again = placeDecor(level, kit);
    expect(again.back.map((i) => [i.el.index, i.x, i.y, i.sx, i.sy])).toEqual(d.back.map((i) => [i.el.index, i.x, i.y, i.sx, i.sy]));
    const other = placeDecor({ ...level, seed: 100 }, kit);
    expect(other.back.map((i) => [i.x, i.y])).not.toEqual(d.back.map((i) => [i.x, i.y]));
  });

  test('grounded decor stands on a solid tile top with open air above; nothing anchors inside solids', () => {
    for (const inst of all) {
      const tx = Math.floor(inst.x / T);
      const c = inst.el.category;
      if (c === 'grass' || c === 'flower' || c === 'shroom') {
        const surfaceTy = Math.round((inst.y - DECOR_SINK) / T);
        expect(Math.abs(inst.y - DECOR_SINK - surfaceTy * T)).toBeLessThanOrEqual(2);
        expect(tileAt(level, tx, surfaceTy)).toBe(TileKind.Solid);
        expect(tileAt(level, tx, surfaceTy - 1)).toBe(TileKind.Empty);
      } else if (c === 'tendril') {
        const ceilTy = Math.round((inst.y + DECOR_SINK) / T) - 1;
        expect(tileAt(level, tx, ceilTy)).toBe(TileKind.Solid);
        expect(tileAt(level, tx, ceilTy + 1)).toBe(TileKind.Empty);
      } else if (c === 'bramble') {
        expect(tileAt(level, tx, Math.floor((inst.y - DECOR_SINK - 3) / T))).toBe(TileKind.Thorns);
        expect(inst.glow).toBe(PALETTE.thorns);
      }
      // Just past the sink, every anchor is in open air (or inside the thorn/one-way tile it decorates).
      const hanging = inst.el.sway === 'top' || inst.sy < 0;
      const probeY = hanging ? inst.y + DECOR_SINK + 3 : inst.y - DECOR_SINK - 3;
      expect(tileAt(level, tx, Math.floor(probeY / T))).not.toBe(TileKind.Solid);
    }
  });

  test('one bridge per one-way run, spanning it with its top on the tile top', () => {
    const bridges = d.back.filter((i) => i.el.category === 'bridge');
    expect(bridges).toHaveLength(1);
    const b = bridges[0] as DecorInstance;
    expect(b.x).toBeCloseTo(12.5 * T, 6);
    expect(b.y).toBe(4 * T + 1);
    const width = b.el.w * b.el.unitsPerTexel * Math.abs(b.sx);
    expect(width).toBeGreaterThanOrEqual(5 * T);
  });

  test('every thorn tile gets at least one bramble; hints get their flora and lantern', () => {
    for (let tx = 10; tx <= 14; tx++) {
      expect(all.some((i) => i.el.category === 'bramble' && Math.floor(i.x / T) === tx)).toBe(true);
    }
    expect(d.back.some((i) => i.el.category === 'floraBig')).toBe(true);
    const lantern = d.back.find((i) => i.el.category === 'lantern') as DecorInstance;
    expect(lantern.glow).toBe(PALETTE.warmAccent);
    // One pool per hint, plus faint rose pools along the thorn run.
    expect(d.halos.filter((h) => h.color !== PALETTE.thorns)).toHaveLength(2);
    const thorn = d.halos.filter((h) => h.color === PALETTE.thorns);
    expect(thorn.length).toBeGreaterThan(0);
    for (const h of thorn) expect(h.alpha).toBeLessThan(0.2);
  });

  test('floors carry grass (dense enough to read), front layer holds only small plants', () => {
    const grass = d.back.filter((i) => i.el.category === 'grass').length;
    expect(grass).toBeGreaterThan(8);
    for (const i of d.front) expect(['grass', 'bramble']).toContain(i.el.category);
  });
});

describe('decor light pools', () => {
  test('one additive particle per halo; static positions and sizes reach the GPU on the first render', () => {
    const halos = [
      { x: 100, y: 200, radius: 150, color: PALETTE.floraGlow, alpha: 0.2, phase: 0, flicker: 0.1 },
      { x: 900, y: 300, radius: 190, color: PALETTE.warmAccent, alpha: 0.3, phase: 1, flicker: 0.2 },
    ];
    const list: HaloRuntime[] = [];
    const pc = createHaloContainer(halos, Texture.WHITE, list);
    expect(pc.blendMode).toBe('add');
    expect(pc.particleChildren).toHaveLength(2);
    expect(list.map((h) => h.particle)).toEqual(pc.particleChildren);
    const { have, need } = firstRenderStaticUpload(pc);
    expect(need).toBeGreaterThan(0);
    expect(have).toBeGreaterThanOrEqual(need);
  });
});
