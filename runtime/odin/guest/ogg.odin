package guest

import cartridge "../cartridge"
import w "../resource_protocol"
import resources "../resources"

when ODIN_OS == .Windows {
    foreign import vorbis {"../../../build/vorbis/native/Release/bytorio-vorbis.lib", "../../../build/vorbis/install/lib/vorbisfile.lib", "../../../build/vorbis/install/lib/vorbis.lib", "../../../build/vorbis/install/lib/ogg.lib"}
} else when ODIN_OS == .Darwin {
    foreign import vorbis {"../../../build/vorbis/native/libbytorio-vorbis.a", "../../../build/vorbis/install/lib/libvorbisfile.a", "../../../build/vorbis/install/lib/libvorbis.a", "../../../build/vorbis/install/lib/libogg.a"}
}
foreign vorbis {
    vorbis_open :: proc "c" (bytes: rawptr, size: i32) -> i32 ---
    vorbis_close :: proc "c" (handle: i32) ---
    vorbis_frames :: proc "c" (handle: i32) -> f64 ---
    vorbis_seek :: proc "c" (handle: i32, frame: f64) -> i32 ---
    vorbis_read :: proc "c" (handle: i32, output: rawptr, frames: i32, loop_start, loop_end: u32) -> i32 ---
}
Ogg_Decoder :: struct {
    id:     u32,
    cursor: u32,
    handle: i32,
}

close_ogg :: proc(game: ^Game) {
    for &decoder in game.ogg { if decoder.handle != 0 { vorbis_close(decoder.handle) }; decoder = {} }
}

// Called on the host producer, never from SDL's audio callback.
pump_ogg :: proc(game: ^Game) -> bool {
    pcm: [w.oggChunkFrames * 2]f32
    for &decoder, index in game.ogg {
        for _ in 0 ..< w.maxStreamFrames / w.oggChunkFrames {
            request := resources.ogg_request(&game.resources, u32(index))
            if decoder.id != request[0] {
                if decoder.handle != 0 { vorbis_close(decoder.handle) }
                decoder = {}
            }
            if request[0] == 0 { break }
            if decoder.handle == 0 {
                bytes := cartridge.content_blob(game.content, request[1])
                handle := vorbis_open(raw_data(bytes), i32(len(bytes)))
                if handle == 0 { return fail(game, "cannot decode Ogg Vorbis content") }
                decoder = {
                    id     = request[0],
                    handle = handle,
                }
                if vorbis_frames(handle) !=
                   f64(request[3]) { return fail(game, "Ogg sample count mismatch") }
            }
            at := u64(request[4]) | u64(request[5]) << 32
            if request[6] == 0 {
                if request[2] ==
                   request[3] { _ = resources.ogg_feed(&game.resources, u32(index), request[0], at, nil) }
                break
            }
            if decoder.cursor != request[2] {
                if vorbis_seek(decoder.handle, f64(request[2])) !=
                   1 { return fail(game, "Ogg seek failed") }
                decoder.cursor = request[2]
            }
            count := vorbis_read(decoder.handle, &pcm, i32(request[6]), request[8], request[9])
            if count <= 0 { return fail(game, "Ogg decoding ended before declared frame count") }
            decoder.cursor += u32(count)
            if request[9] != 0 && decoder.cursor >= request[9] {
                decoder.cursor =
                    request[8] + (decoder.cursor - request[9]) % (request[9] - request[8])
            }
            if !resources.ogg_feed(
                &game.resources,
                u32(index),
                request[0],
                at,
                pcm[:int(count) * 2],
            ) { break }
        }
    }
    return true
}
