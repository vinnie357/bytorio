# PCM audio: resource-av-1

Both SDKs expose the same 48 kHz stereo mixer. The native player delivers its
output through SDL; the browser runs the same Odin DSP in an independent
AudioWorklet. These APIs use resource transport version 4 in the published
SDK 0.2.0 / ABI 2 / `resource-av-1` profile. See
[profile negotiation and limits](../docs/resource-profile.md).

Import `byt.audio` / `byt.data` in Luau or `audio "sdk:audio"` /
`data "sdk:data"` in Odin. Record commands during init/update. Audio never calls
game code, and draw cannot schedule audio. Existing preview sound cues still work.

## Types and operations

`Sample`, `Bus` and `Stream` are session/generation checked resource handles.
`Voice` identifies an explicit slot, indexed 0–15, within the current session.
Starting a sound replaces that slot's previous sound. Voices are not allocated
or selected automatically. `audio.master()` returns the permanent output bus.

| Operation | Both SDKs |
| --- | --- |
| PCM storage | `data.pcm(frames, channels)`; `data.from_i16(values, channels)` |
| Source storage | `audio.sample(desc, pcm)`; `audio.write(sample, range, pcm)` |
| Routing | `audio.bus(desc)`; `audio.stream()`; `audio.voice(index)` |
| Playback | `audio.play_sample(voice, sample, opts)`; `audio.play_stream(voice, stream, opts)` |
| Voice controls | `audio.gain(voice, value, at, ramp_frames)`; `audio.pan(...)` |
| Bus controls | `audio.bus_gain(bus, value, at, ramp_frames)` |
| End playback | `audio.stop(voice, at)`; `audio.release(voice, fade_frames, at)` |
| Stream delivery | `audio.write_stream(stream, at, pcm)` |
| Destruction | `audio.destroy(sample)`; `audio.destroy_bus(bus)`; `audio.destroy_stream(stream)` |
| Observations | `audio.time()`; `audio.status()`; `audio.completions()` |

Luau descriptors are tables; Odin uses `Sample_Desc`, `Bus_Desc`, `Play_Options`
and `Stream_Options`. Optional arguments can be omitted. Odin's optional `at`,
`gain` and `rate` descriptor fields use unions so explicit zero differs from
omission. Positional Odin timing defaults to `audio.ASAP`, meaning `audio.time()`.

Sample descriptors contain `frames`, `channels` (1 or 2) and source `rate`
(8,000–96,000 Hz). PCM is interleaved finite f32 in [-1,1]. Luau stores it in
`pcm.samples`, a buffer; Odin uses a slice. `from_i16` accepts a little-endian
signed-16 buffer in Luau and an `[]i16` slice in Odin, dividing each value by
32,768. It does not decode compressed files. Free Odin buffers with
`data.free_pcm(&pcm)` when finished.

Bus descriptors contain `parent` (default master) and `gain` (default 1).
Sample play options contain `at`, `bus`, `rate` (playback multiplier, default 1),
`gain` (default 1), `pan` (default 0), `loop` (default false), `loop_start` and
`loop_end` (default 0). A loop must explicitly supply an exclusive end frame;
`0 <= loop_start < loop_end <= sample.frames`. Disabled loops require both
endpoints zero. Playback starts at source frame zero, then repeats the loop.
Stream play options contain `at`, `bus`, `gain` and `pan` with the same defaults.

Gain is [0,4], pan is [-1,1], and sample rate multiplier is [1/16,16]. Mono is
duplicated to both channels. Pan is linear balance: left weight `min(1,1-pan)`,
right weight `min(1,1+pan)`. Center preserves both channels. Sources use linear
interpolation, including interpolation across loop boundaries. Child buses mix
into their parents in descending depth and ascending slot order; master output
clamps to [-1,1]. Gain/pan ramps use the old value on the scheduled frame and
reach the target after exactly `ramp_frames` logical frames. Zero applies the
target immediately. Release ramps gain to zero, then stops; it is not an ADSR.

## Scheduling, snapshots and streams

### Experimental Ogg Vorbis streams

SDK **0.7.0**, profile **`ogg-streaming-preview-1`**, adds
`audio.ogg_stream(content_id, options)` in both languages. Package the `.ogg`
file as an immutable cartridge content entry. This path uses libvorbisfile on
native and a project-owned WASM build of that library in the browser.

```luau
local music = audio.ogg_stream(1, {
    loop = true,
    loop_start = 0,
    loop_end = 480000,
})
audio.play_stream(audio.voice(0), music, { gain = 0.5 })
```

```odin
music := audio.ogg_stream(1, {loop = true, loop_start = 0, loop_end = 480000})
audio.play_stream(audio.voice(0), music, {gain = f32(0.5)})
```

Odin options use `audio.Ogg_Options`; Luau uses the matching table fields.
Only single-link mono/stereo 48 kHz Vorbis is supported initially. Loop frames
are measured in the source; the end is exclusive and must not exceed its length.
Disabled loops require both endpoints to be zero. The example requires a source
at least ten seconds long. Other sample rates and chained files are rejected.

The stream starts its source clock at creation, including when no voice is
attached. Stopping a voice does not rewind it. Recreate a stream to restart;
destroy it with `audio.destroy_stream`. Nonlooping playback completes naturally
at EOF. Manual `audio.write_stream` calls on an Ogg stream are rejected.

Four PCM/Ogg stream slots are shared. Ogg input is limited to 2 MiB per stream
and 4 MiB across live streams. Decoding fills the existing 8,192-frame queues;
the browser decoder uses a fixed 8 MiB WASM memory instead of a full-song PCM
cache. See [integration limits and validation](../docs/ogg-streaming-integration.md).

All `at` values are absolute **48 kHz logical frames**, never milliseconds,
device samples or source frames. `audio.time()` is the simulation clock
`tick * 800`, identical in both languages. Omitted times use this clock. The
host accepts commands between that tick's frame and 96,000 frames ahead, within
the exact integer range 0–2^53-1. Ramps/releases are bounded to 96,000 frames.
Events at the same frame execute in accepted command order. Buses and streams
are created/destroyed at the current simulation frame.

The renderer is independent of game execution. `audio.status().frame` reports
its next unrendered logical frame (including up to two frames of resampler
lookahead), from the latest delivered snapshot. It can advance during a stalled
game. A non-stream event arriving behind this cursor executes once on the first
unrendered frame and increments `late_events`; playback starts at source zero.
A late stream write is rejected rather than replaying old PCM.

An initial 2,400-frame / 50 ms lead holds logical time while output begins with
silence. At startup and resume, the renderer anchors to the newest delivered
simulation frame throughout the lead, moving only forward. Browser audio unlock
requires a gesture. Pause fades output, freezes DSP, and increments the audio
epoch; resume inserts a fresh lead and fades back
into the same voices. Reload replaces the entire audio session. Lead is a
scheduling allowance, not measured speaker latency or a guarantee for all devices.

Accepted sample playback owns a snapshot of the source **at the play command**.
Later `audio.write` or destruction does not alter scheduled/playing sound.
The [synthesis API](synthesis.md) explicitly opts samples into live shared source
storage with scheduled edits; its lifetime rules then apply. Buffer reuse after
a command is safe. The synthesis API provides live scheduled source edits,
instruments, modulation and effects.

Streams contain stereo 48 kHz PCM. `write_stream(stream, at, pcm)` reserves a
nonoverlapping absolute interval `[at, at+frames)`. Gaps produce silence while
time continues, and increment `underrun_frames` per active voice-frame. Chunks
expire even when no voice reads them. Multiple voices may read one stream;
starting a stream voice does not move its chunks or restart their clock. Keep
enough data ahead of `status.frame` to cover delivery delay. Destroying a stream
cancels its voices/chunks. Destroy child buses before parents; destroying a bus
cancels its directly routed voices and future plays targeting that generation.

## Bounds and feedback

| Limit | Current implementation |
| --- | --- |
| Voices / buses / streams | 16 / 8 including master / 4 |
| Per-stream queue | 8,192 stereo frames, at most 64 chunks |
| Pending events | 4,096 globally across batches and scheduled events |
| Producer batches | 8 |
| Immutable PCM snapshot arena | 8 MiB, 1 KiB pages; includes scheduled, playing and retired data |
| Browser packet transfers | 4 credits with aggregate capacity bounded to one maximum packet |
| Device block / rate | Up to 2,048 frames per render call; 8,000–192,000 Hz |
| Completion ring / per-update delivery | 64 / 16 |
| Fixed portable audio resource charge | 55,463,952 bytes, plus ordinary sample/bus/stream resources |

The fixed charge reserves worst-case controller/DSP metadata, both PCM arenas,
wire arenas, transfer credits, feedback and device scratch. Native pays the same
charge even though it needs fewer copies. Resource capacity remains 64 MiB;
the reservation is charged only when low-level audio is first used and rolls
back if that first transaction fails. Snapshot exhaustion, overlapping chunks,
queue exhaustion or invalid arguments fail the entire resource commit. This
preview treats rejected commits as game errors; there is no implicit voice
stealing, silent sample eviction or retry API. Snapshot pages become reusable
only after renderer completion reaches the producer.

`status()` returns `frame`, `lead_frames`, `epoch`, `late_events`,
`underrun_frames`, `rejected_writes`, `completed`, `completion_overflow` and
`pending_events`. A write that becomes late in transit increments
`rejected_writes`; one rejected during producer validation fails the commit.
Counters are cumulative within the session. These are observations, not a
request to block until audio finishes.

`completions()` returns the current update's completion snapshot: a Luau array,
or an Odin fixed array plus count. Reading it twice returns the same records;
the mailbox drains on the next update. Each record has `voice`, `reason`,
`frame` and monotonically increasing `serial`. Compare reasons with
`audio.COMPLETION_NATURAL` (1, natural end), `audio.COMPLETION_STOPPED`
(2, stop/release/replacement), or `audio.COMPLETION_CANCELLED`
(3, resource cancellation). Release completes at
the first frame after its final faded sample. The oldest queued records are
preserved when the ring fills; dropped new records increment
`completion_overflow`, without preventing internal PCM reclamation.

## Matching examples

The executable [Luau fixture](../tests/audio/cartridges/game.luau) and
[Odin fixture](../tests/audio/cartridges/game.odin) include loops, ramps, buses,
one-shot playback, signed-16 conversion, bounded streams and status queries.
For a simple sound, create a sample during init and schedule a voice:

```luau
local pcm = byt.data.pcm(480, 1)
for i = 0, 479 do
    buffer.writef32(pcm.samples, i * 4, math.sin(i * math.pi * 2 * 440 / 48000) * 0.2)
end
local source = byt.audio.sample({ frames = 480, channels = 1, rate = 48000 }, pcm)
byt.audio.play_sample(byt.audio.voice(0), source)
```

```odin
pcm := data.pcm(480, 1)
defer data.free_pcm(&pcm)
for &value, i in pcm.samples {
    value = f32(math.sin(f64(i) * math.PI * 2 * 440 / 48000) * 0.2)
}
source := audio.sample({frames = 480, channels = 1, rate = 48000}, pcm)
audio.play_sample(audio.voice(0), source)
```

The Odin example additionally imports `math "core:math"`. Call sample destruction
when its storage is no longer needed. See [verification](../docs/internal/measurements/audio-measurements.md)
for parity, delivery and pressure checks.
