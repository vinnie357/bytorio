package audio_test

import mixer "../../runtime/odin/audio"
import w "../../runtime/odin/resource_protocol"
import "core:testing"

@(test)
raw_stream_engine_clock_survives_startup_jump_direct :: proc(test: ^testing.T) {
    raw_stream_startup_clock(test, false)
}

@(test)
raw_stream_engine_clock_survives_startup_jump_serialized :: proc(test: ^testing.T) {
    raw_stream_startup_clock(test, true)
}

raw_stream_startup_clock :: proc(test: ^testing.T, serialized: bool) {
    poison: Poisoning_Allocator
    allocator := context.allocator
    context.allocator = poisoning_allocator(&poison, allocator)
    defer poisoning_allocator_destroy(&poison)
    defer context.allocator = allocator
    producer := mixer.create()
    defer mixer.close(producer)
    consumer := producer
    if serialized { consumer = mixer.create() }
    defer { if consumer != producer { mixer.close(consumer) } }
    simulation_frame := u64(43200)
    first := simulation_frame + 512
    tx, ok := mixer.begin(producer)
    if !testing.expect(test, ok) { return }
    tx.batch.simulation_frame = simulation_frame
    testing.expect(
        test,
        mixer.append(&tx, {op = w.op_audio_stream, id = 0, resource = 101, at = simulation_frame}),
    )
    pcm: [192 * 2]f32
    for chunk in 0 ..< 2 {
        count := 192 if chunk == 0 else 64
        for frame in 0 ..< count {
            pcm[frame * 2] = 0.2 if chunk == 0 else 0.4
            pcm[frame * 2 + 1] = -pcm[frame * 2]
        }
        bytes := (cast([^]u8)raw_data(pcm[:]))[:count * 2 * 4]
        lease, page, copied := mixer.snapshot(&tx, bytes)
        if !testing.expect(test, copied) { return }
        testing.expect(test, mixer.append(&tx, {
                op       = w.op_audio_stream_write,
                id       = 0,
                resource = 101,
                at       = first + u64(0 if chunk == 0 else 192),
                frames   = u32(count),
                channels = 2,
                lease    = lease,
                page     = page,
            }))
    }
    testing.expect(test, mixer.append(&tx, {
            op       = w.op_audio_play_stream,
            id       = 0,
            resource = 101,
            at       = first,
            gain     = 0.5,
            rate     = 1,
        }))
    testing.expect(test, mixer.append(&tx, {
            op       = w.op_audio_stream_end,
            id       = 0,
            resource = 101,
            at       = first + 256,
        }))
    mixer.publish(&tx)
    if serialized {
        packet := make([]u8, w.maxAudioPacketBytes)
        defer delete(packet)
        if !transfer_audio_batches(test, producer, consumer, packet) { return }
    }
    lead: [w.audioLeadFrames * 2]f32
    mixer.render(consumer, lead[:])
    testing.expect_value(test, consumer.published_frame, simulation_frame)
    output: [800 * 2]f32
    mixer.render(consumer, output[:])
    first_chunk, second_chunk, silent := true, true, true
    for frame in 0 ..< 800 {
        for channel in 0 ..< 2 {
            value := output[frame * 2 + channel]
            sign: f32 = 1 if channel == 0 else -1
            if frame >= 512 && frame < 704 {
                first_chunk = first_chunk && value == sign * 0.1
            } else if frame >= 704 && frame < 768 {
                second_chunk = second_chunk && value == sign * 0.2
            } else {
                silent = silent && value == 0
            }
        }
    }
    testing.expect(
        test,
        first_chunk,
        "Raw engine-time PCM starts on time and plays all 192 frames",
    )
    testing.expect(test, second_chunk, "The following raw chunk plays without a gap")
    testing.expect(test, silent, "Raw PCM remains silent outside its engine-time interval")
    testing.expect_value(test, consumer.underruns, u64(0))
    testing.expect_value(test, consumer.rejected_writes, u64(0))
}
