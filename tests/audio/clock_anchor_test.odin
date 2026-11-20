package audio_test

import mixer "../../runtime/odin/audio"
import w "../../runtime/odin/resource_protocol"
import r "../../runtime/odin/resources"
import audio "../../sdk/odin/audio"
import data "../../sdk/odin/data"
import resource "../../sdk/odin/resource"
import "core:sync"
import "core:testing"

@(test)
simulation_clock_anchors_start_and_resume :: proc(test: ^testing.T) {
    sync.mutex_lock(&sdk_mutex)
    defer sync.mutex_unlock(&sdk_mutex)
    transports := [2]bool{false, true}
    for serialized in transports {
        registry: r.Registry
        defer r.close(&registry)
        testing.expect(test, r.reset(&registry, 118))
        testing.expect(test, resource.configure(118))
        resource.begin(0)
        testing.expect(test, commit(&registry), registry.error)
        testing.expect(test, resource.ack(1))
        for tick in 1 ..= 54 {
            resource.begin(u64(tick))
            if tick == 54 {
                pcm := data.pcm(4, 1)
                defer data.free_pcm(&pcm)
                for &value in pcm.samples { value = 0.5 }
                sample := audio.sample({frames = 4, channels = 1, rate = w.audioRate}, pcm)
                audio.play_sample(audio.voice(0), sample, {loop = true, loop_end = 4})
            }
            testing.expect(test, commit(&registry), registry.error)
            testing.expect(test, resource.ack(u32(tick + 1)))
        }
        consumer := registry.audio
        packet := make([]u8, w.maxAudioPacketBytes)
        defer delete(packet)
        if serialized {
            consumer = mixer.create()
            defer mixer.close(consumer)
            if !transfer_audio_batches(test, registry.audio, consumer, packet) { return }
        }
        lead: [w.audioLeadFrames * 2]f32
        mixer.render(consumer, lead[:])
        testing.expect_value(test, consumer.published_frame, u64(43200))
        for value in lead { testing.expect_value(test, value, f32(0)) }
        first: [2]f32
        mixer.render(consumer, first[:])
        testing.expect_value(test, first[0], f32(0.5))
        testing.expect_value(test, first[1], f32(0.5))

        // A producer ahead of audible DSP must not skip samples outside a lead.
        resource.begin(55)
        audio.bus_gain(audio.master(), 1)
        testing.expect(test, commit(&registry), registry.error)
        testing.expect(test, resource.ack(56))
        if serialized && !transfer_audio_batches(test, registry.audio, consumer, packet) { return }
        before := consumer.published_frame
        mixer.render(consumer, first[:])
        testing.expect_value(test, consumer.published_frame, before + 1)
        testing.expect_value(test, first[0], f32(0.5))

        mixer.pause(consumer, true)
        fading: [w.audioPauseFadeFrames * 2]f32
        mixer.render(consumer, fading[:])
        for tick in 56 ..= 108 {
            resource.begin(u64(tick))
            if tick == 108 {
                pcm := data.pcm(4, 1)
                defer data.free_pcm(&pcm)
                for &value in pcm.samples { value = 0.25 }
                sample := audio.sample({frames = 4, channels = 1, rate = w.audioRate}, pcm)
                audio.play_sample(audio.voice(1), sample)
            }
            testing.expect(test, commit(&registry), registry.error)
            testing.expect(test, resource.ack(u32(tick + 1)))
        }
        if serialized && !transfer_audio_batches(test, registry.audio, consumer, packet) { return }
        // Consume the newest clock while still paused, before the resume edge.
        mixer.render(consumer, first[:])
        mixer.pause(consumer, false)
        mixer.render(consumer, lead[:])
        testing.expect_value(test, consumer.published_frame, u64(86400))
        resumed: [128 * 2]f32
        mixer.render(consumer, resumed[:])
        testing.expect(test, resumed[2] > 0)
        testing.expect(test, resumed[len(resumed) - 2] > 0)
        testing.expect_value(test, consumer.late, u64(1))
        testing.expect_value(test, consumer.completed, u64(1))
    }
}

publish_clock :: proc(test: ^testing.T, producer: ^mixer.Engine, frame, at: u64) {
    tx, ok := mixer.begin(producer)
    testing.expect(test, ok)
    tx.batch.simulation_frame = frame
    testing.expect(test, mixer.append(&tx, {op = w.op_audio_bus_gain, at = at, gain = 1}))
    mixer.publish(&tx)
}

@(test)
lead_tracks_delivered_clock_without_rewinding_or_skipping_audible_pcm :: proc(test: ^testing.T) {
    transports := [2]bool{false, true}
    for serialized in transports {
        producer := tiny(test)
        defer mixer.close(producer)
        producer.batches[0].simulation_frame = 43200
        producer.batches[0].commands[0].at = 43200
        consumer := producer
        packet := make([]u8, w.maxAudioPacketBytes)
        defer delete(packet)
        if serialized {
            consumer = mixer.create()
            defer mixer.close(consumer)
            if !transfer_audio_batches(test, producer, consumer, packet) { return }
        } else {
            consumer.lead_remaining = w.audioLeadFrames
        }
        half_lead: [w.audioLeadFrames]f32
        mixer.render(consumer, half_lead[:])
        testing.expect_value(test, consumer.published_frame, u64(43200))
        publish_clock(test, producer, 44000, 43200)
        if serialized && !transfer_audio_batches(test, producer, consumer, packet) { return }
        first: [2]f32
        mixer.render(consumer, first[:])
        testing.expect_value(test, consumer.published_frame, u64(44000))
        publish_clock(test, producer, 100, 100)
        if serialized && !transfer_audio_batches(test, producer, consumer, packet) { return }
        mixer.render(consumer, half_lead[:])
        testing.expect_value(test, consumer.published_frame, u64(44003))
        testing.expect_value(test, consumer.processed, u64(3))
        testing.expect_value(test, consumer.late, u64(3))
        testing.expect_value(test, half_lead[len(half_lead) - 2], f32(-1))
        publish_clock(test, producer, 600000, 600000)
        if serialized && !transfer_audio_batches(test, producer, consumer, packet) { return }
        output: [8]f32
        mixer.render(consumer, output[:])
        expected := [4]f32{1, -1, 1, -1}
        for value, i in output { testing.expect_value(test, value, expected[i / 2]) }
        testing.expect_value(test, consumer.published_frame, u64(44007))
        testing.expect_value(test, consumer.late, u64(3))
    }
}

@(test)
serialized_clock_is_exact_and_invalid_clock_rolls_back :: proc(test: ^testing.T) {
    producer := mixer.create()
    consumer := mixer.create()
    defer mixer.close(producer)
    defer mixer.close(consumer)
    frame := u64(1) << 32 + 43200
    publish_clock(test, producer, frame, frame)
    packet := make([]u8, w.maxAudioPacketBytes)
    defer delete(packet)
    size := mixer.export_batch(producer, packet)
    testing.expect(test, size > 0)
    mixer.put64(packet, w.audioPacketSimulationFrameOffset, w.audioMaxExactFrame + 1)
    testing.expect(test, !mixer.import_batch(consumer, packet[:size]))
    mixer.put64(packet, w.audioPacketSimulationFrameOffset, frame)
    testing.expect(test, mixer.import_batch(consumer, packet[:size]))
    lead: [w.audioLeadFrames * 2]f32
    mixer.render(consumer, lead[:])
    testing.expect_value(test, consumer.published_frame, frame)
    first: [2]f32
    mixer.render(consumer, first[:])
    testing.expect_value(test, consumer.processed, u64(1))
    testing.expect_value(test, consumer.late, u64(0))
}
