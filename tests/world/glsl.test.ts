import { describe, expect, test } from 'vitest';
import { SHAFT_FRAGMENT, SHAFT_VERTEX } from '../../src/render/fx/shafts.ts';
import { FOG_FRAGMENT, FOG_VERTEX } from '../../src/render/layers/fog.ts';
import { KIT_FRAGMENT, KIT_VERTEX } from '../../src/render/layers/kit.glsl.ts';
import { GLSL_VERTEX_TRANSFORM } from '../../src/render/shaders/common.ts';
import { KIT_ATTRIBUTES } from '../../src/render/layers/geometry.ts';
import { SKY_FRAGMENT, SKY_VERTEX } from '../../src/render/layers/sky.glsl.ts';
import {
  TERRAIN_CORE_FRAGMENT, TERRAIN_CORE_VERTEX, TERRAIN_EDGE_FRAGMENT, TERRAIN_EDGE_VERTEX,
} from '../../src/render/terrain/terrain.glsl.ts';
import { TERRAIN_CORE_ATTRS, TERRAIN_EDGE_ATTRS } from '../../src/render/terrain/terrainView.ts';

/**
 * No GPU in tests, so this is a static lint of every WORLD shader: GLSL ES 3.00 headers, no WebGL1
 * idioms, no reserved words as identifiers, balanced delimiters, varyings that line up between
 * stages, and no discard / gl_FragDepth in any program (opaque passes rely on early-Z).
 */
const PROGRAMS: Record<string, { vertex: string; fragment: string; attributes: string[] }> = {
  kit: { vertex: KIT_VERTEX, fragment: KIT_FRAGMENT, attributes: KIT_ATTRIBUTES.map((a) => a.name) },
  sky: { vertex: SKY_VERTEX, fragment: SKY_FRAGMENT, attributes: ['aPosition'] },
  fog: { vertex: FOG_VERTEX, fragment: FOG_FRAGMENT, attributes: ['aPosition'] },
  shafts: { vertex: SHAFT_VERTEX, fragment: SHAFT_FRAGMENT, attributes: ['aPosition', 'aShaft', 'aSeed'] },
  terrainCore: { vertex: TERRAIN_CORE_VERTEX, fragment: TERRAIN_CORE_FRAGMENT, attributes: TERRAIN_CORE_ATTRS.map((a) => a.name) },
  terrainEdge: { vertex: TERRAIN_EDGE_VERTEX, fragment: TERRAIN_EDGE_FRAGMENT, attributes: TERRAIN_EDGE_ATTRS.map((a) => a.name) },
};

// GLSL ES 3.00 §3.8: keywords reserved for future use (a compile error if used as identifiers).
const RESERVED = new Set([
  'attribute', 'varying', 'coherent', 'volatile', 'restrict', 'readonly', 'writeonly', 'resource', 'atomic_uint',
  'noperspective', 'patch', 'sample', 'subroutine', 'common', 'partition', 'active', 'asm', 'class', 'union', 'enum',
  'typedef', 'template', 'this', 'goto', 'inline', 'noinline', 'public', 'static', 'extern', 'external', 'interface',
  'long', 'short', 'double', 'half', 'fixed', 'unsigned', 'superp', 'input', 'output', 'hvec2', 'hvec3', 'hvec4',
  'dvec2', 'dvec3', 'dvec4', 'fvec2', 'fvec3', 'fvec4', 'sampler3DRect', 'filter', 'sizeof', 'cast', 'namespace', 'using',
  'buffer', 'shared', 'image2D', 'iimage2D', 'uimage2D',
]);

const TYPES = 'float|int|bool|vec2|vec3|vec4|ivec2|ivec3|ivec4|mat2|mat3|mat4|sampler2D|void';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function declared(src: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\b(?:${TYPES})\\s+([A-Za-z_]\\w*)`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1] as string);
  return out;
}

function stageVars(src: string, qualifier: 'in' | 'out'): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(`^\\s*${qualifier}\\s+(\\w+)\\s+(\\w+)\\s*;`, 'gm');
  for (let m = re.exec(src); m; m = re.exec(src)) out.set(m[2] as string, m[1] as string);
  return out;
}

/** Uniforms Pixi binds itself (global group, mesh/particle local groups): a same-named own uniform collides. */
const PIXI_RESERVED = new Set([
  'uProjectionMatrix', 'uWorldTransformMatrix', 'uWorldColorAlpha', 'uResolution', 'uTransformMatrix', 'uColor', 'uRound',
]);

function uniforms(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const s = stripComments(src);
  const re = /^\s*uniform\s+(?:(?:highp|mediump|lowp)\s+)?(\w+)\s+(\w+)\s*;/gm;
  for (let m = re.exec(s); m; m = re.exec(s)) out.set(m[2] as string, m[1] as string);
  return out;
}

function balanced(src: string): boolean {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const stack: string[] = [];
  for (const ch of src) {
    if (ch === '(' || ch === '[' || ch === '{') stack.push(ch);
    else if (ch in pairs && stack.pop() !== pairs[ch]) return false;
  }
  return stack.length === 0;
}

describe('WORLD shaders (static lint)', () => {
  for (const [name, p] of Object.entries(PROGRAMS)) {
    describe(name, () => {
      test('GLSL ES 3.00 headers and outputs', () => {
        expect(p.vertex.startsWith('#version 300 es\n')).toBe(true);
        expect(p.fragment.startsWith('#version 300 es\nprecision highp float;')).toBe(true);
        expect(p.fragment).toMatch(/\bout vec4 finalColor;/);
        expect(p.vertex).toMatch(/gl_Position\s*=\s*pixiClipPosition\(/);
      });

      test('no WebGL1 idioms, discard or depth writes', () => {
        for (const src of [p.vertex, p.fragment]) {
          expect(src).not.toMatch(/\b(gl_FragColor|texture2D|attribute|varying)\b/);
          expect(src).not.toMatch(/\bdiscard\b/);
          expect(src).not.toMatch(/gl_FragDepth/);
        }
      });

      test('no reserved words used as identifiers', () => {
        for (const id of [...declared(p.vertex), ...declared(p.fragment)]) expect(RESERVED.has(id), id).toBe(false);
      });

      test('balanced delimiters', () => {
        expect(balanced(p.vertex)).toBe(true);
        expect(balanced(p.fragment)).toBe(true);
      });

      test('fragment inputs match vertex outputs; attributes match the geometry', () => {
        const outs = stageVars(p.vertex, 'out');
        for (const [v, type] of stageVars(p.fragment, 'in')) expect(outs.get(v), v).toBe(type);
        const ins = [...stageVars(p.vertex, 'in').keys()].sort();
        expect(ins).toEqual([...p.attributes].sort());
      });

      test('uniforms shared by both stages have one type (else the program fails to link)', () => {
        const vs = uniforms(p.vertex);
        const fs = uniforms(p.fragment);
        for (const [name, type] of fs) {
          if (vs.has(name)) expect(`${name}: ${type}`, `${name} is declared in both stages`).toBe(`${name}: ${vs.get(name)}`);
        }
      });

      test("own uniforms never reuse Pixi's global/local uniform names", () => {
        const pixi = uniforms(GLSL_VERTEX_TRANSFORM);
        const own = [...uniforms(p.vertex.replace(GLSL_VERTEX_TRANSFORM, '')), ...uniforms(p.fragment)];
        for (const [name] of own) expect(pixi.has(name) || PIXI_RESERVED.has(name), name).toBe(false);
      });

      test('every function called is defined (or a GLSL builtin)', () => {
        const builtins = new Set([
          'vec2', 'vec3', 'vec4', 'mat3', 'float', 'int', 'sin', 'cos', 'exp', 'pow', 'sqrt', 'abs', 'min', 'max', 'clamp', 'mix',
          'smoothstep', 'step', 'fract', 'floor', 'dot', 'length', 'log2', 'dFdx', 'dFdy', 'textureLod', 'texture', 'textureSize',
          'if', 'for', 'return', 'while',
        ]);
        const src = stripComments(`${p.vertex}\n${p.fragment}`);
        const defined = new Set(declared(src));
        const re = /\b([A-Za-z_]\w*)\s*\(/g;
        for (let m = re.exec(src); m; m = re.exec(src)) {
          const fn = m[1] as string;
          expect(builtins.has(fn) || defined.has(fn), fn).toBe(true);
        }
      });
    });
  }
});
