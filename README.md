# Spiritwood

*Working title.* A luminous, atmospheric 2D platformer for the browser, inspired by the feel of
Ori and the Will of the Wisps. It is fully original: no Ori assets, characters, names or layouts.

- **Stack:** TypeScript 7, Vite 8, PixiJS v8 (WebGL2) with custom GLSL, Vitest.
- **Design and conventions:** [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Run

```bash
npm install
npm run dev        # local dev server
npm run build      # static site in dist/ (relative paths, deployable anywhere)
npm run typecheck
npm test
```

## Controls

| Action | Keyboard | Gamepad |
|---|---|---|
| Move | Arrows / WASD | Left stick / D-pad |
| Jump (double jump in the air, wall jump on a wall) | Space / Z / K | A |
| Dash | Shift / X / L | X / RB / RT |
| Spirit Launch (once the shrine in the Thornveil is found): hold near a seed or a foe to aim, release to fly | C / J / E | B / LB / LT |
| Respawn at checkpoint | R | Y |
| Menu / settings | Esc / P | Start |
| Debug overlay / collision draw | F3 or \` / F4 | Back |

## URL flags

| Flag | Effect |
|---|---|
| `?quality=auto\|high\|medium\|low` | Quality preset |
| `?dpr=1.5` | Pixel-ratio cap |
| `?fps=0\|60` | Uncapped or 60 fps cap |
| `?dynres=0\|1` | Dynamic resolution off or on |
| `?debug=1` | Show the debug overlay |
| `?bench` | 30 s scripted flythrough; prints the fps summary (`?bench=60` for 60 s) |
| `?manifest=plates` | Load the demo painted-plate manifest (streams KTX2 or WebP chunks) |
| `?mute` | Start with the master volume at 0 for this session (not saved) |

Hosts that pass only a URL hash to the page (e.g. Claude artifacts) accept `#token` equivalents,
joined with `-`: `#bench`, `#plates`, `#debug`, `#high`/`#medium`/`#low`, `#uncapped`, `#mute`. For example,
`#bench-low` runs the benchmark on the Low preset.

## Deploying

`npm run build` writes a static site to `dist/` with relative paths. Serve `levels/*.ldtk` as
`application/json`. On hosts with a strict Content-Security-Policy (no `unsafe-eval`), the game detects
the restriction, loads PixiJS's eval-free fallback and skips KTX2 (its transcoder needs eval), so
painted plates load as WebP.

To publish as a Claude artifact, run `npm run artifact -- <outDir>` and publish `<outDir>/index.html`
on its own. Public artifact links need the host to review the page, and a multi-file build (19 JS
modules) couldn't be reviewed, so this build is one self-contained page (≈375 KB):
- PixiJS loads from jsDelivr, pinned with SRI; if it's blocked, the page shows the boot error;
- the game is inlined as one script, with no string compilation (the eval probe is replaced by its
  known answer);
- the level and layer manifest are inlined as compact JSON.

It leaves out KTX2, which needs eval, and the painted-plate demo, which streams image files, so
`#plates` falls back to the procedural forest there.
