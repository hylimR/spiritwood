import {
  GLSL_COLOR, GLSL_DITHER, GLSL_FRAGMENT_HEADER, GLSL_VERSION, GLSL_VERTEX_TRANSFORM,
} from '../shaders/common.ts';
import { GRADE } from './gradeMath.ts';

/**
 * Post-processing shaders. Every pass draws one full-screen triangle straight into the viewport that
 * the render-options `frame` selects (a dynamic-resolution sub-rect), so vUv spans 0..1 over the
 * destination; sources are sampled at vUv · (sub / allocated) and clamped half a texel inside their
 * sub-rect so bilinear taps never read stale texels beyond it.
 */

function glslFloat(v: number): string {
  return Number.isInteger(v) ? `${v}.0` : `${v}`;
}

/** Full-screen triangle: aPosition ∈ {(0,0), (2,0), (0,2)}. uFlipY = 1 when drawing to the canvas. */
export const FULLSCREEN_VERTEX = /* glsl */ `${GLSL_VERSION}
${GLSL_VERTEX_TRANSFORM}
in vec2 aPosition;
uniform float uFlipY;
out vec2 vUv;

void main() {
  vUv = vec2(aPosition.x, mix(aPosition.y, 1.0 - aPosition.y, uFlipY));
  gl_Position = vec4(aPosition * 2.0 - 1.0, 0.0, 1.0);
}
`;

const SOURCE_TAP = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uSrcTexel;
uniform vec2 uSrcScale;
uniform vec2 uSrcMax;

vec3 tap(vec2 uv) {
  return texture(uSource, clamp(uv, uSrcTexel * 0.5, uSrcMax)).rgb;
}
`;

/** ½-size downsample: 4 bilinear taps one source texel off-centre (a 4×4 box, Kawase style). */
export const BLOOM_DOWN_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vUv;
out vec4 finalColor;
${SOURCE_TAP}
void main() {
  vec2 uv = vUv * uSrcScale;
  vec2 o = uSrcTexel;
  vec3 c = tap(uv + vec2(-o.x, -o.y)) + tap(uv + vec2(o.x, -o.y)) + tap(uv + vec2(-o.x, o.y)) + tap(uv + vec2(o.x, o.y));
  finalColor = vec4(c * 0.25, 1.0);
}
`;

/**
 * 2× upsample with the dual-filter 8-tap tent, added onto the destination (additive blend). The last
 * pass into an 8-bit glow target adds ±1 LSB dither (uDither = 1).
 */
export const BLOOM_UP_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vUv;
out vec4 finalColor;
uniform float uDither;
${SOURCE_TAP}
${GLSL_DITHER}
void main() {
  vec2 uv = vUv * uSrcScale;
  vec2 h = uSrcTexel;
  vec3 c = tap(uv + vec2(-h.x, 0.0)) + tap(uv + vec2(h.x, 0.0)) + tap(uv + vec2(0.0, -h.y)) + tap(uv + vec2(0.0, h.y));
  c += 2.0 * (tap(uv + vec2(-h.x, -h.y) * 0.5) + tap(uv + vec2(h.x, -h.y) * 0.5) + tap(uv + vec2(-h.x, h.y) * 0.5) + tap(uv + vec2(h.x, h.y) * 0.5));
  c = c / 12.0 + sw_dither(gl_FragCoord.xy) * uDither;
  finalColor = vec4(max(c, vec3(0.0)), 0.0);
}
`;

/**
 * Final composite to the canvas (mirrors gradePixel in gradeMath.ts): scene + bloom·intensity →
 * exposure → temperature → lift/gamma/gain → contrast → saturation → highlight shoulder → death fade
 * toward fogDeep → vignette → dither.
 */
export const COMPOSITE_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vUv;
out vec4 finalColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec4 uSceneUv;
uniform vec4 uBloomUv;
uniform vec4 uTexels;
uniform float uExposure;
uniform float uContrast;
uniform float uSaturation;
uniform float uTemperature;
uniform float uVignette;
uniform float uBloomIntensity;
uniform float uFade;
uniform float uAspect;
uniform vec3 uLift;
uniform vec3 uGamma;
uniform vec3 uGain;
uniform vec3 uFog;
${GLSL_COLOR}
${GLSL_DITHER}
const vec3 TEMP = vec3(${glslFloat(GRADE.tempR)}, ${glslFloat(GRADE.tempG)}, ${glslFloat(GRADE.tempB)});
const float PIVOT = ${glslFloat(GRADE.contrastPivot)};
const float SHOULDER = ${glslFloat(GRADE.shoulder)};
const float VIGNETTE_INNER = ${glslFloat(GRADE.vignetteInner)};
const vec3 VIGNETTE_TINT = vec3(${GRADE.vignetteTint.map(glslFloat).join(', ')});

vec3 shoulder(vec3 x) {
  float k = 1.0 - SHOULDER;
  vec3 rolled = SHOULDER + k * (1.0 - exp(-(x - SHOULDER) / k));
  return mix(x, rolled, step(vec3(SHOULDER), x));
}

void main() {
  vec3 scene = texture(uScene, clamp(vUv * uSceneUv.xy, uTexels.xy * 0.5, uSceneUv.zw)).rgb;
  vec3 bloom = texture(uBloom, clamp(vUv * uBloomUv.xy, uTexels.zw * 0.5, uBloomUv.zw)).rgb;
  vec3 c = scene + bloom * uBloomIntensity;
  c *= uExposure;
  c *= max(vec3(0.0), 1.0 + TEMP * uTemperature);
  c = max(vec3(0.0), c * uGain + uLift * (1.0 - min(c, vec3(1.0))));
  c = pow(c, 1.0 / max(uGamma, vec3(1e-3)));
  c = max(vec3(0.0), (c - PIVOT) * uContrast + PIVOT);
  c = max(vec3(0.0), sw_saturate(c, uSaturation));
  c = shoulder(c);
  c = mix(c, uFog, uFade);
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(q) / length(vec2(uAspect, 1.0) * 0.5);
  c *= mix(vec3(1.0), VIGNETTE_TINT, smoothstep(VIGNETTE_INNER, 1.0, r) * uVignette);
  c += sw_dither(gl_FragCoord.xy);
  finalColor = vec4(c, 1.0);
}
`;
