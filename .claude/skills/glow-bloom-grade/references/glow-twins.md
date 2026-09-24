# Glow twins and cheap halos

A **glow twin** redraws something emissive into the glow buffer: the same geometry or texture, with
emissive-only shading, additive blending, and alpha 0. The bloom chain blurs the glow buffer, and the
composite adds it back. Twins cost about one draw per batch or chunk, and the glow buffer is ½ or ¼
resolution, so their fill is small. Their CPU cost should be zero, so they share every buffer, array
and program they can with the scene copy.

## 1. What glows, and how

| Content | Where it sits | Technique | Repo |
|---|---|---|---|
| Moss rim on terrain tops | gameplay plane | mesh twin, same program, `uGlowPass = 1`, shared vertex buffer | `src/render/terrain/terrainView.ts`, `terrain.glsl.ts` |
| Gameplay-plane flora, lanterns, thorn tips | gameplay plane | kit meshes in `KIT_MODE.Glow`, built from emissive instances only | `src/render/fx/decor.ts`, `src/render/layers/kit.glsl.ts` |
| Hero body, bud, scarf | gameplay plane | sprite and mesh twins with a grey tint, same matrix every frame | `src/render/hero/heroView.ts` |
| Orbs, checkpoint stones, shrine, crawler eyes | gameplay plane | twin sprites of the emissive parts only (orb core, rune, beam, pool, lamp, eye), plus small radial glow sprites | `src/render/entities/{orbs,stones,shrine,crawlers}.ts`, `entitiesView.ts` |
| Fireflies, motes, shaft dust, sparks | gameplay plane | second `ParticleContainer` over the **same** particle array | `src/render/fx/particles.ts` |
| Flora on parallax layers L1–L8 | behind terrain | **no twin**: baked halo texels + in-scene emissive add | `src/render/gen/raster.ts` (`haloAt`), kit Band mode |
| Moon | sky | **no twin**: analytic three-term halo in the sky shader (tight corona, mid glow, broad sky lift) | `src/render/layers/sky.glsl.ts` |
| Spirit light around the hero, lantern pools | scene | additive halo sprite / particle (lights the world, not bloom) | `heroView.ts` (`halo`), `decor.ts` (`createHaloContainer`) |

Rule: **twin only content drawn in front of the opaque layers** (slot `terrain` onward). The glow
buffer has no depth. A twin of a layer that the terrain hides would bloom straight through the terrain,
so parallax layers carry their glow in their own scene shading.

## 2. Mesh twin with a pass flag (terrain moss)

The scene and the twin use the same `GlProgram` with two `UniformGroup`s that differ only in
`uGlowPass`. The twin geometry reuses the edge mesh's interleaved vertex buffer, and only the index
buffer (the moss subset) is new.

```ts
function edgeUniforms(glowPass: boolean) {
  return new UniformGroup({
    uAA: { value: 1, type: 'f32' },
    uMossIn: { value: DEFAULT_TERRAIN.mossIn, type: 'f32' },
    uMossOut: { value: DEFAULT_TERRAIN.mossOut, type: 'f32' },
    uShadeDepth: { value: DEFAULT_TERRAIN.shadeDepth, type: 'f32' },
    uGlowPass: { value: glowPass ? 1 : 0, type: 'f32' },
    uGlow: { value: MOSS_GLOW, type: 'f32' },          // 0.55
  });
}
const edgeShader = new Shader({ glProgram: edgeProgram, resources: { edge: edgeU } });
const glowShader = new Shader({ glProgram: edgeProgram, resources: { edge: glowU } }); // same keys, same order

const shared = g.getBuffer('aPosition');
const gm = interleavedGeometry(ch.edge, ch.mossIndices, EDGE_STRIDE_FLOATS * 4, TERRAIN_EDGE_ATTRS, `${label}:moss`, shared);
const twin = new Mesh({ geometry: gm, shader: glowShader });
twin.blendMode = 'add';
glowContainer.addChild(twin);            // under ctx.glow.world
```

```glsl
// fragment, moss branch (MOSS_* and SPILL_WARM are vec3 literals interpolated from terrainShading.ts)
float speck = smoothstep(0.6, 0.88, sw_vnoise(vWorld * 0.62 + vec2(30.0, 0.0)));
if (uGlowPass > 0.5) {
  finalColor = vec4(MOSS_GLOW_COLOR * (a * (0.2 + 0.8 * speck) * uGlow), 0.0);
  return;
}
vec3 c = mix(MOSS_BASE_COLOR, MOSS_GLOW_COLOR, 0.22 + 0.78 * speck) + SPILL_WARM * (vSpill.x * 0.6);
finalColor = vec4(c * a, a * 0.94);
// AA-feather branch: the glow pass outputs vec4(0.0), so a stray feather strip contributes nothing
// (the twin's index buffer holds only moss triangles anyway)
```

The twin's light is the same noise-driven speck pattern as the scene moss, at a gain of `uGlow`, so
the bloom shimmers exactly where the bright specks are.

When you tear it down, twins share buffers, so collect every geometry's buffers in a `Set`, destroy the
geometries with `destroy(false)`, and then destroy each buffer once.

Per-frame uniforms that affect coverage (here `uAA`) must be written to **both** groups.

## 3. Emissive-only kit meshes (decor)

The kit shader's `uMode` selects the output. Glow mode (4) writes only the emissive light:

```glsl
vec3 g = vTint.rgb * uGlow;                          // per-instance glow colour × layer glow
float e = ch.b * (1.0 - fog * 0.6) * step(1e-4, uGlow);   // B channel = emissive mask
c = mix(c, g * 1.25, e);
if (uMode < 0.5)      finalColor = vec4(c + dither, 1.0);                        // opaque core
else if (uMode > 3.5) finalColor = vec4(g * e * a, 0.0);                         // glow twin
else                  finalColor = vec4((c + dither) * a + g * (e * a * 0.6), a); // band: KIT_GLOW_ADD
```

The twin chunks are built with `emissiveOnly: true`, so instances of elements without an emissive
mask are skipped entirely. That's fewer vertices and no wasted fill on dark grass. The twin uniforms
are the scene uniforms with `glow: DECOR_GLOW` (0.9), and per-frame `uTime`/`uSway` are written to both
groups so the twin sways with its scene copy.

## 4. Sprite twins (hero)

```ts
const twins = new Container({ label: 'hero-glow-parts' });
twins.blendMode = 'add';                         // group blend mode: whole batch additive
for (const att of HERO_PARTS) {
  const sprite = new Sprite({ texture: r.tex, anchor });
  sprite.tint = att.tint;
  body.addChild(sprite);
  if (att.glow > 0) {
    const twin = new Sprite({ texture: r.tex, anchor });
    twin.tint = grey(att.glow * GLOW_GAIN);      // GLOW_GAIN 0.85; stems 0.3, limbs/leaf 0.35–0.4, torso/head 0.5, bud 1
    twins.addChild(twin);
  }
}
// every frame, per part:
slot.sprite.setFromMatrix(m);
if (slot.twin) slot.twin.setFromMatrix(m);
```

A grey tint scales the texture's own colour, so the twin blooms in the texture's baked hue, without the
scene sprite's tint. The eyes have `glow: 0` and get no twin. `glowBody.position` and `glowBody.alpha`
mirror the scene body, and `glowBody.visible` changes only when the hero's visibility changes, never
for animation (that would rebuild the render group).

The scarf twin is a second `Mesh` over the **same** `MeshGeometry`, tinted `grey(0.7)`. A soft `budGlow`
sprite (the halo texture tinted `floraGlow`, radius 13 u, alpha flickering 0.75 ± 0.2) exists only in
the glow slot. It follows the bud's position and seeds a larger halo around the sprout's bud.

## 5. Particle twin

```ts
mk(this.ambient, true, false, this.root);            // scene: additive motes/fireflies/dust
mk(this.burstAdd, true, true, this.root);
mk(this.ambient, true, false, this.glowRoot, 0.75);  // twin over the SAME Mote[]
mk(this.burstAdd, true, true, this.glowRoot, 0.85);
// mk = fixedParticleContainer({ texture, particles, dynamicProperties: { position: true, vertex: true,
//        color: true, rotation, uvs: false } }), blendMode 'add', container alpha, parent.addChild
```

Both containers point at one particle array, so the simulation runs once and each container just
streams the dynamic attributes. Normal-blend particles (leaves, puffs) have no twin. In Pixi 8.21,
call `pc.update()` once after constructing a `ParticleContainer` with `particles`, or its static
buffer is never filled (`fixedParticleContainer` does this).

## 6. Baked halos for parallax layers (no twin)

When the atlas is baked, `haloAt(cx, cy, r, strength)` writes a soft radial alpha
`strength · (1 − d/r)³` into a halo buffer (max-combined). On finalize, wherever halo > coverage, the
texel becomes pure light: emissive is pushed toward 1, rim goes to 0, luminance goes neutral, and alpha
takes the halo value.

```ts
if (haloA > a) {
  const t = (haloA - a) / haloA;
  em += (1 - em) * t;
  rim *= 1 - t;
  lum += (0.5 - lum) * t;
  outA = haloA;
}
```

The kit Band pass then adds `glowColour · e · a · 0.6` in-scene. The halo is fogged with the layer
(`e *= 1 − fog·0.6`) and depth-tested with it, so the terrain occludes it correctly. In
`src/render/gen/kitElements.ts`, halos sit around glowing flower bulbs, mushroom clusters, big flora,
lanterns, bramble thorn tips and tendril tips. In `src/render/gen/trees.ts` they sit around the trunks'
shelf fungi. Radii run 9–62 texels and strengths 0.18–0.4.

## 7. Additive halo sprites (light, not bloom)

- **Hero spirit light:** a 96-texel radial texture (`a = (1 − r)^2.2`, with the rim smoothstepped to 0),
  baked white and tinted `0xcff6ff`. It is scaled to radius 260 u and drawn additively *behind* the hero
  in the scene at alpha 0.11, with a noise flicker (±7 % slow, ±3 % fast). It lifts the nearby world
  and costs one sprite.
- **Lantern and flora light pools:** one additive `ParticleContainer` of soft dots in slot `front`. Only
  colour streams per frame (the flicker), and position, scale and uvs are static.
- **Orbs:** an additive halo sprite in the scene (radius 40, alpha 0.32, warm), plus a core twin
  (`0xf2f2f2`) and a small radial glow sprite (alpha 0.55) in the glow slot.

Build halo textures with `textureFromRgba` (premultiply in place, then `BufferImageSource` +
`new Texture`). `Texture.from` caches by the pixel array, so a reused scratch buffer returns a stale
texture.

## 8. Foreground occlusion pass

The near foreground framing (dark leaves and branches, parallax 1.25–1.6) is drawn into the glow buffer
*after* the twins, with its normal premultiplied blending. Wherever it is opaque, it replaces the glow
with near-black, so a lantern behind a foreground leaf doesn't bloom through the leaf.

```ts
const glowForeground = post.glowOverlayOptions(scene.foreground, glowForegroundMatrix);
// { container: scene.foreground, target: chain[0].target, clear: CLEAR.NONE, frame: chainFrames[0], transform: glowForegroundMatrix }
glowForegroundMatrix.set(gx, 0, 0, gy, 0, 0);          // on every scale change: glow px per view unit
if (scene.foreground.children.length > 0) renderer.render(glowForeground);
```

This re-renders a container that already lives in the scene tree, as the root of a second call into
another target. Pass an explicit, preallocated `transform` that you mutate. Without it, Pixi captures the
container's own `localTransform` the first time and never updates it.
