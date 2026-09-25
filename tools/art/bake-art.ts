/**
 * Bake the painted plates in art/plates/ into public/layers/ (ARCHITECTURE.md §5.8).
 *
 *   npm run art              validate, encode changed chunks (WebP + PNG + KTX2), splice the plates into
 *                            public/layers/forest.base.manifest.json → forest.manifest.json, print budgets
 *   npm run art -- --check   recompute hashes and the splice without encoding; exit 1 when anything is
 *                            stale (CI / pre-commit)
 *
 * Nothing is written unless every plate validates and the budgets hold.
 */
import { formatBudgetReport } from './budget.ts';
import { ArtError, runArt } from './bake.ts';
import { artPaths } from './paths.ts';

async function main(argv: readonly string[]): Promise<number> {
  const check = argv.includes('--check');
  const unknown = argv.filter((a) => a !== '--check');
  if (unknown.length) {
    console.error(`unknown argument ${unknown.join(' ')}; usage: npm run art [-- --check]`);
    return 2;
  }
  const paths = artPaths();
  try {
    const r = await runArt(paths, { check, log: (l) => console.log(l) });
    console.log(formatBudgetReport(r.report));
    for (const w of r.warnings) if (!r.report.warnings.includes(w)) console.warn(`warning: ${w}`);
    const plates = r.manifest.layers.filter((l) => l.kind === 'plate');
    if (check) {
      if (r.problems.length) {
        console.error(`\nart --check: ${r.problems.length} problem${r.problems.length === 1 ? '' : 's'} (run \`npm run art\` to rebake):\n  ${r.problems.join('\n  ')}`);
        return 1;
      }
      console.log(`\nart --check: ${plates.length} plate layer${plates.length === 1 ? '' : 's'} up to date (${(r.ms / 1000).toFixed(1)} s, nothing encoded)`);
      return 0;
    }
    console.log(`\nwrote public/layers/forest.manifest.json with ${plates.length} plate layer${plates.length === 1 ? '' : 's'}: ${r.encoded} chunk${r.encoded === 1 ? '' : 's'} encoded, ${r.reused} reused, ${(r.ms / 1000).toFixed(1)} s`);
    return 0;
  } catch (e) {
    if (e instanceof ArtError) {
      console.error(`npm run art: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

process.exitCode = await main(process.argv.slice(2));
