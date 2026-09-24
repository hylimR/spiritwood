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
| Filters | pixi-filters is installed, but M1 uses none on its hot paths. Pixi `Filter`s render into pooled targets without depth, which breaks the depth-ordered scene. KawaseBlurFilter cannot downsample and pads its input, so bloom is an owned dual-filter chain. pixi-filters stays available for occasional full-screen composite effects (M2). |
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
        ├─ input.beginFrame()               sample keyboard + gamepads, latch edges
        ├─ repeat n∈[0..5] times:
        │     input.nextTick(frame) ─▶ world.step(frame)       (60 Hz, deterministic)
        └─ render(alpha)
              ├─ pipeline.render(world, alpha, now, dt, lateFrames)
              │     ├─ render clock += min(dt, MAX_RENDER_DT); fill FrameInfo (interpolated camera + shake)
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
              ├─ audio.onSimEvent(e) for each event; world.events.clear()
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
| **main** (frozen contracts) | `ARCHITECTURE.md`, `README.md`, `CLAUDE.md`, `package.json`, `tsconfig*.json`, `vite.config.ts` (incl. the KTX2 transcoder plugin), `index.html`, `src/config.ts`, `src/contracts/**`, `src/core/{math,rng,color,tiles,todo}.ts`, `src/level/ascii.ts` (`levelFromAscii`), `src/render/gen/{noise,sdf}.ts`, `src/render/util/**`, `src/render/shaders/**`, `tools/preview/png.ts`, `tests/shared/**` (incl. `fixtures.ts`: `levelFromAscii`, `createFakeSimView`) | Types, constants, pure shared helpers, test fixtures |
| **main** (integration) | `src/main.ts`, `src/game/**`, `src/audio/**` | Boot, orchestrator, glue |
| **SIM** agent | `src/core/{loop,events}.ts`, `src/input/**`, `src/level/**`, `src/sim/**`, `tools/level/**`, `public/levels/**`, `tests/{core,input,level,sim}/**` | Loop, input, LDtk loading, collision, player controller, camera, world rules, enemy, level content |
| **WORLD** agent | `src/render/gen/**` (except noise/sdf), `src/render/layers/**`, `src/render/terrain/**`, `src/render/fx/**`, `src/render/world.ts`, `src/assets/**`, `public/layers/**`, `tools/plates/**`, `tools/preview/world/**`, `tests/world/**` | Procedural kit and atlases, hull trimming, parallax stack, sky, fog, terrain meshing, decor, thorns, particles, light shafts, layer manifest, chunk streaming, KTX2/WebP |
| **PIPE** agent | `src/render/pipeline.ts`, `src/render/pipeViews.ts`, `src/render/post/**`, `src/render/hero/**`, `src/render/entities/**`, `src/settings/**`, `src/debug/**`, `src/ui/**`, `src/content/**`, `tools/preview/pipe/**`, `tests/pipe/**` | Renderer, RTs and passes, bloom, composite and grading, hero rig and view, orb/checkpoint/enemy/goal views, quality presets, dynamic resolution, debug overlay, bench mode, HUD and menu |

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
  lookAheadSmoothTime.
- **Look-down:** only when vy ≥ lookDownFallSpeed AND the feet are lookDownMinDrop below the last
  grounded y.
- **Smoothing and bounds:** `smoothDamp` per axis. Clamp the *target* (not the output) to the level.
  Centre on the level in an axis where it is smaller than the view.
- **snapTo:** value = target, velocity = 0, prev = cur, snapTick = tick. `setOverride` follows an
  explicit point (bench).

### 5.3 World rules (`src/sim/world.ts`) — normative

**Step order:**

1. prev ← cur for everything.
2. Player.
3. Enemies.
4. If alive, in order: thorns (the hazard AABB inset by `HAZARD_INSET`), then enemies, then the kill
   plane (feet y > pxHeight + KILL_MARGIN).
5. Orbs.
6. Checkpoints.
7. Goal.
8. Death and respawn timers.
9. Camera.

**Enemies:**

- **Stomp** iff the boxes overlap, player vy > 0, and player.prevY ≤ enemy.prevY − enemy.height +
  stompTolerance. The player bounces with vy = −stompBounceVelocity (cuttable: about 143 u held, 50 u
  released).
- Any other overlap with a patrolling enemy kills (DeathCause.Enemy).
- A stunned enemy is harmless and non-solid. It re-forms after stunTicks at its current position,
  deferred while it overlaps the player.

**Death timeline** (death tick D):

- `kill` sets deadTicks = 0 and emits Died (x, y = body centre).
- fade(D + k) = min(1, k/fadeOutTicks). The hero is visible for `deathHideTicks`, then hidden.
- At D + dyingTicks, respawn at the active checkpoint's bottom-centre (x + w/2, y + h), else at
  playerStart. Reset enemies to spawn in patrol mode, return uncollected orbs to their spawns
  un-magnetised, snap the camera, set warpTick, and emit Respawned.
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

The level is one LDtk level, "Forest_Night", `200 × 50` tiles (9600 × 2400 u, about 5 screens wide and
2.2 tall).

- **IntGrid layer `Collision`:** 1 Solid, 2 OneWay, 3 Thorns.
- **Entities:** `PlayerStart`, `Orb`, `Checkpoint`, `Enemy` (its width is the patrol span), `Goal`,
  `LightShaft` (resizable; fields `angleDeg`, `spread`, `intensity`), `GradeZone` (resizable; fields
  `grade: AreaGrade`, `blend`), `Lantern`, `Flora`.
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
| Dash | 196.7 u |

Coyote time (≈ 51 u) and the collider width widen the crossable gaps. The air jump sets vy =
−airJumpVelocity whenever it fires, so a *late* double jump restarts the arc.

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
- No dead masses: from any standable tile, with the camera framed as the sim frames it, solid rock
  more than 3 tiles from open air covers < 8 % of the view (`forest.test.ts`). Scenery-only rock is
  ≤ 5–6 tiles thick; carve bigger masses into ledges, alcoves and windows onto the forest.

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
  supports a compressed format and the CSP allows eval (the Emscripten transcoder calls `new Function`;
  `src/core/csp.ts` probes once). Otherwise WebP, then PNG. The libktx transcoder is self-hosted at
  `transcoders/ktx/`: the Vite plugin serves it in dev and emits it at build. Every texture registers
  its bytes with `TextureBudget` (shown in the debug overlay).
- **Publishing:** `levels/forest.ldtk` must be served as `application/json`. KTX2 also needs blob
  workers, WASM and eval. Under a no-eval CSP it is skipped up front. When workers or WASM are blocked,
  a load still pending after `KTX2_TIMEOUT_MS` counts as failed. Either way the loader falls back to
  WebP/PNG.
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
| Texture memory per area | High ≤ 96 MB, Medium ≤ 64 MB, Low ≤ 48 MB. This covers atlases and streamed plates, **excluding** render targets (≈ 40 MB at 1080p: scene RGBA8 8.3 + D24S8 8.3, glow chain ≈ 4–6, canvas backbuffer 8.3; the pipeline creates the WebGL2 context itself with `depth: false, stencil: false` to avoid another 8.3) |
| Allocation | **Zero allocations per frame in our hot paths**: sim step, view `update`, particles, pipeline render. Preallocate, pool, and use index loops; no closures, spreads, `for…of`, `map/filter` or string building per frame. The debug overlay formats text at ≤ 4 Hz. Pixi's own small per-`renderer.render()` allocations are accepted, so keep `renderer.render()` calls ≤ ~10 per frame. Reusing one render-options object freezes the root transform (Pixi writes `options.transform`), so roots stay at identity and scale lives on a child container. `clearColor` is a preallocated `number[4]`. |
| Batching | Kit layers: 1 draw per chunk per pass, meshes built with `BufferUsage.STATIC` and Uint16 indices (≤ 65535 vertices per chunk mesh). Particles: 1 draw per `ParticleContainer`, from fixed-capacity pools filled before the first render; dead particles are hidden with scale 0 and never added or removed per frame. Hero: 1 draw (one atlas) plus halo. Custom-shader entities are merged per kind. |
| Draw calls (estimate at High) | kit ≈ 10 layers × ≤ 2 chunks × 2 = ≤ 40 (typically ≈ 28); sky 1; fog 2; foreground ≈ 4; terrain ≈ 3 per visible chunk ≈ 12; decor ≈ 6; shafts ≤ 3; entities ≈ 5; hero 3; particles ≈ 6; glow twins ≈ 10; bloom 2·passes; composite 1. Total ≈ 90–110 (measured: 74–87 across eight gameplay views) |
| Transparent full-screen layers | Must be cheap shaders: at most one texture fetch or a small analytic noise, and no dependent loops. |
| Frame pacing (acceptance) | `lateFramePct` < 1% over the bench. Frame-time percentiles are reported, but they include fps-cap cadence jitter. |

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
- Visual checks (main session only): screenshots of each area, reviewed and iterated.
- Machine safety: at most 3 concurrent agents. Agents never launch browsers or dev servers.
- Browser-free visual checks: CPU-generated textures and compositions are written to PNG with
  `tools/preview/png.ts` and inspected as images (`tools/preview/{world,pipe}/`).
