package main

import abi "../abi"
import "core:math/bits"
import "core:testing"
import sdl "vendor:sdl3"

@(test)
native_gamepad_mapping :: proc(t: ^testing.T) {
    testing.expect(t, sdl.Init({.GAMEPAD}))
    defer sdl.Quit()
    buttons: u32
    for button in ([]sdl.GamepadButton{.SOUTH, .EAST, .START, .LEFT_SHOULDER, .RIGHT_SHOULDER, .DPAD_UP, .DPAD_DOWN, .DPAD_LEFT, .DPAD_RIGHT}) {
        buttons |= 1 << u32(button)
    }
    desc := sdl.VirtualJoystickDesc {
        version     = size_of(sdl.VirtualJoystickDesc),
        type        = u16(sdl.JoystickType.GAMEPAD),
        naxes       = 6,
        nbuttons    = 26,
        button_mask = buttons,
        axis_mask   = 1 << u32(sdl.GamepadAxis.LEFTX) | 1 << u32(sdl.GamepadAxis.LEFTY),
        name        = "bytorio test pad",
    }
    id := sdl.AttachVirtualJoystick(desc)
    testing.expect(t, id != 0)
    if id == 0 { return }
    defer sdl.DetachVirtualJoystick(id)
    pad := sdl.OpenGamepad(id)
    testing.expect(t, pad != nil)
    if pad == nil { return }
    defer sdl.CloseGamepad(pad)
    joystick := sdl.GetGamepadJoystick(pad)

    // A virtual gamepad numbers its joystick buttons by rank among the masked bits.
    press :: proc(joystick: ^sdl.Joystick, button: sdl.GamepadButton, down: bool, declared: u32) {
        index := bits.count_ones(declared & (1 << u32(button) - 1))
        sdl.SetJoystickVirtualButton(joystick, i32(index), down)
        sdl.UpdateJoysticks()
    }
    tilt :: proc(joystick: ^sdl.Joystick, x, y: i16) {
        sdl.SetJoystickVirtualAxis(joystick, i32(sdl.GamepadAxis.LEFTX), x)
        sdl.SetJoystickVirtualAxis(joystick, i32(sdl.GamepadAxis.LEFTY), y)
        sdl.UpdateJoysticks()
    }

    testing.expect_value(t, gamepad_buttons(pad), 0)
    for entry in ([]struct {
            button: sdl.GamepadButton,
            mask:   u32,
        } {
            {.SOUTH, 16},
            {.EAST, abi.BUTTON_ESCAPE},
            {.START, abi.BUTTON_MAP},
            {.LEFT_SHOULDER, abi.BUTTON_ROTATE_LEFT},
            {.RIGHT_SHOULDER, abi.BUTTON_ROTATE_RIGHT},
            {.DPAD_LEFT, 1 | abi.BUTTON_MOVE_LEFT},
            {.DPAD_RIGHT, 2 | abi.BUTTON_MOVE_RIGHT},
            {.DPAD_UP, 4 | abi.BUTTON_MOVE_UP},
            {.DPAD_DOWN, 8 | abi.BUTTON_MOVE_DOWN},
        }) {
        press(joystick, entry.button, true, buttons)
        testing.expect_value(t, gamepad_buttons(pad), entry.mask)
        press(joystick, entry.button, false, buttons)
        testing.expect_value(t, gamepad_buttons(pad), 0)
    }

    tilt(joystick, -30000, 0)
    testing.expect_value(t, gamepad_buttons(pad), 1 | abi.BUTTON_MOVE_LEFT)
    tilt(joystick, 30000, 0)
    testing.expect_value(t, gamepad_buttons(pad), 2 | abi.BUTTON_MOVE_RIGHT)
    tilt(joystick, 0, -30000)
    testing.expect_value(t, gamepad_buttons(pad), 4 | abi.BUTTON_MOVE_UP)
    tilt(joystick, 0, 30000)
    testing.expect_value(t, gamepad_buttons(pad), 8 | abi.BUTTON_MOVE_DOWN)
    tilt(joystick, -30000, 30000)
    testing.expect_value(t, gamepad_buttons(pad), 1 | abi.BUTTON_MOVE_LEFT | 8 | abi.BUTTON_MOVE_DOWN)
    tilt(joystick, 10000, -10000)
    testing.expect_value(t, gamepad_buttons(pad), 0)
}
