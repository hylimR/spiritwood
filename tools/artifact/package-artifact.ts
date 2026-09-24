/**
 * Package dist/ for a Claude artifact (a multi-file page): writes <out>/index.html, the page as an HTML
 * fragment (the host adds the doctype/head/body skeleton and scans the first 8 KB for <title>), and
 * <out>/files.json, the supporting-files map {publishedPath: sourcePath | {from, contentType}}.
 *
 * Artifacts don't serve .ktx2, and their CSP forbids the eval the KTX2 transcoder needs, so the package
 * ships WebP/PNG plates only: KTX2 files and the transcoder are dropped, and patched copies of the layer
 * manifests without `ktx2` sources are written to <out>/patched/.
 *
 * Usage: npm run build && node tools/artifact/package-artifact.ts <outDir>
 */
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type FileSource = string | { from: string; contentType: string };

const CONTENT_TYPES: Readonly<Record<string, string>> = { '.ldtk': 'application/json' };

function pick(html: string, re: RegExp, what: string): RegExpMatchArray {
  const m = html.match(re);
  if (!m) throw new Error(`index.html: no ${what}`);
  return m;
}

/** The dist page as an artifact fragment: title first, then style, entry script and preloads, then the body. */
export function toFragment(html: string): { page: string; refs: string[] } {
  const title = pick(html, /<title>[\s\S]*?<\/title>/, 'title')[0];
  const style = pick(html, /<style>[\s\S]*?<\/style>/, 'style')[0];
  const tags = [...html.matchAll(/<(?:script|link)\b[^>]*>(?:<\/script>)?/g)].map((m) => m[0]);
  if (!tags.some((t) => t.startsWith('<script'))) throw new Error('index.html: no entry script');
  const body = (pick(html, /<body>([\s\S]*?)<\/body>/, 'body')[1] ?? '').trim();
  const refs = tags.map((t) => t.match(/(?:src|href)="\.\/([^"]+)"/)?.[1]).filter((r): r is string => r !== undefined);
  return { page: [title, style, ...tags, body, ''].join('\n'), refs };
}

/** A layer manifest without KTX2 sources (every chunk keeps its WebP/PNG). */
export function stripKtx2(manifest: { layers?: { chunks?: { source?: { ktx2?: string } }[] }[] }): void {
  for (const layer of manifest.layers ?? []) for (const c of layer.chunks ?? []) if (c.source) delete c.source.ktx2;
}

function main(): void {
  const outArg = process.argv[2];
  if (!outArg) throw new Error('usage: node tools/artifact/package-artifact.ts <outDir>');
  const dist = fileURLToPath(new URL('../../dist/', import.meta.url));
  const out = resolve(outArg);
  mkdirSync(out, { recursive: true });

  const { page, refs } = toFragment(readFileSync(join(dist, 'index.html'), 'utf8'));
  writeFileSync(join(out, 'index.html'), page);

  const files: Record<string, FileSource> = {};
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        walk(p);
        continue;
      }
      const rel = relative(dist, p).split('\\').join('/');
      if (rel === 'index.html' || rel.endsWith('.ktx2') || rel.startsWith('transcoders/ktx/')) continue;
      if (rel.startsWith('layers/') && rel.endsWith('.json')) {
        const manifest = JSON.parse(readFileSync(p, 'utf8'));
        stripKtx2(manifest);
        const q = join(out, 'patched', rel);
        mkdirSync(dirname(q), { recursive: true });
        writeFileSync(q, JSON.stringify(manifest));
        files[rel] = q;
        continue;
      }
      const type = CONTENT_TYPES[rel.slice(rel.lastIndexOf('.'))];
      files[rel] = type ? { from: p, contentType: type } : p;
    }
  };
  walk(dist);

  const missing = refs.filter((r) => !(r in files));
  if (missing.length) throw new Error(`referenced but not packaged: ${missing.join(', ')}`);
  writeFileSync(join(out, 'files.json'), JSON.stringify(files, null, 2));
  console.log(`${join(out, 'index.html')}: ${page.length} B page, ${Object.keys(files).length} supporting files`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
