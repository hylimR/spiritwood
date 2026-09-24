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
