package audio_test

import mixer "../../runtime/odin/audio"
import w "../../runtime/odin/resource_protocol"
import "core:testing"

@(test)
ogg_feed_clock_during_resume_preserves_buffered_stream_pcm :: proc(test: ^testing.T) {
    poison: Poisoning_Allocator
    allocator := context.allocator
    context.allocator = poisoning_allocator(&poison, allocator)
    defer poisoning_allocator_destroy(&poison)
    defer context.allocator = allocator
    engine := mixer.create()
    defer mixer.close(engine)
    engine.lead_remaining = 0

    initial, ok := mixer.begin(engine)
    if !testing.expect(test, ok) { return }
    testing.expect(test, mixer.append(&initial, {op = w.op_audio_stream, id = 0, resource = 101}))
    _ = queued_pcm(test, &initial, 0, 101, 0, w.oggChunkFrames, 0.25)
    testing.expect(test, mixer.append(&initial, {
            op       = w.op_audio_play_stream,
            id       = 0,
            resource = 101,
            gain     = 1,
            rate     = 1,
        }))
    mixer.publish(&initial)
    warmup: [16]f32
    mixer.render(engine, warmup[:])
    testing.expect_value(test, warmup[0], f32(0.25))
    testing.expect_value(test, engine.underruns, u64(0))

    mixer.pause(engine, true)
    fade: [w.audioPauseFadeFrames * 2]f32
    mixer.render(engine, fade[:])
    testing.expect(test, engine.paused)
    if !testing.expect_value(test, engine.streams[0].count, 1) { return }
    testing.expect(test, engine.streams[0].chunks[0].first <= engine.frame)
    testing.expect(test, engine.frame + 514 < engine.streams[0].chunks[0].end)

    feed, feed_ok := mixer.begin(engine)
    if !testing.expect(test, feed_ok) { return }
    _ = queued_pcm(test, &feed, 0, 101, w.oggChunkFrames, w.oggChunkFrames, 0.25)
    // Ogg prefetch stamps the simulation clock while PCM stays on the engine timeline.
    feed.batch.simulation_frame = 54 * w.audioFramesPerTick
    mixer.publish(&feed)
    mixer.pause(engine, false)
    lead: [w.audioLeadFrames * 2]f32
    mixer.render(engine, lead[:])
    silent := true
    for value in lead { silent = silent && value == 0 }
    testing.expect(test, silent)

    output: [512 * 2]f32
    mixer.render(engine, output[:])
    testing.expect_value(test, engine.underruns, u64(0))
    // Resume fades in over 64 frames; the remainder must be the queued PCM.
    buffered_pcm := true
    for value in output[w.audioPauseFadeFrames * 2:] {
        buffered_pcm = buffered_pcm && value == 0.25
    }
    testing.expect(test, buffered_pcm, "Buffered Ogg PCM must remain audible after resume lead")
}
