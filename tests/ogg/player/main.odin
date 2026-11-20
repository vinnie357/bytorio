package main

import audio "../../../runtime/odin/audio"
import cartridge "../../../runtime/odin/cartridge"
import guest "../../../runtime/odin/guest"
import "core:fmt"
import "core:os"

main :: proc() {
    if len(os.args) != 4 { os.exit(1) }
    bytes, err := os.read_entire_file(os.args[1], context.allocator)
    if err != nil { os.exit(1) }
    defer delete(bytes)
    cart, error := cartridge.parse(bytes)
    if error != "" { fmt.eprintln(error); os.exit(1) }
    code := cart.code
    source: []u8
    executor: []u8
    defer delete(executor)
    if cart.language == cartridge.LUAU {
        source = code
        executor, err = os.read_entire_file(os.args[2], context.allocator)
        if err != nil { os.exit(1) }
        code = executor
    }
    game := new(guest.Game)
    defer free(game)
    defer guest.close(game)
    if !guest.load(game, code, source, expected_profile = cart.profile, content = cart.content) {
        fmt.eprintln(game.error)
        os.exit(1)
    }
    pcm := make([]f32, 96000 * 2)
    defer delete(pcm)
    for at := 0; at < len(pcm) / 2; {
        if !guest.pump_ogg(game) { fmt.eprintln(game.error); os.exit(1) }
        count := min(127, len(pcm) / 2 - at)
        audio.render(game.resources.audio, pcm[at * 2:][:count * 2])
        at += count
    }
    if os.write_entire_file(os.args[3], (cast([^]u8)raw_data(pcm))[:len(pcm) * 4]) !=
       nil { os.exit(1) }
    engine := game.resources.audio
    fmt.printf(
        "{{\"underruns\":%d,\"late\":%d,\"rejected\":%d,\"completed\":%d,\"resourceBytes\":%d}}\n",
        engine.underruns,
        engine.late,
        engine.rejected_writes,
        engine.completed,
        game.resources.bytes,
    )
}
