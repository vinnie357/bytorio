package main

import abi "../../../runtime/odin/abi"
import guest "../../../runtime/odin/guest"
import "core:fmt"
import "core:mem"
import "core:os"

main :: proc() {
    if len(os.args) < 2 {

        os.exit(1)
    }
    bytes, err := os.read_entire_file(os.args[1], context.allocator)
    if err != nil {

        os.exit(1)
    }
    defer delete(bytes)
    source: []u8
    if len(os.args) > 2 && os.args[2] != "" {

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
    fmt.printf("%d %d\n", guest.resource_hash(game), game.resources.bytes)
    for tick in 1 ..= 120 {
        input := abi.Input{}
        if len(os.args) > 3 && os.args[3] == "fault" {

            input.buttons = 4
        }
        if !guest.update(game, input) {

            fmt.eprintln(game.error)
            os.exit(1)
        }
        if tick % 4 == 0 {
            frame: abi.Frame
            if !guest.draw(game, &frame) {

                fmt.eprintln(game.error)
                os.exit(1)
            }
        }
        fmt.printf("%d %d\n", guest.resource_hash(game), game.resources.bytes)
    }
}
