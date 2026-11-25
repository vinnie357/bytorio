package audio_test

import mixer "../../runtime/odin/audio"
import w "../../runtime/odin/resource_protocol"
import resources "../../runtime/odin/resources"
import audio "../../sdk/odin/audio"
import data "../../sdk/odin/data"
import t "../../sdk/odin/resource"
import "core:sync"
import "core:testing"

@(test)
ogg_feed_clock_during_resume_preserves_buffered_stream_pcm :: proc(test: ^testing.T) {
    poison: Poisoning_Allocator
    allocator := context.allocator
    context.allocator = poisoning_allocator(&poison, allocator)
    defer poisoning_allocator_destroy(&poison)
    defer context.allocator = allocator
    sync.mutex_lock(&sdk_mutex)
    defer sync.mutex_unlock(&sdk_mutex)
    registry: resources.Registry
    defer resources.close(&registry)
    if !testing.expect(test, resources.reset(&registry, 119, w.oggProtocol)) { return }
    testing.expect(test, t.configure(119))
    t.begin(0)
    stream := audio.stream()
    audio.play_stream(audio.voice(0), stream)
    sample_pcm := data.pcm(32, 1)
    defer data.free_pcm(&sample_pcm)
    for &value in sample_pcm.samples { value = 0.5 }
    sample := audio.sample({frames = 32, channels = 1, rate = w.audioRate}, sample_pcm)
    if !testing.expect(test, commit(&registry), registry.error) { return }
    testing.expect(test, t.ack(1))
    engine := registry.audio
    engine.lead_remaining = 0
    id := t.Handle(stream).id
    // Model an open decoder at the PCM admission seam, as in ogg_admission_test.
    registry.ogg[0] = {
        id     = id,
        frames = w.maxStreamFrames,
    }
    pcm: [w.oggChunkFrames * 2]f32
    for &value in pcm { value = 0.25 }
    if !testing.expect(test, resources.ogg_feed(&registry, 0, id, 0, pcm[:])) { return }
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
    remaining := engine.streams[0].chunks[0].end - engine.frame
    if !testing.expect(test, remaining >= 512, "At least 512 frames of chunk 0 remain") { return }

    for tick in 1 ..= 54 {
        t.begin(u64(tick))
        if tick == 54 {
            audio.play_sample(audio.voice(1), sample, {at = u64(54 * w.audioFramesPerTick + 128)})
        }
        if !testing.expect(test, commit(&registry), registry.error) { return }
        testing.expect(test, t.ack(u32(tick + 1)))
    }
    testing.expect_value(test, registry.tick, u64(54))
    for &value in pcm { value = 0.125 }
    if !testing.expect(
        test,
        resources.ogg_feed(&registry, 0, id, registry.ogg[0].next_frame, pcm[:]),
    ) { return }
    testing.expect_value(test, registry.ogg[0].next_frame, u64(2 * w.oggChunkFrames))
    mixer.pause(engine, false)
    lead: [w.audioLeadFrames * 2]f32
    mixer.render(engine, lead[:])
    silent := true
    for value in lead { silent = silent && value == 0 }
    testing.expect(test, silent)
    testing.expect_value(test, engine.published_frame, u64(54 * w.audioFramesPerTick))

    output: [1280 * 2]f32
    mixer.render(engine, output[:])
    testing.expect_value(test, engine.underruns, u64(0))
    first_chunk, second_chunk, continuous, timed_sample := true, true, true, true
    for frame in w.audioPauseFadeFrames ..< len(output) / 2 {
        shot: f32 = 0.5 if frame >= 128 && frame < 160 else 0
        for channel in 0 ..< 2 {
            value := output[frame * 2 + channel]
            // Allow the resampler's two prefetched frames at the chunk boundary.
            if u64(frame) + 2 < remaining {
                first_chunk = first_chunk && value == 0.25 + shot
            } else if u64(frame) > remaining + 2 {
                second_chunk = second_chunk && value == 0.125
            }
            continuous = continuous && (value == 0.25 + shot || value == 0.125 + shot)
            if frame >= 120 && frame < 168 {
                timed_sample = timed_sample && value - output[120 * 2 + channel] == shot
            }
        }
    }
    testing.expect(test, first_chunk, "Buffered Ogg PCM stays audible after resume lead")
    testing.expect(test, second_chunk, "The real Ogg feed's next chunk is played")
    testing.expect(test, continuous, "No PCM gap across the Ogg chunk boundary")
    testing.expect(
        test,
        timed_sample,
        "One-shot starts 128 frames after the simulation anchor and lasts 32 frames",
    )

    request := resources.ogg_request(&registry, 0)
    testing.expect_value(test, request[2], u32(2 * w.oggChunkFrames))
    testing.expect_value(test, request[4], u32(2 * w.oggChunkFrames))
    for &value in pcm { value = 0.5 }
    if !testing.expect(
        test,
        resources.ogg_feed(&registry, 0, id, registry.ogg[0].next_frame, pcm[:]),
    ) { return }
    following: [w.oggChunkFrames * 2]f32
    mixer.render(engine, following[:])
    testing.expect_value(test, engine.underruns, u64(0))
    continuous = true
    for value in following { continuous = continuous && (value == 0.125 || value == 0.5) }
    testing.expect(
        test,
        continuous,
        "Post-jump Ogg requests preserve the decoder cursor without a gap",
    )
    testing.expect_value(test, following[len(following) - 1], f32(0.5))
}

@(test)
ogg_created_before_lead_jump_feeds_before_start_is_applied :: proc(test: ^testing.T) {
    poison: Poisoning_Allocator
    allocator := context.allocator
    context.allocator = poisoning_allocator(&poison, allocator)
    defer poisoning_allocator_destroy(&poison)
    defer context.allocator = allocator
    sync.mutex_lock(&sdk_mutex)
    defer sync.mutex_unlock(&sdk_mutex)
    registry: resources.Registry
    defer resources.close(&registry)
    if !testing.expect(test, resources.reset(&registry, 120, w.oggProtocol)) { return }
    testing.expect(test, t.configure(120))
    t.begin(0)
    if !testing.expect(test, commit(&registry), registry.error) { return }
    testing.expect(test, t.ack(1))
    t.begin(1)
    stream := audio.stream()
    audio.play_stream(audio.voice(0), stream)
    if !testing.expect(test, commit(&registry), registry.error) { return }
    testing.expect(test, t.ack(2))
    engine := registry.audio
    id := t.Handle(stream).id
    // The decoder's first chunk begins at the current stream frame, before DSP activation.
    registry.ogg[0] = {
        id     = id,
        frames = w.maxStreamFrames,
    }
    lead: [w.audioLeadFrames * 2]f32
    mixer.render(engine, lead[:])
    testing.expect_value(test, engine.published_frame, u64(w.audioFramesPerTick))
    testing.expect(test, !engine.streams[0].live, "Stream start is still queued at the lead jump")
    pcm: [w.oggChunkFrames * 2]f32
    for &value in pcm { value = 0.25 }
    request := resources.ogg_request(&registry, 0)
    testing.expect_value(test, request[4], u32(0))
    if !testing.expect(test, resources.ogg_feed(&registry, 0, id, 0, pcm[:])) { return }
    output: [512 * 2]f32
    mixer.render(engine, output[:])
    testing.expect_value(test, engine.underruns, u64(0))
    testing.expect_value(test, engine.rejected_writes, u64(0))
    audible := true
    for value in output { audible = audible && value == 0.25 }
    testing.expect(
        test,
        audible,
        "A stream not yet live at the jump still plays its first fed chunk",
    )
}
