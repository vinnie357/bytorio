# Linux x86_64 support

Fork PR 3, stacked on macOS native (PR 2). Goal: Bytorio authoring and the native player on Linux
x86_64, so pixel tactics runs on the Steam Deck (ftl-myth issue 18).

## Container

- Image `bytorio-linux:ubuntu22.04-2`, built from `tools/linux/Dockerfile` on Apple `container`
  with `--platform linux/amd64` (Rosetta). Base `ubuntu:22.04` pinned by digest.
- Pinned in the image: mise 2026.10.17 (sha256 checked), emsdk tag 6.0.12 installed by hand where
  mise expects it (the vfox plugin would fetch emsdk from `main`), the vfox-emsdk plugin at a
  commit, SDL3 build headers, Xvfb and Mesa. Everything else comes from `.mise/toolchain.toml`
  inside the container. No secrets are baked in.
- `mise run container:linux -- <command>` copies the checkout into the container's own `/work`,
  installs Node modules and the Playwright browser once per lock file, and runs the command.
  `container:linux:build` builds the image and `container:linux:stop` removes the container.

## glibc baseline

Built on Ubuntu 22.04, glibc 2.35. The player needs glibc 2.34 or newer (Odin's runtime), which
every SteamOS 3 release provides. SDL3 loads X11, Wayland, ALSA and PulseAudio at run time, so the
shipped `libSDL3.so.0` depends only on libc, libm and libdl. Wasmtime and Vorbis are static. A
lower baseline (Debian 10 or AlmaLinux 8, glibc 2.28) is possible but buys nothing for the Deck.

## What changed

- Odin sources: `memory_linux.odin` (`/proc/self/status`), `save_directory_linux.odin` (XDG data
  home), `context_linux.odin` (GL 3.3 core profile mask), `move_posix.odin` (shared by macOS and
  Linux), Linux arms in the Wasmtime and Vorbis `foreign import` blocks.
- Tools: `toolchain.mjs` gains the Linux library name (`libSDL3.so.0`); CMake installs into `lib`
  so Debian-style CMake does not use `lib/<triplet>`; `nativeExport` is true for Linux x64;
  task outputs use `os()` conditions.
- Wasmtime is pinned in one tool entry with per-platform assets and sha256 values. The earlier
  separate `[macos]` key was a second key for the same tool and replaced the Windows entry, so
  Windows would have had no Wasmtime. Each platform's asset checksum matches the digest the
  release publishes.

## Rosetta finding

`luau-analyze` 0.743 rejects every `.luaurc` under Rosetta: "Both .luaurc and .config.luau files
exist", then "Unknown require: unsupported path". Luau's `isFile()` ignores the return value of
`lstat()` and reads `st_mode`; Rosetta leaves stale data in the buffer when `lstat` fails with
ENOENT, so a missing `.config.luau` looks like a regular file. A source build of 0.743 on native
arm64 Linux passes; the same source built for x86_64 fails only under Rosetta. The image preloads
`rosetta-lstat.so`, which zeroes the buffer on failure. Real x86_64 hardware needs no shim.

## Verified in the container

`test:player-export`, `test:build-tasks` and `test:sdk` pass (the SDK check covers the 120-frame
native replay, the native smoke and the browser parity run in Playwright Chromium). `test:save` and
`test:odin` pass too; as root the failed-replace case of the save verifier is skipped because root
ignores read-only permissions. `byt new`, `check`, `pack` and `run --web` work, and the pixel
tactics cartridge packed in the container is byte-identical to the one packed on macOS. Its native
smoke reports the same state hash on macOS arm64, Linux x86_64 (CPU renderer) and Linux x86_64
(GPU renderer under Xvfb and Mesa llvmpipe): `2095723199`.

## Not run

- `test:gpu` compares native OpenGL against browser WebGL pixel hashes; under llvmpipe and
  SwiftShader they differ, so the parity check says nothing about a real GPU. Other GPU verifiers
  were not run.
- Audio output on a real device (dummy driver only), Wayland and Game Mode input, Steam Input and
  the default save directory on a Deck (`$XDG_DATA_HOME` or `~/.local/share/Bytorio/saves`).
- Deck frame pacing at 1280x800, and a Linux arm64 host (the Wasmtime pin is x86_64 only).
- Export packaging into `pixel-tactics-linux-x86_64.zip`, including a `.desktop` entry and
  executable bits, is the next step for issue 16.
