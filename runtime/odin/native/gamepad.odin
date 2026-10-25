package main

import abi "../abi"
import sdl "vendor:sdl3"

// Left-stick travel, out of 32767, before a direction counts as held.
GAMEPAD_STICK_DEADZONE :: 13107

// Translate an open gamepad into the shared button mask. The d-pad sets the
// original direction bit and the move bit so older SDKs keep working.
gamepad_buttons :: proc(pad: ^sdl.Gamepad) -> (mask: u32) {
    if pad == nil { return }
    if sdl.GetGamepadButton(pad, .SOUTH) { mask |= 16 }
    if sdl.GetGamepadButton(pad, .EAST) { mask |= abi.BUTTON_ESCAPE }
    if sdl.GetGamepadButton(pad, .START) { mask |= abi.BUTTON_MAP }
    if sdl.GetGamepadButton(pad, .LEFT_SHOULDER) { mask |= abi.BUTTON_ROTATE_LEFT }
    if sdl.GetGamepadButton(pad, .RIGHT_SHOULDER) { mask |= abi.BUTTON_ROTATE_RIGHT }
    x := sdl.GetGamepadAxis(pad, .LEFTX)
    y := sdl.GetGamepadAxis(pad, .LEFTY)
    if sdl.GetGamepadButton(pad, .DPAD_LEFT) || x < -GAMEPAD_STICK_DEADZONE {
        mask |= 1 | abi.BUTTON_MOVE_LEFT
    }
    if sdl.GetGamepadButton(pad, .DPAD_RIGHT) || x > GAMEPAD_STICK_DEADZONE {
        mask |= 2 | abi.BUTTON_MOVE_RIGHT
    }
    if sdl.GetGamepadButton(pad, .DPAD_UP) || y < -GAMEPAD_STICK_DEADZONE {
        mask |= 4 | abi.BUTTON_MOVE_UP
    }
    if sdl.GetGamepadButton(pad, .DPAD_DOWN) || y > GAMEPAD_STICK_DEADZONE {
        mask |= 8 | abi.BUTTON_MOVE_DOWN
    }
    return
}
