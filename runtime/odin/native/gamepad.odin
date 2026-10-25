package main

import sdl "vendor:sdl3"

// Left-stick travel, out of 32767, before a direction counts as held.
GAMEPAD_STICK_DEADZONE :: 13107

// Translate an open gamepad into the shared button mask.
gamepad_buttons :: proc(pad: ^sdl.Gamepad) -> u32 {
    return 0
}
