/**
 * Data files inlined into the page by the single-file artifact build (tools/artifact/package-artifact.ts):
 * `<script type="application/json" id="spiritwood-files">` holding `{ "levels/forest.ldtk": "<text>", … }`.
 * Hosts that review one self-contained page for public sharing (Claude artifacts) get no supporting files,
 * so the loaders read these through `embeddedFetch` instead of the network.
 */
export const EMBEDDED_FILES_ID = 'spiritwood-files';

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Parse the embedded JSON into a map keyed by absolute URL (paths resolve against `base`). Throws on bad data. */
export function parseEmbeddedFiles(json: string, base: string): Map<string, string> {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('embedded files: expected an object');
  const files = new Map<string, string>();
  for (const [path, text] of Object.entries(raw)) {
    if (typeof text !== 'string') throw new Error(`embedded files: ${path} is not a string`);
    files.set(new URL(path, base).href, text);
  }
  return files;
}

/** The page's embedded files, or null when the page has none (the normal multi-file build). */
export function readEmbeddedFiles(doc: Pick<Document, 'getElementById' | 'baseURI'>): Map<string, string> | null {
  const el = doc.getElementById(EMBEDDED_FILES_ID);
  return el ? parseEmbeddedFiles(el.textContent ?? '', doc.baseURI) : null;
}

/** A fetch that answers embedded paths from memory and passes every other request to `fallback`. */
export function embeddedFetch(files: ReadonlyMap<string, string>, base: string, fallback: FetchFn): FetchFn {
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), base);
    const text = files.get(url.href);
    if (text === undefined) return fallback(input, init);
    const type = /\.(?:json|ldtk)$/.test(url.pathname) ? 'application/json' : 'text/plain';
    return Promise.resolve(new Response(text, { status: 200, headers: { 'content-type': type } }));
  };
}
