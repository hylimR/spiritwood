import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assemblePage, cdnGlobalNames, checkShippedBundle, checkUnminifiedBundle, EMBEDDED_PATHS, EMBEDDED_SOURCES, scriptSafeJson, STAND_INS,
  umdExportNames,
} from '../../tools/artifact/package-artifact.ts';
import { EMBEDDED_FILES_ID, GAME_DATA, parseEmbeddedFiles } from '../../src/assets/embedded.ts';

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

  const embeddedJson = (): string => {
    const open = `<script type="application/json" id="${EMBEDDED_FILES_ID}">`;
    const start = page.indexOf(open) + open.length;
    return page.slice(start, page.indexOf('</script>', start));
  };

  test('puts the markup before the scripts, and the CDN scripts before the game', () => {
    const at = (s: string): number => page.indexOf(s);
    expect(at('<div id="boot">')).toBeLessThan(at('<script'));
    expect(at('pixi.min.js')).toBeLessThan(at(`id="${EMBEDDED_FILES_ID}"`));
    expect(at(`id="${EMBEDDED_FILES_ID}"`)).toBeLessThan(at(PARTS.code));
    expect(page).toContain('integrity="sha384-abc" crossorigin="anonymous"');
  });

  test('runs the game only when the CDN global is complete, else shows the boot error', () => {
    const script = page.slice(page.lastIndexOf('<script>') + 8, page.lastIndexOf('</script>'));
    const runGuard = (PIXI: unknown): { ran: boolean; boot: { cls: string[]; textContent: string } } => {
      const boot = { cls: [] as string[], textContent: 'Gathering light…', classList: { add: (c: string) => boot.cls.push(c) } };
      const state = { ran: false };
      const body = script.replace(PARTS.code, 'state.ran = true;');
      new Function('window', 'PIXI', 'document', 'state', body)({ PIXI }, PIXI, { getElementById: (id: string) => (id === 'boot' ? boot : null) }, state);
      return { ran: state.ran, boot };
    };
    expect(runGuard({ Application: {}, generateParticleUpdatePolyfill: {} }).ran).toBe(true);
    for (const partial of [undefined, {}, { Application: {} }]) {
      const r = runGuard(partial);
      expect(r.ran).toBe(false);
      expect(r.boot.cls).toEqual(['error']);
      expect(r.boot.textContent).toMatch(/^Could not start\.\n\nPixiJS did not load/);
    }
  });

  test('embedded data cannot close its script element and reads back through parseEmbeddedFiles', () => {
    const json = embeddedJson();
    expect(json).not.toContain('<');
    const files = parseEmbeddedFiles(json, 'https://h.example/a/index.html');
    expect(files.get('https://h.example/a/levels/forest.ldtk')).toBe(PARTS.files['levels/forest.ldtk']);
  });

  test('refuses code that would end the inline script early or change the tokenizer state', () => {
    for (const code of ['x="</script>"', 'x="<!--"', 'x="<SCRIPT>"']) {
      expect(() => assemblePage({ ...PARTS, code })).toThrow(/cannot be inlined/);
    }
  });
});

test('the page embeds exactly the data the game requests', () => {
  expect(EMBEDDED_PATHS).toEqual([GAME_DATA.level, GAME_DATA.manifest]);
});

test('the embedded manifest has no plate layers (the page ships no image files, §5.8)', () => {
  const root = new URL('../../public/', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL(EMBEDDED_SOURCES[GAME_DATA.manifest], root), 'utf8')) as {
    layers: { kind: string }[];
    replaced?: unknown;
  };
  expect(manifest.layers.length).toBeGreaterThan(0);
  expect(manifest.layers.filter((l) => l.kind === 'plate')).toEqual([]);
  expect(manifest.replaced).toBeUndefined();
  // The served manifest does carry plates, so the substitution is what keeps them out of the page.
  const served = JSON.parse(readFileSync(new URL(GAME_DATA.manifest, root), 'utf8')) as { layers: { kind: string }[] };
  expect(served.layers.some((l) => l.kind === 'plate')).toBe(true);
});

describe('stand-ins', () => {
  const srcFiles = (dir: string): string[] => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith('.ts') ? [p] : [];
  });

  test('every pixi.js subpath the game imports has one (else the build would bundle a private PixiJS)', () => {
    const subpaths = new Set<string>();
    for (const f of srcFiles(new URL('../../src', import.meta.url).pathname)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/(?:from\s+|import\s*\(?\s*)'(pixi\.js\/[^']+)'/g)) subpaths.add(m[1] as string);
    }
    expect([...subpaths].sort()).toEqual(Object.keys(STAND_INS).sort());
  });

  test('the unsafe-eval stand-in patches the real ParticleBuffer with the CDN polyfill', () => {
    expect(STAND_INS['pixi.js/unsafe-eval']).toContain(
      'Object.assign(ParticleBuffer.prototype, { generateParticleUpdate: generateParticleUpdatePolyfill })',
    );
  });
});

describe('bundle checks', () => {
  const names = cdnGlobalNames();

  test('the CDN global is read from the UMD files the page loads', () => {
    for (const n of ['Application', 'Assets', 'ParticleBuffer', 'generateParticleUpdatePolyfill']) expect(names.has(n)).toBe(true);
    // ESM-only names: in the npm module, not on the UMD global.
    for (const n of ['OverlayBlend', 'WebWorkerAdapter']) expect(names.has(n)).toBe(false);
  });

  test('flags names the global lacks, bundled PixiJS and a missing particle stand-in', () => {
    const ok = '(function(pixi_js) {\n pixi_js.Assets; pixi_js.generateParticleUpdatePolyfill;\n})(PIXI);';
    expect(checkUnminifiedBundle(ok, names)).toEqual([]);
    expect(checkUnminifiedBundle(ok.replace('pixi_js.Assets', 'pixi_js.OverlayBlend'), names).join()).toMatch(/OverlayBlend/);
    expect(checkUnminifiedBundle(ok.replace('Assets;', 'Assets; x._unsafeEvalCheck;'), names).join()).toMatch(/internals/);
    expect(checkUnminifiedBundle(ok.replace(' pixi_js.generateParticleUpdatePolyfill;', ''), names).join()).toMatch(/stand-in/);
    expect(checkUnminifiedBundle('var x=1;', names)).toEqual(['expected an IIFE over pixi_js']);
  });

  test('flags string compilation in the shipped bundle', () => {
    expect(checkShippedBundle('a.b(1);c()')).toEqual([]);
    expect(checkShippedBundle('try{Function(``)}catch{}')).toHaveLength(1);
    expect(checkShippedBundle('eval("1")')).toHaveLength(1);
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
