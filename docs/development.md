# Console contributor setup

This guide is for building and testing Bytorio itself. To make a game with the
current development version, follow [Getting started](getting-started.md),
which uses the standalone CLI and managed SDK without this contributor toolchain.

The console player and renderer are Odin on native and browser hosts. Luau and
Odin cartridges share that player. The original C++ reference player and its
root CMake build have been removed; historical implementations remain in Git.

## Prerequisites

Use [mise](https://mise.jdx.dev/) 2026.10.8 or newer and the pinned toolchain in
`.mise/toolchain.toml`, included by `mise.toml`. Source authoring targets Windows
x64 and macOS on Apple Silicon. Players need neither a compiler nor Node.js to run.

Mise installs Node.js, Odin (including SDL), the Wasmtime C API, odinfmt from OLS,
StyLua, and the prebuilt Luau analyzer. It also installs CMake, Ninja and
Emscripten 6.0.12. Native builds require the Windows linker prerequisites from
Odin's installation guide. On macOS, install Xcode Command Line Tools with
`xcode-select --install`. The native build compiles pinned SDL3 sources and links
the pinned Wasmtime C API statically. Emscripten builds the C++ Luau compiler/VM and its
adapter into `luau-executor.wasm`; the Odin player runs this same module on both
hosts. The executor uses pinned Luau sources under
`build/luau-executor/_deps/luau-src`; the analyzer matches Luau 0.743.
The upstream Emscripten SDK installer needs Python, which mise supplies; no
project scripts are written in Python or require its packages.

Release production builds the Intel Mac Luau analyzer from the same immutable
source revision as the executor, shared in `experiments/luau-dependency.cmake`.
The upstream Mac analyzer download is ARM-only. `deps:luau:analyzer` builds the
native producer tool; game authors download its signed SDK component and do not
need CMake, Ninja or a C++ compiler.

## Build and run

The standalone authoring CLI is
[available for Windows and Mac](https://github.com/ctxshift/bytorio/releases).
See [Mac installation and usage](getting-started.md#macos-apple-silicon-or-intel)
to use the published binary without a source toolchain.
`mise run build:cli` produces `build/cli/byt.exe` on Windows or `build/cli/byt` on
macOS using pinned Bun and TypeScript.
It creates minimal TOML projects and provides check/build/pack/run/dev with
SDK-managed tools and players. The source CLI retains contributor workflows for
legacy `console.json` projects. See the [standalone specification](internal/standalone-authoring-spec.md)
for SDK distribution and the public runtime/player contracts.

The [short mise setup](getting-started.md#install-with-mise) installs the published
CLI without the contributor toolchain. An optional
[automatic-update recipe](mise-installation.md) covers `latest` and SDK tasks.
`mise run test:cli-install` verifies fresh
installation, pinned cross-platform locks, locked reinstall and offline SDK
scaffolding against published assets. It needs network access and runs separately
from deterministic conformance gates. `BYTORIO_CLI_VERSION` selects an exact
version or `byt-v...` tag; its default is `latest`, including previews.
`BYTORIO_SDK_VERSION` selects the SDK bundle fixture. CI runs this smoke test on
Windows, Apple Silicon and Intel Macs when installation guidance changes and
after publishing each CLI release.

`mise run test:cli-archive-install` additionally exercises mise 2025.12.0 by
default; `BYTORIO_MISE_VERSION` selects another historical version. Before an
archive release is published, it tests newly packaged candidate archives behind
a local metadata fixture. After publication it tests the real short pinned
entry against GitHub. CI covers 2025.12.0 and 2026.7.0 on all three platforms.

From the repository root:

```sh
mise install
mise exec -- npm ci
mise run build:odin
mise exec -- npm run serve
```

Open `http://127.0.0.1:8080/player.html` and click **Play**. Native:
`./build/odin-player/native/player.exe` on Windows or
`./build/odin-player/native/player` on macOS.

The complete CI and tagged-release gates run independently on Windows x64 and
macOS arm64. Intel Mac jobs install only Node, Bun, OLS and StyLua and run
`test:cli`; the pinned Odin release has no Intel Mac compiler asset.
`test:native-platform` additionally checks directory
reuse, no-replace save migration, default save locations, resident-memory
reporting, and a relocated player in a path containing spaces. On macOS it also
checks code signatures and ensures loader commands contain no checkout paths.
Hardware GPU qualification remains a separate opt-in gate.

For a cartridge already on the device, open `player.html?local` and use
**Open cartridge** to select its PNG. This mode waits for file selection without
fetching the default game. The browser still loads the player runtime from the
server. Network cartridge loads display byte progress; continued data delivery
refreshes the loading timeout, while stalled loads and runaway execution remain
bounded.

For new Luau or Odin games, use [the SDK CLI](../sdk/README.md). For matching
native/browser examples in both languages:

```text
npm run build:rpg
npm run serve:rpg
# Open http://127.0.0.1:8083/comparison.html

npm run build:racing
npm run serve:racing
```

See the [RPG guide](../examples/rpg/docs/rpg-comparison.md) and [racing guide](../examples/racing/docs/racing-demo.md) for
controls, standalone launch commands, and cartridge sources. `build:unified`
and `serve:unified` remain aliases for the shared RPG setup.

Playable demos are [nested mise projects](../examples/README.md). Run
`mise run build` and `mise run serve` inside one, or select its `//examples/...` task path
from the root. Each project owns its sources, tooling and local ignored exports.
Root quality gates aggregate their integration coverage with SDK/runtime checks.

The true 3D eight-kart baseline uses `mise run //examples/kart3d:build` and
`mise run //examples/kart3d:serve`. Its [guide](../examples/kart3d/docs/kart-racing.md) covers controls, both SDKs,
CPU-default and opt-in GPU execution, and benchmark limits. `test:kart3d` is
part of the full gate; `test:kart3d:gpu` additionally requires a usable GPU.

## Checks

Choose local validation by behavioral risk, not file extension or whether a
source file changed. For edits very unlikely to affect functionality or
performance, review the diff and run only relevant focused checks. Examples
include release titles and other display copy, comments, documentation and
formatting. A title string inside a publishing script qualifies when release
selection, assets, versions and publication behavior stay unchanged. Check
formatting, syntax or links as applicable; verify changed external metadata and
rebuild/inspect affected website pages when published there.

For meaningful changes to runtime behavior, performance, compatibility, test
expectations, dependencies, build behavior or code generation, finish edits and
run `mise run validate` for the complete quality and conformance gates before
completion. Assess executable examples, generated inputs and documents consumed
by tests or generators by their actual impact. If the impact is unclear, inspect
the consumers and broaden validation to cover the uncertainty.

For focused checks, pass task names, for example
`mise run validate test:validation` or
`mise run validate generate:check test:resources`. Existing `mise run test` and
individual `test:*` tasks remain available with their original coverage. CI keeps
running the complete configured gates on pushes and pull requests, including main.
Low-risk work can finish after focused local checks without waiting for CI unless
requested; report those checks and any pending CI separately.

The runner executes tasks sequentially and stops at the first failure. It prints
one start/result line per task and retains complete output in unique
`build/validation/<run>/` logs. `report.json` is updated after every task with
durations, exit codes, timeout state, Node/platform information, Git revision,
and content fingerprints of tracked and nonignored untracked files. Tool pins
are included through the fingerprinted `.mise/toolchain.toml` and task files.
Logs may contain local diagnostic paths; they remain ignored build artifacts.

A failed launch or a 30-minute task deadline fails validation. A detected source
change marks an otherwise successful run `stale` and returns a nonzero status.
Finish edits before final validation; inspect the changed scope and rerun its
affected gates. Fingerprints are taken at task boundaries, not continuously, and
do not cover ignored files or external configuration. They are provenance, not a
build cache or proof that every byte stayed unchanged during execution. A report
left `running` after interruption is incomplete and must not be treated as passed.
Do not benchmark concurrently with heavy builds or tests.

Hardware GPU checks and riverside interactive controls have separate opt-in
gates: `mise run validate test:gpu test:riverside:controls`. The latter verifies
WASD walking, Q/E orbit, arrow panning, reset, counters and native/browser CPU
quality replays for both SDKs. `mise run validate //experiments/voxel-resolution:benchmark:console` retains the
resident GPU qualification report; see [measurements](../experiments/voxel-resolution/docs/riverside-console-measurements.md).
`mise run validate test:textured3d:gpu` additionally qualifies the experimental
textured mesh/material path across native/browser GPU hosts, both SDKs, display
modes and SSAA/residency settings; ordinary `test:textured3d` remains CPU-capable.
The billboard/cutout preview uses `test:billboards` and the optional hardware gate
`test:billboards:gpu`; see [its contract and comparison bounds](billboards.md).
The effects garden adds `//examples/effects:test` to the CPU gate and
`//examples/effects:test:gpu` for independent blend/depth probes and both SDKs
on native/browser hardware; see [scene-space effects](3d-effects.md).
`test:models` validates static glTF/GLB import, generated examples and both SDKs
on native/browser CPU; `test:models:gpu` additionally checks optional streamed and
resident GPU execution. See [the import subset and authoring workflow](model-import.md).
`//examples/models:benchmark` measures a rotating imported-model proxy through both SDKs
on native/browser GPU, optionally comparing preserved exports. It records raw
phase timings and separate attachment transfer/allocation counters; see
[attachment measurements](../examples/models/docs/gpu-attachment-measurements.md).
`mise run validate //experiments/voxel-resolution:benchmark:startup` measures PNG sizes, player readiness
and the first complete scene through native/browser CPU/GPU paths, including
fresh, reload and same-page executor cache behavior. It retains its observer
build and results under `build/riverside-startup/`.

`mise run validate test:riverside:surface` verifies experimental whole-scene
surface samples through both SDKs and GPU hosts, including independent pixel/depth
expectations, both display sizes, all SSAA settings, camera/actor movement and
reuse of resident geometry. It requires the same hardware support as `test:gpu`.

Each task also retains a `*.commands.jsonl` timing journal for instrumented
synchronous compiler, build and verifier commands. Entries include PID, start
time, arguments, duration and exit status. A parent build command can contain
other recorded commands: do not sum nested durations as independent wall time.
An empty journal means that task did not use the instrumented command helpers.

Browser verifiers also retain `*.browser.jsonl` journals. The report's
`browserSummary` groups calls, durations and failures for browser launch, page
and context creation, navigation, evaluation, waits, screenshots and shutdown.
Each event includes a process/object identity and calling source location. An
evaluation includes everything awaited inside that callback; it is not a pure
rendering measurement. Concurrent operations can overlap, so phase totals are
not necessarily additive wall time. Timings observe the existing calls without
changing their callbacks, timeouts or workloads. Standalone scripts use ordinary
Playwright unless `VALIDATION_BROWSER_TIMINGS` names a writable journal.

Within one `validate` invocation, repeated `tests/3d` and `tests/audio` unit
checks share a successful receipt under that report's `unit-tests/` directory.
The suite, compiler path, flags and source fingerprint must match. A failed
check never creates a receipt. Source edits require another execution, and each
new validation invocation starts a fresh scope. Standalone verifiers always run
the unit checks. Integration replays and their assertions still run for every
selected gate. This removes duplicate executions, not test cases; receipts are
not a persistent test-result cache.

Unit-test packages compile with `-o:none`: the pinned compiler's default
optimization took about 64 seconds for the resource unit package, compared with
0.21 seconds without optimization. The same test body then ran in under a
millisecond, with bounds checks and allocation tracking retained. Production
players, Wasm cartridges, native trace harnesses and benchmarks still use their
existing optimization settings. No assertions, sample counts, workloads or
native/browser combinations are removed.

Mise dependency tasks `deps:trace:resources`, `deps:trace:graphics` and
`deps:trace:audio` reuse compiled, speed-optimized harnesses under
`build/validation-tools/`. Every verifier copies its harness into a fresh run
directory and executes every check. Sources cover the shared Odin packages each
harness imports, its own player package, build helpers and toolchain/task
configuration. Browser assets, SDK-only edits and unrelated test packages do not
invalidate the harnesses. Missing executables also trigger a rebuild.
Test results are never reused across validation invocations.

All-target RPG/racing builds reuse `build:odin`'s optimized native player and
browser runtime/audio modules. They still build their own cartridges and fault
fixtures and stage fresh exports. `build:odin` assembles independently cached
tasks from `.mise/tasks/player.toml`: native, CPU Wasm, GPU Wasm, audio Wasm,
hello cartridge, fault fixtures, and native/browser support files. A missing
output rebuilds its owning task. Browser script edits restage browser support;
shader edits also rebuild the native player, which embeds the shaders.
An aggregate input/output check skips the nested task graph for unchanged builds.
Its inventory must cover every player task; the regression suite checks this.

Tool pins live in `.mise/toolchain.toml` so ordinary command changes in
`mise.toml` do not invalidate compiled players. Update pins in that file.
`test:build-tasks` checks declared inputs against
Odin imports and embedded shaders, then exercises mise invalidation in a temporary
fixture with inexpensive substitute commands. Existing conformance suites still
compile and execute the real players.

Support staging dates its copied outputs when staging completes. Windows copies
otherwise preserve old source timestamps, making fresh copies appear older than
their build recipe and causing repeated staging. Contents and source modification
times are unchanged. `mise run validate test:player-staging` exercises this behavior
with real copies and the mise scheduler, including source/recipe edits, missing
outputs and repeated aggregate invocations after a task-configuration edit. The
same regression is included in `test:build-tasks` during full validation.

Run `mise run bench:build-tasks -- --label comparison` in an idle isolated
checkout to retain cold, warm and representative edit timings. It temporarily
adds comments to source files and restores their original bytes and timestamps.
See [build iteration measurements](internal/measurements/build-iteration-measurements.md) for results,
methodology and limits.

```text
npm run lint
npm run format:check
npm run test:odin
npm run test:sdk
npm run test:cartridge
npm run test:display
npm run test:rpg
npm run test:racing
```

Build the corresponding examples first. Browser checks use Playwright Chromium,
or installed Chrome with `PLAYER_BROWSER_CHANNEL=chrome`. `test:display` needs
the RPG build. `test:rpg` runs the shared-player integration harness with one
sample per variant, checking quest/defeat replays, native/browser parity, audio,
diagnostics, and executor cache behavior. `bench:unified` uses the same harness
with multiple samples for performance measurement. Old C++-specific CTest and
`test:web` commands no longer exist.

## Iteration and cache decisions

Use the smallest existing validation task that exercises the changed behavior.
Let its declared dependencies select builds; run a separate build only when the
task's documented setup requires it. Finish the implementation before the
completion checks selected under [Checks](#checks). After a valid pass, repeat
checks only for new edits, a failure or an invalid report. Preserve test workloads
and production optimization settings.

| Situation | Action |
| --- | --- |
| Ordinary source, shader, browser or fixture edit | Run the affected validation tasks normally. Mise rebuilds the owning artifacts and reuses the rest. |
| Missing cached output | Run its owning task normally; missing declared outputs invalidate it automatically. |
| New local import, embedded file, staged asset, or task input/output | Update the leaf task's `sources`/`outputs` and the `build:odin` aggregate when applicable. Run `mise run validate test:build-tasks` and affected conformance. |
| Tool replaced in place, external tool override, or explicit clean-build comparison | Force the affected artifact task, such as `mise run --force deps:player:web-cpu` or `mise run --force deps:trace:audio`. Force `build:odin` only when all player artifacts need rebuilding. |
| Suspected stale artifact despite a normal build | Retain the failing report and command journal, force the smallest owning task once, and rerun the failing check. If that changes the result, repair the missing dependency declaration and add an invalidation case. |

Keep `build/` artifacts and retained reports between iterations. A blanket clean
discards useful compiled dependencies and diagnosis evidence. Caching applies
only to artifacts across invocations: each run executes every selected unit suite
once and every selected native/browser replay. Read the task log before treating
a long run as a cache miss; a warm suite may spend its time exercising the actual player.

`.gitattributes` checks out text with LF, matching formatters and generators on
Windows as well as other hosts. For an older checkout with CRLF drift, inspect
the affected diff and normalize it before starting final validation. Resolve
generated-file changes before the final run so its source fingerprint stays
stable; a stale report is not a pass.

## Formatting and linting

See [language examples](language-examples.md) for checked resource lifecycle
examples and readability conventions that formatters do not enforce.

`mise run format` applies every formatter. `mise run format:check` checks without
writing. `mise run lint` runs all analyzers. Matching npm aliases remain available;
use `mise exec -- npm run <command>` without shell activation. Language-specific
npm commands include `format:odin`, `format:luau`, `format:cpp`, `lint:odin`,
`lint:luau` and `lint:cpp`. The C++ commands also have dedicated mise tasks:
`mise run format:cpp` and `mise run lint:cpp`.

| Language                    | Formatter                                                                     | Analyzer                                                              |
| --------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| JavaScript and HTML scripts | Prettier                                                                      | ESLint                                                                |
| Odin                        | [odinfmt from OLS](https://github.com/DanielGavin/ols), `odinfmt.json`        | Compiler `odin check -vet`                                            |
| C++                         | [clang-format](https://clang.llvm.org/docs/ClangFormat.html), `.clang-format` | [clang-tidy](https://clang.llvm.org/extra/clang-tidy/), `.clang-tidy` |
| Luau                        | [StyLua](https://github.com/JohnnyMorganz/StyLua), `stylua.toml`              | Official [luau-analyze](https://luau.org/getting-started/), `.luaurc` |

All repository Odin/Luau/C++ sources, examples, tests, templates and tracked generated
code are included. Downloaded dependencies, build outputs and editor SDK mirrors
are excluded. Odin packages are checked for their actual native or Wasm target;
native players also check the shared packages on Windows. Luau SDKs and typed
cartridges retain `--!strict`; the older demos use nonstrict inference. Enabled
Luau lint warnings fail the command through `lintErrors`, including in nonstrict
files.

C++ warnings are errors; clang-tidy checks the bridge translation units and
the project headers they include. It reads CMake's compilation database with the
pinned Emscripten target, sysroot and resource headers. `mise run lint:cpp`
automatically configures those dependencies without building them. Required WASI
symbol names are allowed explicitly, and the supported toolchains use
`#pragma once`. Both LLVM tools are pinned through mise using prebuilt binaries from
[cpp-linter](https://github.com/cpp-linter/clang-tools-static-binaries); no local LLVM
build is needed. `.clang-format` uses four spaces, a 100-column limit and separate
function definitions. Formatter wrappers only invoke the community formatters and
compare their output; a bounded stable-layout check keeps generated files reproducible.

Configure editors to use the same `odinfmt.json` and `stylua.toml`. OLS supplies
Odin formatting; the StyLua extension supplies Luau formatting. C++ formatter
extensions should read the repository's `.clang-format`. `mise exec --
<editor>` gives an editor the pinned executables. No global PATH changes are
required.

The Luau SDK requires the new type solver for `read` table properties. Repository
lint and SDK checks explicitly select `--solver=new`. The checked-in VS Code
settings enable `luau-lsp.fflags.enableNewSolver`, select the standard Luau
platform, and disable automatic upstream flag synchronization and sourcemaps.
New Luau projects receive the same settings. Existing projects should use
`sdk/templates/luau-settings.json` as a reference when merging their own settings.
If the editor still reports `read keyword is illegal here`, run **Luau: Reload
Language Server** after the workspace settings load. Do not remove the `read`
annotations to silence these errors: they protect the SDK's immutable metadata.

Indentation uses spaces in every language. `.editorconfig` specifies four spaces
for Odin, Luau and C++, and two for JavaScript, HTML and configuration files.
Neither Odin nor Luau requires tabs; the optional Odin `-vet-tabs` rule is not
enabled. Formatter checks enforce the same space-based indentation.

## Task layout

Player builds, SDK exports and comparison launchers share
`tools/player-export.mjs` for player dependencies, shaders, notices and optional
Luau executor metadata. Cartridge contents, profiles and launcher customization
remain with their callers. `mise run validate test:player-export` checks export
completeness and missing-input failures; SDK and comparison suites exercise the
assembled players. Add player dependencies to this module and update the
`build:odin` outputs in `mise.toml` so missing cached files trigger a rebuild.

`mise.toml` defines the project commands: `format`, `format:check`, `lint`,
`build:odin`, `//examples/rpg:build`, `//examples/racing:build`, `test`, and each `test:*` suite.
Dependency tasks are declared in `.mise/tasks/deps.toml`:

- `mise run deps:luau:configure` fetches/configures the executor's pinned sources.
- `mise run deps:luau` compiles the shared Wasm executor and depends on configure.

The dependency tasks declare source inputs and output files so mise can skip
unchanged builds. `mise run --force deps:luau` forces a rebuild. The SDK CLI calls
the same tasks rather than maintaining another dependency build cache. Asset
generators and packaging stay in JavaScript and invoke the pinned formatters
before writing generated sources. Rebuilding assets must leave format checks
passing. Project automation contains no shell scripts.

Shared numeric limits and defaults come from `sdk/contract.json` and
`sdk/resource-protocol.json`. Run `mise run generate` after changing
either contract. This updates the Odin, Luau, C++ bridge and browser constants;
`mise run lint` checks that generated files are current. Keep unrelated meanings
separate: a white tint, an integer limit and a checksum mask can have the same
value without being the same constant.

The software renderer's generated sRGB lookup tables use rational samples and
integer fifth roots. This keeps their full-precision source text reproducible
across hosts whose floating-point power functions differ in their last digits.
