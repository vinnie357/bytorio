# Legacy cartridge ABI: contributor specification

This low-level reference preserves the SDK 0.1.0 compatibility contract. It is
not the feature list for new games. See the [SDK overview](../sdk/README.md)
for current authoring features and [PNG cartridges](png-cartridges.md) to share games.

This is the normative **2d-preview-1** profile shared by the Luau and Odin SDKs.
Its machine-readable constants are in [the legacy contract](../sdk/profiles/2d-preview-1.json).
It formalizes the implemented preview console, not the eventual full machine.
The ABI version is **1**; the SDK version is independently **0.1.0**. WIT and
the Wasm Component Model are not used.

The preview supplies two display modes, opaque rectangle/sprite/text rendering,
one immutable sprite/font atlas, five buttons, a pointer, fixed ticks, deterministic
random numbers and one sound cue. This document does not define the newer mesh,
mixer, music, save or indexed-content interfaces; consult their current SDK guides.
Both languages support
the [version-1 PNG cartridge container](png-cartridges.md).
An SDK release is complete for this profile without claiming those features.

## Successor: typed graphics and audio resources

[The resource interface](resource-av-spec.md) defines the published successor
profile, `resource-av-1`: typed runtime resources, mutable pixel/PCM staging,
explicit passes and composition, and a scheduled shared audio mixer/synthesizer.
It uses SDK 0.2.0 / ABI 2 with pre-init negotiation, generation-checked handles,
bounded packets and lifecycle rules for both SDKs. Its fixed budgets are in
[the profile manifest](../sdk/profiles/resource-av-1.json).
The [live contract](../sdk/contract.json) describes the current SDK; the remainder
of this document freezes ABI 1 compatibility. See [profile conformance](resource-profile.md).

## Execution and compatibility

An Odin cartridge is a freestanding core Wasm module. A Luau cartridge is bundled
UTF-8 source run inside the player-provided, sandboxed Wasm executor. Both use the
same exports, shared renderer and input/timing semantics. Native execution uses
Wasmtime in the standalone Odin player; web execution uses a dedicated Worker.
There are no guest OS/WASI capabilities. In addition to `env.sin`, updated players
provide the bounded `env.content_size` and `env.content_read` imports described in
[indexed content](indexed-content.md). The Luau executor imports these functions;
Odin modules import them only when using the content SDK. Arbitrary imports are
rejected, and guest memory limits are unchanged.

Every module defines and exports exactly one unshared, 32-bit memory with an
explicit maximum at or below 8 MiB. Module size is at most 1 MiB. Luau bundled
source is at most 256 KiB; its tracked allocator limit is 4 MiB within guest memory.
These are preview limits, independent of the planned 128/512 MB ROM sizes.

These size limits describe the frozen legacy profile. Current players also
accept modules up to 8 MiB and a 10 MiB base PNG envelope through the same
container and guest ABI, and bundled Luau source up to 8 MiB. Odin guest memory
remains capped at 8 MiB. The current Luau executor has its own 64 MiB memory
ceiling for source and compilation, retaining its 4 MiB VM heap cap. Larger
cartridges require an updated player; see
[PNG cartridges](png-cartridges.md).

SDK version words encode `major << 16 | minor << 8 | patch`; 0.1.0 is 256.
Players require ABI 1. Older cartridges may omit SDK/display/batch extensions and
use the existing 20-byte rectangle format. SDK 0.1.0 cartridges always provide
the exports in the contract and the 32-byte batch format. Changing existing field
layouts or meanings requires a new ABI. New optional features require explicit
negotiation before a cartridge relies on them; silent behavior changes are forbidden.

## Lifecycle and input

1. Instantiate a fresh guest and, for the Luau executor, call `_initialize` once
   and copy source through its source-buffer extension.
2. Call `game_init`. It resets SDK state, tick count, input edges, random seed,
   sound-event count, diagnostics and graphics commands, then runs user `init`.
3. Copy and validate the immutable atlas using `game_assets` and `game_assets_size`.
4. Call `game_draw`, read its frame and command buffers, render and present.
5. Call `game_update(buttons, pointer, x, y)` at fixed 60 Hz, then draw as needed.

User callbacks are `init()`, `update(dt)` and `draw()`, with `dt = 1/60` seconds.
The SDK owns lifecycle exports and command-buffer plumbing. Update increments the
SDK tick before invoking the user callback. Tick 0 is initialization. Draw never
advances time, input edges or random state by itself; game code should keep draw
free of simulation side effects. A player may update multiple times between
presentations and bounds catch-up to five ticks. Pause does not advance game time.
Calling user initialization to restart a round does not reset the SDK clock;
reloading the cartridge through `game_init` does.

Legacy buttons are bits left=1, right=2, up=4, down=8, action=16. Optional
movement, camera pan/rotation and reset bits occupy the additional positions
listed in `sdk/contract.json`. The u32 input record is unchanged. The current
SDK's `all_buttons()` exposes the full known mask while `buttons()` preserves
the original five-bit result. Older SDKs discard the new bits; unknown bits
remain ignored. Current keyboard bindings preserve legacy arrow/WASD aliases
while supplying separate movement and camera controls for games that request
them by name. `button` means held, `pressed` means held now but not on the
previous update, and `released` means previously held but now released. Edges last
for the current tick, including any draws after it. Before the first update all
are false. A pointer snapshot is active plus x/y in active-display coordinates.
Inactive pointers report false,0,0. Platform hosts reject pointer hits outside the
display and map letterboxing before delivery. A display switch takes effect after
draw; input already sampled that tick still belongs to the previous display mode.

`seed(u32)` and `random_u32()` use xorshift32: xor with left-shift 13, xor with
unsigned right-shift 17, xor with left-shift 5, truncating each stage to 32 bits.
Default seed is 1; zero selects 0x6d2b79f5. There is no wall-clock or OS entropy.
Fixed ticks do not guarantee identical floating-point game calculations across
all future platforms; exact replay requires suitable game arithmetic as well.

## Display and frame record

Modes are exactly 640×360 (default) or 320×180. `game_display_mode` returns
`width << 16 | height`; the player queries it after draw and applies it before
rasterization. See [display modes](display-modes.md) for presentation behavior.

`game_draw() -> u32` returns an offset into guest memory for this 40-byte record:

| Offset | Type     | Meaning                                               |
| ------ | -------- | ----------------------------------------------------- |
| 0      | u32      | ABI version, 1                                        |
| 4      | u32      | Clear color                                           |
| 8, 12  | i32, i32 | Legacy built-in sprite position; SDK uses -4096,-4096 |
| 16     | u32      | Tick count, modulo 2³²                                |
| 20     | u32      | Cumulative sound-cue event count, modulo 2³²          |
| 24, 32 | f64, f64 | Optional bounded development position, default 0,0    |

All wire values are little-endian. Colors pack bytes R,G,B,A into a u32
(`0xAABBGGRR`). SDK colors must have alpha 255; `rgb(r,g,b)` constructs them. Transparency
comes from atlas pixels; general alpha blending is not supplied by this profile.
Coordinate fields and development positions must be finite and within ±4096.

## Drawing batch

`game_commands` is a byte offset, `game_command_count` a count of records,
and `game_command_stride` is 32. Text resides in `game_text` with a byte length
from `game_text_size`. Maximums are 16,384 records and 16,384 text bytes per draw.
All buffers remain valid until the next guest lifecycle callback. Hosts copy them
before subsequent guest calls and reacquire memory views after potential growth.
SDK command/text buffers reset before each user draw. Clear color persists.

| Offset       | Type | Field                           |
| ------------ | ---- | ------------------------------- |
| 0            | u32  | kind                            |
| 4, 8, 12, 16 | i32  | x, y, w, h                      |
| 20, 24, 28   | u32  | color, text offset, text length |

Commands execute in submission order, clipped to the active display:

| Kind | Operation             | Fields                                         |
| ---- | --------------------- | ---------------------------------------------- |
| 0    | Rectangle             | x/y, w/h in 0..4096, color                     |
| 1    | Integer-scaled sprite | x/y, w=sprite ID, h=scale in 1..8              |
| 2    | Text                  | x/y, color, offset/length into the text buffer |
| 3    | Sized sprite          | x/y, w/h in 1..128, color=sprite ID            |

Unused fields are zero in SDK output. Positions are signed integers in ±4096.
Fractional Luau drawing coordinates truncate toward zero; display dimensions,
sprite IDs, colors and random seeds must be integral. Rectangles with zero area
or completely outside the active display are no-ops. Invalid dimensions fail.
Sprites use nearest-neighbor sampling and IDs start at **0 in both languages**.
Sized sprites map destination coordinate i to `floor(i*16/destinationSize)`.
An atlas index of 255 is transparent and leaves the destination unchanged.

Text is ASCII 0..127, at most 1024 bytes per command. Glyphs are 5×7 with six-pixel
horizontal advance; newline resets x and advances y by nine. Unsupported non-ASCII
text is an error. Missing glyphs draw blank but still advance. There is no shaping,
Unicode font fallback, wrapping or allocation of temporary textures.

## Immutable graphics packet

The packet length is exactly `80 + spriteCount*256 + 128*7`, at most 66,512 bytes.
The 16-byte header is four u32s: magic 0x31584647 (`GFX1`), sprite count in 1..256,
palette count 16, glyph count 128. Next are 16 opaque u32 colors. Each sprite is
256 row-major palette indices (0..15 or transparent 255), representing 16×16 pixels.
Finally each ASCII character has seven row bytes, each in 0..31; bit 4 is the
leftmost pixel. The SDK asset importer validates all dimensions and indices.
The host validates the uploaded bytes independently. Atlas replacement after
initialization is unsupported; state changes should choose existing sprite IDs.

## Sound and errors

`sound()` requests the existing mono, 48 kHz, one-third-second cue by incrementing
the event count. This is an event notification, not an audio voice or sample API.
Multiple requests between presentations may coalesce into one playback. Browser
audio requires a user gesture. Games must not rely on audible completion timing.

`game_error_length` returns a diagnostic byte length in 0..1024; `game_error` its
offset. Zero means no error. The first SDK error persists until `game_init` and
subsequent SDK callbacks stop. Native and browser players report it and stop the
cartridge. Wasm traps, callback failures, invalid records, invalid graphics and
execution-budget exhaustion also stop execution. SDK validation improves feedback;
hosts must still validate every untrusted offset, count and command independently.

The Luau executor additionally exports source buffer/capacity/size, tracked heap
metrics and its reactor initializer. These are player integration details, not
game-author API. Optional `game_inspect` data is a development-tool convention,
not part of this contract.
