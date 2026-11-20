package main

import abi "../../../runtime/odin/abi"
import core "../../../runtime/odin/core"
import guest "../../../runtime/odin/guest"
import "core:fmt"
import "core:mem"
import "core:os"
import "core:time"

main :: proc() {
    if len(os.args) < 4 {

        os.exit(1)
    }
    bytes, err := os.read_entire_file(os.args[1], context.allocator)
    if err != nil {

        os.exit(1)
    }
    defer delete(bytes)
    source: []u8
    if os.args[2] != "" {

        source, err = os.read_entire_file(os.args[2], context.allocator)
        if err != nil {

            os.exit(1)
        }
    }
    defer delete(source)
    game := new(guest.Game)
    defer mem.free(game)
    defer guest.close(game)
    if !guest.load(game, bytes, source) {

        fmt.eprintln(game.error)
        os.exit(1)
    }
    core.init()
    size, ok := guest.read_graphics(game)
    if !ok || !core.load_graphics(game.assets[:size]) {

        fmt.eprintln("invalid graphics")
        os.exit(1)
    }
    bench := len(os.args) > 4 && os.args[4] == "bench"
    fault := len(os.args) > 4 && os.args[4] == "fault"
    count := 120 if bench else 12
    bench_started := time.tick_now()
    for tick in 0 ..= count {
        started := time.tick_now()
        if tick > 0 {
            mask := u32(8) if bench else (u32(4) if fault else u32(0))
            if !guest.update(game, abi.Input{buttons = mask}) {

                fmt.eprintln(game.error)
                os.exit(1)
            }
        }
        updated := time.duration_seconds(time.tick_since(started)) * 1000
        frame: abi.Frame
        if !guest.draw(game, &frame) {

            fmt.eprintln(game.error)
            os.exit(1)
        }
        core.set_display(game.display_mode)
        if !core.render(frame) ||
           !core.render_batch(game.batch[:game.count], game.text[:game.text_size]) {

            fmt.eprintln("invalid legacy drawing")
            os.exit(1)
        }
        guest.apply_graphics(game)
        elapsed := time.duration_seconds(time.tick_since(started)) * 1000
        if !bench {
            pixels := (cast([^]u8)&core.pixels)[:core.width * core.height * 4]
            if os.write_entire_file(fmt.tprintf("%s/%d.rgba", os.args[3], tick), pixels) != nil {

                os.exit(1)
            }
        }
        fmt.printf(
            "{{\"tick\":%d,\"width\":%d,\"height\":%d,\"hash\":%d,\"updateMs\":%.6f,\"totalMs\":%.6f,\"resourceBytes\":%d,\"guestBytes\":%d,\"packetBytes\":%d,\"hostCopyBytes\":%d,\"peakResourceBytes\":%d,\"wallMs\":%.6f}}\n",
            tick,
            core.width,
            core.height,
            core.hash(),
            updated,
            elapsed,
            game.resources.bytes,
            guest.memory_bytes(game),
            game.resources.stats.packet_bytes,
            game.resources.stats.copy_bytes,
            game.resources.stats.peak_bytes,
            time.duration_seconds(time.tick_since(bench_started)) * 1000,
        )
        if bench && tick > 0 {

            time.sleep(
                time.Duration(
                    max(0.0, 1.0 / 60.0 - time.duration_seconds(time.tick_since(started))) * 1e9,
                ),
            )
        }
    }
}
