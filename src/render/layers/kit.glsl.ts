import { GLSL_COLOR, GLSL_DITHER, GLSL_FRAGMENT_HEADER, GLSL_VERSION, GLSL_VERTEX_TRANSFORM } from '../shaders/common.ts';
import { KIT_MAX_MIP } from '../gen/kit.ts';
import { KIT_GLOW_ADD, KIT_RIM_SCALE } from './kitShading.ts';

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);

/**
 * Kit layer program (ARCHITECTURE.md §5.5): one program for opaque cores, soft bands, plate chunks,
 * blended decor and emissive glow twins, selected by `uMode` (see KIT_MODE). Implements
 * `shadeKit` from kitShading.ts. Wind sway displaces x by the baked per-vertex amplitude
 * (aSway.x = weight² × element amplitude) — identical for core and band, so they stay aligned.
 */
export const KIT_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
in vec2 aUV;
in vec2 aSway;
in float aDepth;
in vec4 aTint;
${GLSL_VERTEX_TRANSFORM}
uniform float uTime;
uniform float uSway;
out vec2 vUV;
out float vLayerY;
out vec4 vTint;

void main() {
  vec2 p = aPosition;
  if (uSway > 0.0) {
    float wave = sin(uTime * 1.35 + aSway.y + p.x * 0.0045) * 0.75
      + sin(uTime * 0.52 + aSway.y * 1.7 + p.x * 0.0013) * 0.5;
    p.x += wave * aSway.x * uSway;
  }
  gl_Position = pixiClipPosition(p, aDepth);
  vUV = aUV;
  vLayerY = aPosition.y;
  vTint = aTint;
}
`;

export const KIT_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vUV;
in float vLayerY;
in vec4 vTint;
uniform sampler2D uTexture;
uniform vec3 uTint;
uniform vec3 uFogColor;
uniform vec3 uRimColor;
uniform float uFog;
uniform float uDesat;
uniform float uRim;
uniform float uGlow;
uniform float uMistY;
uniform float uMistDepth;
uniform float uMist;
uniform float uMode;
uniform float uStraight;
out vec4 finalColor;
${GLSL_COLOR}
${GLSL_DITHER}

// Explicit LOD clamp: gutters and core insets only cover mip levels up to KIT_MAX_MIP.
vec4 sampleClamped(vec2 uv) {
  vec2 size = vec2(textureSize(uTexture, 0));
  vec2 d = max(abs(dFdx(uv * size)), abs(dFdy(uv * size)));
  float lod = clamp(log2(max(max(d.x, d.y), 1e-6)), 0.0, ${f(KIT_MAX_MIP)});
  return textureLod(uTexture, uv, lod);
}

float fogAmount() {
  float t = clamp((vLayerY - uMistY) / max(uMistDepth, 1e-3), 0.0, 1.0);
  return min(1.0, uFog + (1.0 - uFog) * t * t * uMist);
}

void main() {
  vec4 t = sampleClamped(vUV);
  float a = t.a;
  vec3 dither = sw_dither(gl_FragCoord.xy);
  if (uMode > 1.5 && uMode < 3.5) {
    // Painted plate: texture colour × tint, desaturated and fogged.
    vec3 c = uStraight > 0.5 ? t.rgb : t.rgb / max(a, 1e-4);
    c *= uTint;
    c = mix(c, vec3(sw_luma(c)), uDesat);
    c = mix(c, uFogColor, fogAmount()) + dither;
    finalColor = uMode > 2.5 ? vec4(c, 1.0) : vec4(c * a, a);
    return;
  }
  vec3 ch = t.rgb / max(a, 1e-4);
  float k = (0.5 + ch.r) * (0.8 + 0.4 * vTint.a);
  vec3 c = uTint * k + uRimColor * (ch.g * uRim * ${f(KIT_RIM_SCALE)});
  c = mix(c, vec3(sw_luma(c)), uDesat);
  float fog = fogAmount();
  c = mix(c, uFogColor, fog);
  vec3 g = vTint.rgb * uGlow;
  float e = ch.b * (1.0 - fog * 0.6) * step(1e-4, uGlow);
  c = mix(c, g * 1.25, e);
  if (uMode < 0.5) {
    finalColor = vec4(c + dither, 1.0);
  } else if (uMode > 3.5) {
    finalColor = vec4(g * e * a, 0.0);
  } else {
    finalColor = vec4((c + dither) * a + g * (e * a * ${f(KIT_GLOW_ADD)}), a);
  }
}
`;
