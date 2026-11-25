# Typed resources: resource-av-1

The native player and browser Worker support SDK 0.2.0 / ABI 2,
**resource-av-1**, using transport version 4 for typed ownership, software
graphics and scheduled PCM/synthesized audio. The [published profile](profiles/resource-av-1.json)
and [protocol schema](resource-protocol.json) define its limits and wire layout.
Older players reject its profile-2 PNGs. ABI 1 and internal version-1/2/3 guests
remain supported through the compatibility adapter. See
[negotiation and conformance](../docs/resource-profile.md).

Resources can be created, uploaded, edited and destroyed. [Explicit graphics](graphics.md)
now renders textures and targets with passes, composition and readback.
[PCM audio](audio.md) adds explicit voices, buses, loops, ramps and bounded
streams. Existing sprite, text and sound-cue calls work.
[Synthesis/effects](synthesis.md) add typed graphs, instruments, wavetables,
scheduled source edits and independent voice/bus DSP state.

## SDK operations

Luau uses `byt.data`, `byt.gfx`, and `byt.audio`. Odin imports
`data "sdk:data"`, `gfx "sdk:gfx"`, and `audio "sdk:audio"`.

| Operation | Luau | Odin |
| --- | --- | --- |
| Pixel buffer | `data.pixels("rgba8",w,h)` or `"index8"` | `data.pixels(.RGBA8,w,h)` or `.Index8` |
| PCM buffer | `data.pcm(frames,channels)` | `data.pcm(frames,channels)` |
| Texture | `gfx.texture({format="rgba8",width=w,height=h})` | `gfx.texture({.RGBA8,w,h})` |
| Upload | `gfx.upload(texture,{x=0,y=0,width=w,height=h},pixels,opts)` | `gfx.upload(texture,{0,0,w,h},pixels,opts)` |
| Sample | `audio.sample({frames=n,channels=2,rate=48000},pcm)` | `audio.sample({n,2,48000},pcm)` |
| Edit sample | `audio.write(sample,{first=0,frames=n},pcm)` | `audio.write(sample,{0,n},pcm)` |
| Destroy | `gfx.destroy(texture)`, `audio.destroy(sample)` | Same operations with distinct handle types |

Upload options specify `offset_bytes` and `stride_bytes`; omitted or zero stride is the
pixel buffer's row width. Rectangles use top-left coordinates and positive sizes;
uploads must fit the destination. Buffer format must match texture format. Pixel
bytes are row-major index8, stencil8 attachments or premultiplied RGBA8, in R/G/B/A order. Every RGB
channel must be at most alpha. No texture storage is directly mapped into a game.

PCM is finite interleaved f32, mono or stereo, with a declared source rate from
8,000 to 96,000 Hz. `first` and `frames` address source frames, not bytes or scalar
samples. The buffer's channel count must match the sample. Playback, looping and
resampling use the [4c mixer](audio.md); scheduled live source edits remain 4d. Sample
creation can omit initial PCM in Luau, or use an empty `PCM_Buffer` in Odin;
storage begins at zero and can be filled with chunked writes.

Luau buffer metadata and handle tokens are frozen; mutate `pixels.bytes` with
the buffer library and `pcm.samples` with `buffer.writef32` at zero-based byte
offsets. Exported `byt.Texture`, `Sample`, `PixelBuffer`, and `PCMBuffer`
types support editor checks. Token identity, session and generation are checked
at runtime. Odin exposes `[]u8` pixel bytes and `[]f32` samples; it uses distinct
`gfx.Texture` / `audio.Sample` types. Release game-owned Odin buffers with
`data.free_pixels(&pixels)` / `data.free_pcm(&pcm)` when finished. Luau reclaims
them through GC. Odin callbacks receive the Wasm allocator for ordinary game
allocations; typed buffers retain their originating allocator for release. Guest
allocation remains within the existing memory/heap limits.

Call resource operations inside init/update. Each operation copies supplied data
into bounded SDK staging immediately, so a source buffer can be reused before
the callback returns. Destruction is explicit; handles from a destroyed resource
or previous session fail. Version 2 also retains pipeline/table, row/palette and
target/stencil dependencies; destroy dependants before resources they reference.

For complete, type-checked usage, see the equivalent
[Luau example](../examples/resources/lifecycle/luau/main.luau) and
[Odin example](../examples/resources/lifecycle/odin/main.odin). They upload, mutate and
destroy resources, then reuse a slot with a new generation.

## Internal transport and ownership

[resource-transport.json](resource-protocol.json) defines the subset's
version, limits, formats, field layouts, descriptors and configuration exports.
`mise run generate` generates the Odin, Luau, C++ and browser constants;
`mise run generate:check` detects stale generated files.
Version 2 adds a session-checked readback mailbox before each update. Its 16-byte
header carries magic, count, byte length and session; up to four 32-byte records
describe copied pixel results. At most 1 MiB of result data is delivered per
update. The mailbox reuses the acknowledged packet arena; SDKs consume/copy it
before recording new commands. Current profile negotiation is defined in the
[contributor profile reference](../docs/resource-profile.md). Version 3 inserts a 448-byte audio status/completion block after the
readback records, moving payload data from byte 144 to byte 592. It carries up to
16 voice completions per update. Input still uses the existing arguments.

Version 4 adds synthesis commands and graph descriptors with the same mailbox.

Before init, the player checks `game_resource_protocol()` (1–4) and configures a
nonzero fresh session with `game_resource_configure(session)`. The version fixes
the supported operations and limits; a mismatch is rejected. After init and
**every update**, the host calls `game_commit()` then `game_commit_size()`, copies
the packet, validates it in the shared Odin registry, and acknowledges its exact
sequence with `game_commit_ack(sequence)`. Version 2 does the same after every
draw, using a distinct draw phase without advancing the simulation tick. There
is one sealed packet per guest; the SDK refuses arena reuse before acknowledgement.
Draws cannot repeat control/audio events. Legacy guests without these exports
remain supported. Hosts validate version-2 mailbox exports before init and cache
the negotiated version rather than querying a mutable guest getter each frame.

The wire header is the proposal's 64-byte `AVP1` header with ABI field 2. Init,
update and draw are phases 0, 1 and 2. Updates require successive ticks; all
packets require successive sequences. Draw uses the most recent update's tick.
Commands begin at byte 64 and use 32-byte records. The payload follows the used
commands immediately. Argument/data offsets are relative to the payload; typed
descriptors contain eight little-endian u32 fields. Graphics destroy, bind and end-pass have no arguments or
data. Reserved fields are zero. Unknown opcodes, flags, bad ranges, unsupported
formats and malformed descriptors fail the entire packet with a command index.
Audio operations use opcodes 32–41 and 32-byte descriptors; audio destruction
also requires that descriptor, filled with zeroes. Absolute times use low/high
u32 words. Sample loops use an additional 8-byte source-frame range. The schema
defines opcode-specific layouts; [audio.md](audio.md) defines units and timing.
Synthesis uses public opcodes 42–49, fixed 64-byte typed nodes and a 16-byte graph
header. The separate prepared audio queue translates source creation/destruction
to internal opcodes 50/51; those are rejected in guest resource packets.

The registry simulates metadata and prepares copy-on-write allocations before
publication. Failure retains the previous registry, sequence and bytes; temporary
allocations are freed. Accepted mutations reclaim replaced storage after this
synchronous consumer completes. Later asynchronous consumers will require the
retirement tracking specified in the proposal. No guest pointer is retained.

Limits are 1,024 resource slots, 64 MiB runtime resource quota, 16,384 commands and
1 MiB payload per commit. The quota charges live storage, copied packet bytes
and pending replacement allocations, including old/new versions simultaneously.
Fixed registry/staging capacity and allocator overhead are baseline runtime
memory, not claims about RSS. The host input arena and the SDK arena each reserve
at most 1.5 MiB, while empty commits transfer only 64 bytes. Large transfers must
be chunked. Texture axes are 1..1024; actual buffers still must fit guest limits.

The browser runtime now has an 80 MiB linear-memory ceiling to accommodate the
resource quota plus fixed runtime storage and allocation overhead. **Guest memory
remains capped at 32 MiB and the tracked Luau heap at 8 MiB.** The Luau executor's
initial memory is 4 MiB for its bounded transport arena. Native
and browser use the same registry and charging rules. Faults stop the session;
worker errors explicitly release resources and discard the guest.

## Verification

Run `npm run test:resources` on the supported Windows development host. It builds
both SDK fixtures, runs native registry tests and the standalone player, and
compares 121 resource snapshots per language through native and actual browser
Workers. It tests skipped draws, reload, source-buffer reuse, type/generation/
session failures, generation retirement, atomic rollback, copy-on-write budget
exhaustion, malformed packet regions, overflowing ranges, non-finite PCM and
premultiplied-alpha validation. The native registry tests use allocation tracking.
Reports and full traces are written under the ignored `build/resource-verification/`.
