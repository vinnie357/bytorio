package audio_mixer

import w "../resource_protocol"

PACKET_MAGIC :: u32(0x31505541)
FEEDBACK_MAGIC :: u32(0x31465541)
// The high bit carries lead state beside the 53-bit stream frame without enlarging feedback.
FEEDBACK_LEAD_FLAG :: u64(1) << 63
word :: proc(b: []u8, at: int) -> u32 {
    return u32(b[at]) | u32(b[at + 1]) << 8 | u32(b[at + 2]) << 16 | u32(b[at + 3]) << 24
}
put :: proc(b: []u8, at: int, n: u32) {
    for i in 0 ..< 4 { b[at + i] = u8(n >> u32(i * 8)) }
}
put64 :: proc(b: []u8, at: int, n: u64) { put(b, at, u32(n)); put(b, at + 4, u32(n >> 32)) }
wide :: proc(b: []u8, at: int) -> u64 { return u64(word(b, at)) | u64(word(b, at + 4)) << 32 }
encode :: proc(b: []u8, c: Command, offset, size: u32) {
    fields := [24]u32 {
        u32(c.at),
        u32(c.at >> 32),
        u32(c.order),
        u32(c.order >> 32),
        c.op,
        c.id,
        c.lease,
        c.page,
        c.frames,
        c.channels,
        c.source_rate,
        c.bus,
        c.parent,
        c.resource,
        c.loop_start,
        c.loop_end,
        transmute(u32)c.rate,
        transmute(u32)c.gain,
        transmute(u32)c.pan,
        c.parameter,
        c.ramp,
        offset,
        size,
        0,
    }
    for n, i in fields { put(b, i * 4, n) }
}
decode :: proc(b: []u8) -> Command {
    return {
        at          = wide(b, 0),
        order       = wide(b, 8),
        op          = word(b, 16),
        id          = word(b, 20),
        lease       = word(b, 24),
        page        = word(b, 28),
        frames      = word(b, 32),
        channels    = word(b, 36),
        source_rate = word(b, 40),
        bus         = word(b, 44),
        parent      = word(b, 48),
        resource    = word(b, 52),
        loop_start  = word(b, 56),
        loop_end    = word(b, 60),
        rate        = transmute(f32)word(b, 64),
        gain        = transmute(f32)word(b, 68),
        pan         = transmute(f32)word(b, 72),
        parameter   = word(b, 76),
        ramp        = word(b, 80),
    }
}
valid_command :: proc(c: Command) -> bool {
    if c.op == w.op_audio_stream_end {
        return c.id < w.maxStreams && c.lease == 0 && c.at <= w.audioMaxExactFrame
    }
    if c.op >=
       w.op_audio_wavetable { return c.at <= w.audioMaxExactFrame && c.ramp <= w.audioHorizonFrames && valid_synthesis_command(c) }
    if c.at > w.audioMaxExactFrame || c.ramp > w.audioHorizonFrames { return false }
    switch c.op {
    case w.op_audio_bus:
        return(
            c.id > 0 &&
            c.id < w.maxBuses &&
            c.parent < w.maxBuses &&
            finite(c.gain, 0, 4) &&
            c.lease == 0 \
        )
    case w.op_audio_stream:
        return c.id < w.maxStreams && c.lease == 0
    case w.op_audio_destroy:
        return(
            ((c.parameter == 9 && c.id > 0 && c.id < w.maxBuses) ||
                (c.parameter == 10 && c.id < w.maxStreams)) &&
            c.lease == 0 \
        )
    case w.op_audio_play_sample:
        return(
            c.id < w.maxVoices &&
            c.bus < w.maxBuses &&
            c.lease > 0 &&
            c.frames > 0 &&
            c.parameter <= 1 &&
            (c.parameter == 0 ||
                    (source_slot(c.resource) >= 0 && source_slot(c.resource) < w.maxSlots)) &&
            (c.channels == 1 || c.channels == 2) &&
            c.source_rate >= w.minSampleRate &&
            c.source_rate <= w.maxSampleRate &&
            finite(c.rate, 0.0625, 16) &&
            finite(c.gain, 0, 4) &&
            finite(c.pan, -1, 1) &&
            (c.loop_end == 0 || (c.loop_start < c.loop_end && c.loop_end <= c.frames)) \
        )
    case w.op_audio_play_stream:
        return(
            c.id < w.maxVoices &&
            c.bus < w.maxBuses &&
            finite(c.gain, 0, 4) &&
            finite(c.pan, -1, 1) &&
            c.lease == 0 \
        )
    case w.op_audio_stop, w.op_audio_release:
        return c.id < w.maxVoices && c.lease == 0
    case w.op_audio_voice_control:
        return(
            c.id < w.maxVoices &&
            c.parameter <= 1 &&
            c.lease == 0 &&
            (finite(c.gain, 0, 4) if c.parameter == 0 else finite(c.pan, -1, 1)) \
        )
    case w.op_audio_bus_gain:
        return c.id < w.maxBuses && finite(c.gain, 0, 4) && c.lease == 0
    case w.op_audio_stream_write:
        return(
            c.id < w.maxStreams &&
            c.lease > 0 &&
            c.channels == 2 &&
            c.frames > 0 &&
            c.frames <= w.maxStreamFrames \
        )
    }
    return false
}
// Producer-only serialization. The caller supplies a recycled, bounded transfer.
export_batch :: proc(e: ^Engine, destination: []u8) -> int {
    if e == nil { return 0 }
    tail := e.tail
    if tail == e.head { return 0 }
    batch := &e.batches[tail % w.maxAudioBatches]
    bytes := w.audioPacketHeaderBytes + int(batch.count) * w.audioEventBytes
    for c in batch.commands[:batch.count] { if c.lease != 0 { bytes += int(c.frames * c.channels) * 4 } }
    if bytes > len(destination) { return -bytes }
    put(destination, 0, PACKET_MAGIC); put(destination, 4, batch.count)
    put(destination, 8, u32(bytes)); put(destination, 12, 0)
    put64(destination, w.audioPacketSimulationFrameOffset, batch.simulation_frame)
    cursor := w.audioPacketHeaderBytes + int(batch.count) * w.audioEventBytes
    for c, i in batch.commands[:batch.count] {
        size := int(c.frames * c.channels) * 4 if c.lease != 0 else 0
        encode(
            destination[w.audioPacketHeaderBytes + i * w.audioEventBytes:][:w.audioEventBytes],
            c,
            u32(cursor) if size > 0 else 0,
            u32(size),
        )
        if size > 0 {
            src := (cast([^]u8)raw_data(e.pool))[int(c.page) * w.audioPageFrames * 4:][:size]
            copy(destination[cursor:][:size], src); cursor += size
        }
    }
    e.tail = tail + 1
    return bytes
}
// Worklet message handling, never process(): bounded validation/copy into already
// allocated slots. Native uses the same command structs without serialization.
import_batch :: proc(e: ^Engine, bytes: []u8) -> bool {
    if e == nil ||
       len(bytes) < w.audioPacketHeaderBytes ||
       len(bytes) > w.maxAudioPacketBytes ||
       word(bytes, 0) != PACKET_MAGIC ||
       word(bytes, 8) != u32(len(bytes)) ||
       word(bytes, 12) != 0 { return false }
    simulation_frame := wide(bytes, w.audioPacketSimulationFrameOffset)
    if simulation_frame > w.audioMaxExactFrame { return false }
    count := word(bytes, 4)
    start := w.audioPacketHeaderBytes + u64(count) * w.audioEventBytes
    if count == 0 ||
       count > w.maxAudioEvents ||
       start > u64(len(bytes)) ||
       e.head - e.tail == w.maxAudioBatches ||
       e.submitted - e.processed + u64(count) > w.maxAudioEvents { return false }
    // Check the complete host-produced packet before publishing or copying.
    occupied := e.pages
    model := e.model
    seen: [w.maxAudioLeases]bool
    for i in 0 ..< int(count) {
        b := bytes[w.audioPacketHeaderBytes + i * w.audioEventBytes:][:w.audioEventBytes]
        c := decode(b)
        offset, size := word(b, 84), word(b, 88)
        if !valid_command(c) ||
           c.order != e.order + u64(i) ||
           c.lease > w.maxAudioLeases ||
           word(b, 92) != 0 { return false }
        if c.lease != 0 {
            if u64(offset) < start ||
               u64(offset) + u64(size) > u64(len(bytes)) ||
               u64(size) != u64(c.frames) * u64(c.channels) * 4 ||
               u64(c.page) * w.audioPageFrames * 4 + u64(size) > w.maxAudioSnapshotBytes ||
               e.leases[c.lease - 1].live { return false }
            if seen[c.lease - 1] || c.page >= PAGE_COUNT { return false }
            seen[c.lease - 1] = true
            pages := (u64(size) + w.audioPageFrames * 4 - 1) / (w.audioPageFrames * 4)
            if u64(c.page) + pages > PAGE_COUNT { return false }
            for page in u64(c.page) ..< u64(c.page) + pages {
                if occupied[page] { return false }
                occupied[page] = true
            }
            if c.op != w.op_audio_instrument && c.op != w.op_audio_effects {
                for at := int(offset); at < int(offset) + int(size); at += 4 {
                    if !finite(transmute(f32)word(bytes, at), -1, 1) { return false }
                }
            }
        } else if size != 0 || offset != 0 { return false }
        if c.op >= w.op_audio_wavetable &&
           c.op != w.op_audio_stream_end &&
           !validate_prepared_synthesis(
                   c,
                   bytes[int(offset):][:int(size)],
                   &model,
               ) { return false }
    }
    batch := &e.batches[e.head % w.maxAudioBatches]
    batch.count = count
    batch.simulation_frame = simulation_frame
    for i in 0 ..< int(count) {
        b := bytes[w.audioPacketHeaderBytes + i * w.audioEventBytes:][:w.audioEventBytes]
        c := decode(b)
        batch.commands[i] = c
        if c.lease != 0 {
            size, offset := int(word(b, 88)), int(word(b, 84))
            pages := u32((size + w.audioPageFrames * 4 - 1) / (w.audioPageFrames * 4))
            e.leases[c.lease - 1] = {
                page  = c.page,
                pages = pages,
                live  = true,
            }
            for page in c.page ..< c.page + pages { e.pages[page] = true }
            e.used += u64(pages) * w.audioPageFrames * 4
            copy(
                (cast([^]u8)raw_data(e.pool))[int(c.page) * w.audioPageFrames * 4:][:size],
                bytes[offset:][:size],
            )
        }
    }
    e.submitted += u64(count)
    e.model = model
    e.order += u64(count)
    e.head += 1
    return true
}
feedback :: proc(e: ^Engine, destination: []u8) -> int {
    if e == nil { return 0 }
    tail, head := e.done_tail, e.done_head
    count := head - tail
    size := 80 + int(count) * 32
    if len(destination) < size { return -size }
    put(destination, 0, FEEDBACK_MAGIC); put(destination, 4, u32(size)); put(destination, 8, count)
    put(destination, 12, e.epoch)
    values := [8]u64 {
        e.published_frame,
        e.processed,
        e.late,
        e.underruns,
        e.rejected_writes,
        e.completed,
        e.used,
        e.published_stream_frame | (FEEDBACK_LEAD_FLAG if e.published_leading != 0 else 0),
    }
    for value, i in values { put64(destination, 16 + i * 8, value) }
    for i in 0 ..< int(count) {
        d := e.done[(tail + u32(i)) % DONE_CAPACITY]
        at := 80 + i * 32
        put(
            destination,
            at,
            d.lease,
        ); put(destination, at + 4, d.voice); put(destination, at + 8, d.reason); put(destination, at + 12, 0)
        put64(destination, at + 16, d.frame); put64(destination, at + 24, d.serial)
        release_lease(e, d.lease)
    }
    e.done_tail = head
    return size
}
import_feedback :: proc(e: ^Engine, bytes: []u8) -> bool {
    if e == nil ||
       len(bytes) < 80 ||
       word(bytes, 0) != FEEDBACK_MAGIC ||
       word(bytes, 4) != u32(len(bytes)) ||
       word(bytes, 8) > DONE_CAPACITY ||
       u64(word(bytes, 8)) * 32 + 80 != u64(len(bytes)) { return false }
    if wide(bytes, 16) > w.audioMaxExactFrame || wide(bytes, 24) > e.submitted { return false }
    stream_clock := wide(bytes, 72)
    stream_frame := stream_clock & w.audioMaxExactFrame
    if stream_clock & ~(u64(w.audioMaxExactFrame) | FEEDBACK_LEAD_FLAG) != 0 ||
       stream_frame > wide(bytes, 16) { return false }
    seen: [w.maxAudioLeases]bool
    for i in 0 ..< int(word(bytes, 8)) {
        at := 80 + i * 32
        lease, voice := word(bytes, at), word(bytes, at + 4)
        if lease > w.maxAudioLeases ||
           (voice != NO_VOICE && voice >= w.maxVoices) ||
           word(bytes, at + 12) != 0 ||
           wide(bytes, at + 16) > w.audioMaxExactFrame { return false }
        if lease > 0 {
            if seen[lease - 1] || !e.leases[lease - 1].live { return false }
            seen[lease - 1] = true
        }
    }
    e.published_frame = max(e.published_frame, wide(bytes, 16))
    e.published_stream_frame = max(e.published_stream_frame, stream_frame)
    e.published_leading = u32(stream_clock & FEEDBACK_LEAD_FLAG != 0)
    e.processed = max(e.processed, wide(bytes, 24))
    e.late, e.underruns, e.rejected_writes, e.completed =
        wide(bytes, 32), wide(bytes, 40), wide(bytes, 48), wide(bytes, 56)
    e.epoch = word(bytes, 12)
    for i in 0 ..< int(word(bytes, 8)) {
        at := 80 + i * 32
        lease := word(bytes, at)
        voice := word(bytes, at + 4)
        if lease > w.maxAudioLeases || (voice != NO_VOICE && voice >= w.maxVoices) { return false }
        accept_done(
            e,
            {lease, voice, word(bytes, at + 8), wide(bytes, at + 16), wide(bytes, at + 24)},
        )
    }
    return true
}
write_status :: proc(e: ^Engine, bytes: []u8) {
    for &b in bytes[:w.audioStatusBytes] { b = 0 }
    put(bytes, 8, w.audioLeadFrames)
    if e == nil { return }
    reclaim(e)
    put64(bytes, 0, load(&e.published_frame)); put(bytes, 12, load(&e.epoch))
    put64(
        bytes,
        16,
        load(&e.late),
    ); put64(bytes, 24, load(&e.underruns)); put64(bytes, 32, load(&e.rejected_writes))
    put64(bytes, 40, load(&e.completed)); put64(bytes, 48, e.completion_overflow)
    put(bytes, 56, u32(e.submitted - load(&e.processed)))
    count := min(e.completion_head - e.completion_tail, w.audioMailboxCompletions)
    put(bytes, 60, count)
    for i in 0 ..< int(count) {
        d := e.completions[e.completion_tail % w.maxAudioCompletions]
        e.completion_tail += 1
        at := 64 + i * 24
        put(
            bytes,
            at,
            d.voice,
        ); put(bytes, at + 4, d.reason); put64(bytes, at + 8, d.frame); put64(bytes, at + 16, d.serial)
    }
}
