import { generateKit, kitSeed, type KitAtlasData } from '../../src/render/gen/kit.ts';

let kit: KitAtlasData | null = null;
let ms = 0;

/** The full procedural forest kit, generated once per test file (worker). */
export function forestKit(): KitAtlasData {
  if (!kit) {
    const t0 = performance.now();
    kit = generateKit(kitSeed('forest-kit'));
    ms = performance.now() - t0;
  }
  return kit;
}

/** Wall time of the first forestKit() call in this worker (ms). */
export function forestKitMs(): number {
  forestKit();
  return ms;
}
