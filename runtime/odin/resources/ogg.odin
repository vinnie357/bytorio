package resources

import audio "../audio"
import cartridge "../cartridge"
import w "../resource_protocol"
import "core:math"

Ogg_Stream :: struct {
    id, content, frames, cursor, loop_start, loop_end, bytes: u32,
    next_frame:                                               u64,
    ended:                                                    bool,
}

// Container bounds and the supported identification profile are checked before
// publication. Codec setup errors are reported by the host decoder on activation.
ogg_info :: proc(bytes: []u8) -> (frames: u32, ok: bool) {
    if len(bytes) < 58 || len(bytes) > w.maxOggSourceBytes { return }
    offset, sequence := 0, u32(0)
    serial := u32le(bytes, 14)
    for offset < len(bytes) {
        if len(bytes) - offset < 27 { return 0, false }
        page := bytes[offset:]
        if string(page[:4]) != "OggS" ||
           page[4] != 0 ||
           u32le(page, 14) != serial ||
           u32le(page, 18) != sequence { return 0, false }
        segments := int(page[26])
        if len(page) < 27 + segments { return 0, false }
        body := 0
        for n in page[27:][:segments] { body += int(n) }
        size := 27 + segments + body
        if size > len(page) { return 0, false }
        if sequence == 0 {
            if page[5] != 2 || body < 30 { return 0, false }
            header := page[27 + segments:][:body]
            if header[0] != 1 ||
               string(header[1:7]) != "vorbis" ||
               u32le(header, 7) != 0 ||
               (header[11] != 1 && header[11] != 2) ||
               u32le(header, 12) != w.audioRate ||
               header[29] != 1 { return 0, false }
        } else if page[5] & 2 != 0 { return 0, false }
        if page[5] & 4 != 0 {
            if offset + size != len(bytes) || u32le(page, 10) != 0 { return 0, false }
            frames = u32le(page, 6)
            return frames, frames > 0
        }
        offset += size
        sequence += 1
    }
    return 0, false
}

ogg_command :: proc(
    t: ^Transaction,
    id: u32,
    args: [8]u32,
    data: []u8,
    phase: u32,
    tick: u64,
) -> bool {
    r := t.registry
    if r.protocol < w.oggProtocol || phase == 2 || len(data) != 0 || args[1] > 1 {
        return fail(r, "Ogg streaming requires its profile and init/update")
    }
    for i in 4 ..< 8 { if args[i] != 0 { return fail(r, "nonzero Ogg padding") } }
    bytes := cartridge.content_blob(r.content, args[0])
    frames, ok := ogg_info(bytes)
    if !ok { return fail(r, "Ogg requires a single 48 kHz mono/stereo Vorbis content entry") }
    if (args[1] == 0 && (args[2] != 0 || args[3] != 0)) ||
       (args[1] != 0 && (args[2] >= args[3] || args[3] > frames)) {
        return fail(r, "invalid Ogg loop range")
    }
    retained := len(bytes)
    for stream in t.ogg { retained += int(stream.bytes) }
    if retained > w.maxOggEncodedBytes { return fail(r, "Ogg encoded input budget exceeded") }
    if !t.ogg_reserved {
        if t.retained + w.maxOggDecoderBytes >
           t.budget { return fail(r, "Ogg decoder budget exceeded") }
        t.retained += w.maxOggDecoderBytes
        t.ogg_reserved = true
    }
    if !audio_command(t, w.op_audio_stream, id, {}, nil, phase, tick) { return false }
    index, valid := audio.stream_index(&t.audio.model, id)
    if !valid { return fail(r, "Ogg stream allocation failed") }
    t.ogg[index] = {
        id         = id,
        content    = args[0],
        frames     = frames,
        bytes      = u32(len(bytes)),
        loop_start = args[2],
        loop_end   = args[3],
        next_frame = tick * w.audioFramesPerTick,
    }
    return true
}

ogg_advance :: proc(s: ^Ogg_Stream, frames: u64) {
    end := s.loop_end if s.loop_end != 0 else s.frames
    remaining := u64(end - s.cursor)
    if frames < remaining { s.cursor += u32(frames); return }
    if s.loop_end == 0 { s.cursor = s.frames; return }
    s.cursor = s.loop_start + u32((frames - remaining) % u64(s.loop_end - s.loop_start))
}

// Producer-only pull contract. A stale response cannot write to a reused handle.
ogg_request :: proc(r: ^Registry, index: u32) -> [w.oggRequestWords]u32 {
    if index >= w.maxOggStreams || r.audio == nil { return {} }
    s := &r.ogg[index]
    if s.id == 0 || s.ended { return {} }
    frame := audio.load(&r.audio.published_frame)
    if s.next_frame < frame {
        target := frame + w.audioLeadFrames
        ogg_advance(s, target - s.next_frame)
        s.next_frame = target
    }
    count :=
        u32(w.oggChunkFrames) if s.loop_end != 0 else min(w.oggChunkFrames, s.frames - s.cursor)
    if s.next_frame + u64(count) > frame + w.maxStreamFrames { count = 0 }
    return {
        s.id,
        s.content,
        s.cursor,
        s.frames,
        u32(s.next_frame),
        u32(s.next_frame >> 32),
        count,
        s.bytes,
        s.loop_start,
        s.loop_end,
    }
}

ogg_feed :: proc(r: ^Registry, index, id: u32, at: u64, pcm: []f32) -> bool {
    if id == 0 || index >= w.maxOggStreams || r.audio == nil || len(pcm) % 2 != 0 { return false }
    // Decoder prefetch is opportunistic. Keep the final producer batch for a
    // game transaction; the host retries this same PCM range after egress.
    if audio.producer_batches_available(r.audio) <= 1 { return false }
    request := ogg_request(r, index)
    if request[0] != id || at != (u64(request[4]) | u64(request[5]) << 32) { return false }
    frames := u32(len(pcm) / 2)
    if frames > request[6] || (frames == 0 && request[2] != request[3]) { return false }
    for &value in pcm {
        if math.is_nan(value) || math.is_inf(value) { return false }
        value = clamp(value, -1, 1)
    }
    transaction, ok := audio.begin(r.audio)
    if !ok { return false }
    committed := false
    defer { if !committed { audio.abort(&transaction) } }
    if frames > 0 {
        data := (cast([^]u8)raw_data(pcm))[:len(pcm) * 4]
        lease, page, reserved := audio.snapshot(&transaction, data)
        if !reserved { return false }
        if !audio.append(&transaction, {
            op       = w.op_audio_stream_write,
            id       = index,
            resource = id,
            at       = at,
            frames   = frames,
            channels = 2,
            lease    = lease,
            page     = page,
        }) {
            audio.release_lease(r.audio, lease); return false
        }
    }
    next := r.ogg[index]
    ogg_advance(&next, u64(frames))
    next.next_frame += u64(frames)
    if next.loop_end == 0 && next.cursor == next.frames {
        if !audio.append(
            &transaction,
            {op = w.op_audio_stream_end, id = index, resource = id, at = next.next_frame},
        ) { return false }
        next.ended = true
    }
    transaction.batch.simulation_frame = r.tick * w.audioFramesPerTick
    audio.publish(&transaction)
    r.ogg[index] = next
    committed = true
    return true
}
