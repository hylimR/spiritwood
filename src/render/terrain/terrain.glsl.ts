import { DEPTH_TERRAIN } from '../../config.ts';
import { GLSL_DITHER, GLSL_FRAGMENT_HEADER, GLSL_NOISE, GLSL_VERSION, GLSL_VERTEX_TRANSFORM } from '../shaders/common.ts';
import { MOON_DIR } from './terrainLight.ts';
import {
  MOSS_BASE_COLOR, MOSS_GLOW_COLOR, SPILL_FLORA, SPILL_THORN, SPILL_WARM, TERRAIN_BAND_SWING, TERRAIN_BAND_TINT, TERRAIN_CORE_COLOR,
  TERRAIN_CREVICE_DARK, TERRAIN_DEEP_COLOR, TERRAIN_DEEP_REACH, TERRAIN_EDGE_COLOR, TERRAIN_GLINT_CELL, TERRAIN_GLINT_DENSITY,
  TERRAIN_GLINT_MINERAL, TERRAIN_GLINT_MOSS, TERRAIN_PEBBLE_GAIN, TERRAIN_RIM_COLOR, TERRAIN_RIM_REACH, TERRAIN_ROOT_GAIN,
  TERRAIN_SEAM_DARK, TERRAIN_SPILL_REACH, TERRAIN_STONE_BEVEL, TERRAIN_STONE_CELL, TERRAIN_STONE_GAIN, TERRAIN_STONE_SHARE,
  TERRAIN_STROKE_CELLS, TERRAIN_STROKE_CLAMP, TERRAIN_STROKE_CONT_MAX, TERRAIN_STROKE_DEPTH, TERRAIN_STROKE_EDGE, TERRAIN_STROKE_FULL,
  TERRAIN_STROKE_GAIN, TERRAIN_STROKE_KD, TERRAIN_STROKE_KS, TERRAIN_VEIN_GAIN,
} from './terrainShading.ts';

const v2 = (c: readonly number[]): string => `vec2(${c.map((x) => x.toFixed(4)).join(', ')})`;
const v3 = (c: readonly number[]): string => `vec3(${c.map((x) => x.toFixed(4)).join(', ')})`;
const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/**
 * Shared core colour (terrainShading.ts shadeTerrainCore): rim-zone ramp and deep-interior drift, broad
 * strata bands and seams, fine strata (near the surface: painterly strokes along the outline), mottling,
 * pebbles, rootlets, roots, embedded stones, glints, the moonlit rim zone and baked spill. 9 value-noise
 * lookups and 2 hashes per fragment.
 *
 * `stroke` is the stroke coordinate in lattice cells (s·TERRAIN_STROKE_KS, d·TERRAIN_STROKE_KD) and
 * `strokeAA` its fade: the fwidth clamp (terrainStrokeAA, evaluated in main: derivatives need uniform
 * control flow) × the vertices' continuity weight.
 */
const CORE_COLOR = /* glsl */ `
float terrainLattice(float i, float j) {
  float h = step(${f(TERRAIN_STROKE_CELLS / 2 - 0.5)}, i);
  float v = sw_hash21(vec2(i - ${f(TERRAIN_STROKE_CELLS / 2)} * h + 61.3, j + 27.9));
  return mix(v, 1.0 - v, h);
}
float terrainStroke(vec2 c) {
  vec2 i = floor(c);
  vec2 f = fract(c);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float i0 = mod(i.x + 0.5, ${f(TERRAIN_STROKE_CELLS)}) - 0.5;
  float i1 = mod(i.x + 1.5, ${f(TERRAIN_STROKE_CELLS)}) - 0.5;
  float j1 = i.y + 1.0;
  float n = mix(mix(terrainLattice(i0, i.y), terrainLattice(i1, i.y), u.x), mix(terrainLattice(i0, j1), terrainLattice(i1, j1), u.x), u.y);
  return smoothstep(${f(TERRAIN_STROKE_EDGE[0])}, ${f(TERRAIN_STROKE_EDGE[1])}, n);
}
float terrainStrokeAA(vec2 c) {
  return 1.0 - smoothstep(${f(TERRAIN_STROKE_CLAMP)}, ${f(2 * TERRAIN_STROKE_CLAMP)}, max(fwidth(c.x), fwidth(c.y)));
}
vec3 terrainColor(float depth, vec2 world, float lit, vec3 spill, vec2 stroke, float strokeAA) {
  float t = pow(clamp(depth / uShadeDepth, 0.0, 1.0), 0.7);
  float k = clamp((depth - uShadeDepth) / ${f(TERRAIN_DEEP_REACH)}, 0.0, 1.0);
  float warp = sw_vnoise(world * 0.0045) * 70.0;
  float strata = sw_vnoise(vec2(world.x * 0.0022, (world.y + warp) * 0.026));
  float sv = 0.5 + ${f(TERRAIN_STROKE_GAIN)} * (terrainStroke(stroke) - 0.5);
  strata = mix(strata, sv, (1.0 - smoothstep(${f(TERRAIN_STROKE_FULL)}, ${f(TERRAIN_STROKE_DEPTH)}, depth)) * strokeAA);
  float mottle = sw_vnoise(world * 0.019 + 13.1);
  float band = sw_vnoise(vec2(world.x * 0.0011 + 3.1, (world.y + warp * 1.5) * 0.0072 + 7.3));
  float seam = 1.0 - smoothstep(0.0, 0.016, abs(band - 0.5));
  vec2 rw = vec2(world.x * 0.866 - world.y * 0.5, world.x * 0.5 + world.y * 0.866);
  float sn = 0.6 * sw_vnoise(vec2(rw.x * 0.06 + 5.3, rw.y * 0.07 + 1.9)) + 0.4 * sw_vnoise(vec2(rw.y * 0.11 + 2.1, rw.x * 0.12 + 8.4));
  float pebble = smoothstep(0.64, 0.72, sn);
  float vein = 1.0 - smoothstep(0.0, 0.03, abs(sw_vnoise(vec2(rw.y * 0.011 + 7.7, rw.x * 0.017 + 3.1)) - 0.5));
  float root = (1.0 - smoothstep(0.0, 0.022, abs(sw_vnoise(vec2(rw.x * 0.0095 + 1.3, rw.y * 0.0032 + 4.9)) - 0.5)))
    * smoothstep(0.3, 0.62, band);
  vec2 q = rw / ${f(TERRAIN_STONE_CELL)};
  vec2 qi = floor(q);
  float hs = sw_hash21(qi + vec2(41.7, 12.9));
  float su = fract(hs * 7.3);
  float sr = (0.11 + 0.23 * su * su) * ${f(TERRAIN_STONE_CELL)};
  vec2 sq = (q - qi) * ${f(TERRAIN_STONE_CELL)} - (sr + (${f(TERRAIN_STONE_CELL)} - 2.0 * sr) * fract(hs * vec2(31.1, 57.7)));
  float asp = 0.62 + 0.38 * fract(hs * 91.3);
  vec2 se = vec2(sq.x, sq.y / asp);
  float sd = length(se) / sr * (1.0 + 0.5 * (sn - 0.5) + 0.4 * (mottle - 0.5));
  float has = 1.0 - step(${f(TERRAIN_STONE_SHARE)}, hs);
  float body = has * (1.0 - smoothstep(0.9, 1.0, sd));
  vec2 sn2 = vec2(se.x, se.y / asp);
  float facing = dot(vec2(0.866 * sn2.x + 0.5 * sn2.y, -0.5 * sn2.x + 0.866 * sn2.y), ${v2(MOON_DIR)}) / (length(sn2) + 1e-6);
  float crevice = has * smoothstep(0.98, 1.05, sd) * (1.0 - smoothstep(1.05, 1.2, sd)) * (0.2 + 0.8 * smoothstep(-0.2, 0.7, -facing));
  float lum = (1.0 + 0.55 * (1.0 - 0.45 * k) * (strata - 0.5) + 0.3 * (mottle - 0.5))
    * (${f(1 - TERRAIN_BAND_SWING / 2)} + ${f(TERRAIN_BAND_SWING)} * band) * (1.0 - ${f(TERRAIN_SEAM_DARK)} * seam)
    * (1.0 - ${f(TERRAIN_CREVICE_DARK)} * crevice);
  float detail = 1.0 + ${f(TERRAIN_PEBBLE_GAIN)} * pebble + ${f(TERRAIN_VEIN_GAIN)} * vein * (1.0 - 0.6 * t)
    + ${f(TERRAIN_ROOT_GAIN)} * root + ${f(TERRAIN_STONE_GAIN)} * body + ${f(TERRAIN_STONE_BEVEL)} * body * min(sd, 1.0) * facing;
  vec3 tint = mix(vec3(1.0), ${v3(TERRAIN_BAND_TINT)}, smoothstep(0.35, 0.65, band));
  vec3 c = mix(${v3(TERRAIN_EDGE_COLOR)}, mix(${v3(TERRAIN_DEEP_COLOR)}, ${v3(TERRAIN_CORE_COLOR)}, k), t) * tint * (lum * detail);
  vec2 gc = floor(world / ${f(TERRAIN_GLINT_CELL)});
  float gh = sw_hash21(gc + vec2(17.3, 5.1));
  vec2 gp = (gc + 0.2 + 0.6 * fract(gh * vec2(13.7, 71.3))) * ${f(TERRAIN_GLINT_CELL)};
  float glint = step(${f(1 - TERRAIN_GLINT_DENSITY)}, gh) * (1.0 - smoothstep(0.6, 2.8, length(world - gp)));
  c += mix(${v3(TERRAIN_GLINT_MOSS)}, ${v3(TERRAIN_GLINT_MINERAL)}, step(0.5, fract(gh * 431.7))) * glint;
  c += ${v3(TERRAIN_RIM_COLOR)} * (lit * exp(-depth / ${f(TERRAIN_RIM_REACH)}));
  c += (${v3(SPILL_WARM)} * spill.x + ${v3(SPILL_FLORA)} * spill.y + ${v3(SPILL_THORN)} * spill.z) * exp(-depth / ${f(TERRAIN_SPILL_REACH)});
  return c;
}
`;

/** Stroke coordinate (s, d) → lattice cells. */
const STROKE_SCALE = `vec2(${TERRAIN_STROKE_KS.toFixed(8)}, ${TERRAIN_STROKE_KD.toFixed(8)})`;
/** aSpill.w (unorm8) → the stroke continuity weight (0..1). */
const CONT_SCALE = (255 / TERRAIN_STROKE_CONT_MAX).toFixed(6);

export const TERRAIN_CORE_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
in float aDist;
in float aLit;
in vec4 aSpill;
in vec2 aStroke;
${GLSL_VERTEX_TRANSFORM}
out vec2 vWorld;
out float vDist;
out float vLit;
out vec3 vSpill;
out vec3 vStroke;

void main() {
  gl_Position = pixiClipPosition(aPosition, ${DEPTH_TERRAIN.toFixed(4)});
  vWorld = aPosition;
  vDist = aDist;
  vLit = aLit;
  vSpill = aSpill.xyz;
  vStroke = vec3(aStroke * ${STROKE_SCALE}, min(1.0, aSpill.w * ${CONT_SCALE}));
}
`;

/** Opaque pre-pass: never discards, never writes gl_FragDepth. */
export const TERRAIN_CORE_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vWorld;
in float vDist;
in float vLit;
in vec3 vSpill;
in vec3 vStroke;
uniform float uShadeDepth;
out vec4 finalColor;
${GLSL_NOISE}
${GLSL_DITHER}
${CORE_COLOR}

void main() {
  float strokeAA = terrainStrokeAA(vStroke.xy) * vStroke.z;
  finalColor = vec4(terrainColor(vDist, vWorld, vLit, vSpill, vStroke.xy, strokeAA) + sw_dither(gl_FragCoord.xy), 1.0);
}
`;

export const TERRAIN_EDGE_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
in vec2 aNormal;
in vec4 aEdge;
in vec4 aSpill;
${GLSL_VERTEX_TRANSFORM}
uniform float uAA;
uniform float uMossIn;
uniform float uMossOut;
out vec2 vWorld;
out vec3 vEdge;
out vec3 vSpill;
out float vLit;
out vec2 vStrokeS;

void main() {
  float side = aEdge.x;
  float off = aEdge.y > 0.5 ? (side < 0.0 ? side * uMossIn : side * uMossOut) : side * uAA;
  vec2 p = aPosition + aNormal * off;
  gl_Position = pixiClipPosition(p, 0.0);
  vWorld = p;
  vEdge = aEdge.xyz;
  vStrokeS = vec2(aEdge.w * ${TERRAIN_STROKE_KS.toFixed(8)}, min(1.0, aSpill.w * ${CONT_SCALE}));
  vSpill = aSpill.xyz;
  float l = max(length(aNormal), 1e-6);
  vLit = max(0.0, dot(aNormal / l, vec2(-0.55, -0.83)));
}
`;

/**
 * Edge strips: kind 0 = AA feather (surface colour fading outward), kind 1 = moss lip (tufted teal
 * crust on up-facing edges, overhanging slightly). With uGlowPass = 1 only the moss light is output,
 * alpha 0 (additive twin).
 */
export const TERRAIN_EDGE_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vWorld;
in vec3 vEdge;
in vec3 vSpill;
in float vLit;
in vec2 vStrokeS;
uniform float uShadeDepth;
uniform float uGlowPass;
uniform float uGlow;
out vec4 finalColor;
${GLSL_NOISE}
${GLSL_DITHER}
${CORE_COLOR}

void main() {
  float side = vEdge.x;
  vec2 stroke = vec2(vStrokeS.x, 0.0);
  float strokeAA = terrainStrokeAA(stroke) * vStrokeS.y;
  if (vEdge.y < 0.5) {
    if (uGlowPass > 0.5) {
      finalColor = vec4(0.0);
      return;
    }
    float a = clamp((1.0 - side) * 0.5, 0.0, 1.0);
    finalColor = vec4((terrainColor(0.0, vWorld, vLit, vSpill, stroke, strokeAA) + sw_dither(gl_FragCoord.xy)) * a, a);
    return;
  }
  float mossPatch = sw_vnoise(vWorld * 0.07);
  float tuft = sw_vnoise(vec2(vWorld.x * 0.42 + 3.7, vWorld.y * 0.12));
  float outer = smoothstep(0.1, 1.0, side);
  float prof = smoothstep(-1.0, -0.2, side) * (1.0 - smoothstep(0.2 + 0.75 * tuft, 1.02, side) * outer);
  float a = prof * smoothstep(0.12, 0.55, vEdge.z) * (0.35 + 0.65 * smoothstep(0.3, 0.62, mossPatch));
  float speck = smoothstep(0.6, 0.88, sw_vnoise(vWorld * 0.62 + vec2(30.0, 0.0)));
  if (uGlowPass > 0.5) {
    finalColor = vec4(${v3(MOSS_GLOW_COLOR)} * (a * (0.2 + 0.8 * speck) * uGlow), 0.0);
    return;
  }
  vec3 c = mix(${v3(MOSS_BASE_COLOR)}, ${v3(MOSS_GLOW_COLOR)}, 0.22 + 0.78 * speck) + ${v3(SPILL_WARM)} * (vSpill.x * 0.6);
  finalColor = vec4(c * a, a * 0.94);
}
`;
