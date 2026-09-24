import { describe, expect, test } from 'vitest';
import { EMBEDDED_FILES_ID, embeddedFetch, parseEmbeddedFiles, readEmbeddedFiles } from '../../src/assets/embedded.ts';

const BASE = 'https://host.example/art/abc/index.html';

describe('parseEmbeddedFiles', () => {
  test('keys resolve against the page base', () => {
    const files = parseEmbeddedFiles(JSON.stringify({ 'levels/forest.ldtk': '{"a":1}' }), BASE);
    expect([...files.keys()]).toEqual(['https://host.example/art/abc/levels/forest.ldtk']);
  });

  test('rejects anything but an object of strings', () => {
    for (const bad of ['[]', 'null', '"x"', '{"a":1}']) expect(() => parseEmbeddedFiles(bad, BASE)).toThrow(/embedded files/);
    expect(() => parseEmbeddedFiles('{', BASE)).toThrow();
  });
});

describe('readEmbeddedFiles', () => {
  test('null without the element, the parsed files with it', () => {
    expect(readEmbeddedFiles({ baseURI: BASE, getElementById: () => null })).toBeNull();
    const el = { textContent: JSON.stringify({ 'layers/forest.manifest.json': '{}' }) } as HTMLElement;
    const doc = { baseURI: BASE, getElementById: (id: string) => (id === EMBEDDED_FILES_ID ? el : null) };
    expect(readEmbeddedFiles(doc)?.has('https://host.example/art/abc/layers/forest.manifest.json')).toBe(true);
  });
});

describe('embeddedFetch', () => {
  const files = parseEmbeddedFiles(JSON.stringify({ 'levels/forest.ldtk': '{"level":true}', 'notes/a.txt': 'hi' }), BASE);
  const calls: string[] = [];
  const fallback = (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    return Promise.resolve(new Response('net', { status: 200 }));
  };
  const f = embeddedFetch(files, BASE, fallback);

  test('answers embedded paths from memory, however the URL is spelled', async () => {
    for (const url of ['levels/forest.ldtk', './levels/forest.ldtk', 'https://host.example/art/abc/levels/forest.ldtk']) {
      const res = await f(url);
      expect(res.ok).toBe(true);
      expect(res.headers.get('content-type')).toBe('application/json');
      expect(await res.json()).toEqual({ level: true });
    }
    expect((await f(new Request('https://host.example/art/abc/notes/a.txt'))).headers.get('content-type')).toBe('text/plain');
    expect(calls).toEqual([]);
  });

  test('passes everything else to the fallback unchanged', async () => {
    expect(await (await f('layers/other.json')).text()).toBe('net');
    expect(calls).toEqual(['layers/other.json']);
  });
});
