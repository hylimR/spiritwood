import type { LayerManifest } from '../contracts/assets.ts';
import { todo } from '../core/todo.ts';

export class ManifestError extends Error {
  override name = 'ManifestError';
}

/**
 * Validate an unknown JSON value against the LayerManifest schema (src/contracts/assets.ts) and
 * return it typed. Throws ManifestError naming the offending path (e.g. `layers[3].parallax`).
 * Checks: version, unique ids, known kinds, atlas references exist, parallax ranges, colours,
 * layers ordered far→near by parallax (foreground > 1 last), plate chunk grid sanity.
 */
export function parseManifest(json: unknown): LayerManifest {
  void json;
  return todo('WORLD', 'parseManifest');
}

export async function loadManifest(url: string, fetchFn: typeof fetch = fetch): Promise<LayerManifest> {
  const res = await fetchFn(url);
  if (!res.ok) throw new ManifestError(`Failed to load manifest ${url}: HTTP ${res.status}`);
  return parseManifest(await res.json());
}
