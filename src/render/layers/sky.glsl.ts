import { DEPTH_SKY } from '../../config.ts';
import { GLSL_DITHER, GLSL_FRAGMENT_HEADER, GLSL_NOISE, GLSL_VERSION, GLSL_VERTEX_TRANSFORM } from '../shaders/common.ts';
import { MOON_GLOW, SKY_CLOUDS, SKY_HORIZON, STAR_CELL } from './skyShading.ts';

const f = (v: number): string => (Number.isInteger(v) ? `${v}.0` : `${v}`);
const v3 = (c: readonly number[]): string => `vec3(${c.map(f).join(', ')})`;

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
uniform float uHorizonY;
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

  // Horizon mist band behind the far treelines.
  vec2 q = vec2(vView.x * 0.0021 + uTime * 0.006, vView.y * 0.0068);
  float m = sw_vnoise(q) * 0.62 + sw_vnoise(q * vec2(2.7, 2.3) + vec2(5.1, 1.7)) * 0.38;
  float dh = (vView.y - uHorizonY) / uViewSize.y;
  float w = dh < 0.0 ? ${f(SKY_HORIZON.up)} : ${f(SKY_HORIZON.down)};
  c += ${v3(SKY_HORIZON.color)} * (exp(-(dh * dh) / (w * w)) * (${f(SKY_HORIZON.base)} + ${f(SKY_HORIZON.amp)} * m));

  // High cloud streaks.
  float cb = smoothstep(${f(SKY_CLOUDS.t0)}, ${f(SKY_CLOUDS.t1)}, t) * (1.0 - smoothstep(${f(SKY_CLOUDS.t2)}, ${f(SKY_CLOUDS.t3)}, t));
  c += ${v3(SKY_CLOUDS.color)} * (smoothstep(0.52, 0.85, m) * cb);

  // Moon: corona, mid glow and broad sky lift, then a limb-darkened, mottled disc.
  vec2 dm = vView - uMoon.xy;
  float d = length(dm);
  float dn = d / uMoon.z;
  float e = max(0.0, dn - 1.0);
  float halo = uMoon.w * (${f(MOON_GLOW.corona)} * exp(-e * ${f(MOON_GLOW.coronaFall)}) + ${f(MOON_GLOW.mid)} * exp(-e * ${f(MOON_GLOW.midFall)})
    + ${f(MOON_GLOW.broad)} * exp(-dn * ${f(MOON_GLOW.broadFall)}));
  c += uMoonColor * halo;
  float disc = 1.0 - smoothstep(-1.1, 1.1, d - uMoon.z);
  if (disc > 0.0) {
    float rr = min(1.0, dn);
    float limb = 1.0 - 0.16 * rr * rr * rr;
    vec2 l = dm / uMoon.z;
    float maria = smoothstep(0.5, 0.78, sw_vnoise(l * 1.7 + vec2(3.1, 8.3))) * 0.13
      + smoothstep(0.55, 0.8, sw_vnoise(l * 4.1 + vec2(11.0, 2.0))) * 0.06;
    c = mix(c, uMoonColor * (limb * (1.0 - maria)), disc);
  }

  // Stars: at most one per cell, twinkling, fading into the haze and around the moon.
  float fade = (1.0 - smoothstep(0.2, 0.44, t)) * smoothstep(2.4, 7.0, dn);
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
