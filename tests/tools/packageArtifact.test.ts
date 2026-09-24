import { describe, expect, test } from 'vitest';
import { stripKtx2, toFragment } from '../../tools/artifact/package-artifact.ts';

const HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spiritwood</title>
    <style>#game{inset:0}</style>
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
    <link rel="modulepreload" crossorigin href="./assets/Geometry-def.js">
  </head>
  <body>
    <div id="game"></div>
    <div id="boot">Gathering light…</div>
  </body>
</html>`;

describe('toFragment', () => {
  const { page, refs } = toFragment(HTML);

  test('starts with the title and drops the document skeleton', () => {
    expect(page.startsWith('<title>Spiritwood</title>\n<style>')).toBe(true);
    for (const tag of ['<!doctype', '<html', '<head', '<body', '<meta']) expect(page.toLowerCase()).not.toContain(tag);
  });

  test('keeps the entry script, preloads and body content, and reports the referenced files', () => {
    expect(page).toContain('<script type="module" crossorigin src="./assets/index-abc.js"></script>');
    expect(page).toContain('<link rel="modulepreload" crossorigin href="./assets/Geometry-def.js">');
    expect(page).toContain('<div id="boot">Gathering light…</div>');
    expect(refs).toEqual(['assets/index-abc.js', 'assets/Geometry-def.js']);
  });

  test('rejects a page without an entry script', () => {
    expect(() => toFragment(HTML.replace(/<script[^>]*><\/script>/, ''))).toThrow(/entry script/);
  });
});

test('stripKtx2 keeps WebP/PNG sources and leaves other layers alone', () => {
  const m = {
    layers: [
      { chunks: [{ source: { ktx2: 'a.ktx2', webp: 'a.webp', png: 'a.png' } }] },
      { id: 'sky' },
    ],
  };
  stripKtx2(m);
  expect(m.layers[0]?.chunks?.[0]?.source).toEqual({ webp: 'a.webp', png: 'a.png' });
  expect(m.layers[1]).toEqual({ id: 'sky' });
});
