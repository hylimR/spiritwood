import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { assemblePage, scriptSafeJson, umdExportNames } from '../../tools/artifact/package-artifact.ts';
import { EMBEDDED_FILES_ID } from '../../src/assets/embedded.ts';

const INDEX = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Spiritwood</title>
    <style>
      #game { inset: 0; }
    </style>
  </head>
  <body>
    <div id="game"></div>
    <div id="boot">Gathering light…</div>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>`;

const PARTS = {
  indexHtml: INDEX,
  cdn: [{ src: 'https://cdn.jsdelivr.net/npm/pixi.js@8.21.0/dist/pixi.min.js', integrity: 'sha384-abc' }],
  files: { 'levels/forest.ldtk': '{"x":"</script><!--"}' },
  code: '(function(e){e.go()})(PIXI);',
};

describe('assemblePage', () => {
  const page = assemblePage(PARTS);

  test('starts with the title and has no document skeleton or module entry', () => {
    expect(page.startsWith('<title>Spiritwood</title>\n<style>')).toBe(true);
    for (const tag of ['<!doctype', '<html', '<head', '<body', '<meta', 'type="module"', '/src/main.ts']) {
      expect(page.toLowerCase()).not.toContain(tag.toLowerCase());
    }
  });

  test('puts the markup before the scripts, and the CDN scripts before the game', () => {
    const at = (s: string): number => page.indexOf(s);
    expect(at('<div id="boot">')).toBeLessThan(at('<script'));
    expect(at('pixi.min.js')).toBeLessThan(at(`id="${EMBEDDED_FILES_ID}"`));
    expect(at(`id="${EMBEDDED_FILES_ID}"`)).toBeLessThan(at('<script>(function(e)'));
    expect(page).toContain('integrity="sha384-abc" crossorigin="anonymous"');
  });

  test('embedded data cannot close its script element', () => {
    const json = page.slice(page.indexOf(`id="${EMBEDDED_FILES_ID}">`) + EMBEDDED_FILES_ID.length + 6, page.indexOf('</script>\n<script>('));
    expect(json).not.toContain('<');
    expect(JSON.parse(json)).toEqual(PARTS.files);
  });

  test('refuses code that would end the inline script early', () => {
    expect(() => assemblePage({ ...PARTS, code: 'x="</script>"' })).toThrow(/cannot be inlined/);
  });
});

test('scriptSafeJson round-trips and escapes every <', () => {
  const v = { a: '<b>', c: ['</script>', '<!--'] };
  expect(scriptSafeJson(v)).not.toContain('<');
  expect(JSON.parse(scriptSafeJson(v))).toEqual(v);
});

describe('umdExportNames', () => {
  test('reads the export block of a PixiJS UMD package', () => {
    const src = 'this.PIXI=this.PIXI||{};var unsafe_eval_js=(function(h){"use strict";function k(){}return k(),h.alpha=1,h.beta=2,h})({});Object.assign(this.PIXI,unsafe_eval_js);';
    expect(umdExportNames(src, 'unsafe_eval_js')).toEqual(['alpha', 'beta']);
  });

  test('finds the particle polyfill in the installed pixi.js unsafe-eval build (the stand-in relies on it)', () => {
    const src = readFileSync(new URL('../../node_modules/pixi.js/dist/packages/unsafe-eval.min.js', import.meta.url), 'utf8');
    expect(umdExportNames(src, 'unsafe_eval_js')).toContain('generateParticleUpdatePolyfill');
  });

  test('throws when the format is not recognised', () => {
    expect(() => umdExportNames('var other=1;', 'unsafe_eval_js')).toThrow(/unrecognised/);
  });
});
