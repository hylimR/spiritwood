import type { LevelData } from '../contracts/level.ts';
import { todo } from '../core/todo.ts';

export class LevelParseError extends Error {
  override name = 'LevelParseError';
}

/**
 * Convert an LDtk 1.5.x project (parsed JSON) into LevelData. Reads only the exported "__" fields
 * (__identifier, __type, __cWid, __cHei, __gridSize, intGridCsv, entityInstances with px/__pivot/
 * width/height/fieldInstances). Validates structure and throws LevelParseError with a precise message.
 * `levelIdentifier` defaults to the first level.
 */
export function parseLdtk(project: unknown, levelIdentifier?: string): LevelData {
  void project;
  void levelIdentifier;
  return todo('SIM', 'parseLdtk');
}

export async function loadLevel(url: string, levelIdentifier?: string, fetchFn: typeof fetch = fetch): Promise<LevelData> {
  const res = await fetchFn(url);
  if (!res.ok) throw new LevelParseError(`Failed to load level ${url}: HTTP ${res.status}`);
  return parseLdtk(await res.json(), levelIdentifier);
}
