import { DEPTH_TERRAIN } from '../../config.ts';
import { GLSL_DITHER, GLSL_FRAGMENT_HEADER, GLSL_NOISE, GLSL_VERSION, GLSL_VERTEX_TRANSFORM } from '../shaders/common.ts';
import {
  MOSS_BASE_COLOR, MOSS_GLOW_COLOR, SPILL_FLORA, SPILL_THORN, SPILL_WARM, TERRAIN_DEEP_COLOR, TERRAIN_EDGE_COLOR, TERRAIN_RIM_COLOR,
  TERRAIN_RIM_REACH, TERRAIN_SPILL_REACH, TERRAIN_STONE_GAIN, TERRAIN_VEIN_GAIN,
} from './terrainShading.ts';

const v3 = (c: readonly number[]): string => `vec3(${c.map((x) => x.toFixed(4)).join(', ')})`;
const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/** Shared core colour (terrainShading.ts shadeTerrainCore): depth ramp, strata, moonlit rim zone, spill. */
const CORE_COLOR = /* glsl */ `
vec3 terrainColor(float depth, vec2 world, float lit, vec3 spill) {
  float t = pow(clamp(depth / uShadeDepth, 0.0, 1.0), 0.7);
  float warp = sw_vnoise(world * 0.0045) * 70.0;
  float strata = sw_vnoise(vec2(world.x * 0.0022, (world.y + warp) * 0.026));
  float mottle = sw_vnoise(world * 0.019 + 13.1);
  vec2 rw = vec2(world.x * 0.866 - world.y * 0.5, world.x * 0.5 + world.y * 0.866);
  float sn = 0.6 * sw_vnoise(vec2(rw.x * 0.06 + 5.3, rw.y * 0.07 + 1.9)) + 0.4 * sw_vnoise(vec2(rw.y * 0.11 + 2.1, rw.x * 0.12 + 8.4));
  float stone = smoothstep(0.64, 0.72, sn);
  float vein = 1.0 - smoothstep(0.0, 0.03, abs(sw_vnoise(vec2(rw.y * 0.011 + 7.7, rw.x * 0.017 + 3.1)) - 0.5));
  vec3 c = mix(${v3(TERRAIN_EDGE_COLOR)}, ${v3(TERRAIN_DEEP_COLOR)}, t) * (1.0 + 0.55 * (strata - 0.5) + 0.3 * (mottle - 0.5))
    * (1.0 + ${f(TERRAIN_STONE_GAIN)} * stone + ${f(TERRAIN_VEIN_GAIN)} * vein * (1.0 - t));
  c += ${v3(TERRAIN_RIM_COLOR)} * (lit * exp(-depth / ${f(TERRAIN_RIM_REACH)}));
  c += (${v3(SPILL_WARM)} * spill.x + ${v3(SPILL_FLORA)} * spill.y + ${v3(SPILL_THORN)} * spill.z) * exp(-depth / ${f(TERRAIN_SPILL_REACH)});
  return c;
}
`;

export const TERRAIN_CORE_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
in float aDist;
in float aLit;
in vec4 aSpill;
${GLSL_VERTEX_TRANSFORM}
out vec2 vWorld;
out float vDist;
out float vLit;
out vec3 vSpill;

void main() {
  gl_Position = pixiClipPosition(aPosition, ${DEPTH_TERRAIN.toFixed(4)});
  vWorld = aPosition;
  vDist = aDist;
  vLit = aLit;
  vSpill = aSpill.xyz;
}
`;

/** Opaque pre-pass: never discards, never writes gl_FragDepth. */
export const TERRAIN_CORE_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vWorld;
in float vDist;
in float vLit;
in vec3 vSpill;
uniform float uShadeDepth;
out vec4 finalColor;
${GLSL_NOISE}
${GLSL_DITHER}
${CORE_COLOR}

void main() {
  finalColor = vec4(terrainColor(vDist, vWorld, vLit, vSpill) + sw_dither(gl_FragCoord.xy), 1.0);
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

void main() {
  float side = aEdge.x;
  float off = aEdge.y > 0.5 ? (side < 0.0 ? side * uMossIn : side * uMossOut) : side * uAA;
  vec2 p = aPosition + aNormal * off;
  gl_Position = pixiClipPosition(p, 0.0);
  vWorld = p;
  vEdge = aEdge.xyz;
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
uniform float uShadeDepth;
uniform float uGlowPass;
uniform float uGlow;
out vec4 finalColor;
${GLSL_NOISE}
${GLSL_DITHER}
${CORE_COLOR}

void main() {
  float side = vEdge.x;
  if (vEdge.y < 0.5) {
    if (uGlowPass > 0.5) {
      finalColor = vec4(0.0);
      return;
    }
    float a = clamp((1.0 - side) * 0.5, 0.0, 1.0);
    finalColor = vec4((terrainColor(0.0, vWorld, vLit, vSpill) + sw_dither(gl_FragCoord.xy)) * a, a);
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
