import type { LayerDef, LayerManifest, PlateLayerDef } from '../contracts/assets.ts';

export class SpliceError extends Error {
  override name = 'SpliceError';
}

/** A baked plate layer and the base layer it takes out of the draw list, if any. */
export interface PlateInsert {
  layer: PlateLayerDef;
  replaces?: string | null;
}

/**
 * Splice plate layers into the hand-edited base manifest (ARCHITECTURE.md §5.8):
 * - a plate goes where its fx falls among the base layers (far → near). Two layers with the same fx
 *   would draw in an arbitrary order, so a plate whose fx equals another layer's is rejected, except
 *   for the base layer it replaces;
 * - `replaces` takes that base layer out of the list and records it under `replaced`;
 * - plates are spliced in id order, so the result depends only on the inputs.
 *
 * Throws SpliceError naming the plate. Validate the result with parseManifest (depth gaps, ranges).
 */
export function spliceManifest(base: LayerManifest, plates: readonly PlateInsert[]): LayerManifest {
  const sorted = [...plates].sort((a, b) => (a.layer.id < b.layer.id ? -1 : a.layer.id > b.layer.id ? 1 : 0));
  const baseIds = new Set(base.layers.map((l) => l.id));
  const replaced: Record<string, LayerDef> = {};
  const removed = new Set<string>();
  const seen = new Set<string>();
  for (const p of sorted) {
    const id = p.layer.id;
    if (seen.has(id)) throw new SpliceError(`plate "${id}": two plates with this id`);
    seen.add(id);
    if (baseIds.has(id)) throw new SpliceError(`plate "${id}": the base manifest already has a layer with this id; rename the plate`);
    if (p.layer.kind !== 'plate') throw new SpliceError(`plate "${id}": expected a plate layer`);
    const r = p.replaces ?? null;
    if (r === null) continue;
    const target = base.layers.find((l) => l.id === r);
    if (!target) {
      const known = base.layers.filter((l) => l.kind === 'kit' || l.kind === 'plate').map((l) => l.id);
      throw new SpliceError(`plate "${id}": replaces "${r}", which is not a base layer (kit and plate layers: ${known.join(', ')})`);
    }
    if (target.kind !== 'kit' && target.kind !== 'plate') {
      throw new SpliceError(`plate "${id}": replaces "${r}", a ${target.kind} layer; only kit and plate layers can be replaced`);
    }
    if (removed.has(r)) {
      const other = Object.keys(replaced).find((k) => replaced[k]?.id === r);
      throw new SpliceError(`plate "${id}": "${r}" is already replaced by plate "${other}"`);
    }
    removed.add(r);
    replaced[id] = target;
  }
  const layers: LayerDef[] = base.layers.filter((l) => !removed.has(l.id));
  for (const p of sorted) {
    const fx = p.layer.parallax[0];
    // A layer another plate replaced comes back if that plate fails, so it counts too.
    const own = replaced[p.layer.id]?.id;
    const tie = layers.find((l) => l.parallax[0] === fx)
      ?? base.layers.find((l) => removed.has(l.id) && l.id !== own && l.parallax[0] === fx);
    if (tie) {
      const what = tie.kind === 'plate' && seen.has(tie.id) ? 'plate' : 'base layer';
      throw new SpliceError(`plate "${p.layer.id}": parallax fx ${fx} ties with ${what} "${tie.id}"; the draw order would be ambiguous. Move it (the depth-tested gap is at least 0.02) or replace that layer`);
    }
    let at = layers.findIndex((l) => l.parallax[0] > fx);
    if (at < 0) at = layers.length;
    layers.splice(at, 0, p.layer);
  }
  const out: LayerManifest = {
    version: base.version,
    area: base.area,
    textureBudgetMB: { ...base.textureBudgetMB },
    atlases: base.atlases.map((a) => ({ ...a, source: { ...a.source } })),
    layers: layers.map(idKindFirst),
  };
  if (Object.keys(replaced).length > 0) {
    out.replaced = Object.fromEntries(Object.entries(replaced).map(([k, l]) => [k, idKindFirst(l)]));
  }
  return out;
}

/** A copy with `id` and `kind` as the first keys, so the generated file reads like the base. */
function idKindFirst(l: LayerDef): LayerDef {
  const { id, kind, ...rest } = l;
  return { id, kind, ...rest } as LayerDef;
}

/** The plate layers of a manifest (kit layers, fog and sky are left to the parallax stack). */
export function plateLayers(m: LayerManifest): PlateLayerDef[] {
  return m.layers.filter((l): l is PlateLayerDef => l.kind === 'plate');
}
