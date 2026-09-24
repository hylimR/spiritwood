/**
 * Shared GLSL ES 3.0 chunks. Custom mesh shaders get Pixi's global + local uniforms by name
 * (uProjectionMatrix, uWorldTransformMatrix from the global group; uTransformMatrix, uColor from the
 * mesh's local group). Always start with `#version 300 es`.
 */

export const GLSL_VERSION = '#version 300 es';

/** Vertex header: Pixi transform uniforms + helper computing clip position with an explicit depth. */
export const GLSL_VERTEX_TRANSFORM = /* glsl */ `
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

vec4 pixiClipPosition(vec2 pos, float depth01) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  return vec4((mvp * vec3(pos, 1.0)).xy, depth01 * 2.0 - 1.0, 1.0);
}
`;

/** Triangular-PDF dither of ±1 LSB (8-bit), keyed on gl_FragCoord. Add to the final rgb. */
export const GLSL_DITHER = /* glsl */ `
float sw_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 sw_dither(vec2 fragCoord) {
  float r = sw_hash12(fragCoord) + sw_hash12(fragCoord + 17.31) - 1.0;
  return vec3(r / 255.0);
}
`;

/** Cheap value noise + fbm for shaders (no textures). */
export const GLSL_NOISE = /* glsl */ `
float sw_hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float sw_vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = sw_hash21(i);
  float b = sw_hash21(i + vec2(1.0, 0.0));
  float c = sw_hash21(i + vec2(0.0, 1.0));
  float d = sw_hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float sw_fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * sw_vnoise(p);
    p = p * 2.03 + 11.7;
    a *= 0.5;
  }
  return s;
}
`;

/** Rec.709 luma and saturation helpers. */
export const GLSL_COLOR = /* glsl */ `
float sw_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 sw_saturate(vec3 c, float s) { return mix(vec3(sw_luma(c)), c, s); }
`;
