---
name: painted-layers
description: The artist workflow for painted parallax layers ("plates") in Spiritwood, end to end - export paint-over templates of an area's procedural layers (npm run art:export), paint a PNG at a depth, drop it into art/plates/ with a JSON sidecar (parallax, replaces, origin, texelScale, minQuality, fog, fogColor, desaturate, tint, area), bake it with npm run art (1024² chunks with a 4-texel border, WebP + PNG + KTX2, split-hull core/soft rects, hashes, the generated manifest spliced from the hand-edited base), hot-reload it while painting (npm run dev), keep it inside the swept texture budget, and ship it (npm run art -- --check). Also covers how the runtime streams plates (one shared LRU, load deadlines, fallback to the replaced layer, 2 draws per chunk). Use when adding, repainting, moving or removing a painted plate, when a plate bake or check fails, when a plate is over budget or looks wrong in depth, or when working on tools/art/**, src/assets/** or the plate runtime.
---

# Painted layers: from a paint-over template to a streamed plate

A plate is a painting that draws as one layer of the parallax stack. The kit program shades it like the
procedural layers around it (tint, fog, desaturation), so the aerial perspective stays one ramp. It is cut
into 1024² chunk textures that stream in and out, and its opaque interior joins the depth pre-pass, so a big
painting costs about what the procedural layer it stands in for costs. The Hollow Glade has two:
`glade-landmark`, a far crag with a moonlit waterfall at f 0.2, and `glade-frame`, an ancient tree whose bough
arches over the glade at f 0.6. ARCHITECTURE.md §5.8 ("Painted layers") is the spec.

## When to use

- You are adding a set piece, a landmark, a hand-painted backdrop or a replacement for a procedural layer.
- You are repainting, moving or re-tinting a plate, or deleting one.
- `npm run art` or `npm run art -- --check` fails, or the budget report says a plate is over.
- A plate looks too near, too far, too bright or too flat, or it pops in, or it is missing in the game.
- Not for procedural silhouettes (sdf-silhouettes) or atlas and shader work (channel-packed-atlas).

## The loop

```bash
npm run art:export -- glade --f 0.2      # 1. templates for the area (+ an empty slot at f 0.2) → art/templates/glade/
#                                           2. paint on a template, keep its canvas size
cp crag.png art/plates/crag.png          # 3. drop in the PNG and the stub sidecar
cp art/templates/glade/slot-f0.2.json art/plates/crag.json
npm run dev                              # 4. while painting: every save re-bakes and hot-reloads the layer
npm run art                              # 5. bake: chunks, encodings, manifest, budget report
npm run art -- --check                   # 6. before committing (CI): is everything baked and up to date?
```

## 1. Templates (`npm run art:export`)

`npm run art:export -- <area | x0,x1> [--f <parallax> …] [--scale <u per px>] [--layers id,id] [--out dir]`

- `<area>` is a grade zone of the level (`glade`, `gully`, `rootwell`, `canopy`, `veil`, `shrine`: the union of
  its zones) or a world x range. The level is read from `public/levels/forest.ldtk`, never hard-coded.
- For every kit layer of the base manifest it writes, into `art/templates/<area>/` (git-ignored):
  - `NN-<id>.png`: the layer as the game draws it, over the guides. Paint on this canvas;
  - `NN-<id>.layer.png` and `NN-<id>.guides.png`: the two halves, for your own layer stack;
  - `NN-<id>.json`: a sidecar stub that registers a painting made on this canvas.
- `--f 0.2` adds `slot-f0.2.png`: an empty canvas at a new depth, with the procedural layers behind it drawn in.
- Guides: the gameplay terrain as seen from that depth (blue), the camera frames at 16:9 (white), 4:3 (amber) and
  21:9 (cyan) for the area's reference camera, the camera sweep across the area (grey, dashed), the moon, a
  hero-sized marker where the hero stands, and the parallax factor.
- 1 template pixel is `--scale` world units (default 1.5, the smallest allowed `texelScale`). The stub's
  `origin` and `texelScale` match the canvas, so a painting keeps its registration if you keep the canvas
  size. You can crop, but then move `origin` by the cropped amount × texelScale.
- A layer template's stub moves the plate to the nearest free depth (a plate can't tie with the layer it was
  drawn from, or with a plate already in `art/plates/`) and adjusts `origin` so the painting still lines up
  at the reference camera. Slot stubs do the same when their depth is taken. The `_look` note lists the
  layer's fog, fog colour and desaturation.

## 2. Painting

- **Format:** PNG, sRGB (no profile or an sRGB one), 8 bits per channel, RGBA with **straight** (unpremultiplied)
  alpha, at most 16384 px a side. Transparent where the layers behind should show. The colour under alpha 0
  doesn't matter: the bake dilates edge colours into it.
- **Paint the value of the depth.** Distance is a value ramp: far layers are pale indigo, flat and soft; near
  layers are near-black with bright moonlit rims. The stub adds no fog, so paint what the template shows. To
  push a painting back, raise `fog` and `desaturate` in the sidecar, and don't bake fog into the pixels. Keep
  its shaded value between the layers in front and behind (`tools/art/paint-example.ts` prints this check
  for the examples).
- **Opaque interiors are cheap.** Regions with alpha ≥ 254 become the opaque core, inset by a few texels. The core draws in the depth pre-pass and
  hides everything behind it. Soft edges draw blended. A solid painted silhouette with a soft rim costs far less than
  a large half-transparent wash.
- **Size is budget.** A chunk holds 1016 × 1016 texels, which is 1016·texelScale world units. Every visible chunk
  costs up to 4 MB of texture memory, and one layer may show at most **4 chunks at once**. Trim empty margins.
  Paint far and soft things at a coarser `texelScale` (2–3). Only near, crisp things need 1.5.
- **Don't leave near-invisible alpha noise.** Texels with alpha 1/255 are treated as empty. Stray alpha
  2–20 texels still count as visible and grow the soft rects.
- **Mind the moon.** The sky's moon is screen-fixed (27 %, 15 % of the view) while a plate moves with its
  parallax, so a plate can slide over it as the camera moves. `node tools/art/moon.ts <area> [id …]` sweeps
  the area's cameras (every aspect, every height the camera takes over the area's walkable surfaces) and
  reports the worst share of the moon disc a plate hides. The art review allows at most 20 %: keep solid
  shapes out of the moon's sweep and let only sparse strands cross it. `glade-frame` is laid out around
  that sweep (`moonSweepBox`).

## 3. Dropping in: `art/plates/<id>.png` + `<id>.json`

The id is the file stem: letters, digits, `-` and `_`, up to 64 characters. It becomes the layer id and the chunk
file names, so it can't be the id of a base layer or of the demo plate (`npm run plates` writes into the same folder).

| Key | Required | Meaning |
|---|---|---|
| `parallax` | yes | `[fx, fy]`. Where the plate goes among the base layers, far to near. A tie with another layer is rejected. Depth-tested plates need `0 < fx ≤ 0.95` and stay 0.02 from their neighbours. `fx > 1` is a foreground plate (blended, no depth test), up to 4. |
| `replaces` | no | Id of a base kit or plate layer that this plate takes out of the draw list. If the plate fails to load, that layer draws again. Use it only when the painting covers that layer across the whole level. The plate may take its exact fx. |
| `origin` | yes | Layer-space top-left of the image, in world units. |
| `texelScale` | yes | World units per image texel, from 1.5 to 64. Below 1.5, un-mipmapped WebP/PNG chunks would alias at Low quality. |
| `minQuality` | yes | `low`, `medium` or `high`: the lowest quality level that draws the plate. It is the plate's quality gate. Plates never count toward `layerBudget`. |
| `fog`, `fogColor`, `desaturate`, `tint` | yes | Aerial perspective, the same parameters as a kit layer (`fog`, `desaturate` in 0–1; colours `#rrggbb`). |
| `area` | no | The grade zone the plate belongs to (reports only). |

Keys starting with `_` or `$` are comments. They don't trigger a re-bake. Every error names the file, the key
and the fix. A misspelt key suggests the right one.

## 4. `npm run art`

- It validates every pair in `art/plates/`: the PNG header (read without decoding), the sidecar, and the ids. It
  reports every problem at once.
- It cuts each image into 1024² chunk textures: 1016² texels of content and a 4-texel border copied from the
  neighbouring chunks. One texel of border would do for bilinear filtering, but basisu builds KTX2 mip 1
  (drawn at Low and under dynamic resolution) with a Kaiser filter that reads about 3 texels around each
  texel and wraps at the texture edge; with 4 shared texels both chunks compute the mip-1 texels at a seam
  from the same pixels, and the 1016-texel step keeps their 4×4 compression blocks aligned. What is left
  at a seam is ETC1S coding noise, as at mip 0. Each chunk is read as a strip with sharp `extract()`, so
  no image is ever decoded whole. Empty chunks are skipped.
- For each chunk it computes a pixel hash, split-hull `core` and `soft` rects, and **WebP + PNG + KTX2
  (ETC1S)** files. It re-encodes only chunks whose pixels changed. KTX2 takes about 4 s a chunk.
- It splices the plates into the hand-edited base `public/layers/forest.base.manifest.json` and writes
  `public/layers/forest.manifest.json`. Never edit the generated file. Base layers the plates replaced
  are recorded under its root `replaced` key. Chunk URLs carry `?v=<hash8>` for cache busting.
- It writes `art/bake.lock.json`: per plate, the source hash (PNG bytes + canonical sidecar + tool version),
  the chunk hashes and rects, and the hashes of the encoded files. Files are reused only when the lock was
  written by the same tool version (`ART_TOOL_VERSION`, bumped when chunking, hulls or encoder settings
  change); a new version re-encodes everything.
- It checks the budgets (section 6) and prints the report. **Nothing is written unless everything validates and fits.**
- It deletes the chunk files of plates that are gone, or of chunks a plate no longer has.
- `npm run art -- --check` recomputes the source hashes, the chunk hashes and rects, the file hashes and the splice,
  decoding but never encoding (about 1 s). It lists anything stale and exits 1: an image or sidecar changed since the bake, a
  plate not baked yet or deleted, an edited or missing chunk file, or a hand-edited generated manifest.

## 5. Hot reload (`npm run dev`)

- The Vite plugin `tools/art/vite-plugin.ts` watches `art/plates/**`, the base manifest and the lock. It runs
  in the dev server only (`apply: 'serve'`) and is inert under Vitest.
- **A save** is picked up once the file's size has been stable for 200 ms (paint programs write in steps). A
  worker thread re-bakes the plate: it hashes every chunk and WebP-encodes only the chunks whose pixels changed.
  This takes 0.2–0.7 s a chunk.
- **Pixels, colours, origin or texel scale changed:** the page re-fetches the manifest, and the parallax stack reloads
  that one layer. It evicts the chunks, rebuilds the meshes and streams them again, under a new generation, so a
  late texture of the old version can't unload the new one.
- **Structural changes reload the page:** `parallax`, `replaces`, `minQuality`, a plate added or deleted, and any edit of
  the base manifest or the lock (`npm run art` finished).
- The plugin serves the dev manifest and all plate files from its own middleware. Re-baked chunks are listed with
  their in-memory WebP only, and a stale KTX2 or PNG on disk is never used. **Run `npm run art` before you commit**:
  `--check` fails until you do.
- A broken save (invalid JSON, a bad value, a tie, a half-written PNG) is logged in the dev-server terminal,
  and the page keeps the previous version. So is a half-saved base manifest or lock: until it parses, the
  dev server keeps what it served (or, at start-up, leaves the committed files to Vite). A re-bake that
  hangs is abandoned after 3 minutes and the worker restarted. The dev server also warns early when a change
  would break the budget.

## 6. Budgets

The bake sweeps the camera over its clamped range at the widest aspect (21:9), the smallest zoom and the largest
screen shake; foreground plates (fx > 1) also at every narrower aspect down to 4:3 where a chunk edge meets a
view clamped at a level edge, since a narrow view there reaches further into them. It samples every point where
any chunk enters or leaves the view. For each quality level it adds:

- 4·w·h bytes for every visible chunk of the plates that level draws (RGBA8, the no-KTX2 worst case);
- every registered atlas (kit, particles, entity, hero), measured by building them as the game does. Their
  sizes change when their owners change them, so read the current ones on the report's `registered atlases`
  line rather than from here.

The sum must stay within `textureBudgetMB` (read it from the base manifest). If adding the 480 u prefetch margin
goes over, it is a warning: the streamer then skips prefetching there. A layer showing more than 4 chunks at once
is an error. The report names the worst camera position and the chunks it shows:

```
  high   budget 96.00 MB: atlases 24.51 + visible plates 2 chunks 8.00 = 32.51 MB (63.49 MB free); …  ok
         worst view: camera (1260, 540) at 2.33:1 shows glade-landmark ×1, glade-frame ×1
  glade-frame (glade): f 0.6/0.6, minQuality medium, 1 chunk of 1024×1024, at most 1 visible (limit 4)
```

If a plate is over budget: raise its `minQuality`, raise `texelScale`, trim transparent margins, or move content so that
fewer chunks share one view.

## 7. Shipping

1. Review the plate in context without a browser: `node tools/art/preview.ts <outDir> glade`. It renders the CPU scene
   preview with the sources spliced in, post and grade included. Cameras are `glade-left`, `glade-ref` and `glade-right`. Options:
   `--aspect 21:9`, `--without` for a before/after comparison, `--baked ktx2` to see the encoded chunks with their ETC1S artefacts, and
   `--at name=x,y`.
2. Run `npm run art`, then `npm run art -- --check`.
3. Commit `art/plates/<id>.png` + `.json`, `art/bake.lock.json`, `public/layers/forest.manifest.json` and
   `public/layers/plates/<id>_*`. Templates stay local.
4. The main session reviews the plates on the GPU in the browser, and removes any that fail.
5. To remove a plate, delete its two files and run `npm run art`. Its chunk files are deleted, and a layer it replaced comes back.

The single-file artifact (`npm run artifact`) carries no plate files, so it should embed the base manifest. A plate
whose chunks can't load is dropped, and any layer it replaced comes back, so a page that lists plates it can't fetch
still works.

## What the runtime does

- **One streamer and one LRU for all plate layers.** Their budget is `textureBudgetMB` minus everything else
  registered (the atlases), re-read every frame. Visible chunks load first, then the 480 u prefetch, nearest first,
  with 2 loads in flight. Chunks that are not visible are evicted least-recently-wanted first. Visible chunks are never evicted.
  A chunk counts at the RGBA8 worst case until it loads and at its real size afterwards, so a KTX2 chunk that
  falls back to WebP (3× the bytes of a mipmapped KTX2 chunk) is accounted as such.
- **2 draws per visible chunk:** an opaque-core mesh in the depth pre-pass and a soft mesh, blended.
- **Every load has a deadline:** 20 s, and 12 s for KTX2. KTX2 falls back to WebP/PNG for the rest of the session.
  When a chunk fails for good, its whole plate is dropped, and the base layer it replaced (if any) draws again at its own depth.
- **Formats:** KTX2 when the GPU samples BC7/BC3/ETC2/ASTC and the CSP allows the transcoder, else WebP, else PNG.
- Quality: a plate draws at the levels its `minQuality` allows. `layerBudget` trims only kit layers.

## Pitfalls

- A plate whose fx equals a base layer's is rejected: the draw order would be ambiguous. Take the stub's value,
  which is the nearest free depth.
- `replaces` on a painting that covers only part of the layer leaves the rest of the level without that layer.
  Add a plate between layers instead.
- Don't bake fog into the pixels *and* set `fog` in the sidecar. Pick one: the sidecar.
- Don't edit `public/layers/forest.manifest.json`. Edit `forest.base.manifest.json` and run `npm run art`.
- If a plate looks sharp in dev but blocky in the game, look at the KTX2 chunks (`--baked ktx2`) and check that `texelScale` suits the detail.
- The generated manifest changes only through `npm run art`. A dev session never writes it.

## Worked example in this repo

- `node tools/art/paint-example.ts [--only glade-landmark|glade-frame] [--preview <dir>]` regenerates the two example
  plates on the frozen SDF and noise helpers (`tools/art/painter.ts`). It paints in the depth's pre-fog colours
  and interpolates the sidecar fog from the neighbouring kit layers. `glade-landmark` is 602×512 texels
  at texelScale 1.5, minQuality low, and its shaded value p50 is 0.192, between L2 (0.208) and L3 (0.173). `glade-frame` is
  1009×834 at texelScale 2, minQuality medium, p50 0.099, between L5 (0.113) and L6 (0.088). Each is one chunk.
- `glade-frame` is composed around the moon: the camera climbs ~780 u over the Glade (the high ledge to the
  floor), which moves an f 0.6 plate ~470 u on screen, so the bough and its canopy sit above the moon's sweep
  and only come into view from the highest cameras. At the reference camera the frame reads as the hollow tree
  on the left, a foliage corner and curtains at the top right, and single thin strands across the middle; it
  hides at most 15 % of the moon anywhere in the Glade (`node tools/art/moon.ts glade`).
- Code: `tools/art/` (`bake.ts`, `bake-art.ts`, `chunks.ts`, `source.ts`, `sidecar.ts`, `budget.ts`, `atlases.ts`,
  `templates.ts`, `export-templates.ts`, `dev.ts`, `dev-worker.ts`, `bakeWorker.ts`, `vite-plugin.ts`, `preview.ts`,
  `moon.ts`, `ktx.ts`), `src/assets/`
  (`splice.ts`, `manifest.ts`, `plateLayout.ts`, `streamer.ts`, `textures.ts`, `hotReload.ts`), and
  `src/render/layers/{plates,parallaxStack}.ts`. The M1 demo plate `tools/plates/` (`npm run plates`) uses the same
  chunking and splice.
- Tests: `npx vitest run tests/world/art*.test.ts tests/world/{plates,manifest,streamer,textures}.test.ts --maxWorkers=2`
  (`artSeams` decodes the demo plate's KTX2 mips, `artMoon` sweeps the Glade cameras).

## Related skills

channel-packed-atlas (the kit program, hulls and chunk meshes that plates reuse), layered-atmosphere (the
value ramp and the depth pre-pass), sdf-silhouettes (the procedural painters behind the examples).
