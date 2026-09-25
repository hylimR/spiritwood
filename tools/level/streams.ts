import type { LevelData, SpitterDef } from '../../src/contracts/level.ts';
import { SimEventQueue } from '../../src/core/events.ts';
import { CollisionGrid } from '../../src/level/grid.ts';
import { SeedPool } from '../../src/sim/seeds.ts';
import { DEFAULT_WORLD_TUNING, type WorldTuning } from '../../src/sim/tuning.ts';

export interface SeedPoint {
  x: number;
  y: number;
}

/**
 * The flight of one seed from a fixed-aim spitter, traced with the sim's own SeedPool (terrain bursts,
 * speed cap, lifetime, the out-of-level margin; no enemies). Returns the centre at fire time, then once
 * per stepped tick until the seed bursts or expires (its last point is where it burst).
 */
export function fixedSeedPath(level: LevelData, s: SpitterDef, tuning: WorldTuning = DEFAULT_WORLD_TUNING): SeedPoint[] {
  const pool = new SeedPool(CollisionGrid.fromLevel(level), tuning, level.pxHeight);
  const events = new SimEventQueue(4);
  const seed = pool.fire(s.x, s.y - tuning.spitterMuzzleHeight, s.fixedVx, s.fixedVy, s.id, 0, events);
  const out: SeedPoint[] = [];
  if (!seed) return out;
  out.push({ x: seed.x, y: seed.y });
  for (let tick = 1; seed.active; tick++) {
    pool.step(tick, [], events);
    events.clear();
    out.push({ x: seed.x, y: seed.y });
  }
  return out;
}

/** Every fixed-aim spitter's seed flight. */
export function fixedStreams(level: LevelData, tuning: WorldTuning = DEFAULT_WORLD_TUNING): { spitter: SpitterDef; path: SeedPoint[] }[] {
  const out: { spitter: SpitterDef; path: SeedPoint[] }[] = [];
  for (const e of level.enemies) if (e.kind === 'thornSpitter' && e.aim === 'fixed') out.push({ spitter: e, path: fixedSeedPath(level, e, tuning) });
  return out;
}
