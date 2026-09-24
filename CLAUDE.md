# Spiritwood: agent guide

An Ori-*inspired* (not derived) 2D browser platformer: TypeScript 7 + Vite 8 + PixiJS v8 (WebGL2) + Vitest 5.
**Read `ARCHITECTURE.md` first.** It is the spec: conventions, module ownership and the performance budget.

## Commands

```bash
npm run typecheck                             # tsc --noEmit (strict); must stay green
npm test                                      # vitest run --maxWorkers=2
npx vitest run tests/sim --maxWorkers=2       # one area
npm run build                                 # vite build → dist/
node tools/level/build-level.ts               # regenerate public/levels/forest.ldtk from the ASCII map
```

## Machine safety (hard rules)

- **Sub-agents never launch a browser** (Playwright, Chromium, Puppeteer) or a server (`npm run dev`,
  `vite`, `vite preview`, `http-server`, …). Only the main session does visual checks.
- Vitest always runs with `--maxWorkers=2` and never in watch mode.
- No more than 3 agents run at once.

## Ownership

- Edit only files your role owns (ARCHITECTURE.md §4).
- `src/contracts/**`, `src/config.ts`, the shared helpers (`src/core/{math,rng,color}.ts`,
  `src/render/gen/{noise,sdf}.ts`, `src/render/util/**`, `src/render/shaders/common.ts`) and the configs
  are frozen. If you need a contract change, stop and report it. Do not work around it.
- Only the main session commits.

## Code conventions

- `erasableSyntaxOnly`: no `enum`, `namespace` or constructor parameter properties. Use
  `const X = {...} as const` + unions.
- Import local modules with the `.ts` extension. Use `import type` for type-only imports.
- Strict TypeScript, no `any`. Minimal comments: only for non-obvious logic.
- `sim/`, `level/`, `input/` and `core/` never import `pixi.js` or `render/**`. Render code reads
  the sim only through `SimView` and the other contract types.
- **Hot paths** (sim `step`, view `update`, particles, pipeline `render`) allocate nothing per frame.
  Use preallocated objects and typed arrays, index loops, and no closures, spreads, `for…of`,
  `map/filter/forEach` or string building.
- **Determinism:** the sim never uses `Math.random`, `Date`, `performance.now` or the DOM. Use `Rng`,
  and express durations in ticks.
- Shaders: GLSL ES 3.0 (`#version 300 es`), output premultiplied alpha. Use the chunks in
  `src/render/shaders/common.ts` (Pixi transform uniforms, dither, noise).

## Tests

- Put tests in `tests/<area>/*.test.ts`. They must be deterministic and headless: no WebGL, no real
  DOM. Fake `EventTarget`s and gamepads are fine, and so are Pixi scene-graph objects without a
  renderer.
- Read tuning values from the tuning objects instead of hard-coding magic numbers.
