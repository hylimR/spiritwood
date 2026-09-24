/**
 * Build the game as ONE self-contained page for a Claude artifact: <outDir>/index.html, an HTML fragment
 * (the host adds the doctype/head/body skeleton and scans the first 8 KB for <title>).
 *
 * Public links need the host to review the page, and a multi-file build (19 JS modules, ~0.9 MB of
 * minified code, most of it PixiJS) "couldn't be reviewed". So this build has no supporting files:
 * - PixiJS comes from the jsDelivr CDN (an allowlisted script host) as the pinned UMD build with SRI,
 *   plus its unsafe-eval package, which installs eval-free shader sync on load (artifacts forbid eval);
 * - the game is bundled as one IIFE against the `PIXI` global and inlined, guarded so a blocked CDN
 *   shows the boot error; the build fails if it reads a name the CDN global lacks or compiles strings;
 * - the level and layer manifest are inlined as compact JSON and served to the loaders by `embeddedFetch`.
 * KTX2 needs eval and the painted-plate demo needs streamed image files, so neither ships here.
 *
 * Usage: node tools/artifact/package-artifact.ts <outDir>
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Plugin } from 'vite';
import { EMBEDDED_FILES_ID, GAME_DATA } from '../../src/assets/embedded.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PIXI_DIR = join(ROOT, 'node_modules/pixi.js');
/** Data files the page embeds, by the path the game requests them at. */
export const EMBEDDED_PATHS = [GAME_DATA.level, GAME_DATA.manifest] as const;
/**
 * Bundle-time stand-ins for pixi.js subpaths. KTX2 never runs without eval. The CDN unsafe-eval script
 * installs itself on load, except that (pixi.js 8.21.0) it patches a private copy of ParticleBuffer
 * instead of PIXI.ParticleBuffer, so particle updates would still call `new Function`: patch the real one.
 */
export const STAND_INS: Readonly<Record<string, string>> = {
  'pixi.js/ktx2': 'export {};',
  'pixi.js/unsafe-eval': [
    "import { ParticleBuffer, generateParticleUpdatePolyfill } from 'pixi.js';",
    'Object.assign(ParticleBuffer.prototype, { generateParticleUpdate: generateParticleUpdatePolyfill });',
  ].join('\n'),
};
/**
 * The artifact host forbids eval, so the eval probe (which a no-eval CSP reports as a violation even
 * when the EvalError is caught) is replaced by its known answer.
 */
const CSP_MODULE = join(ROOT, 'src/core/csp.ts');
const CSP_STAND_IN = 'export function evalAllowed() { return false; }';
const BOOT_FAILURE = 'Could not start.\n\nPixiJS did not load from cdn.jsdelivr.net (blocked network or integrity mismatch).';

export interface CdnScript {
  src: string;
  integrity: string;
}

export interface PageParts {
  /** The source index.html (its <title>, <style> and body markup are reused). */
  indexHtml: string;
  cdn: readonly CdnScript[];
  files: Readonly<Record<string, string>>;
  /** The bundled game (classic script). */
  code: string;
}

function pick(html: string, re: RegExp, what: string): string {
  const m = html.match(re);
  if (!m) throw new Error(`index.html: no ${what}`);
  return m[1] ?? m[0];
}

/** JSON that is safe inside a <script> element (no `<` at all, so no `</script` or `<!--`). */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * The artifact page: title first, then style, the body markup, then the scripts in execution order
 * (classic scripts run as parsed, so #game/#ui/#boot must exist before the game script). Pure.
 */
export function assemblePage(p: PageParts): string {
  const title = pick(p.indexHtml, /<title>[\s\S]*?<\/title>/, 'title');
  const style = pick(p.indexHtml, /<style>[\s\S]*?<\/style>/, 'style');
  const body = pick(p.indexHtml, /<body>([\s\S]*?)<\/body>/, 'body')
    .replace(/<script\b[\s\S]*?<\/script>/g, '')
    .split('\n').map((l) => l.trim()).filter(Boolean).join('\n');
  // Any of these can end the inline script early or switch the HTML tokenizer into an escaped state.
  const unsafe = p.code.match(/<\/script|<!--|<script/i);
  if (unsafe) throw new Error(`bundled code contains "${unsafe[0]}"; it cannot be inlined`);
  // A blocked or tampered CDN leaves PIXI undefined: show the boot error instead of hanging on the title.
  const guarded = [
    'if (window.PIXI && PIXI.Application && PIXI.generateParticleUpdatePolyfill) {',
    p.code,
    '} else {',
    "  const boot = document.getElementById('boot');",
    `  if (boot) { boot.classList.add('error'); boot.textContent = ${JSON.stringify(BOOT_FAILURE)}; }`,
    '}',
  ].join('\n');
  return [
    title,
    style,
    body,
    ...p.cdn.map((s) => `<script src="${s.src}" integrity="${s.integrity}" crossorigin="anonymous"></script>`),
    `<script type="application/json" id="${EMBEDDED_FILES_ID}">${scriptSafeJson(p.files)}</script>`,
    `<script>${guarded}</script>`,
    '',
  ].join('\n');
}

function sri(path: string): string {
  return `sha384-${createHash('sha384').update(readFileSync(path)).digest('base64')}`;
}

/**
 * Resolve the pixi.js subpath stand-ins (an unknown subpath fails the build rather than bundling a
 * private PixiJS copy) and the eval probe; bare 'pixi.js' stays external (the PIXI global).
 */
function standIns(): Plugin {
  return {
    name: 'spiritwood-artifact-stand-ins',
    enforce: 'pre',
    resolveId(id) {
      if (id in STAND_INS) return `\0stand-in:${id}`;
      if (id.startsWith('pixi.js/')) throw new Error(`${id}: no stand-in for the CDN build (add one to STAND_INS)`);
      return null;
    },
    load(id) {
      if (id.startsWith('\0stand-in:')) return STAND_INS[id.slice('\0stand-in:'.length)] ?? null;
      return id.split('?')[0] === CSP_MODULE ? CSP_STAND_IN : null;
    },
  };
}

async function bundleGame(outDir: string, minify: boolean): Promise<string> {
  await build({
    configFile: false,
    root: ROOT,
    logLevel: 'warn',
    plugins: [standIns()],
    build: {
      outDir,
      emptyOutDir: true,
      target: 'es2022',
      minify,
      sourcemap: false,
      copyPublicDir: false,
      lib: { entry: join(ROOT, 'src/main.ts'), formats: ['iife'], name: 'Spiritwood', fileName: () => 'spiritwood.js' },
      rollupOptions: {
        external: (id) => id === 'pixi.js',
        output: { globals: { 'pixi.js': 'PIXI' } },
      },
    },
  });
  return readFileSync(join(outDir, 'spiritwood.js'), 'utf8');
}

/**
 * Names a PixiJS UMD package adds to the global: its IIFE ends `return …, p.a=…, p.b=…, p})({})` and
 * is copied onto PIXI. Throws when the format changes (re-check the bundle after a pixi.js upgrade).
 */
export function umdExportNames(src: string, bundleVar: string): string[] {
  const p = src.match(new RegExp(`var ${bundleVar}=\\(function\\((\\w+)\\)`))?.[1];
  const end = p ? src.lastIndexOf(`,${p}})({})`) : -1;
  const start = end >= 0 ? src.lastIndexOf('return ', end) : -1;
  if (!p || start < 0) throw new Error(`${bundleVar}: unrecognised UMD export block`);
  return [...src.slice(start, end).matchAll(new RegExp(`\\b${p}\\.(\\w+)=`, 'g'))].map((m) => m[1] as string);
}

/** Every name the page's two CDN scripts put on the PIXI global. */
export function cdnGlobalNames(pixiDir: string = PIXI_DIR): Set<string> {
  return new Set([
    ...umdExportNames(readFileSync(join(pixiDir, 'dist/pixi.min.js'), 'utf8'), 'PIXI'),
    ...umdExportNames(readFileSync(join(pixiDir, 'dist/packages/unsafe-eval.min.js'), 'utf8'), 'unsafe_eval_js'),
  ]);
}

/**
 * Problems with the unminified bundle, where Rollup names the global's parameter `pixi_js` and nothing
 * shadows it: PIXI names the CDN global lacks, or PixiJS itself bundled in.
 */
export function checkUnminifiedBundle(code: string, globalNames: ReadonlySet<string>): string[] {
  if (!code.startsWith('(function(pixi_js) {')) return ['expected an IIFE over pixi_js'];
  const problems: string[] = [];
  const used = new Set([...code.matchAll(/\bpixi_js\.(\w+)/g)].map((m) => m[1] as string));
  const missing = [...used].filter((n) => !globalNames.has(n));
  if (missing.length) problems.push(`uses PIXI names the CDN build lacks: ${missing.join(', ')}`);
  if (code.includes('_unsafeEvalCheck')) problems.push('bundles PixiJS internals instead of using the PIXI global');
  if (!used.has('generateParticleUpdatePolyfill')) problems.push('lacks the ParticleBuffer unsafe-eval stand-in');
  return problems;
}

/** Problems with the shipped bundle: any string compilation, which the host's CSP forbids. */
export function checkShippedBundle(code: string): string[] {
  const hits = code.match(/\beval\(|\bFunction\(/g);
  return hits ? [`compiles strings at runtime (${hits.join(', ')})`] : [];
}

function assertNoProblems(what: string, problems: readonly string[]): void {
  if (problems.length) throw new Error(`${what}: ${problems.join('; ')}`);
}

async function main(): Promise<void> {
  const outArg = process.argv[2];
  if (!outArg) throw new Error('usage: node tools/artifact/package-artifact.ts <outDir>');
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });

  const version = (JSON.parse(readFileSync(join(PIXI_DIR, 'package.json'), 'utf8')) as { version: string }).version;
  const cdn = ['dist/pixi.min.js', 'dist/packages/unsafe-eval.min.js'].map((f) => ({
    src: `https://cdn.jsdelivr.net/npm/pixi.js@${version}/${f}`,
    integrity: sri(join(PIXI_DIR, f)),
  }));
  assertNoProblems('unminified bundle', checkUnminifiedBundle(await bundleGame(join(out, 'bundle'), false), cdnGlobalNames()));
  const code = await bundleGame(join(out, 'bundle'), true);
  assertNoProblems('bundle', checkShippedBundle(code));
  const files: Record<string, string> = {};
  // Both are JSON read with res.json(); compacting drops the pretty-printing (~54 KB of the level).
  for (const path of EMBEDDED_PATHS) files[path] = JSON.stringify(JSON.parse(readFileSync(join(ROOT, 'public', path), 'utf8')));

  const page = assemblePage({ indexHtml: readFileSync(join(ROOT, 'index.html'), 'utf8'), cdn, files, code });
  writeFileSync(join(out, 'index.html'), page);
  const kb = (n: number): string => `${(n / 1024).toFixed(0)} KB`;
  console.log(`${join(out, 'index.html')}: ${kb(page.length)} (game ${kb(code.length)}; PixiJS ${version} from jsDelivr)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
