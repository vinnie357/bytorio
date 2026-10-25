# macOS native player spike

Status: spike on `feat/macos-native-player`, stacked on `fix/macos-web-authoring`.
It proves the native player builds and runs on macOS arm64. It is not the full port.

## What compiled and ran

- `mise run deps:player:native-binary` builds `build/odin-player/native/player` (arm64 Mach-O)
  on macOS with Odin dev-2026-10. Windows keeps its foreign imports and file contents.
- The built player was staged by hand (`player`, `libSDL3.0.dylib`, `libSDL3.dylib`) in a scratch
  directory. Packaging was not touched.
- `player --smoke` with `SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy SDL_RENDER_DRIVER=software`
  passed for `examples/hello` (`audioQueuedFrames` 32000) and for the packed
  `prototypes/bytorio-tactics/game` cartridge (`ticks` 120, exit 0).
- A real window opened with the CPU renderer and rendered the tactics grid at 60.2 FPS.
- `--renderer gpu --gpu-meshes` created a core-profile OpenGL 3.3 context and ran
  ("graphics: GPU rasterization enabled").
- The GPU renderer cannot be smoke-tested with the dummy video driver, which has no OpenGL.
  A `--renderer gpu` verifier needs a real display on macOS.

## Pins

- wasmtime 49.0.3, `wasmtime-v49.0.3-aarch64-macos-c-api.tar.xz` (sha256 `0c853eb1...332c41b`), pinned in `.mise/toolchain.toml`
  as `"github:bytecodealliance/wasmtime[macos]"` with `os = ["macos"]`. mise treats the
  `[macos]` suffix as a backend option on the same tool, so `mise where` and `tool()` still
  resolve it through the unsuffixed name. The suffix only avoids a duplicate TOML key.
  The player links the static `lib/libwasmtime.a`.
- SDL3 3.4.2, built from the pinned source tarball by `tools/sdl3-build.mjs` (sha256
  `ef39a2e3f9a8a78296c40da701967dd1b0d0d6e267e483863ce70f8a03b4050c`) with the pinned cmake and
  ninja, into `build/sdl3/install`. 3.4.2 matches Odin's `vendor:sdl3` bindings. Odin links
  `vendor:sdl3` on darwin as `system:SDL3` and ships no darwin library, and no mise tool or
  release asset provides a plain SDL3 dylib (upstream releases a `.dmg`). The build task follows
  the existing Vorbis source-build style. Task: `deps:sdl3:native`.

## Files changed

- Renamed with no content change except as noted (15 files, Odin compiles `_windows` only on
  Windows): `runtime/odin/native/{audio,benchmark,main,text}.odin`,
  `runtime/odin/guest/{bindings,content,guest,ogg,save,text}.odin`,
  `runtime/odin/gpu/native/{backend,frame,presentation,resident,texture}.odin`.
- `benchmark.odin`: `process_memory` moved out.
- Added `runtime/odin/native/memory_windows.odin` (the moved code) and `memory_darwin.odin`
  (`task_info` with `MACH_TASK_BASIC_INFO`).
- `guest/bindings.odin`, `guest/ogg.odin`: `foreign import` is file scoped in Odin, so each
  import is now a `when ODIN_OS == .Windows` / `.Darwin` block in the same file.
- `guest/save.odin`: the Windows `MoveFileExW` call moved to `guest/move_windows.odin`
  (same call); `guest/move_darwin.odin` uses `link()`, which also fails when the destination exists.
- `gpu/native/backend.odin`: calls `request_context_flags()`; `context_windows.odin` is empty,
  `context_darwin.odin` requests a forward-compatible core profile.
- `native/main.odin`: the executor-cache `make_directory_all` now accepts `.Exist`. On macOS it
  returned `Exist` on every run after the first, so the player refused to start twice.
- `tools/player-build.mjs`: removed the Windows-only throw, outputs `player` off Windows, adds
  the SDL3 link path and `@executable_path` rpath.
- `tools/sdl3-build.mjs` (new), `.mise/tasks/vorbis.toml` (`deps:sdl3:native`),
  `.mise/tasks/player.toml` (native-binary depends on it), `.mise/toolchain.toml` (wasmtime pin).
- `tools/build-tasks.test.mjs`: fixture path `main_windows.odin` to `main.odin`.

## Finding

`backend.odin` passes `i32(sdl.GLProfile.CORE)`. `GLProfile` is a bit set, so this is 0, not the
`CORE` mask (1). This is a Bytorio call-site mistake, not a defect in the Odin bindings. Windows
tolerates it; macOS then gives a 2.1 context and fails. The darwin file re-requests the mask
correctly. Fixing it on Windows too is a one-line change but alters Windows behavior, so it was
left alone.

## Review fixes

- The executor cache path must be an existing directory; a regular file there is an error on every OS.
- Task outputs: `deps:sdl3:native` and `deps:vorbis:native` declare a stamp the script rewrites on
  every host, because build tools leave an unchanged library untouched and mise then sees it as
  stale. `native-binary` declares `player.exe` or `player` through a tera `os()` condition. Second
  runs on macOS report "sources up-to-date, skipping" with no output warning.
  `deps:player:native-support` still declares Windows files until export staging is ported.
- Saves: macOS defaults to `~/Library/Application Support/Bytorio/saves`, mirroring the Windows
  `%LOCALAPPDATA%\Bytorio\saves` layout, and an existing save directory is accepted.
  `BYTORIO_SAVE_DIRECTORY` still overrides. `tools/verify-save.mjs` passed natively on macOS
  through a temporary copy that pointed at the macOS player. One case changed: the
  read-only-file replace failure cannot happen on POSIX, because rename ignores the target file
  mode, so the copy used a read-only save directory. The real verifier still needs that case split
  by OS.
- wasmtime archive checksum pinned in `.mise/toolchain.toml`; mise rejects a mismatch. It equals
  the digest GitHub publishes for the asset.

## Remaining work for the full port

Sizes are rough counts of files and changed lines.

- Export staging: `tools/player-export.mjs`, `tools/stage-player.mjs` and the
  `deps:player:native-support` outputs hardcode `player.exe`, `SDL3.dll`, `wasmtime.dll` and
  `vendor/sdl3/SDL3.dll`. macOS stages `player`, `libSDL3.0.dylib` and the license, and no wasmtime
  library because it is static. `tools/player-export.test.mjs` also changes. 4 files, about 60 lines.
- `nativeExport` on darwin: `tools/sdk/project.mjs` (`nativeExport`, `browserOnlyHosts`,
  `requireNativePlayer`, the `build:odin` choice), `tools/byt.mjs`, `tools/verify-sdk.mjs` and
  its messages. Semantics were left unchanged in the spike. 3 files, about 40 lines.
- Verifier executable names: about 20 verifiers reference `player.exe` or `SDL3.dll` (for example
  `verify-gpu`, `verify-audio`, `verify-graphics`, `verify-resources`, `verify-textured-*`,
  `verify-billboards`, `verify-ogg`, `verify-sdk`, `verify-profile`, `verify-text-input`). A shared
  helper for the executable name and library copy removes most of the edits. About 22 files,
  about 120 lines.
- Test player sources: `tests/{audio,graphics,ogg,resources}/player/main_windows.odin` (348 lines)
  are Windows-only and need the same rename, plus the `build:trace` and `build-tasks.test.mjs`
  references. 4 renames, about 20 lines.
- Release packaging: `tools/package-release.mjs`, `release-config.mjs`, `publish-release.mjs`
  and tests (a macOS archive with `player`, the dylib and licenses). 4 files, about 80 lines.
- Signing and Gatekeeper: a downloaded `player` is quarantined and unsigned, and the bundled dylib
  needs a matching signature. Requires an Apple Developer ID certificate, codesign with hardened
  runtime, notarization and stapling. The link order uses `@rpath` with
  `@executable_path`, so the dylib must stay beside the binary. Rough size: one script of about
  80 lines, plus operator work to obtain credentials. Ad hoc signing is enough for local runs.
- CI: `.github/workflows/build.yml` and `release.yml` run only on `windows-latest`. A macOS job
  (arm64 runner) needs the toolchain install, `deps:player:native-binary`, the native verifiers
  and the smoke run. macOS runners bill at 10x on private repos. 2 files, about 60 lines.
- Docs: `docs/development.md` and the README platform statements. 2 files, about 20 lines.

## Blockers

- None for the CPU or GPU renderer on arm64.
- GPU verifiers need a real display on macOS, because the dummy video driver has no OpenGL.
- Notarization needs operator-held credentials.
- x86_64 macOS is untested. wasmtime publishes an `x86_64-macos` asset, but the pin is arm64 only.
- Audio output was not exercised (the cartridge under test queues no audio); `hello` smoke passed
  with the dummy audio driver only.
