package audio_test

import mixer "../../runtime/odin/audio"
import w "../../runtime/odin/resource_protocol"
import resources "../../runtime/odin/resources"
import audio "../../sdk/odin/audio"
import t "../../sdk/odin/resource"
import "core:os"
import "core:sync"
import "core:testing"

@(test)
ogg_startup_after_serialized_clock_feedback_preserves_first_writes :: proc(test: ^testing.T) {
    ogg_startup_transport(test, false)
}

@(test)
ogg_startup_during_serialized_lead_preserves_first_writes :: proc(test: ^testing.T) {
    ogg_startup_transport(test, true)
}

ogg_startup_transport :: proc(test: ^testing.T, leading: bool) {
    poison: Poisoning_Allocator
    allocator := context.allocator
    context.allocator = poisoning_allocator(&poison, allocator)
    defer poisoning_allocator_destroy(&poison)
    defer context.allocator = allocator
    sync.mutex_lock(&sdk_mutex)
    defer sync.mutex_unlock(&sdk_mutex)
    encoded, err := os.read_entire_file("tests/ogg/fixtures/tone.ogg", context.allocator)
    if !testing.expect(test, err == nil) { return }
    defer delete(encoded)
    index: [12]u8
    resources.put32(index[:], 0, 1)
    resources.put32(index[:], 8, u32(len(encoded)))
    registry: resources.Registry
    registry.content = {
        index = index[:],
        data  = encoded,
    }
    defer resources.close(&registry)
    if !testing.expect(test, resources.reset(&registry, 121, w.oggProtocol)) { return }
    testing.expect(test, t.configure(121))
    t.begin(0)
    audio.bus_gain(audio.master(), 1)
    if !testing.expect(test, commit(&registry), registry.error) { return }
    testing.expect(test, t.ack(1))
    t.begin(1)
    audio.bus_gain(audio.master(), 1)
    if !testing.expect(test, commit(&registry), registry.error) { return }
    testing.expect(test, t.ack(2))
    producer := registry.audio
    consumer := mixer.create()
    defer mixer.close(consumer)
    packet := make([]u8, w.maxAudioPacketBytes)
    defer delete(packet)
    if !transfer_audio_batches(test, producer, consumer, packet) { return }
    warmup: [(w.audioLeadFrames + 5598) * 2]f32
    mixer.render(consumer, warmup[:512] if leading else warmup[:])
    testing.expect_value(test, consumer.published_frame, u64(800 if leading else 6400))
    testing.expect_value(test, consumer.published_stream_frame, u64(0 if leading else 5600))
    feedback := make([]u8, w.maxAudioFeedbackBytes)
    defer delete(feedback)
    size := mixer.feedback(consumer, feedback)
    if !testing.expect(test, mixer.import_feedback(producer, feedback[:size])) { return }
    testing.expect_value(test, producer.published_stream_frame, u64(0 if leading else 5600))
    testing.expect_value(test, producer.published_leading, u32(leading))
    // The worklet advances between feedback and delivery of the worker's new stream.
    in_flight: [128 * 2]f32
    mixer.render(consumer, in_flight[:])
    for tick in 2 ..= 12 {
        t.begin(u64(tick))
        if tick == 12 {
            music := audio.ogg_stream(1)
            audio.play_stream(audio.voice(0), music, {gain = f32(0.5)})
        }
        if !testing.expect(test, commit(&registry), registry.error) { return }
        testing.expect(test, t.ack(u32(tick + 1)))
    }
    pcm: [w.oggChunkFrames * 2]f32
    for &value in pcm { value = 0.25 }
    for _ in 0 ..< 4 {
        request := resources.ogg_request(&registry, 0)
        at := u64(request[4]) | u64(request[5]) << 32
        if !testing.expect(
            test,
            resources.ogg_feed(&registry, 0, request[0], at, pcm[:]),
        ) { return }
    }
    if !transfer_audio_batches(test, producer, consumer, packet) { return }
    output: [4096 * 2]f32
    mixer.render(consumer, output[:])
    testing.expect_value(test, consumer.rejected_writes, u64(0))
    testing.expect_value(test, consumer.underruns, u64(0))
    testing.expect_value(test, output[len(output) - 1], f32(0.125))
    size = mixer.feedback(consumer, feedback)
    testing.expect(test, mixer.import_feedback(producer, feedback[:size]))
    testing.expect_value(test, producer.rejected_writes, u64(0))
}
