# Spiritwood — Architecture (Milestone 1)

> Working title. The name lives only in `src/config.ts` (`GAME_TITLE`).

An original, Ori-*inspired* 2D platformer for the browser: a luminous, layered night forest, a glowing
spirit hero with fluid, precise movement, soft light, fog and floating particles. No Ori assets, names,
characters or layouts.

- **Mood:** serene · hushed · bittersweet · hopeful ("Moonlit Hush").
- **Palette** (`PALETTE` in `src/config.ts`): fog deep `#0B1A2E`, fog far `#1F4A63`, silhouette `#050B14`,
  spirit glow `#BFF6FF`, flora glow `#3FE0C5`, warm accent `#FFB45A`, thorns `#FF4D6D`.
  Cool moonlight from the upper left.
- **Hero:** a small spirit child — round head, a sprout antenna with a glowing seed, a trailing scarf of
  light, slim limbs, glowing eyes. Deliberately *not* cat/fox-like.

---

## 1. Stack

| Concern | Choice |
|---|---|
| Language / build | TypeScript 7 (`tsc --noEmit` is the type oracle), Vite 8, static output (`base: './'`) |
| Renderer | PixiJS v8, **WebGL2 only** in M1 (`preference: 'webgl'`); custom GLSL ES 3.0 shaders. WebGPU is deferred: every custom shader would need a WGSL twin. |
| Filters | pixi-filters where a stock filter fits (e.g. Kawase blur for bloom); everything else custom |
| Character animation | In-house bones + SDF-drawn sprite parts + keyframed and procedural motion (no Spine licence) |
| Movement | Custom kinematic controller on a fixed 60 Hz step with interpolated rendering. No physics engine. |
| Levels | LDtk 1.5.3 project JSON (`public/levels/forest.ldtk`), generated from an ASCII map by `tools/level/build-level.ts`, and editable later in LDtk |
| Audio | Deferred to M2 (`src/audio/audio.ts` is an API stub) |
| Input | Keyboard + Gamepad API (standard mapping) |
| Tests | Vitest (`--maxWorkers=2`), headless logic only |

Code style: `erasableSyntaxOnly` — no `enum`, no namespaces, no constructor parameter properties (Node can
run `tools/*.ts` directly). Import local modules with the `.ts` extension. `const X = {...} as const` +
union types replace enums.

---

## 2. Conventions

### 2.1 Coordinates

| Space | Origin / axes | Units |
|---|---|---|
| **World** | top-left of the level, **+x right, +y down** | world units (u). 1 collision tile = `TILE` = 48 u |
| **View** | top-left of the visible view | view units; the view is always `VIEW_H` = 1080 u tall at zoom 1, and `VIEW_H × aspect` wide (aspect clamped to 4:3…21:9) |
| **Layer** | parallax layer's own space (see 2.3) | world units scaled by the layer's parallax |
| **RT pixels** | top-left of a render target | device pixels × dynamic render scale |

- Actors (player, enemies) are positioned by their **feet**: `(x, y)` = bottom-centre of the collider.
  The collider is `[x − w/2, y − h] … [x + w/2, y]`.
- Orbs are positioned by their centre. Rect entities (checkpoints, goal, zones, shafts) use top-left + size.
- Tile `(tx, ty)` covers `[tx·TILE, (tx+1)·TILE) × [ty·TILE, (ty+1)·TILE)`. Ranges are half-open;
  a collider edge exactly on a tile boundary does not overlap the next tile.
- Outside the level: left, right and top are solid walls. Below the bottom is open; falling past
  `pxHeight + KILL_MARGIN` kills the player.
- Angles are in radians; `facing` is `1` (right) or `-1` (left).

### 2.2 Timestep

- The simulation runs at a fixed **60 Hz** (`SIM_DT = 1/60`) with an accumulator
  (`src/core/loop.ts`), at most `MAX_STEPS_PER_FRAME` = 5 steps per frame. Excess time is dropped
  (no spiral of death).
- **Vsync snapping:** a frame delta within 0.25 ms of an integer multiple of `SIM_DT` is snapped to it, so a
  60 Hz display does not jitter between 0 and 2 steps.
- **Interpolation:** everything that moves keeps `prevX/prevY` (set at the start of each step) and
  `x/y`. The renderer draws `lerp(prev, cur, alpha)` with `alpha = accumulator / SIM_DT`. When a
  discontinuity happens (respawn, teleport) the sim sets `prev = cur`.
- **FPS cap:** with the 60 fps cap on, the loop renders on the first rAF at or after the next 60 Hz
  deadline, minus half a rAF interval. Deadlines advance by a fixed 1/60 s, so 120/144 Hz displays
  average 60 fps.
- **Determinism:** the sim uses no wall-clock time, no `Math.random` (use `Rng` from `src/core/rng.ts`)
  and no DOM. Durations are counted in **ticks** (integers). Speeds are u/s and accelerations u/s²,
  multiplied by `SIM_DT`.
- **Input latching:** the input manager is sampled once per render frame. *Pressed* edges are latched
  and delivered to exactly one sim tick: the first tick that runs. If a frame runs zero ticks, the edge
  carries over to the next frame. *Held* state goes to every tick.
- Render-only animation (shaders, particles, rig secondary motion) uses the render clock `frame.time`
  and `frame.dt`, clamped to at most 1/20 s.

### 2.3 Parallax

A layer has a parallax factor `f = (fx, fy)`: 0 = infinitely far, 1 = gameplay plane, >1 = foreground.
Given the interpolated camera centre `C`, zoom `z` and view size `V`:

```
zoomF = 1 + (z − 1)·f
view  = (p − C·f)·zoomF + V/2          // p is in layer space
```

With the camera clamped to the level, a layer covers layer-space x in
`[−(1−f)·Vw/2, f·W + (1−f)·Vw/2]`, a width of `f·W + (1−f)·Vw` (and the same for y with `fy` and height).
`src/render/util/camera.ts` implements this (`applyParallax`, `layerExtent`), and nothing else may
re-derive it.

### 2.4 Depth ordering (overdraw control)

The scene render target has a **depth buffer**. Parallax layers use it in three kinds of pass:

1. **Opaque pre-pass** (slot `opaque`): opaque cores of background layers and the terrain core. These are
   meshes trimmed to the fully-opaque interior of each shape, drawn with **blending off, depth write on,
   depth test on**, **near → far**. Early-Z rejects hidden fragments, so opaque background pixels are
   shaded about once.
2. **Sky** (slot `sky`): one full-screen quad at depth `DEPTH_SKY`, depth test on and no write. It fills
   only the pixels nothing opaque covered.
3. **Transparent passes** (slots `background`, `shafts`): soft edges and translucent parts, **far → near**,
   depth test on, **depth write off**, normal or additive blending.

Depth of a layer: `depthForParallax(f) = 0.05 + 0.9·(1 − clamp(f, 0, 1))` (terrain = 0.05, the farthest
layer ≈ 0.95), sky = `DEPTH_SKY` = 0.99. Shaders write `gl_Position.z = depth·2 − 1`.

Everything from slot `terrain` onwards (decor, entities, hero, particles, fog, foreground) uses Pixi's
default state (no depth test) and simply draws on top in slot order.

**Rule:** anything in slots `opaque`, `sky`, `background` or `shafts` must be a depth-tested custom
shader. Plain Pixi Sprites, Graphics and ParticleContainers have no depth test, so they would paint
over the terrain drawn in the pre-pass. They may only be used from slot `terrain` onward.

### 2.5 Colour and alpha

- Pixi textures and render targets are **premultiplied alpha**, and custom fragment shaders output
  premultiplied colour.
- Palette colours are `0xRRGGBB` numbers in `config.ts`. Use `src/core/color.ts` to convert them to
  linear floats for uniforms (sRGB-ish in M1: no linear-light pipeline, grading is artistic).
- **Dither at the source:** any shader that outputs a smooth dark gradient (sky, fog, layer fog tint,
  composite) adds ±0.5/255 triangular dither (`GLSL_DITHER` in `src/render/shaders/common.ts`).

---

## 3. Frame anatomy

```
rAF ─▶ FixedStepLoop.frame(now)
        ├─ input.beginFrame()               sample keyboard + gamepads, latch edges
        ├─ repeat n∈[0..5] times:
        │     input.nextTick(frame) ─▶ world.step(frame)       (60 Hz, deterministic)
        └─ render(alpha)
              ├─ drain world.events ─▶ pipeline.dispatch(e) ─▶ views.onSimEvent(e)   (particles, hero squash, shake)
              ├─ build FrameInfo (interpolated camera, time, quality)
              ├─ pipeline.render(frame)
              │     ├─ views.update(frame)            (transforms, animation, particles; no allocation)
              │     ├─ PASS 1  scene  ─▶ sceneRT  (w·s × h·s, RGBA8 + depth)
              │     │     opaque → sky → background → shafts → terrain → entities → hero
              │     │     → front → particles → fog → foreground
              │     ├─ PASS 2  glow   ─▶ glowRT   (sceneRT/2, RGBA8, additive emissive twins)
              │     ├─ PASS 3  bloom  ─▶ Kawase blur chain on glowRT (half → quarter)
              │     └─ PASS 4  composite ─▶ canvas: scene + bloom → per-area grade → death fade
              │                                     → vignette → dither
              └─ hud/debug overlay (DOM, throttled to 4 Hz)
```

- **Scene slots** (drawn in this order): `opaque, sky, background, shafts, terrain, entities, hero, front,
  particles, fog, foreground`. The pipeline gives the world-space slots (`terrain, entities, hero, front,
  particles, shafts`) the camera transform (parallax 1). Parallax slots (`opaque, sky, background, fog,
  foreground`) get an identity *view-space* transform, and their owners place each layer with
  `applyParallax`.
- **Glow slots:** `world, entities, hero, particles`. These are additive, emissive-only "twins" of
  content drawn from slot `terrain` onward (moss rim, decor flora, lanterns, thorn tips, orbs, hero,
  fireflies, shaft dust). The glow RT has no depth buffer, so **parallax-layer content is never
  twinned**: it would bloom through the terrain. Background flora bakes its halo into the scene
  instead.
- **Dynamic resolution:** the scene and glow RTs are `canvasPx × renderScale`. `renderScale` changes in
  0.05 steps, at most once per second. The composite upsamples bilinearly.

---

## 4. Module ownership

Ownership is by file. An agent edits only files it owns. `src/contracts/**`, the shared utilities and
the configs are **frozen**: changing them needs the main session.

| Owner | Files | Summary |
|---|---|---|
| **main** (frozen contracts) | `ARCHITECTURE.md`, `README.md`, `CLAUDE.md`, `package.json`, `tsconfig.json`, `vite.config.ts` (incl. the KTX2 transcoder plugin), `index.html`, `src/config.ts`, `src/contracts/**`, `src/core/{math,rng,color,todo}.ts`, `src/render/gen/{noise,sdf}.ts`, `src/render/util/**`, `src/render/shaders/common.ts`, `tools/preview/png.ts`, `tests/shared/**` | Types, constants, pure shared helpers |
| **main** (integration) | `src/main.ts`, `src/game/**`, `src/audio/**` | Boot, orchestrator, glue |
| **SIM** agent | `src/core/{loop,events}.ts`, `src/input/**`, `src/level/**`, `src/sim/**`, `tools/level/**`, `public/levels/**`, `tests/{core,input,level,sim}/**` | Loop, input, LDtk loading, collision, player controller, camera, world rules, enemy, level content |
| **WORLD** agent | `src/render/gen/**` (except noise/sdf), `src/render/layers/**`, `src/render/terrain/**`, `src/render/fx/**`, `src/render/world.ts`, `src/assets/**`, `public/layers/**`, `tools/plates/**`, `tools/preview/world/**`, `tests/world/**` | Procedural kit and atlases, hull trimming, parallax stack, sky, fog, terrain meshing, decor, thorns, particles, light shafts, layer manifest, chunk streaming, KTX2/WebP |
| **PIPE** agent | `src/render/pipeline.ts`, `src/render/pipeViews.ts`, `src/render/post/**`, `src/render/hero/**`, `src/render/entities/**`, `src/settings/**`, `src/debug/**`, `src/ui/**`, `src/content/**`, `tools/preview/pipe/**`, `tests/pipe/**` | Renderer, RTs and passes, bloom, composite and grading, hero rig and view, orb/checkpoint/enemy/goal views, quality presets, dynamic resolution, debug overlay, bench mode, HUD and menu |

Dependency rule: `sim/`, `level/`, `input/` and `core/` never import `pixi.js` or `render/**`.
`render/**` reads sim state only through `SimView` (the contracts), never through concrete sim classes.

---

## 5. Subsystem specs

### 5.1 Player controller (`src/sim/player.ts`, tuning in `src/sim/tuning.ts`)

A kinematic AABB of 28 × 58 u, resolved against the tile grid with swept, axis-separated moves:
X first, then Y. The sweep scans every tile column or row the leading edge crosses, so there is no
tunnelling at any speed.

| Feature | Rule |
|---|---|
| Run | Accelerate toward `moveX·maxRunSpeed` with `groundAccel`. Use `turnAccel` when reversing and `groundDecel` with no input. In the air, use `airAccel`, `airTurnAccel` and `airDecel`. |
| Jump | `gravity` and `jumpVelocity` are derived from `jumpHeight` and `jumpTimeToApex`. |
| Variable height | While rising with jump **not held**, gravity × `jumpCutGravityMult`. |
| Apex hang | While `abs(vy) < apexThreshold` and jump is held, gravity × `apexGravityMult`. |
| Fall | Gravity × `fallGravityMult`, capped at `maxFallSpeed`, or `fastFallSpeed` while holding down. |
| Coyote time | Can ground-jump for `coyoteTicks` after walking off a ledge. Consumed by a jump. |
| Jump buffer | A press is remembered for `jumpBufferTicks`, and fires on the first tick a jump becomes legal. |
| Wall slide | Airborne, falling, touching a wall and holding toward it: `vy ≤ wallSlideMaxSpeed`. The wall stays "stuck" for `wallStickTicks` after input stops pointing at it. |
| Wall jump | Legal while wall-sliding or within `wallCoyoteTicks` of leaving a wall. Sets `vx = −wallDir·wallJumpVx`, `vy = −wallJumpVelocity`. For `wallJumpLockTicks`, horizontal control ramps back from 0 to 1, so you can climb one wall by re-pressing into it. |
| Double jump | `airJumps` = 1. Restored on landing or when touching a wall. |
| Dash | Horizontal, in the input direction (else facing), `dashSpeed` for `dashTicks`, with gravity off. `airDashes` = 1, restored on ground or wall. `dashCooldownTicks` applies. At the end, `vx = sign·dashEndSpeed`. A jump press during the dash cancels it and keeps horizontal momentum. |
| Corner correction | A rising head hitting a ceiling corner within `cornerCorrection` u is nudged sideways. |
| Ledge assist | A dash or run hitting a wall top within `ledgeAssist` u pops up onto the ledge. |
| One-way platforms | Solid only from above (feet at or above the top on the previous tick and moving down). Down + jump drops through for 12 ticks. |
| Hazards | Overlapping thorn tiles, inset by `HAZARD_INSET`, kills the player. |
| Squash & stretch | Render-only. The controller emits events (`Jump`, `Land(impactSpeed)`, `Dash`, …) and the hero view springs its scale from them. |

### 5.2 Camera (`src/sim/camera.ts`)

Simulated on the fixed step with prev/cur interpolation.

- **Dead zone:** a centred rect (`deadZoneW × deadZoneH`). The camera target moves only when the player
  leaves it.
- **Look-ahead:** `lookAheadX` in the velocity or facing direction. Engages above
  `lookAheadMinSpeed` and is smoothed with its own `smoothDamp`. It releases slowly on stop, so the view
  does not ping-pong on turn-around.
- **Vertical:** follows landings (platform snapping) rather than every jump arc. Looks down by up to
  `lookDownMax` when falling faster than `lookDownFallSpeed`.
- **Smoothing:** critically damped `smoothDamp` per axis (`smoothTimeX` and `smoothTimeY`).
- **Bounds:** clamped to the level rect. `snapTo()` teleports and marks `snapped` (no interpolation that
  frame).

### 5.3 World rules (`src/sim/world.ts`)

- **Orbs:** within `orbMagnetRadius` they accelerate toward the player. Contact collects them
  (`OrbCollected` event). Collected orbs stay collected after death.
- **Checkpoints:** overlap activates one and sets the respawn point (`CheckpointActivated`).
- **Death:** caused by thorns, an enemy or the kill plane. `Died` event → `dyingTicks` (hero hidden, fade
  to 1) → respawn at the last checkpoint (`Respawned`, camera snap) → fade back to 0 over `fadeInTicks`.
  Input is ignored while dying.
- **Enemy "Gloomcrawler":** patrols `[patrolMinX, patrolMaxX]` on its platform and turns at range ends,
  walls and edges. Touching it kills the player, *unless* the player is falling and their feet are
  above its top. Then it is stomped: the player bounces (`bounceVelocity`), the enemy is stunned for
  `stunTicks`, then it re-forms.
- **Goal "Moonwell shrine":** overlap sets `completed` (`GoalReached`).

### 5.4 Level content (`tools/level/`, `public/levels/forest.ldtk`)

The level is one LDtk level, "Forest_Night", `200 × 50` tiles (9600 × 2400 u, about 5 screens wide and
2.2 tall).

- **IntGrid layer `Collision`:** 1 Solid, 2 OneWay, 3 Thorns.
- **Entities:** `PlayerStart`, `Orb`, `Checkpoint`, `Enemy` (its width is the patrol span), `Goal`,
  `LightShaft` (resizable; fields `angle`, `intensity`), `GradeZone` (resizable; fields
  `grade: AreaGrade`, `blend`), `Lantern`, `Flora`.

Five areas, left to right, each with a colour grade:

1. **Hollow Glade** (`glade`): the start. Gentle ground, first orbs, one light shaft, and checkpoint 1.
2. **Thorn Gully** (`gully`): a thorn pit crossed with ledges and the double jump; a checkpoint after it.
3. **Rootwell** (`rootwell`): a vertical shaft climbed by wall jumps, with orbs along the climb.
4. **Canopy Walk** (`canopy`): high gaps that need dash + double jump, the Gloomcrawler on a long
   platform, and light shafts.
5. **Moonwell** (`shrine`): a descent into a warm, lantern-lit clearing with the goal shrine.

### 5.5 Visual pipeline

**Parallax stack** (WORLD). The manifest `public/layers/forest.manifest.json` lists the layers far → near.
With the full High budget there are 10 kit layers plus sky and fog:

| # | f | Content | Notes |
|---|---|---|---|
| sky | 0 | Gradient, moon with halo, sparse twinkling stars, high mist | Shader. Opaque via depth test. |
| L1–L3 | 0.08–0.3 | Far treelines and mist-drowned trunks | Heavy fog and desaturation. Masses fade out at the bottom (no full-height fill). |
| L4–L6 | 0.4–0.7 | Mid trees, roots, hanging vines, a few glowing flowers | Moderate fog; vertex sway on vines and foliage. |
| L7–L8 | 0.8–0.92 | Near-mid gnarled trunks and roots, glowing flora | Little fog, strong rim light. |
| terrain | 1 | Gameplay plane | See below. |
| F1–F2 | 1.25–1.6 | Dark, soft (baked-blur) framing: leaves, branches, roots at the screen edges | Near-black, top and bottom bands only. Cheap. |

- **Kit layers:** instances of **kit elements** (procedurally generated silhouettes: trunks, canopies,
  roots, vines, grass, rocks, ferns, flora). The elements are packed into one atlas. **Atlas channels:**
  R = luminance detail, G = rim-light mask (lit from the upper left), B = emissive mask, A = coverage.
- Each layer chunk merges its instances into **one static mesh**, drawn with **one draw call** using
  the kit shader. The shader tints by depth (`tint`, `fog`, `desaturate`), adds rim light, emissive and
  wind sway (per-vertex weight and phase, only when `sway > 0`). A shape's hull splits into an **opaque
  core** (alpha ≥ 0.995, pre-pass) and a **soft band** (transparent pass).
- **Terrain** (WORLD): an SDF of the solid tiles (rounded corners r = 10 u, fbm-displaced ≤ 4 u, with
  flat tops kept flat). It is marching-squared on a 12 u sub-grid into chunked meshes: an opaque core,
  a 2-pixel AA edge strip, and a **moss rim** strip on up-facing edges (emissive, twinned into glow).
  The core shader shades by distance-to-surface plus world-space noise.
- **Decor** (WORLD): seeded placement from the grid. Grass tufts on floors (front and back, with sway),
  vines from ceilings (sway), glowing flora and mushrooms, `Flora`/`Lantern` hint entities, and thorn
  brambles on hazard tiles (dark stems with `#FF4D6D` glowing tips).
- **Light shafts** (WORLD): additive trapezoid meshes with a scrolling-noise shimmer, depth-tested behind
  the terrain, and dust motes that are brighter inside a shaft.
- **Particles** (WORLD): pooled `ParticleContainer`s sharing one particle atlas. Ambient motes, fireflies
  (wander plus blinking glow) and falling leaves (tumble) are spawned around the camera. Bursts come from
  sim events: land dust, jump puff, dash streak, orb sparkle, death burst and respawn gather.
- **Hero** (PIPE): an in-house rig (see 5.6) drawn from an SDF-baked part atlas with a baked soft rim.
  An additive spirit-light halo sits behind it (it lights the nearby world), and there is a glow twin
  for bloom.
- **Post** (PIPE): bloom from glowRT (Kawase, half then quarter resolution), then the composite.
  The composite applies exposure, contrast, saturation, lift/gamma/gain and temperature from the
  **per-area grade**. The grade is blended by the camera's position in `GradeZone`s (`blend` u
  cross-fade). Then come the death fade (to `fogDeep`), vignette and dither.

### 5.6 In-house rig (`src/render/hero/rig.ts`)

- `Skeleton`: bones with parent index, rest transform and length, evaluated into world matrices in
  place (preallocated `Float32Array`).
- `Clip`: keyframed bone channels (rotation, x, y, scaleX, scaleY) with cubic-Hermite/ease sampling.
  Clips: `idle, run, jump, fall, land, wallSlide, wallJump, doubleJump (flip), dash, dead`.
- `Animator`: a state-driven clip blender (cross-fade 60–120 ms). Run speed is scaled by `|vx|`.
- **Procedural layers:** lean into acceleration, head look toward velocity, a spring on the sprout
  antenna, a verlet scarf ribbon (8 points), breathing, and a squash/stretch spring (volume-preserving,
  pivot at the feet).

### 5.7 Settings, quality and dynamic resolution (PIPE)

| | Low | Medium | High |
|---|---|---|---|
| Pixel-ratio cap | 1 | 1 | 1.5 |
| Initial render scale | 0.75 | 0.9 | 1.0 |
| Min render scale (dynres) | 0.5 | 0.6 | 0.7 |
| Max render pixels | 1280×720 | 1600×900 | 2560×1440 |
| Kit layers (layer budget) | 6 | 8 | 10 |
| Particles density | 0.35 | 0.65 | 1.0 |
| Bloom | quarter res, 2 passes | half, 3 passes | half, 4 passes |
| Light shafts, sway | shafts on, sway off | on | on |
| Fog bands | 1 | 2 | 2 |

- **Auto:** reads `WEBGL_debug_renderer_info` (when exposed). Integrated GPUs (Intel UHD/Iris, AMD
  APUs, unknown) get **High features with pixel-ratio cap 1 and dynamic resolution on**. Discrete GPUs
  get High. Software renderers (SwiftShader, llvmpipe) get Low.
- **Dynamic resolution** (`src/settings/dynres.ts`, pure): uses GPU time from
  `EXT_disjoint_timer_query_webgl2` when available, else frame-time misses. Two or more frames in the
  last 30 over 17.5 ms steps the scale down 0.05. Three seconds with no misses (and GPU time under 13 ms,
  when known) steps it up 0.05. At most one change per second, clamped to [min, initial].
- **Persisted** in `localStorage` (guarded with try/catch): preset, pixel-ratio cap override, fps cap
  (60 or uncapped), dynamic resolution and the debug overlay.
- **Keys:** `Esc` or Start = menu, `F3` = debug overlay, `F4` = collision/hitbox debug draw,
  `R` = respawn at the checkpoint.

### 5.8 Asset pipeline hooks (WORLD)

- **Layer manifest** (`src/contracts/assets.ts`): layers of kind `sky | fog | kit | plate`.
  - A `kit` layer names an atlas and a recipe. In M1 the atlas source is `{ procedural: 'forest-kit' }`,
    generated at load.
  - A `plate` layer is a grid of **chunks**, each with a `TextureSourceDef { ktx2?, webp?, png? }` and
    optional precomputed `hull` / `opaqueHull` polygons (so painted plates keep tight meshes).
- **Chunk streaming** (`src/assets/streamer.ts`, pure logic): computes the chunks visible from the camera
  plus a margin (in layer space via `layerExtent`/parallax). It loads by priority (nearest first, at most
  2 in flight) and evicts least-recently-visible chunks past `textureBudgetMB[level]`.
- **Texture resolution** (`src/assets/textures.ts`): KTX2 (Basis via `pixi.js/ktx2`) when the GPU
  supports a compressed format. Otherwise WebP, then PNG. The libktx transcoder is self-hosted at
  `transcoders/ktx/`: the Vite plugin serves it in dev and emits it at build. Every texture registers
  its bytes with `TextureBudget` (shown in the debug overlay).
- **Bake tool** (`tools/plates/bake-plates.ts`, Node + sharp + ktx2-encoder): renders a plate to PNG,
  then writes WebP + KTX2 (ETC1S, mipmapped) chunks and tight hull polygons alongside a manifest. M1
  ships one demo plate layer in `public/layers/forest.plates.manifest.json` (open with
  `?manifest=plates`). This exercises the whole painted-plate path, and painted or AI-generated plates
  go through the same tool.

---

## 6. Performance budget (hard requirement)

Target: **60 fps at 1920×1080 on Intel Iris Xe** (the i7-12700H iGPU), preset Auto, which resolves to
High features with pixel-ratio cap 1 and dynamic resolution.

| Budget | Limit |
|---|---|
| Frame | 16.6 ms. GPU ≤ 12 ms, main-thread CPU ≤ 6 ms |
| Sim | ≤ 0.5 ms per frame (1–2 steps) |
| Render CPU (view updates + Pixi submit) | ≤ 3.5 ms |
| Draw calls | ≤ 120 (target ≈ 70) |
| Scene fill at internal res (full-screen equivalents) | ≤ 6.0: opaque pre-pass ≈ 1.2, sky ≤ 0.5 (after depth reject), transparent layer bands ≤ 1.5, shafts ≤ 0.3, terrain edges and decor ≤ 0.4, entities and hero ≤ 0.2, particles ≤ 0.3, fog bands ≤ 0.6 (each ≤ ⅓ screen tall), foreground ≤ 0.5 |
| Post fill (full-screen equivalents at 1080p) | glow twins ≤ 0.1 (half res), bloom chain ≤ 0.4, composite 1.0 |
| Texture memory per area | High ≤ 96 MB, Medium ≤ 64 MB, Low ≤ 48 MB. This covers atlases and streamed plates, **excluding** render targets (≈ 13 MB at 1080p) |
| Allocation | **Zero allocations per frame in hot paths**: sim step, view `update`, particles, pipeline render. Preallocate, pool, and use index loops; no closures, spreads, `for…of`, `map/filter` or string building per frame. The debug overlay formats text at ≤ 4 Hz. |
| Batching | Kit layers: 1 draw per chunk per pass. Particles: 1 draw per `ParticleContainer`. Hero: 1 draw (one atlas) plus halo. |
| Transparent full-screen layers | Must be cheap shaders: at most one texture fetch or a small analytic noise, and no dependent loops. |

**Verification.** The debug overlay (F3) shows fps (average and 1% low), frame, sim and render CPU ms,
GPU ms (timer query), draw calls, estimated fill (sum of on-screen mesh bounds ÷ screen area), render
scale and RT size, particles and texture MB. `?bench` runs a 30 s scripted camera flythrough through
all five areas at the chosen preset and prints average fps, 1% low and frame-time p50/p95/p99. It is the
acceptance test to run on the Iris Xe laptop.

---

## 7. Testing and acceptance

- `npm run typecheck` (tsc 7, strict), `npm test` (Vitest, `--maxWorkers=2`), `npm run build`: all green.
- Headless tests cover:
  - **Controller physics:** jump height and time, the variable-jump minimum, coyote and buffer tick
    limits, wall slide cap, wall jump, double jump count, dash distance and cooldown, corner correction,
    one-way platforms, no tunnelling.
  - **Collisions**, the **LDtk loader** (the real `forest.ldtk`, plus level validation: spawns on
    ground, entities inside bounds and not inside solids), camera dead zone and look-ahead, and the loop
    (step counts, vsync snap, fps cap, edge latching).
  - **Pure render helpers:** hull trimming, marching squares, parallax maths, grade blending, dynres
    decisions, manifest validation, chunk streaming.
- Visual checks (main session only): screenshots of each area, reviewed and iterated.
- Machine safety: at most 3 concurrent agents. Agents never launch browsers or dev servers.
- Browser-free visual checks: CPU-generated textures and compositions are written to PNG with
  `tools/preview/png.ts` and inspected as images (`tools/preview/{world,pipe}/`).
