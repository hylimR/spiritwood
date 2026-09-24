/**
 * Deterministic, diff-friendly JSON: two-space indentation, but arrays of numbers and strings and
 * small objects stay on one line (long number arrays wrap at `width` columns). Parsing the output gives
 * back the input.
 */
export function formatJson(value: unknown, width = 120): string {
  return `${fmt(value, '', width)}\n`;
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean';
}

function keysOf(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => o[k] !== undefined);
}

/** One-line form: `[1, 2]`, `{ "a": 1, "b": [2] }`. */
function inline(v: unknown): string {
  if (isPrimitive(v) || v === undefined) return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(inline).join(', ')}]`;
  const o = v as Record<string, unknown>;
  const keys = keysOf(o);
  return keys.length === 0 ? '{}' : `{ ${keys.map((k) => `${JSON.stringify(k)}: ${inline(o[k])}`).join(', ')} }`;
}

function fmt(v: unknown, indent: string, width: number): string {
  if (isPrimitive(v) || v === undefined) return JSON.stringify(v ?? null);
  const inner = `${indent}  `;
  const one = inline(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (indent.length + one.length <= width) return one;
    if (v.every(isPrimitive)) {
      // Wrap long primitive arrays (hull rects) into lines of at most `width` columns.
      const lines: string[] = [];
      let line = '';
      for (let i = 0; i < v.length; i++) {
        const item = `${JSON.stringify(v[i])}${i < v.length - 1 ? ',' : ''}`;
        if (line && inner.length + line.length + 1 + item.length > width) {
          lines.push(line);
          line = item;
        } else {
          line = line ? `${line} ${item}` : item;
        }
      }
      if (line) lines.push(line);
      return `[\n${lines.map((l) => inner + l).join('\n')}\n${indent}]`;
    }
    return `[\n${v.map((x) => inner + fmt(x, inner, width)).join(',\n')}\n${indent}]`;
  }
  const o = v as Record<string, unknown>;
  const keys = keysOf(o);
  if (keys.length === 0) return '{}';
  if (indent.length + one.length <= width) return one;
  return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${fmt(o[k], inner, width)}`).join(',\n')}\n${indent}}`;
}
