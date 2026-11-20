# Luau Wasm executor prototype

Question: can Luau and Odin cartridges run through the **same Odin player**, natively and in a browser, without a separate native Luau backend?

**Yes.** The Luau compiler and interpreter compile to a standalone Wasm module implementing the existing cartridge lifecycle and rectangle display-list ABI. The Odin player supplies Luau source to that module. Both cartridge types submit commands to the same Odin renderer and use the same audio/input paths. This executor now supports both SDKs through the shared player; the [SDK specification](../../docs/cartridge-spec.md) defines the implemented preview profile. Historical measurements below predate that specification.

See [measured results](RESULTS.md) and [the numeric snapshot](results.json).

The subsequent [batched drawing extension](BATCHING.md) preserves the original visuals while moving sprite and font expansion into the shared renderer. The original results above are the rectangle-path baseline.

[Updated results](BATCHED-RESULTS.md) cover batching plus [compiled executor caching](CACHING.md), with [a separate numeric snapshot](results-batched.json).

## Reproduce

From the repository root, with the existing Odin, Emscripten, CMake, Node, and Playwright prerequisites installed:

```text
npm run build:unified
npm run bench:unified
```

Set `PLAYER_BROWSER_CHANNEL=chrome` to use installed Chrome instead of Playwright Chromium. Measurements run serially. Avoid running other builds or benchmarks at the same time. `UNIFIED_BENCH_SAMPLES` optionally selects 1–9 fresh processes/workers per variant; the recorded run used five. Current raw timings, memory reports, parity traces, and screenshots go under `build/unified-player/benchmark-batched/`; the original rectangle run used `benchmark/`.

Interactive browser (set `PORT=8081` in the environment first):

```text
npm run serve:unified
```

Open `http://127.0.0.1:8081/comparison.html`. Both choices open the same HTML player, Worker, and Odin runtime module. The Luau choice adds `?game=./rpg.luau`; the player loads its shared `luau-executor.wasm`. Click Start game to enable audio. The existing on-screen controls are included.

Interactive standalone Windows player:

```text
# Odin cartridge
./build/unified-player/native/player.exe

# Luau cartridge, identical player executable
./build/unified-player/native/player.exe --game build/unified-player/native/luau-executor.wasm --source build/unified-player/native/rpg.luau
```

No C++ native player is used by either option. Luau itself remains implemented in C++, compiled to Wasm. The native player uses Wasmtime 49.0.3; the browser uses its own Wasm engine. Modern Wasm exception handling is required by the executor and was verified with the recorded Chrome/Node/Wasmtime versions.

## What was changed

- `executor.cpp`: player-supplied compiler/VM, source upload, lifecycle functions, bounded rectangle commands, Luau diagnostics, and heap counters. Source is compiled with Luau optimization level 2; executor C++ is built with `-O3`.
- `capabilities.cpp`: internal libc stubs deny descriptors and clocks and provide an empty environment. The finished executor has **zero host imports**. It does not link a host WASI implementation or access real host files, clocks, or environment variables. Console effects travel through the validated output buffer.
- The Odin guest adapter optionally initializes a Wasm reactor and copies source into its bounded upload buffer before `game_init`. Errors retain their Luau source messages.
- The browser adapter follows the same loading sequence and accepts the same executable bytes as native.
- Both players expose development benchmark paths. Native unmetered execution is available only with `--benchmark`; normal execution retains interruption controls.

The source upload functions are `game_source_allocate(size)`, `game_source_capacity`, and `game_source_size`. Updated hosts allocate the exact source size, at most 8 MiB, before copying bytes. `game_source_buffer` remains a compatibility path that reserves the full source allowance; hosts fall back to it for older executors. The shared lifecycle remains `game_abi`, `game_frame_size`, `game_init`, `game_update`, and `game_draw`; display lists use `game_commands` and `game_command_count`. `game_error`/`game_error_length` and `game_heap_bytes`/`game_heap_peak` are executor-specific diagnostics.

The executor is stored once with the player, not inside each cartridge. Native caches compiled code on disk; browser caches compiled modules for the player page's lifetime. There is no PNG package loader yet. The small executor-version manifest identifies player code, not cartridge packaging. The Luau console surface covers this RPG's clear, rectangle, atlas, sprite, text, buttons, and sound operations.

## Measurement boundaries

Every report uses the same 134-tick quest route. A separate 76-tick defeat/recovery route also has to match. Hashes and sound-request counts are checked after every tick. The harness verifies both native SDL players with dummy video/audio devices, live browser keyboard/audio on both options, and a controlled Luau error on both hosts. Audio checks establish correct sound data/requests and browser playback, not speaker quality. It also verifies that native and browser load identical executable modules.

Each fresh native process or browser Worker runs two warmup passes followed by five measured passes, giving 3,350 measured quest frames per language/host/metering variant across five instances. Resetting between passes is outside frame timing. Execution order alternates to reduce order bias. This is a single-machine experiment, not a controlled lab result.

Frame CPU work is split into update, guest drawing plus command validation/copy, and shared software rasterization. Framebuffer hashing, presentation, audio delivery, pacing, and Worker messaging are outside those timings. Browser pixel copying is timed separately; it is excluded from the comparable frame-work total. Browser timer precision causes tiny phases to quantize to zero in individual samples; aggregate means are more informative there.

Native startup begins inside the player's run function before reading module/source files and ends after its first rendered framebuffer. It includes a new Wasmtime engine/module compilation, instance creation, game initialization, common runtime initialization, and first draw. It excludes executable/DLL loading. Compile and game-initialization times are reported separately. Browser startup begins inside the Worker before local HTTP fetching and ends with its first framebuffer; Worker creation and message delivery are separately retained as `workerReadyMs`. Browser compilation caches are not forcibly cleared, so these are fresh-worker measurements, not guaranteed cold browser starts. Native and browser startup totals have different boundaries and should be compared **within each host**.

Guest linear-memory size is allocated Wasm addressable memory, not resident RAM or the amount of live game data. The Luau allocator reports its own live/peak VM heap; compiler/libc allocations sit elsewhere in that same linear memory. Odin heap usage is not instrumented and is shown as unavailable. The common browser runtime has its own linear memory, separate from each guest. Native Windows working sets cover the whole headless player process, including Wasmtime and JIT code; they are snapshots after the replay, and peak working sets include compilation. Browser process residency is not measured.

Normal native runs meter Wasm execution: ten million fuel per Odin guest call and 500 million for the Luau executor, to accommodate its compiler/interpreter. These are interruption allowances, not equal language CPU quotas. The additional native unmetered measurements isolate some metering overhead, using trusted fixed inputs. Browser runs have the external Worker watchdog instead of native fuel.

Odin guests have an 8 MiB linear-memory maximum. The Luau executor starts with 4 MiB, grows to at most 64 MiB for its source/compiler/VM storage, and caps its custom Luau VM heap at 4 MiB. Its source allowance is 8 MiB, matching the Odin module-size allowance. Native fuel and browser watchdog budgets remain separate execution bounds.
