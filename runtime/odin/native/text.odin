package main

import abi "../abi"
import "core:strings"
import sdl "vendor:sdl3"

text_event :: proc(app: ^App, event: ^sdl.Event) {
    if !app.focused || !abi.text_active(&app.game.text_input) { return }
    #partial switch event.type {
    case .TEXT_INPUT:
        if event.text.windowID != sdl.GetWindowID(app.window) { return }
        app.game.text_input.composing = false
        value := cast([^]u8)event.text.text
        if value == nil { return }
        length := 0
        for length <= abi.TEXT_INPUT_MAX_BYTES && value[length] != 0 { length += 1 }
        if length <= abi.TEXT_INPUT_MAX_BYTES {
            _ = abi.text_replace(&app.game.text_input, value[:length])
        }
    case .TEXT_EDITING:
        if event.edit.windowID != sdl.GetWindowID(app.window) { return }
        value := cast([^]u8)event.edit.text
        app.game.text_input.composing = value != nil && value[0] != 0
    case .KEY_DOWN:
        if event.key.windowID ==
           sdl.GetWindowID(app.window) { text_key(app, event.key.scancode, event.key.mod) }
    }
}

sync_text_input :: proc(app: ^App) {
    if app.window == nil { return }
    if app.text_revision != app.game.text_input.revision {
        _ = sdl.ClearComposition(app.window)
        sdl.FlushEvents(.TEXT_EDITING, .TEXT_INPUT)
    }
    active := app.focused && abi.text_active(&app.game.text_input)
    if active != sdl.TextInputActive(app.window) {
        if active { _ = sdl.StartTextInput(app.window) } else { _ = sdl.StopTextInput(app.window) }
    }
    if active && app.text_revision != app.game.text_input.revision {
        h := app.game.text_input.packet.header
        window_width, window_height: i32
        _ = sdl.GetWindowSize(app.window, &window_width, &window_height)
        logical_width := max(app.logical_width, 1)
        logical_height := max(app.logical_height, 1)
        scale := min(
            f32(window_width) / f32(logical_width),
            f32(window_height) / f32(logical_height),
        )
        left := (f32(window_width) - f32(logical_width) * scale) / 2
        top := (f32(window_height) - f32(logical_height) * scale) / 2
        rect := sdl.Rect {
            x = i32(left + f32(h.x) * scale),
            y = i32(top + f32(h.y) * scale),
            w = i32(f32(h.width) * scale),
            h = i32(f32(h.height) * scale),
        }
        _ = sdl.SetTextInputArea(app.window, &rect, 0)
    }
    app.text_revision = app.game.text_input.revision
}

text_key :: proc(app: ^App, key: sdl.Scancode, modifiers: sdl.Keymod = {}) {
    if !app.focused || !abi.text_active(&app.game.text_input) { return }
    state := &app.game.text_input
    if state.composing { return }
    shift := modifiers & sdl.KMOD_SHIFT != {}
    control := modifiers & sdl.KMOD_CTRL != {}
    if control {
        #partial switch key {
        case .A:
            abi.text_select_all(state)
            return
        case .V:
            clipboard := sdl.GetClipboardText()
            if clipboard == nil { return }
            defer sdl.free(clipboard)
            length := 0
            for length <= abi.TEXT_INPUT_MAX_BYTES && clipboard[length] != 0 { length += 1 }
            if length <=
               abi.TEXT_INPUT_MAX_BYTES { _ = abi.text_replace(state, clipboard[:length]) }
            return
        case .C, .X:
            h := state.packet.header
            if h.start == h.end { return }
            value := string(state.packet.bytes[h.start:h.end])
            if sdl.SetClipboardText(strings.clone_to_cstring(value, context.temp_allocator)) &&
               key == .X {
                _ = abi.text_replace(state, nil)
            }
            return
        }
    }
    #partial switch key {
    case .LEFT, .RIGHT:
        abi.text_move(state, key == .RIGHT, shift, false)
    case .HOME, .END:
        abi.text_move(state, key == .END, shift, true)
    case .DELETE:
        abi.text_delete(state)
    case .BACKSPACE:
        abi.text_backspace(&app.game.text_input)
    case .RETURN, .KP_ENTER:
        abi.text_finish(&app.game.text_input, false)
    case .ESCAPE:
        abi.text_finish(&app.game.text_input, true)
    }
}
