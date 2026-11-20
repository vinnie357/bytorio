# Odin reproduction

The Odin player reproduces the original sprite-and-sound example on Windows and macOS native hosts and in the browser. Both hosts load **identical game.wasm bytes** compiled from [the game source](../examples/hello/odin/main.odin). Rendering, sprite pixels, PCM generation, command validation, and framebuffer hashing live in [shared Odin runtime code](../runtime/odin/core/core.odin).

The native player is an Odin executable using SDL3 and Wasmtime's C API. It has no maintained C++ core and needs no webview, Node.js, or compiler to play. The browser loads the Odin game and Odin runtime as separate Wasm instances in a Worker. JavaScript handles browser input, scheduling, pixel presentation, audio output, and Worker lifecycle.

## Build and run on Windows

Prerequisites: mise 2026.10.15 or newer, Git, and the native linker prerequisites described by [Odin's installation guide](https://odin-lang.org/docs/install/). A Visual Studio C++ desktop workload is available in the tested environment; that is a build prerequisite, not a player dependency.

From the repository root:

```text
mise install
mise exec -- npm ci
mise run build:odin
./build/odin-player/native/player.exe
```

Mise installs Odin `dev-2026-10` revision `84bc3fc` and Wasmtime C API **49.0.3**, with download verification handled by mise. Build commands resolve these managed installations rather than downloading tools themselves. The build uses basename-only source locations to avoid embedding machine paths in exported binaries.

`mise run deps:player:native` and `mise run deps:player:web` build one host.
Playable games own their [nested project tasks](../examples/README.md), such as
`mise run //examples/rpg:build`. Native targets Windows x64 and macOS arm64.
On macOS, install Xcode Command Line Tools, run the same mise setup/build commands,
and launch `./build/odin-player/native/player`.
The pinned Odin release has no Intel Mac compiler; Intel Mac CI covers the
standalone scaffolding CLI only.

The native player finds `game.wasm` beside its executable, independent of the working directory. Distribute `player.exe`, `game.wasm`, `SDL3.dll`, `wasmtime.dll`, and `licenses/` together. An import-table inspection found only those bundled libraries and Windows system dependencies; a clean-machine packaging test remains outstanding.

On macOS, distribute `player`, `game.wasm`, `libSDL3.0.dylib` and `licenses/`.
Wasmtime and Vorbis are linked statically. Exports use relative loader paths and
ad hoc code signatures; distribution signing and notarization are not provided.
Default saves use `~/Library/Application Support/Bytorio/saves` on macOS and
`LOCALAPPDATA/Bytorio/saves` on Windows; `BYTORIO_SAVE_DIRECTORY` overrides either.

Use arrows/WASD or a controller D-pad to move; Space, the controller's south button, or click/tap triggers the sound. Pointer input positions the sprite. Physical controller and touch hardware have not been tested yet. Focus loss pauses updates; native focus regain resumes them.

## Browser

```text
npm run serve:odin
```

Open [the local player](http://127.0.0.1:8080/player.html) and click **Start game**. The default port is 8080; stop another preview on that port first, or select another port:

Set the `PORT` environment variable to `8081` before starting the server.

Serve the files in `build/odin-player/web/` together over localhost HTTP or hosted HTTPS. Wasm must use `application/wasm`, and JavaScript module files must use a JavaScript MIME type. No SharedArrayBuffer or cross-origin isolation headers are required. The browser uses a 2D canvas to present the software framebuffer; WebGL/mesh rendering remains future work.

The game Worker is watched externally: loading gets a ten-second network allowance, then guest instantiation/execution and frame requests get a one-second watchdog. A runaway game is terminated and the UI offers **Restart game**. Native guest calls use a fresh ten-million-fuel allowance, a 256 KiB Wasm stack limit, and store resource limits. Instantiation retains a two-million-fuel allowance. These are recovery controls, not equal CPU quotas or a performance guarantee across hosts.

Browser focus loss pauses the game; **Resume game** resumes it. Audio is gesture-unlocked and uses a static AudioBufferSourceNode copied from the Odin-generated sample. The native host queues the same generated PCM through SDL. This proves single-sample playback, not the future streaming mixer or worklet design.

## Verification

Install the pinned browser test dependency and test browser once:

```text
npm ci
npx playwright install chromium
npm run test:odin
```

To use an installed Chrome instead, set `PLAYER_BROWSER_CHANNEL=chrome`. The test creates and closes its own loopback HTTP server. `mise run build:odin` includes failure-test fixtures.

The verifier runs a real native SDL smoke scenario, checks byte-identical game modules, then checks browser movement, held-action behavior, pointer placement, sound data, audio-clock progression through a 500 ms UI stall, and a matching 120-tick replay. Both hosts reject unsupported ABI versions, out-of-range frame offsets, invalid drawing commands, and traps; the loop fixture exercises native fuel exhaustion and browser Worker termination/restart.

Captures and reports are saved under ignored `build/odin-player/verification/`. The checked local Windows/Chrome replay has:

- 120 updates, two sound events, sprite position `(412, 171)` after integer conversion.
- Framebuffer hash `3747813061` at the current 640×360 default mode.
- 32,000 sample frames queued by the native audio path.
- Browser sample peak approximately `0.21316`, with the audio clock advancing approximately half a second through the UI stall.

The native executable is approximately 636 KiB, bundled Wasmtime DLL 21.4 MiB, and SDL3 DLL 2.7 MiB in this build. Runtime/dependency size is separate from the cartridge budget. Tiny example module sizes are not representative of full games. Automated audio checks do not prove a human heard sound on a physical speaker.

## Prototype guest ABI

[The ABI package](../runtime/odin/abi/abi.odin) defines a 40-byte little-endian frame record. Its fields are version, clear RGBA, sprite x/y, tick count, cumulative sound count, and logical x/y. The frame preserves the initial one-sprite prototype. The [RPG display-list extension](../examples/rpg/docs/rpg-comparison.md) adds optional `game_commands()` and `game_command_count()` exports for general rectangle drawing, with sprites and text supplied by guest helpers.

Required exports:

- `game_abi() -> u32`, currently 1.
- `game_frame_size() -> u32`, currently 40.
- `game_init()`.
- `game_update(buttons: u32, pointer: u32, x: f64, y: f64)`; each call is one 60 Hz tick.
- `game_draw() -> u32`, returning an offset to the frame record.
- `memory`, an unshared wasm32 memory with an explicit maximum of at most 8 MiB.

The one allowed function import is `env.sin(f64) -> f64`, because Odin's freestanding math implementation lowers sine to that import. Native supplies it through a named Wasmtime linker callback and web supplies `Math.sin`. It grants no filesystem/network capability. Unknown imports fail. The measured example matches on both hosts, but host math is not a universal determinism guarantee.

The native adapter validates function calls through Wasmtime's typed API. The browser validates module size, memory declarations, imports/required exports, frame ranges, and shared Odin command checks. Neither adapter treats the guest frame pointer as a host pointer. Wasmtime C layouts are pinned and asserted in Odin; its memory handle includes significant nested-struct padding.

## Remaining work

The [RPG comparison](../examples/rpg/docs/rpg-comparison.md) adds guest-owned palette sprites, a tile map, text, a bounded rectangle display list, and matching Luau gameplay. [PNG cartridge loading](png-cartridges.md) is implemented for both languages. Indexed large ROMs, general texture imports, allocation-heavy games, full Wasm feature policy, runtime source-line diagnostics, state-preserving reload, streaming audio, and other desktop platforms remain later milestones. The C++ reference player has been removed; both cartridge languages use this Odin player. The Odin reproduction is not a claim that the whole machine profile or untrusted-cartridge security review is complete.
