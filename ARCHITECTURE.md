# Spiritwood — Architecture (Milestones 1–2)

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
| Filters | pixi-filters is installed, but M1 uses none on its hot paths. Pixi `Filter`s render into pooled targets without depth, which breaks the depth-ordered scene. KawaseBlurFilter cannot downsample and pads its input, so bloom is an owned dual-filter chain. pixi-filters stays available for occasional full-screen composite effects (M2). |
| Character animation | In-house bones + SDF-drawn sprite parts + keyframed and procedural motion (no Spine licence) |
| Movement | Custom kinematic controller on a fixed 60 Hz step with interpolated rendering. No physics engine. |
| Levels | LDtk 1.5.3 project JSON (`public/levels/forest.ldtk`), generated from an ASCII map by `tools/level/build-level.ts`, and editable later in LDtk |
| Audio | Web Audio API, **synthesized at runtime** (no audio files): SFX patches, generative per-area music, ambience (§5.9) |
| Painted art | `art/plates/*.png` + JSON sidecars baked by `npm run art` into streamed plate layers, with dev hot reload (§5.8) |
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
- **Vsync snapping:** a frame delta within 1 ms of an integer multiple k ≥ 1 of `SIM_DT` is snapped to
  it, so a 60 Hz display does not jitter between 0 and 2 steps. This also covers browsers that coarsen
  timestamps to 1 ms. `render` receives the raw (unsnapped) delta.
- **Interpolation:** everything that moves keeps `prevX/prevY` (set at the start of each step) and
  `x/y`. The renderer draws `lerp(prev, cur, alpha)` with `alpha = accumulator / SIM_DT`. When a
  discontinuity happens (respawn, teleport) the sim sets `prev = cur`.
- **FPS cap:** keep an EMA of the rAF interval (`rafEst`, starting at 16.67 ms; samples are clamped to
  4–50 ms). A frame is rendered when `now ≥ deadline − rafEst/2`. Then `deadline += 1000/cap`. A late
  frame (a deadline was missed) resyncs to `now + 1000/cap`, so one missed deadline is counted once and
  hitches don't unleash uncapped frames. This averages exactly the cap on 120/144/165 Hz displays.
  `render` receives the raw wall-clock dt; the pipeline clamps its own render clock. A reset frame
  after `resetClock()` reports one nominal rAF interval.
- **Accumulator in ticks:** `accTicks += dt'·hz`. Loop `while (accTicks ≥ 1 − 1e-6 && n < max)`.
  After the clamp, whole ticks are dropped (counted in `droppedSeconds`). `alpha = clamp01(accTicks)`.
  `setPaused(true)` runs no steps and sets alpha = 1, so the frozen scene does not wobble.
  `resetClock()` re-initialises on the next frame.
- **Late frames:** `lateFrames` is the number of render deadlines missed before this frame. It is the
  frame-pacing signal for dynamic resolution and the bench.
- **Determinism:** the sim uses no wall-clock time, no `Math.random` (use `Rng` from `src/core/rng.ts`)
  and no DOM. Durations are counted in **ticks** (integers). Speeds are u/s and accelerations u/s²,
  multiplied by `SIM_DT`.
- **Input latching:** the input manager is sampled once per render frame. Presses are counted per
  action (capped at 2). At most one press is delivered per tick; the rest carry over to later ticks and
  frames, and so do presses in a frame that runs zero ticks. A tick that delivers a press also reports
  the action as held. *Held* state goes to every tick.
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

Static layer geometry covers the **union** of `layerExtent(W, H, VIEW_H·MIN_ASPECT, VIEW_H, fx, fy,
MIN_CAMERA_ZOOM)` and the same call at `VIEW_H·MAX_ASPECT`. Instance placement never depends on the
current window aspect, so the forest never reshuffles on resize.

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

Depth of a layer: `depthForParallax(f) = 0.05 + 0.9·(1 − clamp(f, 0, 1))` (terrain = `DEPTH_TERRAIN`
0.05, the farthest layer ≈ 0.95), shafts `DEPTH_SHAFTS` 0.055, sky `DEPTH_SKY` 0.99. Shaders write
`gl_Position.z = depth·2 − 1`.

- **Instances within a layer** get `depthForInstance(f, k) = depthForParallax(f) − k·DEPTH_INSTANCE_EPS`,
  where k is the painter order (0 = backmost, at most `MAX_INSTANCES_PER_LAYER`), carried in a per-vertex
  `aDepth` attribute. Overlapping instances then resolve front-over-back.
- **Index order:** core meshes are indexed front → back (for early-Z); band meshes back → front.
- **Parallax constraints:** depth-tested layers need `fx ≤ MAX_LAYER_PARALLAX` (0.95) and a gap of at
  least `MIN_LAYER_PARALLAX_GAP` (0.02) between consecutive layers. The manifest validator enforces both.

**Pixi recipe** (verified against pixi.js 8.21):

- The scene target is `new RenderTarget({ colorTextures: [sceneTexture], depth: true })`. A plain
  `RenderTexture` target has **no depth buffer**, and the depth test then silently passes everything.
- `renderer.render({ …, clear: CLEAR.ALL })` clears depth to 1.0. Pixi never calls `gl.depthFunc`, so
  the depth test is the WebGL default **LESS**.
- Use the States from `src/render/util/states.ts`:
  - `createOpaqueState()`: blend off, depth test on, depth write on.
  - `createSkyState()`: blend off, depth test on, depth write off.
  - `createTransparentState()`: blend on, depth test on, depth write off.
- For additive meshes set `mesh.blendMode = 'add'`. Never assign `state.blendMode`: MeshPipe overwrites
  it every frame, and the setter re-enables blending.
- Opaque and sky fragment shaders never `discard` or write `gl_FragDepth`, because that disables
  early-Z.
- No `filters`, `mask` or `cacheAsTexture` anywhere under a scene or glow slot. Filters render into
  pooled textures that have no depth.
- The scene colour source has `antialias: false`.

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
  composite) adds ±1/255 TPDF dither from two uniform hashes (`GLSL_DITHER` in
  `src/render/shaders/common.ts`).
- **Precision:** fragment shaders start with `GLSL_FRAGMENT_HEADER` (highp). Pixi otherwise injects
  `mediump`, and uniforms shared with the vertex stage then fail to link.

---

## 3. Frame anatomy

```
rAF ─▶ FixedStepLoop.frame(now)
        ├─ input.beginFrame()               sample keyboard + gamepads, latch edges; any press → audio.unlock()
        ├─ repeat n∈[0..5] times:
        │     input.nextTick(frame) ─▶ world.step(frame)       (60 Hz, deterministic)
        └─ render(alpha)
              ├─ pipeline.render(world, alpha, now, dt, lateFrames)
              │     ├─ render clock += min(dt, MAX_RENDER_DT); world clock += that · timeScale (timeScale eases
              │     │    toward TIME_SCALE_FROZEN while sim.frozen); fill FrameInfo (interpolated camera + shake)
              │     ├─ for each queued sim event: shake + views.onSimEvent(e, frame)   (particles, hero squash)
              │     ├─ views.update(frame)            (transforms, animation, particles; no allocation)
              │     ├─ PASS 1  scene  ─▶ sceneRT  (w·s × h·s, RGBA8 + depth)
              │     │     opaque → sky → background → shafts → terrain → entities → hero
              │     │     → front → particles → fog → foreground
              │     ├─ PASS 2  glow   ─▶ glowRT   (sceneRT × bloomScale, RGBA16F, additive twins,
              │     │                               then the foreground drawn over them to block bloom)
              │     ├─ PASS 3  bloom  ─▶ owned dual-filter chain: bloomPasses × ½ downsamples
              │     │                    (4-tap Kawase), then upsample-add back to glowRT size
              │     └─ PASS 4  composite ─▶ canvas: scene + bloom → per-area grade → death fade
              │                                     → vignette → dither
              ├─ fill AudioFrame; guarded: audio.onSimEvent(e, audioFrame) for each event, then
              │    audio.update(audioFrame) (area moods, panning, leases, launch-aim filter)
              ├─ world.events.clear()                 (always, even if audio failed)
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
- **Dynamic resolution:** the scene and glow targets are allocated once at the maximum size (canvas ×
  initial scale, capped by `maxRenderPixels`). Each frame renders into a sub-rect sized `canvasPx ×
  renderScale` via a preallocated render-options `frame`, and the composite samples
  `uv · (w/W, h/H)`. A scale change never reallocates. `renderScale` moves in 0.05 steps, at most once
  per second.
- **Render groups:** every slot container is `isRenderGroup: true`, so toggling a chunk's `visible`
  rebuilds only that slot's instructions. Views toggle `visible` only when a chunk enters or leaves the
  view, never for animation.
- **Glow format:** `rgba16float` when `EXT_color_buffer_float` is available (Pixi enables it on
  WebGL2); otherwise `rgba8unorm` with dither in the last up-pass. The chain is built from owned
  full-screen-quad meshes, not Pixi `Filter`s. KawaseBlurFilter never downsamples and pads its input, so
  it does not fit the budget.

---

## 4. Module ownership

Ownership is by file. An agent edits only files it owns. `src/contracts/**`, the shared utilities and
the configs are **frozen**: changing them needs the main session.

| Owner | Files | Summary |
|---|---|---|
| **main** (frozen contracts) | `ARCHITECTURE.md`, `README.md`, `CLAUDE.md`, `package.json`, `tsconfig*.json`, `vite.config.ts` (incl. the KTX2 transcoder plugin), `index.html`, `src/config.ts`, `src/contracts/**`, `src/core/{math,rng,color,tiles,todo,csp}.ts`, `src/level/ascii.ts` (`levelFromAscii`), `src/render/gen/{noise,sdf}.ts`, `src/render/util/**`, `src/render/shaders/**`, `tools/preview/png.ts`, `tools/artifact/**`, `tests/tools/**`, `src/assets/embedded.ts`, `tests/world/embedded.test.ts`, `tests/shared/**` (incl. `fixtures.ts`: `levelFromAscii`, `createFakeSimView`) | Types, constants, pure shared helpers, test fixtures |
| **main** (integration) | `src/main.ts`, `src/game/**`, `src/core/zones.ts`, `vite.config.ts` plugin wiring | Boot, orchestrator, glue |
| **SIM** agent | `src/core/{loop,events}.ts`, `src/input/**`, `src/level/**`, `src/sim/**`, `tools/level/**`, `public/levels/**`, `tests/{core,input,level,sim}/**` | Loop, input, LDtk loading, collision, player controller, camera, world rules, enemy, level content |
| **WORLD** agent (M1; split into ART-PAINT and ART-TOOLS in M2) | `src/render/gen/**` (except noise/sdf), `src/render/layers/**`, `src/render/terrain/**`, `src/render/fx/**`, `src/render/world.ts`, `src/assets/**` (except `embedded.ts`), `public/layers/**`, `tools/plates/**`, `tools/preview/world/**`, `tests/world/**` (except `embedded.test.ts`) | Procedural kit and atlases, hull trimming, parallax stack, sky, fog, terrain meshing, decor, thorns, particles, light shafts, layer manifest, chunk streaming, KTX2/WebP |
| **PIPE** agent | `src/render/pipeline.ts`, `src/render/pipeViews.ts`, `src/render/post/**`, `src/render/hero/**`, `src/render/entities/**`, `src/settings/**`, `src/debug/**`, `src/ui/**`, `src/content/**`, `tools/preview/pipe/**`, `tests/pipe/**`; in M2 also `src/render/fx/**` (particles, decor, shafts) | Renderer, RTs and passes, bloom, composite and grading, hero rig and view, orb/checkpoint/enemy/goal views, quality presets, dynamic resolution, debug overlay, bench mode, HUD and menu; M2: Spitter, seed, shrine and Spirit Launch visuals, world clock, volume settings |
| **AUDIO** agent (M2) | `src/audio/**`, `tests/audio/**`, `tools/audio/**` | Synthesized SFX, generative music and ambience, mixing (§5.9) |
| **ART-PAINT** agent (M2) | `src/render/gen/**` (except noise/sdf), `src/render/terrain/**`, `src/render/layers/**` (except `parallaxStack.ts`, `plates.ts`), `tools/preview/world/**`, `tests/world/**` (except the ART-TOOLS and main files) | Painterly pass: brush-stroke bake of the kit atlas, painterly terrain shading (§5.5) |
| **ART-TOOLS** agent (M2) | `src/assets/**` (except `embedded.ts`), `src/render/layers/{parallaxStack,plates}.ts`, `src/render/world.ts`, `public/layers/**`, `tools/plates/**`, `tools/art/**`, `art/**`, `tests/world/{plates,manifest,streamer,textures}.test.ts`, `tests/world/art*.test.ts` | Painted-layer import/export, budgets, dev hot reload, example plates (§5.8) |

Dependency rules:

- `sim/`, `level/`, `input/` and `core/` never import `pixi.js` or `render/**`. `render/**` reads sim
  state only through `SimView` (the contracts), never through concrete sim classes.
- Tile lookups everywhere use `tileAt` (`src/core/tiles.ts`).
- Shaders live beside their owner (e.g. `src/render/layers/kit.glsl.ts`); `src/render/shaders/` is
  main-only.
- The F4 debug draw (tiles, hitboxes) is PIPE's. It is drawn in an overlay after the composite, outside
  `SCENE_SLOTS`, so grading, bloom and the death fade don't affect it. Other views use `onDebugDraw`
  only for their own bounds.
- WORLD's shared atlases (kit, particles) are created in `createWorldViews()`, passed to the views that
  use them, registered once in `ctx.textures`, and destroyed once by a resource-owner view added first.

---

## 5. Subsystem specs

### 5.1 Player controller (`src/sim/player.ts`, tuning in `src/sim/tuning.ts`) — normative

A kinematic AABB of 28 × 58 u, resolved against the tile grid with swept, axis-separated moves: X
first, then Y. The sweep scans every tile column or row the leading edge crosses, so there is no
tunnelling at any speed. A blocked sweep ends exactly on the tile boundary. Thorns never block.

**Per-tick order** in `step`:

1. prev ← cur.
2. Decrement every countdown timer (floor 0).
3. Latch input. A press sets `jumpBuffer = jumpBufferTicks`, so a press on tick p is live on ticks
   p … p + jumpBufferTicks − 1.
4. Resolve the buffered jump. Use contact state from the end of the previous tick and take the first
   legal option in this priority:
   1. **Drop-through:** grounded only on OneWay tiles, and `moveY ≥ downThreshold`. Sets
      `dropThrough = dropThroughTicks`, y += 1, emits DropThrough.
   2. **Ground jump:** grounded or `coyote > 0`. While grounded, coyote = coyoteTicks, so the jump is
      legal on airborne ticks 1…coyoteTicks. A jump zeroes coyote.
   3. **Wall jump:** wall contact on side d within `wallJumpProbe`, or `wallCoyote > 0` (using the last
      d).
   4. **Air jump:** `airJumpsLeft > 0` and vy ≥ −airJumpVelocity. The jump sets vy = −airJumpVelocity.
      An earlier press stays buffered until vy has decayed, so a double jump never lowers the arc.

   Firing consumes the buffer. A jump fired while dashing ends the dash (DashEnd b = 1) and keeps vx. A
   press 1–8 ticks before landing with the air jump available fires the air jump.
5. **Dash start:** a press starts a dash when the cooldown is 0 and the player is grounded or has
   `airDashesLeft > 0`.
   - `dashDir = |moveX| ≥ dirThreshold ? sign(moveX) : (wallSlide ? −wallDir : facing)`.
   - vx = dashDir·dashSpeed, vy = 0, gravity 0.
   - The player moves exactly dashSpeed·dt on each of `dashTicks` ticks, starting on the press tick.
   - Cooldown counts from the start tick.
   - Blocked by a wall after ledge assist: the dash ends with vx = 0 (DashEnd b = 2).
   - Natural end: vx = dashDir·dashEndSpeed (b = 0).
   - Same-tick jump + dash: the dash starts, the jump stays buffered and cancels it next tick (a
     dash-jump). The dash gives no invulnerability.
6. **Horizontal velocity** (not dashing):
   - target = moveX·maxRunSpeed.
   - Rates: accel, turnAccel when sign(moveX) ≠ sign(vx), decel with no input. Ground rates on the
     ground, air rates in the air.
   - For `wallJumpLockTicks` after a wall jump, all horizontal rates are multiplied by
     k/wallJumpLockTicks on tick k.
   - **Over-speed:** when |vx| > |moveX|·maxRunSpeed and (sign(moveX) = sign(vx) or moveX = 0), vx
     decays toward the target at the decel rate, preserving momentum.
7. **Gravity:** a = g × mult, where mult is chosen from vy at the start of the tick, first match wins:

   | Condition | mult |
   |---|---|
   | dashing | 0, and vy = 0 |
   | vy < 0 && !jumpHeld && jumpCuttable | jumpCutGravityMult |
   | \|vy\| < apexThreshold && jumpHeld && inJumpArc | apexGravityMult |
   | vy > 0 | fallGravityMult |
   | otherwise | 1 |

   `inJumpArc` and `jumpCuttable` are set by ground, air and wall jumps and by stomp bounces, and
   cleared on landing and by drop-through. Jump release is ignored for the first wallJumpLockTicks
   after a wall jump.
8. **Integrate (trapezoid, exact for constant acceleration):**
   - vyEnd = min(vy + a·dt, cap), where cap = fastFallSpeed while moveY ≥ downThreshold, else
     maxFallSpeed. dy = (vy + vyEnd)·dt/2.
   - dx = (vx + vxEnd)·dt/2.
   - Impulses (jumps, bounce, dash) overwrite velocity before integration.
9. **Move:** sweepX (with ledge assist), then sweepY (with corner correction, one-ways landable iff
   `dropThrough == 0`).
10. **Contacts:**
    - Update grounded, wall contact, mode and timers.
    - Landing restores airJumps and airDashes and emits Land (a = impact speed, b = fall height).
    - Entering wallSlide (and wall jumping) also restores them. Bare wall contact never does.
    - Update facing, runDistance and airTicks.

**Rules:**

- **Wall slide:** airborne, vy > 0, contact(d), and (moveX·d ≥ dirThreshold or wallStick > 0). Holding
  into the wall sets wallStick = wallStickTicks. While wallStick > 0, input away from the wall is
  ignored (the player stays flush). vy = min(vy, wallSlideMaxSpeed). Every slide tick sets
  wallCoyote = wallCoyoteTicks.
- **Wall jump:** vx = −d·wallJumpVx, vy = −wallJumpVelocity, facing = −d.
- **Facing:**
  - sign(moveX) when |moveX| ≥ dirThreshold, outside the wall-jump lock.
  - dashDir while dashing.
  - −wallDir while wall-sliding.
  - The launch direction on a wall jump.
- **modeTicks** is 0 on the tick a mode is entered.
- **Corner correction:** when an upward Y sweep hits Solid and the player is not dashing, try n =
  1…cornerCorrection, side s = sign(vx) first (the side with the smaller overlap when vx = 0). If the
  body offset by (s·n, remaining dy) is free, x += s·n, redo the Y move, and keep vy. Otherwise the head
  bonks (vy = 0).
- **Ledge assist:** only when sweepX is blocked in the air (vy ≥ 0) or while dashing, never on the
  ground. Try k = 1…ledgeAssist: if the body offset by (sign(dx), −k) is free, y −= k,
  vy = min(vy, 0), and finish the X move.
- **Input:** a tick delivering a press also counts as held (sub-frame taps are consistent). Keyboard ±1
  always passes `dirThreshold`/`downThreshold`.
- **Squash & stretch** is render-only, driven by events.

**Test contract** (read values from the tuning; the numbers below are for DEFAULT_TUNING):

| Move | Expected |
|---|---|
| Full held jump | apex ∈ [jumpHeight, jumpHeight + apexHangExtra + 1] (≈ 172.9 u), at tick 24 ± 1 |
| Tap jump | apex ≈ 70.9 ± 2 u |
| Air jump from rest | ≈ 121.1 ± 2 u |
| Wall jump | ≈ 141.8 ± 2 u |
| Dash | exactly dashSpeed·dashTicks·dt (± 0.01) |
| Single-wall climb | ≥ 130 u gained per cycle |

### 5.1.1 Spirit Launch (M2) — normative

The hero's light latches onto a nearby **seed** (a Thorn Spitter projectile) or **enemy**. The world freezes
while you aim, and releasing launches you along the aim, flinging a seed the opposite way. The ability is
locked until an `AbilityShrine` is touched (§5.3).

**Tuning** (`LaunchTuning`, `DEFAULT_LAUNCH_TUNING` in `src/sim/tuning.ts`). Tests read these values. SIM
may retune them, but must then update the reach tables in §5.4.

| Field | Default | Meaning |
|---|---|---|
| range | 170 u | grab radius, player centre (x, y − h/2) → target centre, inclusive |
| aimMaxTicks | 120 | aiming auto-releases when aimTicks reaches this |
| speed | 1150 u/s | launch speed along the aim |
| flightTicks | 12 | length of the `launched` phase |
| flightGravityMult | 0.35 | the phase's gravity multiplier (it replaces the §5.1 table) |
| graceTicks | 8 | ticks from the release in which enemy and seed contact can't kill |
| regrabTicks | 20 | ticks after the release in which the last target can't be grabbed |
| inputLockTicks | 4 | jump and dash presses on the first ticks from the release are dropped, not buffered, so a mashed jump can't overwrite the launch |
| bufferTicks | 6 | a launch press stays live this long waiting for a candidate |
| seedSpeed | 1000 u/s | speed of a seed flung off (opposite the aim, straight, no gravity) |

**Ticks.**
- The release tick R is flight tick 1.
- The world countdowns `grace`, `inputLock` and `regrab` are set at step 2 of R (§5.3) and decremented at
  step 1 of each later tick. So:
  - grace protects R … R + graceTicks − 1;
  - presses are dropped on R … R + inputLockTicks − 1;
  - the old target can't be grabbed on R + 1 … R + regrabTicks.
- `launchBuffer` is also a world countdown.

**Input.** `InputFrame.launchReleased` is a latched release edge, so a release and re-press inside one
frame still releases. The re-press is then buffered.

**Targets.** Any active seed (either owner) and any enemy (in every mode, stunned included). A target is
**valid** when all of these hold:
- Its centre is within `range` of the player centre.
- The segment between the two centres crosses no Solid tile. The check is a supercover grid walk: a
  segment through a tile corner tests both neighbours and is blocked if either is Solid. OneWay and
  Thorns don't block.
- It isn't the last target while `regrab > 0`. The last target is (kind, id) for an enemy and (id,
  spawnTick) for a seed, so a reused pool slot counts as a new target.

The **candidate** is the valid target nearest the player centre; ties go to seeds, then to the lower id.
It is published at step 8 (LaunchView), and the next tick's grab uses that published candidate, so what
you grab is always the ring you saw.

**Per-tick handling** (step 2 in §5.3, before the player moves):

1. **Aiming** (player mode `launchAim`):
   - aimTicks += 1.
   - Aim = the input vector (moveX, moveY), normalised, when its length ≥ `dirThreshold`. Otherwise it
     is the direction from the target centre to the player centre, so a neutral release pushes you away
     from the target. Otherwise it is (0, −1).
   - Release when `launchReleased`, `!launchHeld` or aimTicks ≥ aimMaxTicks:
     - **Player:**
       - Position unchanged; (vx, vy) = aim × speed; mode `launched`.
       - airJumps and airDashes restored; inJumpArc = jumpCuttable = false; jumpBuffer = 0.
       - groundKind = Empty; coyote = wallCoyote = wallStick = wallJumpLock = dashCooldown =
         dropThrough = 0.
       - facing = sign(aimX) when |aimX| ≥ dirThreshold.
       - grace = graceTicks, inputLock = inputLockTicks, regrab = regrabTicks.
     - **Seed target:** owner = `reflected`, (vx, vy) = −aim × seedSpeed, spawnTick = tick, age = 0,
       lifetime = reflectedLifetimeTicks.
     - **Enemy target:** EnemyHit (cause Launch), and the enemy is stunned: stunTicks for a crawler,
       spitterStunTicks for a player-aimed spitter. A running stun restarts. Fixed-aim spitters are
       never stunned, and enemies are never displaced.
     - Emit Launch; `frozen` = false.
2. **Buffer:** a `launchPressed` sets launchBuffer = bufferTicks, as long as the ability is unlocked, the
   player is alive and not aiming (having just released counts as not aiming). Otherwise the press is
   ignored. A buffer that runs out without a grab emits LaunchFizzle at the player centre.
3. **Grab:** not on a release tick. When launchBuffer > 0 and a published candidate exists:
   - launchBuffer = 0.
   - The player enters `launchAim`: velocity 0, position held. A dash ends with DashEnd b = 3, and a
     wall slide with WallSlideEnd b = 4.
   - `frozen` = true, aimTicks = 0.
   - The target's kind, id, spawnTick and centre are stored, and the aim is computed as on an aiming
     tick.
   - Emit LaunchAim.

   Grabbing is legal on the ground, in the air, while dashing, while wall-sliding and while `launched`
   (chains).

**While aiming** the player step does only prev ← cur and modeTicks += 1:
- no timers run;
- jump and dash presses are dropped;
- airTicks and inputX are frozen.

A death (debug respawn), respawn, teleport or reset cancels the aim, unfreezes the world and emits no
Launch.

**`launched` phase** (player step; flight ticks R … R + flightTicks − 1, modeTicks 0 … flightTicks − 1):
- **Physics:**
  - a = g·flightGravityMult, replacing the §5.1 gravity table whatever the sign of vy.
  - vx is held: input doesn't change it, but a wall zeroes it.
  - The fall cap is max(cap, speed).
- **Collision:**
  - Normal sweeps apply, including ledge assist and corner correction.
  - A wall or ceiling hit zeroes only that axis.
  - No wall slide starts during the phase.
- **Landing:** ends the phase (Land). The release cleared groundKind, so a launch that leaves you on the
  ground lands on R.
- **Presses after inputLock:** a jump press fires the first legal §5.1 jump (the stale coyote and
  wallCoyote are gone), and a dash press dashes. Either one ends the phase.
- **Afterwards:** from R + flightTicks the normal rules apply. Over-speed decays vx toward the input
  target at the air decel rate.

**Freeze.** While `frozen` (= player mode `launchAim`):
- Enemies, projectiles, orbs, checkpoints, shrines and the goal do not step; their prev = cur.
- Hazards are not checked.
- The tick counter, run timer, respawn fade and camera keep going.

**LaunchView** (SimView.launch) is updated in place every tick:
- the candidate fields (empty while aiming, dead or locked);
- the target fields, from the grab until the next grab;
- the aim: the live aim while aiming, the launch direction afterwards;
- aimTicks, aimMaxTicks and range.

**Test contract** (derive expectations from the tuning, with the tick convention above):

| Case | Expected |
|---|---|
| Straight-up launch from rest | apex gain matches the integration ± 2 u (416.2 u by default) |
| 45° launch on flat ground, moveX = +1 after the phase | horizontal distance and airtime match the integration ± 2 u (≈ 495 u, ≈ 51 ticks) |
| Freeze | while aiming, only the player's modeTicks, the launch aim fields and aimTicks, the tick counter, run timer, respawn fade and camera change; the release restores stepping |
| Controller state | after a ground or wall-slide grab, no jump on R + inputLockTicks … fires a ground or wall jump from stale coyote; a dash in progress at the grab leaves the dash usable after the release |
| Grab rules | range edge (inclusive), LOS blocking including corners, seed-first tie-break, regrab window R + 1 … R + regrabTicks including pool-slot reuse, a press up to bufferTicks − 1 ticks early still grabs, fizzle on expiry, no fizzle while locked, dead or aiming |
| Input | a release and re-press inside one frame releases, then buffers |
| Seed flung off | flies −aim at seedSpeed; the first enemy it touches takes EnemyHit (cause Seed) and is stunned, except a fixed-aim spitter (the seed bursts without a hit) |
| Grace | during grace hostile seeds neither kill nor burst and enemy contact doesn't kill; a stomp still bounces |
| Chains | grabbing from `launched` works; abilities are restored on every release |
| Determinism | identical input scripts give identical states |

### 5.2 Camera (`src/sim/camera.ts`) — normative

Simulated on the fixed step with prev/cur interpolation. The framing point is the feet + `targetOffsetY`.

- **X:** an edge-follow dead zone. focusX moves only while |x − focusX| > deadZoneW/2, and only far
  enough to bring x back to the zone edge. Y's dead zone is edge-follow in the same way.
- **Y:** a ground reference `groundRef`.
  - mode ∈ {ground, wallSlide} → groundRef = y.
  - Otherwise, when y > groundRef → groundRef = y.
  - Otherwise, when y < groundRef − airRiseMargin → groundRef = y + airRiseMargin.

  A single jump never moves the camera; a double jump or a climb does. focusY moves to groundRef only
  while |groundRef − focusY| > deadZoneH/2.
- **Look-ahead:** the direction flips to sign(vx) only after |vx| > lookAheadMinSpeed has held for
  lookAheadCommitTicks. It decays to 0 after lookAheadHoldTicks of slow speed, smoothed with
  lookAheadSmoothTime. While the player is in `launchAim` the look-ahead is held: its direction, timers
  and value all freeze.
- **Look-down:** only when vy ≥ lookDownFallSpeed AND the feet are lookDownMinDrop below the last
  grounded y.
- **Smoothing and bounds:** `smoothDamp` per axis. Clamp the *target* (not the output) to the level.
  Centre on the level in an axis where it is smaller than the view.
- **snapTo:** value = target, velocity = 0, zoom = its target with zero zoom velocity, prev = cur,
  snapTick = tick. `setOverride` follows an
  explicit point (bench).
- **Aim zoom (M2):** while the player is in `launchAim`, zoom smooth-damps toward `aimZoom` (1.08,
  `CameraTuning.aimZoom`, time `zoomSmoothTime` 0.18 s); otherwise back to `zoom`. prevZoom interpolates it.

### 5.3 World rules (`src/sim/world.ts`) — normative

**Step order** (M2):

1. prev ← cur for everything; decrement the world countdowns (§5.1.1).
2. A queued `respawn()` kills the player (Debug), which cancels an aim. Then Spirit Launch: aiming and
   release, buffer, grab (§5.1.1). This toggles `frozen`.
3. Player.
4. Unless frozen:
   1. Enemies. Spitters may fire; a seed fired this tick doesn't move until the next tick.
   2. Projectiles: age, move, terrain and enemy collisions, expiry.
5. If alive and not aiming, in order:
   1. Thorns (the hazard AABB inset by `HAZARD_INSET`).
   2. Enemies. During grace the stomp test still runs; only the kill branch is skipped.
   3. Hostile seeds against the player's box at their end positions. Skipped during grace: they neither
      kill nor burst. Tunnelling is impossible: the relative motion is ≤ 43.4 u per tick (seed and fast
      fall both at 1300 u/s), below the 52 u minimum overlap span.
   4. The kill plane (feet y > pxHeight + KILL_MARGIN).
6. If alive and not frozen: orbs, checkpoints, ability shrines, goal.
7. Death and respawn timers.
8. Launch candidate refresh (LaunchView).
9. Camera.

**Enemies:**

- **Stomp** (crawlers only) iff the boxes overlap, player vy > 0, and player.prevY ≤ enemy.prevY −
  enemy.height + stompTolerance. The player bounces with vy = −stompBounceVelocity (cuttable: about
  143 u held, 50 u released).
- Any other overlap with a harmful enemy kills (DeathCause.Enemy): a crawler while patrolling, or a
  spitter in any mode except `stunned`.
- A stunned enemy is harmless and non-solid. It re-forms after its stun at its current position,
  deferred while it overlaps the player. A reflected seed or a launch off a stunned enemy restarts its
  stun.

**Thorn Spitter** (M2, `src/sim/spitter.ts`). `WorldTuning` defaults: spitterWidth 44, spitterHeight 60,
spitterMuzzleHeight 50, spitterWindupTicks 36, spitterStunTicks 300, spitterViewInset 32, plus the LDtk
field defaults.

- **Body:** a rooted plant with a `spitterWidth × spitterHeight` contact box on its feet and its muzzle
  at (x, y − spitterMuzzleHeight).
  - **Harmful from every side** in every mode except `stunned`: touching it kills with
    DeathCause.Enemy. It can't be stomped.
  - Fixed-aim spitters are anchors, not foes: they are never stunned.
- **Active** while the player is alive with its centre within `range` of the muzzle (inclusive). A
  player-aimed spitter also needs:
  - LOS from the muzzle to the player centre (the §5.1.1 walk);
  - its muzzle inside the sim camera's current view, inset by spitterViewInset, so it never fires from
    off-screen.

  Becoming inactive in any mode except `stunned` returns it to `idle`, and the next activation restarts
  the cycle.
- **Cycle** (modeTicks is 0 on entry; W = spitterWindupTicks, C = max(1, period − W)):
  - **Activation:** on its first active step it goes from `idle` to `cooldown` for (phase mod period)
    ticks, or straight into `windup` when that is 0.
  - **Windup:** lasts W ticks. On entry it emits SpitterWindup (a = W) and sets facing toward the player,
    or to sign(fixedVx) for fixed aim (unchanged when that is 0).
  - **Fire:** on the step after the windup's last tick it fires (SeedFired) and enters `cooldown` for C
    ticks, then `windup` again.

  So shots are exactly `period` ticks apart.
- **Fire:**
  - **Slot:** the lowest free projectile slot. With none free the shot is skipped (validate.ts rules this
    out).
  - **Seed:** starts at the muzzle with prev = cur, age 0, lifetime seedLifetimeTicks, owner `hostile`.
  - **Fixed aim:** v = (fixedVx, fixedVy).
  - **Player aim:** a ballistic shot onto the player centre at fire time, with flight time
    T = flightTicks·dt:
    - vx = dx/T and vy = dy/T − ½·seedGravity·T;
    - scaled down to seedMaxSpeed if faster;
    - trapezoid integration makes an unscaled shot exact.
- **Stunned** (player aim only): an EnemyHit from a reflected seed, or a launch off it, stuns it for
  spitterStunTicks. It is harmless and silent. It then re-forms (EnemyReformed, deferred while it
  overlaps the player) into `cooldown` for a full period, or into `idle` if it is inactive.
- Respawn and reset put it back to `idle`.

**Seeds** (M2). `WorldTuning`: seedRadius 12, seedGravity 1400 u/s², seedMaxSpeed 1300 u/s,
seedLifetimeTicks 300, reflectedLifetimeTicks 150, seedOutMargin 240. A fixed pool of `MAX_PROJECTILES`
(SimView.projectiles). Each unfrozen tick (step 4), each active seed:

1. **Age:** age += 1. Age counts only stepped ticks, so aiming doesn't age seeds.
2. **Move:** trapezoid integration. Hostile seeds fall with seedGravity; reflected seeds fly straight.
   Speed is capped at seedMaxSpeed. The move takes n = ceil(|d| / seedRadius) equal sub-steps.
3. **Sub-step checks**, in order:
   - A centre inside a Solid tile bursts it (SeedBurst Terrain). Outside the left, right and top edges
     counts as Solid (§2.1).
   - A reflected seed touching an enemy's box bursts it (Enemy). The enemy takes EnemyHit (cause Seed)
     and is stunned, except a fixed-aim spitter. OneWay and Thorns tiles don't stop seeds.
   - Hostile seeds pass through enemies.
4. **Expiry:** age ≥ lifetime, or more than seedOutMargin below the bottom edge, expires it (SeedBurst
   Expired). A burst frees the slot.

Player contact (step 5):
- A hostile seed whose circle touches the player's box kills (DeathCause.Seed) and bursts (Player).
- Reflected seeds never hurt the player.

Respawn, teleport and reset free every slot silently (no events).

**Ability shrines** (M2): the first time the player's box overlaps an `AbilityShrine` rect,
`launch.unlocked` becomes true and AbilityUnlocked is emitted. Unlocks persist through deaths and
respawns; `reset()` clears them. Tests unlock through `GameWorld.unlock(ability)`: playthrough segments
start with `teleport`, which never passes the shrine.

**Death timeline** (death tick D):

- `kill` sets deadTicks = 0 and emits Died (x, y = body centre).
- fade(D + k) = min(1, k/fadeOutTicks). The hero is visible for `deathHideTicks`, then hidden.
- At D + dyingTicks, respawn at the active checkpoint's bottom-centre (x + w/2, y + h), else at
  playerStart. Reset enemies to their spawn state, free every projectile slot, return uncollected orbs
  to their spawns un-magnetised, snap the camera, set warpTick, and emit Respawned.
- The player is visible and controllable from the respawn tick. fade(R + k) = max(0, 1 − k/fadeInTicks).
  There is no invulnerability.
- `respawn()` (debug R) queues a Debug death for the next step and is a no-op while dead. Nothing
  kills a dead player.

**Checkpoints:** the latest one touched becomes active. CheckpointActivated fires only on a change.

**Orbs:**

- Distance is measured to the player centre (x, y − height/2).
- Within orbMagnetRadius an orb becomes magnetised permanently:
  v = approach(v, dir·orbMaxSpeed, orbMagnetAccel·dt).
- Collected at distance ≤ orbCollectRadius. Collected orbs stay collected after death.

**Timer:** `elapsed` counts ticks from the first tick with non-neutral input until GoalReached, which
fires once. Input continues after completion.

### 5.4 Level content (`tools/level/`, `public/levels/forest.ldtk`)

The level is one LDtk level, "Forest_Night", `200 × 50` tiles in M1 (9600 × 2400 u, about 5 screens wide
and 2.2 tall). M2 widens it to at most **260 × 50** for the Thornveil (every kit layer stays far under
`MAX_INSTANCES_PER_LAYER`: 76 instances at 260 tiles).

- **IntGrid layer `Collision`:** 1 Solid, 2 OneWay, 3 Thorns.
- **Entities:** `PlayerStart`, `Orb`, `Checkpoint`, `Enemy` (its width is the patrol span), `Goal`,
  `LightShaft` (resizable; fields `angleDeg`, `spread`, `intensity`), `GradeZone` (resizable; fields
  `grade: AreaGrade`, `blend`), `Lantern`, `Flora`; M2: `Spitter` (fields in `SpitterDef`, enum
  `SpitterAim`) and `AbilityShrine` (resizable; field `ability`, enum `Ability`). The loader validates both
  (a spitter stands on a Solid or OneWay floor tile with its box clear of Solid; a shrine rect is inside
  the level and not inside Solid). Spitter `angleDeg` → (fixedVx, fixedVy) snaps components with
  |c| < 1e-9 to 0, so 90° is exactly vertical.
- **Workflow:** edit `tools/level/forest.map.txt` (format documented at its top), then `npm run level`.
  `node tools/level/build-level.ts --check` and `tests/level/forest.test.ts` fail when the committed
  `.ldtk` is stale. `node tools/level/preview-level.ts out.png` renders a map preview, and
  `node tools/level/masses.ts` lists the gameplay views with the most dead rock.
- **ASCII:** `src/level/ascii.ts` (`levelFromAscii`, `ASCII_TILES`) is the one ASCII legend, shared by
  tests, `CollisionGrid.fromAscii` and `tools/level`.

**Reach** (DEFAULT_TUNING, trapezoid, jump held, running at 440 u/s):

| Move | Reach |
|---|---|
| Full jump rise | 172.9 u (3.6 tiles) |
| Jump + double-jump peak | 293.9 u (6.1 tiles) |
| Flat run-jump | 345 u of feet travel |
| Jump + double jump (air jump at the apex) | 550 u (11.5 tiles) |
| Jump + double jump, late air jump (restarts the arc) | ≈ 650 u (13.5 tiles) |
| Jump + double jump + dash at the second apex | 765 u (15.9 tiles) |
| Jump + air dash, cancelled by the air jump (keeps 1180 u/s) | ≈ 1064 u leading edge (22 tiles) |
| Ground dash → coyote jump (cancels) + air dash + air jump (cancels) | ≈ 1346 u leading edge (28 tiles); ≈ 1137 u onto a ledge 6 tiles higher |
| Dash | 196.7 u |

Coyote time (≈ 51 u) and the collider width widen the crossable gaps. The air jump sets vy =
−airJumpVelocity whenever it fires, so a *late* double jump restarts the arc. A jump that cancels a
dash keeps the dash's vx, which then decays at airDecel, so dash-jumps outreach every other move.

The vertical reach without launch is the 293.9 u peak, plus 12 u of ledge assist, plus ≈ 14 u from
a crawler stomp: ≈ 320 u, under 7 tiles. The dash-jump reaches nothing at a rise of 7 tiles.

**Spirit Launch reach** (DEFAULT_LAUNCH_TUNING, the §5.1.1 tick convention; measured with a port of the
controller validated against `PlayerController`):

| Move | Reach |
|---|---|
| Straight-up launch from rest (apex gain) | 416.2 u (8.7 tiles) |
| … then the restored air jump | 537.3 u (11.2 tiles) |
| Jump + double jump, grab at the 293.9 u peak, launch up, air jump | ≈ 831 u (17.3 tiles) |
| 45° launch, holding forward, measured over a void back to launch height | 495.2 u, airtime 51 ticks, peak 233.6 u (498.4 u on flat ground, counting the landing tick) |
| Launch off a mid-air seed at a 32° analog aim, then dash at R+39 and air jump at R+48 (cancelling it) | ≈ 1166 u |

**Design rules:**

- Single-jump ledges ≤ 3 tiles; jump + double-jump ledges ≤ 5 tiles.
- Gaps crossable without the double jump ≤ 6 tiles.
- Double-jump gaps 9–10 tiles. A gap that forces the dash must beat the late double jump: flat gaps
  ≥ 15 tiles, or 14 tiles with the far side 2 tiles higher (what Canopy Walk uses; `reach.test.ts`
  proves no jump + double-jump timing lands).
- Wall-jump shafts 3–5 tiles wide.
- `tests/sim/reach.test.ts` asserts each gate: the intended move succeeds and the next-weaker move
  fails.
- `tests/sim/playthrough.test.ts` replays scripted inputs through every area of `forest.ldtk`.
- **Launch-only landings (M2).** Width alone never gates: the dash-jump outreaches a single launch. A
  landing that needs Spirit Launch satisfies all of these:
  - **Height:** it is ≥ 7 tiles (336 u) above every standable tile and crawler floor it can be
    approached from without launching.
  - **No wall climbs:** the landing ledge is OneWay, or its face is Thorns. A single wall can be climbed,
    and entering a wall slide restores the air jump and dash, so no Solid face exposed to air may have
    its bottom less than 366 u above a standable approach surface within 28 tiles
    (293.9 + 58 body + 14 stomp).
  - **Proof** in `reach.test.ts`:
    - A conservative no-launch reachability closure must exclude the landing. It allows rises of ≤ 6
      tiles within 28 tiles, plus the top of every climbable face.
    - A bot search must also fail to land. It searches ground dash tick × jump tick (grounded or
      coyote, which may cancel the dash) × air dash tick × air jump tick (which may cancel the air
      dash).
    - A scripted launch does land. It uses only the 8 keyboard directions and neutral aim.
  - **Anchors in the proof:** every launch target reachable from the approach counts, including
    player-aimed seeds, which come to the player, and enemy bodies.
- **Stun gates (M2):** a player-aimed spitter stands in a passage ≤ 2 tiles tall. Its box plus the
  player's (118 u) doesn't fit under a 96 u ceiling, and the dash gives no invulnerability, so the only
  way through is to stun it with a flung seed or a launch.
- **Anchors (M2):** seeds that serve as anchors come from **fixed-aim** spitters with period ≤ 120
  ticks, so the rhythm is learnable. Fixed-aim spitters are never stunned, so their streams can't be
  shut off by accident.
- **Fairness (M2),** checked by `forest.test.ts`:
  - Fixed-aim streams never cross the standable surfaces of a gate's approach, so standing still before
    a gate is safe.
  - No checkpoint's respawn point is within `range` of a player-aimed spitter.
  - Simulated fixed-aim trajectories (seedLifetimeTicks) never touch a checkpoint's respawn stand box.
  - Player-aimed spitters only fire from on-screen (§5.3), and every shot is telegraphed by a 36-tick
    windup.
- **Shrine chokepoint (M2):** the AbilityShrine rect spans its corridor from floor to ceiling.
  `forest.test.ts` runs the no-launch reachability closure (the one the gate proofs use) from the spawn,
  with the shrine rect as a blocker. It must reach no Spitter and not the Goal. As a control, the same
  closure without the blocker reaches the floor just past the shrine. So the launch course can't be
  entered without the ability.
  - The closure models jumps, so open sky doesn't count as a path the way a plain flood fill would count
    it. No roof is needed.
  - A region is sealed by walls that reach the top edge (above the top is Solid, §2.1) or by
    thorn-lined faces that can't be climbed.
  - The Moonwell stays open to the sky.
- **Seed pool (M2):** Σ over spitters of ceil((seedLifetimeTicks + reflectedLifetimeTicks) / period) ≤
  `MAX_PROJECTILES` (`validate.ts`), so a shot is never skipped and anchor rhythms hold.
- **Grade zones** cover every tile, leaving no uncovered remainder (`forest.test.ts`), so the audio mood
  never falls back to its default.
- No dead masses: from any standable tile, with the camera framed as the sim frames it, solid rock
  more than 3 tiles from open air covers < 8 % of the view (`forest.test.ts`). Scenery-only rock is
  ≤ 5–6 tiles thick; carve bigger masses into ledges, alcoves and windows onto the forest.

Six areas (five in M1), left to right, each with a colour grade:

1. **Hollow Glade** (`glade`): the start. Gentle ground, first orbs, one light shaft, and checkpoint 1.
2. **Thorn Gully** (`gully`): a thorn pit crossed with ledges and the double jump; a checkpoint after it.
3. **Rootwell** (`rootwell`): a vertical shaft climbed by wall jumps, with orbs along the climb.
4. **Canopy Walk** (`canopy`): high gaps that need dash + double jump, the Gloomcrawler on a long
   platform, and light shafts.
5. **Thornveil** (`veil`, M2, between Canopy Walk and Moonwell): the AbilityShrine and a checkpoint at the
   entry, then a Spirit Launch course:
   - **Teach:** a fixed spitter lobs seeds straight up in a safe pit. Launching off one reaches a reward
     alcove ≥ 7 tiles up (optional).
   - **Rise gate:** a thorn chasm whose far landing is ≥ 7 tiles above the near ledge, fed by seeds lobbed
     from below (a diagonal launch).
   - **Vertical gate:** a shaft with no climbable faces, up to a OneWay ledge ≥ 7 tiles up, beside a seed
     stream (a straight-up launch).
   - **Stun gate:** a player-aimed spitter (short flightTicks, so shots stay under the ceiling) blocks a
     low passage. Stun it with its own seed, flung back by launching away from it, or by launching off
     it, then pass.
   - **Chain (optional):** orbs along a two-launch route (seed → seed, or seed → a crawler on a floating
     platform).
   - A checkpoint after the vertical gate.
6. **Moonwell** (`shrine`): a descent into a warm, lantern-lit clearing with the goal shrine.

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
  The core shader shades by depth below the surface (the SDF near surfaces, extended by a distance
  transform up to `shadeDepth + TERRAIN_DEEP_REACH` so thick masses keep varying) plus world-space
  noise. Interiors are earth, not a void: a moonlit rim zone ramps into a lifted indigo/teal-black that
  drifts slightly more indigo with depth, carrying structure that reads at gameplay zoom (strata bands
  and seams, roots, lumpy embedded stones with far-side contact shadows, pebbles, rootlets, faint
  glints). Interior p95 stays below `fogDeep` so terrain always separates from the background.
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
- **Post** (PIPE): bloom from glowRT through the owned dual-filter chain (§3), then the composite.
  The composite applies exposure, contrast, saturation, lift/gamma/gain and temperature from the
  **per-area grade**. The grade is blended by the camera's position in `GradeZone`s (`blend` u
  cross-fade). Then come the death fade (to `fogDeep`), vignette and dither.

**M2 visuals** (PIPE unless noted):

- **World clock** (FrameInfo doc is normative): s ← g + (s − g)·e^(−dt/τ) on the clamped render dt, with
  g = TIME_SCALE_FROZEN and τ = TIME_SCALE_EASE while `sim.frozen`, and g = 1, τ = TIME_SCALE_RELEASE
  otherwise. worldDt is the exact integral over the frame, so the clock is frame-rate independent.
  - **World clock users:** particles (per-particle flag: ambient and world bursts use it), decor and kit
    sway, fog, sky, shafts, entity idles.
  - **Frozen-aware tick animations:** animations that count sim ticks since an event (orb collect,
    checkpoint stones) record `worldTime` at the event instead, because ticks keep counting while frozen.
  - **Real clock (`time`/`dt`):** the hero rig and all its secondary motion, the launch ring, aim
    arrow, LaunchAim gather and Launch burst/streak, UI, post. A verlet or velocity estimate on
    `worldDt` explodes as the scale ramps back up: the scarf would lead the hero after a release. While
    `launchAim`, the scarf may float by scaling its gravity and rest pull by `timeScale`, never its step.
  - **Freeze grade:** freeze amount k = (1 − s)/(1 − TIME_SCALE_FROZEN), applied on the CPU to the
    blended GradeParams (saturation × (1 − 0.35k), temperature − 0.3k, vignette + 0.15k). No shader
    cost.
- **Thorn Spitter:** a rooted bulb plant about 1.3 tiles tall with thorny leaves. Its bulb swells and
  glows `thorns` rose over the windup, recoils on the shot, droops and dims while stunned, and re-forms
  with a small bloom. SDF parts are baked into the entity atlas: one merged draw plus a glow twin.
- **Seeds:** hostile = a rose ember with small thorns; reflected = a spirit-blue wisp. Each has a short
  ribbon trail (≤ 8 points). All seeds and trails share one draw, plus one glow-twin draw. That holds
  only if:
  - the trails are default-shader meshes of ≤ 100 vertices (a custom shader or state disables
    batching);
  - every seed uses one blend mode (premultiplied normal; emissive texels at alpha 0 add);
  - inactive slots are hidden with alpha 0, never `visible` (which rebuilds the render group).

  Trail behaviour:
  - Trails take one sample per tick in which the seed moved (a frozen seed keeps its trail).
  - Point 0 is the interpolated head, followed by the samples.
  - Trails reset when `spawnTick` changes (a new flight or a reflection).
  - A seed fades over its last 30 ticks of `age` / `lifetime`, so an expiry never pops.
  - Twins of thin things (trails) are at least 2 glow-buffer pixels wide.
- **Spirit Launch:**
  - A thin, pulsing spirit-glow ring marks `launch.candidate` (only when unlocked). It follows the
    candidate's *interpolated* position, looked up by kind and id, not candidateX/Y.
  - While aiming, the ring locks and tightens on the target, and an aim arrow (≈ 90 u) leaves the hero
    along the aim.
  - The freeze grade (above) comes in and out with the world clock.
  - On release: a radial light burst at the centre of the LaunchAim that preceded the Launch (not
    `LaunchView`, which a later grab in the same frame overwrites), a light streak on the hero, and a
    small shake.
  - The spitter's glow twin may draw with normal blend (a dark body with alpha) so it occludes moss glow
    behind it.
- **AbilityShrine:** a mossy stone pedestal holding a floating lantern-seed that dims once unlocked.
  Unlocking bursts with light, and the HUD shows a toast with the controls.
- **Bursts** (particles): SeedFired puff, SeedBurst shards (rose) or wisps (blue), LaunchAim light gather,
  Launch burst, EnemyHit, AbilityUnlocked bloom, SpitterWindup thorn glints.

**Painterly pass** (M2, ART-PAINT). The target is a hand-painted gouache/oil look: visible,
form-following brush strokes at 1:1, soft broken edges, no outlines, no speckle noise. Silhouettes, the
aerial-perspective value ramp and the terrain/background value separation stay as they are, because the
gameplay read comes first.

- **Strokes live in local stroke coordinates, never in a rotated global coordinate.** Rotating texel or
  world coordinates by a per-texel direction or a per-vertex tangent warps the noise domain: 7–19× the
  intended frequency near lobe centres, and shimmer on terrain corners. That is exactly the speckle to
  avoid.
- **Kit atlas (bake time, zero runtime cost):**
  - `put()` records a stroke coordinate (u, v) per texel in the owning shape's frame, next to
    `mat`/`shade`. Capsules and curves: along / across the segment. Ellipses and lobes: (r̄·φ, r) around
    the lobe centre, faded as r → 0. Leaves: along the blade. Ground, rocks and roots: stretched (x, y).
  - An elongated brush texture (stretch 4–6 : 1, 2–3 scales) is evaluated in (u, v). Stroke widths are
    given in layer units, converted with `unitsPerTexel`, and are at least 3 texels and 2 px at the
    minimum render scale.
  - **Visibility target:** body strokes change final luma by at least 3–4 8-bit codes on L3–L8 (about
    ±0.3 in R, or a stroke gain inside the kit shading); ±10–15 % of R is invisible (≤ 2 codes). The
    rim mask G breaks into stroke segments while keeping its mean over every 2×2 texel block, so the
    mip-averaged rim, and with it the value ramp, does not shift.
  - Alpha edges get a light dry-brush breakup along the stroke direction, within the existing
    edge-noise budget. Decor inherits all of this through the atlas.
- **Terrain:** vertices carry a stroke coordinate (s, depth): s is the arc length at the nearest contour
  point (from the mesh build), wrapped mod 1024 so the hash keeps its precision. Strokes follow it in
  the rim zone and blend into the existing warped-strata coordinates by 60 u of depth. Stroke frequency
  is clamped with `fwidth` to ≤ 0.25 cycles per pixel at `minRenderScale`. This costs one more
  value-noise lookup (≤ 10 per fragment) and a vertex stride of 5 → 7 floats.
- **Budget:** cold atlas bake ≤ +150 ms (a 3-lookup modulation over the ≈ 0.85 M covered texels measures
  60–80 ms), the same atlas size, no new textures. Previews compare before and after at gameplay scale
  and in 2× crops, and report the measured luma change per layer; the main session reviews on the GPU.

### 5.6 In-house rig (`src/render/hero/rig.ts`)

- `Skeleton`: bones with parent index, rest transform and length, evaluated into world matrices in
  place (preallocated `Float32Array`).
- `Clip`: keyframed bone channels (rotation, x, y, scaleX, scaleY) with cubic-Hermite/ease sampling.
  Clips: `idle, run, jump, fall, land, wallSlide, wallJump, doubleJump (flip), dash, dead`; M2 adds
  `launchAim` (braced crouch facing the target, arms drawing its light, scarf floating) and `launched`
  (a streamlined dive along the velocity, scarf streaming).
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
| Kit layers (layer budget; plates are gated by `minQuality` instead) | 6 | 8 | 10 |
| Particles density | 0.35 | 0.65 | 1.0 |
| Bloom | quarter res, 2 passes | half, 3 passes | half, 4 passes |
| Light shafts, sway | shafts on, sway off | on | on |
| Fog bands | 1 | 2 | 2 |

- **Auto:** reads `WEBGL_debug_renderer_info` (when exposed). Integrated GPUs (Intel UHD/Iris, AMD
  APUs, unknown) get **High features with pixel-ratio cap 1 and dynamic resolution on**. Discrete GPUs
  get High. Software renderers (SwiftShader, llvmpipe) get Low.
- **Dynamic resolution** (`src/settings/dynres.ts`, pure):
  - A **miss** is a frame where the loop reports `lateFrames > 0` (a missed render deadline) *and* the
    GPU time is unknown or above `dropGpuMs` (14). Frame-interval thresholds are wrong under an fps cap:
    at 144 Hz the cap's steady cadence alternates 13.9 and 20.8 ms. A CPU hitch with a fast GPU is not a
    miss either, since lower resolution cannot fix it.
  - Two or more misses in the last 30 frames step the scale down 0.05.
  - Three seconds with no misses (and GPU time under 13 ms, when known) step it up 0.05.
  - At most one change per second, clamped to [min, initial].
  - **GPU time:** one `TIME_ELAPSED_EXT` query wraps all of a frame's passes, using a ring of 4
    queries polled without blocking. Results are discarded on `GPU_DISJOINT_EXT`, and the value is −1
    when the extension is missing (Firefox, Safari, some drivers).
- **Persisted** in `localStorage` (guarded with try/catch): preset, pixel-ratio cap override, fps cap
  (60 or uncapped), dynamic resolution, the debug overlay and (M2) master/music/effects volumes.
  - The volume rows step by 0.1, clamp at 0 and 1 (no wrap), ignore confirm and show percentages.
  - The engine maps a slider value v to gain v², so each step sounds even.
  - `?mute` or `#mute` sets master to 0 for the session without persisting it.
- **Keys:** `Esc` or Start = menu, `F3` = debug overlay, `F4` = collision/hitbox debug draw,
  `R` = respawn at the checkpoint. **Spirit Launch** (M2): `C`, `J` or `E`; gamepad B, LB or LT. The
  controls hint gains it once unlocked.

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
  supports a compressed format and the CSP allows eval (the Emscripten transcoder calls `new Function`;
  `src/core/csp.ts` probes once). Otherwise WebP, then PNG. The libktx transcoder is self-hosted at
  `transcoders/ktx/`: the Vite plugin serves it in dev and emits it at build. Every texture registers
  its bytes with `TextureBudget` (shown in the debug overlay).
- **Publishing:** `levels/forest.ldtk` must be served as `application/json`. KTX2 also needs blob
  workers, WASM and eval. Under a no-eval CSP it is skipped up front. When workers or WASM are blocked,
  a load still pending after `KTX2_TIMEOUT_MS` counts as failed. Either way the loader falls back to
  WebP/PNG. `npm run artifact` builds a single-file page for Claude artifacts (see README): PixiJS from
  the CDN, the game and its data inlined through `src/assets/embedded.ts`, no KTX2 or plates.
- **Bake tool** (`tools/plates/bake-plates.ts`, Node + sharp + ktx2-encoder): renders a plate to PNG,
  then writes WebP + KTX2 (ETC1S, mipmapped) chunks and tight hull polygons alongside a manifest. M1
  ships one demo plate layer in `public/layers/forest.plates.manifest.json` (open with
  `?manifest=plates`). It replaces the `L3-misty-trunks` kit layer with a treeline painted by
  `tools/plates/paint.ts` from the same tree generator (`src/render/gen/trees.ts`), in L3's colour
  before fog, so the two read alike. `tests/world/plates.test.ts` fails when the committed bake is stale.
  This exercises the whole painted-plate path, and painted or AI-generated plates go through the same
  tool.

- **Painted layers (M2, ART-TOOLS):** artists paint plate layers and drop them in; the pipeline does the
  rest.
  - **Source:** `art/plates/<id>.png` (sRGB, 8-bit RGBA, straight alpha, ≤ 16384 px a side, read with
    sharp `limitInputPixels: false` and chunk `extract()` so nothing decodes the whole image at once)
    plus `art/plates/<id>.json`:
    - `parallax [fx, fy]`, which sets the draw position among the base layers (ties are rejected);
      `replaces` (an optional base layer id) swaps that layer out;
    - `origin [x, y]` (layer-space top-left, u) and `texelScale` (≥ 1.5, because WebP/PNG chunks have
      no mipmaps);
    - `minQuality`, `fog`, `fogColor`, `desaturate`, `tint`, and an optional `area` (an AreaGradeId,
      for docs and budget reports).
  - **Manifests:** `public/layers/forest.base.manifest.json` is hand-edited and never generated.
    `npm run art` (`tools/art/bake-art.ts`) combines the base with the sidecars into the generated
    `public/layers/forest.manifest.json`. `npm run plates` (the demo plate) also derives from the base.
  - **Bake:**
    - Validates every source and cuts it into 1024² chunks with a 1-texel duplicated border, so
      bilinear filtering has no seams.
    - Writes WebP + PNG + KTX2 plus split-hull rects: `PlateChunkDef.core` / `soft` from
      `computeSplitHullHalf`, so set pieces with holes or content only at the edges still get tight
      meshes and an opaque core.
    - Records a pixel hash per chunk (`hash`) and a source hash (PNG + sidecar + tool version) per
      layer.
    - `--check` recomputes hashes and the splice and never re-encodes (KTX2 takes about 4 s per chunk).
  - **Budgets** (the bake fails on these):
    - Sweep the camera over the clamped range at the widest aspect (`MAX_ASPECT`), `MIN_CAMERA_ZOOM`
      and maximum shake, at every chunk-edge breakpoint of every layer, for each quality level that
      draws the layer.
    - Visible plate chunks × 4·w·h bytes (RGBA8 fallback, no mipmaps), plus every registered atlas,
      must stay ≤ `textureBudgetMB[level]`; the same including the 480 u prefetch margin is a warning.
    - A layer may never show more than 4 chunks at once (2 draws per chunk: core + soft).
  - **Runtime:**
    - One shared streamer and LRU serves all plate layers. Its budget is `textureBudgetMB` minus every
      registered atlas (kit, particles, entity, hero), read when streaming rather than at init.
    - `layerBudget` limits procedural kit layers only; plates are gated by `minQuality`.
    - Every image load has a deadline, and a plate layer that fails re-enables the base layer it
      replaced.
  - **Paint-over templates:** `npm run art:export -- <area | x0,x1>` (`tools/art/export-templates.ts`)
    renders an area's procedural layers to layer-space PNGs in `art/templates/<area>/`, with guide
    overlays (the gameplay terrain silhouette, camera frames at 16:9, 4:3 and 21:9, the parallax factor).
  - **Hot reload (dev only):**
    - A Vite plugin (`tools/art/vite-plugin.ts`, `apply: 'serve'`, inert under `process.env.VITEST`,
      wired in `vite.config.ts` by main) watches `art/plates/**` through `configureServer` +
      `server.watcher`.
    - Writes are debounced until the file size is stable for 200 ms. Only chunks whose pixels changed
      are re-encoded, WebP only and off the dev-server thread.
    - The dev manifest rewrite drops `ktx2` from re-baked chunks, so a stale KTX2 can't win.
    - Plate files are served from the plugin's own middleware; Vite's public-file set lags new files.
    - Texture URLs carry `?v=<hash8>` (the validator checks the pathname). Budget keys carry a
      generation, and a layer unloads a URL only while it still owns it.
    - A pixel-only change sends `spiritwood:plate-updated` { id }. `src/assets/hotReload.ts` (behind
      `import.meta.hot`) re-fetches the manifest, and the parallax stack reloads that layer: it evicts
      the chunks, rebuilds the meshes and re-streams, updating its own copy of the manifest.
    - Any structural change (parallax, `replaces`, `minQuality`, a plate added or deleted) sends a
      full page reload.
  - **Example:** the Hollow Glade gets two painted set pieces through this pipeline: a distant moonlit
    landmark (f ≈ 0.2) and a midground frame (f ≈ 0.6). They are generated stand-ins
    (`tools/art/paint-example.ts`) that real paintings replace file for file. They stay in the default
    manifest only if they pass the art review on the GPU.
  - **Single-file artifact:** plate layers are omitted (a replaced base layer is restored), as with
    `#plates`. Base64 plates would grow the page past the size the public review is known to handle,
    and Pixi's image path uses blob workers that the artifact CSP blocks.

### 5.9 Audio (M2, `src/audio/**`) — synthesized

No audio files: every sound is synthesized with the Web Audio API. The spec below is shaped by browser
facts the review measured: autoplay policies, missing Firefox APIs, the compressor's makeup gain, and
ramp edge cases.

#### Engine and lifecycle

- **Class:** `AudioSystem implements AudioEngine` (`src/contracts/audio.ts`). Options:
  `{ createContext?, gestureTarget?, enabled?, seed? }`. Tests inject a fake context factory and
  gesture target. `?bench` constructs it with `enabled: false`.
- **Fails closed:**
  - Every public method catches. On the first unexpected error it logs once, closes the context and sets
    `stats.state = 'unavailable'`.
  - `game.ts` also wraps the audio calls, so `events.clear()` and the HUD always run.
- **Ports:** Web Audio is reached only through the narrow structural ports in `src/audio/ports.ts`,
  which the real context satisfies. The ports leave out:
  - `cancelAndHoldAtTime` and `automationRate`: Firefox lacks them;
  - AudioWorklet: its modules load under script-src, which the artifact CSP restricts;
  - ScriptProcessor.

  Every value written to an AudioParam is clamped to a finite number, since NaN or Infinity throws.
- **Context:** `new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 })` inside try/catch.
  - It is never created before a user activation.
  - No `webkitAudioContext`: WebGL2 already implies Safari 15.
  - `outputLatency` may be undefined; `stats.latency` is then −1.
  - On iOS, Web Audio obeys the silent switch.
- **Unlock:**
  - **Listeners:** the engine listens in the capture phase on `window` for `pointerdown`, `pointerup`,
    `mousedown`, `touchend`, `keydown`, `click` and `gamepadconnected`.
  - **On each trusted event,** synchronously:
    - create the context if needed;
    - call `resume()`, never awaited and never gated on an earlier call;
    - start a one-sample silent buffer (WebKit).
  - **Retry:** the listeners stay armed while `ctx.state !== 'running'`.
  - **`unlock()`:** does the same and is idempotent. `game.ts` calls it after polling the pad, because
    Chromium grants activation from gamepad presses.
  - **Until running,** `update()` schedules nothing and SFX events are dropped. That avoids a burst of
    queued notes and Chromium's console spam.
  - **HUD:** while `stats.state === 'locked'` after play starts, it shows "Press a key or click to
    enable sound".
- **States:**

  | `stats.state` | When |
  |---|---|
  | `unavailable` | no AudioContext, the factory threw, `enabled: false`, or a fail-closed error (final) |
  | `locked` | no context yet, or it has never reached `running` |
  | `running` | `ctx.state === 'running'` |
  | `suspended` | it ran before and is now `suspended` or `interrupted` |
  | `closed` | after `destroy()` (final) |

  `setActive(false)` (tab hidden) suspends the context and `setActive(true)` resumes it. Each
  `statechange` reconciles the wanted state with the actual one, and every promise is caught.

#### Graph and levels

- **Chain per bus** (`sfx`, `music`, `ambience`):
  1. volume Gain;
  2. duck Gain, plus the freeze low-pass on music and ambience;
  3. master Gain;
  4. compressor (threshold −12 dB, ratio 4, knee 6);
  5. trim Gain −4 dB, which cancels the compressor's automatic makeup gain;
  6. WaveShaper soft clip (linear to ±0.8, tanh knee up to ±1);
  7. destination.
- **Ownership:** one owner per AudioParam, since each `setTargetAtTime` overrides the last.
  - volume Gain: the volume setting, τ 0.05 s; slider v → gain v², and ambience follows `sfx`;
  - duck Gain: pause;
  - freeze filter: the aim.
- **Pause** (`AudioFrame.paused`):
  - music ducks 12 dB and ambience holds low;
  - every sustained SFX releases within 50 ms and comes back on resume if its condition still holds;
  - no new SFX start.
- **Freeze** (`sim.frozen`):
  - the music and ambience low-pass keeps `frequency` at 20 kHz and sweeps `detune` toward −5370 cents
    (≈ 900 Hz) with `setTargetAtTime`, τ = `TIME_SCALE_EASE`, in step with the visual freeze;
  - a soft heartbeat speeds up with aimTicks / aimMaxTicks;
  - the aim sustain rings.
- **Headroom:** each patch alone peaks ≤ −12 dBFS on its bus, and the worst-case stress mix peaks
  ≤ −1 dBFS after the chain. `render-patches` checks both.

#### Voices

- **Chain:** sources → envelope Gain → kill Gain → panner → bus. Non-spatial voices replace the panner
  with a fixed 0.7071 gain, so their level matches the panned voices.
- **Envelopes** (these rules make clicks impossible):
  - Attack: `setValueAtTime(0, t0)`, then a linear ramp.
  - Decay: exponential ramps down to no less than 1e-4 (a ramp to 0 throws), or `setTargetAtTime`.
  - Release: always ends with `linearRampToValueAtTime(0, tEnd)`, and sources stop at tEnd + 5 ms.
  - Steal: on the kill Gain, `setValueAtTime(1, now)`, then a linear ramp to 0 by now + 10 ms, and a
    stop at now + 15 ms.
- **Budgets:** a voice is one patch instance.
  - Budgets per category: SFX 16, music 12, ambience 6. Stealing happens within a category: lowest
    priority first, then oldest.
  - The wind and cricket beds are long-lived nodes outside the budgets. Crickets are gain-gated FM on
    persistent oscillators, not new nodes per chirp.
  - Music uses bus-level pan and filter and one shared reverb send.
  - `stats.voices` is the sum of the three categories.
- **Leases:** sustained sounds (the wall scrape, aim sustain, heartbeat, windup rattle and ambience beds)
  are leases.
  - Each `update()` re-issues `stop(now + 0.35)` (the last `stop()` wins) and moves the kill fade to
    start at now + 0.2. So a sound whose `update()` stops (hidden tab, throttled iframe) fades out on its
    own.
  - Each follows state read in `update()`, never events:
    - scrape ⇔ `player.mode === 'wallSlide'`;
    - aim sounds ⇔ `sim.frozen`;
    - rattle pitch and gain ⇔ `modeTicks / modeDuration` while a spitter is in `windup`.
  - Reset, Teleported and Respawned release every SFX voice and clear the orb combo.
- **Retire and write:** voices retire by their scheduled end time in `update()` (no `onended`
  closures) and are then disconnected. Continuous parameters are written only when their target changes.

#### SFX

`EVENT_PATCH satisfies Record<SimEventType, PatchId | null>`, so every event type is mapped:

- **Movement:**
  - Jump, AirJump, WallJump and Dash each have a patch.
  - DashEnd b = 2: a wall thud. Other DashEnd reasons are silent.
  - WallSlideStart: a grip tick. WallSlideEnd: silent.
  - DropThrough: a soft rustle.
  - Land: loudness ∝ impact speed; silent below 150 u/s; at least 80 ms apart.
- **Pickups and progress:**
  - OrbCollected: bell notes climbing at most 7 scale steps within a 1.5 s combo. Same-frame pickups are
    staggered 50 ms apart.
  - CheckpointActivated: a warm swell.
  - GoalReached: a melodic cadence.
  - AbilityUnlocked: a grand bloom.
- **Life and death:**
  - Died: a reverse swell plus a low thud.
  - Respawned: a shimmer.
  - Reset and Teleported: control only (release voices).
- **Enemies:**
  - EnemyStomped and EnemyReformed each have a patch.
  - SpitterWindup: starts the rattle lease; the 2 nearest play.
  - SeedFired: a wet pop, cap 3.
  - SeedBurst: a crackle, cap 4. With a = Enemy it is a chime only; with a = Player it is silent (Died
    covers it).
  - EnemyHit: cause Seed plays a hit; cause Launch is silent (Launch covers it).
- **Spirit Launch:**
  - LaunchAim: a time-freeze whoosh down.
  - Launch: a whoosh plus a bright ping.
  - LaunchFizzle: a soft tick.
- **Pitch:** melodic SFX (orb combo, checkpoint, goal, ability) take their pitches from the current
  music harmony.

#### Space

`onSimEvent(e, frame)` receives the frame already filled for this render, so snaps (Respawned, Reset,
Teleported) use the new camera. With zoom = `sim.camera.zoom`:

- **Distance:**
  - hx = viewW / (2·zoom), hy = viewH / (2·zoom);
  - ex = max(0, |x − camX| − hx) / hx, and ey likewise for y;
  - d = √(ex² + ey²).
- **Gain:** × (1 − smoothstep(0, 1, d)).
- **Cull:** when d ≥ 1, before a voice is allocated.
- **Pan:** clamp((x − camX) / hx, −1, 1) · 0.6.
- **Non-spatial events** (pan 0, never culled): player-origin events, i.e. movement, launch, orbs,
  checkpoint, death and respawn, goal, ability, reset and teleport.

#### Music

Generative, following `areaWeights(level.gradeZones, camX, camY)` (`src/core/zones.ts`). The uncovered
remainder goes to glade. Each area has a mode, a chord cycle, a density and timbres:

| Area | Mood |
|---|---|
| glade | warm pentatonic pads, a sparse bell melody |
| gully | minor, a low pulse, sparser |
| rootwell | dark drone, resonant drips |
| canopy | airy high pads, more melody |
| veil | whole-tone shimmer, tense harmonics |
| shrine | warm major-7 swells toward the goal |

- **Harmony:**
  - All moods share one transport: tempo, bar grid and tonic.
  - Layer gains follow the area weights, smoothed with τ = 1.5 s.
  - Mode and chord follow the dominant area. They change only on a bar line, and only when the new
    area's weight beats the current one by 0.2.
  - Every sounding layer takes its notes from the current harmony, so two harmonic engines never clash
    at a boundary.
- **Scheduler:** a lookahead scheduler inside `update()` (no timers).
  - It books notes in (currentTime + lead, currentTime + 0.25], with lead = max(0.03, 2·baseLatency).
  - A lane that has fallen behind skips to its next step boundary: missed notes are dropped, never
    played late or in a burst.
  - Nothing is booked unless the context is running.
  - Timing uses only `ctx.currentTime`; `frame.dt` only smooths.
  - The engine owns an `Rng` seeded from `level.seed` and draws once per musical step, so the note
    sequence doesn't depend on frame rate.

#### Ambience

- A wind bed: filtered noise with a slow LFO.
- Crickets, with a density per area.
- A rare owl or wood creak.
- Water drips in the Rootwell.

#### Performance

- **Main thread:** `update()` averages ≤ 0.3 ms per frame, measured in `stats.updateMs`. It allocates
  nothing when nothing starts; an idle `update()` creates zero nodes.
- **Buffers:** noise and impulse buffers total ≤ 1 MB at a fixed 48 kHz, with the reverb impulse ≤ 1.5
  s.
  - They are built in slices of ≤ 2 ms per `update()`.
  - Patches whose buffer isn't ready yet are skipped.
  - The convolver's internal copies count toward the budget.

#### Tests

- **Fake context:** a fake context behind the ports records the node graph and parameter automation.
  Tests assert:
  - the event map covers every type;
  - the envelope rules;
  - budgets, caps and steal fades;
  - one owner per param;
  - leases release on pause and when `update()` stops;
  - area gains follow `areaWeights`;
  - harmony changes only on bar lines, with hysteresis;
  - no burst after a fake 2 s stall;
  - the lifecycle table (the factory returning null or throwing, `unlock()` twice, `setActive`,
    `destroy`);
  - fail-closed behaviour;
  - an idle `update()` creating zero nodes.
- **Offline render:** `tests/audio/render.test.ts` renders patches with `node-web-audio-api`'s
  `OfflineAudioContext` and checks peak, RMS, clicks and silence at the end (tolerances, not hashes).
  - The module is loaded with a dynamic import, and the test uses `describe.skipIf` when it is
    unavailable: there are no musl binaries.
  - The realtime `AudioContext` is never constructed in tests or tools.
  - Patches are pure functions of `(ctx, out, t, params)` with no DOM access.
- **WAV export:** `tools/audio/render-patches.ts` writes every patch and a stress mix to WAV for
  listening, and checks the headroom rules.

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
| Texture memory per area | High ≤ 96 MB, Medium ≤ 64 MB, Low ≤ 48 MB. This covers atlases and streamed plates, **excluding** render targets (≈ 40 MB at 1080p: scene RGBA8 8.3 + D24S8 8.3, glow chain ≈ 4–6, canvas backbuffer 8.3; the pipeline creates the WebGL2 context itself with `depth: false, stencil: false` to avoid another 8.3) |
| Allocation | **Zero allocations per frame in our hot paths**: sim step, view `update`, particles, pipeline render. Preallocate, pool, and use index loops; no closures, spreads, `for…of`, `map/filter` or string building per frame. The debug overlay formats text at ≤ 4 Hz. Pixi's own small per-`renderer.render()` allocations are accepted, so keep `renderer.render()` calls ≤ ~10 per frame. V8 boxes a changed number written through a Pixi setter (a few dozen bytes each). That is accepted, but only for values that really change: views compare against cached values and skip unchanged writes, and never touch parked sprites, so an idle view allocates nothing. Reusing one render-options object freezes the root transform (Pixi writes `options.transform`), so roots stay at identity and scale lives on a child container. `clearColor` is a preallocated `number[4]`. |
| Batching | Kit layers: 1 draw per chunk per pass, meshes built with `BufferUsage.STATIC` and Uint16 indices (≤ 65535 vertices per chunk mesh). Particles: 1 draw per `ParticleContainer`, from fixed-capacity pools filled before the first render; dead particles are hidden with scale 0 and never added or removed per frame. Hero: 1 draw (one atlas) plus halo. Custom-shader entities are merged per kind. |
| Draw calls (estimate at High) | kit ≈ 10 layers × ≤ 2 chunks × 2 = ≤ 40 (typically ≈ 28); sky 1; fog 2; foreground ≈ 4; terrain ≈ 3 per visible chunk ≈ 12; decor ≈ 6; shafts ≤ 3; entities ≈ 5; hero 3; particles ≈ 6; glow twins ≈ 10; bloom 2·passes; composite 1. Total ≈ 90–110 (measured: 74–87 across eight gameplay views) |
| Transparent full-screen layers | Must be cheap shaders: at most one texture fetch or a small analytic noise, and no dependent loops. |
| Frame pacing (acceptance) | `lateFramePct` < 1% over the bench. Frame-time percentiles are reported, but they include fps-cap cadence jitter. |
| M2 draw calls | Spitters 1 + glow 1; seeds with trails 1 + glow 1; launch ring and aim arrow ≤ 2; the shrine joins the entity batch: about +4–6 at High. Painted plates: 2 per visible chunk, ≤ 4 chunks per layer (bake-enforced); the two Glade set pieces add ≈ 8–16 where they are visible. |
| M2 fill | Seeds, trails, rings and the arrow ≤ 0.05 screens; the freeze grade adds ALU only in the composite. Terrain core ≤ 10 value-noise lookups per fragment. |
| M2 CPU | Launch candidate search + seeds ≤ 0.1 ms per step (≤ `MAX_PROJECTILES` seeds, LOS walk only for in-range targets). Audio `update()` ≤ 0.3 ms per frame average (`stats.updateMs`). |
| M2 audio thread | ≤ 34 budgeted voices (SFX 16, music 12, ambience 6) plus the beds, one compressor and one ≤ 1.5 s convolver: ≈ 20–30 % of one core by the offline measurement, which is indicative only. Music pans and filters per bus, not per voice. |
| M2 memory | Painted plates count toward `textureBudgetMB` through one shared streamer (the bake enforces the worst case, RGBA8 4·w·h per chunk); audio buffers ≤ 1 MB at 48 kHz, including the convolver's copies; no new atlases. |

**Verification.** The debug overlay (F3) shows fps (average and 1% low), late-frame %, frame, sim and render CPU ms,
GPU ms (timer query), draw calls, estimated fill (sum of on-screen mesh bounds ÷ screen area), render
scale and RT size, particles and texture MB. `?bench` runs a 30 s scripted camera flythrough through
all five areas at the chosen preset and prints average fps, 1% low and frame-time p50/p95/p99 and the late-frame %. It is the
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
- M2 adds headless tests for:
  - Spirit Launch (the §5.1.1 contract), the Thorn Spitter cycle and aiming, seed physics and collisions,
    freeze and grace, ability unlocks;
  - the Thornveil gates in `reach.test.ts` and the extended playthrough;
  - the loader and validator for the new entities;
  - painterly bake determinism and budgets;
  - painted-layer bake and staleness, budget reports, hot-reload message handling;
  - audio on a fake context (graph, envelopes, budgets, leases, scheduling, lifecycle), plus guarded
    offline renders with `node-web-audio-api`.
- Visual checks (main session only): screenshots of each area, reviewed and iterated.
- Machine safety: at most 3 concurrent agents. Agents never launch browsers or dev servers.
- Browser-free visual checks: CPU-generated textures and compositions are written to PNG with
  `tools/preview/png.ts` and inspected as images (`tools/preview/{world,pipe}/`).
