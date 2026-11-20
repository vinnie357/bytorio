# Typed resources: contributor specification

This is a low-level compatibility and implementation reference for console and
SDK contributors. Game authors should use the [resource guide](../sdk/resources.md),
[graphics guide](../sdk/graphics.md) and [audio guide](../sdk/audio.md).

Design rationale: [transactional typed resources](adr/0008-publish-resource-changes-transactionally.md).

Status: **published resource profile**, 2026-10-19. SDK 0.2.0,
ABI 2, profile `resource-av-1` (identifier 2). The SDK 0.1.0 / ABI 1 compatibility
contract remains supported. [The profile](../sdk/profiles/resource-av-1.json),
[protocol schema](../sdk/resource-protocol.json) and generated constants define
the public interface, wire layouts and portable bounds. See
[conformance, packaging and performance scope](resource-profile.md).

The [resource implementation](../sdk/resources.md),
[software graphics reference](../sdk/graphics.md), [PCM mixer](../sdk/audio.md)
and [synthesis/effects](../sdk/synthesis.md) support both SDKs and hosts.
Profile requirements are checked before initialization for loose payloads and PNGs.

Sample playback snapshots contents at each accepted play command. Source
writes affect later plays; explicit scheduled edits opt a source into
live storage. Its 8 MiB PCM/history arena is page allocated by the producer; rendering returns
leases through a fixed queue. Streams allow 64 chunks / 8,192 frames each.
Controller/DSP state, wire/transfer arenas and feedback reserve a portable
55,463,952-byte charge on either host, plus ordinary resource storage. This
conservative reservation and 50 ms lead are frozen for this profile; device
latency and minimum hardware remain unqualified. Delivery uses
SDL callbacks and transferable AudioWorklet buffers, with a maximum 2,048-frame
render call; larger native callback requests are split. See the
[measurement method and remaining gates](internal/measurements/audio-measurements.md).

Protocol 4 implements the synthesis slice with fixed typed DAGs and one mutable
source store shared by instrument instances. Explicit `edit_sample` opts PCM
playback into that live store; ordinary snapshot playback otherwise remains
unchanged. Definitions retain sources; per-note and bus history is reserved in
the same 8 MiB arena before publication. Effects topology changes use the current
simulation frame, with future controls/edits scheduled independently. Note pitches
are explicit Hz relative to a 440 Hz definition root. Detailed experimental
signatures and numerical behavior are in the [SDK reference](../sdk/synthesis.md).

The console provides low-level control through typed data, resource handles,
ordered rendering and scheduled audio. Games manipulate their own bytes and
submit explicit operations. The Odin runtime owns resource storage, rendering,
DSP and device delivery. The two SDKs provide the same capabilities and errors.

## 1. Compatibility and negotiation

A cartridge explicitly requests `resource-av-1`; there is no automatic upgrade
of ABI 1 games. The profile identifier is 2, ABI is 2, and SDK version
word is 512. Existing players must reject these requirements before starting a
game. The player keeps an ABI 1 adapter for existing cartridges and golden
replays. Existing `byt.sprite`, `text`, input and lifecycle conveniences remain
available in the new SDK, implemented over the new resource interface.
The legacy sound-cue convenience remains in its compatibility adapter;
new-profile scheduled audio uses explicit voice/source selection, with no
secretly reserved voice slot.

The host checks an exact profile/SDK/ABI/protocol/feature tuple before `game_init`.
This first profile has fixed limits and mandatory feature mask 7; it has no
optional extensions or per-game limit negotiation. SDK `capabilities()` reports
the selected tuple and principal limits. The host supplies a fresh session ID
through `game_resource_configure`; inputs retain the fixed lifecycle arguments,
with bounded completion/audio-status mailboxes before each update. This freezes
the existing input representation instead of introducing a redundant input buffer.
Missing features or exports stop loading. Both hosts enforce the same bounds.

PNG container version 1 accepts profile 1 and profile 2, preserving the existing
32-byte header layout. The current player allows an 8 MiB Wasm module or bundled
Luau source within a
10 MiB cover/code envelope, plus optional indexed content up to 512 MiB. These
storage budgets retain Odin's 8 MiB guest memory limit, the 4 MiB Luau VM heap
cap and the resource profile's execution and decoded-resource allowances. Luau's
executor has a separate 64 MiB memory ceiling for source and compilation.
See [PNG cartridges](png-cartridges.md) for
compatibility with earlier players.

## 2. Ownership, types and lifetime

| Type | Owner | Purpose |
| --- | --- | --- |
| `ByteBuffer`, `PixelBuffer`, `PCMBuffer` | Game / SDK | Mutable typed staging data; ordinary bytes, pixels or audio frames |
| `Texture`, `Target`, `Palette`, `ColorTable`, `RowTable`, `Pipeline` | Runtime | Uploaded images, offscreen surfaces and rendering controls |
| `Sample`, `Wavetable`, `Instrument`, `Bus`, `Stream` | Runtime | Audio storage, bounded DSP definitions, routing and PCM streaming |
| `Voice` | Runtime | One of 16 explicitly selected playback slots |
| `Readback` | Runtime until completion | Ticket for an asynchronous pixel copy |

Luau uses exported opaque handle types and typed buffer wrappers with checked
access. Odin uses distinct handle types and typed slices. Handles are not raw
pointers. The SDK represents a handle with its session and a 32-bit resource ID;
on the wire the packet carries the session and references use the resource ID.
IDs use a 16-bit slot and 16-bit generation, with zero invalid. Types, ownership,
generation and session are checked by the runtime, even for hand-written guests.
Generation wrap retires that slot until the next session. SDKs reject handles
retained across reset; the host discards packets from an old session.

`create` reserves a logical handle immediately and enqueues creation. It does not
perform a host call inside the game callback. Creating, uploading and using that
resource in the same commit is allowed in order. A creation failure is reported
at commit, before the next game callback; the game cannot assume allocation has
physically completed inside `create`. New storage is zero-initialized.

The SDK snapshots supplied bytes into bounded staging storage when an upload or
write is called. Callers may immediately reuse their buffer. At commit the host
copies the packet before further guest calls, validates it, reserves budgets,
and publishes accepted operations. No guest pointer survives submission and no
game obtains an address in renderer or mixer memory.

`destroy(handle)` prevents subsequent commands using that handle. A referenced
resource cannot be destroyed while a live pipeline, instrument, voice, routing
edge, readback or scheduled event still needs it: this is a validation error.
Release dependants explicitly first; a playing voice remains a dependant until
its release tail ends or it is stopped. `destroy` does not imply a stop or cascade.
Accepted submissions retain internal references until rendering/audio completes;
retired storage remains charged until reclamation. Shutdown, trap and watchdog
termination tear down the session and its resources through the host.

## 3. Commands, copies and errors

Initialization and each update produce one **control commit** containing resource
operations and audio events. The host consumes it after that callback, including
every catch-up update even if no frame is drawn. Resource allocation/uploads,
pipeline creation and audio commands are permitted only in init/update. Draw only
records render passes, presentation and readback requests. Skipping a draw cannot
drop audio events or a resource upload; drawing twice cannot replay a note.

Commits are ordered by session, monotonic submission sequence and tick. Replaying
a sequence is rejected. Validation simulates the whole packet's resource state
in command order before publishing anything. Malformed records, stale handles,
wrong formats, exceeded budgets, invalid graphs and invalid numeric values stop
the cartridge with a diagnostic identifying the command and field. SDK checks
improve feedback but are never the host's authority. No silent truncation,
allocation eviction or audio voice stealing is allowed.

Pre-publication validation/allocation failure publishes no operations from that
packet. A device failure after publication stops the session and tears it down;
the runtime does not promise to undo already presented pixels or emitted sound.
Context loss produces an explicit suspended/reload-required state, rather than
silently returning blank targets. Transparent graphics restoration is later work.

An upload is an ordered snapshot. An update after an earlier submission cannot
alter that earlier submission, including buffered audio; implementations may use
versioned storage or copy-on-write. Old versions count against the budget. The
host input mailbox delivers resource completions and status before an update;
it never re-enters the game from a renderer, audio thread or browser promise.

### Published transport

Keep guests import-free. SDK-generated exports provide bounded configuration /
input buffers, accept a host configuration before initialization, and consume an
input mailbox before update. `game_commit()` returns the init/update packet;
`game_draw()` returns a draw packet. The host snapshots and validates each, then
acknowledges its sequence before the SDK reuses staging memory. Only one sealed
packet may be outstanding per guest. Audio delivery queues are host-owned and
independent of this guest acknowledgement. Exact input/configuration layouts,
acknowledgement exports and opcode/argument schemas are a milestone-4a gate.

Packet header, 64 bytes, little-endian:

| Offset | Type | Meaning |
| --- | --- | --- |
| 0 | 4 bytes | `AVP1` magic |
| 4, 8 | u32 each | ABI 2, header size 64 |
| 12 | u32 | Session ID |
| 16 | u64 | Simulation tick |
| 24, 28 | u32 each | Phase (init/update/draw), submission sequence |
| 32 | u32 | Command count |
| 36, 40 | u32 each | Command offset, byte length |
| 44, 48 | u32 each | Payload offset, byte length |
| 52..63 | bytes | Reserved, zero |

Each command has a 32-byte header: opcode u16 at 0, record size u16 at 2,
flags u32 at 4, primary resource ID u32 at 8, argument offset/size u32s at 12/16,
data offset/size u32s at 20/24, and reserved zero u32 at 28. Record size is 32;
descriptor arguments and bulk bytes live in the copied payload region. Unknown
opcodes or flags fail. Range arithmetic uses checked wide integers; descriptor
alignment, exact lengths, overlaps with headers, counts and enum values are
validated. Getters may grow guest memory: snapshot the header and revalidate
views after every guest call. No host addresses or language layouts cross here.

## 4. Graphics interface

### Buffers and images

Formats are `index8` (one byte per pixel), `rgba8` (four bytes, R/G/B/A),
and `stencil8` (one byte, stencil attachments only). `rgba8` stores premultiplied
alpha in encoded 8-bit color space; `gfx.rgba(r,g,b,a)` accepts ordinary channel
values and premultiplies them. Opaque `byt.rgb` values retain their meaning.
Every raw RGB channel must be at most alpha. Helpers/importers perform conversion
explicitly; no implicit gamma conversion or HDR is part of this profile.

Textures and targets may be 1..1024 pixels on each axis. Screen output remains
exactly 640×360 or 320×180. Descriptors specify format, dimensions and usage.
Uploads specify rectangle, buffer offset and row stride in bytes. Rows are
top-to-bottom; the last row's required bytes must fit the buffer, with no assumed
trailing padding. Subrectangles must fit the resource; this is not screen clipping.
Pixel buffers support checked get/set, rectangular fill and row copy. Odin can
also operate directly on its typed slice; Luau can use bulk buffer operations.

`Palette` has 256 RGBA8 entries. Indexed images carry indices only; a draw or
presentation supplies the palette explicitly. Indexed transparency is selected
by pipeline state, not a permanently reserved transparent index. `ColorTable`
is a 256×256 u8 mapping from source/destination indices to an output index.
It supports custom remapping and destination-dependent composition, and is
mutable through ordered subrange uploads. No color bits are reserved for flags.

### Passes and drawing state

`begin_pass(target, options)` returns a short-lived `Pass`; `end_pass(pass)` ends
it. Passes cannot nest or survive a draw callback. Every pass explicitly selects
its target, optional clear, pipeline, clip rectangle and affine transform.
Omitted state uses documented defaults, never state left by a previous frame.
Clearing a target is explicit; un-cleared target contents persist across frames.

A `Pipeline` is an immutable validated descriptor; create a replacement to change
it. It defines format-compatible blending, optional color table, indexed write
bit mask or RGBA channel write mask, and stencil compare/write behavior. Opaque
defaults and standard alpha defaults are built-in pipeline resources. Indexed
output can replace an index or apply a color table. RGBA output supports replace,
premultiplied source-over and saturating add. Source-over is
`Cout = Csrc + Cdst*(1-Asrc)` and `Aout = Asrc + Adst*(1-Asrc)`, normalized to
0..1, clamped and rounded to the nearest byte. Stencil compares are always,
equal and not-equal, with explicit reference/read/write masks and keep/replace
operations for pass/fail. Stencil is a separate attachment, not encoded in color.

Pass operations include setting clip/transform/pipeline and drawing rectangles,
text and textured quads with source/destination rectangles, tint and flips.
Quads support rotation/scaling through affine transforms. Coordinates are
quantized to signed 16.16 fixed point; clip rectangles and pixel samples use
integer coordinates with half-open bounds. Nearest sampling is required;
clamp/repeat addressing is explicit. The software reference must define edge
coverage and rounding fixtures before a GPU adapter is accepted. Batching may
combine work only while preserving painter order and pass semantics.

A completed `Target` can be used as a sampled image in another pass. Sampling the
active target, including through an alias, is rejected. Use separate targets or
an explicit copy outside passes for feedback effects. Copy requires equal formats
and non-overlapping source/destination storage. Index8-to-RGBA conversion is an
explicit draw with a palette. Automatic RGBA-to-index quantization is not supplied;
games/importers perform that conversion in a CPU buffer. Other unsupported format
combinations fail.

Exactly one `present` selects the final image in a draw packet. RGBA output uses
its stored colors; indexed output supplies a palette and optional `RowTable`.
The table has one entry per output row: palette reference and signed integer
x/y source offsets. It is evaluated during indexed-to-screen resolution, enabling
palette bands and raster-style scrolling without callbacks during physical
scanout. Offsets use the selected clamp/repeat mode. Output dimensions must match
the active display. Rendering may use multiple targets before presentation.
Presentation flattens alpha over an explicit opaque background, default black;
the physical display result is opaque. Switching display mode changes the
reserved screen target's dimensions for the next draw, without resizing offscreen
targets. Input already sampled before a switch retains the previous coordinates.

### Readback

`readback(target, rect)` is recorded outside passes, after the writes it observes,
and returns a ticket. Completion supplies a tightly packed, game-owned pixel
buffer through a later input mailbox. There is no synchronous GPU read in an
update or draw callback. Completion timing can vary by host; game simulation
must not depend on its arrival tick. The returned pixels refer to the requested
submission, not later target contents. CPU procedural effects can retain and
edit their own pixel buffers instead of reading back rendered images.

`gfx.poll(ticket)` returns pending or a ready pixel buffer. Taking a ready result
consumes the ticket; the buffer then belongs to the game. Destroying a ticket
cancels delivery and releases its retained result. Mailbox payload delivery is
limited to 1 MiB per update; excess ready results remain on the host, charged to
the resource budget, until a later update. A single result cannot exceed 1 MiB.

## 5. Audio interface

The shared Odin mixer renders 48,000 Hz stereo f32 internally. Native supplies
its output through SDL; the browser runs the same DSP module in an AudioWorklet
adapter. Resample at device delivery when required. Accept actual device/worklet
block lengths; neither game ticks nor event times depend on a fixed callback size.
The [Web Audio specification](https://www.w3.org/TR/webaudio/#AudioWorklet) defines
the browser processing facility; the console defines its own DSP and resources.

### Sources, instruments and routing

- `Sample`: mono/stereo interleaved PCM, imported from i16 or finite f32, 8..96 kHz.
  The runtime converts to interleaved f32 outside the audio callback, retaining
  the declared source rate. Voices use bounded linear interpolation at playback
  rate; writes continue to address source-rate frames.
  Loop start/end are frame indices, end-exclusive. Rate conversion, looping,
  gain and panning have shared reference tests.
- `Wavetable`: mono f32, 32..2048 samples per cycle (power of two), 1..64 waves.
  Phase wraps in cycles; linear interpolation applies within and between waves.
  Partial writes can change a playing waveform at a scheduled sample while phase
  continues. Table data is bounded to -1..1; NaN and infinity are invalid.
- `Instrument`: immutable typed DSP graph and parameter bindings. Source nodes
  include sample, wavetable and seeded noise; processing/control nodes include
  mix, gain, ADSR, LFO, state-variable filter, bounded delay and stereo pan/output.
  Ports distinguish audio from scalar control. Validate indices, port types and
  acyclic topology at creation. Feedback exists only inside a bounded delay node;
  there is no arbitrary graph feedback or guest DSP callback. Per-voice phase,
  envelopes and filter/delay history are separate from the shared definition.
  Declared oscillator frequency/phase and gain inputs also accept mono audio-rate
  modulation, with explicit units, depth and bounded parameter ranges. These
  connections are evaluated per sample, allowing frequency modulation and
  multiplying signals through gain nodes. They obey the same typed, acyclic
  graph rules; control-rate events alone do not define their resolution.
- `Bus`: a bounded effects chain and parent bus. Routing forms a tree ending at
  the master bus. No routing feedback; topology replacement is a control commit.
- `Stream`: bounded f32 stereo PCM supplied ahead of playback, with declared
  logical frame positions. It provides an escape hatch for game-generated audio;
  streaming compressed files/large music requires the later asset delivery work.

Resources support explicit create, bounded writes where mutable, and destroy.
Sample writes use frame offsets, never byte/sample ambiguity. Writes, table edits
and parameter changes are scheduled; a voice already using the resource observes
the new version at that event's frame. Instrument topology is immutable, but
declared controls may adjust tuning, wave selection, envelope values and effects.
Filter ranges, delay duration and feedback are constrained to finite stable
domains in the DSP descriptor schema before implementation is accepted.

Games explicitly select one of 16 `Voice` slots. `play_sample` accepts rate,
gain, pan, loop and bus; `play_stream` selects a queued PCM stream and bus;
`note_on` accepts instrument, explicit frequency in Hz, velocity and bus.
Replacing a playing slot occurs at the requested frame and resets its state;
there is no hidden allocation or voice stealing. `note_off` starts the instrument
release envelope; `stop` silences immediately. The existing `release` call uses
an explicit fade length for either PCM or instrument voices. Zero-duration changes may click: smoothing is an explicit ramp or
instrument envelope, not an undocumented delay. Controls address typed voice,
instrument-instance or bus parameters and reject parameters for the wrong type.
Mix voices in slot order and buses in a defined child order; clamp master output
to -1..1. A configurable gain/ramp is part of master bus state.

### Scheduling, pause and failure

The scheduling unit is a **stereo frame**, not a byte or a single channel sample.
At 60 Hz, simulation tick k starts at logical frame `800*k`; `audio.time()` returns
that stable integer within a callback. Event times are absolute logical frames,
represented as u64 on the wire and limited to 2^53-1 for exact Luau numbers.
Events may be scheduled from the current tick through the next 96,000 frames.
Events at the same frame execute in commit/command order. Parameter ramps have
an explicit duration in frames; zero means immediate. Game tick time and actual
audio output position are separate status values.

The initial adapter target is a fixed 2,400-frame / 50 ms scheduling lead, plus
device latency, reported in capabilities. Both hosts test the same fixed lead;
it does not promise physical output latency. A late event executes at the first unrendered frame
and increments a visible late-event counter; it is never replayed twice. This
handles stalls explicitly but does not promise sample-exact synchronization
between stalled gameplay and physical audio. On-time offline event traces must
match; device buffering and floating-point output need measured tolerances.

The mixer continues active oscillators, envelopes, sample playback and scheduled
events independently of game/main-thread progress. An empty PCM stream emits
silence, advances its timeline and increments an underrun counter; late writes
are rejected rather than playing stale data later. Stream writes cannot overlap
queued intervals or exceed its negotiated queue capacity. Status/completions
arrive through the mailbox; scripts are not called on the audio thread.

Before browser audio unlock, logical DSP time is held and the SDK allows one
bounded initial schedule. Starting the game anchors the audio epoch and lead.
Pause fades the master out, invalidates queued device blocks and freezes DSP
time; resume re-anchors delivery and fades in without re-triggering notes.
Session teardown invalidates queued events/blocks before accepting a new session.
Backends must make this behavior explicit instead of letting suspended tabs
accumulate unbounded catch-up or sending old sound into a reloaded game.

### Real-time ownership

The registry validates descriptors, preallocates DSP state and snapshots sample
versions outside the real-time path. The audio callback/worklet does bounded DSP
and reads a preallocated command queue: no allocation, compilation, I/O, locks
waiting on gameplay, or guest callbacks. Reclamation runs off the audio thread.
Native uses a bounded producer/consumer queue; the browser transfers prepared
commands and resource blocks to the worklet with a bounded in-flight pool.
All copies, pending versions and effect buffers count against resource limits.

The baseline requires no SharedArrayBuffer or cross-origin isolation. Worklet
message delivery and buffer recycling must be measured; success is not assumed.
If that path fails sustained audio requirements, revise this proposal explicitly
before making stronger deployment requirements. First prove shared sample mixing
and callback behavior; add synthesis only after the delivery path passes.

## 6. Equivalent SDK surfaces

These describe the published resource interface. Exact signatures and optional
descriptor fields are documented in the SDK references above. Use `byt.gfx`,
`byt.audio` and `byt.data` in Luau, and the corresponding `sdk:gfx`,
`sdk:audio` and `sdk:data` Odin packages. Descriptors use named fields, explicit
units and tagged enum choices. Odin wraps handle kinds in distinct types; Luau
exports matching opaque types checked by the runtime as well as its analyzer.

| Operation | Luau shape | Odin shape |
| --- | --- | --- |
| Pixel storage | `data.pixels(format,w,h)` | `data.pixels(format,w,h)` |
| Sample storage (f32) | `data.pcm(frames,channels)` | `data.pcm(frames,channels)` |
| Create texture | `gfx.texture(desc)` | `gfx.texture(desc)` |
| Upload pixels | `gfx.upload(texture,rect,pixels)` | `gfx.upload(texture,rect,pixels)` |
| Palette/table/row creation | `gfx.palette(bytes)`, `gfx.color_table(bytes)`, `gfx.row_table(height)` | `gfx.palette(colors)` uses `[]u32`; table data uses `[]u8`; row count is explicit |
| Mutable table data | `gfx.write(handle,offset_bytes,bytes)`, `gfx.write_rows(table,first,rows)` | Same operations; typed slices |
| Offscreen image | `gfx.target(desc)` | `gfx.target(desc)` |
| Pipeline/pass | `gfx.pipeline(desc)`, `gfx.begin_pass(target,opts)` | Same operations with typed descriptor structs |
| Screen/default state | `gfx.screen()`, `gfx.default_pipeline(format)` | Same operations; session-scoped reserved handles |
| Pass controls | `gfx.clip(pass,x,y,w,h)`, `gfx.transform(pass,matrix)`, `gfx.bind(pass,pipeline)` | Same operations; typed pass and pipeline |
| Draw | `gfx.draw(pass,image,src,dst,opts)` | `gfx.draw(pass,image,src,dst,opts)` |
| Finish pass | `gfx.end_pass(pass)` | `gfx.end_pass(pass)` |
| Resolve screen | `gfx.present(image,opts)` | `gfx.present(image,opts)` |
| Pixel readback | `gfx.readback(target,rect)` | `gfx.readback(target,rect)` |
| Consume readback | `gfx.poll(ticket)` returns buffer or nil | `gfx.poll(ticket)` returns `(data.Pixel_Buffer,bool)` |
| Audio storage/graph | `audio.sample(desc,pcm)`, `audio.wavetable(desc,pcm)`, `audio.instrument(nodes)` | Same operations with typed descriptors/slices |
| Voices/routing | `audio.voice(index)`, `audio.master()`, `audio.bus(desc)` | Same operations; typed voice/bus handles |
| Explicit playback | `audio.play_sample(voice,sample,opts)`, `audio.note_on(voice,inst,frequency_hz,opts)` | Same operations; typed voice/instrument handles |
| PCM queue | `audio.stream()`, `audio.write_stream(stream,at,pcm)`, `audio.play_stream(voice,stream,opts)` | Same operations; typed stream handle |
| Scheduled controls | `audio.node_control(voice,inst,node,param,value,at,ramp_frames)`, `audio.effect_control(bus,node,param,value,at,ramp_frames)` | Same operations; typed parameter enum |
| Mutable audio | `audio.edit_sample(sample,first,pcm,at)`, `audio.edit_wavetable(table,first,pcm,at)` | Same operations; explicit source-frame offset and time |
| Release/stop | `audio.note_off(voice,at)`, `audio.release(voice,fade_frames,at)`, `audio.stop(voice,at)` | Same operations |
| Clock/status | `audio.time()`, `audio.status()`, `byt.capabilities()` | Same queries; integer clock and read-only snapshots |
| Free resource | `gfx.destroy(handle)`, `audio.destroy(handle)`, `audio.destroy_instrument(inst)`, `audio.destroy_wavetable(table)` | Same operations with typed handles |

Indexing into game data is zero-based in both SDKs, including Luau typed buffers;
ordinary Luau arrays remain normal language arrays. Byte and frame offsets must
be whole numbers. Resource counts/sizes and capabilities are read-only metadata.
Memory allocation strategy inside the game remains language-specific; renderer,
DSP features, synchronization and failure behavior do not.

For `edit_sample` and `edit_wavetable`, `first` addresses source frames and the
PCM buffer declares the replacement frame count. `at` is an absolute 48 kHz
logical frame. Stream writes address absolute logical intervals instead of
source-frame offsets. Ordinary `audio.write` still initializes/updates a sample
before live binding using its explicit frame range. SDK names expose these units.

## 7. Initial limits and verification gates

These are the published profile's portable quotas. They do not promise a frame
time or physical device latency on arbitrary hardware.

| Item | Profile limit |
| --- | --- |
| Game memory / tracked Luau heap | Retain 8 MiB / 4 MiB; staging fits inside those limits |
| Live runtime resource IDs | 1,024, plus reserved screen/default resources |
| Runtime resource budget | 64 MiB, charging persistent copies, retired versions, queued payloads and DSP history |
| Packet staging | 16,384 commands, 1 MiB payload per commit; larger uploads require chunks |
| Images | 1..1024 per axis; 8 offscreen targets; per-kind budgets within the shared pool |
| Readback | 4 outstanding, at most 1 MiB per result; retained results count against budget |
| Completion mailbox | At most 1 MiB payload delivered per update; excess ready results remain budgeted on the host |
| Audio | 16 voices; 8 buses including master; 64 instrument definitions |
| DSP | 16 nodes/instrument, 8/bus, at most 320 active nodes including all buses |
| Delay | At most 2 seconds per delay node; all history charged to the resource pool |
| PCM streams | 4; at most 8,192 queued stereo frames each |
| Scheduled events | 4,096 pending, horizon 96,000 frames |

Reported budgets must use the same portable charging rules on both hosts,
including copies needed only by the browser adapter. Baseline runtime heaps,
reserved linear-memory capacity, allocator overhead and device-driver memory
are measured separately; a 64 MiB resource quota is not a process-RSS guarantee.
The implemented pool enforces these charges transactionally on both hosts.

Acceptance requires matching Luau/Odin traces and native/browser rendering for
pixel uploads, palette edits, LUT composition, masks, stencil, offscreen passes,
row-table resolution, feedback rejection and readback. Audio tests compare event
timelines, loop/rate behavior, live wavetable edits, envelope/filter/delay state,
slot replacement, ramps, pause/resume, reload, underruns and late commands.
Mixer float tolerances and graphics edge rules must be measured and frozen with
reference fixtures; do not claim universal bit-identical device output.

Malformed packets, arithmetic overflow, stale/cross-session handles, wrong resource
types, future/unknown features, cyclic graphs, NaN/Inf, queue saturation, heap
pressure, device/context loss and terminated game Workers must fail or recover
as specified. Measure a full-frame procedural upload and the worst permitted
voice/graph workload in both languages on both hosts. No new profile is advertised
until these tests, real device audio checks and budget gates pass.
