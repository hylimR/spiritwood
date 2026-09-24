import { DEPTH_TERRAIN } from '../../config.ts';
import { GLSL_DITHER, GLSL_FRAGMENT_HEADER, GLSL_NOISE, GLSL_VERSION, GLSL_VERTEX_TRANSFORM } from '../shaders/common.ts';
import { MOSS_BASE_COLOR, MOSS_GLOW_COLOR, TERRAIN_DEEP_COLOR, TERRAIN_EDGE_COLOR } from './terrainShading.ts';

const v3 = (c: readonly number[]): string => `vec3(${c.map((x) => x.toFixed(4)).join(', ')})`;

/** Shared core colour function (depth inside → edge-to-silhouette ramp with world-space mottling). */
const CORE_COLOR = /* glsl */ `
vec3 terrainColor(float depth, vec2 world) {
  float t = pow(clamp(depth / uShadeDepth, 0.0, 1.0), 0.65);
  float mottle = (sw_vnoise(world * 0.006) * 0.6 + sw_vnoise(world * 0.021 + 13.1) * 0.4) * 2.0 - 1.0;
  return mix(${v3(TERRAIN_EDGE_COLOR)}, ${v3(TERRAIN_DEEP_COLOR)}, t) * (1.0 + 0.22 * mottle);
}
`;

export const TERRAIN_CORE_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
in float aDist;
${GLSL_VERTEX_TRANSFORM}
out vec2 vWorld;
out float vDist;

void main() {
  gl_Position = pixiClipPosition(aPosition, ${DEPTH_TERRAIN.toFixed(4)});
  vWorld = aPosition;
  vDist = aDist;
}
`;

/** Opaque pre-pass: never discards, never writes gl_FragDepth. */
export const TERRAIN_CORE_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vWorld;
in float vDist;
uniform float uShadeDepth;
out vec4 finalColor;
${GLSL_NOISE}
${GLSL_DITHER}
${CORE_COLOR}

void main() {
  finalColor = vec4(terrainColor(vDist, vWorld) + sw_dither(gl_FragCoord.xy), 1.0);
}
`;

export const TERRAIN_EDGE_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
in vec2 aNormal;
in vec4 aEdge;
${GLSL_VERTEX_TRANSFORM}
uniform float uAA;
uniform float uMossIn;
uniform float uMossOut;
out vec2 vWorld;
out vec3 vEdge;

void main() {
  float side = aEdge.x;
  float off = aEdge.y > 0.5 ? (side < 0.0 ? side * uMossIn : side * uMossOut) : side * uAA;
  vec2 p = aPosition + aNormal * off;
  gl_Position = pixiClipPosition(p, 0.0);
  vWorld = p;
  vEdge = aEdge.xyz;
}
`;

/**
 * Edge strips: kind 0 = AA feather (core colour fading outward), kind 1 = moss rim (patchy teal
 * crust on up-facing edges). With uGlowPass = 1 only the moss light is output, alpha 0 (additive twin).
 */
export const TERRAIN_EDGE_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vWorld;
in vec3 vEdge;
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
    finalColor = vec4((terrainColor(0.0, vWorld) + sw_dither(gl_FragCoord.xy)) * a, a);
    return;
  }
  float mossPatch = sw_vnoise(vWorld * 0.09);
  float speck = smoothstep(0.62, 0.9, sw_vnoise(vWorld * 0.7 + 30.0));
  float prof = smoothstep(-1.0, -0.15, side) * (1.0 - smoothstep(0.25, 1.0, side));
  float a = prof * smoothstep(0.3, 0.75, vEdge.z) * (0.3 + 0.7 * smoothstep(0.35, 0.65, mossPatch));
  if (uGlowPass > 0.5) {
    finalColor = vec4(${v3(MOSS_GLOW_COLOR)} * (a * (0.25 + 0.75 * speck) * uGlow), 0.0);
    return;
  }
  vec3 c = mix(${v3(MOSS_BASE_COLOR)}, ${v3(MOSS_GLOW_COLOR)}, 0.3 + 0.7 * speck);
  finalColor = vec4(c * a, a * 0.92);
}
`;
