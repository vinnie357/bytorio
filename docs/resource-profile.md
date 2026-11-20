# Capability profiles: contributor reference

This low-level reference covers compatibility negotiation and conformance for
console and SDK contributors. Game authors can choose supported features from
the [SDK overview](../sdk/README.md); a profile's limits are not a hardware speed rating.

`resource-av-1` is the published SDK 0.2.0 / ABI 2 profile for both authoring
languages and both players. The machine-readable contract is
[resource-av-1.json](../sdk/profiles/resource-av-1.json); exact packet headers,
opcodes, descriptors, graph nodes, parameters, completions and limits are in
[resource-protocol.json](../sdk/resource-protocol.json). Generated Odin, Luau,
C++ and JavaScript constants are checked with `mise run generate:check`.

## Compatibility

The [profile decision](adr/0006-negotiate-explicit-portable-profiles.md) records
why capability negotiation is explicit. The table below covers the base profiles
and first 3D preview; the machine-readable [contract](../sdk/contract.json) and
individual feature guides define the complete set of supported preview tuples.

| Profile | PNG identifier | SDK word | ABI | Resource protocol | Required feature mask |
| --- | --- | --- | --- | --- | --- |
| `2d-preview-1` | 1 | 256 (0.1.0) | 1 | Legacy / optional experimental transport | 0 |
| `resource-av-1` | 2 | 512 (0.2.0) | 2 | 4 | 7 |
| `compact-3d-preview-1` (experimental) | 3 | 768 (0.3.0) | 2 | 5 | 15 |

The [3D preview](compact-3d.md) is a separate opt-in profile. The shared schema
also describes its experimental additions; `stableVersion` remains 4.

Bits 1, 2 and 4 identify typed ownership, software graphics, and scheduled
audio/synthesis. All are mandatory. This version has no optional extensions:
the full profile has fixed portable limits. The players validate the exported
`game_profile`, `game_abi`, `game_sdk_version`, `game_resource_protocol` and
`game_required_features` before `game_init`, then configure a fresh resource
session. Profile-2 games require the resource exports listed in the live
[contract](../sdk/contract.json). PNG metadata must match the executable tuple.
Unknown profiles, tuples, protocols and feature masks fail before game callbacks.
ABI 2 retains the existing 40-byte convenience frame and 32-byte sprite/text
commands; that frame's record version remains 1. Resource packets independently
carry ABI 2 and protocol 4. The public profile changes the negotiated contract,
not the layout of the legacy drawing records.
Both loaders also validate the exported function signatures against the generated
contract. The conformance corpus redirects real Wasm query exports to produce
wrong requirements and incompatible function types through both execution engines.

The shared Luau executor determines the profile from a leading
`--!console-profile=2` line in the bundled source. Source without the declaration
uses the ABI 1 adapter. Unknown declarations fail loading. The Odin SDK defaults
to ABI 1 for existing direct builds; SDK 0.2 projects pass
`-define:CONSOLE_PROFILE=2`. Neither language is automatically upgraded at load.

Both SDKs expose `byt.capabilities()`: `profile`, `abi`, `sdk`, `features`,
`protocol`, `resource_bytes`, `slots`, `payload_bytes`, `audio_rate` and
`audio_lead_frames`. Luau returns a frozen table; Odin returns `Capabilities`.
These describe the host-validated fixed profile, not a hardware speed estimate.
Inputs retain the existing update arguments; completions and audio status arrive
through the bounded mailbox before updates. Accepted commits acknowledge their
sequence before any later callback; failures terminate that session.

## Build and launch the examples

From the repository root:

```text
mise run //examples/resources:build
mise run //examples/resources:serve
```

Open `http://127.0.0.1:8088/`, select a cartridge and click **Start game**. Native runs
`examples/resources/build/synthesis-luau/build/native/player.exe`. Replace
`synthesis-luau` with `synthesis-odin`, `graphics-luau` or `graphics-odin`.
The graphics cartridges cover passes, indexed palettes, tables, stencil,
readback and full-frame uploads. The synthesis cartridges expose pitch, filter
and waveform controls. Their checked-in sources live under
`examples/resources/graphics` and `examples/resources/synthesis`.

New CLI projects request SDK 0.2.0 and `profile: "resource-av-1"`. Existing
`sdk: "0.1.0"` manifests remain supported. Declaring a contradictory profile is
an error. `build` and `pack` produce the same self-contained PNG on both hosts.
The PNG container remains version 1 with its 32-byte header and **10 MiB** base
envelope limit; optional [indexed content](indexed-content.md) has a separate
capacity bound. Distributions include `profile.json`,
the public profile and wire schema alongside their player, licenses and modules.
Bundled profile descriptors reference their local schema and omit checkout-only
documentation links; the SDK's canonical profile retains those references.
The PNG header and exported guest requirements remain authoritative at load.
Copy the whole native directory; serve the web directory as static files.

## Verification and supported targets

`mise run test:profile` builds both examples in both languages, compares native
and browser results for loose code and PNGs, rejects metadata mismatches, and
checks failure/reload plus display-context-loss termination and restart.
It also rejects an unavailable native audio driver and injects browser audio
device allocation failure, requiring a visible error and terminated game session.
It retains playable exports, cold/warm browser startup and memory observations
in `build/profile-verification/<run>/`. Each cold series uses a fresh page;
warm PNG replacement retains the same page's executor cache. Native reports
separate uncached and cache-enabled process startup, guest/working-set peaks,
and update/draw/render timings. Executor caching applies to Luau; Odin modules
compile directly in each native process. These are local observations, not statistical
latency claims. A simulated `contextlost` event tests the recovery policy;
it does not prove physical GPU/device-loss recovery.

`mise run test` also runs SDK, PNG malformed-input, registry, graphics, PCM,
synthesis/full-graph, display and ABI 1 RPG/racing regression suites. These
exercise both languages on native and browser hosts in Windows and Apple Silicon
macOS CI. Registry tests
cover invalid/stale handles, atomic rollback, budget/allocation failure and
teardown; audio tests cover bounded queues, stalls, epochs and reload. PNG tests
also remove loose game files to prove that packaged assets are self-contained.

Supported development/runtime references: Windows x64 and macOS Apple Silicon
with SDL3/Wasmtime;
browser reference: Chromium with WebAssembly, Workers, Canvas2D and AudioWorklet,
without shared memory or isolation headers. Native Linux, Intel Mac players and
other browser engines are not certified by this suite. Canvas loss stops the worker and audio;
the user restarts into a new session after restoration. Allocation failure is a
load/commit error, never permission to reduce limits silently.

Portable quotas are frozen; they are not promised frame times. The audio/control
reservation is 55,463,952 bytes inside the 64 MiB resource budget, with an 8 MiB
shared PCM/history arena and a reported 2,400-frame initial audio lead. Physical
speaker latency and minimum hardware remain unqualified. Existing measurements
cover [upload/rendering](internal/measurements/graphics-measurements.md), [PCM delivery](internal/measurements/audio-measurements.md),
and [full synthesis load](internal/measurements/synthesis-measurements.md), including copy volume, staging,
DSP timings and memory. Qualify a target device with these workloads before
claiming 60 Hz or uninterrupted audio under its maximum supported load.

## Publication measurements

Local verification on 2026-10-19 used Windows x64, an Intel Core i7-11700K,
Chromium 156.0.8078.4 and the pinned toolchain. Both demos matched native/browser
frame hashes across loose and PNG loading. Synthesis and PCM samples also passed
the separate three-rate reference suites. The following are single startup
observations from the profile corpus, rounded to milliseconds:

| Cartridge | Native uncached | Native repeat | Browser PNG / new page | Browser PNG / same-page replacement |
| --- | --- | --- | --- | --- |
| Graphics / Luau | 196 ms | 24 ms | 99 ms | 28 ms |
| Graphics / Odin | 18 ms | 17 ms | 37 ms | 15 ms |
| Synthesis / Luau | 179 ms | 20 ms | 83 ms | 53 ms |
| Synthesis / Odin | 16 ms | 17 ms | 26 ms | 19 ms |

Luau's native repeat uses its executor cache; native Odin compiles each process.
Both Luau browser replacement loads reported executor-cache hits. A new page
starts a new application cache. Native startup excludes display/audio device
presentation; browser startup includes local fetch through the first frame,
before the audio-unlock gesture. These columns measure different host paths.

Guest linear memory at startup ranged from 3.19 to 5.06 MiB. The browser's
producer runtime used 17.25 MiB for graphics and 27.25 MiB for synthesis; this
excludes the AudioWorklet instance, JavaScript heap and device/browser overhead.
Native process peak working sets were about 128–137 MiB for uncached Luau
compilation, 20–28 MiB with its cache, and 30–31 MiB for Odin. Resource quota
charges, linear memory and process working sets measure different things.
The retained results include raw native update/draw/render timings and memory
counters; broader upload and DSP-load measurements are linked above. These short
runs establish a reproducible reference, not minimum hardware or latency guarantees.
