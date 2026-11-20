package main

import abi "../../../runtime/odin/abi"
import audio "../../../runtime/odin/audio"
import guest "../../../runtime/odin/guest"
import w "../../../runtime/odin/resource_protocol"
import "base:runtime"
import "core:fmt"
import "core:os"
import "core:strconv"
import "core:time"
import sdl "vendor:sdl3"

capture: [48000 * 2]f32
block: [w.maxAudioDeviceBlock * 2]f32
written: u32
callback_count: u32
callback :: proc "c" (userdata: rawptr, stream: ^sdl.AudioStream, additional, total: i32) {
    context = runtime.default_context()
    engine := cast(^audio.Engine)userdata
    frames := (int(additional) + 7) / 8
    for frames > 0 {
        count := min(frames, w.maxAudioDeviceBlock)
        audio.render(engine, block[:count * 2])
        at := written
        copied := min(count, len(capture) / 2 - int(at))
        if copied >
           0 { copy(capture[int(at) * 2:][:copied * 2], block[:copied * 2]); audio.store(&written, at + u32(copied)) }
        audio.store(&callback_count, callback_count + 1)
        _ = sdl.PutAudioStreamData(stream, &block, i32(count * 8))
        frames -= count
    }
}
main :: proc() {
    if len(os.args) < 6 { os.exit(1) }
    bytes, err := os.read_entire_file(os.args[1], context.allocator)
    if err != nil { os.exit(1) }
    defer delete(bytes)
    source: []u8
    if os.args[2] !=
       "" { source, err = os.read_entire_file(os.args[2], context.allocator); if err != nil { os.exit(1) } }
    defer delete(source)
    game := new(guest.Game)
    defer free(game)
    defer guest.close(game)
    if !guest.load(game, bytes, source) { fmt.eprintln(game.error); os.exit(1) }
    engine := game.resources.audio
    if engine == nil { fmt.eprintln("missing audio schedule"); os.exit(1) }
    rate64, ok := strconv.parse_u64(os.args[4])
    rate := u32(rate64)
    if !ok { os.exit(1) }
    started := time.tick_now()
    if os.args[5] == "device" {
        if !sdl.Init({.AUDIO}) { fmt.eprintln(string(sdl.GetError())); os.exit(1) }
        spec := sdl.AudioSpec {
            format   = .F32,
            channels = 2,
            freq     = w.audioRate,
        }
        device := sdl.OpenAudioDeviceStream(
            sdl.AUDIO_DEVICE_DEFAULT_PLAYBACK,
            &spec,
            callback,
            engine,
        )
        if device != nil { _ = sdl.SetAudioStreamGain(device, 0) }
        if device == nil ||
           !sdl.ResumeAudioStreamDevice(
                   device,
               ) { fmt.eprintln(string(sdl.GetError())); os.exit(1) }
        // The producer neither updates the guest nor feeds PCM during this stall.
        sdl.Delay(500)
        stalled := audio.load(&written)
        for _ in 0 ..< 200 { if audio.load(&written) >= 48000 { break }; sdl.Delay(10) }
        device_spec: sdl.AudioSpec
        device_frames: i32
        _ = sdl.GetAudioDeviceFormat(
            sdl.GetAudioStreamDevice(device),
            &device_spec,
            &device_frames,
        )
        sdl.DestroyAudioStream(device)
        if stalled < 10000 ||
           written < 48000 { fmt.eprintln("audio did not survive producer stall"); os.exit(1) }
        fmt.printf(
            "{{\"stallFrames\":%d,\"callbacks\":%d,\"rate\":%d,\"deviceRate\":%d,\"deviceBufferFrames\":%d,\"driver\":\"%s\"}}\n",
            stalled,
            callback_count,
            rate,
            device_spec.freq,
            device_frames,
            sdl.GetCurrentAudioDriver(),
        )
        sdl.Quit()
    } else {
        at := 0
        for at < 48000 {
            count := min(127, len(capture) / 2 - at)
            audio.render(engine, capture[at * 2:][:count * 2], rate)
            at += count
        }
    }
    if os.write_entire_file(os.args[3], (cast([^]u8)&capture)[:size_of(capture)]) !=
       nil { os.exit(1) }
    if !guest.update(game, abi.Input{}) { fmt.eprintln(game.error); os.exit(1) }
    sdk_frame: abi.Frame
    expected := u64(4)
    if len(os.args) > 6 {
        expected, ok = strconv.parse_u64(os.args[6])
        if !ok { os.exit(1) }
    }
    if !guest.draw(game, &sdk_frame) ||
       sdk_frame.x != f64(expected) ||
       sdk_frame.y != f64(expected) {
        fmt.eprintln("SDK audio status/completion decoding failed")
        os.exit(1)
    }
    fmt.printf(
        "{{\"frame\":%d,\"late\":%d,\"underruns\":%d,\"completed\":%d,\"snapshotPeakBytes\":%d,\"reservedBytes\":%d,\"elapsedMs\":%.6f}}\n",
        engine.published_frame,
        engine.late,
        engine.underruns,
        engine.completed,
        engine.peak,
        audio.RESERVED_BYTES,
        time.duration_seconds(time.tick_since(started)) * 1000,
    )
}
