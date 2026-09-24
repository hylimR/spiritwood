# Atmosphere shaders (GLSL ES 3.00, from the repo)

Sources: `src/render/shaders/common.ts`, `src/render/layers/kit.glsl.ts`, `src/render/layers/sky.glsl.ts`,
`src/render/layers/fog.ts`, `src/render/fx/shafts.ts`. In the repo the numeric constants are TS template values
(`${f(SKY_HORIZON.up)}` and so on). The listings below show them **resolved to their current values**, so they can be reused as is.
The constants live in:

| constant object | file | values |
|---|---|---|
| `DEPTH_SKY`, `DEPTH_SHAFTS` | `src/config.ts` | 0.99, 0.055 |
| `KIT_RIM_SCALE`, `KIT_GLOW_ADD` | `kitShading.ts` | 0.5, 0.6 |
| `KIT_MAX_MIP` | `src/render/gen/kit.ts` | 1 |
| `STAR_CELL`, `SKY_HORIZON`, `SKY_CLOUDS`, `MOON_GLOW` | `skyShading.ts` | see the sky section |
| `FOG_SHAPE` | `fogShading.ts` | fx 0.0048, fy 0.016, thrBase 0.22, thrTop 0.78, soft 0.34, crest 0.35 |
| `SHAFT_LOOK`, `SHAFT_COLOR` | `src/render/fx/shaftShading.ts` | strength 0.26, streakFreq 7.5, streakMin 0.28, shimmer 2.2 / 0.09 / 0.42, fadeIn 0.07, fall 0.7 |

Every shader has a TS twin that computes the same formula on the CPU: `kitShading.ts` (`shadeKit`), `skyShading.ts` (`shadeSky`),
`fogShading.ts` (`shadeFog`), `shaftShading.ts` (`shadeShaft`) and `terrainShading.ts`. The browser-free previews
(`tools/preview/world/compose.ts`, `gameplay-overlay.ts`, `terrain-overlay.ts`) and the tests use them. **Change a formula in both places**,
or the previews stop predicting the GPU.

## Shared chunks

```glsl
// GLSL_VERSION          = '#version 300 es'
// GLSL_FRAGMENT_HEADER  = '#version 300 es\nprecision highp float;\nprecision highp int;\n'

// GLSL_VERTEX_TRANSFORM (vertex stage; these names are Pixi's own uniforms, never redeclare them with another type)
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;

vec4 pixiClipPosition(vec2 pos, float depth01) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  return vec4((mvp * vec3(pos, 1.0)).xy, depth01 * 2.0 - 1.0, 1.0);
}

// GLSL_DITHER: triangular-PDF ±1 LSB, keyed on gl_FragCoord
float sw_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 sw_dither(vec2 fragCoord) {
  float r = sw_hash12(fragCoord) + sw_hash12(fragCoord + 17.31) - 1.0;
  return vec3(r / 255.0);
}

// GLSL_NOISE: value noise (the chunk also has a 4-octave sw_fbm, which the atmosphere shaders don't use)
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

// GLSL_COLOR
float sw_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
```

Why TPDF dither: two uniform hashes summed give a triangular distribution over ±1 LSB. With TPDF, the error's mean and variance don't
depend on the signal, so long dark gradients (sky, mist, fog, layer fog, terrain) lose their 8-bit bands and gain only an even, very faint noise.
Add the dither to the **straight** colour before premultiplying: `(c + dither) * a`.

## Kit layer: sway (vertex) and aerial perspective (fragment)

```glsl
in vec2 aPosition;
in vec2 aUV;
in vec2 aSway;
in float aDepth;
in vec4 aTint;
// + GLSL_VERTEX_TRANSFORM
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
```

- `aSway.x = weight² · swayScale · swayAmp · height/100` (`kitMesh.ts`). The weight is 0 at the element's anchor and 1 at its free end, so trunk bases
  and vine roots stay planted. `aSway.y` is the instance phase. `uSway` is 1, or 0 when quality turns sway off.
- The wave depends only on time, phase and rest position. Core and band vertices at the same rest position move identically, so seams
  never open.
- The two sines at 1.35 and 0.52 rad/s (ratio 135:52) repeat together only every 2π·100 ≈ 628 s, and the `p.x` term shifts the phase along the
  layer. This is an artistic choice: the motion reads as irregular gusts, not as one sine pulse. `|wave| ≤ 1.25`, and chunk bounds are padded by 1.4× the amplitude.
- Only x moves, which is enough for side-view foliage. The mist (`vLayerY`) is evaluated at the rest y.

```glsl
in vec2 vUV;
in float vLayerY;
in vec4 vTint;
uniform sampler2D uTexture;
uniform vec3 uTint;
uniform vec3 uFogColor;
uniform vec3 uMistColor;
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
// + GLSL_COLOR, GLSL_DITHER, and sampleClamped() (explicit-LOD sampling, see channel-packed-atlas)

float mistAmount() {
  float t = clamp((vLayerY - uMistY) / max(uMistDepth, 1e-3), 0.0, 1.0);
  return min(1.0, t * t * uMist);
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
    c = mix(mix(c, uFogColor, uFog), uMistColor, mistAmount()) + dither;
    finalColor = uMode > 2.5 ? vec4(c, 1.0) : vec4(c * a, a);
    return;
  }
  vec3 ch = t.rgb / max(a, 1e-4);
  float k = (0.5 + ch.r) * (0.8 + 0.4 * vTint.a);
  vec3 c = uTint * k + uRimColor * (ch.g * uRim * 0.5);
  c = mix(c, vec3(sw_luma(c)), uDesat);
  float m = mistAmount();
  c = mix(mix(c, uFogColor, uFog), uMistColor, m);
  float fog = uFog + (1.0 - uFog) * m;
  vec3 g = vTint.rgb * uGlow;
  float e = ch.b * (1.0 - fog * 0.6) * step(1e-4, uGlow);
  c = mix(c, g * 1.25, e);
  if (uMode < 0.5) {
    finalColor = vec4(c + dither, 1.0);
  } else if (uMode > 3.5) {
    finalColor = vec4(g * e * a, 0.0);
  } else {
    finalColor = vec4((c + dither) * a + g * (e * a * 0.6), a);
  }
}
```

The order of the steps matters:

1. The surface is material × tint (`ch.r` detail, `vTint.a` per-instance shade) plus the rim.
2. Desaturate the *lit* surface.
3. Apply the layer fog: a constant `uFog` toward `uFogColor`. This is distance. The rim fades with it, which is why far layers lose contrast.
4. Apply the height mist toward `uMistColor`. For mid and near recipes this is the fog colour plus a small teal lift (`mistLift`), so each plane's base
   dissolves into luminous mist rather than into its own flat fog.
5. Glow comes last and is attenuated by the combined fog. Glow that ignored the fog would pop out of the mist and flatten the depth.

`uMode`: 0 = opaque core (alpha 1, never discards), 1 = soft band (premultiplied), 2/3 = painted plate band/core, 4 = glow twin (used
only by decor, never by parallax layers). See channel-packed-atlas for `sampleClamped` and the channel layout.

## Sky

```glsl
// vertex
in vec2 aPosition;
// + GLSL_VERTEX_TRANSFORM
out vec2 vView;
void main() {
  gl_Position = pixiClipPosition(aPosition, 0.9900);
  vView = aPosition;
}
```

```glsl
in vec2 vView;
uniform vec2 uViewSize;
uniform float uTime;
uniform float uHorizonY;
uniform vec4 uStopT;
uniform vec3 uStop0;
uniform vec3 uStop1;
uniform vec3 uStop2;
uniform vec3 uStop3;
uniform vec4 uMoon;       // view x, view y, radius, halo
uniform vec3 uMoonColor;
uniform float uStars;
out vec4 finalColor;
// + GLSL_NOISE, GLSL_DITHER

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
  float w = dh < 0.0 ? 0.13 : 0.3;
  c += vec3(0.05, 0.115, 0.15) * (exp(-(dh * dh) / (w * w)) * (0.72 + 0.56 * m));

  // High cloud streaks.
  float cb = smoothstep(0.06, 0.26, t) * (1.0 - smoothstep(0.4, 0.62, t));
  c += vec3(0.03, 0.05, 0.075) * (smoothstep(0.52, 0.85, m) * cb);

  // Moon: corona, mid glow and broad sky lift, then a limb-darkened, mottled disc.
  vec2 dm = vView - uMoon.xy;
  float d = length(dm);
  float dn = d / uMoon.z;
  float e = max(0.0, dn - 1.0);
  float halo = uMoon.w * (0.3 * exp(-e * 2.4) + 0.085 * exp(-e * 0.55)
    + 0.05 * exp(-dn * 0.13));
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
    vec2 cell = floor(vView / 38.0);
    float h = sw_hash21(cell);
    if (h < uStars * 0.42) {
      vec2 sp = (cell + 0.15 + 0.7 * vec2(sw_hash21(cell + vec2(7.1, 3.3)), sw_hash21(cell + vec2(1.9, 9.7)))) * 38.0;
      float bright = 0.35 + 0.65 * sw_hash21(cell + vec2(4.4, 5.5));
      float tw = 0.62 + 0.38 * sin(uTime * (1.3 + 2.4 * sw_hash21(cell + vec2(8.8, 2.2))) + 6.283 * h * 17.0);
      vec2 ds = vView - sp;
      float s = exp(-dot(ds, ds) * 0.55) * bright * tw * fade;
      c += vec3(0.8, 0.92, 1.0) * s;
    }
  }
  finalColor = vec4(c + sw_dither(gl_FragCoord.xy), 1.0);
}
```

Design notes:

- **Gradient:** 4 stops passed as `vec4 uStopT` plus `vec3 uStop0..3`. This keeps the uniform group flat and needs no loop. `skyParams` pads a shorter
  gradient by repeating the last stop at `t = 1 + i`. Forest: `#030817` (0) → `#091a33` (0.32) → `#163a57` (0.64) → `#12324b` (1). The
  sky is darkest at the top, and the luminous part comes from the horizon band, not the gradient.
- **Horizon band:** an asymmetric Gaussian (half-widths 0.13 of the view height above, 0.3 below), brightness `0.72 + 0.56·noise`. Its centre is
  `skyHorizonY = viewH·0.6 − (camY − levelH/2)·0.06`, so it drifts with camera y at parallax 0.06, like a very distant layer, and
  stays behind the bases of the far treelines (L1 f = 0.08, baseline 0.62), which fade into it (mist 1, atlas `fadeBottom`). The CPU uploads it
  as `uHorizonY` each frame. The same noise `m`, thresholded (`smoothstep(0.52, 0.85, m)`), gives the faint cloud streaks at 6–62 % of the view height.
- **Moon glow:** three exponential lobes scaled by `halo`: a corona (`0.3·exp(−2.4·e)`, starting at the rim), a mid glow (`0.085·exp(−0.55·e)`)
  and a broad lift of the whole sky around it (`0.05·exp(−0.13·dn)`). A single Gaussian falls off too fast and leaves a hard-edged disc on flat sky.
  Several exponentials with long tails read as light scattered in haze. This is an artistic judgement, not a physical model.
- **Disc:** a ±1.1-unit smoothstep for AA, limb darkening `1 − 0.16·r³`, and two thresholded noise octaves as maria (up to 19 % darker).
  The disc is opaque over the halo.
- **Stars:** a jittered grid with one candidate per 38-unit cell and the threshold `h < density·0.42`. The shader reads no neighbour cells. That is
  safe because the jitter keeps every star at least 0.15·38 ≈ 5.7 units inside its cell, where `exp(−d²·0.55)` is below 1e-7. Stars fade out
  between 20 % and 44 % of the view height (into the haze) and between 7 and 2.4 moon radii (outshone).
- **Cost:** everything is analytic: 2 value-noise lookups (4 inside the moon disc), a few hashes and `exp`s per pixel, and no loops or textures. The §6 budget allows the sky
  ≤ 0.5 screens after the depth reject. The debug fill estimate adds `SKY_FILL_ESTIMATE = 0.6`. Neither number is a GPU measurement.
- **View space:** the sky is parallax 0 with no zoom. Layers with `fy > 0` slide over it vertically as the camera moves, so a bright
  feature in it shows through different canopy gaps at every camera y (see Pitfalls in SKILL.md).
- The uniform is `uViewSize`, not Pixi's reserved `uResolution`.

## Fog band

```glsl
// vertex: layer-space quad, positioned with applyParallax (fx 1.08/1.22, fy 0)
in vec2 aPosition;
// + GLSL_VERTEX_TRANSFORM
out vec2 vLayer;
void main() {
  gl_Position = pixiClipPosition(aPosition, 0.0);
  vLayer = aPosition;
}
```

```glsl
in vec2 vLayer;
uniform vec3 uFogColor;
uniform float uDensity;
uniform float uY;
uniform float uHeight;
uniform float uTime;
uniform float uSpeed;
out vec4 finalColor;
// + GLSL_NOISE, GLSL_DITHER

void main() {
  float v = (vLayer.y - uY) / uHeight;
  vec2 p = vec2((vLayer.x + uTime * uSpeed) * 0.0048, vLayer.y * 0.016);
  float n = sw_vnoise(p) * 0.6 + sw_vnoise(p * vec2(2.6, 2.1) + vec2(uTime * 0.03, 5.2)) * 0.4;
  float top = 1.0 - smoothstep(-0.95, 0.35, v);
  float thr = mix(0.22, 0.78, top);
  float a = uDensity * smoothstep(thr - 0.17, thr + 0.17, n)
    * smoothstep(-1.0, -0.7, v) * (1.0 - smoothstep(0.55, 1.0, v));
  vec3 c = uFogColor * (1.0 + 0.35 * top);
  finalColor = vec4((c + sw_dither(gl_FragCoord.xy)) * a, a);
}
```

- The quad spans exactly `y ± height` (v ∈ [−1, 1], y down). The envelope fades both ends, so the band has no hard top or bottom.
  Each band stays at most ⅓ of the screen tall (the §6 fog budget is ≤ 0.6 screens for all bands).
- **Erosion toward the top:** the noise threshold rises from 0.22 at the base to 0.78 at the top. The bottom is a dense bank, and the top breaks into
  rolling wisps with clear holes, which is where the air comes from. Wisp crests are up to 35 % brighter, so they catch moonlight.
- The noise is stretched about 3.3:1 horizontally (0.0048 against 0.016), so the bands read as drifting banks rather than clouds. The layer drifts at
  `uSpeed` (14 and 26 u/s), and the second octave moves on its own clock (`uTime·0.03`), so the mist *changes shape* instead of sliding like a texture.
- The bands sit in front of the gameplay plane (fx 1.08 and 1.22, fy 0, view y = `y + viewH/2`) and draw over the hero, so keep density low (0.22 and
  0.16) and the colour brighter than the scene (`#4d8ea3`, `#6fa9ba`). Mist in front of a dark scene should lift it, not grey it.
  This is an artistic rule.
- Slot `fog` uses Pixi's default state with no depth test, so the depth 0 written by the vertex shader is ignored.

## Light shaft (additive, depth-tested behind the terrain core)

```glsl
// vertex writes pixiClipPosition(aPosition, 0.0550); aShaft = (x − left(y), width(y), v, intensity), aSeed per shaft
in vec4 vShaft;
in float vSeed;
uniform vec3 uShaftColor;
uniform float uStrength;
uniform float uTime;
out vec4 finalColor;
// + GLSL_NOISE

void main() {
  float u = clamp(vShaft.x / max(vShaft.y, 1e-3), 0.0, 1.0);
  float v = clamp(vShaft.z, 0.0, 1.0);
  float across = smoothstep(0.0, 0.24, u) * (1.0 - smoothstep(0.76, 1.0, u));
  float along = smoothstep(0.0, 0.07, v) * pow(max(0.0, 1.0 - v), 0.7);
  float n = sw_vnoise(vec2(u * 7.5 + vSeed, uTime * 0.035 + vSeed * 0.37));
  float streak = 0.28 + 0.72 * smoothstep(0.2, 0.8, n);
  float sh = sw_vnoise(vec2(u * 2.3 + vSeed * 1.7, v * 2.2 - uTime * 0.09));
  float shimmer = 0.58 + 0.672 * sh;
  float a = across * along * streak * shimmer * vShaft.w * uStrength;
  finalColor = vec4(uShaftColor * a, a);
}
```

- `x − left(y)` and `width(y)` are both affine over the trapezoid, so interpolating them per vertex and dividing per fragment gives an exact
  `u = x/width` with no perspective tricks. The mesh has 4 rows per shaft, which only shape the envelope.
- Streaks run *along* the shaft (the noise varies in u and slowly in time), and the shimmer travels down it (`v·2.2 − t·0.09`). The light is
  brightest near the source and falls off as `(1 − v)^0.7`.
- `uStrength = SHAFT_STRENGTH = 0.26`. Its depth is 0.055, just behind the terrain core (0.05): the ground occludes the shaft, and every parallax layer
  is still lit through it.
