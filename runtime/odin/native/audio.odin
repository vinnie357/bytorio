package main

import audio "../audio"
import w "../resource_protocol"
import "base:runtime"
import sdl "vendor:sdl3"

audio_callback :: proc "c" (
    userdata: rawptr,
    stream: ^sdl.AudioStream,
    additional_amount, total_amount: i32,
) {
    context = runtime.default_context()
    app := cast(^App)userdata
    engine := audio.load(&app.audio_engine)
    remaining := (int(additional_amount) + 7) / 8
    for remaining > 0 {
        frames := min(remaining, w.maxAudioDeviceBlock)
        audio.render(engine, app.audio_buffer[:frames * 2])
        if !sdl.PutAudioStreamData(stream, &app.audio_buffer, i32(frames * 8)) { return }
        remaining -= frames
    }
}
attach_audio :: proc(app: ^App) -> bool {
    if app.mixer_audio != nil || app.game.resources.audio == nil { return true }
    audio.store(&app.audio_engine, app.game.resources.audio)
    spec := sdl.AudioSpec {
        format   = .F32,
        channels = w.audioChannels,
        freq     = w.audioRate,
    }
    app.mixer_audio = sdl.OpenAudioDeviceStream(
        sdl.AUDIO_DEVICE_DEFAULT_PLAYBACK,
        &spec,
        audio_callback,
        app,
    )
    return app.mixer_audio != nil && sdl.ResumeAudioStreamDevice(app.mixer_audio)
}
