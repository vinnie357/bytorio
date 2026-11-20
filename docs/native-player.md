# Native player

From a game directory on Windows x64 or Apple Silicon:

```sh
byt run --target native
byt run --target native -- --fps native
byt build --target native
```

`run` builds once and launches the matching SDK player. `build` creates a
standalone `build/native/` directory; share the entire directory, including its
libraries, cartridge and licenses. Run its `player.exe` on Windows or `player`
on Mac. The export targets the authoring host. F11 toggles fullscreen.

A native-only build keeps an existing web export unchanged. Refresh both with
`byt build --target all`. A kept export retains its own earlier cartridge and
player; it does not receive subsequent edits until rebuilt.

## Forward options and resolve paths

Put CLI options before `--` and native player options after it:

```sh
byt run --target native --offline -- --fps 144
byt run --target native -- --smoke --capture ../../capture.bmp
```

The CLI launches the player with **`build/native/` as its working directory**.
Every relative path after `--` is relative to that directory, including replay
inputs, captures and a replacement cartridge. For example, `../../capture.bmp`
writes to the project root; `../../inputs.txt` reads a file in the project root.
An absolute path works too; quote paths containing spaces. This differs from
CLI options such as `byt pack --output`, which use the terminal's working
directory. Running an exported executable directly uses that terminal's working
directory for explicit path arguments; its default game is beside the executable.

## Player options

These options apply to both Luau and Odin games. Defaults are a 60 FPS cap,
CPU rendering and SSAA off.

| Option | Purpose |
| --- | --- |
| `--fps 1..240`, `--fps native`, `--fps uncapped` | Presentation cadence; simulation stays at 60 Hz. See [frame pacing](frame-pacing.md). |
| `--renderer cpu\|gpu\|auto` | Rendering backend. GPU availability depends on the host. |
| `--ssaa off\|2x\|1080p` | GPU supersampling; select GPU rendering for supersampling. |
| `--pixel-snap`, `--smooth-pan` | GPU presentation settings; smooth pan also enables pixel snapping. |
| `--gpu-meshes`, `--surface-samples` | Opt-in GPU residency paths. See [graphics](../sdk/graphics.md). |
| `--game path` | Open a different PNG cartridge, or a development Wasm module. |
| `--source path` | Run development Luau source instead of the packaged game code. |
| `--executor path` | Override the Luau executor module; normally use the SDK's matching module. |
| `--smoke`, `--check` | Validate 120 updates and exit. Smoke opens the host's window/audio; check skips them. |
| `--replay path` | Execute a deterministic input file and exit. |
| `--capture path` | Write a BMP when a windowed run ends, including `--smoke`; does not apply to `--check` or replay. |
| `--capture-rgba path` | Write the final replay's raw RGBA pixels; requires `--replay`. |
| `--benchmark path` | Benchmark a deterministic input file and exit. |
| `--benchmark-warmup 0..10000` | Warmup updates; must be less than the number of benchmark input records. |
| `--benchmark-unmetered` | Development benchmark only; disables execution metering. |
| `--executor-cache path`, `--no-executor-cache` | Override native executor-cache configuration, or disable it. |

Replay, capture and benchmark flags are diagnostics, not required to play a
game. A replay file contains whitespace-separated input records, one per 60 Hz
update: a decimal button mask, or `v2:mask:leftHeld:x:y` for logical pointer
coordinates (`leftHeld` is 0 or 1). For example, `0 0 0` advances three updates
with no buttons. Replay prints one JSON object per update containing framebuffer
`hash` and `sounds`. A benchmark accepts 1–10000 decimal masks and reports timing
over repeated passes; its input format does not include pointer records.
Prefer the packaged cartridge and SDK defaults for distribution.
