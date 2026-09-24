/**
 * Builds public/levels/forest.ldtk from tools/level/forest.map.txt.
 *
 *   node tools/level/build-level.ts            (or: npm run level)
 *   node tools/level/build-level.ts --check    exit 1 if the committed file is stale or the level has errors
 *
 * The output is byte-stable: the same map always produces the same file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { LevelData } from '../../src/contracts/level.ts';
import { validateLevel, type LevelIssue } from '../../src/level/validate.ts';
import { buildLdtkProject, serializeLdtk } from './ldtk-writer.ts';
import { parseMapFile } from './mapfile.ts';

export const MAP_PATH = fileURLToPath(new URL('./forest.map.txt', import.meta.url));
export const LDTK_PATH = fileURLToPath(new URL('../../public/levels/forest.ldtk', import.meta.url));

export interface BuildResult {
  level: LevelData;
  text: string;
  issues: LevelIssue[];
}

/** Pure: map source → LevelData, the serialized LDtk project and the validation issues. */
export function buildLevel(mapSource: string): BuildResult {
  const level = parseMapFile(mapSource);
  const text = serializeLdtk(buildLdtkProject(level), level.widthTiles);
  return { level, text, issues: validateLevel(level) };
}

function main(argv: readonly string[]): number {
  const check = argv.includes('--check');
  const { level, text, issues } = buildLevel(readFileSync(MAP_PATH, 'utf8'));
  for (const issue of issues) console[issue.severity === 'error' ? 'error' : 'warn'](`${issue.severity}: ${issue.message}`);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const summary = `${level.id}: ${level.widthTiles}×${level.heightTiles} tiles, ${level.orbs.length} orbs, `
    + `${level.checkpoints.length} checkpoints, ${level.enemies.length} enemies, ${level.lightShafts.length} light shafts, `
    + `${level.decorHints.length} decor hints`;
  if (check) {
    let current = '';
    try {
      current = readFileSync(LDTK_PATH, 'utf8');
    } catch {
      current = '';
    }
    const stale = current !== text;
    console.log(`${summary}${stale ? ' — public/levels/forest.ldtk is STALE' : ' — up to date'}`);
    return stale || errors > 0 ? 1 : 0;
  }
  if (errors > 0) {
    console.error(`${errors} error(s); not writing ${LDTK_PATH}`);
    return 1;
  }
  writeFileSync(LDTK_PATH, text);
  console.log(`${summary} → ${LDTK_PATH}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = main(process.argv.slice(2));
