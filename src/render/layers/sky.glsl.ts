import { DEPTH_SKY } from '../../config.ts';
import { GLSL_DITHER, GLSL_FRAGMENT_HEADER, GLSL_NOISE, GLSL_VERSION, GLSL_VERTEX_TRANSFORM } from '../shaders/common.ts';
import { STAR_CELL } from './skyShading.ts';

/** Full-screen sky at DEPTH_SKY (depth-tested, no write): implements skyShading.ts per fragment. */
export const SKY_VERTEX = /* glsl */ `${GLSL_VERSION}
in vec2 aPosition;
${GLSL_VERTEX_TRANSFORM}
out vec2 vView;

void main() {
  gl_Position = pixiClipPosition(aPosition, ${DEPTH_SKY.toFixed(4)});
  vView = aPosition;
}
`;

export const SKY_FRAGMENT = /* glsl */ `${GLSL_FRAGMENT_HEADER}
in vec2 vView;
uniform vec2 uViewSize;
uniform float uTime;
uniform vec4 uStopT;
uniform vec3 uStop0;
uniform vec3 uStop1;
uniform vec3 uStop2;
uniform vec3 uStop3;
uniform vec4 uMoon;
uniform vec3 uMoonColor;
uniform float uStars;
out vec4 finalColor;
${GLSL_NOISE}
${GLSL_DITHER}

float seg(float t, float a, float b) {
  return clamp((t - a) / max(b - a, 1e-5), 0.0, 1.0);
}

void main() {
  float t = vView.y / uViewSize.y;
  vec3 c = mix(uStop0, uStop1, seg(t, uStopT.x, uStopT.y));
  c = mix(c, uStop2, seg(t, uStopT.y, uStopT.z));
  c = mix(c, uStop3, seg(t, uStopT.z, uStopT.w));

  // High mist band.
  float band = smoothstep(0.12, 0.42, t) * (1.0 - smoothstep(0.55, 0.9, t));
  if (band > 0.0) {
    vec2 q = vec2(vView.x * 0.0016 + uTime * 0.004, vView.y * 0.0055) * 40.0;
    float m = (sw_vnoise(q * 0.12) * 0.65 + sw_vnoise(q * 0.31 + 7.3) * 0.35) * band;
    c += vec3(0.045, 0.085, 0.105) * m;
  }

  // Moon: two-lobe halo and a softly mottled disc.
  vec2 dm = vView - uMoon.xy;
  float d = length(dm);
  float dn = d / uMoon.z;
  float halo = uMoon.w * (0.34 * exp(-max(0.0, dn - 1.0) * 1.5) + 0.11 * exp(-dn * 0.3));
  c += uMoonColor * halo * 0.32;
  float disc = 1.0 - smoothstep(-1.2, 1.2, d - uMoon.z);
  if (disc > 0.0) {
    float mottled = 0.9 + 0.1 * sw_vnoise(vView * 0.05 * 3.0);
    c = mix(c, uMoonColor * mottled, disc);
  }

  // Stars: at most one per cell, twinkling, fading into the haze below 45% of the view.
  float fade = (1.0 - smoothstep(0.22, 0.46, t)) * smoothstep(2.2, 6.0, dn);
  if (fade > 0.0) {
    vec2 cell = floor(vView / ${STAR_CELL.toFixed(1)});
    float h = sw_hash21(cell);
    if (h < uStars * 0.42) {
      vec2 sp = (cell + 0.15 + 0.7 * vec2(sw_hash21(cell + vec2(7.1, 3.3)), sw_hash21(cell + vec2(1.9, 9.7)))) * ${STAR_CELL.toFixed(1)};
      float bright = 0.35 + 0.65 * sw_hash21(cell + vec2(4.4, 5.5));
      float tw = 0.62 + 0.38 * sin(uTime * (1.3 + 2.4 * sw_hash21(cell + vec2(8.8, 2.2))) + 6.283 * h * 17.0);
      vec2 ds = vView - sp;
      float s = exp(-dot(ds, ds) * 0.55) * bright * tw * fade;
      c += vec3(0.8, 0.92, 1.0) * s;
    }
  }
  finalColor = vec4(c + sw_dither(gl_FragCoord.xy), 1.0);
}
`;
