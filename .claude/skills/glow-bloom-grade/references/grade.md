# Composite and per-area grade

The final pass reads the scene and the bloom, grades them and writes the canvas. The same maths lives
in a CPU reference that tests and browser-free previews use. Sources: `src/render/post/post.glsl.ts`
(`COMPOSITE_FRAGMENT`), `src/render/post/gradeMath.ts`, `src/render/post/grade.ts`,
`src/render/post/postChain.ts` (`setGrade`), `src/content/grades.ts`, `tests/pipe/grade.test.ts`.

## 1. Composite shader (GLSL ES 3.0)

```glsl
#version 300 es
precision highp float;
precision highp int;
in vec2 vUv;
out vec4 finalColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec4 uSceneUv;      // xy = sub/alloc, zw = (sub - 0.5)/alloc
uniform vec4 uBloomUv;      // same for glow level 0
uniform vec4 uTexels;       // xy = 1/scene alloc, zw = 1/glow alloc
uniform float uExposure, uContrast, uSaturation, uTemperature, uVignette, uBloomIntensity, uFade, uAspect;
uniform vec3 uLift, uGamma, uGain, uFog;   // uFog, not uColor: Pixi reserves uColor (vec4)

// GLSL_COLOR
float sw_luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 sw_saturate(vec3 c, float s) { return mix(vec3(sw_luma(c)), c, s); }
// GLSL_DITHER: TPDF, ±1/255
float sw_hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 sw_dither(vec2 fragCoord) {
  float r = sw_hash12(fragCoord) + sw_hash12(fragCoord + 17.31) - 1.0;
  return vec3(r / 255.0);
}

const vec3 TEMP = vec3(0.14, 0.025, -0.14);
const float PIVOT = 0.22;
const float SHOULDER = 0.78;
const float VIGNETTE_INNER = 0.32;
const vec3 VIGNETTE_TINT = vec3(0.14, 0.2, 0.32);

vec3 shoulder(vec3 x) {
  float k = 1.0 - SHOULDER;
  vec3 rolled = SHOULDER + k * (1.0 - exp(-(x - SHOULDER) / k));
  return mix(x, rolled, step(vec3(SHOULDER), x));
}

void main() {
  vec3 scene = texture(uScene, clamp(vUv * uSceneUv.xy, uTexels.xy * 0.5, uSceneUv.zw)).rgb;
  vec3 bloom = texture(uBloom, clamp(vUv * uBloomUv.xy, uTexels.zw * 0.5, uBloomUv.zw)).rgb;
  vec3 c = scene + bloom * uBloomIntensity;               // intensity already ÷ (passes + 1)
  c *= uExposure;
  c *= max(vec3(0.0), 1.0 + TEMP * uTemperature);
  c = max(vec3(0.0), c * uGain + uLift * (1.0 - min(c, vec3(1.0))));
  c = pow(c, 1.0 / max(uGamma, vec3(1e-3)));
  c = max(vec3(0.0), (c - PIVOT) * uContrast + PIVOT);
  c = max(vec3(0.0), sw_saturate(c, uSaturation));
  c = shoulder(c);
  c = mix(c, uFog, uFade);
  vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = length(q) / length(vec2(uAspect, 1.0) * 0.5);   // 1 at the corners, any aspect
  c *= mix(vec3(1.0), VIGNETTE_TINT, smoothstep(VIGNETTE_INNER, 1.0, r) * uVignette);
  c += sw_dither(gl_FragCoord.xy);
  finalColor = vec4(c, 1.0);
}
```

The repo doesn't type the constants into the shader. It interpolates them from the frozen `GRADE` object
in `gradeMath.ts` with `glslFloat(v)` (which turns `1` into `1.0`), so the GPU and CPU paths can't drift apart.

The matching uniform group (PixiJS v8, one `UniformGroup` bound as a resource next to `uScene` and
`uBloom`) preallocates every array. `setScale` fills the three `vec4`s, and `setGrade` writes the rest
in place each frame:

```ts
const compositeUniforms = new UniformGroup({
  uSceneUv: { value: new Float32Array(4), type: 'vec4<f32>' },
  uBloomUv: { value: new Float32Array(4), type: 'vec4<f32>' },
  uTexels: { value: new Float32Array(4), type: 'vec4<f32>' },
  uExposure: { value: 1, type: 'f32' }, uContrast: { value: 1, type: 'f32' },
  uSaturation: { value: 1, type: 'f32' }, uTemperature: { value: 0, type: 'f32' },
  uVignette: { value: 0, type: 'f32' }, uBloomIntensity: { value: 0, type: 'f32' },
  uFade: { value: 0, type: 'f32' }, uAspect: { value: 16 / 9, type: 'f32' },
  uLift: { value: new Float32Array(3), type: 'vec3<f32>' },
  uGamma: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
  uGain: { value: new Float32Array([1, 1, 1]), type: 'vec3<f32>' },
  uFog: { value: new Float32Array(3), type: 'vec3<f32>' },
  uFlipY: { value: 1, type: 'f32' },   // read by FULLSCREEN_VERTEX: this pass writes the canvas
});
```

## 2. Why this order

| Step | Why here |
|---|---|
| `scene + bloom·k` | Bloom is light, so it's added before any grading. Exposure, white balance and the curves then treat glow and scene alike, and a warm grade warms the halos too. |
| exposure | Plain linear gain, the "camera" step. It sits first so the area mood can brighten or darken everything, bloom included. |
| temperature | White balance before the creative controls: per-channel gain `1 + (0.14, 0.025, −0.14)·t`. |
| lift / gamma / gain | The colourist's wheels. Gain tints highlights, gamma bends the mids, and lift raises shadows while fading to 0 at white (`lift·(1 − min(c,1))`), so blacks get tinted and highlights don't. |
| contrast | Pivots at **0.22**, not 0.5. The night scene lives below ~0.35, and a 0.5 pivot would crush it. |
| saturation | After contrast, which already changes saturation, so this is the final say. Rec.709 luma. |
| shoulder | After every gain. Bloom and gain push emissives past 1, and the exponential roll-off from 0.78 keeps them from clipping into flat white blobs. It is monotonic and stays below 1. |
| death fade | Mixes toward `fogDeep`, not black, so a fade keeps the palette. It comes after grading, so `fade = 1` gives exactly the fog colour inside the vignette's inner radius (tested at the centre). The vignette and dither still apply after it, which keeps the corners consistent during a fade. |
| vignette | Multiplies toward a cool tint `(0.14, 0.2, 0.32)` instead of black, from normalised radius 0.32. It is aspect-correct. |
| dither | Last, on the final 8-bit value: ±1 LSB TPDF, which kills banding in the dark gradients. |

## 3. CPU reference (`gradeMath.ts`)

```ts
export const GRADE = Object.freeze({
  contrastPivot: 0.22, tempR: 0.14, tempG: 0.025, tempB: -0.14, shoulder: 0.78,
  vignetteInner: 0.32, vignetteTint: [0.14, 0.2, 0.32] as const,
});

function shoulder(x: number): number {
  const s = GRADE.shoulder;
  if (x <= s) return x;
  const k = 1 - s;
  return s + k * (1 - Math.exp(-(x - s) / k));
}

function smooth(e0: number, e1: number, x: number): number {   // GLSL smoothstep
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export function gradePixel(out: RGB, scene: Readonly<RGB>, bloom: Readonly<RGB>, p: GradeParams,
  fade: number, fogDeep: Readonly<RGB>, radius: number): RGB {
  const temp = [GRADE.tempR, GRADE.tempG, GRADE.tempB];
  const c = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let v = scene[i] + bloom[i] * p.bloomIntensity;
    v *= p.exposure;
    v *= Math.max(0, 1 + temp[i] * p.temperature);
    v = Math.max(0, v * p.gain[i] + p.lift[i] * (1 - Math.min(v, 1)));
    v = Math.pow(v, 1 / Math.max(1e-3, p.gamma[i]));
    v = Math.max(0, (v - GRADE.contrastPivot) * p.contrast + GRADE.contrastPivot);
    c[i] = v;
  }
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const v = smooth(GRADE.vignetteInner, 1, radius) * p.vignette;
  for (let i = 0; i < 3; i++) {
    let x = Math.max(0, l + (c[i] - l) * p.saturation);
    x = shoulder(x);
    x += (fogDeep[i] - x) * fade;
    x *= 1 + (GRADE.vignetteTint[i] - 1) * v;
    out[i] = x;
  }
  return out;
}
```

Note that `gradePixel` takes the raw `bloomIntensity`. The GPU uniform is
`bloomIntensity / (passes + 1)`, because the GPU bloom is a sum of `passes + 1` levels. The CPU preview
passes the *mean* of its blur levels (see §6), so the two are on the same scale. The CPU blur isn't
the GPU dual filter, so halo shapes only approximately match.

Tests that keep the pair honest (`tests/pipe/grade.test.ts`):

- The identity grade is a no-op below the shoulder. Highlights stay below 1 and are monotonic up to 4.0.
- Bloom adds before exposure. `fade = 1` at the centre gives exactly `fogDeep`. The vignette leaves
  radius 0.32 untouched and multiplies the corners (radius 1) by the tint.
- Temperature > 0 makes R > B, and < 0 makes B > R.
- Shader text: every post shader starts with `#version 300 es`, every fragment contains
  `precision highp float;`, and the composite contains `const float PIVOT = ${GRADE.contrastPivot};`
  (and the same for SHOULDER, VIGNETTE_INNER) and `sw_dither(gl_FragCoord.xy)`. TEMP and VIGNETTE_TINT
  aren't string-checked, so extend the test if you add constants.

## 4. Per-area grades blended by camera position (`grade.ts`)

A zone is an axis-aligned rect with a grade id and a `blend` distance in world units. Its weight is 1
inside the rect and falls off with a smoothstep of the Euclidean distance to the rect.

```ts
export function zoneWeight(z: GradeZoneDef, x: number, y: number): number {
  const dx = Math.max(z.x - x, 0, x - (z.x + z.w));
  const dy = Math.max(z.y - y, 0, y - (z.y + z.h));
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d <= 0) return 1;
  if (z.blend <= 0 || d >= z.blend) return 0;
  const t = 1 - d / z.blend;
  return t * t * (3 - 2 * t);
}
```

`blendGrades(out, zones, x, y, table, fallback)`:

1. Sum the weights (`total`). If it is ≤ 0, copy `fallback` into `out`.
2. Zero `out` and accumulate each zone's grade × `w / max(total, 1)`. Overlaps are normalised.
3. If `total < 1` (inside a lone blend band), accumulate `fallback × (1 − total)`. Walking out of a zone
   then fades continuously to the default instead of snapping.

It writes into a preallocated `GradeParams` (lift, gamma and gain arrays are reused), so it allocates
nothing and can run every frame. The pipeline evaluates it at the interpolated camera centre:

```ts
blendGrades(this.grade, level.gradeZones, cam.cx, cam.cy, AREA_GRADE_TABLE, DEFAULT_GRADE);
const fade = sim.prevFade + (sim.fade - sim.prevFade) * alpha;
post.setGrade(this.grade, fade, this.fog, fit.aspect, q.bloom);
// setGrade: uBloomIntensity = bloom ? g.bloomIntensity / (passes + 1) : 0; copies lift/gamma/gain/fog in place
```

Blending the *parameters* keeps the cost at one composite pass. It isn't the same as cross-fading two
graded frames (exposure × temperature, gamma and the shoulder are nonlinear). With grades this close
together, though, the difference is small, and the parameter blend is continuous and costs nothing.
A test steps the camera in 5 u increments across a boundary and asserts that exposure changes by less
than 0.02 per step.

## 5. Authoring the table (`src/content/grades.ts`)

"The five areas should read as one world breathing, not five filters." Every grade stays close to the
glade baseline. The test enforces these bounds: exposure 0.8–1.2, |contrast−1| < 0.15,
|saturation−1| < 0.2, |temperature| < 0.4, vignette < 0.6, |lift| < 0.05, |gamma−1| < 0.1 and
|gain−1| < 0.12. It also pins the moods' direction: shrine temperature > 0, gully colder than glade,
rootwell darker than glade with a stronger vignette than gully, and canopy blooming more than glade.

| Area | Intent | Values (exposure, contrast, saturation, temperature, lift, gamma, gain, vignette, bloom) |
|---|---|---|
| default (no zone) | fallback | 1, 1.03, 1, −0.06, (0.004, 0.01, 0.018), 1, (0.99, 1.01, 1.02), 0.3, 1 |
| glade (baseline) | calm cool teal | 1, 1.04, 1.04, −0.06, (0.004, 0.014, 0.018), 1, (0.97, 1.03, 1.02), 0.3, 1 |
| gully | colder, tense | 1.02, 1.09, 0.86, −0.28, (0, 0.006, 0.024), (0.98, 1, 1.03), (0.93, 0.99, 1.06), 0.42, 0.9 |
| rootwell | deep blue, enclosed | 0.95, 1.06, 0.92, −0.24, (0, 0.008, 0.03), (0.97, 0.99, 1.04), (0.9, 0.98, 1.07), 0.52 (the strongest), 1.05 |
| canopy | moonlit, airy | 1.08, 1, 1.02, −0.1, (0.01, 0.018, 0.026), (1.03, 1.03, 1.02), (0.99, 1.04, 1.06), 0.2, 1.25 |
| shrine | warm, hopeful | 1.05, 1.03, 1.06, +0.2, (0.03, 0.014, 0.008), (1.05, 1, 0.97), (1.1, 1, 0.92), 0.26, 1.3 |

Warmth comes from a red-heavy lift, gamma and gain, together with a positive temperature. Coolness is
a blue-heavy lift, gamma and gain with a negative temperature. Bloom intensity is part of the mood:
the open or hopeful areas get more, and the tense gully gets less.

## 6. Browser-free preview

`node tools/preview/pipe/scene.ts <outDir>` renders the hero and entity views with the CPU renderer. It
renders their glow slots at half size and approximates the chain as the **mean** of
`[glow, blur 2, blur 6, blur 14, blur 28]`. It then grades every pixel with `gradePixel` and writes
`scene-glade.png`, `scene-grades.png` (the five area grades side by side) and `scene-hero-closeups.png`.
Use it to tune grades and twin gains without a GPU.
