package audio_mixer

import w "../resource_protocol"
import "base:intrinsics"
import "core:math"

// Only the producer allocates/reclaims pages. The renderer owns voices, the heap,
// and stream cursors. Release/acquire SPSC indices publish immutable snapshots.
PAGE_COUNT :: w.maxAudioSnapshotBytes / (w.audioPageFrames * 4)
DONE_CAPACITY :: w.maxAudioDoneRecords
NO_VOICE :: max(u32)
STREAM_TIME :: u32(1)
Command :: struct {
    at, order:                                          u64,
    op, id, lease, page, frames, channels, source_rate: u32,
    bus, parent, resource, loop_start, loop_end:        u32,
    rate, gain, pan:                                    f32,
    parameter, ramp:                                    u32,
}
Batch :: struct {
    simulation_frame: u64,
    count:            u32,
    commands:         [w.maxAudioEvents]Command,
}
Lease :: struct {
    page, pages: u32,
    live:        bool,
}
Done :: struct {
    lease, voice, reason: u32,
    frame, serial:        u64,
}
Bus_Model :: struct {
    id, parent: u32,
    live:       bool,
}
Interval :: struct {
    first, end: u64,
}
Stream_Model :: struct {
    id:        u32,
    live:      bool,
    count:     int,
    intervals: [w.maxStreamChunks]Interval,
}
Model :: struct {
    buses:       [w.maxBuses]Bus_Model,
    streams:     [w.maxStreams]Stream_Model,
    sources:     [w.maxSlots]Source_Info,
    definitions: [w.maxInstruments]Definition_Info,
}
Ramp :: struct {
    value, target: f64,
    remaining:     u32,
}
Voice :: struct {
    kind, resource, bus, bus_id, lease:                  u32,
    data:                                                []f32,
    frames, channels, source_rate, loop_start, loop_end: u32,
    position, rate:                                      f64,
    gain, pan:                                           Ramp,
    releasing:                                           bool,
    synth:                                               Synth,
}
Bus :: struct {
    id, parent, depth: u32,
    live:              bool,
    gain:              Ramp,
    effects:           Synth,
}
Chunk :: struct {
    stream_time: bool,
    first, end:  u64,
    lease:       u32,
    data:        []f32,
}
Stream :: struct {
    ended:  bool,
    id:     u32,
    live:   bool,
    count:  int,
    chunks: [w.maxStreamChunks]Chunk,
}
Engine :: struct {
    // Producer fields.
    pool:                                                                                 []f32,
    pages:                                                                                [PAGE_COUNT]bool,
    leases:                                                                               [w.maxAudioLeases]Lease,
    used, peak:                                                                           u64,
    model:                                                                                Model,
    submitted, order:                                                                     u64,
    batches:                                                                              [w.maxAudioBatches]Batch,
    head, tail:                                                                           u32,
    done:                                                                                 [DONE_CAPACITY]Done,
    done_head, done_tail:                                                                 u32,
    completions:                                                                          [w.maxAudioCompletions]Done,
    completion_head, completion_tail:                                                     u32,
    completion_overflow:                                                                  u64,
    // Atomic renderer publications; never inspect mutable DSP state on the producer.
    published_frame, processed, late, underruns, rejected_writes, completed:              u64,
    published_stream_frame:                                                               u64,
    published_leading:                                                                    u32,
    pause_request, epoch:                                                                 u32,
    // Renderer fields.
    events:                                                                               [w.maxAudioEvents]Command,
    event_count:                                                                          int,
    voices:                                                                               [w.maxVoices]Voice,
    buses:                                                                                [w.maxBuses]Bus,
    streams:                                                                              [w.maxStreams]Stream,
    sources:                                                                              [w.maxSlots]Source,
    graphs:                                                                               [w.maxInstruments]Graph,
    frame, processed_local, late_local, underruns_local, rejected_local, completed_local: u64,
    lead_remaining:                                                                       u32,
    simulation_frame:                                                                     u64,
    stream_shift:                                                                         u64,
    paused:                                                                               bool,
    fade:                                                                                 Ramp,
    lead_phase:                                                                           f64,
    device_phase:                                                                         f64,
    device_ready:                                                                         bool,
    previous, next:                                                                       [2]f32,
}
// Portable worst-case charge, independent of native/Wasm pointer size. Includes
// both controller/DSP states, their PCM arenas, two wire arenas, transfer credits,
// feedback credits, and device scratch. Native deliberately pays the same charge.
#assert(size_of(Engine) <= w.audioMetadataReservationBytes)
RESERVED_BYTES ::
    2 * (w.audioMetadataReservationBytes + w.maxAudioSnapshotBytes) +
    3 * w.maxAudioPacketBytes +
    (w.maxAudioTransfers + 2) * w.maxAudioFeedbackBytes +
    w.maxAudioDeviceBlock * 2 * 4
Transaction :: struct {
    engine: ^Engine,
    batch:  ^Batch,
    model:  Model,
    head:   u32,
    active: bool,
}

load :: proc "contextless" (p: ^$T) -> T {
    when ODIN_ARCH == .wasm32 { return p^ } else { return intrinsics.atomic_load(p) }
}
store :: proc "contextless" (p: ^$T, value: T) {
    when ODIN_ARCH == .wasm32 { p^ = value } else { intrinsics.atomic_store(p, value) }
}
create :: proc() -> ^Engine {
    e, err := new(Engine)
    if err != nil { return nil }
    e.pool, err = make([]f32, w.maxAudioSnapshotBytes / 4)
    if err != nil { free(e); return nil }
    e.model.buses[0] = {
        id   = 0,
        live = true,
    }
    e.buses[0] = {
        live = true,
        gain = {value = 1, target = 1},
    }
    e.fade = {
        value  = 1,
        target = 1,
    }
    e.lead_remaining = w.audioLeadFrames
    e.published_leading = 1
    e.epoch = 1
    return e
}
close :: proc(e: ^Engine) { if e != nil { delete(e.pool); free(e) } }
release_lease :: proc(e: ^Engine, id: u32) {
    if id == 0 { return }
    lease := &e.leases[id - 1]
    if !lease.live { return }
    for i in lease.page ..< lease.page + lease.pages { e.pages[i] = false }
    e.used -= u64(lease.pages) * w.audioPageFrames * 4
    lease.live = false
}
accept_done :: proc(e: ^Engine, d: Done) {
    release_lease(e, d.lease)
    if d.voice == NO_VOICE { return }
    if e.completion_head - e.completion_tail == w.maxAudioCompletions {
        e.completion_overflow += 1
    } else {
        e.completions[e.completion_head % w.maxAudioCompletions] = d
        e.completion_head += 1
    }
}
reclaim :: proc(e: ^Engine) {
    if e == nil { return }
    tail, head := e.done_tail, load(&e.done_head)
    for tail != head {
        accept_done(e, e.done[tail % DONE_CAPACITY])
        tail += 1
    }
    store(&e.done_tail, tail)
}
// Producer-side admission query. Reading the consumer's tail does not reclaim
// snapshots or change transaction ownership.
producer_batches_available :: proc(e: ^Engine) -> u32 {
    if e == nil { return 0 }
    pending := e.head - load(&e.tail)
    return w.maxAudioBatches - pending if pending < w.maxAudioBatches else 0
}
begin :: proc(e: ^Engine) -> (Transaction, bool) {
    reclaim(e)
    head := e.head
    if producer_batches_available(e) == 0 { return {}, false }
    batch := &e.batches[head % w.maxAudioBatches]
    batch.count = 0
    batch.simulation_frame = 0
    return {engine = e, batch = batch, model = e.model, head = head, active = true}, true
}
abort :: proc(t: ^Transaction) {
    if !t.active { return }
    for c in t.batch.commands[:t.batch.count] { release_lease(t.engine, c.lease) }
    t.batch.count = 0
    t.active = false
}
publish :: proc(t: ^Transaction) {
    if !t.active { return }
    e := t.engine
    e.model = t.model
    e.submitted += u64(t.batch.count)
    e.order += u64(t.batch.count)
    store(&e.head, t.head + 1)
    t.active = false
}
append :: proc(t: ^Transaction, command: Command) -> bool {
    e := t.engine
    if t.batch.count == w.maxAudioEvents ||
       e.submitted - load(&e.processed) + u64(t.batch.count) >= w.maxAudioEvents { return false }
    c := command
    c.order = e.order + u64(t.batch.count)
    t.batch.commands[t.batch.count] = c
    t.batch.count += 1
    return true
}
snapshot :: proc(t: ^Transaction, bytes: []u8) -> (lease, page: u32, ok: bool) {
    lease, page, ok = reserve_snapshot(t, len(bytes))
    if ok {
        target := (cast([^]u8)raw_data(t.engine.pool))[int(page) *
        w.audioPageFrames *
        4:][:len(bytes)]
        copy(target, bytes)
    }
    return
}
reserve_snapshot :: proc(t: ^Transaction, size: int) -> (lease, page: u32, ok: bool) {
    e := t.engine
    needed := (size + w.audioPageFrames * 4 - 1) / (w.audioPageFrames * 4)
    first, run := 0, 0
    for busy, i in e.pages {
        if busy { run = 0; first = i + 1 } else { run += 1 }
        if run == needed { break }
    }
    if needed == 0 || run < needed { return }
    for &slot, i in e.leases {
        if slot.live { continue }
        slot = {
            page  = u32(first),
            pages = u32(needed),
            live  = true,
        }
        for j in first ..< first + needed { e.pages[j] = true }
        target := (cast([^]u8)raw_data(e.pool))[first * w.audioPageFrames * 4:][:size]
        for &b in target { b = 0 }
        e.used += u64(needed * w.audioPageFrames * 4)
        e.peak = max(e.peak, e.used)
        return u32(i + 1), u32(first), true
    }
    return
}
bus_index :: proc(model: ^Model, id: u32) -> (u32, bool) {
    for b, i in model.buses { if b.live && b.id == id { return u32(i), true } }
    return 0, false
}
stream_index :: proc(model: ^Model, id: u32) -> (u32, bool) {
    for s, i in model.streams { if s.live && s.id == id { return u32(i), true } }
    return 0, false
}
finite :: proc(value: f32, lo, hi: f32) -> bool {
    return !math.is_nan(value) && !math.is_inf(value) && value >= lo && value <= hi
}
// Called only by the renderer. The queue is larger than every possible live lease
// plus voice completion. Producer admission also bounds outstanding commands.
finish :: proc(e: ^Engine, lease, voice, reason: u32, after_frame: bool = false) {
    if lease == 0 && voice == NO_VOICE { return }
    head := e.done_head
    if head - load(&e.done_tail) >= DONE_CAPACITY { return }
    serial := u64(0)
    if voice != NO_VOICE { e.completed_local += 1; serial = e.completed_local }
    e.done[head % DONE_CAPACITY] = {lease, voice, reason, e.frame + u64(after_frame), serial}
    store(&e.done_head, head + 1)
}
stop_voice :: proc(e: ^Engine, index, reason: u32, after_frame: bool = false) {
    v := &e.voices[index]
    if v.kind != 0 { finish(e, v.lease, index, reason, after_frame); v^ = {} }
}
set_ramp :: proc(r: ^Ramp, target: f64, duration: u32) {
    r.target = target
    r.remaining = duration
    if duration == 0 { r.value = target }
}
advance :: proc(r: ^Ramp) {
    if r.remaining > 0 {
        r.value += (r.target - r.value) / f64(r.remaining)
        r.remaining -= 1
    }
}
before :: proc(a, b: Command) -> bool { return a.at < b.at || (a.at == b.at && a.order < b.order) }
push :: proc(e: ^Engine, command: Command) {
    // Large read-only parameters may alias the caller's heap slot. Preserve the
    // incoming event before percolation overwrites that slot during a rebuild.
    c := command
    at := e.event_count
    e.event_count += 1
    for at > 0 {
        parent := (at - 1) / 2
        if !before(c, e.events[parent]) { break }
        e.events[at] = e.events[parent]
        at = parent
    }
    e.events[at] = c
}
sift_down :: proc(e: ^Engine, start: int) {
    last := e.events[start]
    at := start
    for at * 2 + 1 < e.event_count {
        child := at * 2 + 1
        if child + 1 < e.event_count && before(e.events[child + 1], e.events[child]) { child += 1 }
        if !before(e.events[child], last) { break }
        e.events[at] = e.events[child]
        at = child
    }
    e.events[at] = last
}
pop :: proc(e: ^Engine) -> Command {
    result := e.events[0]
    e.event_count -= 1
    if e.event_count > 0 {
        e.events[0] = e.events[e.event_count]
        sift_down(e, 0)
    }
    return result
}
uses_stream_time :: proc(c: Command) -> bool {
    return(
        (c.op == w.op_audio_stream_write || c.op == w.op_audio_stream_end) &&
        c.parameter == STREAM_TIME \
    )
}
consume :: proc(e: ^Engine) {
    tail, head := e.tail, load(&e.head)
    for tail != head {
        batch := &e.batches[tail % w.maxAudioBatches]
        e.simulation_frame = max(e.simulation_frame, batch.simulation_frame)
        for command in batch.commands[:batch.count] {
            c := command
            if uses_stream_time(c) {
                c.at += e.stream_shift
            }
            push(e, c)
        }
        tail += 1
    }
    store(&e.tail, tail)
}
// Destruction is scheduled in the same ordered queue as prefetched PCM. Once it
// takes effect, later writes/end markers for that handle are cancelled, even if
// the physical stream slot is immediately reused. Release producer-owned leases
// through the completion queue and retire admission credits exactly once.
cancel_stream_prefetch :: proc(e: ^Engine, resource: u32) {
    kept := 0
    for command in e.events[:e.event_count] {
        if command.resource == resource &&
           (command.op == w.op_audio_stream_write || command.op == w.op_audio_stream_end) {
            finish(e, command.lease, NO_VOICE, 0)
            e.processed_local += 1
        } else {
            e.events[kept] = command
            kept += 1
        }
    }
    // Rebuild the bounded heap in place. push only writes at or below its input
    // index, so no remaining compacted command is overwritten before being read.
    e.event_count = 0
    for index in 0 ..< kept { push(e, e.events[index]) }
}
apply :: proc(e: ^Engine, c: Command) {
    if c.at < e.frame { e.late_local += 1 }
    if c.op >= w.op_audio_wavetable && c.op != w.op_audio_stream_end {
        apply_synthesis(e, c)
        return
    }
    switch c.op {
    case w.op_audio_bus:
        e.buses[c.id] = {
            id = c.resource,
            parent = c.parent,
            depth = e.buses[c.parent].depth + 1,
            live = true,
            gain = {value = f64(c.gain), target = f64(c.gain)},
        }
    case w.op_audio_stream:
        e.streams[c.id] = {
            id   = c.resource,
            live = true,
        }
    case w.op_audio_destroy:
        if c.parameter == 9 {
            finish(e, e.buses[c.id].effects.graph.lease, NO_VOICE, 0)
            e.buses[c.id].effects = {}
            e.buses[c.id].live = false
            for v, i in e.voices { if v.kind != 0 && v.bus == c.id { stop_voice(e, u32(i), w.audioReasonCancelled) } }
        } else {
            s := &e.streams[c.id]
            for chunk in s.chunks[:s.count] { finish(e, chunk.lease, NO_VOICE, 0) }
            cancel_stream_prefetch(e, c.resource)
            s^ = {}
            for v, i in e.voices { if v.kind == 2 && v.resource == c.resource { stop_voice(e, u32(i), w.audioReasonCancelled) } }
        }
    case w.op_audio_play_sample, w.op_audio_play_stream:
        if !e.buses[c.bus].live || e.buses[c.bus].id != c.parent {
            finish(e, c.lease, c.id, w.audioReasonCancelled); break
        }
        if c.op == w.op_audio_play_stream {
            found := false
            ended := false
            for s in e.streams { if s.live && s.id == c.resource { found = true; ended = s.ended; break } }
            if !found { finish(e, 0, c.id, w.audioReasonCancelled); break }
            if ended { stop_voice(e, c.id, w.audioReasonStopped); finish(e, 0, c.id, w.audioReasonNatural); break }
        }
        if c.op == w.op_audio_play_sample && c.parameter == 1 {
            source := &e.sources[source_slot(c.resource)]
            if source.info.id !=
               c.resource { finish(e, c.lease, c.id, w.audioReasonCancelled); break }
        }
        stop_voice(e, c.id, w.audioReasonStopped)
        v := &e.voices[c.id]
        v^ = {
            kind = 1 if c.op == w.op_audio_play_sample else 2,
            resource = c.resource,
            bus = c.bus,
            bus_id = c.parent,
            lease = c.lease,
            frames = c.frames,
            channels = c.channels,
            source_rate = c.source_rate,
            loop_start = c.loop_start,
            loop_end = c.loop_end,
            rate = f64(c.rate),
            gain = {value = f64(c.gain), target = f64(c.gain)},
            pan = {value = f64(c.pan), target = f64(c.pan)},
        }
        if c.lease !=
           0 { v.data = e.pool[int(c.page) * w.audioPageFrames:][:int(c.frames * c.channels)] }
        if c.op == w.op_audio_play_sample &&
           source_slot(c.resource) >= 0 &&
           source_slot(c.resource) < w.maxSlots {
            source := &e.sources[source_slot(c.resource)]
            if source.info.id == c.resource {
                finish(e, c.lease, NO_VOICE, 0)
                v.lease = 0
                v.data = source.data
            }
        }
    case w.op_audio_stop:
        stop_voice(e, c.id, w.audioReasonStopped)
    case w.op_audio_release:
        if c.ramp == 0 { stop_voice(e, c.id, w.audioReasonStopped) } else {
            set_ramp(&e.voices[c.id].gain, 0, c.ramp); e.voices[c.id].releasing = true
        }
    case w.op_audio_voice_control:
        if c.parameter ==
           0 { set_ramp(&e.voices[c.id].gain, f64(c.gain), c.ramp) } else { set_ramp(&e.voices[c.id].pan, f64(c.pan), c.ramp) }
    case w.op_audio_bus_gain:
        if e.buses[c.id].live &&
           e.buses[c.id].id == c.resource { set_ramp(&e.buses[c.id].gain, f64(c.gain), c.ramp) }
    case w.op_audio_stream_end:
        s := &e.streams[c.id]
        if s.live && s.id == c.resource {
            s.ended = true
            for v, i in e.voices {
                if v.kind == 2 &&
                   v.resource == c.resource { stop_voice(e, u32(i), w.audioReasonNatural) }
            }
        }
    case w.op_audio_stream_write:
        s := &e.streams[c.id]
        if c.at < e.frame || !s.live || s.id != c.resource || s.count == w.maxStreamChunks {
            e.rejected_local += 1; finish(e, c.lease, NO_VOICE, 0); break
        }
        // Only decoder feeds use continuous stream time; game PCM timestamps are engine frames.
        shift := e.stream_shift if uses_stream_time(c) else 0
        s.chunks[s.count] = {
            stream_time = uses_stream_time(c),
            first       = c.at - shift,
            end         = c.at - shift + u64(c.frames),
            lease       = c.lease,
            data        = e.pool[int(c.page) * w.audioPageFrames:][:int(c.frames * 2)],
        }
        s.count += 1
    }
}
logical_frame :: proc(e: ^Engine) -> [2]f32 {
    for e.event_count > 0 && e.events[0].at <= e.frame {
        apply(e, pop(e)); e.processed_local += 1
    }
    stream_frame := e.frame - e.stream_shift
    // Stream chunks are ordered by event time; consume elapsed chunks even if no
    // voice currently reads that stream, so silence never defers stale PCM.
    for &s in e.streams {
        for s.count > 0 {
            frame := stream_frame if s.chunks[0].stream_time else e.frame
            if s.chunks[0].end > frame { break }
            finish(e, s.chunks[0].lease, NO_VOICE, 0)
            for i in 1 ..< s.count { s.chunks[i - 1] = s.chunks[i] }
            s.count -= 1
        }
    }
    mix: [w.maxBuses][2]f64
    for &v, index in e.voices {
        if v.kind == 0 { continue }
        value: [2]f64
        synth_done := false
        if v.kind == 3 {
            value, synth_done = synth_frame(e, &v.synth)
        } else if v.kind == 1 {
            if v.position >=
               f64(v.frames) { stop_voice(e, u32(index), w.audioReasonNatural); continue }
            first := u32(math.floor(v.position))
            second := first + 1
            if v.loop_end > 0 && second >= v.loop_end {
                second = v.loop_start
            } else {
                second = min(second, v.frames - 1)
            }
            fraction := v.position - f64(first)
            for channel in 0 ..< 2 {
                offset := u32(channel) if v.channels == 2 else 0
                a, b :=
                    f64(v.data[first * v.channels + offset]),
                    f64(v.data[second * v.channels + offset])
                value[channel] = a + (b - a) * fraction
            }
            v.position += f64(v.source_rate) / w.audioRate * v.rate
            if v.loop_end > 0 && v.position >= f64(v.loop_end) {
                v.position =
                    f64(v.loop_start) +
                    math.mod(v.position - f64(v.loop_start), f64(v.loop_end - v.loop_start))
            }
        } else {
            found := false
            for &s in e.streams {
                if !s.live || s.id != v.resource { continue }
                if s.count > 0 {
                    frame := stream_frame if s.chunks[0].stream_time else e.frame
                    if s.chunks[0].first <= frame && frame < s.chunks[0].end {
                        at := int(frame - s.chunks[0].first) * 2
                        value = {f64(s.chunks[0].data[at]), f64(s.chunks[0].data[at + 1])}
                        found = true
                    }
                }
                break
            }
            if !found { e.underruns_local += 1 }
        }
        mix[v.bus][0] += value[0] * v.gain.value * min(1.0, 1.0 - v.pan.value)
        mix[v.bus][1] += value[1] * v.gain.value * min(1.0, 1.0 + v.pan.value)
        advance(&v.gain); advance(&v.pan)
        if v.releasing &&
           v.gain.remaining == 0 { stop_voice(e, u32(index), w.audioReasonStopped, true) }
        if synth_done { stop_voice(e, u32(index), w.audioReasonStopped, true) }
    }
    for depth := w.maxBuses - 1; depth > 0; depth -= 1 {
        for &b, i in e.buses {
            if b.live && b.depth == u32(depth) {
                if b.effects.graph.count != 0 { mix[i], _ = synth_frame(e, &b.effects, mix[i]) }
                for channel in 0 ..< 2 { mix[b.parent][channel] += mix[i][channel] * b.gain.value }
            }
        }
    }
    if e.buses[0].effects.graph.count !=
       0 { mix[0], _ = synth_frame(e, &e.buses[0].effects, mix[0]) }
    result := [2]f32 {
        f32(clamp(mix[0][0] * e.buses[0].gain.value, -1, 1)),
        f32(clamp(mix[0][1] * e.buses[0].gain.value, -1, 1)),
    }
    for &b in e.buses { advance(&b.gain) }
    e.frame += 1
    return result
}
pause :: proc(e: ^Engine, paused: bool) { if e != nil { store(&e.pause_request, u32(paused)) } }
// Rendering touches only preallocated state and immutable PCM; it never calls a
// guest, allocates/frees memory, locks, compiles, or performs file/device I/O.
render :: proc(e: ^Engine, output: []f32, rate: u32 = w.audioRate) {
    if e == nil { for &v in output { v = 0 }; return }
    consume(e)
    requested := load(&e.pause_request) != 0
    if requested != e.paused {
        e.paused = requested
        store(&e.epoch, e.epoch + 1)
        if !requested { e.lead_remaining = w.audioLeadFrames; e.lead_phase = 0 }
        set_ramp(&e.fade, 0 if requested else 1, w.audioPauseFadeFrames)
    }
    if e.lead_remaining > 0 && e.simulation_frame > e.frame {
        delta := e.simulation_frame - e.frame
        // Stream time stays continuous while simulation time jumps to anchor timed voices.
        changed := false
        for &c in e.events[:e.event_count] {
            if uses_stream_time(c) {
                c.at += delta
                changed = true
            }
        }
        if changed {
            for parent := e.event_count / 2; parent > 0; parent -= 1 {
                sift_down(e, parent - 1)
            }
        }
        e.stream_shift += delta
        e.frame = e.simulation_frame
        e.device_ready = false
    }
    for i in 0 ..< len(output) / 2 {
        pair: [2]f32
        if e.lead_remaining > 0 {
            e.lead_phase += f64(w.audioRate) / f64(rate)
            for e.lead_phase >= 1 &&
                e.lead_remaining > 0 { e.lead_remaining -= 1; e.lead_phase -= 1 }
        } else if !e.paused || e.fade.remaining > 0 {
            if !e.device_ready {
                e.previous = logical_frame(
                    e,
                ); e.next = logical_frame(e); e.device_phase = 0; e.device_ready = true
            }
            for channel in 0 ..< 2 {
                pair[channel] = f32(
                    (f64(e.previous[channel]) +
                        (f64(e.next[channel]) - f64(e.previous[channel])) * e.device_phase) *
                    e.fade.value,
                )
            }
            e.device_phase += f64(w.audioRate) / f64(rate)
            for e.device_phase >=
                1 { e.previous = e.next; e.next = logical_frame(e); e.device_phase -= 1 }
            advance(&e.fade)
        }
        output[i * 2] = pair[0]; output[i * 2 + 1] = pair[1]
    }
    store(&e.published_frame, e.frame)
    store(&e.published_stream_frame, e.frame - e.stream_shift)
    store(&e.published_leading, u32(e.lead_remaining > 0))
    store(&e.processed, e.processed_local)
    store(&e.late, e.late_local)
    store(&e.underruns, e.underruns_local)
    store(&e.rejected_writes, e.rejected_local)
    store(&e.completed, e.completed_local)
}
