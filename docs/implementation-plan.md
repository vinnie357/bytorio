# Bytorio implementation plan

This document retains milestone planning and implementation evidence, including
historical status statements. Use the [architecture overview](architecture.md)
and [decision records](adr/README.md) for current architectural choices, and the
area specifications for current contracts and supported capabilities.

Standalone authoring and SDK/player distribution follow the
[authoring specification](internal/standalone-authoring-spec.md) and its
[implementation plan](internal/standalone-authoring-plan.md).

Status: updated 2026-10-19. **Luau is the default cartridge language; Odin cartridges are also supported.** The runtime remains Odin. [SDK 0.2.0](../sdk/README.md) publishes the shared [resource profile](resource-profile.md), retaining the [ABI 1 adapter](cartridge-spec.md). The C++ reference player is retired; C++ remains only for Luau support. Larger indexed ROMs and 3D remain later work.

Keep the standalone native requirement, browser target, single display with 640×360 and 320×180 modes, mostly 2D scope, approximate 128/512 MB package goals, and complete PNG cartridges. The [DS/3DS comparison](target-comparison.md) is advisory; the language change does not expand fidelity scope. The product is Bytorio, its website is https://bytor.io, and its developer CLI is `byt`. Product metadata lives in `package.json`; protocol and SDK names remain compatible.

## Current evidence

Both players offer a default 60 FPS render cap, a custom cap, uncapped rendering,
and native display-refresh pacing. These are three policies: default/custom use
the same capped policy. Simulation remains fixed at 60 Hz; fractional render-time
interpolation and per-cartridge timing metadata remain future extensions.
See [frame pacing](frame-pacing.md) for host controls and verification limits.

SDK 0.2.0 publishes the resource profile and supports Luau as the
default authoring language alongside Odin. Both SDKs provide lifecycle handling,
drawing, input, timing, deterministic random numbers, typed graphics resources,
PCM playback and synthesis/effects. The shared CLI
creates, checks, builds, packages, runs and watches projects; see [the SDK guide](../sdk/README.md).
Both cartridge languages remain supported, as recorded in the [authoring-language decision](adr/0002-support-luau-and-odin-cartridges.md). The [runtime language decision](adr/0001-use-odin-for-games-and-runtime.md) selects Odin independently.

- The removed Luau/C++ reference established the original sprite, sound, input and replay baseline. Its RPG golden traces remain in tests; current checks run both languages through the Odin player.
- The [Odin probe](../experiments/odin/README.md) compiles scalar game-state logic to Windows native code and an identical import-free Wasm module executed in Node and Chrome. It verifies movement, sound-event counts, and one bounds trap.
- The probe does not render, play sound, allocate game data dynamically, load guests in the native player, meter runaway code, or load PNGs.
- The subsequent reproduction does render and play the shared Odin sample on both hosts. Native Wasmtime fuel and browser Worker watchdog/restart paths pass, as do unsupported-ABI, bad-offset, invalid-command, and trap fixtures. A 120-tick replay matches the reference framebuffer hash. See the Odin development guide for exact scope and remaining gaps.
- CI checks JavaScript quality, both SDKs, the Odin native/browser player, display modes, and both RPG/racing cartridges. Local verification is recorded separately from remote CI execution. The [development guide](development.md) documents current builds.

## Migration approach

Both languages now use the Odin player. Keep runtime implementation in Odin and use third-party C interfaces for SDL and Wasmtime. The C++ Luau compiler/VM compiles to the shared Wasm executor; its analyzer is a development tool. No C++ player or renderer is maintained.

Proposed boundaries, created only when needed:

```text
runtime/core/          Shared Odin timing, resources, and console behavior
runtime/guest/         Wasm validation, guest ABI, native engine adapter
runtime/graphics/      Odin drawing commands and platform backends
runtime/audio/         Odin sample/mixer behavior and platform output
runtime/cartridge/     Indexed ROM and PNG wrapper readers
runtime/platform/      Native SDL and browser service adapters
sdk/                   Odin API packages, compiler/build orchestration
examples/              Reference game and Odin successor
experiments/odin/      Existing isolated compiler probe
tests/                 Contracts, integration, and conformance
```

These are proposed module boundaries; implemented runtime packages currently live under `runtime/odin/`. C++ source lives only in `experiments/luau-executor/`, alongside its Luau-specific CMake target.

## Milestone 0: define the guest contract and measurement baseline

The prototype ABI and native embedding proof now exist. Selecting minimum devices and a representative performance baseline remains open.

- Define the smallest versioned Wasm ABI: initialization, fixed update, draw submission, input snapshot, one sound request, diagnostics, and state inspection.
- Use fixed-width scalar values and validated offset/length buffers; do not expose Odin context, strings, slices, or native pointers across the ABI.
- Establish context and allocator conventions at every exported Odin entry point.
- Select a native Wasm engine through a small Odin C-interface probe. Wasmtime is a candidate; measure footprint, startup, memory controls, interruption, and deployment dependencies before selecting it.
- Select the minimum native/browser environments and provisional frame, startup, memory, recovery, and iteration targets.

Exit: a documented ABI draft, pinned compiler/dependency revisions, named measurement environments, and a small native engine embedding proof. The prior scalar probe alone does not satisfy this milestone.

## Milestone 1: Odin native and browser player with one sprite and sound

Implemented and checked locally on Windows/Chrome. The identical game module, shared Odin drawing/sample code, input, audio, reference replay, and controlled-failure paths pass. Physical controller/touch devices and clean-machine distribution still require validation.

- Implement an Odin native executable with SDL window/input/presentation/audio integration and embedded guest execution.
- Compile an Odin game to freestanding Wasm. Load the exact same bytes in the native engine and browser Wasm engine.
- Compile the shared Odin runtime for browser execution. Supply only the necessary JavaScript bridge to drawing, input, audio, loading, and storage.
- Run browser game code in a Worker, with bounded command messages and an external watchdog. Keep presentation responsive during runaway code; do not silently require shared memory or cross-origin isolation.
- Recreate the existing example's sprite, movement, bobbing, pointer interaction, action edge, and sound using the shared Odin console behavior.
- Preserve both logical display modes, fixed ticks, bounded catch-up, gesture-unlocked browser audio, pause/resume, and controlled errors.

Exit: a standalone Odin native player and browser player run one identical game module with real graphics/audio. Scripted positions, sound requests, and rendered output match the reference where specified. Native users need no compiler, Node.js, or webview.

## Milestone 2: memory, failures, and developer workflow

- Prove persistent game and per-frame arenas with allocation tracking, exhaustion behavior, and stale-resource diagnostics.
- Validate imports/exports, feature subset, guest memory maximums, command bounds, integer overflow, and resource handles.
- Test traps, stack exhaustion, excessive growth, malformed modules, invalid host requests, and infinite loops on both targets. Native interruption and browser Worker termination must recover cleanly.
- Provide ordinary Odin SDK packages, OLS completion/navigation, compiler diagnostics, and runtime failures mapped to source locations.
- Implement save, compile, validate, restart; retain the last working game on compilation failure. Measure ten warm iterations and three first-run/cold scenarios rather than extrapolating the scalar probe.
- Start with restart-on-change. State-preserving reload requires explicit serialization/version migration.

Exit: useful diagnostics and bounded recovery on both players, measured edit-to-first-frame latency, explicit memory accounting, and no dependence on an unrestricted native game plugin.

## Milestone 3: automate parity and retire the reference implementation

- Add Odin native and browser builds to CI alongside focused contract checks.
- Verify clean-checkout builds and standalone distributions, including required native libraries and license notices.
- Replay the sprite/sound scenario, inspect actual captures, test browser audio through a UI-thread stall, and exercise suspend/resume and focus changes.
- Validate controller/touch support on physical devices and report platform coverage honestly.
- Completed: retire the C++ reference player, its tests, and build dependencies. Preserve replay goldens and keep C++ only for the supported Luau executor and analyzer.
- Keep Node/Playwright development utilities where useful; they are not player runtime requirements.

Exit: the supported Odin build replaces the reference player and its documented commands. A compile-only proof or headless state test is insufficient.

## Milestone 4: typed graphics and audio resources

Design: [resource interface](resource-av-spec.md), published SDK 0.2.0 /
ABI 2 / `resource-av-1`. Status: **4a–4e implemented on the reference hosts**.
SDK 0.1.0 remains supported through the ABI 1 adapter.
[Profile bounds](../sdk/profiles/resource-av-1.json) are frozen portable quotas;
minimum hardware and physical device latency remain unqualified. Earlier stages
below record the slices that preceded publication; 4e defines the supported release.

### 4a. Resource ownership, transport and both SDKs

Implemented: [experimental resource transport and SDKs](../sdk/resources.md),
with texture/PCM lifecycles, shared transactional registry, typed staging,
session/generation validation, control commits on every update and four-way
native/browser verification. Version 1 remains supported; internal version 2 adds
the graphics draw stream and readback mailbox; version 3 adds the 4c audio
status/completion block. Full negotiated configuration and input records remain
later work before profile publication in 4e.

- Generate one schema for capability/configuration/input records, packet headers,
  opcodes, typed descriptors, acknowledgements and completion messages. Freeze
  their exact layouts only after a small native/browser vertical slice passes.
- Implement session/generation-checked handles, a bounded Odin resource registry,
  staging snapshots, ordered commit validation and resource accounting. Define
  identical portable charges for host copies, pending versions and retired data.
- Implement typed Luau buffers/opaque handles and Odin slices/distinct handles.
  Validate create/upload/use/destroy and errors through each public interface.
- Consume a control commit after init and every update, independently of draws.
  Preserve import-free guests and the ABI 1 compatibility adapter. Keep the new
  profile out of advertised capabilities and PNG readers until its gates pass.

Exit: one mutable texture and one PCM resource follow the same lifecycle on both
hosts through each SDK. Malformed packets, overflow, stale/cross-session handles,
wrong types, failed commits, generation wrap and budget exhaustion have focused
tests. Guest buffer reuse after upload does not change accepted data. No device
work retains guest pointers or calls game code re-entrantly.

### 4b. Explicit graphics passes and low-level composition

Implemented: [both graphics SDKs and the software reference](../sdk/graphics.md),
including typed targets/palettes/tables/pipelines, masks and stencil, affine quads,
ordered passes, screen resolution, readback and sprite/text conveniences in passes.
`npm run test:graphics` compares complete native/browser frames from both SDKs,
checks independent reference pixels, rollback and completion bounds, and records
the full-frame upload workload. See [measurement method](internal/measurements/graphics-measurements.md).
The accelerated adapter remains deferred; full-profile publication still waits
for 4c-4e rather than inferring support from these experimental SDK calls.

- Extend the Odin software reference with mutable index8/premultiplied-RGBA8
  images, palettes, immutable pipelines, clips and affine transforms. Define and
  test byte rounding, sampling and edge coverage before any accelerated adapter.
- Add offscreen targets, independent stencil attachments, masks, source-over/add
  blending, destination-index color tables and per-row palette/source offsets.
- Implement ordered pass controls, target hazard checks, explicit presentation
  and asynchronous readback tickets with bounded completion delivery. Add
  matching SDK examples and diagnostics.
- Integrate existing sprite/text conveniences over the new command protocol and
  retain old-profile golden replays. Defer GPU acceleration until it can satisfy
  the same reference fixtures and context-loss behavior.

Exit: matching Luau/Odin scenes demonstrate procedural pixel upload, palette
animation, compositing, stencil shadows, offscreen passes and row effects on
native/browser. Tests cover clipping, feedback rejection, format mismatches,
readback versions and display switches. Measure a full 640×360 RGBA upload at
60 Hz; record copy volume, CPU time and memory rather than assuming it is cheap.

### 4c. Shared PCM mixer and real-time delivery

Implemented experimentally: [both PCM SDKs](../sdk/audio.md), shared Odin DSP,
SDL callback delivery and an independent AudioWorklet with bounded recyclable
transfers. `mise run test:audio` compares both SDKs/native/browser at three device
rates, independent PCM references, malformed packets, queue pressure, completion
delivery, 500 ms stalls, pause/resume and player PNG reload. A muted WASAPI probe
also verified a physical output device. See [measurements](internal/measurements/audio-measurements.md).
Audible listening, acoustic latency and minimum-device guarantees remain open;
the 50 ms lead remains provisional. Publication/negotiation stays in 4e.

- Implement the Odin 48 kHz stereo mixer with 16 explicit voice slots, source-rate
  PCM playback/loops, gain/pan ramps and typed bus routing. Use the same DSP on
  native and browser, with no dependence on game execution in the audio callback.
- Implement absolute logical-frame scheduling, a reported scheduling lead,
  ordered events, bounded PCM streams, late-event/underrun counters and completion
  mailboxes. Specify queue ownership, backpressure and off-thread reclamation.
- Prove SDL delivery and AudioWorklet delivery with preallocated bounded queues
  and recyclable transfers. Test the baseline without shared memory or additional
  isolation headers; explicitly revise the proposal if that delivery path fails.
- Verify gesture unlock, game/main-thread stalls, pause/resume, audio epochs and
  reload. No callback allocation, file access, compilation or waiting on gameplay.

Exit: both SDKs schedule the same note/sample event traces. Capture native/browser
PCM and compare measured tolerances; device latency is reported separately.
Sustained audio survives a 500 ms game/main-thread stall with queued/active sound,
and empty streams emit defined silence. Test resource and queue pressure, one
and multiple device block sizes/rates, and a physical output device. Measure the
initial 50 ms lead target before accepting it as a shipping requirement.

### 4d. Mutable synthesis and effects

Implemented experimentally: [both synthesis SDKs](../sdk/synthesis.md), typed
acyclic instrument/effects graphs, per-voice state, scheduled partial source
edits, audio-rate modulation, ADSR/LFO, seeded noise, filters, delay and bus
chains. `mise run test:synthesis` builds the matching interactive tone cartridges
and full 320-node workload for native/browser capture, timing and memory checks.
Independent source/envelope/effect references and malformed-packet rollback
checks complement cross-host PCM comparisons. See [verification](internal/measurements/synthesis-measurements.md).
Minimum-device budgets and public profile publication remain 4e gates.

- Add partial sample/wavetable writes, independent voice state and live parameter
  ramps with exact logical-frame application. Preserve old versions already used
  by accepted submissions; all retained versions count against budgets.
- Implement and validate typed source/control/DSP graphs: wavetable, seeded noise,
  mix, ADSR, LFO, filter, bounded delay, pan and output. Bound graph topology,
  coefficient domains, DSP node count, state memory and scheduled-event horizon.
  Include typed audio-rate oscillator modulation and gain inputs in the shared
  per-sample graph evaluation and reference fixtures.
- Prepare resource changes and state off the real-time thread. Add a small tone
  editor/test cartridge in both languages using our interface and asset schema.

Exit: reference tests cover phase continuity, envelopes, modulation, filters,
delay, replacement/release, simultaneous events and invalid/cyclic graphs. Stress
the full permitted voice/node workload, including live writes, on both hosts.
Record real-time CPU budget, copy overhead, peak memory, saturation behavior and
underruns before freezing the provisional limits.

### 4e. Conformance, packaging and profile publication

Implemented: [published SDK 0.2.0 / ABI 2 resource profile](resource-profile.md),
generated public protocol schema, exact pre-init tuple/feature negotiation,
profile-2 PNG packaging, both SDK capability queries and portable distribution
manifests. `mise run test:profile` exercises both languages and hosts using
loose/PNG graphics and synthesis cartridges, metadata rejection and session
recovery, and retains cold/warm startup and memory observations. Existing
conformance and ABI 1 RPG/racing suites remain in the same CI gate.

Publication freezes portable bounds and supported reference platforms. Minimum
hardware and physical latency are unqualified; the profile makes no universal
frame/audio timing guarantee. Input retains the existing fixed arguments plus
the completion mailbox, and the first profile requires all features rather than
introducing optional feature/minimum-limit negotiation. Context-loss recovery
uses session termination/restart; tests inject the event, not a physical GPU loss.

- Publish the generated schema, SDK signatures, examples and measured limits only
  after the preceding gates pass. Add explicit profile/ABI negotiation to native
  and browser loaders; enable profile-2 PNG packaging without changing the
  existing version-1 container header or pretending it supports large ROMs.
- Exercise the same corpus through Luau/Odin, native/browser, loose development
  payloads and PNGs. Re-run ABI 1 RPG/racing goldens. Test reload/termination,
  unsupported features, failed device allocations and graphics-context loss.
- Keep all four runtime/language combinations in CI. Add focused benchmarks for
  upload bandwidth, rendering, voice/graph load, cold/warm startup, packet staging,
  resource copies and peak memory. Select minimum target devices before claiming
  universal frame/audio guarantees.

Exit: a supported resource profile with equivalent controls, documented error
and timing semantics, predictable budgets, complete SDK examples and standalone
distributions. Design documents and provisional JSON alone do not meet this exit.

### 4f. Compact 3D after the resource interface

Implemented experimentally: [shared compact 3D](compact-3d.md), indexed colored
meshes, six-plane clipping, depth attachments, explicit orthographic/perspective
cameras, flat lighting/fog and 3D/2D composition. The separate SDK 0.3.0 profile
also prototypes typed voxel grids with cached visible-face meshes, bulk region
edits and frame-resource animation. `mise run test:3d` verifies and benchmarks
both SDKs through the standalone native player and browser Worker at both display
modes. Chunked/merged voxel resources and voxel-texture mapping remain future
work; [measurements](internal/measurements/compact-3d-measurements.md) determine the next optimization.

The separate textured and alpha previews now support a bounded
[static glTF/GLB import path](model-import.md). It emits both SDK modules with
named rigid parts, shared mesh instances, validated material conversion and size
reports. Artists can replace hand-authored vertex tables; large binary model
streaming, skeletal animation, smooth normals and PBR remain outside this slice.

Add indexed meshes, depth testing, cameras, vertex colors, simple lighting/fog
and 3D-to-2D composition using these target/resource lifetimes. Keep custom shaders,
advanced shadows, full physics and complex animation deferred until game needs
and minimum-device measurements justify them. Compressed music decoding and large
asset streaming depend on milestone 5, not on the presence of a PCM stream handle.

The [voxel resource assessment](voxel-3d-assessment.md) records the original design
and its prototype gate. Chunk-local rebuilding, merged surfaces and additional
engine features remain proposals; use the measured workloads before accepting
further scope, published limits or performance guarantees.

### 4g. GPU execution and configurable presentation

The first execution slice is implemented experimentally in the
[compact 3D graphics path](compact-3d.md): shared validated/charged triangle
staging, transactional OpenGL/WebGL rasterization, CPU/GPU/auto selection,
bounded SSAA, orthographic camera snapping and layered smooth presentation with
opaque HUD coverage. Native uses Odin/OpenGL without a webview; browser rendering
runs in its Worker. Both SDKs retain the same cartridge resource API.

Keep CPU as the deterministic reference and GPU hardware checks opt-in.
The streamed mode transforms/lights triangles on CPU. The separately opt-in
resident mode caches versioned geometry and moves render transforms/lighting
onto the GPU, retaining exact CPU work accounting. Both GPU modes present on the
GPU and synchronize attachments at actual CPU consumers. Qualify actual costs separately from the
independent riverside renderer; do not extrapolate that renderer's timings.

Next slices:

- Implemented: bounded versioned mesh/voxel caches with exact palette snapshots,
  GPU transforms/lighting, final GPU presentation, and live performance counters.
  Retain opt-in selection and qualify both SDKs on native/browser before claims.
- Implemented: optional CPU supersampling, orthographic snapping and smooth pan;
  default CPU rendering allocates no supersample buffers. Riverside uses
  independent walking/pan/orbit controls in both SDKs, verified across hosts.
- Implemented: retain private color/depth samples across compatible batches and
  load passes, including material/camera/clip changes. CPU consumers, clears,
  attachment switches and software fallback synchronize them.
  Retain rollback, stale handles, target feedback checks and CPU reference mode.
- Implemented: publish committed GPU attachments directly to final presentation,
  avoiding world readback/re-upload until a CPU consumer needs the logical
  snapshot. Versioned double buffering preserves rollback; opaque HUD layers
  compose on GPU, with conservative barriers for other ordering/blending.
  Qualify both SDKs on native/browser; keep acceleration opt-in and retain CPU
  conformance, explicit diagnostics and device-failure reporting.
- Experimental riverside comparison: opt-in whole-scene object-local surface
  samples on native/browser GPU hosts. Flat rectangular patches reuse resident
  geometry, expand fixed sample identities in the shared vertex shader, and retain
  SSAA, snapped projection and smooth pan. Keep triangle modes and CPU defaults;
  qualify silhouettes, coverage and cost before considering a general SDK API.
- Expand layered presentation beyond the initial single orthographic screen
  batch, including translucent HUD composition and explicit pass/camera hints.
- The representative riverside field is now packaged through both SDKs;
  [console qualification](../experiments/voxel-resolution/docs/riverside-console-measurements.md) measures update,
  rendering and presentation on native and browser. Use those results to gate
  60 fps claims, GPU residency and later integrated/mobile qualification.
- Add a native settings menu/persistence after the runtime options and capability
  reporting are stable. Current native configuration uses launch flags; browser
  controls already persist preferences and restart the game to apply them.

The perspective racer now integrates original imported kart LODs and scenery,
textured road surfaces, cutout decorations, translucent ground shadows and bounded
smoke/boost effects in both SDKs. The [effects contract](3d-effects.md) defines
experimental SDK 0.6.0 and protocol 8; CPU stays the default. The
[racing guide](../examples/kart3d/docs/kart-racing.md) records controls, authoring and verification.
Distance LOD and manual detail are independent of the renderer. Broader device
qualification, advanced racing physics and full indexed asset delivery remain
separate work.

## Milestone 5: indexed ROMs, full PNG cartridges, loading, and saves

Implemented subset: [PNG container v1](png-cartridges.md), SDK `pack`, default or
custom covers, native/browser loading in both languages, and malformed-input
conformance. Current games embed all assets with their code; the preview PNG
limit is 2 MiB. The indexed 128/512 MB profile, streaming and saves below remain
future work.

- Package the game module, assets, profile requirements, and optional source/debug data under a versioned manifest.
- Implement native indexed ROM reads, browser chunk delivery, startup sets, prefetch/readiness, cache bounds, cancellation, and corruption handling.
- Implement valid PNG covers plus private ancillary directory/payload chunks carrying the complete ROM. Preserve exact game-module bytes and save identity across wrapper conversions.
- Support native open/drop and browser file-picker/drop without requiring the SDK. Read local payload ranges without full cover decode or ROM extraction.
- Add isolated, failure-aware native/browser saves and explicit byte/memory ceilings.
- Provide `byt pack`, PNG packing, and native/web exports.

Exit: small and near-512 MB synthetic payloads round-trip with bounded memory. Test malformed PNG/index data, oversized decoded resources, stripped payloads, storage failures, unsupported profiles, and slow/offline delivery. The original-file sharing workflow is documented; image re-encoding is not guaranteed to preserve ROM data.

## Milestone 6: second game and machine profile v0.1

- Complete one playable reference game and a second game with a different 2D workload.
- Use them to refine the SDK and freeze the ABI, cartridge schema, resource limits, and compatibility policy.
- Publish reproducible native/browser conformance, performance, and export checks.
- Revisit richer 3D only with evidence from actual games.

Exit: both games use the same documented Odin SDK and portable guest contract without game-specific host escape hatches.

## Validation and remaining uncertainty

Use focused checks for guest validation, ABI decoding, input/timing, allocation/resource accounting, save identity, mixer output, and parser boundaries. Keep graphics/audio integration checks separate from scalar/headless tests. Fuzz cartridge and guest-command parsers when implemented. Record exact compiler/engine versions and observed results without machine-specific paths.

The embedded Wasm engine, Odin browser host, shared rendering/sample path, and basic Worker recovery are now proven together for this reproduction. Allocation-heavy guest support, source-level debugging, realistic edit-loop timing, broader feature policy, physical input devices, and minimum-device performance remain unproven. These are implementation gates for the chosen language direction, not reasons to treat the whole machine profile as complete.
