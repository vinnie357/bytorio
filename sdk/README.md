# Bytorio SDK guide

Make games in Luau or Odin, run them in the native or browser player, and share
them as PNG cartridges. **Start with [Getting started](../docs/getting-started.md)**
for installation and your first playable game without a source checkout.

The SDK also provides an [embeddable web player](web-player.md) with
digital touch controls and a [browser runtime](web-runtime.md) for custom hosts.
These preview APIs are versioned with the SDK. Existing SDK pins keep their
previous player until explicitly upgraded with `byt sdk upgrade`.

## Supported features

The SDK/API numbers below identify cartridge profiles. The independently
versioned SDK distribution in `bytorio.lock.toml` may contain several profiles.
Select one with `profile` in `bytorio.toml`; the CLI verifies its availability.

Both players support three [frame-rate policies](../docs/frame-pacing.md):
a custom render cap (60 FPS by default), uncapped rendering, and native display
refresh. Simulation remains fixed at 60 Hz in both SDKs.

Two authoring SDKs for the same **resource-av-1** console. Luau is the default
authoring language; Odin is supported for explicit memory control and performance.
The standalone native and browser players share the Odin renderer and cartridge
ABI. The [formal specification](../docs/cartridge-spec.md) defines behavior and
[contract.json](contract.json) records wire constants and required exports.

The [typed graphics/audio specification](../docs/resource-av-spec.md) and
[published profile](profiles/resource-av-1.json) define SDK 0.2.0 / ABI 2.
[Resources](resources.md), [explicit graphics](graphics.md), [PCM audio](audio.md)
and [synthesis/effects](synthesis.md) work through both SDKs on native and browser.
SDK 0.1.0 / ABI 1 remains an explicit compatibility profile. Existing manifests
retain their version; new projects request SDK 0.2.0 and `resource-av-1`.
See [profile negotiation and conformance](../docs/resource-profile.md).

SDK 0.3.0 / `compact-3d-preview-1` is an explicit experimental opt-in for
[meshes, cameras, depth and voxel resources](../docs/compact-3d.md) in both SDKs.
Create an SDK project, then set `profile = "compact-3d-preview-1"` in `bytorio.toml`.
`mise run build:3d` exports the matching native/browser prototypes.

SDK 0.4.0 / `textured-3d-preview-1` extends that opt-in with
[UV meshes and typed materials](../docs/textured-3d.md). Set
`profile = "textured-3d-preview-1"` in `bytorio.toml`. Both SDKs expose
`gfx3d.textured_mesh`, `gfx3d.material` and `gfx3d.draw_textured`. CPU rendering is
the default; optional CPU supersampling and GPU rendering/residency use the same
API. Existing profiles keep their original contracts and defaults.

SDK 0.5.0 / `alpha-3d-preview-1` adds [depth-tested billboards and alpha cutout](../docs/billboards.md).
It reuses typed UV meshes/materials on CPU and optional GPU paths. Select
`profile = "alpha-3d-preview-1"`; contributor examples have matching source builds.

The [static glTF/GLB importer](../docs/model-import.md) generates ready-to-use Luau
and Odin model modules, preserving named rigid parts for game-side animation.
The contributor command `mise run byt -- import <asset> --output <project>/src/imported` identifies
the required preview profile, limits and base-color rendering reductions.

SDK 0.6.0 / `effects-3d-preview-1` adds
[premultiplied and additive scene-space effects](../docs/3d-effects.md), with
independent depth-test/write controls. Both SDKs use `gfx3d.effect_material`;
CPU rendering remains the default. See `examples/effects` and `examples/kart3d`.

## Install byt

A [Windows and Mac CLI](https://github.com/ctxshift/bytorio/releases)
creates, checks, builds, packs and runs games using a version-pinned SDK.
It downloads matching tools and players when needed. Follow
[Getting started](../docs/getting-started.md) for the download instructions,
supported commands, including
[installation through mise](../docs/getting-started.md#install-with-mise).
Luau/browser authoring supports Windows x64, Apple Silicon and Intel Macs.
Odin and native players support Windows and Apple Silicon. Follow the
[Mac install and usage instructions](../docs/getting-started.md#macos-apple-silicon-or-intel).

With mise, add this short entry using the full CLI release tag in place of
`byt-v<version>`, then run `mise install github:ctxshift/bytorio`:

```toml
[tools]
"github:ctxshift/bytorio" = "byt-v<version>"
```

## Start a game

Install the standalone CLI, then run outside the Bytorio checkout:

```sh
byt new my-game
byt check my-game
byt run my-game
```

The command is `byt`; the package is named `bytorio`.

For Odin, create with `new my-game --language odin`. Projects are ordinary folders;
they may live outside this repository. The `new` command refuses existing folders.
New projects contain source, `bytorio.toml` and `bytorio.lock.toml`. The latter
pins a compatible SDK distribution and checksum until `byt sdk upgrade` is
explicitly requested. Managed components live in a shared per-user cache;
ordinary game builds require no global compiler or Bytorio source.

Luau checks generate a portable `.luaurc` alias and an ignored SDK mirror. Use
the standard Luau platform and new type solver in your editor. The SDK's `read` table properties
require that solver. For an existing project, merge the settings from
[the editor template](templates/luau-settings.json). If diagnostics remain after
the settings load, run **Luau: Reload Language Server** in the command palette.

| Command                                                    | Behavior                                                     |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| `new <directory> [--language luau\|odin]`                  | Create source, small TOML config and exact SDK pin        |
| `check <directory>`                                        | Check types, assets, ABI and first rendered frames           |
| `build [directory] [--target web\|native\|all]`            | Export web by default; native is explicit     |
| `pack <directory> [--output game.png] [--cover cover.png]` | Build and export a viewable PNG containing the complete game |
| `run [directory] [--port 0] [--no-open]`                      | Build once and open the browser player              |
| `run [directory] --target native`                           | Build and launch the native player                           |
| `dev [directory]`                                          | Rebuild after edits and reload the browser after success    |
| `sdk upgrade [directory] [--sdk <version>]`                  | Explicitly update the project's generated SDK pin            |

`build/native` contains the executable, libraries, licenses and cartridge files.
Copy that whole folder to run without Node.js, a compiler or a webview. Both
languages launch with `player.exe` on Windows or `player` on Mac, loading
`game.png` automatically. Share the single `build/game.png` file with another
compatible player. `build/web` can be
served as static files; its configured player loads the same PNG. The browser
also accepts local PNGs through **Open cartridge** or drag-and-drop. See
[PNG cartridges](../docs/png-cartridges.md) for the format, custom artwork,
runtime components, loading commands and current preview limits.

For assets larger than the code budget, declare `[[content]]` entries in
`bytorio.toml`. The [indexed content guide](../docs/indexed-content.md)
describes both SDK read APIs, byte limits and the immutable cartridge index.

## Project structure and lifecycle

`bytorio.toml` declares title, language, optional profile, entry path, asset path, optional PNG cover path and
initial display. Supported displays are `[640,360]` and `[320,180]`. Paths are
relative to the project and may not escape it. Without an `assets` override the
SDK supplies starter art. A custom `assets.json` contains exactly
16 `#RRGGBB` palette entries, 1..256 sprites of sixteen 16-character rows, and an
optional ASCII bitmap font. Sprite pixels are palette digits `0`..`f` or `.` for
transparency. Font entries have seven five-bit string rows. Extra source metadata,
such as a tile map, can be stored in this JSON and in normal game modules.

The package is `bytorio`; use `byt` as the local namespace in game code.
Luau's entry is a `.luau` module returning `init`, `update(dt)` and `draw` functions.
Use `local byt = require("@bytorio")`. Strict types and completions come from
the real SDK module copied into ignored `.bytorio/`, with a portable `.luaurc`
alias. The CLI analyzes game sources and their dependencies, then bundles literal
relative `require("./module")` and `require("@bytorio")` calls. Modules execute
once and cache their returned value. Cycles, dynamic requires, shadowing `require`,
external packages and paths escaping the project are unsupported. Strings and
comments are preserved. The player requires no filesystem module loader.

When updating source projects, replace `require("@console")` with
`require("@bytorio")`, rename the local SDK variable to `byt`, and change Odin
imports to `byt "sdk:bytorio"`. Generated Odin files now use `bytorio_entry.odin`
and `bytorio_assets/`. Luau checks refresh `.bytorio/` and the managed `bytorio`
editor alias, preserving other settings and aliases, and ignore the mirror in
Git. An old generated editor alias is removed; user-defined aliases are retained.
Legacy contributor projects retain `console.json`. Standalone projects use
TOML and a separate distribution pin; cartridge formats, profile markers
and exported guest functions are unchanged. Previously built cartridges continue
to run without recompilation.

Odin's entry is a package directory with `package main`, `init :: proc()`,
`update :: proc(dt:f64)` and `draw :: proc()`. Import `byt "sdk:bytorio"`.
The CLI supplies the collection, generates an atlas package and lifecycle entry
point under `build/generated/`, and compiles the cartridge. Source names
`bytorio_entry.odin` and the `bytorio_assets/` package are reserved. The generated
atlas can be imported as `assets "./bytorio_assets"` from the entry package.
Game authors do not write Wasm exports or buffer-offset code.

Both SDKs initialize input/time/random state, prepare graphics batches and provide
the same console operations. Update always receives 1/60 seconds; input edges
are sampled once per tick. Keep simulation in update and presentation in draw.
Changing display mode does not reset state. Calling your own init callback to
restart a round does not reload the SDK. See [the API reference](api.md).

Odin retains normal explicit memory management: allocations belong to the game,
and temporary allocations need an explicit reset strategy. The SDK itself uses
fixed buffers for frame drawing and diagnostics. Avoid returning strings backed
by dead stack storage, or allocating text every frame without reclaiming it.

## Direction and camera input

The original `left`, `right`, `up`, `down`, and `action` buttons retain their
bindings and bits. `buttons()` still returns only those five bits. The current
player also delivers independent `move_left/right/up/down` (WASD or gamepad
D-pad), `pan_left/right/up/down` (arrows), `rotate_left/right` (Q/E), and `reset`
(R). Odin uses `MoveLeft`, `PanLeft`, `RotateLeft`, and the corresponding enum
members; Luau uses the lowercase names with underscores. `button`, `pressed`
and `released` support every named button. `all_buttons()` returns the complete
mask. These optional controls require the current player; older SDKs continue
to ignore the extra bits. See the canonical values in `contract.json`.

Input version 2 adds `pointer_left`, `pointer_right`, `pointer_hover`,
`wheel_up/down`, `inventory` (I), `character` (C), `skills` (K), `quest` (Q),
`map` (Tab), `potion_1` through `potion_4` (1–4), `shift` (either Shift), and
`escape` (Escape). Odin names are `PointerLeft`, `PointerRight`, `PointerHover`,
`WheelUp`, `WheelDown`, `Inventory`, `Character`, `Skills`, `Quest`, `Map`,
`Potion1` through `Potion4`, `Shift`, and `Escape`. Q also retains `rotate_left`.
`capabilities().input_version` reports 2 without changing cartridge profile ABIs.

`pointer_position()` returns `(hover, x, y)` in logical display coordinates,
including movement with no mouse button held. `pointer()` retains its original
left-held meaning and returns `(false, 0, 0)` when inactive. Both discard
out-of-display coordinates. `wheel()` returns +1 for up, -1 for down, or 0;
the host coalesces wheel events to the latest direction before the next tick and
consumes it once, even when several simulation ticks share a rendered frame.
Focus loss clears held controls and pending wheel input.

Native `--replay` accepts the original whitespace-separated unsigned button
masks or versioned `v2:mask:leftHeld:x:y` tokens. For example,
`v2:262144:0:80.5:60.75` hovers without pressing a button. Masks are unsigned
32-bit integers; Escape occupies bit 31. Browser worker step requests use the
equivalent `{buttons, pointer, x, y}` input snapshot. Old SDKs ignore the added
bits and continue to receive their original pointer semantics.

## Browser cartridge cache

Built web players reference `game.png?revision=<SHA-256>` using the exact
cartridge bytes. The browser stores these versioned downloads in CacheStorage;
refreshing the same export can load without another cartridge HTTP request.
A new cartridge produces a new revision and downloads fresh bytes. HTML must
still be served with an appropriate revalidation policy so browsers see new
exports.

The cache uses no service worker. It streams the download into browser storage
with loading progress, then streams the stored response into the player. It
does not tee a large response into an unbounded JavaScript queue. Each transfer
retains the ordinary cartridge size limit; successful writes prune older entries
to keep two revisions when browser storage operations succeed. Browsers can
evict cached data, and unavailable storage or quota errors fall back to network
loading. Local files and URLs without an exported revision bypass this cache.

Run `mise run validate test:cartridge-cache` to check real browser refreshes,
revision changes, local files, and storage-failure fallback. Cached bytes are
still checked by the ordinary cartridge parser; the URL revision selects an
export version and does not replace its format validation.

## Verify

Both SDKs also provide a versioned [persistent save slot](save.md), with a
64 KiB limit, native atomic replacement and browser transaction status.

```text
npm run test:sdk
npm run test:cartridge
mise run validate test:save
```

The suite builds real projects with both SDKs and verifies native/browser parity,
mode switching, clipped and sized sprites, text, input edges, pointer delivery,
known random vectors, sound events, reload, static errors and invalid arguments.
Retained projects and outputs live in ignored `build/sdk-verification/`.
The RPG and racing examples also use these SDKs; their existing build commands
generate the entry points and pack their shared art. Racing replays retain all
2,236 pre-SDK framebuffer/sound pairs, and RPG checks retain the original artwork
hashes within its historical 384×216 scene on the current default canvas.
